import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PLAN_PROMPT } from "@/lib/operatorPlan";

/**
 * Интеграционный тест БД для пункта 15:
 *   • отдельные истории план-чата (с индивидуальным system_prompt) и чата «Агент»;
 *   • сохранение метаданных файлов без байтов и изоляция по пользователям;
 *   • вычисление состояния бота (`getAgentBotConnectionStatus`) и `touch: false`.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-agent-conv-"));
process.env.SQLITE_PATH = path.join(dir, "crm.sqlite");
process.env.DATABASE_URL = "";

let userId = 0;
let otherUserId = 0;
let repo: typeof import("@/db/repo");
let db: typeof import("@/db");

beforeAll(async () => {
  repo = await import("@/db/repo");
  db = await import("@/db");
  await db.getDb();
  await db.q(sql`
    insert into users (email, password_hash, name, role, created_at, updated_at)
    values
      ('planner@example.com', 'x', 'Planner', 'super_admin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('other@example.com', 'x', 'Other', 'super_admin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  const first = await db.q1<{ id: number }>(sql`select id from users where email = 'planner@example.com'`);
  const second = await db.q1<{ id: number }>(sql`select id from users where email = 'other@example.com'`);
  userId = Number(first?.id);
  otherUserId = Number(second?.id);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("история чатов планировщика и агента", () => {
  it("хранит план-чаты и чаты агента отдельно, со своим system_prompt на каждый план-чат", async () => {
    const planA = await repo.createAgentConversation(userId, "plan", "Новый план", DEFAULT_PLAN_PROMPT);
    const planB = await repo.createAgentConversation(userId, "plan", "Новый план", "Свой короткий промпт");
    const agentChat = await repo.createAgentConversation(userId, "agent", "Новый чат", "");

    expect(planA.systemPrompt).toBe(DEFAULT_PLAN_PROMPT);
    expect(planB.systemPrompt).toBe("Свой короткий промпт");

    const plans = await repo.listAgentConversations(userId, "plan");
    const agents = await repo.listAgentConversations(userId, "agent");
    expect(plans.map((item) => item.id).sort()).toEqual([planA.id, planB.id].sort());
    expect(agents.map((item) => item.id)).toEqual([agentChat.id]);

    // Индивидуальный промпт меняется только у выбранного план-чата.
    await repo.updateAgentConversation(userId, planA.id, { systemPrompt: "Обновлённый промпт A" });
    expect((await repo.getAgentConversation(userId, planA.id))?.systemPrompt).toBe("Обновлённый промпт A");
    expect((await repo.getAgentConversation(userId, planB.id))?.systemPrompt).toBe("Свой короткий промпт");

    // Чужой пользователь не видит и не может изменить чат.
    expect(await repo.listAgentConversations(otherUserId, "plan")).toHaveLength(0);
    expect(await repo.getAgentConversation(otherUserId, planA.id)).toBeNull();
    expect(await repo.updateAgentConversation(otherUserId, planA.id, { systemPrompt: "взлом" })).toBeNull();
    expect(await repo.deleteAgentConversation(otherUserId, planA.id)).toBe(false);
  });

  it("сохраняет сообщения, автозаголовок и метаданные файлов без содержимого; удаляет каскадом", async () => {
    const chat = await repo.createAgentConversation(userId, "agent", "Новый чат", "");
    await repo.insertAgentConversationMessage({
      userId,
      conversationId: chat.id,
      role: "user",
      content: "Сделай отчёт по продажам",
      attachments: JSON.stringify([{ name: "sales.xlsx", size: 2048 }]),
    });
    await repo.insertAgentConversationMessage({
      userId,
      conversationId: chat.id,
      role: "assistant",
      content: "Файл готов",
      files: JSON.stringify([{ name: "report.csv", mime: "text/csv", size: 512 }]),
      actions: JSON.stringify([{ type: "open_url", url: "https://example.com", label: "Example", autoplay: false }]),
    });

    const loaded = await repo.getAgentConversation(userId, chat.id);
    expect(loaded?.title).toBe("Сделай отчёт по продажам");
    expect(loaded?.messagesCount).toBe(2);

    const messages = await repo.listAgentConversationMessages(chat.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].attachments).toEqual([{ name: "sales.xlsx", size: 2048 }]);
    expect(messages[1].files).toEqual([{ name: "report.csv", mime: "text/csv", size: 512 }]);
    expect(messages[1].actions).toEqual([{ type: "open_url", url: "https://example.com", label: "Example", autoplay: false }]);

    expect(await repo.deleteAgentConversation(userId, chat.id)).toBe(true);
    expect(await repo.getAgentConversation(userId, chat.id)).toBeNull();
    expect(await repo.listAgentConversationMessages(chat.id)).toHaveLength(0);
  });
});

describe("ручная проверка подключения бота", () => {
  it("различает отсутствие токенов, ни разу не выходившего, активного и устаревшего бота", async () => {
    const initial = await repo.getAgentBotConnectionStatus(userId);
    expect(initial.state).toBe("no_tokens");
    expect(initial.connected).toBe(false);

    const conn = await repo.createAgentConnection(userId, "Офис", "http://localhost:3000");
    const created = await repo.createAgentConnectionToken(userId, conn.id, "Ноутбук");
    expect(created).not.toBeNull();

    // Ручная проверка токена (touch: false) не должна отмечать бота как активного.
    expect(await repo.findAgentTokenOwner(created!.token, { touch: false })).toBe(userId);
    const neverUsed = await repo.getAgentBotConnectionStatus(userId, conn.id);
    expect(neverUsed.state).toBe("never");
    expect(neverUsed.connected).toBe(false);

    // Реальный опрос бота (touch: true) отмечает активность — статус становится online.
    expect(await repo.findAgentTokenOwner(created!.token)).toBe(userId);
    const online = await repo.getAgentBotConnectionStatus(userId, conn.id);
    expect(online.state).toBe("online");
    expect(online.connected).toBe(true);
    expect(online.tokenName).toBe("Ноутбук");

    // Если последний опрос был давно — статус stale (бот не на связи).
    const oldIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await db.q(sql`update agent_connection_tokens set last_used_at = ${oldIso} where id = ${created!.item.id}`);
    const stale = await repo.getAgentBotConnectionStatus(userId, conn.id);
    expect(stale.state).toBe("stale");
    expect(stale.connected).toBe(false);

    // Но если прямо сейчас выполняется свежее задание — бот всё ещё считается подключённым.
    const task = await repo.createAgentTask(userId, "Тест", 10);
    await repo.setAgentTaskStatus(task.id, userId, "running");
    const running = await repo.getAgentBotConnectionStatus(userId, conn.id);
    expect(running.state).toBe("online");
    expect(running.connected).toBe(true);
    expect(running.runningTask?.id).toBe(task.id);
  });

  it("при onlyIfExisting=true синхронизирует только существующий чат задачи и не воскрешает удалённый", async () => {
    const task = await repo.createAgentTask(userId, "Открой заметки", 10);

    // Пока чата нет, onlyIfExisting=true не создаёт его при поллинге.
    const noCreate = await repo.syncOperatorTaskToConversation(userId, task.id, { onlyIfExisting: true });
    expect(noCreate).toBeNull();

    // По явному запросу (?ensureChat=1) чат создаётся.
    const ensuredId = await repo.syncOperatorTaskToConversation(userId, task.id);
    expect(ensuredId).not.toBeNull();

    // После удаления чата повторный поллинг с onlyIfExisting=true не воскрешает его.
    await repo.deleteAgentConversation(userId, ensuredId!);
    const afterDelete = await repo.syncOperatorTaskToConversation(userId, task.id, { onlyIfExisting: true });
    expect(afterDelete).toBeNull();
  });
});
