import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-launcher-bridge-"));
process.env.SQLITE_PATH = path.join(dir, "crm.sqlite");
process.env.DATABASE_URL = "";

const mockHeadersStore = {
  cookieToken: "",
  authorization: "",
};

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === "crm_session" && mockHeadersStore.cookieToken
        ? { value: mockHeadersStore.cookieToken }
        : undefined,
    set: vi.fn(),
    delete: vi.fn(),
  })),
  headers: vi.fn(async () => new Headers(mockHeadersStore.authorization ? { authorization: mockHeadersStore.authorization } : {})),
}));

let superId = 0;
let userId = 0;
let superToken = "";
let userToken = "";

let db: typeof import("@/db");
let repo: typeof import("@/db/repo");
let auth: typeof import("@/lib/auth");
let launcherProfile: typeof import("@/lib/launcherProfile");
let chatBridge: typeof import("@/app/api/launcher/chat/route");
let agentPrepare: typeof import("@/app/api/launcher/agent/prepare/route");
let agentEvents: typeof import("@/app/api/launcher/agent/events/route");

beforeAll(async () => {
  db = await import("@/db");
  repo = await import("@/db/repo");
  auth = await import("@/lib/auth");
  launcherProfile = await import("@/lib/launcherProfile");
  chatBridge = await import("@/app/api/launcher/chat/route");
  agentPrepare = await import("@/app/api/launcher/agent/prepare/route");
  agentEvents = await import("@/app/api/launcher/agent/events/route");

  await db.getDb();
  await db.q(sql`
    insert into users (email, password_hash, name, role, is_bot, can_use_agent, can_use_operator, created_at, updated_at)
    values
      ('boss@example.com', 'x', 'Boss', 'super_admin', 0, 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('emp@example.com', 'x', 'Employee', 'user', 0, 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `);
  superId = Number((await db.q1<{ id: number }>(sql`select id from users where email = 'boss@example.com'`))?.id);
  userId = Number((await db.q1<{ id: number }>(sql`select id from users where email = 'emp@example.com'`))?.id);

  superToken = (await auth.createLauncherSession(superId, { label: "Harness Super" })).token;
  userToken = (await auth.createLauncherSession(userId, { label: "Harness User" })).token;
});

