import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { requestAgentStepCoaching } from "@/lib/agentCoach";
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
  });
});
