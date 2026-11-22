import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";

const tempDirs: string[] = [];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "crm-sec-audit2-"));
  tempDirs.push(dir);
  process.env.SQLITE_PATH = join(dir, "crm.sqlite");
  process.env.CRM_STORAGE_DIR = join(dir, "storage");
  process.env.CRM_SECRET = "test-secret-for-audit-2-minimum-32-chars";
  delete process.env.DATABASE_URL;
});

afterAll(() => {
  for (const d of tempDirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("Audit 2 security & correctness fixes [1]-[21]", () => {
  it("[1] proxy forwards Content-Security-Policy and x-nonce in request headers for Next.js SSR", async () => {
    const { proxy } = await import("@/proxy");
    const req = new NextRequest("http://localhost:3000/login");
    const res = proxy(req);
    const resCsp = res.headers.get("Content-Security-Policy") || "";
    const reqNonce = res.headers.get("x-middleware-request-x-nonce") || "";
    const reqCsp = res.headers.get("x-middleware-request-content-security-policy") || "";

    expect(resCsp).toContain("'strict-dynamic'");
    expect(reqNonce.length).toBeGreaterThan(10);
    expect(resCsp).toContain(`'nonce-${reqNonce}'`);
    expect(reqCsp).toBe(resCsp);
  });

  it("[2] verifyUserTotp fails closed when 2FA is enabled but secret cannot be decrypted", async () => {
    const db = await import("@/db");
    await db.getDb();
    const repo = await import("@/db/repo");
    const auth = await import("@/lib/auth");

    const uid = await repo.insertUser({
      name: "TOTP Fail Closed",
      email: "totp-fail-closed@crm.local",
      passwordHash: auth.hashPassword("StrongPass123"),
      role: "user",
      avatarColor: "#7c5cff",
    });
    await db.q(sql`update users set totp_enabled = true, totp_secret_encrypted = '' where id = ${uid}`);
    expect(await auth.verifyUserTotp(uid, "123456")).toBe(false);
  });

  it("[4] login rate limit without trusted proxy (ip='direct') does not lock out other users globally", async () => {
    const rl = await import("@/lib/rateLimit");
    const opts = { windowMs: 60_000, maxFailures: 2, blockMs: 30_000 };
    for (let i = 0; i < 10; i += 1) {
      rl.recordLoginFailure("direct", "attacker-target@crm.local", opts);
    }
    expect(rl.checkLoginRateLimit("direct", "attacker-target@crm.local", opts).allowed).toBe(false);
    expect(rl.checkLoginRateLimit("direct", "innocent-coworker@crm.local", opts).allowed).toBe(true);
    rl.clearLoginAttempts("direct", "attacker-target@crm.local");
  });

  it("[6] aiPolicyFor preserves unlimited monthlyTokens=null for super_admin and admin even with overrides", async () => {
    const { aiPolicyFor } = await import("@/lib/aiPolicy");
    expect(aiPolicyFor("super_admin", 500_000).monthlyTokens).toBeNull();
    expect(aiPolicyFor("admin", 500_000).monthlyTokens).toBeNull();
    expect(aiPolicyFor("developer", 0).monthlyTokens).toBeNull();
    expect(aiPolicyFor("developer", 8_000_000).monthlyTokens).toBe(8_000_000);
  });

  it("[8] capabilitiesForRole uses Object.hasOwn and rejects prototype keys", async () => {
    const { capabilitiesForRole } = await import("@/lib/permissions");
    expect(capabilitiesForRole("toString").role).toBe("user");
    expect(capabilitiesForRole("constructor").role).toBe("user");
    expect(capabilitiesForRole("__proto__").isSuperAdmin).toBe(false);
  });

  it("[10] publicChatBot hides short secret tails while preserving masked hint format", async () => {
    const { publicChatBot } = await import("@/lib/chatBot");
    const base = {
      userId: 1,
      name: "B",
      position: null,
      bio: null,
      avatarColor: "#000",
      avatarUrl: null,
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      systemPrompt: "",
      paramsJson: "{}",
      replyMode: "mention" as const,
      isActive: true,
      createdBy: 1,
      createdAt: "",
      updatedAt: "",
    };
    expect(publicChatBot({ ...base, apiKey: "123456" }, true).apiKeyHint).toBe("••••");
    expect(publicChatBot({ ...base, apiKey: "sk-bot-secret-9999" }, true).apiKeyHint).toBe("…9999");
  });

  it("[11] deleteChatBot deletes stored attachment files and related messages cleanly", async () => {
    const db = await import("@/db");
    await db.getDb();
    const repo = await import("@/db/repo");
    const auth = await import("@/lib/auth");
    const { getStorageRoot } = await import("@/lib/storage");

    const ownerId = await repo.insertUser({
      name: "Bot Owner",
      email: "bot-owner-del@crm.local",
      passwordHash: auth.hashPassword("StrongPass123"),
      role: "super_admin",
      avatarColor: "#7c5cff",
    });
    const bot = await repo.createChatBot({
      createdBy: ownerId,
      name: "Удаляемый Бот",
      model: "gpt-4o-mini",
      provider: "openai",
      apiKey: "sk-bot-secret-del-1234",
    });
    const msgId = await repo.insertMessage(bot.userId, ownerId, "Тест вложения");
    const attId = await repo.insertMessageAttachment(msgId, {
      name: "report.txt",
      mime: "text/plain",
      size: 5,
      data: Buffer.from("hello", "utf8").toString("base64"),
    });
    const row = await db.q1<{ storage_key: string }>(sql`select storage_key from message_attachments where id = ${attId}`);
    const fullFile = join(getStorageRoot(), String(row?.storage_key || ""));
    expect(existsSync(fullFile)).toBe(true);

    expect(await repo.deleteChatBot(bot.userId)).toBe(true);
    expect(existsSync(fullFile)).toBe(false);
    expect(await repo.getChatBot(bot.userId)).toBeNull();
  });

  it("[12] GitHub client enforces https://api.github.com allowlist", async () => {
    const src = readFileSync(join(process.cwd(), "src/lib/github.ts"), "utf8");
    expect(src).toContain('parsedUrl.hostname !== "api.github.com"');
  });

  it("[13] batch backfill normalizes mixed-case Cyrillic messages safely", async () => {
    const db = await import("@/db");
    const dialect = await import("@/db/dialect");
    const executor = await db.getDb();
    const auth = await import("@/lib/auth");
    const repo = await import("@/db/repo");
    const u = await repo.insertUser({
      name: "Backfill User",
      email: "backfill@crm.local",
      passwordHash: auth.hashPassword("StrongPass123"),
      role: "user",
      avatarColor: "#7c5cff",
    });
    await db.q(sql`
      insert into messages (sender_id, recipient_id, room_id, content, content_lower, created_at)
      values (${u}, null, null, 'Привет МИР', '', '2026-01-01T00:00:00.000Z')
    `);
    await dialect.backfillMessageSearch(executor);
    const row = await executor.all<{ id: number; content_lower: string }>(
      sql`select id, content_lower from messages where content = 'Привет МИР'`,
    );
    expect(row.length).toBe(1);
    expect(row[0]?.content_lower).toBe("привет мир");
  });

  it("[3][5][7][9] route handlers enforce server hard caps, async SQLite retries and streaming export", () => {
    const aiChatSrc = readFileSync(join(process.cwd(), "src/app/api/ai/chat/route.ts"), "utf8");
    expect(aiChatSrc).toContain("readJsonWithByteLimit");
    expect(aiChatSrc).toContain("HARD_MAX_BODY_BYTES");

    const chatSrc = readFileSync(join(process.cwd(), "src/app/api/chat/route.ts"), "utf8");
    expect(chatSrc).toContain("HARD_MAX_FILE_BYTES");
    expect(chatSrc).toContain("fileBuffer.byteLength > maxFileBytes");

    const dialectSrc = readFileSync(join(process.cwd(), "src/db/dialect.ts"), "utf8");
    expect(dialectSrc).not.toContain("while (Date.now() < until)");
    expect(dialectSrc).toContain("setTimeout");

    const exportSrc = readFileSync(join(process.cwd(), "src/app/api/tasks/export/route.ts"), "utf8");
    expect(exportSrc).toContain("new ReadableStream");
    expect(exportSrc).toContain("markTasksExported(user.id, selectedIds)");
  });

  it("[15] docker-compose sets CRM_ALLOW_REMOTE_AGENT and resolveSafeAgentUrl permits host.docker.internal when enabled", async () => {
    const compose = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");
    expect(compose).toContain("CRM_ALLOW_REMOTE_AGENT");
    const prev = process.env.CRM_ALLOW_REMOTE_AGENT;
    try {
      process.env.CRM_ALLOW_REMOTE_AGENT = "1";
      const { resolveSafeAgentUrl } = await import("@/lib/agentConfig");
      expect(resolveSafeAgentUrl("http://host.docker.internal:8899")).toBe("http://host.docker.internal:8899");
    } finally {
      if (prev === undefined) delete process.env.CRM_ALLOW_REMOTE_AGENT;
      else process.env.CRM_ALLOW_REMOTE_AGENT = prev;
    }
  });
});
