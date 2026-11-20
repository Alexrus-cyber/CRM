import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentChat } from "@/components/AgentChat";

type Sent = {
  messages?: Array<{ role: string; content: string }>;
  params?: Record<string, unknown>;
  attachments?: Array<{ name: string; text: string }>;
};

type StoredConversation = {
  id: number;
  kind: "agent";
  title: string;
  messagesCount: number;
  updatedAt: string;
};

type StoredMsg = {
  id: number;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  error?: string;
  attachments?: Array<{ name: string; size: number }>;
  actions?: Array<{ type: "open_url"; url: string; label: string; autoplay?: boolean }>;
  files?: Array<{ name: string; mime: string; size: number }>;
};

const sent: Sent[] = [];
const savedMessages: Array<{ conversationId: number; body: Record<string, unknown> }> = [];
let conversations: StoredConversation[] = [];
let messagesByConv: Record<number, StoredMsg[]> = {};
let nextConvId = 1;
let nextMsgId = 1;
let sseReply = "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/ai/agent" && method === "GET") {
        return json({ available: true, tools: [] });
      }
      if (url === "/api/ai/agent" && method === "POST") {
        sent.push(JSON.parse(String(init?.body ?? "{}")) as Sent);
        if (sseReply) {
          return new Response(sseReply, { status: 200, headers: { "Content-Type": "text/event-stream" } });
        }
        return json({ error: "тест" });
      }

      if (url.startsWith("/api/agent/conversations?kind=agent") && method === "GET") {
        return json({ conversations });
      }
      if (url === "/api/agent/conversations" && method === "POST") {
        const created: StoredConversation = {
          id: nextConvId++,
          kind: "agent",
          title: "Новый чат",
          messagesCount: 0,
          updatedAt: "2026-11-17T10:00:00.000Z",
        };
        conversations = [created, ...conversations];
        messagesByConv[created.id] = [];
        return json({ conversation: created });
      }

      const msgMatch = url.match(/^\/api\/agent\/conversations\/(\d+)\/messages$/);
      if (msgMatch && method === "POST") {
        const id = Number(msgMatch[1]);
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        savedMessages.push({ conversationId: id, body });
        const stored: StoredMsg = {
          id: nextMsgId++,
          role: body.role === "assistant" ? "assistant" : "user",
          content: String(body.content ?? ""),
          reasoning: String(body.reasoning ?? ""),
          error: String(body.error ?? ""),
          attachments: Array.isArray(body.attachments) ? (body.attachments as StoredMsg["attachments"]) : [],
          actions: Array.isArray(body.actions) ? (body.actions as StoredMsg["actions"]) : [],
          files: Array.isArray(body.files) ? (body.files as StoredMsg["files"]) : [],
        };
        messagesByConv[id] = [...(messagesByConv[id] ?? []), stored];
        conversations = conversations.map((c) =>
          c.id === id ? { ...c, messagesCount: c.messagesCount + 1 } : c,
        );
        return json({ message: stored });
      }

      const convMatch = url.match(/^\/api\/agent\/conversations\/(\d+)$/);
      if (convMatch && method === "GET") {
        const id = Number(convMatch[1]);
        const conversation = conversations.find((item) => item.id === id);
        if (!conversation) return json({ error: "Not found" }, 404);
        return json({ conversation, messages: messagesByConv[id] ?? [] });
      }
      if (convMatch && method === "DELETE") {
        const id = Number(convMatch[1]);
        conversations = conversations.filter((item) => item.id !== id);
        delete messagesByConv[id];
        return json({ ok: true });
      }

      return json({ error: `unexpected ${method} ${url}` }, 500);
    }),
  );
}

