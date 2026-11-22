import { getCurrentUser } from "@/lib/auth";
import {
  createAiChat,
  getAiChat,
  getAiQuotaOverride,
  getAiUsage,
  getAiUserSettingsSecret,
  getRagFolder,
  insertAiChatMessage,
  listRagChunks,
  recordAiUsage,
  renameAiChat,
  searchRagChunks,
  type AiChatRow,
} from "@/db/repo";
import { RAG_FULL_MAX_CHARS, formatFullRagContext, formatRagContext, ragBudgetChars, type FullRagContext } from "@/lib/rag";
import { aiPolicyFor, formatTokenCount, reasoningAllowed, type AiRolePolicy } from "@/lib/aiPolicy";
import {
  AI_DEFAULT_BASE_URL,
  AI_MAX_CONTEXT_MESSAGES,
  aiAuthHeaders,
  aiEndpoint,
  normalizeBaseUrl,
  normalizeParams,
  estimateTokens,
  type AiParams,
} from "@/lib/ai";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";
import { assertSafeAiUrl, safeAiFetch } from "@/lib/ssrf";
import { readJsonWithByteLimit } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Потолок на тело запроса: история + картинки в data-URL (сжимаем в браузере). */
const MAX_BODY_BYTES = 48 * 1024 * 1024;
/** Жёсткий серверный потолок даже для super_admin (защита от OOM DoS). */
const HARD_MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Сколько символов RAG-контекста максимум подмешиваем в обычном режиме (≈4–5k токенов). */
const MAX_RAG_CONTEXT_CHARS = 12_000;
/** Сколько токенов оставляем модели на ответ в режиме «вся база». */
const RAG_FULL_RESERVE_TOKENS = 1_024;
/** Страховка от «зависшего» локального сервера. */
const UPSTREAM_TIMEOUT_MS = 5 * 60 * 1000;

type AiMessage = { role: "system" | "user" | "assistant"; content: unknown };

type UsageTotals = { prompt: number; completion: number; total: number };

/** Оценка промпта, если сервер не вернул usage: по символам сообщений. */
function estimatePromptTokens(messages: AiMessage[]): number {
  let total = 4;
  for (const message of messages) {
    if (typeof message.content === "string") {
      total += estimateTokens(message.content) + 4;
      continue;
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content as Array<{ type?: string; text?: string }>) {
        if (part?.type === "text" && part.text) total += estimateTokens(part.text) + 3;
        if (part?.type === "image_url") total += 600;
      }
      total += 4;
    }
  }
  return total;
}

/** Текст последнего сообщения пользователя (для истории и авто-названия чата). */
function lastUserContent(messages: AiMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return (message.content as Array<{ type?: string; text?: string }>)
        .filter((part) => part?.type === "text" && part.text)
        .map((part) => part.text ?? "")
        .join("\n");
    }
    return "";
  }
  return "";
}

type UpstreamChunk = {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
};

/**
 * Тело запроса к локальному серверу: параметры генерации передаём только когда
 * они заданы — строгие сборки отвергают незнакомые поля, а не игнорируют их.
 */
function buildUpstreamBody(model: string, messages: AiMessage[], params: AiParams) {
  const body: Record<string, unknown> = { model, messages, stream: true };
  if (params.temperature !== null) body.temperature = params.temperature;
  if (params.topP !== null) body.top_p = params.topP;
  if (params.maxTokens !== null) body.max_tokens = params.maxTokens;
  if (params.seed !== null) body.seed = params.seed;

  // Некоторые сборки умеют отдавать usage прямо в потоке.
  if (params.streamUsage) body.stream_options = { include_usage: true };

  if (params.reasoning !== "default") {
    if (params.reasoning === "off") body.reasoning_effort = "none";
    else if (params.reasoning === "budget") {
      if (params.thinkingBudget) body.thinking_budget = params.thinkingBudget;
      body.reasoning_effort = "high";
    } else body.reasoning_effort = params.reasoning;

    if (params.sendThinkingFlag) {
      body.chat_template_kwargs = { enable_thinking: params.reasoning !== "off" };
    }
  }
  return body;
}

