import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

const isPostgresCi = process.env.DB_DIALECT === "postgres" && Boolean(process.env.DATABASE_URL);
const describePg = isPostgresCi ? describe : describe.skip;

let tempStorageDir = "";

describePg("PostgreSQL migrations, backfill and core security/CRUD smoke", () => {
  beforeAll(async () => {
    tempStorageDir = mkdtempSync(join(tmpdir(), "crm-pg-storage-"));
    process.env.CRM_STORAGE_DIR = tempStorageDir;
    const db = await import("@/db");
    await db.getDb();
  });

  afterAll(async () => {
    if (tempStorageDir) {
      rmSync(tempStorageDir, { recursive: true, force: true });
    }
    const g = globalThis as { __crmPool?: { end?: () => Promise<void> } };
    if (g.__crmPool?.end) {
      await g.__crmPool.end().catch(() => undefined);
    }
  });

  it("connects to PostgreSQL and passes migrations + CRUD + cascade cleanup", async () => {
    const db = await import("@/db");
    const dialect = await import("@/db/dialect");
    const repo = await import("@/db/repo");
    const auth = await import("@/lib/auth");
    const { getStorageRoot } = await import("@/lib/storage");

    expect(await db.getDialect()).toBe("postgres");

    const uid = await repo.insertUser({
      name: "PG Smoke User",
      email: "pg-smoke@crm.local",
      passwordHash: auth.hashPassword("StrongPass123"),
      role: "super_admin",
      avatarColor: "#7c5cff",
    });

    await db.q(sql`update users set totp_enabled = true, totp_secret_encrypted = '' where id = ${uid}`);
    expect(await auth.verifyUserTotp(uid, "123456")).toBe(false);

    const bot = await repo.createChatBot({
      createdBy: uid,
      name: "PG Smoke Bot",
      model: "gpt-4o-mini",
      provider: "openai",
      apiKey: "sk-pg-bot-secret-9988",
    });

    const msgId = await repo.insertMessage(bot.userId, uid, "Привет PG");
    const attId = await repo.insertMessageAttachment(msgId, {
      name: "Отчёт.txt",
      mime: "text/plain",
      size: 4,
      data: Buffer.from("test", "utf8").toString("base64"),
    });

    await db.q(sql`update messages set content_lower = '' where id = ${msgId}`);
    await db.q(sql`update message_attachments set name_lower = '' where id = ${attId}`);
    const executor = await db.getDb();
    await dialect.backfillMessageSearch(executor);

    const mRow = await db.q1<{ content_lower: string }>(sql`select content_lower from messages where id = ${msgId}`);
    expect(mRow?.content_lower).toBe("привет pg");
    const aRow = await db.q1<{ name_lower: string; storage_key: string }>(
      sql`select name_lower, storage_key from message_attachments where id = ${attId}`,
    );
    expect(aRow?.name_lower).toBe("отчёт.txt");
    const fullFile = join(getStorageRoot(), String(aRow?.storage_key || ""));
    expect(existsSync(fullFile)).toBe(true);

    expect(await repo.deleteChatBot(bot.userId)).toBe(true);
    expect(existsSync(fullFile)).toBe(false);

    const task = await repo.createAgentTask(uid, "PG Task", 10, "verified");
    const [c1, c2] = await Promise.all([repo.claimAgentTask(uid), repo.claimAgentTask(uid)]);
    expect([c1?.id, c2?.id].filter((id) => id === task.id)).toHaveLength(1);
  });
});
