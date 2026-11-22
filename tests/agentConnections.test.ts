import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Подключения и токены оператора живут в базе под пользователем.
 * Тест гоняет настоящий слой БД на SQLite: создание, список, основной,
 * токены, проверку `findAgentTokenOwner` и удаление с каскадом.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-agent-conn-"));
process.env.SQLITE_PATH = path.join(dir, "crm.sqlite");
process.env.DATABASE_URL = "";

let userId = 0;
let repo: typeof import("@/db/repo");
let db: typeof import("@/db");

beforeAll(async () => {
  repo = await import("@/db/repo");
  db = await import("@/db");
  await db.getDb();
  await db.q(sql`
    insert into users (email, password_hash, name, role, created_at, updated_at)
    values ('owner@example.com', 'x', 'Owner', 'super_admin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  const me = await db.q1<{ id: number }>(sql`select id from users where email = 'owner@example.com'`);
  userId = Number(me?.id);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("подключения оператора", () => {
  it("первое подключение становится основным, второе — нет", async () => {
    const first = await repo.createAgentConnection(userId, "Этот CRM", "https://crm.example.com");
    const second = await repo.createAgentConnection(userId, "Тестовый сервер", "http://localhost:3000");

    expect(first.id).toBeGreaterThan(0);
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);

    const list = await repo.listAgentConnections(userId);
    expect(list.map((item) => item.name)).toEqual(["Этот CRM", "Тестовый сервер"]);
    expect(list[0].tokensCount).toBe(0);
  });

  it("переключение основного подключения и правка адреса", async () => {
    const before = await repo.listAgentConnections(userId);
    const second = before.find((item) => item.name === "Тестовый сервер");

    expect(await repo.setDefaultAgentConnection(userId, second!.id)).toBe(true);
    const updated = await repo.updateAgentConnection(userId, second!.id, {
      serverUrl: "https://test.example.com",
    });

    expect(updated?.serverUrl).toBe("https://test.example.com");
    const list = await repo.listAgentConnections(userId);
    expect(list[0].id).toBe(second!.id);
    expect(list[0].isDefault).toBe(true);
  });

  it("токены создаются в подключении, видны маской и находят владельца", async () => {
    const list = await repo.listAgentConnections(userId);
    const connection = list[0];

    const created = await repo.createAgentConnectionToken(userId, connection.id, "Ноутбук");
    expect(created).not.toBeNull();
    expect(created!.token).toMatch(/^crmop_[0-9a-f]{48}$/);
    expect(created!.item.hint).toBe(`…${created!.token.slice(-6)}`);
    // В списке токен не утекает целиком: только хвост.
    expect(created!.item.hint).not.toContain(created!.token);

    const tokens = await repo.listAgentTokens(userId, connection.id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].hint).toHaveLength(7);
    expect(tokens[0].lastUsedAt).toBeNull();

    // Бот приходит с этим токеном — CRM находит владельца и отмечает использование.
    expect(await repo.findAgentTokenOwner(created!.token)).toBe(userId);
    const afterUse = await repo.listAgentTokens(userId, connection.id);
    expect(afterUse[0].lastUsedAt).not.toBeNull();
    const connections = await repo.listAgentConnections(userId);
    expect(connections[0].activeTokens).toBe(1);

    // Повторное раскрытие старого токена больше невозможно (P0-2) — вместо этого работает перевыпуск.
    expect("revealAgentToken" in repo).toBe(false);
    const storedRow = await db.q1<{ token: string; token_hash: string }>(
      sql`select token, token_hash from agent_connection_tokens where id = ${tokens[0].id}`,
    );
    expect(storedRow?.token).toMatch(/^sha256:/);
    expect(storedRow?.token_hash).toBe(storedRow?.token);

    // Чужой пользователь не видит и не перевыпускает чужой токен.
    expect(await repo.reissueAgentConnectionToken(userId + 999, tokens[0].id)).toBeNull();
    expect(await repo.listAgentTokens(userId + 999, connection.id)).toHaveLength(0);

    // Владелец может перевыпустить токен: старый немедленно перестаёт работать, новый действует.
    const reissued = await repo.reissueAgentConnectionToken(userId, tokens[0].id);
    expect(reissued).not.toBeNull();
    expect(reissued!.token).not.toBe(created!.token);
    expect(await repo.findAgentTokenOwner(created!.token)).toBeNull();
    expect(await repo.findAgentTokenOwner(reissued!.token)).toBe(userId);

    const activeList = await repo.listAgentTokens(userId, connection.id);
    expect(activeList).toHaveLength(1);
    expect(await repo.deleteAgentConnectionToken(userId, activeList[0].id)).toBe(true);
    expect(await repo.listAgentTokens(userId, connection.id)).toHaveLength(0);
    expect(await repo.findAgentTokenOwner(reissued!.token)).toBeNull();
  });

  it("удаление подключения уносит его токены и передаёт основность", async () => {
    const list = await repo.listAgentConnections(userId);
    const main = list[0];
    const other = list.find((item) => item.id !== main.id)!;
    const created = await repo.createAgentConnectionToken(userId, main.id, "ПК");

    expect(await repo.deleteAgentConnection(userId, main.id)).toBe(true);
    expect(await repo.getAgentConnection(userId, main.id)).toBeNull();
    expect(await repo.findAgentTokenOwner(created!.token)).toBeNull();

    const rest = await repo.listAgentConnections(userId);
    expect(rest).toHaveLength(1);
    expect(rest[0].id).toBe(other.id);
    expect(rest[0].isDefault).toBe(true);
  });

  it("подключения одного пользователя не видны другому", async () => {
    await db.q(sql`
      insert into users (email, password_hash, name, role, created_at, updated_at)
      values ('stranger@example.com', 'x', 'Stranger', 'super_admin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
    const stranger = await db.q1<{ id: number }>(
      sql`select id from users where email = 'stranger@example.com'`,
    );
    expect(await repo.listAgentConnections(Number(stranger?.id))).toHaveLength(0);
    expect(await repo.countAgentTokens(Number(stranger?.id), 1)).toBe(0);
  });
});