async function settingsFromRequest(req: Request, userId: number) {
  const saved = await getAiUserSettingsSecret(userId).catch(() => ({ baseUrl: "", model: "", apiKey: "" }));
  // SSRF-защита (P0-1): baseUrl и apiKey берутся только из серверных настроек пользователя или env,
  // клиентский заголовок x-ai-base полностью игнорируется.
  const baseUrl =
    normalizeBaseUrl(saved.baseUrl) ??
    normalizeBaseUrl(process.env.AI_BASE_URL ?? "") ??
    AI_DEFAULT_BASE_URL;
  const apiKey = (saved.apiKey ?? process.env.AI_API_KEY ?? "").trim();
  const model = (req.headers.get("x-ai-model") ?? saved.model ?? process.env.AI_MODEL ?? "").trim();
  return { baseUrl, apiKey, model };
}

/** Текст последнего сообщения пользователя — по нему ищем фрагменты RAG. */
function lastUserText(messages: AiMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return (message.content as Array<{ type?: string; text?: string }>)
        .filter((part) => part?.type === "text" && part.text)
        .map((part) => part.text ?? "")
        .join("\n");
    }
    return "";
  }
  return "";
}

/** Разбор одного SSE-события OpenAI: нужен только текст ответа. */
function readDelta(chunk: UpstreamChunk): string {
  const choice = chunk.choices?.[0];
  if (!choice) return "";
  const delta = choice.delta?.content ?? "";
  if (delta) return delta;
  // Некоторые локальные серверы присылают весь ответ в `message` даже при stream=true.
  return choice.message?.content ?? "";
}

/** «Размышления» модели: разные серверы называют их reasoning_content или reasoning. */
function readReasoning(chunk: UpstreamChunk): string {
  const choice = chunk.choices?.[0];
  return choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? choice?.message?.reasoning_content ?? "";
}

