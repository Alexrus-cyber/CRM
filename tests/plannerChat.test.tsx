import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PlannerChat } from "@/components/operator/PlannerChat";
import { GEN_DEFAULT_PARAMS } from "@/lib/genParams";
import { DEFAULT_PLAN_PROMPT } from "@/lib/operatorPlan";

type Conv = {
  id: number;
  kind: "plan";
  title: string;
  systemPrompt: string;
  messagesCount: number;
  updatedAt: string;
};

type Msg = {
  id: number;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  attachments?: Array<{ name: string; size: number }>;
};

let conversations: Conv[];
let messagesByConv: Record<number, Msg[]>;
let planRequests: Array<{ systemPrompt?: string; messages?: Array<{ role: string; content: string }> }>;
let nextConvId: number;
let nextMsgId: number;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockServer() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.startsWith("/api/agent/conversations?kind=plan") && method === "GET") {
        return json({ conversations });
      }
      if (url === "/api/agent/conversations" && method === "POST") {
        const created: Conv = {
          id: nextConvId++,
          kind: "plan",
          title: "Новый план",
          systemPrompt: DEFAULT_PLAN_PROMPT,
          messagesCount: 0,
          updatedAt: "2026-11-17T10:00:00.000Z",
        };
        conversations = [created, ...conversations];
        messagesByConv[created.id] = [];
        return json({ conversation: created });
      }

      const convMatch = url.match(/^\/api\/agent\/conversations\/(\d+)$/);
      if (convMatch && method === "GET") {
        const id = Number(convMatch[1]);
        const conversation = conversations.find((item) => item.id === id);
        if (!conversation) return json({ error: "Not found" }, 404);
        return json({ conversation, messages: messagesByConv[id] ?? [] });
      }
      if (convMatch && method === "PATCH") {
        const id = Number(convMatch[1]);
        const body = JSON.parse(String(init?.body ?? "{}")) as { systemPrompt?: string };
        conversations = conversations.map((item) =>
          item.id === id && body.systemPrompt !== undefined
            ? { ...item, systemPrompt: body.systemPrompt }
            : item,
        );
        return json({ conversation: conversations.find((item) => item.id === id) });
      }
      if (convMatch && method === "DELETE") {
        const id = Number(convMatch[1]);
        conversations = conversations.filter((item) => item.id !== id);
        delete messagesByConv[id];
        return json({ ok: true });
      }

      const msgMatch = url.match(/^\/api\/agent\/conversations\/(\d+)\/messages$/);
      if (msgMatch && method === "POST") {
        const id = Number(msgMatch[1]);
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          role: "user" | "assistant";
          content: string;
          reasoning?: string;
          attachments?: Array<{ name: string; size: number }>;
        };
        const stored: Msg = {
          id: nextMsgId++,
          role: body.role,
          content: body.content,
          reasoning: body.reasoning,
          attachments: body.attachments,
        };
        messagesByConv[id] = [...(messagesByConv[id] ?? []), stored];
        return json({ message: stored });
      }

      if (url === "/api/agent/plan" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          systemPrompt?: string;
          messages?: Array<{ role: string; content: string }>;
        };
        planRequests.push(body);
        return json({ reply: "1. Открыть блокнот\nГотово, когда: текст виден." });
      }

      return json({ error: `unexpected ${method} ${url}` }, 500);
    }),
  );
}

describe("чат-планировщик «Оператора»", () => {
  beforeEach(() => {
    conversations = [];
    messagesByConv = {};
    planRequests = [];
    nextConvId = 1;
    nextMsgId = 1;
    mockServer();
  });

  it("подставляет примерный промпт, сохраняет изменения отдельно для чата и шлёт в /api/agent/plan", async () => {
    render(
      <PlannerChat
        baseUrl="http://127.0.0.1:8888/v1"
        model="qwen3-vl:8b"
        apiKey=""
        providerLabel="Локальный"
        params={GEN_DEFAULT_PARAMS}
        onTransfer={async () => undefined}
        onOpenSetup={() => undefined}
      />,
    );

    const promptArea = (await screen.findByLabelText("Системный промпт планировщика")) as HTMLTextAreaElement;
    await waitFor(() => expect(promptArea.disabled).toBe(false));
    expect(promptArea.value).toBe(DEFAULT_PLAN_PROMPT);

    fireEvent.change(promptArea, { target: { value: "Отвечай только списком из 2 шагов" } });

    const input = screen.getByPlaceholderText(/Что нужно сделать/i);
    fireEvent.change(input, { target: { value: "открой заметки" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() => expect(planRequests).toHaveLength(1));
    expect(planRequests[0].systemPrompt).toBe("Отвечай только списком из 2 шагов");
    expect(await screen.findByText(/1\. Открыть блокнот/)).toBeTruthy();

    // Кнопка «Сбросить к примеру» возвращает исходный системный промпт.
    fireEvent.click(screen.getByRole("button", { name: /Сбросить к примеру/ }));
    expect(promptArea.value).toBe(DEFAULT_PLAN_PROMPT);
    fireEvent.change(promptArea, { target: { value: "Отвечай только списком из 2 шагов" } });
    await waitFor(() =>
      expect(conversations.find((c) => c.id === 1)?.systemPrompt).toBe("Отвечай только списком из 2 шагов"),
    );

    // В новом чате — снова примерный промпт, а первый чат сохранил свой.
    fireEvent.click(screen.getByRole("button", { name: /Новый чат/ }));
    await waitFor(() => expect(promptArea.value).toBe(DEFAULT_PLAN_PROMPT));
    expect(conversations.find((c) => c.id === 1)?.systemPrompt).toBe("Отвечай только списком из 2 шагов");

    // Переключаемся обратно на первый чат — видим и переписку, и его промпт.
    const select = screen.getByLabelText("История чатов планировщика") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "1" } });
    await waitFor(() => expect(promptArea.value).toBe("Отвечай только списком из 2 шагов"));
    expect(screen.getByText("открой заметки", { selector: "p" })).toBeTruthy();

    // Удаление чата переключает на оставшийся чат.
    fireEvent.click(screen.getByRole("button", { name: "Удалить план-чат" }));
    await waitFor(() => expect(promptArea.value).toBe(DEFAULT_PLAN_PROMPT));
    expect(screen.queryByText("открой заметки", { selector: "p" })).toBeNull();
  });
});
