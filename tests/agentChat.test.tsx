import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentChat, SSE_IDLE_TIMEOUT_MS } from "@/components/AgentChat";

type Sent = {
  messages?: Array<{ role: string; content: string }>;
  params?: Record<string, unknown>;
  systemPrompt?: string;
  trustLevel?: string;
  maxSteps?: number;
  ragFolderId?: number;
  ragFull?: boolean;
  ragChunks?: number;
  attachments?: Array<{ name: string; text: string }>;
};

type StoredConversation = {
  id: number;
  kind: "agent" | "tester";
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
let testerRunsMock: Array<Record<string, unknown>> = [];
const testerDecisionsSent: Array<{ runId: number; decision: string }> = [];

const operatorCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
let operatorPollCount = 0;

let operatorTaskGuidance: Record<string, unknown> | null = null;
let enableLiveOperatorMock = false;
let ensureChatRequested = 0;

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
        return json({ available: true, tools: ["create_file", "inspect_pc_screen", "call_operator"] });
      }
      if (url === "/api/ai/agent/sandbox" && method === "GET") {
        return json({
          available: true,
          root: "/tmp/sandbox",
          projects: [
            { name: "landing-site", files: 4 },
            { name: "crm-widget", files: 2 },
          ],
          items: [
            { path: "landing-site", type: "dir", size: 0 },
            { path: "landing-site/index.html", type: "file", size: 240 },
          ],
          processes: [],
        });
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
        const isInspect = body.taskMode === "inspect";
        return json({
          ok: true,
          task: {
            id: isInspect ? 88 : 77,
            prompt: String(body.prompt ?? ""),
            status: "queued",
            maxSteps: Number(body.maxSteps ?? (isInspect ? 2 : 30)),
            steps: 0,
            summary: "",
            trustLevel: String(body.trustLevel ?? "verified"),
            taskMode: String(body.taskMode ?? "copilot"),
            coachMode: String(body.coachMode ?? (isInspect ? "off" : "agent")),
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
      if (url === "/api/agent/tasks/88" && method === "GET") {
        return json({
          task: {
            id: 88,
            prompt: "Покажи окно IDE",
            status: "done",
            maxSteps: 2,
            steps: 1,
            summary: "Снимок экрана ПК (1280×720). Активное окно: VS Code — Ошибка TypeScript",
            trustLevel: "verified",
            taskMode: "inspect",
            coachMode: "off",
            source: "agent",
            createdAt: "2026-11-17T10:00:00.000Z",
            updatedAt: "2026-11-17T10:00:02.000Z",
          },
          events: [],
          latestScreen: {
            eventId: 901,
            summary: "Снимок экрана ПК (1280×720). Активное окно: VS Code — Ошибка TypeScript",
            meta: { type: "inspect_screen", activeWindow: "VS Code" },
            dataUrl: "data:image/jpeg;base64,/9j/4AAQ",
            createdAt: "2026-11-17T10:00:02.000Z",
          },
        });
      }
      if (url === "/api/agent/bot/status" && method === "GET" && enableLiveOperatorMock) {
        return json({ ok: true, state: "online", connected: true, secondsAgo: 2 });
      }
      if (url === "/api/agent/tasks" && method === "GET" && enableLiveOperatorMock) {
        return json({
          tasks: [
            {
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
              updatedAt: "2026-11-17T10:00:00.000Z",
            },
          ],
        });
      }
      if ((url === "/api/agent/tasks/77" || url === "/api/agent/tasks/77?ensureChat=1") && method === "GET") {
        const ensure = url.includes("ensureChat=1");
        if (ensure) ensureChatRequested += 1;
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
          conversationId: ensure ? 42 : null,
          events: enableLiveOperatorMock
            ? [
                {
                  id: 501,
                  kind: "thought",
                  text: "Вижу дверь и навожу курсор на ручку",
                  action: "",
                  fileName: "",
                  fileMime: "",
                  fileSize: 0,
                  hasFile: false,
                  createdAt: "2026-11-17T10:00:01.000Z",
                },
                {
                  id: 502,
                  kind: "action",
                  text: "Клавиша e",
                  action: '{"type":"key","key":"e"}',
                  fileName: "",
                  fileMime: "",
                  fileSize: 0,
                  hasFile: false,
                  createdAt: "2026-11-17T10:00:02.000Z",
                },
              ]
            : [],
        });
      }
      if (url.startsWith("/api/ai/models") && (method === "GET" || method === "POST")) {
        return json({
          ok: true,
          models: ["o3-mini", "gpt-4o-mini"],
          capabilitiesByModel: {
            "o3-mini": {
              model: "o3-mini",
              supportsReasoning: true,
              reasoningModes: ["default", "off", "low", "medium", "high", "max", "budget"],
              supportsThinkingBudget: true,
              supportsVision: false,
              supportsTools: true,
              maxContextLength: 200000,
              maxOutputTokens: 100000,
              source: "metadata",
              note: "Метаданные o3-mini: reasoning high/max и budget",
            },
            "gpt-4o-mini": {
              model: "gpt-4o-mini",
              supportsReasoning: false,
              reasoningModes: ["default", "off"],
              supportsThinkingBudget: false,
              supportsVision: true,
              supportsTools: true,
              maxContextLength: 128000,
              maxOutputTokens: 16384,
              source: "metadata",
              note: "Модель gpt-4o-mini без расширенного reasoning",
            },
          },
          selectedCapabilities: {
            model: "o3-mini",
            supportsReasoning: true,
            reasoningModes: ["default", "off", "low", "medium", "high", "max", "budget"],
            supportsThinkingBudget: true,
            supportsVision: false,
            supportsTools: true,
            maxContextLength: 200000,
            maxOutputTokens: 100000,
            source: "metadata",
            note: "Метаданные o3-mini: reasoning high/max и budget",
          },
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

      if (url === "/api/agent/tester" && method === "GET") {
        return json({
          runs: testerRunsMock,
          conversations: conversations.filter((c) => c.kind === "tester"),
        });
      }
      const testerIdMatch = url.match(/^\/api\/agent\/tester\/(\d+)$/);
      if (testerIdMatch && method === "POST") {
        const runId = Number(testerIdMatch[1]);
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const decision = String(body.decision ?? "approved");
        testerDecisionsSent.push({ runId, decision });
        testerRunsMock = testerRunsMock.map((r) =>
          Number(r.id) === runId ? { ...r, minorDecision: decision } : r,
        );
        const updated = testerRunsMock.find((r) => Number(r.id) === runId);
        return json({ ok: true, run: updated });
      }
      if (url.startsWith("/api/agent/conversations?kind=agent") && method === "GET") {
        return json({ conversations: conversations.filter((c) => c.kind === "agent") });
      }
      if (url === "/api/agent/conversations" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const kind = body.kind === "tester" ? "tester" : "agent";
        const created: StoredConversation = {
          id: nextConvId++,
          kind,
          title: String(body.title ?? "Новый чат"),
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
    enableLiveOperatorMock = false;
    conversations = [];
    messagesByConv = {};
    nextConvId = 1;
    nextMsgId = 1;
    sseReply = "";
    sseResponder = null;
    testerRunsMock = [];
    testerDecisionsSent.length = 0;
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

    // Переходим во вкладку «Доверие и RAG», выбираем уровень доверия и RAG-папку.
    fireEvent.click(screen.getByRole("tab", { name: /Доверие и RAG/i }));
    fireEvent.click(screen.getByRole("radio", { name: /Дать полный доступ/i }));

    // Открытие RAG-панели, выбор папки и «Вся база».
    fireEvent.click(screen.getByRole("button", { name: /Настроить/i }));
    const ragSelect = await screen.findByLabelText("Выбор RAG-папки");
    fireEvent.change(ragSelect, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Вся база/i }));

    // Возвращаемся на последнюю вкладку «Чат» и отправляем запрос.
    fireEvent.click(screen.getByRole("tab", { name: /^Чат$/i }));

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

  it("корректно рендерит sandbox.projects формата {name, files} без ошибки React child", async () => {
    render(<AgentChat userName="Тест" />);
    fireEvent.click(screen.getByRole("tab", { name: /Sandbox и Оператор/i }));
    expect(await screen.findByText(/Проекты: landing-site, crm-widget/)).toBeTruthy();

    const quickLink = screen.getByRole("link", { name: /Открыть landing-site/i });
    expect(quickLink.getAttribute("href")).toBe("/api/ai/agent/sandbox/preview/landing-site");

    fireEvent.click(screen.getByRole("button", { name: /Sandbox \(2\)/i }));
    expect(await screen.findByText("landing-site (4 ф.)")).toBeTruthy();
    expect(screen.getByText("crm-widget (2 ф.)")).toBeTruthy();

    const previewBtns = screen.getAllByRole("button", { name: /^превью$/i });
    fireEvent.click(previewBtns[0]!);
    const iframe = await screen.findByTitle("Превью landing-site");
    expect(iframe.getAttribute("src")).toBe("/api/ai/agent/sandbox/preview/landing-site");
  });

  it("показывает запрос разрешения внизу справа и передаёт снимок экрана от Оператора в Агента", async () => {
    render(<AgentChat userName="Тест" />);
    const textarea = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    await waitFor(() => expect((textarea as HTMLTextAreaElement).disabled).toBe(false));

    const encoder = new TextEncoder();
    sseResponder = () => {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: approval_required\ndata: {"approvalId":"appr-screen-1","kind":"capture_screen","title":"Разрешить Оператору сделать снимок экрана ПК?","description":"Нужно увидеть текст ошибки в IDE","task":"Покажи окно IDE","mode":"inspect","maxSteps":2,"operatorTrustLevel":"verified"}\n\n',
            ),
          );
          while (approvalsSent.length === 0) {
            await new Promise((r) => setTimeout(r, 10));
          }
          controller.enqueue(
            encoder.encode(
              'event: action\ndata: {"type":"operator_screen","taskId":88,"summary":"Активное окно: VS Code — Ошибка TypeScript","hasImage":true}\n\n',
            ),
          );
          controller.enqueue(encoder.encode('event: text\ndata: {"text":"Вижу ошибку TypeScript в VS Code"}\n\n'));
          controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    fireEvent.change(textarea, { target: { value: "посмотри какая ошибка у меня на экране" } });
    fireEvent.click(screen.getByText("Запустить"));

    const toastDialog = await screen.findByRole("alertdialog", {
      name: /Разрешить Оператору сделать снимок экрана ПК/,
    });
    const stackEl = document.getElementById("crm-approval-toast-stack");
    expect(stackEl).toBeTruthy();
    expect(stackEl?.className).toContain("fixed");
    expect(stackEl?.className).toContain("bottom-4");
    expect(stackEl?.className).toContain("right-4");
    expect(stackEl?.contains(toastDialog)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Разрешить Оператору снять экран/i }));

    await waitFor(() =>
      expect(
        operatorCalls.some((c) => c.url === "/api/ai/agent/operator" && c.body.taskMode === "inspect"),
      ).toBe(true),
    );
    await waitFor(() => expect(approvalsSent.length).toBe(1));
    expect(approvalsSent[0]).toMatchObject({
      approvalId: "appr-screen-1",
      approved: true,
      taskId: 88,
      mode: "inspect",
      screenshot: "data:image/jpeg;base64,/9j/4AAQ",
    });
    expect(String(approvalsSent[0].screenSummary)).toContain("VS Code");
    expect(await screen.findByText(/Снимок экрана ПК передан Агенту \(#88\)/)).toBeTruthy();
    expect(await screen.findByText("Вижу ошибку TypeScript в VS Code")).toBeTruthy();
  });

  it("показывает статус Оператора ПК, его живые мысли и позволяет открыть задачу как чат", async () => {
    enableLiveOperatorMock = true;
    conversations = [
      {
        id: 1,
        kind: "agent",
        title: "Обычный чат",
        messagesCount: 0,
        updatedAt: "2026-11-17T09:59:00.000Z",
      },
      {
        id: 42,
        kind: "agent",
        title: "Оператор #77: Открой окно игры",
        messagesCount: 2,
        updatedAt: "2026-11-17T10:00:02.000Z",
      },
    ];
    messagesByConv[1] = [];
    messagesByConv[42] = [
      {
        id: 9001,
        role: "user",
        content: "Задача для Оператора #77 (Игра):\nОткрой окно игры, зажми W на 1 с и нажми E у двери",
      },
      {
        id: 9002,
        role: "assistant",
        content: "Диалог Агент ↔ Оператор #77 · статус: выполняется · шагов 1/45\n💭 Размышление: Вижу дверь\n▸ Действие: Клавиша e",
        reasoning: "💭 Вижу дверь и навожу курсор на ручку",
      },
    ];

    render(<AgentChat userName="Тест" />);

    expect(await screen.findByText("Оператор ПК: онлайн")).toBeTruthy();
    expect(await screen.findByText(/Мысли и шаги Оператора/)).toBeTruthy();
    expect(await screen.findByText(/Вижу дверь и навожу курсор на ручку/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Открыть как чат/i }));

    expect(await screen.findByText(/Диалог Агент ↔ Оператор #77/)).toBeTruthy();
    expect(await screen.findByText(/Размышления ·/)).toBeTruthy();
  });

  it("передаёт и сохраняет системный промпт на вкладке «Агент»", async () => {
    render(<AgentChat userName="Тест" />);
    const promptInput = await screen.findByLabelText("Системный промпт агента");
    fireEvent.change(promptInput, { target: { value: "Всегда отвечай кратко и пиши команды списком." } });

    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/);
    fireEvent.change(chatBox, { target: { value: "Сверь файлы" } });
    fireEvent.click(screen.getByText("Запустить"));

    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]?.systemPrompt).toBe("Всегда отвечай кратко и пиши команды списком.");
    expect(localStorage.getItem("crm.ai.agent.system.v1")).toContain("Всегда отвечай кратко");
  });

  it("принимает файлы через вставку из буфера (Ctrl+V) и drag-and-drop", async () => {
    render(<AgentChat userName="Тест" />);
    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/);

    const pastedFile = new File(["hello screenshot"], "pasted.txt", { type: "text/plain" });
    fireEvent.paste(chatBox, {
      clipboardData: {
        files: [pastedFile],
        items: [{ kind: "file", getAsFile: () => pastedFile }],
        getData: () => "",
      },
    });

    expect(await screen.findByLabelText("Убрать pasted.txt")).toBeTruthy();

    const droppedFile = new File(["dropped info"], "notes.md", { type: "text/markdown" });
    const dropContainer = chatBox.closest("div.relative");
    expect(dropContainer).toBeTruthy();
    fireEvent.drop(dropContainer!, {
      dataTransfer: {
        types: ["Files"],
        files: [droppedFile],
      },
    });

    expect(await screen.findByLabelText("Убрать notes.md")).toBeTruthy();
  });

  it("раскрывает блок рассуждений в прямом эфире во время стриминга", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    sseResponder = () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: reasoning\ndata: {"text":"Проверяю первый шаг"}\n\n'));
          gate.release = () => {
            controller.enqueue(encoder.encode('event: text\ndata: {"text":"Готово"}\n\n'));
            controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
            controller.close();
          };
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    render(<AgentChat userName="Тест" />);
    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/);
    fireEvent.change(chatBox, { target: { value: "Покажи мысли" } });
    fireEvent.click(screen.getByText("Запустить"));

    const liveBadge = await screen.findByText("в эфире");
    expect(liveBadge).toBeTruthy();
    const detailsEl = liveBadge.closest("details");
    await waitFor(() => expect(detailsEl?.open).toBe(true));
    expect(await screen.findByText("Проверяю первый шаг")).toBeTruthy();

    gate.release?.();
    expect(await screen.findByText("Готово")).toBeTruthy();
  });

  it("по умолчанию отправляет maxSteps = 0 (без лимита) и позволяет задать число > 500", async () => {
    render(<AgentChat userName="Тест" />);
    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/);
    fireEvent.change(chatBox, { target: { value: "Тест без лимита" } });
    fireEvent.click(screen.getByText("Запустить"));

    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].maxSteps).toBe(0);

    const toggle = screen.getByLabelText("Без лимита шагов") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);

    const stepsInput = await screen.findByLabelText("Лимит шагов агента");
    fireEvent.change(stepsInput, { target: { value: "800" } });
    fireEvent.change(chatBox, { target: { value: "Тест 800 шагов" } });
    fireEvent.click(screen.getByText("Запустить"));

    await waitFor(() => expect(sent.length).toBe(2));
    expect(sent[1].maxSteps).toBe(800);
  });

  it("показывает карточку интерактивного осмотра проекта и не пишет base64-превью в базу", async () => {
    sseReply = [
      'event: action\ndata: {"type":"browser_inspect","action":"inspect_animations","url":"http://127.0.0.1:8123/","viewport":"1440×900","animationsCount":3,"issuesCount":1,"errorsCount":1,"summary":"анимаций: 3, проблем: 1, ошибок: 1","preview":"data:image/jpeg;base64,RkFLRQ=="}\n\n',
      'event: text\ndata: {"text":"Найдена зависшая анимация на карточке"}\n\n',
      "event: done\ndata: {}\n\n",
    ].join("");

    render(<AgentChat userName="Тест" />);
    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/);
    fireEvent.change(chatBox, { target: { value: "Проверь анимации на проекте" } });
    fireEvent.click(screen.getByText("Запустить"));

    expect(await screen.findByText(/Осмотр проекта \(inspect_animations\)/)).toBeTruthy();
    expect(screen.getByText(/анимаций: 3, проблем: 1, ошибок: 1/)).toBeTruthy();
    expect(screen.getByAltText(/Скриншот осмотра http:\/\/127\.0\.0\.1:8123\//)).toBeTruthy();

    await waitFor(() =>
      expect(savedMessages.some((m) => m.body.role === "assistant")).toBe(true),
    );
    const savedAssistant = savedMessages.find((m) => m.body.role === "assistant")!;
    const savedActions = savedAssistant.body.actions as Array<Record<string, unknown>>;
    expect(savedActions[0]?.type).toBe("browser_inspect");
    expect(savedActions[0]?.preview).toBeUndefined();
  });

  it("переключается между видом по вкладкам (с чатом на последней вкладке) и классическим видом", async () => {
    render(<AgentChat userName="Тест" />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, "").trim())).toEqual([
      "Модель и генерация",
      "Доверие и RAG",
      "Sandbox и Оператор",
      "Субагенты",
      "Чат",
    ]);
    expect(tabs[tabs.length - 1]?.textContent).toBe("Чат");
    expect(tabs[tabs.length - 1]?.getAttribute("aria-selected")).toBe("true");

    // Переключаемся в классический вид: все настройки и чат видны на одном экране без вкладок.
    fireEvent.click(screen.getByRole("button", { name: "Классический вид" }));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("radio", { name: /Дать полный доступ/i })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Sandbox \(2\)/i })).toBeTruthy();
    expect(screen.getByPlaceholderText(/Например: открой ютуб/i)).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("crm.ai.agent.layout.v1") ?? '""')).toBe("classic");

    // Возвращаемся к виду по вкладкам.
    fireEvent.click(screen.getByRole("button", { name: "По вкладкам" }));
    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("crm.ai.agent.layout.v1") ?? '""')).toBe("tabs");
  });

  it("подтягивает список моделей, возможности и разрешает безлимитный ввод для super_admin", async () => {
    render(<AgentChat userName="Тест" />);
    fireEvent.click(screen.getByRole("tab", { name: /Модель и генерация/i }));

    fireEvent.click(screen.getByRole("button", { name: /Подтянуть модели/i }));

    const modelSelect = (await screen.findByLabelText("Выбрать модель из списка сервера")) as HTMLSelectElement;
    expect(modelSelect.value).toBe("o3-mini");
    expect(await screen.findByText(/Метаданные o3-mini/)).toBeTruthy();

    // Системный промпт > 12000 символов и max_tokens > 384000 не обрезаются для unlimited (super_admin).
    const longPrompt = "A".repeat(13_500);
    const promptInput = screen.getByLabelText("Системный промпт агента") as HTMLTextAreaElement;
    fireEvent.change(promptInput, { target: { value: longPrompt } });
    expect(promptInput.value.length).toBe(13_500);
    expect(screen.getByText(/13500 симв\. · без лимита/)).toBeTruthy();

    const maxTokensInput = screen.getByLabelText("max_tokens") as HTMLInputElement;
    fireEvent.change(maxTokensInput, { target: { value: "500000" } });
    expect(maxTokensInput.value).toBe("500000");

    // Переключаемся на gpt-4o-mini без reasoning и проверяем, что список режимов обновился.
    fireEvent.change(modelSelect, { target: { value: "gpt-4o-mini" } });
    const notes = await screen.findAllByText(/Модель gpt-4o-mini без расширенного reasoning/);
    expect(notes.length).toBeGreaterThanOrEqual(1);
  });

  it("закрывает карточку задачи Оператора без повторного открытия при опросе и запрашивает ?ensureChat=1 только по кнопке «Открыть как чат»", async () => {
    enableLiveOperatorMock = true;
    ensureChatRequested = 0;
    conversations = [
      { id: 1, kind: "agent", title: "Основной чат", messagesCount: 0, updatedAt: "2026-11-17T10:00:00.000Z" },
      { id: 42, kind: "agent", title: "Оператор #77", messagesCount: 1, updatedAt: "2026-11-17T10:00:05.000Z" },
    ];
    messagesByConv[42] = [
      { id: 100, role: "assistant", content: "Шаг #1: навожу на дверь" },
    ];

    render(<AgentChat userName="Тест" />);
    await screen.findByRole("button", { name: "Скрыть карточку задачи Оператора" });
    expect(ensureChatRequested).toBe(0);

    // Скрываем карточку задачи: при повторном опросе карточка остаётся закрытой.
    fireEvent.click(screen.getByRole("button", { name: "Скрыть карточку задачи Оператора" }));
    expect(screen.queryByRole("button", { name: "Скрыть карточку задачи Оператора" })).toBeNull();

    // Открываем задачу снова из списка «Недавние и активные задачи Оператора» на вкладке «Sandbox и Оператор».
    fireEvent.click(screen.getByRole("tab", { name: /Sandbox и Оператор/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Оператор$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /#77/i }));
    const openChatBtn = await screen.findByRole("button", { name: /Открыть как чат/i });
    expect(ensureChatRequested).toBe(0);

    // Нажатие «Открыть как чат» при conversationId === null дозапрашивает ?ensureChat=1 и переходит в чат.
    fireEvent.click(openChatBtn);
    await waitFor(() => expect(ensureChatRequested).toBe(1));
    expect(await screen.findByText("Шаг #1: навожу на дверь")).toBeTruthy();
    enableLiveOperatorMock = false;
  });

  it("отображает архивный tester_report из истории только для чтения и не показывает вкладку «Тестировщик»", async () => {
    conversations = [
      { id: 1, kind: "agent", title: "Исторический чат", messagesCount: 2, updatedAt: "2026-11-17T10:00:00.000Z" },
    ];
    messagesByConv[1] = [
      { id: 501, role: "user", content: "Проверь landing-site" },
      {
        id: 502,
        role: "assistant",
        content: "Отчёт сохранён в истории.",
        actions: [
          {
            type: "tester_report" as unknown as "open_url",
            url: "",
            label: "Отчёт",
            sandboxProject: "landing-site",
            reportSummary: "Найдена 1 мелкая проблема верстки",
            criticalCount: 0,
            minorCount: 1,
            totalTokens: 200,
          } as unknown as { type: "open_url"; url: string; label: string },
        ],
      },
    ];

    render(<AgentChat userName="Тест" />);
    expect(screen.queryByRole("tab", { name: /Тестировщик/i })).toBeNull();
    expect(await screen.findByText(/Отчёт Тестировщика · landing-site/i)).toBeTruthy();
    expect(screen.getByText(/Найдена 1 мелкая проблема верстки/i)).toBeTruthy();
    expect(screen.getByText(/Архивный отчёт \(история\)/i)).toBeTruthy();
  });

  it("сохраняет вложения в рамках сессии с fromHistory=true, отображает чипы «в сессии» и sandboxPath", async () => {
    conversations = [
      { id: 1, kind: "agent", title: "Основной чат", messagesCount: 1, updatedAt: "2026-11-17T10:00:00.000Z" },
    ];
    messagesByConv[1] = [
      {
        id: 700,
        role: "user",
        content: "Исходный макет",
        attachments: [
          {
            name: "old-mock.png",
            size: 512,
            sandboxPath: "_shared_files/old-mock.png",
          } as unknown as { name: string; size: number },
        ],
      },
    ];
    sseReply = [
      'event: text\ndata: {"text":"Дизайн учтён."}\n\n',
      'event: done\ndata: {"steps":1,"files":0,"actions":0}\n\n',
    ].join("");

    render(<AgentChat userName="Тест" />);
    expect(await screen.findByText("_shared_files/old-mock.png")).toBeTruthy();

    const fileInput = screen.getByLabelText("Приложить файлы для анализа") as HTMLInputElement;
    const specFile = new File(["# Дизайн-токен\naccent: #10b981"], "design-spec.md", {
      type: "text/markdown",
    });
    Object.defineProperty(fileInput, "files", { value: [specFile], configurable: true });
    fireEvent.change(fileInput);
    expect(await screen.findByText(/design-spec\.md/)).toBeTruthy();

    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    fireEvent.change(chatBox, { target: { value: "Передай макет субагенту" } });
    fireEvent.click(screen.getByText("Запустить"));

    expect(await screen.findByText(/Дизайн учтён\./i)).toBeTruthy();
    expect(sent[0]?.attachments?.[0]).toMatchObject({
      name: "design-spec.md",
      fromHistory: false,
    });
    // После отправки файл остаётся доступным в текущей сессии (чип «в сессии»)
    expect(await screen.findByText(/в сессии/i)).toBeTruthy();

    // Повторное сообщение в той же сессии автоматически прикрепляет сессионный файл с fromHistory: true
    fireEvent.change(chatBox, { target: { value: "Уточни цвета кнопки" } });
    fireEvent.click(screen.getByText("Запустить"));

    await waitFor(() => expect(sent.length).toBe(2));
    expect(sent[1]?.attachments?.[0]).toMatchObject({
      name: "design-spec.md",
      fromHistory: true,
    });
  });

  it("обрабатывает SSE-события subagent_start / subagent_chat_rotated / subagent_done и рендерит карточку переноса чата", async () => {
    conversations = [
      { id: 1, kind: "agent", title: "Основной чат", messagesCount: 0, updatedAt: "2026-11-17T10:00:00.000Z" },
    ];
    const encoder = new TextEncoder();
    sseResponder = () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: subagent_start\ndata: ${JSON.stringify({
                runKey: "r-sub-1",
                subagentSlug: "coder",
                subagentName: "Кодер",
                subagentColor: "#8b5cf6",
                tier: 1,
                routingMode: "linear",
                model: "o3-mini",
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: subagent_chat_rotated\ndata: ${JSON.stringify({
                previousRunKey: "r-sub-1",
                newRunKey: "r-sub-2",
                subagentName: "Кодер",
                steps: 300,
                summary: "Собран бэкенд, осталось подключить UI.",
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: subagent_done\ndata: ${JSON.stringify({
                runKey: "r-sub-2",
                subagentName: "Кодер",
              })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode('event: text\ndata: {"text":"Субагент завершил перенесённую задачу."}\n\n'));
          controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    render(<AgentChat userName="Тест" />);
    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    fireEvent.change(chatBox, { target: { value: "Собери большой проект" } });
    fireEvent.click(screen.getByText("Запустить"));

    expect(await screen.findByText(/Чат субагента «Кодер» перенесён в новую сессию \(300 шагов\)/i)).toBeTruthy();
    expect(screen.getByText(/Собран бэкенд, осталось подключить UI\./i)).toBeTruthy();
    expect(await screen.findByText(/Субагент завершил перенесённую задачу\./i)).toBeTruthy();
  });

  it("P1-2: показывает ошибку, если subagent_done пришёл со статусом error, и нейтрально сообщает о ротации", async () => {
    conversations = [
      { id: 1, kind: "agent", title: "Основной чат", messagesCount: 0, updatedAt: "2026-11-17T10:00:00.000Z" },
    ];
    const encoder = new TextEncoder();
    sseResponder = () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: subagent_start\ndata: ${JSON.stringify({
                runKey: "r-err",
                subagentSlug: "coder",
                subagentName: "Кодер",
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: subagent_done\ndata: ${JSON.stringify({
                runKey: "r-err",
                subagentName: "Кодер",
                status: "rotated",
                rotatedToNewChat: true,
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: subagent_done\ndata: ${JSON.stringify({
                runKey: "r-err-2",
                subagentName: "Кодер",
                status: "error",
                error: "соединение закрыто до завершения",
              })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    render(<AgentChat userName="Тест" />);
    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    fireEvent.change(chatBox, { target: { value: "Собери проект" } });
    fireEvent.click(screen.getByText("Запустить"));

    expect(await screen.findByText(/контекст перенесён в новый чат/i)).toBeTruthy();
    expect(await screen.findByText(/соединение закрыто до завершения/i)).toBeTruthy();
  });

  it("P1-2: обрабатывает SSE-событие subagent_error и показывает текст ошибки", async () => {
    conversations = [
      { id: 1, kind: "agent", title: "Основной чат", messagesCount: 0, updatedAt: "2026-11-17T10:00:00.000Z" },
    ];
    const encoder = new TextEncoder();
    sseResponder = () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: subagent_error\ndata: ${JSON.stringify({
                runKey: "r-crash",
                subagentName: "Стили",
                status: "error",
                message: "Превышен лимит времени сеанса субагента",
              })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    render(<AgentChat userName="Тест" />);
    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    fireEvent.change(chatBox, { target: { value: "Свёрстай шапку" } });
    fireEvent.click(screen.getByText("Запустить"));

    expect(await screen.findByText(/Превышен лимит времени сеанса субагента/i)).toBeTruthy();
  });

  it("показывает карточку live-actor-card субагента во вкладке «Чат», парсит CRLF SSE и корректно останавливает запрос кнопкой «Остановить»", async () => {
    const encoder = new TextEncoder();
    let aborted = false;

    sseResponder = (_url, init) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: subagent_start\r\ndata: ${JSON.stringify({
                runKey: "rk-ui",
                subagentSlug: "qa",
                subagentName: "QA Агент",
                subagentColor: "#06b6d4",
                tier: 1,
                routingMode: "linear",
                model: "o3-mini",
              })}\r\n\r\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: subagent_status\r\ndata: ${JSON.stringify({
                runKey: "rk-ui",
                subagentName: "QA Агент",
                text: "Проверяю вёрстку и кнопки…",
              })}\r\n\r\n`,
            ),
          );
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            try {
              controller.error(new DOMException("Aborted", "AbortError"));
            } catch {
              // ignore
            }
          });
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    render(<AgentChat userName="Тест" />);
    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    fireEvent.change(chatBox, { target: { value: "Создай и проверь shop-demo" } });
    fireEvent.click(screen.getByText("Запустить"));

    const liveCard = await screen.findByTestId("live-actor-card");
    expect(liveCard.textContent).toContain("Субагент · QA Агент");
    expect((await screen.findAllByText(/Проверяю вёрстку и кнопки…/i)).length).toBeGreaterThanOrEqual(2);

    const stopBtn = screen.getByRole("button", { name: /Остановить/i });
    fireEvent.click(stopBtn);

    await waitFor(() => expect(aborted).toBe(true));
    expect(await screen.findByText(/Выполнение остановлено пользователем\./i)).toBeTruthy();
  });

  it("показывает ошибку при неожиданном обрыве SSE-потока без события done и ответа", async () => {
    sseReply = ": keepalive\n\n";
    render(<AgentChat userName="Тест" />);
    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    fireEvent.change(chatBox, { target: { value: "Проверь обрыв" } });
    fireEvent.click(screen.getByText("Запустить"));

    expect(await screen.findByText(/Поток ответа от агента оборвался без завершения/i)).toBeTruthy();
  });

  it("обновляет статус live-actor-card, когда субагент ждёт подтверждения на сайте", async () => {
    const encoder = new TextEncoder();
    const streamCtrl: { current: ReadableStreamDefaultController<Uint8Array> | null } = { current: null };

    sseResponder = () => {
      const stream = new ReadableStream({
        start(controller) {
          streamCtrl.current = controller;
          controller.enqueue(
            encoder.encode(
              `event: subagent_start\ndata: ${JSON.stringify({
                runKey: "rk-apr",
                subagentSlug: "qa-proj-sub",
                subagentName: "QA Проекта",
                model: "o3-mini",
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: subagent_reasoning\ndata: ${JSON.stringify({
                runKey: "rk-apr",
                subagentName: "QA Проекта",
                text: "Рассуждения завершены, запускаю npm test",
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: approval_required\ndata: ${JSON.stringify({
                approvalId: "apr-qa-1",
                kind: "bash_command",
                title: "Разрешить субагенту запустить тесты?",
                command: "npm test",
              })}\n\n`,
            ),
          );
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    render(<AgentChat userName="Тест" />);
    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    fireEvent.change(chatBox, { target: { value: "Проверь qa-proj" } });
    fireEvent.click(screen.getByText("Запустить"));

    const liveCard = await screen.findByTestId("live-actor-card");
    expect(liveCard.textContent).toContain("Ждёт подтверждения: Разрешить субагенту запустить тесты?");

    fireEvent.click(screen.getByRole("button", { name: /^Разрешить$/i }));
    await waitFor(() => expect(approvalsSent.length).toBe(1));

    streamCtrl.current?.enqueue(encoder.encode('event: text\ndata: {"text":"Проверка завершена."}\n\n'));
    streamCtrl.current?.enqueue(encoder.encode('event: done\ndata: {"steps":1,"files":0,"actions":0}\n\n'));
    streamCtrl.current?.close();
    expect(await screen.findByText(/Проверка завершена\./i)).toBeTruthy();
  });

  it("показывает live-журнал BrowserInspector и карточку сбоя с пошаговым трейсом", async () => {
    const encoder = new TextEncoder();
    const streamCtrl: { current: ReadableStreamDefaultController<Uint8Array> | null } = { current: null };

    sseResponder = () => {
      const stream = new ReadableStream({
        start(controller) {
          streamCtrl.current = controller;
          controller.enqueue(
            encoder.encode(
              `event: status\ndata: ${JSON.stringify({
                text: "Вызываю инструмент: browse_project…",
                source: "browser_inspector",
                tool: "browse_project",
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: status\ndata: ${JSON.stringify({
                text: "Запускаю msedge.exe (попытка 1/3: --headless=new, D3D11/ANGLE, sandbox)…",
                source: "browser_inspector",
                tool: "browse_project",
              })}\n\n`,
            ),
          );
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    render(<AgentChat userName="Тест" />);
    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    fireEvent.change(chatBox, { target: { value: "Открой проект в браузере" } });
    fireEvent.click(screen.getByText("Запустить"));

    expect(await screen.findByText(/Ход BrowserInspector/i)).toBeTruthy();
    expect(screen.getAllByText(/Запускаю msedge\.exe \(попытка 1\/3/i).length).toBeGreaterThanOrEqual(2);

    streamCtrl.current?.enqueue(
      encoder.encode(
        `event: action\ndata: ${JSON.stringify({
          type: "browser_inspect",
          action: "open",
          url: "http://127.0.0.1:3000",
          error: "Не удалось запустить Chromium (код 1): gpu_process_host failed",
          trace: [
            "[+0.01s] Старт действия «open»",
            "[+0.25s] Попытка 1 завершилась с ошибкой: gpu_process_host failed",
          ],
          errorsCount: 1,
        })}\n\n`,
      ),
    );
    streamCtrl.current?.enqueue(encoder.encode('event: text\ndata: {"text":"Браузер не стартовал."}\n\n'));
    streamCtrl.current?.enqueue(encoder.encode('event: done\ndata: {"steps":1,"files":0,"actions":1}\n\n'));
    streamCtrl.current?.close();

    expect(await screen.findByText(/Сбой BrowserInspector \(open\)/i)).toBeTruthy();
    expect(screen.getByText(/Не удалось запустить Chromium \(код 1\)/i)).toBeTruthy();
    expect(screen.getByText(/Журнал шагов BrowserInspector \(2\)/i)).toBeTruthy();
    expect(screen.getByText(/\[\+0\.25s\] Попытка 1 завершилась с ошибкой/i)).toBeTruthy();
    // После прихода карточки browser_inspect и завершения шага живая плашка хода должна исчезнуть.
    expect(screen.queryByText(/Ход BrowserInspector/i)).toBeNull();
  });

  it("убирает живую плашку BrowserInspector сразу после done: true при осмотре субагентом с полными инструментами и разбирает CRLF SSE", async () => {
    const encoder = new TextEncoder();
    const streamCtrl: { current: ReadableStreamDefaultController<Uint8Array> | null } = { current: null };

    sseResponder = () => {
      const stream = new ReadableStream({
        start(controller) {
          streamCtrl.current = controller;
          controller.enqueue(
            encoder.encode(
              `event: subagent_start\r\ndata: ${JSON.stringify({
                runKey: "run-br-1",
                subagentSlug: "qa-full",
                subagentName: "QA Браузер",
                model: "gpt-test",
              })}\r\n\r\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: subagent_status\r\ndata: ${JSON.stringify({
                runKey: "run-br-1",
                subagentName: "QA Браузер",
                text: "Осмотр «resize» завершён за 0.92 с (анимаций: 20, проблем: 0, ошибок: 0)",
                source: "browser_inspector",
                tool: "qa_browser_audit",
              })}\r\n\r\n`,
            ),
          );
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    render(<AgentChat userName="Тест" />);
    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    fireEvent.change(chatBox, { target: { value: "Проверь проект субагентом" } });
    fireEvent.click(screen.getByText("Запустить"));

    expect(await screen.findByText(/Ход BrowserInspector/i)).toBeTruthy();
    expect(screen.getAllByText(/Осмотр «resize» завершён/i).length).toBeGreaterThanOrEqual(2);

    streamCtrl.current?.enqueue(
      encoder.encode(
        `event: subagent_status\r\ndata: ${JSON.stringify({
          runKey: "run-br-1",
          subagentName: "QA Браузер",
          text: "BrowserInspector завершил шаг (qa_browser_audit) — передаю данные субагенту «QA Браузер»…",
          source: "browser_inspector",
          tool: "qa_browser_audit",
          done: true,
        })}\r\n\r\n`,
      ),
    );

    await waitFor(() => {
      expect(screen.queryByText(/Ход BrowserInspector/i)).toBeNull();
    });

    streamCtrl.current?.enqueue(encoder.encode('event: text\r\ndata: {"text":"Проверка завершена."}\r\n\r\n'));
    streamCtrl.current?.enqueue(encoder.encode('event: done\r\ndata: {"steps":1,"files":0,"actions":0}\r\n\r\n'));
    streamCtrl.current?.close();
    expect(await screen.findByText(/Проверка завершена\./i)).toBeTruthy();
  });

  it("показывает полные мысли субагента в live-actor-card и итоговую карточку отчёта субагента", async () => {
    const encoder = new TextEncoder();
    const streamCtrl: { current: ReadableStreamDefaultController<Uint8Array> | null } = { current: null };

    sseResponder = () => {
      const stream = new ReadableStream({
        start(controller) {
          streamCtrl.current = controller;
          controller.enqueue(
            encoder.encode(
              `event: subagent_start\ndata: ${JSON.stringify({
                runKey: "rk-full",
                subagentSlug: "crm-qa",
                subagentName: "Аудитор CRM",
                subagentColor: "#06b6d4",
                tier: 1,
                routingMode: "linear",
                model: "qwen3",
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: subagent_reasoning\ndata: ${JSON.stringify({
                runKey: "rk-full",
                subagentName: "Аудитор CRM",
                text: "Шаг 1: проверяю структуру.\n\nШаг 2: проверяю все эндпоинты.\n\nУникальная_концовка_мысли_шага_3",
              })}\n\n`,
            ),
          );
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    render(<AgentChat userName="Тест" />);
    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    fireEvent.change(chatBox, { target: { value: "Создай и проверь crm-ui" } });
    fireEvent.click(screen.getByText("Запустить"));

    const liveCard = await screen.findByTestId("live-actor-card");
    expect(liveCard.textContent).toContain("Субагент · Аудитор CRM");
    expect(await screen.findByText(/Уникальная_концовка_мысли_шага_3/i)).toBeTruthy();

    streamCtrl.current?.enqueue(
      encoder.encode(
        `event: action\ndata: ${JSON.stringify({
          type: "subagent_report",
          subagentName: "Аудитор CRM",
          sandboxProject: "crm-ui",
          reportSummary: "Все 10 проверок пройдены без критических ошибок.",
        })}\n\n`,
      ),
    );
    streamCtrl.current?.enqueue(encoder.encode('event: text\ndata: {"text":"Анализ завершён."}\n\n'));
    streamCtrl.current?.enqueue(encoder.encode('event: done\ndata: {"steps":1,"files":0,"actions":1}\n\n'));
    streamCtrl.current?.close();
    expect(await screen.findByText(/Анализ завершён\./i)).toBeTruthy();
    expect(screen.getByText(/Все 10 проверок пройдены без критических ошибок\./i)).toBeTruthy();
  });

  it("показывает ошибку при обрыве потока после частичного ответа без done и читает финальный кадр на EOF", async () => {
    sseReply = [
      'event: reasoning\r\ndata: {"text":"Начал анализировать..."}\r\n\r\n',
      'event: action\r\ndata: {"type":"browser_inspect","label":"Проверка","url":"http://127.0.0.1:4100"}\r\n\r\n',
    ].join("");
    render(<AgentChat userName="Тест" />);
    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    fireEvent.change(chatBox, { target: { value: "Тест обрыва с частичным ответом" } });
    fireEvent.click(screen.getByText("Запустить"));

    expect(await screen.findByText(/Поток ответа от агента оборвался без завершения/i)).toBeTruthy();

    sseReply = 'event: text\r\ndata: {"text":"Успешный хвост"}\r\n\r\nevent: done\r\ndata: {}';
    fireEvent.change(chatBox, { target: { value: "Тест хвоста EOF" } });
    fireEvent.click(screen.getByText("Запустить"));
    expect(await screen.findByText(/Успешный хвост/i)).toBeTruthy();
    expect(screen.getAllByText(/Поток ответа от агента оборвался без завершения/i)).toHaveLength(1);
  });

  it("показывает единую карточку активного актора, эскалацию субагентов и блокировку Надсмотрщика в прямом эфире", async () => {
    const encoder = new TextEncoder();
    const streamCtrl: { current: ReadableStreamDefaultController<Uint8Array> | null } = { current: null };
    sseResponder = () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamCtrl.current = controller;
          controller.enqueue(
            encoder.encode(
              `event: agent_card\ndata: ${JSON.stringify({
                kind: "orchestrator",
                name: "Оркестратор",
                routingMode: "layered",
                model: "qwen3:8b",
                statusText: "Выбираю субагента по уровням…",
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: subagent_start\ndata: ${JSON.stringify({
                subagentSlug: "css-leaf",
                subagentName: "Стили",
                subagentColor: "#06b6d4",
                tier: 4,
                routingMode: "layered",
                model: "deepseek-r1",
                usedCustomApi: true,
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: subagent_reasoning\ndata: ${JSON.stringify({
                subagentName: "Стили",
                text: "Проверяю CSS переменные и эскалацию на уровень 1.",
              })}\n\n`,
            ),
          );
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    render(<AgentChat userName="Тест" />);
    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    fireEvent.change(chatBox, { target: { value: "Проверь цвета по уровням" } });
    fireEvent.click(screen.getByText("Запустить"));

    // Единая живая карточка показывает активного Субагента 4-го уровня с кастомным API
    const liveCard = await screen.findByTestId("live-actor-card");
    expect(liveCard.textContent).toContain("Субагент · Стили");
    expect(liveCard.textContent).toContain("ур.4");
    expect(liveCard.textContent).toContain("По уровням");
    expect(liveCard.textContent).toContain("своё API");
    expect(await screen.findByText(/Проверяю CSS переменные и эскалацию на уровень 1/i)).toBeTruthy();

    // Надсмотрщик перехватывает команду — карточка временно переключается на Надсмотрщика и открывает ApprovalToast
    streamCtrl.current?.enqueue(
      encoder.encode(
        `event: overseer_start\ndata: ${JSON.stringify({
          tool: "run_command",
          targetAgent: "Стили",
          model: "guard-7b",
        })}\n\n`,
      ),
    );
    streamCtrl.current?.enqueue(
      encoder.encode(
        `event: overseer_reasoning\ndata: ${JSON.stringify({
          text: "Обнаружен выход из песочницы в cat ../.env",
          tool: "run_command",
        })}\n\n`,
      ),
    );
    streamCtrl.current?.enqueue(
      encoder.encode(
        `event: approval_required\ndata: ${JSON.stringify({
          approvalId: "ov-main-1",
          kind: "overseer_approval",
          title: "Надсмотрщик: подозрительный доступ",
          description: "Попытка чтения секретов",
          command: "cat ../.env",
          overseer: {
            checkId: "ov1",
            verdict: "require_human",
            riskLevel: "critical",
            title: "Побег из Sandbox",
            reason: "Команда содержит ../.env",
            recommendation: "Отклоните запрос",
            requestedBy: "Стили",
            tool: "run_command",
          },
        })}\n\n`,
      ),
    );

    expect(await screen.findByText(/Надсмотрщик · риск: critical/i)).toBeTruthy();
    expect(screen.getByText(/Команда содержит \.\.\/\.env/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Отклонить$/i }));
    await waitFor(() => {
      expect(approvalsSent.some((a) => a.approvalId === "ov-main-1" && a.approved === false)).toBe(true);
    });

    // Надсмотрщик завершает, субагент передаёт задачу на верхний уровень и отдаёт отчёт
    streamCtrl.current?.enqueue(
      encoder.encode(
        `event: overseer_done\ndata: ${JSON.stringify({
          verdict: "require_human",
          riskLevel: "critical",
          tool: "run_command",
          reason: "Отклонено пользователем",
        })}\n\n`,
      ),
    );
    streamCtrl.current?.enqueue(
      encoder.encode(
        `event: subagent_handoff\ndata: ${JSON.stringify({
          fromSubagentName: "Стили",
          toSubagentName: "Архитектор",
          handoffVia: "escalation",
          task: "Уточнить токены темы",
        })}\n\n`,
      ),
    );
    streamCtrl.current?.enqueue(
      encoder.encode(
        `event: subagent_done\ndata: ${JSON.stringify({
          subagentName: "Стили",
        })}\n\n`,
      ),
    );
    streamCtrl.current?.enqueue(
      encoder.encode(
        `event: overseer_verdict\ndata: ${JSON.stringify({
          verdict: "require_human",
          tool: "run_command",
          riskLevel: "critical",
          reason: "Отклонено человеком",
          label: "Надсмотрщик заблокировал run_command",
        })}\n\n`,
      ),
    );
    streamCtrl.current?.enqueue(
      encoder.encode(
        `event: action\ndata: ${JSON.stringify({
          type: "subagent_report",
          subagentName: "Стили",
          tier: 4,
          reportSummary: "Запрошена эскалация на Уровень 1.",
        })}\n\n`,
      ),
    );
    streamCtrl.current?.enqueue(encoder.encode('event: text\ndata: {"text":"Итоговый ответ готов."}\n\n'));
    streamCtrl.current?.enqueue(encoder.encode('event: done\ndata: {}\n\n'));
    streamCtrl.current?.close();

    expect(await screen.findByText(/Итоговый ответ готов\./i)).toBeTruthy();
    expect(screen.getByText(/Стили → Архитектор/i)).toBeTruthy();
    expect(screen.getByText(/Надсмотрщик заблокировал run_command/i)).toBeTruthy();
    expect(screen.getByText(/Отчёт субагента · Стили/i)).toBeTruthy();
  });

  it("переиспользует единую вкладку crm_sandbox_preview при повторных open_url на проект", async () => {
    const fakePreviewWin = {
      closed: false,
      location: { href: "" },
      focus: vi.fn(),
      close: vi.fn(),
    } as unknown as Window;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(fakePreviewWin);

    render(<AgentChat userName="Тест" />);
    const textarea = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    await waitFor(() => expect((textarea as HTMLTextAreaElement).disabled).toBe(false));

    const encoder = new TextEncoder();
    sseResponder = () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: action\ndata: {"type":"open_url","url":"/api/ai/agent/sandbox/proxy/4100","label":"Первый старт"}\n\n',
            ),
          );
          controller.enqueue(
            encoder.encode(
              'event: action\ndata: {"type":"open_url","url":"/api/ai/agent/sandbox/proxy/4101","label":"Перезапуск"}\n\n',
            ),
          );
          controller.enqueue(encoder.encode('event: text\ndata: {"text":"Проект перезапущен."}\n\n'));
          controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    fireEvent.change(textarea, { target: { value: "запусти и перезапусти проект" } });
    fireEvent.click(screen.getByText("Запустить"));

    expect(await screen.findByText(/Проект перезапущен\./i)).toBeTruthy();
    // window.open вызван ТОЛЬКО 1 раз с именем вкладки crm_sandbox_preview, второй URL обновил ту же вкладку
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith("/api/ai/agent/sandbox/proxy/4100", "crm_sandbox_preview");
    expect(fakePreviewWin.location.href).toBe("/api/ai/agent/sandbox/proxy/4101");
    openSpy.mockRestore();
  });

  it("держит SSE-поток до 1200 с: не обрывает при активных кадрах дольше 120 с и рвёт ровно после 1200 с тишины", async () => {
    expect(SSE_IDLE_TIMEOUT_MS).toBe(1_200_000);

    // 1) Долгий ответ (> 400 с с паузами по 150 с между кадрами) НЕ обрывается на 120 с.
    render(<AgentChat userName="Тест" />);
    const textarea = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    await waitFor(() => expect((textarea as HTMLTextAreaElement).disabled).toBe(false));

    const encoder = new TextEncoder();
    let streamCtrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    sseResponder = () => {
      const stream = new ReadableStream({
        start(controller) {
          streamCtrl = controller;
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "Сделай тяжёлый проект" } });
        fireEvent.click(screen.getByText("Запустить"));
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(streamCtrl).not.toBeNull();

      // Через 150 с (> прежних 120 с) модель шлёт reasoning + status, таймер сбрасывается.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150_000);
        streamCtrl!.enqueue(
          encoder.encode(
            `event: reasoning\ndata: ${JSON.stringify({ text: "Анализирую модули проекта…" })}\n\n`,
          ),
        );
        await vi.advanceTimersByTimeAsync(50);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150_000);
        streamCtrl!.enqueue(
          encoder.encode(
            `event: status\ndata: ${JSON.stringify({ text: "Модель формирует вызов sandbox_write_file…" })}\n\n`,
          ),
        );
        await vi.advanceTimersByTimeAsync(50);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150_000);
        streamCtrl!.enqueue(encoder.encode('event: text\ndata: {"text":"Тяжёлый проект готов."}\n\n'));
        streamCtrl!.enqueue(encoder.encode('event: done\ndata: {"steps":1}\n\n'));
        streamCtrl!.close();
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(screen.getByText(/Тяжёлый проект готов\./i)).toBeTruthy();
      expect(screen.queryByText(/Агент не отвечает/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }

    // 2) При реальном отсутствии данных по SSE в течение 1200 с появляется ошибка.
    let aborted = false;
    sseResponder = (_url, init) => {
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            try {
              controller.error(new DOMException("Aborted", "AbortError"));
            } catch {
              // ignore
            }
          });
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await act(async () => {
        const nextBox = screen.getByPlaceholderText(/Например: открой ютуб/i);
        fireEvent.change(nextBox, { target: { value: "Зависший запрос" } });
        fireEvent.click(screen.getByText("Запустить"));
        await vi.advanceTimersByTimeAsync(1_190_000);
      });
      expect(aborted).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(aborted).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(screen.getByText(/Агент не отвечает \(нет данных по SSE более 1200 с\)/i)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