function adaptBodyOnContextOverflow(
  body: Record<string, unknown>,
  rawError: string,
): Record<string, unknown> | null {
  const lower = rawError.toLowerCase();
  const maxTokOnly =
    /(?:max_tokens|max_output_tokens|completion\s*tokens)/i.test(lower) &&
    /(?:at\s+most|must\s+be\s*<=|too\s+large|exceed|range|limit)/i.test(lower);
  const isOverflow =
    /maximum\s+context\s+length|context[_ ]length[_ ]exceeded|context\s+(?:window|limit|size)|available\s+context\s+size|prompt\s+is\s+too\s+long|too\s+many\s+tokens|reduce\s+the\s+length|in\s+the\s+messages.*in\s+the\s+completion/i.test(
      lower,
    );
  if (!isOverflow && !maxTokOnly) return null;

  const next: Record<string, unknown> = { ...body };
  const msgs = Array.isArray(body.messages) ? [...(body.messages as AiMessage[])] : [];
  next.messages = msgs;

  const firstInt = (patterns: RegExp[]): number | null => {
    for (const pat of patterns) {
      const m = rawError.match(pat);
      if (m?.[1]) {
        const parsed = Number(m[1].replace(/,/g, ""));
        if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
      }
    }
    return null;
  };

  if (maxTokOnly && !isOverflow) {
    const cap =
      firstInt([
        /supports\s+at\s+most\s+(\d[\d,]*)/i,
        /(?:max_tokens|max_output_tokens)\s*(?:must\s+be\s*<=?|cannot\s+exceed|limit\s*(?:is|:)?)\s*(\d[\d,]*)/i,
        /range\s*\[\s*\d+\s*,\s*(\d[\d,]*)\s*\]/i,
      ]) ?? (typeof next.max_tokens === "number" ? Math.max(1024, Math.floor(next.max_tokens / 2)) : 8192);
    if (typeof next.max_tokens === "number" && next.max_tokens > cap) {
      const clamped = Math.max(256, cap);
      next.max_tokens = clamped;
      if (typeof next.thinking_budget === "number" && next.thinking_budget >= clamped) {
        next.thinking_budget = Math.max(256, Math.floor(clamped / 2));
      }
      return next;
    }
    return null;
  }

  const maxCtx = firstInt([
    /maximum\s+context\s+length\s+is\s+(\d[\d,]*)/i,
    /context\s+(?:length|limit|window|size)\s*(?:is|of|:)?\s*(\d[\d,]*)/i,
    /available\s+context\s+size\s*\((\d[\d,]*)\s*tokens?\)/i,
  ]);
  const msgTokens = firstInt([
    /(\d[\d,]*)\s*in\s+the\s+messages/i,
    /messages\s+resulted\s+in\s+(\d[\d,]*)\s*tokens?/i,
    /prompt\s+is\s+too\s+long:\s*(\d[\d,]*)\s*tokens?/i,
  ]);

  let changed = false;
  if (maxCtx && msgTokens) {
    const margin = Math.max(256, Math.min(2048, Math.floor(maxCtx / 64)));
    const avail = maxCtx - msgTokens - margin;
    if (avail >= 1024 && typeof next.max_tokens === "number" && next.max_tokens > avail) {
      next.max_tokens = avail;
      if (typeof next.thinking_budget === "number" && next.thinking_budget >= avail) {
        next.thinking_budget = Math.max(256, Math.floor(avail / 2));
      }
      return next;
    }
  }

  if (typeof next.max_tokens === "number" && next.max_tokens > 4096) {
    const clamped = Math.max(2048, Math.floor(next.max_tokens / 3));
    next.max_tokens = clamped;
    if (typeof next.thinking_budget === "number" && next.thinking_budget >= clamped) {
      next.thinking_budget = Math.max(256, Math.floor(clamped / 2));
    }
    changed = true;
  }

  const estNow = estimatePromptTokens(msgs);
  const targetTokens = maxCtx
    ? Math.max(512, maxCtx - (typeof next.max_tokens === "number" ? next.max_tokens : 4096) - 1024)
    : Math.max(512, Math.floor(estNow * 0.65));

  const targetEst =
    msgTokens && msgTokens > estNow && estNow > 0
      ? Math.max(512, Math.floor(targetTokens * (estNow / msgTokens) * 0.9))
      : targetTokens;

  while (estimatePromptTokens(msgs) > targetEst) {
    const nonSysIdx = msgs.findIndex((m) => m.role !== "system");
    const nonSysCount = msgs.filter((m) => m.role !== "system").length;
    if (nonSysIdx >= 0 && nonSysCount > 1) {
      msgs.splice(nonSysIdx, 1);
      changed = true;
      continue;
    }
    const ragIdx = msgs.findIndex(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("(RAG)"),
    );
    if (ragIdx >= 0) {
      const content = String(msgs[ragIdx].content);
      const shrinkTo = Math.max(500, Math.floor(content.length * 0.6));
      if (shrinkTo < content.length) {
        msgs[ragIdx] = {
          role: "system",
          content: `${content.slice(0, shrinkTo)}\n...[RAG сокращён под лимит контекста модели]`,
        };
        changed = true;
        continue;
      }
    }
    break;
  }

  return changed ? next : null;
}

