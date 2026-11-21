import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OperatorPanel } from "@/components/OperatorPanel";

const requestedUrls: string[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("ручная проверка подключения бота во вкладке «Оператор»", () => {
  beforeEach(() => {
    localStorage.clear();
    requestedUrls.length = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requestedUrls.push(`${method} ${url}`);

        if (url === "/api/agent/tasks") return json({ tasks: [] });
        if (url.startsWith("/api/agent/conversations?kind=plan")) {
          return json({
            conversations: [
              { id: 1, kind: "plan", title: "Новый план", messagesCount: 0, updatedAt: "2026-11-17T10:00:00.000Z" },
            ],
          });
        }
        if (url === "/api/agent/conversations/1") {
          return json({
            conversation: { id: 1, kind: "plan", title: "Новый план", systemPrompt: "test", messagesCount: 0 },
            messages: [],
          });
        }
        if (url.startsWith("/api/agent/bot/status")) {
          return json({
            ok: true,
            state: "online",
            connected: true,
            secondsAgo: 3,
            tokenName: "Ноутбук",
            tokenHint: "…123456",
            connectionName: "Этот CRM",
            tokensCount: 1,
            totalTokensCount: 1,
            runningTask: null,
            queue: { queued: 1, running: 0 },
            checkedAt: "2026-11-17T10:05:00.000Z",
          });
        }

        return json({ ok: true });
      }),
    );
  });

  it("не опрашивает статус автоматически и проверяет подключение только по кнопке", async () => {
    render(<OperatorPanel />);
    await waitFor(() => expect(requestedUrls.some((entry) => entry.includes("/api/agent/tasks"))).toBe(true));

    // На старте автоматического статуса и запроса /api/agent/bot/status нет.
    expect(requestedUrls.some((entry) => entry.includes("/api/agent/bot/status"))).toBe(false);
    expect(screen.queryByText(/Бот подключён/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Проверить подключение бота/ }));

    expect(await screen.findByText(/Бот подключён/)).toBeTruthy();
    expect(screen.getByText(/Ноутбук/)).toBeTruthy();
    expect(requestedUrls.filter((entry) => entry.includes("/api/agent/bot/status"))).toHaveLength(1);
  });

  it("передаёт уровень доверия при создании задачи и позволяет одобрить действие или продлить шаги на сайте", async () => {
    const taskPosts: Array<{ url: string; body: Record<string, unknown> }> = [];
    let currentTasks: Array<Record<string, unknown>> = [
      {
        id: 42,
        prompt: "Открой калькулятор",
        status: "waiting_approval",
        maxSteps: 10,
        steps: 4,
        summary: "",
        trustLevel: "verified",
        pendingApproval: JSON.stringify({
          id: "req-calc",
          kind: "dangerous_action",
          title: "Подтвердите действие: launch_app calc",
          description: "ИИ запрашивает запуск программы",
          action: { type: "launch_app", app: "calc" },
        }),
        approvalResponse: "",
        createdAt: "2026-11-17T10:00:00.000Z",
        updatedAt: "2026-11-17T10:01:00.000Z",
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/agent/tasks" && method === "GET") return json({ tasks: currentTasks });
        if (url === "/api/agent/tasks" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          taskPosts.push({ url, body });
          const created = {
            ...currentTasks[0],
            id: 43,
            prompt: String(body.prompt ?? ""),
            status: "queued",
            trustLevel: String(body.trustLevel ?? "verified"),
            taskMode: String(body.taskMode ?? "autonomous"),
            coachMode: String(body.coachMode ?? "after_step"),
            pendingApproval: "",
          };
          currentTasks = [created, ...currentTasks];
          return json({ task: created });
        }
        const getMatch = url.match(/^\/api\/agent\/tasks\/(\d+)$/);
        if (getMatch && method === "GET") {
          const tid = Number(getMatch[1]);
          const found = currentTasks.find((t) => t.id === tid) ?? currentTasks[0];
          return json({ task: found, events: [] });
        }
        if (getMatch && method === "POST") {
          const tid = Number(getMatch[1]);
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          taskPosts.push({ url, body });
          currentTasks = currentTasks.map((t) => {
            if (t.id !== tid) return t;
            if (body.action === "approve") {
              return {
                ...t,
                status: "waiting_steps",
                pendingApproval: JSON.stringify({
                  id: "req-steps",
                  kind: "step_limit",
                  title: "Достигнут лимит 10 шагов",
                  extraSteps: 20,
                }),
              };
            }
            if (body.action === "extend_steps") {
              return {
                ...t,
                status: "running",
                maxSteps: 30,
                pendingApproval: "",
              };
            }
            if (body.action === "guidance") {
              return {
                ...t,
                guidanceNote: {
                  id: "g-manual",
                  author: "user",
                  text: String(body.text ?? ""),
                  createdAt: "2026-11-17T10:05:00.000Z",
                },
              };
            }
            return t;
          });
          const updated = currentTasks.find((t) => t.id === tid) ?? currentTasks[0];
          return json({ ok: true, task: updated });
        }
        if (url === "/api/ai/agent/coach" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          taskPosts.push({ url, body });
          const tid = Number(body.taskId ?? 43);
          currentTasks = currentTasks.map((t) =>
            t.id === tid
              ? {
                  ...t,
                  guidanceNote: {
                    id: "g-agent",
                    author: "agent",
                    text: "hold_key w 0.6s",
                    userAdvice: "Бежим вперёд к воротам",
                    createdAt: "2026-11-17T10:06:00.000Z",
                  },
                }
              : t,
          );
          const updated = currentTasks.find((t) => t.id === tid) ?? currentTasks[0];
          return json({ ok: true, task: updated });
        }
        if (url.startsWith("/api/agent/conversations?kind=plan")) {
          return json({ conversations: [{ id: 1, kind: "plan", title: "План", messagesCount: 0 }] });
        }
        if (url === "/api/agent/conversations/1") {
          return json({
            conversation: { id: 1, kind: "plan", title: "План", systemPrompt: "t", messagesCount: 0 },
            messages: [],
          });
        }
        return json({ ok: true });
      }),
    );

    render(<OperatorPanel />);

    // Отображается всплывающее уведомление подтверждения опасного действия справа внизу.
    const approvalToast = await screen.findByRole("alertdialog", {
      name: /Подтвердите действие: launch_app calc/,
    });
    const stackEl = document.getElementById("crm-approval-toast-stack");
    expect(stackEl?.className).toContain("fixed");
    expect(stackEl?.className).toContain("bottom-4");
    expect(stackEl?.className).toContain("right-4");
    expect(stackEl?.contains(approvalToast)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Разрешить выполнение/ }));
    await waitFor(() =>
      expect(taskPosts.some((p) => p.url === "/api/agent/tasks/42" && p.body.action === "approve")).toBe(true),
    );

    // После approval задача ждёт продления шагов — нажимаем «+20 шагов и продолжить».
    expect(await screen.findByText(/Достигнут лимит 10 шагов/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /\+20 шагов и продолжить/ }));
    await waitFor(() =>
      expect(taskPosts.some((p) => p.url === "/api/agent/tasks/42" && p.body.action === "extend_steps")).toBe(true),
    );

    // Выбор уровня доверия «Нет доступа, к компьютеру для исполнения задач» и игрового режима передаются в задачу.
    fireEvent.click(screen.getByRole("radio", { name: /Нет доступа, к компьютеру для исполнения задач/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Игра$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Ведёт Агент/i }));
    const promptBox = screen.getByPlaceholderText(/Опишите цель в игре/i);
    fireEvent.change(promptBox, { target: { value: "Пройди квест в игре" } });
    fireEvent.click(screen.getByRole("button", { name: /В очередь/ }));
    await waitFor(() => expect(taskPosts.some((p) => p.url === "/api/agent/tasks")).toBe(true));
    const createdCall = taskPosts.find((p) => p.url === "/api/agent/tasks")!;
    expect(createdCall.body.trustLevel).toBe("none");
    expect(createdCall.body.taskMode).toBe("game");
    expect(createdCall.body.coachMode).toBe("agent");

    // Ручная подсказка и кнопка «Совет Агента» работают в живой задаче (#43).
    const hintInput = screen.getByPlaceholderText(/Подсказка на следующий шаг/i);
    fireEvent.change(hintInput, { target: { value: "Нажми E у двери" } });
    fireEvent.click(screen.getByRole("button", { name: /Подсказать/i }));
    await waitFor(() =>
      expect(taskPosts.some((p) => p.url === "/api/agent/tasks/43" && p.body.action === "guidance")).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: /Совет Агента/i }));
    await waitFor(() => expect(taskPosts.some((p) => p.url === "/api/ai/agent/coach")).toBe(true));
    expect(await screen.findByText(/Бежим вперёд к воротам/)).toBeTruthy();
  });
});
