import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-agent-tester-"));
process.env.SQLITE_PATH = path.join(tempDir, "crm.sqlite");
process.env.DATABASE_URL = "";

let userA = 0;
let userB = 0;
let repo: typeof import("@/db/repo");
let db: typeof import("@/db");

const authMock = vi.hoisted(() => ({
  currentUser: null as {
    id: number;
    email: string;
    name: string;
    role: "super_admin" | "admin" | "user";
    canUseAgent: boolean;
    canUseAi: boolean;
  } | null,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(async () => authMock.currentUser),
}));

beforeAll(async () => {
  repo = await import("@/db/repo");
  db = await import("@/db");
  await db.getDb();
  await db.q(sql`
    insert into users (email, password_hash, name, role, can_use_agent, created_at, updated_at)
    values
      ('qa_owner@example.com', 'x', 'Разработчик QA', 'admin', 1, '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z'),
      ('qa_other@example.com', 'x', 'Другой Пользователь', 'user', 1, '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z')`);
  const first = await db.q1<{ id: number }>(sql`select id from users where email = 'qa_owner@example.com'`);
  const second = await db.q1<{ id: number }>(sql`select id from users where email = 'qa_other@example.com'`);
  userA = Number(first?.id);
  userB = Number(second?.id);
});

beforeEach(() => {
  vi.restoreAllMocks();
  authMock.currentUser = {
    id: userA,
    email: "qa_owner@example.com",
    name: "Разработчик QA",
    role: "admin",
    canUseAgent: true,
    canUseAi: true,
  };
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Tester sub-agent DB, token isolation & API orchestration", () => {
  it("создаёт отдельный чат Тестировщика, изолирует токены по ref_id и каскадно удаляет прогон", async () => {
    const agentChat = await repo.createAgentConversation(userA, "agent", "Основной чат");

    const { run, conversation } = await repo.createTesterRunWithConversation({
      userId: userA,
      agentConversationId: agentChat.id,
      sandboxProject: "crm-app",
      summary: "Реализован мини-дашборд задач",
      model: "o3-mini",
    });

    expect(conversation.kind).toBe("tester");
    expect(run.agentConversationId).toBe(agentChat.id);
    expect(run.testerConversationId).toBe(conversation.id);
    expect(run.status).toBe("running");

    const initialMessages = await repo.listAgentConversationMessages(conversation.id);
    expect(initialMessages).toHaveLength(1);
    expect(initialMessages[0].role).toBe("user");
    expect(initialMessages[0].content).toContain("crm-app");

    const completed = await repo.completeTesterRun(userA, run.id, {
      status: "minor_issues",
      reportSummary: "Критичных сбоев нет, есть 1 мелкое замечание по отступам",
      criticalIssues: [],
      minorIssues: [{ title: "Отступ на кнопке", description: "Добавить gap-2", file: "index.html", line: 42 }],
      checksRun: [{ name: "qa_static_review", status: "pass", details: "0 синтаксических ошибок" }],
      promptTokens: 320,
      completionTokens: 180,
      totalTokens: 500,
      model: "o3-mini",
    });

    expect(completed?.status).toBe("minor_issues");
    expect(completed?.minorDecision).toBe("pending");
    expect(completed?.totalTokens).toBe(500);

    // Токены записаны в agent_usage_events с ref_id = testerConversationId (а не в чат Агента)
    const usageRow = await db.q1<{ ref_id: number; total_tokens: number }>(sql`
      select ref_id, total_tokens from agent_usage_events
      where user_id = ${userA} and ref_id = ${conversation.id}
      order by id desc limit 1`);
    expect(Number(usageRow?.ref_id)).toBe(conversation.id);
    expect(Number(usageRow?.total_tokens)).toBe(500);

    // Флаг skipUsageRecord предотвращает двойную запись при прямом запуске
    const runSkip = await repo.createTesterRunWithConversation({
      userId: userA,
      testerConversationId: conversation.id,
      sandboxProject: "crm-app",
      summary: "Повторный прямой запуск",
      skipInitialMessage: true,
    });
    const countBeforeSkip = (await repo.listAgentConversationMessages(conversation.id)).length;
    await repo.completeTesterRun(userA, runSkip.run.id, {
      status: "passed",
      reportSummary: "OK",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      skipUsageRecord: true,
    });
    // skipInitialMessage=true не добавил user-сообщение, только assistant от completeTesterRun
    const afterSkipMsgs = await repo.listAgentConversationMessages(conversation.id);
    expect(afterSkipMsgs).toHaveLength(countBeforeSkip + 1);
    const usageCountForConv = await db.q1<{ cnt: number }>(sql`
      select count(*) as cnt from agent_usage_events where user_id = ${userA} and ref_id = ${conversation.id}`);
    expect(Number(usageCountForConv?.cnt)).toBe(1);

    // Изоляция между пользователями
    expect(await repo.getTesterRun(userB, run.id)).toBeNull();
    expect(await repo.updateTesterMinorDecision(userB, run.id, "approved")).toBeNull();

    // Решение пользователя сохраняется в отчёт и пишется в переписку тестировщика
    const decided = await repo.updateTesterMinorDecision(userA, run.id, "approved", "Поправить шрифт тоже");
    expect(decided?.minorDecision).toBe("approved");

    // Удаление чата тестировщика каскадно удаляет связанные прогоны
    await repo.deleteAgentConversation(userA, conversation.id);
    expect(await repo.getTesterRun(userA, run.id)).toBeNull();
    expect(await repo.getTesterRun(userA, runSkip.run.id)).toBeNull();
  });

  it("API /api/agent/tester, /api/agent/tester/[id] и /api/agent/conversations?kind=tester соблюдают права и возвращают данные", async () => {
    const testerRoute = await import("@/app/api/agent/tester/route");
    const testerByIdRoute = await import("@/app/api/agent/tester/[id]/route");
    const convRoute = await import("@/app/api/agent/conversations/route");

    const createConvRes = await convRoute.POST(
      new Request("http://localhost/api/agent/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "tester", title: "QA: Ручной чат" }),
      }),
    );
    expect(createConvRes.status).toBe(200);
    const createdConv = (await createConvRes.json()) as { conversation: { id: number; kind: string } };
    expect(createdConv.conversation.kind).toBe("tester");

    const { run } = await repo.createTesterRunWithConversation({
      userId: userA,
      testerConversationId: createdConv.conversation.id,
      sandboxProject: "landing",
      summary: "Проверка лендинга",
      skipInitialMessage: true,
    });
    await repo.completeTesterRun(userA, run.id, {
      status: "minor_issues",
      reportSummary: "Мелкое замечание",
      minorIssues: [{ title: "Контраст ссылки", description: "Чуть темнее", file: "style.css" }],
    });

    const listRes = await testerRoute.GET(new Request("http://localhost/api/agent/tester"));
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as { runs: Array<{ id: number }>; conversations: Array<{ id: number }> };
    expect(listData.runs.some((r) => r.id === run.id)).toBe(true);
    expect(listData.conversations.some((c) => c.id === createdConv.conversation.id)).toBe(true);

    const decRes = await testerByIdRoute.POST(
      new Request(`http://localhost/api/agent/tester/${run.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "rejected", note: "Не трогать цвета" }),
      }),
      { params: Promise.resolve({ id: String(run.id) }) },
    );
    expect(decRes.status).toBe(200);
    const decJson = (await decRes.json()) as { run: { minorDecision: string } };
    expect(decJson.run.minorDecision).toBe("rejected");

    // Другой пользователь не видит чужой отчёт
    authMock.currentUser = {
      id: userB,
      email: "qa_other@example.com",
      name: "Другой",
      role: "user",
      canUseAgent: true,
      canUseAi: true,
    };
    const forbiddenDetail = await testerByIdRoute.GET(
      new Request(`http://localhost/api/agent/tester/${run.id}`),
      { params: Promise.resolve({ id: String(run.id) }) },
    );
    expect(forbiddenDetail.status).toBe(404);

    // Пользователь без canUseAgent получает 403
    authMock.currentUser.canUseAgent = false;
    const deniedList = await testerRoute.GET(new Request("http://localhost/api/agent/tester"));
    expect(deniedList.status).toBe(403);
  });

  it("SSE-оркестратор POST /api/ai/agent транслирует tester_start->tester_run, tester_done, recentTesterReports и не дублирует стартовое сообщение при agentRole='tester'", async () => {
    const agentChat = await repo.createAgentConversation(userA, "agent", "Главный чат");
    const encoder = new TextEncoder();
    let capturedBody: Record<string, unknown> = {};

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `event: tester_start\ndata: ${JSON.stringify({
                  runKey: "k1",
                  sandboxProject: "shop",
                  summary: "Магазин на HTML/JS",
                  model: "o3-mini",
                })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `event: tester_done\ndata: ${JSON.stringify({
                  runKey: "k1",
                  sandboxProject: "shop",
                  status: "critical_issues",
                  reportSummary: "Критическая ошибка в корзине",
                  criticalIssues: [{ title: "NaN в итоге", description: "item.price undefined", file: "cart.js", line: 15 }],
                  minorIssues: [],
                  checksRun: [{ name: "qa_static_review", status: "fail", details: "TypeError" }],
                  usage: { prompt: 210, completion: 90, total: 300 },
                })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode('event: text\ndata: {"text":"Исправляю ошибку корзины."}\n\n'));
            controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }),
    );

    const agentRoute = await import("@/app/api/ai/agent/route");
    const sseRes = await agentRoute.POST(
      new Request("http://localhost/api/ai/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentRole: "agent",
          agentConversationId: agentChat.id,
          messages: [{ role: "user", content: "Собери магазин и проверь" }],
          settings: { model: "o3-mini" },
        }),
      }),
    );
    expect(sseRes.status).toBe(200);
    const sseText = await sseRes.text();
    expect(sseText).toContain("event: tester_run");
    expect(sseText).toContain("event: tester_done");
    expect(capturedBody.agentRole).toBe("agent");

    const runsAfter = await repo.listTesterRuns(userA, 5);
    const shopRun = runsAfter.find((r) => r.sandboxProject === "shop");
    expect(shopRun?.status).toBe("critical_issues");
    expect(shopRun?.criticalIssues[0]?.title).toBe("NaN в итоге");
    expect(shopRun?.totalTokens).toBe(300);

    // Повторный запуск Агента получает recentTesterReports из БД
    await agentRoute.POST(
      new Request("http://localhost/api/ai/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentRole: "agent",
          agentConversationId: agentChat.id,
          messages: [{ role: "user", content: "Проверь отчёты" }],
        }),
      }),
    );
    const injectedContext = (capturedBody.context ?? {}) as Record<string, unknown>;
    const injectedReports = injectedContext.recentTesterReports as Array<Record<string, unknown>>;
    expect(Array.isArray(injectedReports)).toBe(true);
    expect(injectedReports.some((r) => r.sandboxProject === "shop")).toBe(true);

    // Прямой запуск agentRole="tester" в существующем QA-чате не создаёт дубликат user-сообщения
    const directConv = await repo.createAgentConversation(userA, "tester", "Прямой QA");
    await repo.insertAgentConversationMessage({
      userId: userA,
      conversationId: directConv.id,
      role: "user",
      content: "Проверь footer",
    });
    const directRes = await agentRoute.POST(
      new Request("http://localhost/api/ai/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentRole: "tester",
          testerConversationId: directConv.id,
          sandboxProject: "shop",
          messages: [{ role: "user", content: "Проверь footer" }],
        }),
      }),
    );
    await directRes.text();
    const msgsInDirect = await repo.listAgentConversationMessages(directConv.id);
    const userMsgsCount = msgsInDirect.filter((m) => m.role === "user").length;
    expect(userMsgsCount).toBe(1);
  });
});
