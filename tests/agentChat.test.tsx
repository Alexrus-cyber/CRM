import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentChat } from "@/components/AgentChat";

type Sent = {
  messages?: Array<{ role: string; content: string }>;
  params?: Record<string, unknown>;
  trustLevel?: string;
  ragFolderId?: number;
  ragFull?: boolean;
  ragChunks?: number;
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
const approvalsSent: Array<Record<string, unknown>> = [];
const transcriptsSaved: Array<Record<string, unknown>> = [];
const savedMessages: Array<{ conversationId: number; body: Record<string, unknown> }> = [];
let conversations: StoredConversation[] = [];
let messagesByConv: Record<number, StoredMsg[]> = {};
let nextConvId = 1;
let nextMsgId = 1;
let sseReply = "";
let sseResponder: ((url: string, init?: RequestInit) => Promise<Response> | Response) | null = null;

const operatorCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
let operatorPollCount = 0;

let operatorTaskGuidance: Record<string, unknown> | null = null;

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
      if (url === "/api/ai/agent/operator" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        operatorCalls.push({ url, body });
        if (body.action === "formulate") {
          return json({
            prompt: "Открой окно игры, зажми W на 1 с и нажми E у двери",
            taskMode: "game",
            coachMode: "agent",
            maxSteps: 45,
            notes: "Выбран игровой режим с пошаговым ведением Агента.",
          });
        }
        return json({
          ok: true,
          task: {
            id: 77,
            prompt: String(body.prompt ?? ""),
            status: "queued",
            maxSteps: Number(body.maxSteps ?? 30),
            steps: 0,
            summary: "",
            trustLevel: String(body.trustLevel ?? "verified"),
            taskMode: String(body.taskMode ?? "copilot"),
            coachMode: String(body.coachMode ?? "agent"),
            source: "agent",
            guidanceNote: operatorTaskGuidance,
            createdAt: "2026-11-17T10:00:00.000Z",
            updatedAt: "2026-11-17T10:00:00.000Z",
          },
        });
      }
      if (url === "/api/ai/agent/coach" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        operatorCalls.push({ url, body });
        operatorTaskGuidance = {
          id: "g-1",
          author: "agent",
          text: "Нажми E чтобы открыть сундук",
          userAdvice: "Персонаж подошёл к сундуку — жмём E",
          createdAt: "2026-11-17T10:01:00.000Z",
        };
        return json({
          ok: true,
          task: {
            id: 77,
            prompt: "Открой окно игры, зажми W на 1 с и нажми E у двери",
            status: "running",
            maxSteps: 45,
            steps: 1,
            summary: "",
            trustLevel: "verified",
            taskMode: "game",
            coachMode: "agent",
            source: "agent",
            guidanceNote: operatorTaskGuidance,
            createdAt: "2026-11-17T10:00:00.000Z",
            updatedAt: "2026-11-17T10:01:00.000Z",
          },
        });
      }
      if (url === "/api/agent/tasks/77" && method === "GET") {
        operatorPollCount += 1;
        return json({
          task: {
            id: 77,
            prompt: "Открой окно игры, зажми W на 1 с и нажми E у двери",
            status: "running",
            maxSteps: 45,
            steps: operatorPollCount,
            summary: "",
            trustLevel: "verified",
            taskMode: "game",
            coachMode: "agent",
            source: "agent",
            guidanceNote: operatorTaskGuidance,
            createdAt: "2026-11-17T10:00:00.000Z",
            updatedAt: "2026-11-17T10:00:00.000Z",
          },
          events: [],
        });
      }
      if (url === "/api/ai/agent" && method === "POST") {
        sent.push(JSON.parse(String(init?.body ?? "{}")) as Sent);
        if (sseResponder) {
          return await sseResponder(url, init);
        }
        if (sseReply) {
          return new Response(sseReply, { status: 200, headers: { "Content-Type": "text/event-stream" } });
        }
        return json({ error: "тест" });
      }
      if (url === "/api/ai/agent/approve" && method === "POST") {
        approvalsSent.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return json({ ok: true });
      }
      if (url === "/api/ai/rag" && method === "GET") {
        return json({
          folders: [
            {
              id: 5,
              name: "Документация",
              filesCount: 3,
              chunksCount: 40,
              chars: 25000,
              updatedAt: "2026-11-17T10:00:00.000Z",
            },
          ],
        });
      }
      if (url === "/api/ai/agent/summarize" && method === "POST") {
        return json({ summary: "Сжатый итог работы по проекту" });
      }
      if (url === "/api/agent/transcripts" && method === "GET") {
        return json({ transcripts: [] });
      }
      if (url === "/api/agent/transcripts" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        transcriptsSaved.push(body);
        return json({
          transcript: {
            id: 99,
            conversationId: body.conversationId ?? 1,
            title: body.title ?? "Чат",
            summary: body.summary ?? "",
            fileName: body.fileName ?? "transcript.md",
            chars: String(body.content ?? "").length,
            createdAt: "2026-11-17T10:00:00.000Z",
          },
        });
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
    approvalsSent.length = 0;
    transcriptsSaved.length = 0;
    savedMessages.length = 0;
    operatorCalls.length = 0;
    operatorPollCount = 0;
    operatorTaskGuidance = null;
    conversations = [];
    messagesByConv = {};
    nextConvId = 1;
    nextMsgId = 1;
    sseReply = "";
    sseResponder = null;
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

  it("передаёт уровень доверия и RAG-папку, запрашивает подтверждение и сжимает чат в Summary", async () => {
    render(<AgentChat userName="Тест" />);
    const textarea = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    await waitFor(() => expect((textarea as HTMLTextAreaElement).disabled).toBe(false));

    // Выбор уровня доверия «Дать полный доступ».
    fireEvent.click(screen.getByRole("radio", { name: /Дать полный доступ/i }));

    // Открытие RAG-панели, выбор папки и «Вся база».
    fireEvent.click(screen.getByRole("button", { name: /Настроить/i }));
    const ragSelect = await screen.findByLabelText("Выбор RAG-папки");
    fireEvent.change(ragSelect, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Вся база/i }));

    // Стриминговый ответ с запросом подтверждения экспорта из Sandbox:
    // завершаем поток только после отправки подтверждения, как в реальном agent.py.
    const encoder = new TextEncoder();
    sseResponder = () => {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: approval_required\ndata: {"approvalId":"appr-1","kind":"sandbox_export","title":"Разрешить перенос?","description":"Экспорт проекта","source":"site","destination":"D:/out","mode":"copy","filesCount":4}\n\n',
            ),
          );
          while (approvalsSent.length === 0) {
            await new Promise((r) => setTimeout(r, 10));
          }
          controller.enqueue(encoder.encode('event: text\ndata: {"text":"Экспорт выполнен"}\n\n'));
          controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    fireEvent.change(textarea, { target: { value: "собери сайт" } });
    fireEvent.click(screen.getByText("Запустить"));

    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].trustLevel).toBe("full");
    expect(sent[0].ragFolderId).toBe(5);
    expect(sent[0].ragFull).toBe(true);

    // Появляется карточка подтверждения экспорта — жмём «Разрешить».
    const approveBtn = await screen.findByRole("button", { name: /^Разрешить$/ });
    fireEvent.click(approveBtn);
    await waitFor(() => expect(approvalsSent.length).toBe(1));
    expect(approvalsSent[0]).toMatchObject({ approvalId: "appr-1", approved: true, destination: "D:/out" });

    expect(await screen.findByText("Экспорт выполнен")).toBeTruthy();

    // Нажимаем кнопку ручного сжатия в Summary и новый чат.
    const compressBtn = screen.getByRole("button", { name: /Сжать в Summary и новый чат/ });
    await waitFor(() => expect((compressBtn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(compressBtn);

    expect(await screen.findByText(/Сжатый итог работы по проекту/)).toBeTruthy();
    expect(transcriptsSaved).toHaveLength(1);
    expect(String(transcriptsSaved[0].content)).toContain("# Переписка агента");
  });

  it("вызывает Оператора только с разрешения пользователя и помогает формулировать + вести по шагам", async () => {
    render(<AgentChat userName="Тест" />);
    const textarea = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    await waitFor(() => expect((textarea as HTMLTextAreaElement).disabled).toBe(false));

    // Сценарий 1: Агент запрашивает разрешение на вызов Оператора (approval_required call_operator).
    const encoder = new TextEncoder();
    sseResponder = () => {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: approval_required\ndata: {"approvalId":"appr-op-1","kind":"call_operator","title":"Разрешить Агенту вызвать Оператора на ПК?","description":"Нужно кликнуть на кнопку в программе","task":"Открой окно и нажми Сохранить","mode":"copilot","maxSteps":25,"coachAfterEachStep":true,"operatorTrustLevel":"verified"}\n\n',
            ),
          );
          while (approvalsSent.length === 0) {
            await new Promise((r) => setTimeout(r, 10));
          }
          controller.enqueue(encoder.encode('event: text\ndata: {"text":"Задача передана Оператору"}\n\n'));
          controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    fireEvent.change(textarea, { target: { value: "нажми сохранить в программе" } });
    fireEvent.click(screen.getByText("Запустить"));

    const approveOpBtn = await screen.findByRole("button", { name: /Разрешить и запустить Оператора/i });
    fireEvent.click(approveOpBtn);

    await waitFor(() =>
      expect(operatorCalls.some((c) => c.url === "/api/ai/agent/operator" && c.body.action === "launch")).toBe(true),
    );
    await waitFor(() => expect(approvalsSent.length).toBe(1));
    expect(approvalsSent[0]).toMatchObject({
      approvalId: "appr-op-1",
      approved: true,
      taskId: 77,
      mode: "copilot",
      coachMode: "agent",
    });

    // Сценарий 3: В открытой live-панели Оператора можно запросить совет Агента, и кнопка «Оператор» формулирует задачу.
    const coachBtn = await screen.findByRole("button", { name: /Совет Агента/i });
    fireEvent.click(coachBtn);
    await waitFor(() => expect(operatorCalls.some((c) => c.url === "/api/ai/agent/coach")).toBe(true));
    expect(await screen.findByText(/Персонаж подошёл к сундуку/)).toBeTruthy();

    fireEvent.change(textarea, { target: { value: "помоги пройти дверь в игре" } });
    fireEvent.click(screen.getByRole("button", { name: /^Оператор$/i }));
    await waitFor(() =>
      expect(operatorCalls.some((c) => c.url === "/api/ai/agent/operator" && c.body.action === "formulate")).toBe(true),
    );
    expect(await screen.findByDisplayValue(/Открой окно игры, зажми W на 1 с и нажми E у двери/)).toBeTruthy();
  });
});
