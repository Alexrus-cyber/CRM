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
});
