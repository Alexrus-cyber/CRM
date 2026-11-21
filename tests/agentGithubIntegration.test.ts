import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGithubRagSnapshot,
  decryptGithubToken,
  encryptGithubToken,
  maskGithubToken,
} from "@/lib/github";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-agent-gh-"));
process.env.SQLITE_PATH = path.join(dir, "crm.sqlite");
process.env.DATABASE_URL = "";

let ownerUserId = 0;
let colleagueUserId = 0;
let repo: typeof import("@/db/repo");
let db: typeof import("@/db");

beforeAll(async () => {
  repo = await import("@/db/repo");
  db = await import("@/db");
  await db.getDb();
  await db.q(sql`
    insert into users (email, password_hash, name, role, can_use_agent, created_at, updated_at)
    values
      ('dev@example.com', 'x', 'Разработчик', 'admin', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('colleague@example.com', 'x', 'Коллега', 'user', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  const first = await db.q1<{ id: number }>(sql`select id from users where email = 'dev@example.com'`);
  const second = await db.q1<{ id: number }>(sql`select id from users where email = 'colleague@example.com'`);
  ownerUserId = Number(first?.id);
  colleagueUserId = Number(second?.id);
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("GitHub integration (encryption, per-user DB isolation & GitHub-RAG)", () => {
  it("encrypts GitHub tokens at rest and masks token hint", () => {
    const raw = "ghp_ExampleSecretToken1234567890";
    const encrypted = encryptGithubToken(raw);
    expect(encrypted).toMatch(/^enc1:/);
    expect(encrypted).not.toContain(raw);
    expect(decryptGithubToken(encrypted)).toBe(raw);
    expect(maskGithubToken(raw)).toBe("ghp_Ex••••7890");
  });

  it("stores per-user GitHub connection, hides secret in public query, and isolates users", async () => {
    const rawToken = "ghp_PersonalUserTokenABCDEF1234";
    const saved = await repo.upsertGithubConnection({
      userId: ownerUserId,
      githubUserId: 777,
      login: "alex-dev",
      name: "Alex Dev",
      email: "alex@example.org",
      avatarUrl: "https://avatars.githubusercontent.com/u/777",
      token: rawToken,
      scopes: "repo, read:user, user:email",
      selectedOwner: "Alexrus-cyber",
      selectedRepo: "CRM",
      selectedBranch: "main",
      enabled: true,
    });

    expect(saved.login).toBe("alex-dev");
    expect(saved.selectedOwner).toBe("Alexrus-cyber");
    expect(saved.selectedRepo).toBe("CRM");
    expect(saved.selectedBranch).toBe("main");
    expect(saved.tokenHint).toBe(maskGithubToken(rawToken));
    expect((saved as Record<string, unknown>).token).toBeUndefined();
    expect((saved as Record<string, unknown>).tokenEncrypted).toBeUndefined();

    const secret = await repo.getGithubConnectionWithSecret(ownerUserId);
    expect(secret?.token).toBe(rawToken);

    // Другой пользователь CRM не получает доступ к чужому GitHub-аккаунту или токену
    expect(await repo.getGithubConnectionPublic(colleagueUserId)).toBeNull();
    expect(await repo.getGithubConnectionWithSecret(colleagueUserId)).toBeNull();

    const updated = await repo.updateGithubRepoSelection(ownerUserId, {
      selectedBranch: "feat/rag",
      enabled: false,
    });
    expect(updated?.selectedBranch).toBe("feat/rag");
    expect(updated?.enabled).toBe(false);

    expect(await repo.deleteGithubConnection(colleagueUserId)).toBe(false);
    expect(await repo.deleteGithubConnection(ownerUserId)).toBe(true);
    expect(await repo.getGithubConnectionPublic(ownerUserId)).toBeNull();
  });

  it("builds GitHub-RAG snapshot skipping node_modules/binaries and including query-matched files", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/git/trees/")) {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              { type: "blob", path: "README.md" },
              { type: "blob", path: "package.json" },
              { type: "blob", path: "src/auth/session.ts" },
              { type: "blob", path: "node_modules/pkg/index.js" },
              { type: "blob", path: "public/logo.png" },
              { type: "blob", path: "package-lock.json" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/contents/README.md")) {
        return new Response(
          JSON.stringify({
            encoding: "base64",
            content: Buffer.from("# CRM Project\nDocs here.", "utf8").toString("base64"),
          }),
          { status: 200 },
        );
      }
      if (url.includes("/contents/src/auth/session.ts")) {
        return new Response(
          JSON.stringify({
            encoding: "base64",
            content: Buffer.from("export function verifySession() { return true; }", "utf8").toString("base64"),
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const snap = await buildGithubRagSnapshot({
      token: "ghp_test",
      owner: "Alexrus-cyber",
      repo: "CRM",
      branch: "main",
      query: "как работает session в auth?",
    });

    expect(snap.fileCount).toBe(3);
    expect(snap.matchedFiles).toContain("src/auth/session.ts");
    expect(snap.contextText).toContain("Alexrus-cyber/CRM (ветка: main)");
    expect(snap.contextText).toContain("export function verifySession()");
    expect(snap.contextText).not.toContain("node_modules/pkg/index.js");
    expect(snap.contextText).not.toContain("public/logo.png");
    expect(snap.contextText).not.toContain("package-lock.json");
  });
});
