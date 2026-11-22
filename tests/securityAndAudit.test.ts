import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import writeXlsxFile, { type SheetData } from "write-excel-file/node";
import { readSheet } from "read-excel-file/node";
import {
  decryptSecret,
  encryptSecret,
  hashOpaqueToken,
  maskSecret,
} from "@/lib/crypto";
import {
  ALL_ROLES,
  canConfigureBots,
  canManageData,
  canManageRole,
  hasAgentAccess,
  hasOperatorAccess,
} from "@/lib/permissions";
import {
  checkLoginRateLimit,
  clearLoginFailures,
  recordLoginFailure,
  resetAllRateLimitsForTests,
} from "@/lib/rateLimit";
import {
  readStoredBase64,
  saveStoredBase64,
} from "@/lib/storage";
import {
  aiSettingsUpdateSchema,
  chatBotCreateSchema,
  chatRoomCreateSchema,
  counterpartyInputSchema,
  taskInputSchema,
} from "@/lib/validation";
import { parseCounterpartyMatrix, parseCsvMatrix } from "@/lib/counterpartyImport";

const tempDirs: string[] = [];

afterEach(() => {
  resetAllRateLimitsForTests();
  delete process.env.CRM_STORAGE_DIR;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("crypto & secret encryption", () => {
  it("encrypts and decrypts secrets with AES-256-GCM and rejects tampered ciphertext", () => {
    const plain = "sk-test-1234567890abcdef";
    const encrypted = encryptSecret(plain);
    expect(encrypted).not.toContain(plain);
    expect(encrypted.startsWith("enc1:")).toBe(true);
    expect(decryptSecret(encrypted)).toBe(plain);
    expect(maskSecret(plain)).toBe("sk-tes••••cdef");

    const tampered = `${encrypted.slice(0, -2)}aa`;
    expect(decryptSecret(tampered)).toBe("");
  });

  it("hashes session tokens deterministically with SHA-256", () => {
    const t = "raw-session-token-xyz";
    const h1 = hashOpaqueToken(t);
    const h2 = hashOpaqueToken(t);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(t);
    expect(h1.startsWith("sha256:")).toBe(true);
    expect(h1).toHaveLength(7 + 64);
  });
});

describe("permissions & role capabilities", () => {
  it("enforces strict hierarchy across all roles", () => {
    expect(ALL_ROLES).toContain("super_admin");
    expect(canConfigureBots("super_admin")).toBe(true);
    expect(canConfigureBots("admin")).toBe(false);
    expect(canManageData("manager")).toBe(true);
    expect(canManageData("developer")).toBe(false);
    expect(canManageRole("admin", "user")).toBe(true);
    expect(canManageRole("admin", "admin")).toBe(false);
    expect(hasAgentAccess({ role: "super_admin", canUseAgent: false })).toBe(true);
    expect(hasAgentAccess({ role: "user", canUseAgent: false })).toBe(false);
    expect(hasOperatorAccess({ role: "user", canUseOperator: true })).toBe(true);
  });
});

describe("rateLimit", () => {
  it("blocks repeated failures and clears on successful login", () => {
    const opts = { windowMs: 60_000, maxFailures: 3, blockMs: 30_000 };
    const ip = "203.0.113.10";
    const email = "user@example.com";

    expect(checkLoginRateLimit(ip, email, opts).allowed).toBe(true);
    recordLoginFailure(ip, email, opts);
    recordLoginFailure(ip, email, opts);
    expect(checkLoginRateLimit(ip, email, opts).allowed).toBe(true);
    recordLoginFailure(ip, email, opts);

    const blocked = checkLoginRateLimit(ip, email, opts);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSec).toBeGreaterThan(0);
    }

    clearLoginFailures(ip, email);
    expect(checkLoginRateLimit(ip, email, opts).allowed).toBe(true);
  });
});

describe("storage", () => {
  it("saves and reads base64 attachments safely and rejects path traversal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crm-storage-"));
    tempDirs.push(dir);
    process.env.CRM_STORAGE_DIR = dir;

    const payload = Buffer.from("hello-crm-attachment", "utf8").toString("base64");
    const saved = await saveStoredBase64("chat", payload, "../evil/test.txt");
    expect(saved.storageKey).not.toContain("..");

    const loaded = await readStoredBase64(saved.storageKey);
    expect(loaded).toBe(payload);
    expect(await readStoredBase64("../../etc/passwd")).toBeNull();
  });
});

