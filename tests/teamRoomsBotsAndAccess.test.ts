import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Интеграционный тест БД для пунктов 3, 4, 5 и 6:
 *   • доступ сотрудников к Агенту/Оператору (`setUserAgentAccess`) и профили лаунчера;
 *   • токен-сессии лаунчера (`createLauncherSession` / `findUserByBearer` / `destroyTokenSession`);
 *   • отдельный учёт токенов Агента и Оператора (`recordAgentUsage` / `getAgentUsage` / `listUsersAgentUsage`);
 *   • модели-боты (не попадают в listUsers и логин), групповые и общие комнаты чата, фильтрация доступа и триггеры ботов.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-rooms-access-"));
process.env.SQLITE_PATH = path.join(dir, "crm.sqlite");
process.env.DATABASE_URL = "";

let superId = 0;
let devId = 0;
let managerId = 0;
let repo: typeof import("@/db/repo");
let db: typeof import("@/db");
let auth: typeof import("@/lib/auth");
let launcherProfile: typeof import("@/lib/launcherProfile");
let chatBot: typeof import("@/lib/chatBot");

beforeAll(async () => {
  repo = await import("@/db/repo");
  db = await import("@/db");
  auth = await import("@/lib/auth");
  launcherProfile = await import("@/lib/launcherProfile");
  chatBot = await import("@/lib/chatBot");
  await db.getDb();

  await db.q(sql`
    insert into users (email, password_hash, name, role, is_bot, can_use_agent, can_use_operator, created_at, updated_at)
    values
      ('super@example.com', 'x', 'Главный Админ', 'super_admin', 0, 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('dev@example.com', 'x', 'Разработчик', 'developer', 0, 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('mgr@example.com', 'x', 'Менеджер', 'manager', 0, 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  superId = Number((await db.q1<{ id: number }>(sql`select id from users where email = 'super@example.com'`))?.id);
  devId = Number((await db.q1<{ id: number }>(sql`select id from users where email = 'dev@example.com'`))?.id);
  managerId = Number((await db.q1<{ id: number }>(sql`select id from users where email = 'mgr@example.com'`))?.id);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("права к Агенту/Оператору, профиль лаунчера и учёт токенов", () => {
  it("управляет правами доступа сотрудников, авто-токеном Оператора и Bearer-сессией лаунчера", async () => {
    const devBefore = await repo.getUser(devId);
    expect(devBefore?.canUseAgent).toBe(false);
    expect(devBefore?.canUseOperator).toBe(false);

    // Пока права не выданы, профиль лаунчера не выдаёт токен Оператора.
    const profileDenied = await launcherProfile.buildLauncherProfile(devBefore!, "https://crm.test");
    expect(profileDenied.user.canUseAgent).toBe(false);
    expect(profileDenied.user.canUseOperator).toBe(false);
    expect(profileDenied.operator.token).toBeNull();
    expect("agentUsage" in profileDenied).toBe(false);
    expect(profileDenied.limits.maxSteps).toBeNull();

    // Выдаём разработчику права на Агента и Оператора.
    await repo.setUserAgentAccess(devId, { canUseAgent: true, canUseOperator: true });
    const devAfter = await repo.getUser(devId);
    expect(devAfter?.canUseAgent).toBe(true);
    expect(devAfter?.canUseOperator).toBe(true);

    const profileGranted = await launcherProfile.buildLauncherProfile(devAfter!, "https://crm.test");
    expect(profileGranted.user.canUseAgent).toBe(true);
    expect(profileGranted.user.canUseOperator).toBe(true);
    expect(profileGranted.operator.token).toMatch(/^crmop_/);
    expect(profileGranted.operator.serverUrl).toBe("https://crm.test");

    // Главный админ видит статистику и не имеет потолка шагов.
    const superUser = await repo.getUser(superId);
    const superProfile = await launcherProfile.buildLauncherProfile(superUser!, "https://crm.test");
    expect(superProfile.user.canUseAgent).toBe(true);
    expect(superProfile.user.canUseOperator).toBe(true);
    expect(superProfile.limits.unlimited).toBe(true);
    expect(superProfile.limits.maxSteps).toBeNull();
    expect(superProfile.agentUsage).toBeDefined();

    // Проверка Bearer-сессии лаунчера и выхода.
    const session = await auth.createLauncherSession(devId);
    const reqWithBearer = new Request("https://crm.test/api/launcher/profile", {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    const authedUser = await auth.findUserByBearer(reqWithBearer);
    expect(authedUser?.id).toBe(devId);
    await auth.destroyTokenSession(session.token);
    expect(await auth.findUserByBearer(reqWithBearer)).toBeNull();
  });

  it("учитывает токены Агента и Оператора отдельно от общего ИИ-чата", async () => {
    await repo.recordAgentUsage({
      userId: devId,
      kind: "agent",
      refId: 10,
      model: "gpt-4o",
      prompt: 1200,
      completion: 300,
    });
    await repo.recordAgentUsage({
      userId: devId,
      kind: "operator",
      refId: 22,
      model: "qwen3-vl",
      prompt: 2000,
      completion: 500,
    });

    const summary = await repo.getAgentUsage(devId);
    expect(summary.month.agent.prompt).toBe(1200);
    expect(summary.month.agent.completion).toBe(300);
    expect(summary.month.agent.total).toBe(1500);
    expect(summary.month.operator.total).toBe(2500);
    expect(summary.month.total.total).toBe(4000);

    const byUsers = await repo.listUsersAgentUsage();
    const devRow = byUsers.find((u) => u.userId === devId);
    expect(devRow?.monthAgent).toBe(1500);
    expect(devRow?.monthOperator).toBe(2500);
    expect(devRow?.monthTotal).toBe(4000);
  });
});

describe("модели-боты и групповые/общие комнаты чата", () => {
  it("боты не отображаются в списке сотрудников и не могут логиниться, но работают в ЛС, группах и общем чате", async () => {
    const bot = await repo.createChatBot({
      createdBy: superId,
      name: "Аналитик",
      model: "gpt-4o-mini",
      provider: "openai",
      apiKey: "sk-bot-secret-9999",
      replyMode: "mention",
      isActive: true,
    });

    // Бот скрыт из обычного списка сотрудников (is_bot = 0) и входа по email.
    const team = await repo.listUsers();
    expect(team.some((u) => u.id === bot.userId)).toBe(false);
    const botUserRecord = await repo.getUser(bot.userId);
    expect(botUserRecord?.isBot).toBe(true);
    expect(await repo.findUserAuthByEmail(`bot-x@bot.crm.local`)).toBeNull();

    // Публичный формат скрывает API-ключ и системный промпт для обычных пользователей.
    const masked = chatBot.publicChatBot(bot, false);
    expect(masked.apiKeyHint).toBeUndefined();
    expect(masked.systemPrompt).toBeUndefined();
    const adminView = chatBot.publicChatBot(bot, true);
    expect(adminView.hasApiKey).toBe(true);
    expect(adminView.apiKeyHint).toBe("…9999");

    // Добавляем бота в общий чат.
    await repo.addGeneralBot(bot.userId, superId);
    const generalBots = await repo.listGeneralActiveBots();
    expect(generalBots.map((b) => b.userId)).toContain(bot.userId);

    // Триггеры: по @упоминанию, ЛС и режиму always.
    expect(chatBot.findTriggeredBots(generalBots, "привет всем")).toEqual([]);
    expect(chatBot.findTriggeredBots(generalBots, "@Аналитик проверь отчёт")).toEqual([bot.userId]);
    expect(chatBot.findTriggeredBots(generalBots, "любой текст", { isDm: true })).toEqual([bot.userId]);

    // Закрытая группа видна только участникам, а общий чат (shared) виден всем сотрудникам.
    const privateRoom = await repo.createChatRoom({
      creatorId: superId,
      name: "Отдел продаж",
      kind: "group",
      memberIds: [devId],
      botIds: [bot.userId],
    });
    const sharedRoom = await repo.createChatRoom({
      creatorId: superId,
      name: "Курилка",
      kind: "shared",
    });

    const devRooms = await repo.listChatRoomsForUser(devId);
    expect(devRooms.map((r) => r.id)).toContain(privateRoom.id);
    expect(devRooms.map((r) => r.id)).toContain(sharedRoom.id);

    const mgrRooms = await repo.listChatRoomsForUser(managerId);
    expect(mgrRooms.map((r) => r.id)).not.toContain(privateRoom.id);
    expect(mgrRooms.map((r) => r.id)).toContain(sharedRoom.id);

    // Сообщения и непрочитанные в комнате изолированы от общего чата и ЛС.
    await repo.insertMessage(superId, null, "План по сделкам на ноябрь", privateRoom.id);
    const roomMsgs = await repo.listMessages(superId, 0, 0, 30, privateRoom.id);
    expect(roomMsgs.messages).toHaveLength(1);
    expect(roomMsgs.messages[0].content).toBe("План по сделкам на ноябрь");

    const unreadBefore = await repo.unreadRoomCounts(devId);
    expect(unreadBefore[String(privateRoom.id)]).toBe(1);
    await repo.markRoomRead(devId, privateRoom.id, roomMsgs.messages[0].id);
    const unreadAfter = await repo.unreadRoomCounts(devId);
    expect(unreadAfter[String(privateRoom.id)] ?? 0).toBe(0);
  });
});
