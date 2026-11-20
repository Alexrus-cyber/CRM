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
    let currentTasks = [
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
          return json({
            task: {
              ...currentTasks[0],
              id: 43,
              prompt: String(body.prompt ?? ""),
              status: "queued",
              trustLevel: String(body.trustLevel ?? "verified"),
              pendingApproval: "",
            },
          });
        }
        if (url === "/api/agent/tasks/42" && method === "GET") {
          return json({ task: currentTasks[0], events: [] });
        }
        if (url === "/api/agent/tasks/42" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          taskPosts.push({ url, body });
          if (body.action === "approve") {
            currentTasks = [
              {
                ...currentTasks[0],
                status: "waiting_steps",
                pendingApproval: JSON.stringify({
                  id: "req-steps",
                  kind: "step_limit",
                  title: "Достигнут лимит 10 шагов",
                  extraSteps: 20,
                }),
              },
            ];
          } else if (body.action === "extend_steps") {
            currentTasks = [
              {
                ...currentTasks[0],
                status: "running",
                maxSteps: 30,
                pendingApproval: "",
              },
            ];
          }
          return json({ ok: true, task: currentTasks[0] });
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

    // Отображается карточка подтверждения опасного действия.
    expect(await screen.findByText(/Подтвердите действие: launch_app calc/)).toBeTruthy();
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

    // Выбор уровня доверия «Нет доступа, к компьютеру для исполнения задач» передаётся в задачу.
    fireEvent.click(screen.getByRole("radio", { name: /Нет доступа, к компьютеру для исполнения задач/ }));
    const promptBox = screen.getByPlaceholderText(/План из чата слева/i);
    fireEvent.change(promptBox, { target: { value: "Сделай отчёт" } });
    fireEvent.click(screen.getByRole("button", { name: /В очередь/ }));
    await waitFor(() => expect(taskPosts.some((p) => p.url === "/api/agent/tasks")).toBe(true));
    const createdCall = taskPosts.find((p) => p.url === "/api/agent/tasks")!;
    expect(createdCall.body.trustLevel).toBe("none");
  });
});
