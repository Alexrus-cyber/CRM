import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  assertSafeAgentUrl,
  assertSafeAiUrl,
} from "@/lib/ssrf";
import { buildOtpAuthUri, generateTotpSecret, hotpCode, verifyTotpCode } from "@/lib/totp";
import { formatServerBotApproval } from "@/lib/approvalFormat";
import {
  clearAgentApprovalsForTests,
  consumeAgentApproval,
  peekAgentApproval,
  registerAgentApproval,
} from "@/lib/agentApprovals";
import { readJsonWithByteLimit, validateStrongPassword } from "@/lib/validation";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-sec-p0p1-"));
const sqliteFile = path.join(tempDir, "crm.sqlite");
process.env.SQLITE_PATH = sqliteFile;
process.env.DATABASE_URL = "";

afterAll(() => {
  clearAgentApprovalsForTests();
  delete process.env.CRM_SECRET_PREVIOUS;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("P0/P1 security guards (SSRF, crypto HKDF, TOTP, approval nonces, passwords)", () => {
  it("SSRF guards block cloud metadata, embedded credentials, and enforce strict agent policy", async () => {
    for (const blocked of [
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://[fe80::1]/",
      "http://[fd00:ec2::254]/latest",
      "http://user:pass@127.0.0.1:8888/v1",
      "file:///etc/passwd",
      "ftp://example.com/model",
    ]) {
      await expect(assertSafeAiUrl(blocked)).rejects.toThrow();
    }

    // Local LLM endpoints stay usable under allow_local_llm default policy
    await expect(assertSafeAiUrl("http://127.0.0.1:8888/v1")).resolves.toBeInstanceOf(URL);
    await expect(assertSafeAiUrl("http://localhost:11434/v1")).resolves.toBeInstanceOf(URL);

    // Agent URL stays loopback-only unless CRM_ALLOW_REMOTE_AGENT=1
    expect(() => assertSafeAgentUrl("http://192.168.1.50:8787")).toThrow();
    expect(() => assertSafeAgentUrl("http://127.0.0.1:8787?foo=bar")).toThrow();
    expect(assertSafeAgentUrl("http://127.0.0.1:8787").hostname).toBe("127.0.0.1");
  });

  it("HKDF enc2 encryption supports key rotation and backward-compatible enc1 decryption", () => {
    const a = encryptSecret("sk-secret-value");
    const b = encryptSecret("sk-secret-value");
    expect(a).toMatch(/^enc2:k1:/);
    expect(b).toMatch(/^enc2:k1:/);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("sk-secret-value");
    expect(decryptSecret(b)).toBe("sk-secret-value");
    expect(decryptSecret(`${a.slice(0, -3)}xxx`)).toBe("");

    // Backward-compatible enc1 decryption via CRM_SECRET_PREVIOUS key rotation
    const oldSecret = "legacy-secret-material-at-least-32-chars-long";
    process.env.CRM_SECRET_PREVIOUS = oldSecret;
    const oldKey = createHash("sha256").update(oldSecret, "utf8").digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", oldKey, iv);
    const encrypted = Buffer.concat([cipher.update("rotated-token", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const enc1Wire = `enc1:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
    expect(decryptSecret(enc1Wire)).toBe("rotated-token");
  });

  it("TOTP 2FA generates valid RFC-6238 tokens, verifies within ±1 step, and rejects wrong codes", () => {
    const secret = generateTotpSecret(20);
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(buildOtpAuthUri("admin@crm.local", secret)).toContain("otpauth://totp/");

    const nowMs = 1_700_000_000_000;
    const currentStep = Math.floor(nowMs / 1000 / 30);
    const validNow = hotpCode(secret, currentStep);
    const validPrev = hotpCode(secret, currentStep - 1);
    const staleOld = hotpCode(secret, currentStep - 4);

    expect(validNow).toMatch(/^\d{6}$/);
    expect(verifyTotpCode(secret, validNow, nowMs)).toBe(true);
    expect(verifyTotpCode(secret, validPrev, nowMs)).toBe(true);
    expect(verifyTotpCode(secret, staleOld, nowMs)).toBe(false);
    expect(verifyTotpCode(secret, "abcdef", nowMs)).toBe(false);
  });

  it("formats bot approvals exclusively on the server and enforces single-use owner-scoped approval nonces", () => {
    const formatted = formatServerBotApproval({
      kind: "action",
      action: { type: "pc_command", command: "whoami\r\n&& id" },
    });
    expect(formatted.ok).toBe(true);
    if (formatted.ok) {
      expect(formatted.kind).toBe("action");
      expect(formatted.title).toContain("Команда");
      expect(formatted.description).toContain("whoami && id");
      expect(formatted.description).not.toContain("\n");
    }

    clearAgentApprovalsForTests();
    registerAgentApproval("appr-100", 7, "nonce-secret-abc");

    // Peek validates without consuming
    expect(peekAgentApproval("appr-100", 7)).toEqual({ ok: true, nonce: "nonce-secret-abc" });
    expect(peekAgentApproval("appr-100", 99)).toEqual({
      ok: false,
      status: 403,
      error: "Чужой запрос подтверждения",
    });

    // Disk persistence recovers across in-memory HMR/worker resets
    (globalThis as { __crmPendingAgentApprovals?: Map<string, unknown> }).__crmPendingAgentApprovals?.clear();
    expect(peekAgentApproval("appr-100", 7)).toEqual({ ok: true, nonce: "nonce-secret-abc" });

    // Wrong owner rejected without consuming
    expect(consumeAgentApproval("appr-100", 99)).toEqual({
      ok: false,
      status: 403,
      error: "Чужой запрос подтверждения",
    });
    // Correct owner consumes once atomically
    expect(consumeAgentApproval("appr-100", 7)).toEqual({ ok: true, nonce: "nonce-secret-abc" });
    // Replay rejected
    expect(consumeAgentApproval("appr-100", 7)).toEqual({
      ok: false,
      status: 404,
      error: "Запрос подтверждения не найден или уже истёк",
    });

    // Legacy agents that do not emit a nonce still register owner-scoped approval
    registerAgentApproval("appr-legacy", 7, "");
    expect(peekAgentApproval("appr-legacy", 99).ok).toBe(false);
    expect(consumeAgentApproval("appr-legacy", 7)).toEqual({ ok: true, nonce: "" });
  });

  it("enforces strong password rules and streaming byte limit on JSON bodies", async () => {
    expect(validateStrongPassword("short1").ok).toBe(false);
    expect(validateStrongPassword("onlyletterslong").ok).toBe(false);
    expect(validateStrongPassword("123456789012").ok).toBe(false);
    expect(validateStrongPassword("StrongPass123").ok).toBe(true);

    const bigReq = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(5000) }),
    });
    const overLimit = await readJsonWithByteLimit(bigReq, 1024);
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) expect(overLimit.response.status).toBe(413);

    const okReq = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    const underLimit = await readJsonWithByteLimit<{ hello: string }>(okReq, 1024);
    expect(underLimit.ok).toBe(true);
    if (underLimit.ok) expect(underLimit.data.hello).toBe("world");
  });
});

describe("P0/P1 DB & route invariants (atomic claim, token expiry, soft-delete, email confirmation, health probe)", () => {
  let uid = 0;

  beforeAll(async () => {
    const db = await import("@/db");
    await db.getDb();
    await db.q(sql`
      insert into users (email, password_hash, name, role, created_at, updated_at)
      values ('sec-user@example.com', 'x', 'Sec User', 'user', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `);
    const row = await db.q1<{ id: number }>(sql`select id from users where email = 'sec-user@example.com'`);
    uid = Number(row?.id);
  });

  it("claims agent tasks atomically so only one concurrent worker succeeds", async () => {
    const agentRepo = await import("@/db/repos/agent");
    const task = await agentRepo.createAgentTask(uid, "Run check", 10, "verified");

    const [c1, c2] = await Promise.all([
      agentRepo.claimAgentTask(uid),
      agentRepo.claimAgentTask(uid),
    ]);
    const claimedIds = [c1?.id, c2?.id].filter((id) => id === task.id);
    expect(claimedIds).toHaveLength(1);
  });

  it("rejects expired agent tokens while accepting active ones", async () => {
    const agentRepo = await import("@/db/repos/agent");
    const db = await import("@/db");
    const conn = await agentRepo.createAgentConnection(uid, "Test Conn", "https://crm.example");
    const tok = await agentRepo.createAgentConnectionToken(uid, conn.id, "Temp Token");
    expect(tok).not.toBeNull();
    expect(await agentRepo.findAgentTokenOwner(tok!.token)).toBe(uid);

    // Force expiration in DB
    await db.q(sql`update agent_connection_tokens set expires_at = '2020-01-01T00:00:00.000Z' where id = ${tok!.item.id}`);
    expect(await agentRepo.findAgentTokenOwner(tok!.token)).toBeNull();
  });

  it("supports email confirmation flow and soft-deletion revoking authentication", async () => {
    const usersRepo = await import("@/db/repos/users");

    const sessionToken = "sess-raw-token-0123456789abcdef";
    await usersRepo.insertSession(sessionToken, uid, new Date(Date.now() + 86_400_000).toISOString(), {
      label: "Test Session",
    });
    expect((await usersRepo.findSessionUser(sessionToken))?.user.id).toBe(uid);

    await usersRepo.requestEmailChange(uid, "new-sec@example.com", "confirm-tok-abc");
    expect((await usersRepo.getUser(uid))?.email).toBe("sec-user@example.com");

    // Wrong token fails
    expect((await usersRepo.confirmEmailChangeByToken("wrong-token")).ok).toBe(false);

    // Correct token applies new email & revokes existing sessions
    const confirmed = await usersRepo.confirmEmailChangeByToken("confirm-tok-abc");
    expect(confirmed).toEqual({ ok: true, userId: uid, newEmail: "new-sec@example.com" });
    expect((await usersRepo.getUser(uid))?.email).toBe("new-sec@example.com");
    expect(await usersRepo.findSessionUser(sessionToken)).toBeNull();

    // Soft-delete hides user from auth & listings
    await usersRepo.deleteUser(uid);
    expect(await usersRepo.getUser(uid)).toBeNull();
    expect(await usersRepo.findUserAuthByEmail("new-sec@example.com")).toBeNull();
  });

  it("/api/health does not leak filesystem paths and computes probeAck challenge", async () => {
    const { GET } = await import("@/app/api/health/route");
    const probe = "deadbeefcafebabe1234";
    const expectedAck = createHash("sha256").update(`nova-crm-health:${probe}`, "utf8").digest("hex");
    const res = await GET(new Request(`http://localhost/api/health?probe=${probe}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.app).toBe("nova-crm");
    expect(body.probeAck).toBe(expectedAck);
    expect(body.sqlitePath).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(sqliteFile);
  });
});