describe("zod validation & Excel/CSV helpers", () => {
  it("validates tasks, counterparties, ai settings, bots and rooms", () => {
    expect(
      taskInputSchema.safeParse({
        title: "Проверить отчёт",
        assigneeId: 2,
        deadline: "2026-11-20",
        hours: 2,
        status: "new",
        priority: "medium",
      }).success,
    ).toBe(true);
    expect(
      taskInputSchema.safeParse({
        title: "",
        assigneeId: 0,
        deadline: "invalid",
        status: "new",
        priority: "medium",
      }).success,
    ).toBe(false);

    expect(counterpartyInputSchema.safeParse({ name: "ООО Тест" }).success).toBe(true);
    expect(aiSettingsUpdateSchema.safeParse({ baseUrl: "http://127.0.0.1:8888/v1", model: "qwen3" }).success).toBe(true);
    expect(chatBotCreateSchema.safeParse({ name: "Бот" }).success).toBe(true);
    expect(chatRoomCreateSchema.safeParse({ name: "Отдел продаж", kind: "group" }).success).toBe(true);
  });

  it("roundtrips Excel via write-excel-file/read-excel-file and parses CSV counterparties", async () => {
    const sheet: SheetData = [
      [{ value: "Наименование" }, { value: "ИНН" }, { value: "КПП" }],
      [{ value: "ООО Альфа" }, { value: "7707083893" }, { value: "773601001" }],
    ];
    const buffer = await writeXlsxFile(sheet, { sheet: "Контрагенты" }).toBuffer();
    const parsedRows = await readSheet(buffer);
    const parsedXlsx = parseCounterpartyMatrix(parsedRows as unknown[][]);
    expect(parsedXlsx.headerFound).toBe(true);
    expect(parsedXlsx.rows).toHaveLength(1);
    expect(parsedXlsx.rows[0]?.name).toBe("ООО Альфа");
    expect(parsedXlsx.rows[0]?.inn).toBe("7707083893");

    const csv = '\uFEFF"Наименование";"ИНН";"КПП"\n"ООО ""Бета""";7707083893;773601001\n';
    const parsedCsv = parseCounterpartyMatrix(parseCsvMatrix(csv));
    expect(parsedCsv.headerFound).toBe(true);
    expect(parsedCsv.rows[0]?.name).toBe('ООО "Бета"');
  });
});

describe("sessions & encrypted ai_user_settings in DB", () => {
  it("hashes session tokens, revokes sessions, and encrypts per-user AI API keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crm-db-sec-"));
    tempDirs.push(dir);
    process.env.SQLITE_PATH = join(dir, "crm.sqlite");
    delete process.env.DATABASE_URL;

    const db = await import("@/db");
    await db.getDb();
    const repo = await import("@/db/repo");
    const { hashPassword } = await import("@/lib/auth");

    const userId = await repo.insertUser({
      name: "Тест",
      email: "sec@crm.local",
      passwordHash: hashPassword("secret123"),
      role: "user",
      avatarColor: "#7c5cff",
    });

    const tokenA = "tok_session_alpha";
    const tokenB = "tok_session_beta";
    await repo.insertSession(tokenA, userId, new Date(Date.now() + 86_400_000).toISOString(), {
      label: "Браузер",
      ip: "127.0.0.1",
    });
    await repo.insertSession(tokenB, userId, new Date(Date.now() + 86_400_000).toISOString(), {
      label: "CRM Launcher",
      ip: "127.0.0.1",
    });

    const foundA = await repo.findSessionUser(tokenA);
    expect(foundA?.user.id).toBe(userId);

    const sessionsBefore = await repo.listUserSessions(userId, tokenA);
    expect(sessionsBefore).toHaveLength(2);
    expect(sessionsBefore.some((s) => s.current)).toBe(true);

    const revokedCount = await repo.revokeOtherSessions(userId, tokenA);
    expect(revokedCount).toBe(1);
    expect(await repo.findSessionUser(tokenB)).toBeNull();
    expect((await repo.findSessionUser(tokenA))?.user.id).toBe(userId);

    await repo.upsertAiUserSettings(userId, {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-live-secret-9988",
    });
    const pub = await repo.getAiUserSettingsPublic(userId);
    expect(pub.hasApiKey).toBe(true);
    expect(pub.apiKeyHint).toBe("sk-liv••••9988");
    const secret = await repo.getAiUserSettingsSecret(userId);
    expect(secret.apiKey).toBe("sk-live-secret-9988");
    expect(secret.baseUrl).toBe("https://api.openai.com/v1");
    expect(secret.model).toBe("gpt-4o-mini");
  });
});