beforeEach(() => {
  mockHeadersStore.cookieToken = "";
  mockHeadersStore.authorization = "";
});

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("Bearer fallback и мост CRM для настольного Harness", () => {
  it("getCurrentSessionToken и getCurrentUser поддерживают Authorization: Bearer при отсутствии cookie", async () => {
    expect(await auth.getCurrentSessionToken()).toBeNull();
    expect(await auth.getCurrentUser()).toBeNull();

    mockHeadersStore.authorization = `Bearer ${userToken}`;
    expect(await auth.getCurrentSessionToken()).toBe(userToken);
    const resolved = await auth.getCurrentUser();
    expect(resolved?.id).toBe(userId);

    // Cookie имеет приоритет над Bearer
    mockHeadersStore.cookieToken = superToken;
    expect(await auth.getCurrentSessionToken()).toBe(superToken);
    const resolvedCookie = await auth.getCurrentUser();
    expect(resolvedCookie?.id).toBe(superId);
  });

  it("buildLauncherProfile возвращает canViewAgentUsage, rolePolicies и агрегаты лимитов", async () => {
    const boss = (await repo.getUser(superId))!;
    const emp = (await repo.getUser(userId))!;

    const bossProfile = await launcherProfile.buildLauncherProfile(boss, "https://crm.example.com");
    expect(bossProfile.user.canViewAgentUsage).toBe(true);
    expect(bossProfile.rolePolicies.length).toBeGreaterThanOrEqual(5);
    expect(typeof bossProfile.limits.allUsed).toBe("number");
    expect(typeof bossProfile.limits.chatsCount).toBe("number");

    const empProfile = await launcherProfile.buildLauncherProfile(emp, "https://crm.example.com");
    expect(empProfile.user.canViewAgentUsage).toBe(false);
    expect(empProfile.limits.unlimited).toBe(false);
    expect(empProfile.rolePolicies.some((r) => r.role === "super_admin")).toBe(true);
  });

  it("/api/launcher/chat: prepare и record учитывают права, RAG и токены", async () => {
    const folder = await repo.createRagFolder(userId, "База регламентов");
    await repo.addRagChunks(folder.id, [
      { path: "doc.txt", chunks: ["Секретный пароль от ворот 9911."] },
    ]);

    const prepReq = new Request("https://crm.example.com/api/launcher/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        action: "prepare",
        params: { reasoning: "max" },
        ragFolderId: folder.id,
        ragQuery: "пароль от ворот",
      }),
    });
    const prepRes = await chatBridge.POST(prepReq);
    // Для роли user RAG выключен политикой -> 403
    expect(prepRes.status).toBe(403);

    // Без RAG для user: reasoning="max" понижается до допустимого уровня
    const prepOkReq = new Request("https://crm.example.com/api/launcher/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        action: "prepare",
        params: { reasoning: "max" },
      }),
    });
    const prepOkRes = await chatBridge.POST(prepOkReq);
    expect(prepOkRes.status).toBe(200);
    const prepData = (await prepOkRes.json()) as {
      ok: boolean;
      chat: { id: number; title: string };
      reasoningDowngraded: boolean;
      params: { reasoning: string };
    };
    expect(prepData.ok).toBe(true);
    expect(prepData.reasoningDowngraded).toBe(true);
    expect(prepData.params.reasoning).not.toBe("max");

    // Запись сообщений и токенов в БД
    const recReq = new Request("https://crm.example.com/api/launcher/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        action: "record",
        chatId: prepData.chat.id,
        userMessage: "Привет, проверь регламент",
        answer: "Готово, проверено.",
        thinking: "Думаю",
        promptTokens: 120,
        completionTokens: 45,
        usageReported: true,
      }),
    });
    const recRes = await chatBridge.POST(recReq);
    expect(recRes.status).toBe(200);
    const recData = (await recRes.json()) as {
      ok: boolean;
      usage: { total: number };
      chat: { title: string; tokensTotal: number };
    };
    expect(recData.ok).toBe(true);
    expect(recData.usage.total).toBe(165);
    expect(recData.chat.title).toContain("Привет");
    expect(recData.chat.tokensTotal).toBe(165);

    // Super admin с RAG-папкой получает ragContext
    const bossFolder = await repo.createRagFolder(superId, "Инструкции");
    await repo.addRagChunks(bossFolder.id, [
      { path: "guide.md", chunks: ["Код сборки CRM: 7744."] },
    ]);
    const bossPrepRes = await chatBridge.POST(
      new Request("https://crm.example.com/api/launcher/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${superToken}`,
        },
        body: JSON.stringify({
          action: "prepare",
          params: { reasoning: "max", ragChunks: 4 },
          ragFolderId: bossFolder.id,
          ragQuery: "код сборки",
        }),
      }),
    );
    expect(bossPrepRes.status).toBe(200);
    const bossPrepData = (await bossPrepRes.json()) as {
      ragContext: string;
      ragHits: number;
      params: { reasoning: string };
    };
    expect(bossPrepData.params.reasoning).toBe("max");
    expect(bossPrepData.ragHits).toBe(1);
    expect(bossPrepData.ragContext).toContain("7744");
  });

  it("/api/launcher/agent/prepare: проверяет права, субагентов, отключение Надсмотрщика и loopback LLM", async () => {
    // Без доступа к агенту -> 403
    const deniedRes = await agentPrepare.POST(
      new Request("https://crm.example.com/api/launcher/agent/prepare", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Привет" }],
        }),
      }),
    );
    expect(deniedRes.status).toBe(403);

    // Настраиваем субагента и отключаем Надсмотрщика у super_admin
    const sub = await repo.createSubagent(superId, {
      name: "Аналитик",
      toolProfile: "restricted",
      isActive: true,
    });
    await repo.upsertAgentOrchestrationConfig(superId, {
      routingMode: "layered",
      overseer: { enabled: false },
    });

    const okRes = await agentPrepare.POST(
      new Request("https://crm.example.com/api/launcher/agent/prepare", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${superToken}`,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Сделай отчёт" }],
          settings: { baseUrl: "http://127.0.0.1:1234/v1", model: "qwen3-coder" },
          allowClientLoopback: true,
        }),
      }),
    );
    expect(okRes.status).toBe(200);
    const prep = (await okRes.json()) as {
      ok: boolean;
      payload: {
        subagentRoutingMode: string;
        overseer: { enabled: boolean };
        subagents: Array<{ id: number; name: string }>;
        settings: { baseUrl: string; model: string };
      };
      meta: { model: string };
    };
    expect(prep.ok).toBe(true);
    expect(prep.meta.model).toBe("qwen3-coder");
    expect(prep.payload.settings.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(prep.payload.subagentRoutingMode).toBe("layered");
    expect(prep.payload.overseer.enabled).toBe(false);
    expect(prep.payload.subagents.some((s) => s.id === sub.id && s.name === "Аналитик")).toBe(true);
  });

  it("/api/launcher/agent/events: синхронизирует субагентов, тестировщика и usage", async () => {
    const sub = await repo.createSubagent(superId, { name: "Кодер QA", isActive: true });

    const startRes = await agentEvents.POST(
      new Request("https://crm.example.com/api/launcher/agent/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${superToken}` },
        body: JSON.stringify({
          action: "subagent_start",
          subagentId: sub.id,
          task: "Напиши модуль",
          model: "qwen3",
        }),
      }),
    );
    expect(startRes.status).toBe(200);
    const startData = (await startRes.json()) as { runId: number; subagentConversationId: number };
    expect(startData.runId).toBeGreaterThan(0);

    const hbRes = await agentEvents.POST(
      new Request("https://crm.example.com/api/launcher/agent/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${superToken}` },
        body: JSON.stringify({ action: "subagent_heartbeat", runIds: [startData.runId] }),
      }),
    );
    expect(hbRes.status).toBe(200);

    const doneRes = await agentEvents.POST(
      new Request("https://crm.example.com/api/launcher/agent/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${superToken}` },
        body: JSON.stringify({
          action: "subagent_done",
          runId: startData.runId,
          status: "completed",
          outputSummary: "Модуль написан",
          fullResponse: "Готовый результат работы",
          promptTokens: 300,
          completionTokens: 120,
          totalTokens: 420,
          model: "qwen3",
        }),
      }),
    );
    expect(doneRes.status).toBe(200);
    const savedRun = await repo.getSubagentRun(superId, startData.runId);
    expect(savedRun?.status).toBe("completed");
    expect(savedRun?.totalTokens).toBe(420);

    // Тестировщик + usage
    const tStart = await agentEvents.POST(
      new Request("https://crm.example.com/api/launcher/agent/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${superToken}` },
        body: JSON.stringify({ action: "tester_start", title: "Прогон", summary: "Проверка UI" }),
      }),
    );
    expect(tStart.status).toBe(200);
    const tStartData = (await tStart.json()) as { runId: number };

    const tDone = await agentEvents.POST(
      new Request("https://crm.example.com/api/launcher/agent/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${superToken}` },
        body: JSON.stringify({
          action: "tester_done",
          runId: tStartData.runId,
          status: "minor_issues",
          reportSummary: "Есть мелкое замечание",
          minorIssues: ["Небольшой отступ"],
        }),
      }),
    );
    expect(tDone.status).toBe(200);

    const tDec = await agentEvents.POST(
      new Request("https://crm.example.com/api/launcher/agent/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${superToken}` },
        body: JSON.stringify({
          action: "tester_decision",
          runId: tStartData.runId,
          decision: "approved",
          note: "Принято",
        }),
      }),
    );
    expect(tDec.status).toBe(200);

    const uRes = await agentEvents.POST(
      new Request("https://crm.example.com/api/launcher/agent/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${superToken}` },
        body: JSON.stringify({
          action: "usage",
          kind: "agent",
          model: "qwen3",
          promptTokens: 500,
          completionTokens: 200,
          totalTokens: 700,
        }),
      }),
    );
    expect(uRes.status).toBe(200);
    const usageAfter = await repo.getAgentUsage(superId);
    expect(usageAfter.month.agent.total).toBeGreaterThanOrEqual(1120);
  });
});
