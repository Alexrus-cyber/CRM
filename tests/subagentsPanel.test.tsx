import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SubagentsPanel } from "@/components/agent/SubagentsPanel";
import type {
  OverseerConfig,
  Subagent,
  SubagentConversation,
  SubagentRoutingMode,
  SubagentRun,
} from "@/components/agent/subagentTypes";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeSubagent(overrides: Partial<Subagent> = {}): Subagent {
  return {
    id: 1,
    userId: 10,
    slug: "qa-lead",
    name: "QA-инженер",
    roleTitle: "Контроль качества",
    description: "Проверяет приложения и пишет автотесты",
    systemPrompt: "Ты QA-субагент.",
    color: "#7c5cff",
    isActive: true,
    parentSubagentId: null,
    orchestratorCanCall: true,
    allowedCallees: ["*"],
    unlockApi: false,
    provider: "local",
    baseUrl: "",
    model: "",
    hasApiKey: false,
    apiKeyHint: "",
    reasoningMode: "default",
    runsCount: 3,
    conversationsCount: 1,
    createdAt: "2026-11-17T10:00:00.000Z",
    updatedAt: "2026-11-17T10:00:00.000Z",
    ...overrides,
  };
}

describe("SubagentsPanel & DependencyTreeCanvas", () => {
  let subagentsStore: Subagent[];
  let runsStore: SubagentRun[];
  let conversationsStore: SubagentConversation[];
  let getSubagentsCalls: string[];
  let chatTokensTotal: number;
  let putTreePayloads: Array<Record<string, unknown>>;
  let postSubagentPayloads: Array<Record<string, unknown>>;
  let patchSubagentPayloads: Array<{ id: number; body: Record<string, unknown> }>;
  let patchRootPayloads: Array<Record<string, unknown>>;
  let approvePayloads: Array<Record<string, unknown>>;
  let routingModeStore: SubagentRoutingMode;
  let overseerStore: OverseerConfig;
  let sseResponder: ((body: Record<string, unknown>) => Response) | null;

  beforeEach(() => {
    vi.restoreAllMocks();
    subagentsStore = [
      makeSubagent({ id: 1, slug: "qa-lead", name: "QA-инженер", color: "#7c5cff" }),
      makeSubagent({
        id: 2,
        slug: "ui-architect",
        name: "UI-архитектор",
        roleTitle: "Дизайн и верстка",
        color: "#06b6d4",
        parentSubagentId: 1,
        orchestratorCanCall: false,
        allowedCallees: ["qa-lead"],
        unlockApi: true,
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "qwen/qwen2.5-vl-72b-instruct",
        hasApiKey: true,
        apiKeyHint: "sk-or-•••99",
      }),
    ];
    runsStore = [
      {
        id: 11,
        subagentId: 1,
        subagentSlug: "qa-lead",
        subagentName: "QA-инженер",
        subagentColor: "#7c5cff",
        agentConversationId: 100,
        subagentConversationId: 201,
        callerKind: "orchestrator",
        callerSubagentId: null,
        sandboxProject: "crm-app",
        inputSummary: "Проверить сборку",
        outputSummary: "Ошибок не найдено",
        status: "completed",
        requestedCalleeSlug: "",
        requestedCalleeTask: "",
        actionsCount: 4,
        filesTouched: ["src/app/page.tsx"],
        promptTokens: 320,
        completionTokens: 180,
        totalTokens: 500,
        model: "qwen3:8b",
        usedCustomApi: false,
        createdAt: "2026-11-17T10:01:00.000Z",
        updatedAt: "2026-11-17T10:02:00.000Z",
      },
    ];
    conversationsStore = [
      {
        id: 201,
        kind: "subagent",
        subagentId: 1,
        title: "Чат: QA-инженер",
        messagesCount: 2,
        createdAt: "2026-11-17T10:01:00.000Z",
        updatedAt: "2026-11-17T10:02:00.000Z",
      },
    ];
    getSubagentsCalls = [];
    chatTokensTotal = 500;
    putTreePayloads = [];
    postSubagentPayloads = [];
    patchSubagentPayloads = [];
    patchRootPayloads = [];
    approvePayloads = [];
    routingModeStore = "linear";
    overseerStore = {
      enabled: true,
      mode: "strict",
      systemPrompt: "",
      unlockApi: false,
      provider: "local",
      baseUrl: "",
      model: "",
      hasApiKey: false,
      apiKeyHint: "",
    };
    sseResponder = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.startsWith("/api/agent/subagents") && method === "GET") {
          getSubagentsCalls.push(url);
          if (url.includes("onlyConversation=1")) {
            return json({
              selectedConversation: {
                conversation: conversationsStore[0],
                messages: [
                  {
                    id: 1,
                    conversationId: 201,
                    role: "user",
                    content: "Проверь форму входа",
                    reasoning: "",
                    attachments: [],
                    actions: [],
                    files: [],
                    error: "",
                    createdAt: "2026-11-17T10:01:00.000Z",
                  },
                  {
                    id: 2,
                    conversationId: 201,
                    role: "assistant",
                    content: "Форма входа проверена, ошибок нет.",
                    reasoning: "Проверил валидацию полей и фокус.",
                    attachments: [],
                    actions: [],
                    files: [],
                    error: "",
                    createdAt: "2026-11-17T10:02:00.000Z",
                  },
                ],
                tokens: { prompt: 320, completion: 180, total: chatTokensTotal },
              },
            });
          }
          return json({
            subagents: subagentsStore,
            runs: runsStore,
            conversations: conversationsStore,
            selectedConversation: null,
            routingMode: routingModeStore,
            overseer: overseerStore,
            limits: {
              maxStored: 50,
              maxActive: 10,
              totalCount: subagentsStore.length,
              activeCount: subagentsStore.filter((s) => s.isActive).length,
            },
          });
        }

        if (url === "/api/agent/subagents" && method === "PATCH") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          patchRootPayloads.push(body);
          if (body.routingMode === "layered" || body.routingMode === "linear") {
            routingModeStore = body.routingMode;
          }
          if (body.overseer && typeof body.overseer === "object") {
            overseerStore = { ...overseerStore, ...(body.overseer as Partial<OverseerConfig>) };
          }
          return json({ ok: true, routingMode: routingModeStore, overseer: overseerStore });
        }

        if (url === "/api/ai/agent/approve" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          approvePayloads.push(body);
          return json({ ok: true });
        }

        if (url === "/api/agent/subagents" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          postSubagentPayloads.push(body);
          const created = makeSubagent({
            id: 3,
            slug: String(body.slug || "sec-auditor"),
            name: String(body.name || "Аудитор"),
            roleTitle: String(body.roleTitle || ""),
            unlockApi: Boolean(body.unlockApi),
            provider: String(body.provider || "local"),
            baseUrl: String(body.baseUrl || ""),
            model: String(body.model || ""),
          });
          subagentsStore = [...subagentsStore, created];
          return json({ ok: true, subagent: created });
        }

        if (url === "/api/agent/subagents" && method === "PUT") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          putTreePayloads.push(body);
          return json({ ok: true });
        }

        const patchMatch = url.match(/^\/api\/agent\/subagents\/(\d+)$/);
        if (patchMatch && method === "PATCH") {
          const id = Number(patchMatch[1]);
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          patchSubagentPayloads.push({ id, body });
          return json({ ok: true, subagent: subagentsStore.find((s) => s.id === id) });
        }

        if (url === "/api/ai/agent" && method === "POST") {
          chatTokensTotal = 610;
          if (sseResponder) {
            const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            return sseResponder(body);
          }
          const sse = [
            `event: subagent_start\ndata: ${JSON.stringify({ subagentConversationId: 201 })}\n\n`,
            `event: subagent_reasoning\ndata: ${JSON.stringify({ text: "Анализирую запрос..." })}\n\n`,
            `event: subagent_text\ndata: ${JSON.stringify({ text: "Готово, отчёт сформирован." })}\n\n`,
            `event: subagent_done\ndata: ${JSON.stringify({ subagentConversationId: 201, usage: { prompt: 400, completion: 210, total: 610 } })}\n\n`,
          ].join("");
          return new Response(sse, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }

        return json({ error: `unexpected ${method} ${url}` }, 500);
      }),
    );
  });

  it("не зацикливает GET /api/agent/subagents даже при нестабильном onStats и взаимодействии с UI", async () => {
    const statsSeen: Array<{ totalCount: number; activeCount: number; runs: number }> = [];
    const { rerender } = render(
      <SubagentsPanel
        settings={{ baseUrl: "http://127.0.0.1:8888/v1", model: "qwen3:8b" }}
        params={{}}
        trustLevel="verified"
        refreshKey={0}
        onStats={(s) => statsSeen.push(s)}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByText("QA-инженер").length).toBeGreaterThan(0);
    });

    // Имитируем перерисовку с новой ссылкой на onStats и задержкой (раньше здесь шло 5+ запросов в мс)
    rerender(
      <SubagentsPanel
        settings={{ baseUrl: "http://127.0.0.1:8888/v1", model: "qwen3:8b" }}
        params={{}}
        trustLevel="verified"
        refreshKey={0}
        onStats={(s) => statsSeen.push(s)}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 180));

    expect(getSubagentsCalls).toEqual(["/api/agent/subagents"]);
    expect(statsSeen).toEqual([
      { totalCount: 2, activeCount: 2, runs: 1, routingMode: "linear", overseerEnabled: true },
    ]);

    // Обновление по сигналу завершения субагента делает ровно 1 дополнительный запрос
    rerender(
      <SubagentsPanel
        settings={{ baseUrl: "http://127.0.0.1:8888/v1", model: "qwen3:8b" }}
        params={{}}
        trustLevel="verified"
        refreshKey={1}
        onStats={(s) => statsSeen.push(s)}
      />,
    );
    await waitFor(() => {
      expect(getSubagentsCalls.length).toBe(2);
    });
  });

  it("отрисовывает нейронное дерево зависимостей, защищает от циклов и сохраняет изменения топологии", async () => {
    render(
      <SubagentsPanel
        settings={{ baseUrl: "http://127.0.0.1:8888/v1", model: "qwen3:8b" }}
        params={{}}
        trustLevel="verified"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "Схема зависимостей Оркестратора и субагентов" })).toBeTruthy();
    });

    // Кликаем на шестиугольник «QA-инженер» в дереве зависимостей
    fireEvent.click(screen.getByRole("button", { name: "Субагент QA-инженер" }));

    // Проверяем защиту от циклов: UI-архитектор является потомком QA-инженера и не может быть выбран родителем QA
    const parentSelect = screen.getByLabelText("Родительский узел для QA-инженер") as HTMLSelectElement;
    const uiArchOption = Array.from(parentSelect.options).find((o) => o.value === "2");
    expect(uiArchOption?.disabled).toBe(true);

    // Переключаем чекбокс «Оркестратор вызывает напрямую» и сохраняем дерево
    const directToggle = screen.getAllByRole("checkbox").find((el) =>
      el.closest("label")?.textContent?.includes("Оркестратор вызывает напрямую"),
    )!;
    fireEvent.click(directToggle);

    const saveTreeBtn = screen.getByRole("button", { name: /Сохранить дерево/i });
    fireEvent.click(saveTreeBtn);

    await waitFor(() => {
      expect(putTreePayloads.length).toBe(1);
    });
    const sentNodes = putTreePayloads[0].nodes as Array<{ id: number; orchestratorCanCall: boolean }>;
    expect(sentNodes.find((n) => n.id === 1)?.orchestratorCanCall).toBe(false);
  });

  it("использует стилизованные поля проекта, пресеты провайдеров и сохраняет ключ при редактировании", async () => {
    render(
      <SubagentsPanel
        settings={{ baseUrl: "http://127.0.0.1:8888/v1", model: "qwen3:8b" }}
        params={{}}
        trustLevel="verified"
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByText("QA-инженер").length).toBeGreaterThan(0);
    });

    // Открываем форму создания субагента
    fireEvent.click(screen.getByRole("button", { name: /Создать субагента/i }));
    const nameInput = screen.getByPlaceholderText("Например: QA-инженер");
    expect(nameInput.className).toContain("rounded-xl");
    expect(nameInput.className).toContain("bg-card2");

    fireEvent.change(nameInput, { target: { value: "Security-аудитор" } });
    // Разблокируем своё API и выбираем OpenRouter
    const unlockCheckbox = screen.getAllByRole("checkbox").find((el) =>
      el.closest("label")?.textContent?.includes("Разблокировать API"),
    )!;
    fireEvent.click(unlockCheckbox);

    const providerSelect = screen.getByDisplayValue(/Локальная/i);
    fireEvent.change(providerSelect, { target: { value: "openrouter" } });

    expect((screen.getByPlaceholderText("http://127.0.0.1:8888/v1") as HTMLInputElement).value).toBe(
      "https://openrouter.ai/api/v1",
    );

    fireEvent.click(screen.getByRole("button", { name: /^Создать$/i }));
    await waitFor(() => {
      expect(postSubagentPayloads.length).toBe(1);
    });
    expect(postSubagentPayloads[0].name).toBe("Security-аудитор");
    expect(postSubagentPayloads[0].unlockApi).toBe(true);
    expect(postSubagentPayloads[0].baseUrl).toBe("https://openrouter.ai/api/v1");

    // Проверяем редактирование существующего субагента с сохранением нового API-ключа
    const editButtons = screen.getAllByRole("button", { name: /Редактировать/i });
    fireEvent.click(editButtons[1]); // UI-архитектор (unlockApi: true)
    const keyInput = screen.getByPlaceholderText(/Сохранён на сервере/i);
    fireEvent.change(keyInput, { target: { value: "sk-new-secret-key" } });
    fireEvent.click(screen.getByRole("button", { name: /Сохранить изменения/i }));

    await waitFor(() => {
      expect(patchSubagentPayloads.length).toBe(1);
    });
    expect(patchSubagentPayloads[0].id).toBe(2);
    expect(patchSubagentPayloads[0].body.apiKey).toBe("sk-new-secret-key");
  });

  it("открывает изолированный чат субагента через onlyConversation=1 и отправляет сообщение по SSE", async () => {
    render(
      <SubagentsPanel
        settings={{ baseUrl: "http://127.0.0.1:8888/v1", model: "qwen3:8b" }}
        params={{}}
        trustLevel="verified"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Чаты \(1\)/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Чаты \(1\)/i }));

    await waitFor(() => {
      expect(screen.getByText("Форма входа проверена, ошибок нет.")).toBeTruthy();
    });
    expect(getSubagentsCalls.some((u) => u.includes("onlyConversation=1"))).toBe(true);

    const chatInput = screen.getByPlaceholderText(/Сообщение субагенту/i);
    fireEvent.change(chatInput, { target: { value: "Проверь ещё страницу настроек" } });
    fireEvent.click(screen.getByRole("button", { name: /Отправить/i }));

    await waitFor(() => {
      expect(screen.getByLabelText("Токены: 610")).toBeTruthy();
    });
  });

  it("переключает режим маршрутизации Линейно / По уровням и позволяет рисовать/удалять связи в дереве", async () => {
    render(
      <SubagentsPanel
        settings={{ baseUrl: "http://127.0.0.1:8888/v1", model: "qwen3:8b" }}
        params={{}}
        trustLevel="verified"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "По уровням" })).toBeTruthy();
    });

    // Переключаем режим на «По уровням»
    fireEvent.click(screen.getByRole("button", { name: "По уровням" }));
    await waitFor(() => {
      expect(patchRootPayloads.some((p) => p.routingMode === "layered")).toBe(true);
    });
    expect(screen.getByText("Режим: По уровням")).toBeTruthy();
    expect(screen.getByText(/Ур\.1 ·/)).toBeTruthy();
    expect(screen.getByText(/Ур\.2 ·/)).toBeTruthy();

    // Кликаем «Оркестратор» и соединяем его напрямую с «UI-архитектор»
    fireEvent.click(screen.getByRole("button", { name: "Оркестратор" }));
    fireEvent.click(screen.getByRole("button", { name: /Связать с субагентом/i }));
    fireEvent.click(screen.getByRole("button", { name: "Соединить с субагентом UI-архитектор" }));

    // Проверяем, что можно удалить ребро кнопкой «×» прямо на схеме
    const removeEdgeBtn = screen.getByRole("button", { name: "Удалить связь Оркестратор → QA-инженер" });
    fireEvent.click(removeEdgeBtn);

    fireEvent.click(screen.getByRole("button", { name: /Сохранить дерево/i }));
    await waitFor(() => {
      expect(putTreePayloads.length).toBe(1);
    });
    expect(putTreePayloads[0].routingMode).toBe("layered");
    const nodes = putTreePayloads[0].nodes as Array<{ id: number; orchestratorCanCall: boolean }>;
    expect(nodes.find((n) => n.id === 1)?.orchestratorCanCall).toBe(false);
    expect(nodes.find((n) => n.id === 2)?.orchestratorCanCall).toBe(true);
  });

  it("настраивает и сохраняет Агента-Надсмотрщика через PATCH /api/agent/subagents", async () => {
    render(
      <SubagentsPanel
        settings={{ baseUrl: "http://127.0.0.1:8888/v1", model: "qwen3:8b" }}
        params={{}}
        trustLevel="verified"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Надсмотрщик: строгий/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /^Надсмотрщик$/i }));
    expect(await screen.findByText(/Агент-Надсмотрщик \(Guard безопасности\)/i)).toBeTruthy();

    // Переключаем режим на «Только статические правила» и сохраняем
    fireEvent.change(screen.getByLabelText("Режим проверки Надсмотрщика"), {
      target: { value: "rules_only" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Сохранить Надсмотрщика/i }));

    await waitFor(() => {
      expect(patchRootPayloads.length).toBe(1);
    });
    const ov = patchRootPayloads[0].overseer as Record<string, unknown>;
    expect(ov.enabled).toBe(true);
    expect(ov.mode).toBe("rules_only");
  });

  it("в чате субагента показывает проверку Надсмотрщика и отправляет решение ApprovalToast", async () => {
    const encoder = new TextEncoder();
    const ctrlRef: { current: ReadableStreamDefaultController<Uint8Array> | null } = { current: null };
    sseResponder = () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          ctrlRef.current = controller;
          controller.enqueue(
            encoder.encode(`event: subagent_start\ndata: ${JSON.stringify({ subagentConversationId: 201 })}\n\n`),
          );
          controller.enqueue(
            encoder.encode(
              `event: overseer_start\ndata: ${JSON.stringify({ tool: "run_command", targetAgent: "QA-инженер" })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: overseer_reasoning\ndata: ${JSON.stringify({
                text: "Обнаружена попытка чтения .env",
                tool: "run_command",
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: approval_required\ndata: ${JSON.stringify({
                approvalId: "ov-sub-1",
                kind: "overseer_approval",
                title: "Надсмотрщик: запрос доступа к .env",
                description: "Субагент пытается выполнить cat ../.env",
                command: "cat ../.env",
                overseer: {
                  checkId: "chk1",
                  verdict: "require_human",
                  riskLevel: "critical",
                  title: "Чтение секретов",
                  reason: "Возможна утечка секретов хоста",
                  recommendation: "Отклоните действие",
                  requestedBy: "QA-инженер",
                  tool: "run_command",
                },
              })}\n\n`,
            ),
          );
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    render(
      <SubagentsPanel
        settings={{ baseUrl: "http://127.0.0.1:8888/v1", model: "qwen3:8b" }}
        params={{}}
        trustLevel="full"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Чаты \(1\)/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /Чаты \(1\)/i }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Сообщение субагенту/i)).toBeTruthy();
    });
    fireEvent.change(screen.getByPlaceholderText(/Сообщение субагенту/i), {
      target: { value: "Прочитай .env" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Отправить/i }));

    // Проверяем ApprovalToast от Надсмотрщика и живые рассуждения Надсмотрщика
    expect(await screen.findByText("Надсмотрщик: запрос доступа к .env")).toBeTruthy();
    expect(screen.getByText(/Возможна утечка секретов хоста/)).toBeTruthy();
    expect(screen.getByText(/Обнаружена попытка чтения \.env/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Отклонить$/i }));
    await waitFor(() => {
      expect(approvePayloads.length).toBe(1);
    });
    expect(approvePayloads[0].approvalId).toBe("ov-sub-1");
    expect(approvePayloads[0].approved).toBe(false);

    ctrlRef.current?.enqueue(
      encoder.encode(`event: overseer_done\ndata: ${JSON.stringify({ verdict: "require_human", riskLevel: "critical", tool: "run_command" })}\n\n`),
    );
    ctrlRef.current?.enqueue(
      encoder.encode(`event: subagent_done\ndata: ${JSON.stringify({ subagentConversationId: 201, usage: { prompt: 400, completion: 210, total: 610 } })}\n\n`),
    );
    ctrlRef.current?.close();
    await waitFor(() => {
      expect(screen.getByLabelText("Токены: 610")).toBeTruthy();
    });
  });
});
