import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { requestAgentStepCoaching, resolveAdaptiveCoachParams } from "@/lib/agentCoach";
import { normalizeTaskMode } from "@/lib/operatorModes";
import { describeAction } from "@/components/operator/shared";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-op-collab-"));
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
    values ('collab@test.local', 'x', 'Admin', 'super_admin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `);
  const row = await db.q1<{ id: number }>(sql`select id from users where email = 'collab@test.local'`);
  userId = Number(row?.id);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("связка Агент ↔ Оператор, режимы и пошаговый коучинг", () => {
  it("сохраняет taskMode, source, coachMode и guidanceNote в задаче и событиях", async () => {
    const task = await repo.createAgentTask(userId, "Побеги вперёд и открой дверь", 45, "verified", {
      taskMode: "game",
      coachMode: "agent",
      source: "agent",
    });
    expect(task.taskMode).toBe("game");
    expect(task.coachMode).toBe("agent");
    expect(task.source).toBe("agent");
    expect(task.guidanceNote).toBeNull();

    const saved = await repo.setAgentTaskGuidance(task.id, userId, {
      author: "agent",
      text: "hold_key w 0.6s -> key e",
      userAdvice: "Подходим к двери и открываем её клавишей E",
    });
    expect(saved?.guidance.author).toBe("agent");
    expect(saved?.task?.guidanceNote?.text).toBe("hold_key w 0.6s -> key e");
    expect(saved?.task?.guidanceNote?.userAdvice).toContain("клавишей E");

    const loaded = await repo.getAgentTask(userId, task.id);
    expect(loaded?.guidanceNote?.id).toBe(saved?.guidance.id);
    const all = await repo.listAgentTasks(userId, 10);
    expect(all[0]?.taskMode).toBe("game");
    expect(all[0]?.source).toBe("agent");

    const events = await repo.listAgentEvents(task.id, 20);
    expect(events.some((ev) => ev.kind === "guidance" && ev.text.includes("открываем её клавишей E"))).toBe(true);
  });

  it("requestAgentStepCoaching берёт подсказку из AGENT_URL/coach и умеет fallback в эвристику", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/coach")) {
          return new Response(
            JSON.stringify({
              ok: true,
              guidanceForOperator: "Используй move_mouse_rel(80, 0) чтобы навестись на сундук",
              adviceForUser: "Поворачиваем камеру правее к сундуку",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404 });
      }),
    );

    const coached = await requestAgentStepCoaching({
      agentUrl: "http://127.0.0.1:8899",
      taskPrompt: "Найди сундук в игре",
      taskMode: "game",
      step: 2,
      lastAction: { type: "hold_key", key: "w", seconds: 0.7 },
      lastResult: "удержание w (0.70 с)",
    });
    expect(coached.source).toBe("agent");
    expect(coached.guidanceForOperator).toContain("move_mouse_rel");
    expect(coached.adviceForUser).toContain("сундук");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const fallback = await requestAgentStepCoaching({
      agentUrl: "http://127.0.0.1:8899",
      taskPrompt: "Найди сундук",
      taskMode: "game",
      step: 3,
      lastResult: "экран обновлён",
    });
    expect(fallback.source).toBe("heuristic");
    expect(fallback.guidanceForOperator).toContain("экран обновлён");
    expect(fallback.guidanceForOperator).toContain("hold_key");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          phase?: string;
          plannedAction?: { type?: string };
          aimPoint?: { x?: number; y?: number };
        };
        expect(body.phase).toBe("before_action");
        expect(body.plannedAction?.type).toBe("double_click");
        expect(body.aimPoint).toEqual({ x: 340, y: 200 });
        return new Response(
          JSON.stringify({
            ok: true,
            approved: false,
            visionUsed: true,
            reason: "крестик чуть выше кнопки",
            guidanceForOperator: "Смести курсор на 20px ниже",
            adviceForUser: "Поправляем наведение перед двойным кликом",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const beforeCheck = await requestAgentStepCoaching({
      agentUrl: "http://127.0.0.1:8899",
      taskPrompt: "Открой папку",
      taskMode: "copilot",
      phase: "before_action",
      step: 1,
      plannedAction: { type: "double_click", x: 340, y: 200 },
      aimPoint: { x: 340, y: 200 },
      screenshot: "data:image/jpeg;base64,AAA",
    });
    expect(beforeCheck.approved).toBe(false);
    expect(beforeCheck.visionUsed).toBe(true);
    expect(beforeCheck.reason).toContain("выше кнопки");
  });

  it("describeAction переводит игровые и интерактивные действия на русский", () => {
    expect(describeAction(JSON.stringify({ type: "hold_key", key: "w", seconds: 0.8 }))?.title).toContain(
      "Удержание клавиши w",
    );
    expect(describeAction(JSON.stringify({ type: "move_mouse_rel", dx: 120, dy: -20 }))?.title).toContain(
      "Смещение камеры/мыши (120, -20)",
    );
    expect(
      describeAction(JSON.stringify({ type: "sequence", steps: [{ type: "key", key: "e" }, { type: "wait", seconds: 1 }] }))
        ?.title,
    ).toContain("2 действий");
    expect(describeAction(JSON.stringify({ type: "mouse_down", button: "left" }))?.title).toContain("Зажата кнопка");
    expect(describeAction(JSON.stringify({ type: "key_down", key: "shift" }))?.title).toContain("Зажата клавиша shift");
    expect(describeAction(JSON.stringify({ type: "inspect_screen" }))?.title).toContain("Снимок экрана ПК");
    expect(describeAction(JSON.stringify({ type: "pc_command", command: "dir C:\\" }))?.title).toContain(
      "Команда на ПК (с разрешения)",
    );
  });

  it("сохраняет снимок экрана Оператора (kind=screen) и возвращает его через getLatestAgentScreen", async () => {
    expect(normalizeTaskMode("inspect")).toBe("inspect");
    const task = await repo.createAgentTask(userId, "Покажи экран для Агента", 2, "verified", {
      taskMode: "inspect",
      coachMode: "off",
      source: "agent",
    });
    expect(task.taskMode).toBe("inspect");

    await repo.addAgentEvent({
      taskId: task.id,
      kind: "screen",
      text: "Снимок экрана ПК (1280×720). Активное окно: Terminal",
      action: JSON.stringify({ type: "inspect_screen", activeWindow: "Terminal", width: 1280, height: 720 }),
      fileName: "screen.jpg",
      fileMime: "image/jpeg",
      fileSize: 9,
      fileData: "/9j/4AAQ",
    });

    const latest = await repo.getLatestAgentScreen(task.id);
    expect(latest).not.toBeNull();
    expect(latest?.summary).toContain("Terminal");
    expect(latest?.dataUrl).toBe("data:image/jpeg;base64,/9j/4AAQ");
    expect(latest?.meta).toMatchObject({ activeWindow: "Terminal", width: 1280, height: 720 });
  });

  it("resolveAdaptiveCoachParams уважает настройки человека и повышает reasoning/temperature при зацикливании", async () => {
    const clean = resolveAdaptiveCoachParams(
      { reasoning: "off", temperature: 0.1, maxTokens: 1200 },
      { repeatStreak: 0, failedChecks: 0, phase: "after_step" },
    );
    expect(clean.params.reasoning).toBe("off");
    expect(clean.params.temperature).toBe(0.1);
    expect(clean.params.maxTokens).toBe(1200);

    const defaulted = resolveAdaptiveCoachParams(
      { reasoning: "default" },
      { repeatStreak: 0, failedChecks: 0, phase: "after_step" },
    );
    expect(defaulted.params.reasoning).toBe("medium");
    expect(defaulted.params.maxTokens).toBeGreaterThanOrEqual(900);

    const beforeStuck = resolveAdaptiveCoachParams(
      { reasoning: "default", temperature: 0.15 },
      { repeatStreak: 3, failedChecks: 1, phase: "before_action" },
    );
    expect(beforeStuck.params.reasoning).toBe("high");
    expect(beforeStuck.params.temperature).toBeGreaterThanOrEqual(0.55);

    const payloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/coach")) {
          return new Response("agent down", { status: 503 });
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        payloads.push(body);
        if (payloads.length === 1) {
          return new Response(JSON.stringify({ error: "unsupported field reasoning_effort" }), { status: 400 });
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    approved: true,
                    reason: "В выделенной строке кнопка Сохранить",
                    guidanceForOperator: "Клик по кнопке Сохранить подтверждён",
                    adviceForUser: "Нажимаем Сохранить",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const modelRes = await requestAgentStepCoaching({
      agentUrl: "http://127.0.0.1:8899",
      taskPrompt: "Сохрани файл",
      taskMode: "copilot",
      phase: "before_action",
      step: 2,
      repeatStreak: 3,
      cursorContext: "активное окно: Блокнот | элемент: Сохранить",
      screenshot: "data:image/jpeg;base64,AAA",
      cursorCrop: "data:image/jpeg;base64,BBB",
      params: { reasoning: "default", temperature: 0.15 },
      settings: { baseUrl: "http://127.0.0.1:8888/v1", model: "strict-vlm" },
    });
    expect(modelRes.source).toBe("model");
    expect(modelRes.approved).toBe(true);
    expect(modelRes.visionUsed).toBe(true);
    expect(payloads).toHaveLength(2);
    expect(payloads[0].reasoning_effort).toBe("high");
    expect(payloads[1].reasoning_effort).toBeUndefined();
  });

  it("syncOperatorTaskToConversation сохраняет мысли, шаги и итог Оператора как обновляемый чат Агента", async () => {
    const task = await repo.createAgentTask(userId, "Открой заметки и проверь список дел", 20, "verified", {
      taskMode: "copilot",
      coachMode: "agent",
      source: "agent",
    });

    await repo.addAgentEvent({
      taskId: task.id,
      kind: "thought",
      text: "Вижу окно рабочего стола, навожу курсор на значок Заметки",
    });
    await repo.addAgentEvent({
      taskId: task.id,
      kind: "action",
      text: "Двойной клик (120, 240)",
      action: JSON.stringify({ type: "double_click", x: 120, y: 240 }),
    });

    const convId1 = await repo.syncOperatorTaskToConversation(userId, task.id);
    expect(convId1).toBeTruthy();

    // Симулируем продолжение диалога пользователем в этом чате, затем новое событие Оператора.
    await repo.insertAgentConversationMessage({
      userId,
      conversationId: convId1!,
      role: "user",
      content: "А какой последний пункт в заметках?",
    });

    await repo.addAgentEvent({
      taskId: task.id,
      kind: "thought",
      text: "Окно Заметок открылось, вижу пункт Позвонить клиенту",
    });
    await repo.setAgentTaskStatus(task.id, userId, "done", "Заметки открыты и проверены");

    const convId2 = await repo.syncOperatorTaskToConversation(userId, task.id);
    expect(convId2).toBe(convId1);

    const found = await repo.findOperatorTaskConversation(userId, task.id);
    expect(found?.id).toBe(convId1);

    const msgs = await repo.listAgentConversationMessages(convId1!);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toContain("Открой заметки");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].reasoning).toContain("Окно Заметок открылось");
    expect(msgs[1].content).toContain("Двойной клик (120, 240)");
    expect(msgs[1].content).toContain("Заметки открыты и проверены");
    expect(msgs[2].role).toBe("user");
    expect(msgs[2].content).toContain("какой последний пункт");
  });
});
