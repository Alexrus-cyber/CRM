import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentChat } from "@/components/AgentChat";

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
      "Тестировщик",
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

  it("синхронизирует модель с подвкладкой «Тестировщик», отображает отдельный QA-чат, отчёт и одобрение мелких правок", async () => {
    testerRunsMock = [
      {
        id: 11,
        userId: 1,
        agentConversationId: 1,
        testerConversationId: 50,
        sandboxProject: "landing-site",
        title: "QA: landing-site",
        summary: "Найдена 1 мелкая проблема верстки",
        status: "minor_issues",
        criticalIssues: [],
        minorIssues: [
          {
            title: "Отступ на мобильном экране",
            description: "Увеличить padding-x до 16px",
            file: "src/index.css",
            severity: "minor",
          },
        ],
        checksRun: [{ name: "qa_static_review", status: "pass", details: "OK" }],
        minorDecision: "pending",
        model: "gpt-4o-mini",
        promptTokens: 120,
        completionTokens: 80,
        totalTokens: 200,
        createdAt: "2026-11-17T10:05:00.000Z",
        finishedAt: "2026-11-17T10:05:10.000Z",
      },
    ];
    conversations = [
      { id: 1, kind: "agent", title: "Основной чат", messagesCount: 0, updatedAt: "2026-11-17T10:00:00.000Z" },
      { id: 50, kind: "tester", title: "QA: landing-site", messagesCount: 2, updatedAt: "2026-11-17T10:05:10.000Z" },
    ];
    messagesByConv[50] = [
      { id: 501, role: "user", content: "Проверь landing-site" },
      { id: 502, role: "assistant", content: "Итог: minor_issues" },
    ];

    render(<AgentChat userName="Тест" />);
    // Меняем модель на вкладке Агента — она должна синхронизироваться в индикаторе Тестировщика
    fireEvent.click(screen.getByRole("tab", { name: /Модель и генерация/i }));
    const modelInput = screen.getByLabelText("Модель");
    fireEvent.change(modelInput, { target: { value: "qwen2.5-coder:32b" } });

    fireEvent.click(screen.getByRole("tab", { name: /Тестировщик/i }));
    expect(await screen.findByText(/Модель синхронизирована с Агентом: qwen2\.5-coder:32b/i)).toBeTruthy();
    expect(screen.getByText(/Токены QA-чата: 200/)).toBeTruthy();
    expect(screen.getByText("Отступ на мобильном экране")).toBeTruthy();

    // Подтверждаем мелкие исправления прямо из панели Тестировщика
    fireEvent.click(screen.getByRole("button", { name: /Внести изменения/i }));
    await waitFor(() =>
      expect(testerDecisionsSent).toEqual([{ runId: 11, decision: "approved" }]),
    );
  });

  it("обрабатывает SSE-события tester_run / approval_required (tester_minor_fixes) / tester_done в основном чате Агента", async () => {
    conversations = [
      { id: 1, kind: "agent", title: "Основной чат", messagesCount: 0, updatedAt: "2026-11-17T10:00:00.000Z" },
    ];
    const testerRunObj = {
      id: 22,
      userId: 1,
      agentConversationId: 1,
      testerConversationId: 60,
      sandboxProject: "crm-widget",
      title: "QA: crm-widget",
      summary: "Обнаружена 1 мелкая ошибка отступа",
      status: "minor_issues",
      criticalIssues: [],
      minorIssues: [{ title: "Шрифт заголовка", description: "Слишком тонкий", file: "index.html", severity: "minor" }],
      checksRun: [{ name: "qa_static_review", status: "pass", details: "OK" }],
      minorDecision: "pending",
      model: "o3-mini",
      promptTokens: 50,
      completionTokens: 40,
      totalTokens: 90,
      createdAt: "2026-11-17T10:06:00.000Z",
      finishedAt: "2026-11-17T10:06:05.000Z",
    };

    const encoder = new TextEncoder();
    sseResponder = () => {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: tester_run\ndata: ${JSON.stringify({ runKey: "r1", runId: 22, testerConversationId: 60, conversation: { id: 60, kind: "tester", title: "QA: crm-widget", messagesCount: 1, updatedAt: "2026-11-17T10:06:00.000Z" }, run: { ...testerRunObj, status: "running", minorIssues: [], totalTokens: 0 } })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: approval_required\ndata: ${JSON.stringify({ approvalId: "apr-minor-1", kind: "tester_minor_fixes", title: "Мелкие замечания по crm-widget", description: "Решить судьбу мелких правок", sandboxProject: "crm-widget", testerRunId: 22, testerConversationId: 60, minorIssues: testerRunObj.minorIssues })}\n\n`,
            ),
          );
          while (approvalsSent.length === 0) {
            await new Promise((r) => setTimeout(r, 10));
          }
          controller.enqueue(
            encoder.encode(
              `event: action\ndata: ${JSON.stringify({ type: "tester_report", label: "Отчёт Тестировщика: crm-widget", sandboxProject: "crm-widget", testerConversationId: 60, status: "minor_issues", reportSummary: "Обнаружена 1 мелкая ошибка отступа", criticalCount: 0, minorCount: 1, totalTokens: 90 })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: tester_done\ndata: ${JSON.stringify({ runKey: "r1", runId: 22, testerConversationId: 60, run: testerRunObj })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode('event: text\ndata: {"text":"Тестировщик завершил проверку crm-widget."}\n\n'),
          );
          controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    render(<AgentChat userName="Тест" />);
    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    fireEvent.change(chatBox, { target: { value: "Протестируй crm-widget" } });
    fireEvent.click(screen.getByText("Запустить"));

    // Появляется карточка подтверждения мелких замечаний
    expect(await screen.findByText("Мелкие замечания по crm-widget")).toBeTruthy();
    expect(screen.getByText("Шрифт заголовка")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Внести мелкие изменения/i }));

    await waitFor(() => expect(approvalsSent.length).toBe(1));
    expect(approvalsSent[0]).toMatchObject({ approvalId: "apr-minor-1", approved: true });
    await waitFor(() =>
      expect(testerDecisionsSent).toContainEqual({ runId: 22, decision: "approved" }),
    );
    expect(await screen.findByText(/Отчёт Тестировщика · crm-widget/i)).toBeTruthy();
  });

  it("позволяет запустить Тестировщика напрямую из отдельной вкладки с общими настройками модели", async () => {
    sseResponder = () => {
      // Имитируем серверную запись отчёта в QA-чат №1 (который создаст клиент при первом запуске)
      const convId = nextConvId - 1;
      messagesByConv[convId] = [
        ...(messagesByConv[convId] ?? []),
        { id: nextMsgId++, role: "assistant", content: "Проверка завершена успешно, багов не найдено." },
      ];
      testerRunsMock = [
        {
          id: 33,
          userId: 1,
          agentConversationId: null,
          testerConversationId: convId,
          sandboxProject: "landing-site",
          summary: "Проверь сайт",
          status: "passed",
          reportSummary: "OK",
          criticalIssues: [],
          minorIssues: [],
          checksRun: [],
          minorDecision: "not_needed",
          promptTokens: 40,
          completionTokens: 20,
          totalTokens: 60,
          model: "o3-mini",
          createdAt: "2026-11-17T10:10:00.000Z",
          updatedAt: "2026-11-17T10:10:05.000Z",
        },
      ];
      const body = [
        `event: tester_run\ndata: ${JSON.stringify({ runKey: "direct", runId: 33, testerConversationId: convId })}\n\n`,
        'event: text\ndata: {"text":"Проверка завершена успешно, багов не найдено."}\n\n',
        `event: tester_done\ndata: ${JSON.stringify({ runKey: "direct", runId: 33, testerConversationId: convId, run: testerRunsMock[0] })}\n\n`,
        "event: done\ndata: {}\n\n",
      ].join("");
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    render(<AgentChat userName="Тест" />);
    fireEvent.click(screen.getByRole("tab", { name: /Модель и генерация/i }));
    fireEvent.change(screen.getByLabelText("Модель"), { target: { value: "o3-mini" } });

    fireEvent.click(screen.getByRole("tab", { name: /Тестировщик/i }));
    const projectSelect = (await screen.findByLabelText(/Проект Sandbox/i)) as HTMLSelectElement;
    fireEvent.change(projectSelect, { target: { value: "landing-site" } });

    const testerInput = screen.getByLabelText("Задача для Тестировщика");
    fireEvent.change(testerInput, { target: { value: "Проверь адаптивность и ссылки" } });
    fireEvent.click(screen.getByRole("button", { name: /Проверить проект/i }));

    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toMatchObject({
      agentRole: "tester",
      sandboxProject: "landing-site",
      settings: { model: "o3-mini" },
    });
    expect(await screen.findByText(/Проверка завершена успешно, багов не найдено\./i)).toBeTruthy();
  });

  it("показывает карточку liveTester прямо во вкладке «Чат», парсит CRLF SSE и корректно останавливает запрос кнопкой «Остановить»", async () => {
    const encoder = new TextEncoder();
    let aborted = false;

    sseResponder = (_url, init) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: tester_run\r\ndata: ${JSON.stringify({
                runKey: "rk-ui",
                runId: 55,
                testerConversationId: 1,
                sandboxProject: "shop-demo",
                summary: "Аудит магазина",
              })}\r\n\r\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: tester_status\r\ndata: ${JSON.stringify({ runKey: "rk-ui", text: "Проверяю вёрстку и кнопки…" })}\r\n\r\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: tester_action\r\ndata: ${JSON.stringify({ runKey: "rk-ui", action: { type: "qa_check", label: "HTTP-аудит /" } })}\r\n\r\n`,
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

    // На активной вкладке «Чат» видна живая карточка Тестировщика и кнопка «Остановить»
    expect(await screen.findByText(/Тестировщик · shop-demo/i)).toBeTruthy();
    expect((await screen.findAllByText(/Проверяю вёрстку и кнопки…/i)).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/HTTP-аудит \//i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /Открыть Тестировщик/i })).toBeTruthy();

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

  it("обновляет статус liveTester, когда Тестировщик ждёт подтверждения на сайте", async () => {
    const encoder = new TextEncoder();
    const streamCtrl: { current: ReadableStreamDefaultController<Uint8Array> | null } = { current: null };

    sseResponder = () => {
      const stream = new ReadableStream({
        start(controller) {
          streamCtrl.current = controller;
          controller.enqueue(
            encoder.encode(
              `event: tester_run\ndata: ${JSON.stringify({
                runKey: "rk-apr",
                runId: 77,
                testerConversationId: 1,
                sandboxProject: "qa-proj",
                summary: "Запуск тестов",
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: tester_reasoning\ndata: ${JSON.stringify({
                runKey: "rk-apr",
                text: "Рассуждения завершены, запускаю qa_run_tests",
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: approval_required\ndata: ${JSON.stringify({
                approvalId: "apr-qa-1",
                kind: "bash_command",
                title: "Разрешить Тестировщику запустить тесты?",
                command: "npm test",
                testerRunKey: "rk-apr",
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

    expect(await screen.findByText(/Тестировщик · qa-proj/i)).toBeTruthy();
    expect((await screen.findAllByText(/Тестировщик ждёт вашего подтверждения на сайте…/i)).length).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByRole("button", { name: /^Разрешить$/i }));
    await waitFor(() => expect(approvalsSent.length).toBe(1));
    expect((await screen.findAllByText(/Тестировщик: продолжаю проверку…/i)).length).toBeGreaterThanOrEqual(2);

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

  it("убирает живую плашку BrowserInspector сразу после handoff (done: true) и показывает формат осмотра у Тестировщика", async () => {
    const encoder = new TextEncoder();
    const streamCtrl: { current: ReadableStreamDefaultController<Uint8Array> | null } = { current: null };

    sseResponder = () => {
      const stream = new ReadableStream({
        start(controller) {
          streamCtrl.current = controller;
          controller.enqueue(
            encoder.encode(
              `event: tester_run\ndata: ${JSON.stringify({
                runKey: "run-br-1",
                runId: 77,
                testerConversationId: 2,
                sandboxProject: "landing",
                model: "gpt-test",
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: tester_status\ndata: ${JSON.stringify({
                runKey: "run-br-1",
                text: "Осмотр «resize» завершён за 0.92 с (анимаций: 20, проблем: 0, ошибок: 0)",
                source: "browser_inspector",
                tool: "qa_browser_audit",
              })}\n\n`,
            ),
          );
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    render(<AgentChat userName="Тест" />);
    const chatBox = await screen.findByPlaceholderText(/Например: открой ютуб/i);
    fireEvent.change(chatBox, { target: { value: "Проверь проект тестировщиком" } });
    fireEvent.click(screen.getByText("Запустить"));

    expect((await screen.findAllByText(/Ход BrowserInspector/i)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Осмотр «resize» завершён/i).length).toBeGreaterThanOrEqual(2);

    streamCtrl.current?.enqueue(
      encoder.encode(
        `event: tester_action\ndata: ${JSON.stringify({
          runKey: "run-br-1",
          action: {
            type: "browser_inspect",
            action: "resize",
            viewport: "390×844",
            url: "http://127.0.0.1:4444/",
            summary: "анимаций: 20, проблем: 0, ошибок: 0",
          },
        })}\n\n`,
      ),
    );
    streamCtrl.current?.enqueue(
      encoder.encode(
        `event: tester_status\ndata: ${JSON.stringify({
          runKey: "run-br-1",
          text: "BrowserInspector завершил шаг (qa_browser_audit) — передаю данные Тестировщику…",
          source: "browser_inspector",
          tool: "qa_browser_audit",
          done: true,
        })}\n\n`,
      ),
    );

    expect(
      (await screen.findAllByText(/Осмотр проекта \(resize · 390×844\): анимаций: 20, проблем: 0, ошибок: 0/i)).length,
    ).toBeGreaterThanOrEqual(2);
    await waitFor(() => {
      expect(screen.queryAllByText(/Ход BrowserInspector/i).length).toBe(0);
    });

    streamCtrl.current?.enqueue(encoder.encode('event: text\ndata: {"text":"Проверка завершена."}\n\n'));
    streamCtrl.current?.enqueue(encoder.encode('event: done\ndata: {"steps":1,"files":0,"actions":0}\n\n'));
    streamCtrl.current?.close();
    expect(await screen.findByText(/Проверка завершена\./i)).toBeTruthy();
  });

  it("корректно разбирает CRLF SSE и завершает BrowserInspector при прямом запуске Тестировщика", async () => {
    const encoder = new TextEncoder();
    const streamCtrl: { current: ReadableStreamDefaultController<Uint8Array> | null } = { current: null };

    sseResponder = () => {
      const stream = new ReadableStream({
        start(controller) {
          streamCtrl.current = controller;
          controller.enqueue(
            encoder.encode(
              `event: tester_run\r\ndata: ${JSON.stringify({
                runKey: "direct-1",
                runId: 88,
                testerConversationId: 2,
                sandboxProject: "landing",
                model: "gpt-test",
              })}\r\n\r\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: status\r\ndata: ${JSON.stringify({
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
    const testerTab = await screen.findByRole("button", { name: /Тестировщик/i });
    fireEvent.click(testerTab);

    const promptInput = await screen.findByLabelText(/Задача для Тестировщика/i);
    fireEvent.change(promptInput, { target: { value: "Проверь адаптивность landing" } });
    fireEvent.click(screen.getByRole("button", { name: /Проверить проект/i }));

    expect(await screen.findByText(/Ход BrowserInspector/i)).toBeTruthy();

    streamCtrl.current?.enqueue(
      encoder.encode(
        `event: action\r\ndata: ${JSON.stringify({
          type: "browser_inspect",
          action: "resize",
          viewport: "390×844",
          summary: "анимаций: 20, проблем: 0, ошибок: 0",
        })}\r\n\r\n`,
      ),
    );
    streamCtrl.current?.enqueue(
      encoder.encode(
        `event: status\r\ndata: ${JSON.stringify({
          text: "BrowserInspector завершил шаг — передаю данные Тестировщику…",
          source: "browser_inspector",
          tool: "qa_browser_audit",
          done: true,
        })}\r\n\r\n`,
      ),
    );

    expect(
      await screen.findByText(/Осмотр проекта \(resize · 390×844\): анимаций: 20, проблем: 0, ошибок: 0/i),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText(/Ход BrowserInspector/i)).toBeNull();
    });

    streamCtrl.current?.enqueue(encoder.encode('event: text\r\ndata: {"text":"Прямая проверка выполнена."}\r\n\r\n'));
    streamCtrl.current?.enqueue(encoder.encode('event: done\r\ndata: {"steps":1,"files":0,"actions":1}\r\n\r\n'));
    streamCtrl.current?.close();
    expect(await screen.findByText(/Прямая проверка выполнена\./i)).toBeTruthy();
  });
});