function describeUpstreamError(status: number, body: string): string {
  const trimmed = body.trim();
  const lower = body.toLowerCase();
  const contextOverflow = /context|too many tokens|maximum|token limit|out of memory|превыш/i.test(lower);
  const hint = contextOverflow
    ? " Похоже, контекст модели закончился: нажмите «Новый чат», чтобы начать с чистого счётчика, или уменьшите число фрагментов RAG."
    : status === 400 || status === 422
      ? " Если сервер не понимает параметры раздумий, выберите «По умолчанию» в блоке «Раздумья» или выключите chat_template_kwargs."
      : "";
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as UpstreamChunk;
      const message = parsed.error?.message;
      if (message) return `Локальный сервер ответил ${status}: ${message}${hint}`;
    } catch {
      /* не JSON — покажем как есть, но коротко */
    }
    return `Локальный сервер ответил ${status}: ${trimmed.slice(0, 300)}${hint}`;
  }
  return `Локальный сервер ответил ${status}`;
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const rl = checkApiRateLimit({
    scope: "ai_chat",
    userId: me.id,
    ip: extractClientIp(req.headers),
    maxRequests: 60,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const { baseUrl, apiKey, model } = await settingsFromRequest(req, me.id);
  try {
    await assertSafeAiUrl(baseUrl);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Запрещённый URL модели" },
      { status: 400 },
    );
  }
  if (!model) {
    return Response.json(
      { error: "Не указана модель. Впишите имя модели в настройках блока «Чат с ИИ»." },
      { status: 400 },
    );
  }

  let messages: AiMessage[];
  let params: AiParams = normalizeParams(null);
  let ragContext = "";
  let ragFolderId = 0;
  let ragQuery = "";
  let chatId = 0;
  let attachmentsJson = "[]";
  const unlimited = me.role === "super_admin";
  const parsedBody = await readJsonWithByteLimit<{
    messages?: AiMessage[];
    params?: unknown;
    ragContext?: unknown;
    ragFolderId?: unknown;
    ragQuery?: unknown;
    chatId?: unknown;
    attachments?: unknown;
  }>(req, unlimited ? HARD_MAX_BODY_BYTES : MAX_BODY_BYTES);
  if (!parsedBody.ok) return parsedBody.response;

  try {
    const body = parsedBody.data ?? {};
    params = normalizeParams(body.params, { unlimited });
    ragContext =
      typeof body.ragContext === "string"
        ? unlimited
          ? body.ragContext
          : body.ragContext.slice(0, MAX_RAG_CONTEXT_CHARS)
        : "";
    ragFolderId = Number(body.ragFolderId ?? 0) || 0;
    ragQuery =
      typeof body.ragQuery === "string"
        ? unlimited
          ? body.ragQuery
          : body.ragQuery.slice(0, 4000)
        : "";
    chatId = Number(body.chatId ?? 0) || 0;
    if (Array.isArray(body.attachments)) {
      const items = unlimited ? body.attachments : body.attachments.slice(0, 8);
      const serialized = JSON.stringify(
        items.map((item) => {
          const meta = (item ?? {}) as { name?: unknown; kind?: unknown; size?: unknown; note?: unknown };
          return {
            name: String(meta.name ?? "").slice(0, 200),
            kind: String(meta.kind ?? "text").slice(0, 20),
            size: Number(meta.size ?? 0) || 0,
            note: String(meta.note ?? "").slice(0, 200),
          };
        }),
      );
      attachmentsJson = unlimited ? serialized : serialized.slice(0, 4000);
    }
    messages = (body.messages ?? []).filter(
      (m) => m && (m.role === "user" || m.role === "assistant" || m.role === "system"),
    );
  } catch {
    return Response.json({ error: "Некорректный запрос" }, { status: 400 });
  }

  // ---- ограничения роли -------------------------------------------------
  const override = await getAiQuotaOverride(me.id);
  const policy: AiRolePolicy = aiPolicyFor(me.role, override?.monthlyLimit ?? null);

  // Роль может не разрешать выбранный режим: молча приводим к ближайшему
  // разрешённому (для менеджера/сотрудника это «коротко»), а не ломаем запрос.
  let reasoningDowngraded = false;
  if (!reasoningAllowed(policy, params.reasoning)) {
    reasoningDowngraded = true;
    params = {
      ...params,
      reasoning: policy.reasoning.includes("low") ? "low" : policy.reasoning[0],
      thinkingBudget: null,
    };
  }

  if (ragFolderId > 0 && !policy.rag) {
    return Response.json(
      { error: `RAG-папка недоступна для роли «${me.role}». Модель ответит без документов.` },
      { status: 403 },
    );
  }

  let chat: AiChatRow | null = null;
  if (chatId > 0) {
    chat = await getAiChat(me.id, chatId);
    if (!chat) return Response.json({ error: "Чат не найден" }, { status: 404 });
    if (policy.perChatTokens !== null && policy.perChatTokens > 0 && chat.tokensTotal >= policy.perChatTokens) {
      return Response.json(
        {
          error:
            `В этом чате закончился лимит токенов (${formatTokenCount(chat.tokensTotal)} из ` +
            `${formatTokenCount(policy.perChatTokens)}). Нажмите «Новый чат» — счётчик обнулится.`,
        },
        { status: 403 },
      );
    }
  } else {
    chat = await createAiChat(me.id);
    chatId = chat.id;
  }

  const monthUsage = await getAiUsage(me.id);
  if (policy.monthlyTokens !== null && monthUsage.month.total >= policy.monthlyTokens) {
    return Response.json(
      {
        error:
          `Месячный лимит токенов исчерпан (${formatTokenCount(monthUsage.month.total)} из ` +
          `${formatTokenCount(policy.monthlyTokens)}). Расширить лимит на этот месяц может администратор.`,
      },
      { status: 403 },
    );
  }

  const userMessage = lastUserContent(messages);

  // RAG: если выбрана сохранённая папка, ищем фрагменты по запросу пользователя.
  // В режиме «вся база» берём весь индекс и упираемся только в контекст модели.
  let ragHits = 0;
  let ragFull: (FullRagContext & { total: number; budgetChars: number; contextLimit: number }) | null = null;
  if (ragFolderId > 0 && (params.ragFull || params.ragChunks > 0) && !ragContext) {
    const folder = await getRagFolder(me.id, ragFolderId);
    if (folder) {
      const query = ragQuery.trim() || lastUserText(messages);
      if (params.ragFull) {
        const chunks = await listRagChunks(ragFolderId);
        if (chunks.length > 0) {
          // Сначала самое релевантное вопросу, потом остальное в документном
          // порядке: если контекст не резиновый, обрезка отрежет хвост, а не суть.
          const relevant = query ? await searchRagChunks(ragFolderId, query, chunks.length) : [];
          const seen = new Set<number>();
          const ordered: Array<{ id: number; path: string; text: string; score: number }> = [];
          for (const hit of relevant) {
            if (seen.has(hit.id)) continue;
            seen.add(hit.id);
            ordered.push(hit);
          }
          for (const chunk of chunks) {
            if (seen.has(chunk.id)) continue;
            seen.add(chunk.id);
            ordered.push({ ...chunk, score: 0 });
          }

          // Сколько уже занято: история без системного промпта + сам промпт + запас на ответ.
          const usedTokens =
            estimatePromptTokens(messages.filter((message) => message.role !== "system")) +
            (params.system.trim() ? estimateTokens(params.system) : 0);
          const completionReserve =
            params.contextLimit > 0
              ? Math.min(params.maxTokens ?? RAG_FULL_RESERVE_TOKENS, Math.max(1_024, Math.floor(params.contextLimit * 0.75)))
              : Math.min(params.maxTokens ?? RAG_FULL_RESERVE_TOKENS, 32_768);
          const safetyTokens =
            params.contextLimit > 0 ? Math.max(1_024, Math.floor(params.contextLimit * 0.08)) : 1_024;
          const budgetChars =
            params.contextLimit > 0
              ? ragBudgetChars(params.contextLimit, usedTokens, completionReserve + safetyTokens, unlimited)
              : RAG_FULL_MAX_CHARS;
          const packed = formatFullRagContext(ordered, budgetChars);
          if (packed.used > 0) {
            ragContext = packed.text;
            ragHits = packed.used;
            ragFull = { ...packed, total: ordered.length, budgetChars, contextLimit: params.contextLimit };
          }
        }
      } else if (query) {
        const hits = await searchRagChunks(ragFolderId, query, params.ragChunks);
        if (hits.length > 0) {
          const maxChars = unlimited
            ? Math.min(RAG_FULL_MAX_CHARS, Math.max(24_000, params.ragChunks * 2_400))
            : MAX_RAG_CONTEXT_CHARS;
          ragContext = formatRagContext(hits, maxChars);
          ragHits = hits.length;
        }
      }
    }
  }

  // Системный промпт и найденные фрагменты RAG — первыми сообщениями.
  const preamble: AiMessage[] = [];
  if (params.system.trim()) preamble.push({ role: "system", content: params.system.trim() });
  if (ragContext.trim()) {
    preamble.push({
      role: "system",
      content: `Контекст из папки, выбранной пользователем (RAG). Опирайся на него, но не выдумывай то, чего в нём нет:\n\n${ragContext.trim()}`,
    });
  }
  if (preamble.length > 0) messages = [...preamble, ...messages.filter((message) => message.role !== "system")];
  if (messages.length === 0) {
    return Response.json({ error: "Пустой запрос" }, { status: 400 });
  }
  const trimmed = unlimited ? messages : messages.slice(-AI_MAX_CONTEXT_MESSAGES);
  let estimatedPrompt = estimatePromptTokens(trimmed);

  /**
   * Фиксирует ход в базе: сообщения, расход токенов, счётчик чата.
   * Возвращает данные для финального SSE-события.
   */
  const finishTurn = async (answer: string, thinking: string, usage: UsageTotals | null) => {
    const prompt = usage && usage.prompt > 0 ? usage.prompt : estimatedPrompt;
    const completion = usage && usage.completion > 0 ? usage.completion : estimateTokens(answer);
    const total = usage && usage.total > 0 ? usage.total : prompt + completion;
    const summary = {
      usage: { prompt, completion, total, estimated: !usage },
      reasoningDowngraded,
      chat: null as (AiChatRow & { tokensLeft: number | null; tokensLimit: number | null }) | null,
      monthly: { used: 0, limit: policy.monthlyTokens, left: null as number | null },
    };
    try {
      if (userMessage.trim() || attachmentsJson !== "[]") {
        await insertAiChatMessage({ chatId, role: "user", content: userMessage, attachments: attachmentsJson });
      }
      if (answer.trim()) {
        await insertAiChatMessage({
          chatId,
          role: "assistant",
          content: answer,
          reasoning: thinking,
          tokens: total,
          promptTokens: prompt,
          completionTokens: completion,
        });
      }
      if (chat && chat.title === "Новый чат" && userMessage.trim()) {
        await renameAiChat(me.id, chatId, userMessage.trim().slice(0, 60));
      }
      const fresh = await recordAiUsage({ userId: me.id, chatId, prompt, completion });
      const perChatLimit = policy.perChatTokens !== null && policy.perChatTokens > 0 ? policy.perChatTokens : null;
      summary.chat = fresh.chat
        ? {
            ...fresh.chat,
            tokensLeft: perChatLimit === null ? null : Math.max(perChatLimit - fresh.chat.tokensTotal, 0),
            tokensLimit: perChatLimit,
          }
        : null;
      summary.monthly = {
        used: fresh.month.total,
        limit: policy.monthlyTokens,
        left: policy.monthlyTokens === null ? null : Math.max(policy.monthlyTokens - fresh.month.total, 0),
      };
    } catch {
      /* история не должна ломать ответ модели */
    }
    return summary;
  };

  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = typeof AbortSignal.any === "function" ? AbortSignal.any([req.signal, timeout]) : timeout;

  let currentBody = buildUpstreamBody(model, trimmed, params);
  let upstream: Response | null = null;
  let lastErrorBody = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      upstream = await safeAiFetch(aiEndpoint(baseUrl, "/chat/completions"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...aiAuthHeaders(apiKey) },
        body: JSON.stringify(currentBody),
        signal,
        cache: "no-store",
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return Response.json(
        {
          error:
            `Не удалось подключиться к ${baseUrl}. Проверьте, что локальный сервер запущен ` +
            `и адрес совпадает с baseURL (${reason}).`,
        },
        { status: 502 },
      );
    }
    if (upstream.ok) break;
    lastErrorBody = await upstream.text().catch(() => "");
    if (upstream.status !== 400 || attempt >= 2) break;
    const adapted = adaptBodyOnContextOverflow(currentBody, lastErrorBody);
    if (!adapted) break;
    currentBody = adapted;
    if (Array.isArray(currentBody.messages)) {
      estimatedPrompt = estimatePromptTokens(currentBody.messages as AiMessage[]);
    }
  }

  if (!upstream || !upstream.ok) {
    return Response.json(
      { error: describeUpstreamError(upstream?.status ?? 502, lastErrorBody) },
      { status: 502 },
    );
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const encoder = new TextEncoder();

  // Не-streaming ответ (некоторые сборки игнорируют stream: true) отдаём одним куском.
  if (!upstream.body || !contentType.includes("text/event-stream")) {
    const body = await upstream.text();
    let text = "";
    let usage: UsageTotals | null = null;
    let thinking = "";
    try {
      const parsed = JSON.parse(body) as UpstreamChunk;
      text = readDelta(parsed);
      thinking = readReasoning(parsed);
      if (parsed.usage) {
        usage = {
          prompt: parsed.usage.prompt_tokens ?? 0,
          completion: parsed.usage.completion_tokens ?? 0,
          total: parsed.usage.total_tokens ?? 0,
        };
      }
      if (!text) text = parsed.error?.message ?? "";
    } catch {
      text = body;
    }
    if (!text) {
      return Response.json({ error: describeUpstreamError(upstream.status, body) }, { status: 502 });
    }
    const summary = await finishTurn(text, thinking, usage);
    const single = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: text })}\n\n`));
        if (thinking) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ reasoning: thinking })}\n\n`));
        if (usage) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ usage: summary.usage })}\n\n`));
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ done: true, ragHits, ragFull, ...summary })}\n\n`),
        );
        controller.close();
      },
    });
    return sseResponse(single);
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const push = (payload: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      let answer = "";
      let thinking = "";
      let usage: UsageTotals | null = null;
      let recorded = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf("\n");
          while (index !== -1) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf("\n");
            if (!line || line.startsWith(":")) continue;
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const chunk = JSON.parse(payload) as UpstreamChunk;
              const delta = readDelta(chunk);
              if (delta) {
                answer += delta;
                push({ delta });
              }
              const reason = readReasoning(chunk);
              if (reason) {
                thinking += reason;
                push({ reasoning: reason });
              }
              if (chunk.usage && (chunk.usage.prompt_tokens || chunk.usage.completion_tokens)) {
                usage = {
                  prompt: chunk.usage.prompt_tokens ?? 0,
                  completion: chunk.usage.completion_tokens ?? 0,
                  total: chunk.usage.total_tokens ?? 0,
                };
                push({ usage });
              }
            } catch {
              /* служебные строки локальных серверов пропускаем */
            }
          }
        }
        recorded = true;
        push({ done: true, ragHits, ragFull, ...(await finishTurn(answer, thinking, usage)) });
      } catch (error) {
        push({ error: error instanceof Error ? error.message : "Поток прерван" });
        if (!recorded) {
          recorded = true;
          push({ done: true, ...(await finishTurn(answer, thinking, usage)) });
        } else {
          push({ done: true });
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* поток уже закрыт клиентом */
        }
      }
    },
    cancel() {
      void upstream.body?.cancel();
    },
  });

  return sseResponse(stream);
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Прокси не должны буферизовать поток.
      "X-Accel-Buffering": "no",
    },
  });
}