describe("вкладка «Агент»", () => {
  beforeEach(() => {
    localStorage.clear();
    sent.length = 0;
    savedMessages.length = 0;
    conversations = [];
    messagesByConv = {};
    nextConvId = 1;
    nextMsgId = 1;
    sseReply = "";
    mockFetch();
  });

  it("настройки генерации сохраняются и уходят в запрос", async () => {
    render(<AgentChat userName="Тест" />);
    const textarea = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    await waitFor(() => expect((textarea as HTMLTextAreaElement).disabled).toBe(false));

    // Блок настроек открыт по умолчанию — поля сразу доступны.
    const temperature = screen.getByLabelText(/temperature/i);
    fireEvent.change(temperature, { target: { value: "0.3" } });

    fireEvent.change(textarea, { target: { value: "привет" } });
    fireEvent.click(screen.getByText("Запустить"));

    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].params?.temperature).toBe(0.3);
    // Настройка переживает перерисовку: сохранена в localStorage.
    expect(JSON.parse(localStorage.getItem("crm.ai.agent.params.v1") ?? "{}").temperature).toBe(0.3);
    expect((screen.getByLabelText(/temperature/i) as HTMLInputElement).value).toBe("0.3");
  });

  it("файл прикрепляется и уходит в запрос вместе с вопросом", async () => {
    render(<AgentChat userName="Тест" />);
    const textarea = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    await waitFor(() => expect((textarea as HTMLTextAreaElement).disabled).toBe(false));

    const input = screen.getByLabelText("Приложить файлы для анализа") as HTMLInputElement;
    const file = new File(["План на день: зарядка и отчёт"], "plan.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);

    expect(await screen.findByText(/plan\.txt/)).toBeTruthy();

    fireEvent.change(textarea, { target: { value: "что в файле?" } });
    fireEvent.click(screen.getByText("Запустить"));

    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].attachments?.[0]?.name).toBe("plan.txt");
    expect(sent[0].attachments?.[0]?.text).toContain("зарядка");
  });

  it("история чатов переключается, создаёт новые чаты и хранит файлы без байтов", async () => {
    conversations = [
      { id: 10, kind: "agent", title: "Старый чат", messagesCount: 2, updatedAt: "2026-11-17T09:00:00.000Z" },
      { id: 11, kind: "agent", title: "Второй чат", messagesCount: 1, updatedAt: "2026-11-17T08:00:00.000Z" },
    ];
    messagesByConv = {
      10: [
        { id: 1, role: "user", content: "сделай csv", attachments: [{ name: "notes.txt", size: 120 }] },
        {
          id: 2,
          role: "assistant",
          content: "Готово",
          files: [{ name: "report.csv", mime: "text/csv", size: 42 }],
        },
      ],
      11: [{ id: 3, role: "user", content: "сообщение из второго чата" }],
    };

    render(<AgentChat userName="Тест" />);

    expect(await screen.findByText("сделай csv")).toBeTruthy();
    expect(screen.getByText(/notes\.txt/)).toBeTruthy();
    expect(screen.getByText("report.csv")).toBeTruthy();
    expect(screen.getByText(/файл не сохранён/)).toBeTruthy();

    const select = screen.getByLabelText("История чатов агента") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "11" } });
    expect(await screen.findByText("сообщение из второго чата")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Новый чат/ }));
    await waitFor(() => expect(screen.queryByText("сообщение из второго чата")).toBeNull());

    // Живой сгенерированный файл остаётся скачиваемым в текущем сеансе, а в базу уходят только метаданные.
    sseReply = [
      'event: action\ndata: {"type":"file","name":"fresh.csv","mime":"text/csv","size":5,"data":"YSwxCg=="}\n\n',
      'event: text\ndata: {"text":"Файл создан"}\n\n',
      'event: done\ndata: {}\n\n',
    ].join("");
    const textarea = screen.getByPlaceholderText(/Например: открой ютуб/i);
    fireEvent.change(textarea, { target: { value: "создай файл" } });
    fireEvent.click(screen.getByText("Запустить"));

    const link = await screen.findByRole("link", { name: /fresh\.csv/ });
    expect(link.getAttribute("href")).toBe("data:text/csv;base64,YSwxCg==");

    await waitFor(() => expect(savedMessages.some((m) => m.body.role === "assistant")).toBe(true));
    const savedAssistant = savedMessages.find((m) => m.body.role === "assistant")!;
    expect(savedAssistant.body.files).toEqual([{ name: "fresh.csv", mime: "text/csv", size: 5 }]);
  });
});
