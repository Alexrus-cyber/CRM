import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Старая база знала один токен на пользователя (`agent_tokens`).
 * При старте он должен сам переехать в подключение «Основной CRM»,
 * иначе работающие боты останутся без доступа после обновления.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-agent-legacy-"));
const file = path.join(dir, "crm.sqlite");
const legacyToken = "crmop_0123456789abcdef0123456789abcdef0123456789abcdef";
let userId = 0;

// Готовим «старую» базу до того, как CRM создаст свои таблицы.
const seed = new Database(file);
seed.exec(`
  create table users (
    id integer primary key autoincrement,
    email text not null unique,
    password_hash text not null,
    name text not null,
    phone text,
    position text,
    bio text,
    role text not null default 'user',
    avatar_color text not null default '#7c5cff',
    avatar_url text,
    created_at text not null,
    updated_at text not null
  );
  create table agent_tokens (
    id integer primary key autoincrement,
    user_id integer not null unique references users(id) on delete cascade,
    token text not null unique,
    created_at text not null
  );
  insert into users (email, password_hash, name, role, created_at, updated_at)
  values ('legacy@example.com', 'x', 'Legacy', 'super_admin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  insert into agent_tokens (user_id, token, created_at)
  values (1, '${legacyToken}', '2026-01-02T00:00:00.000Z');
`);
seed.close();

process.env.SQLITE_PATH = file;
process.env.DATABASE_URL = "";

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("миграция старого токена", () => {
  it("токен из agent_tokens переезжает в подключение «Основной CRM»", async () => {
    const repo = await import("@/db/repo");
    const db = await import("@/db");
    await db.getDb();

    const me = await db.q1<{ id: number }>(sql`select id from users where email = 'legacy@example.com'`);
    userId = Number(me?.id);

    const connections = await repo.listAgentConnections(userId);
    expect(connections).toHaveLength(1);
    expect(connections[0].name).toBe("Основной CRM");
    expect(connections[0].isDefault).toBe(true);
    expect(connections[0].tokensCount).toBe(1);
    expect(connections[0].activeTokens).toBe(1);

    const tokens = await repo.listAgentTokens(userId, connections[0].id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].name).toBe("Основной");
    expect(tokens[0].hint).toBe(`…${legacyToken.slice(-6)}`);

    // Бот со старым токеном продолжает находить владельца, но сам токен в БД захеширован (sha256:).
    expect(await repo.findAgentTokenOwner(legacyToken)).toBe(userId);
    const stored = await db.q1<{ token: string; token_hash: string }>(
      sql`select token, token_hash from agent_connection_tokens where id = ${tokens[0].id}`,
    );
    expect(stored?.token).toMatch(/^sha256:/);
    expect(stored?.token_hash).toMatch(/^sha256:/);
    expect(stored?.token).not.toContain(legacyToken);
  });
});
