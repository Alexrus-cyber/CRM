import { getCurrentUser } from "@/lib/auth";
import {
  AI_DEFAULT_BASE_URL,
  AI_MAX_CONTEXT_MESSAGES,
  aiAuthHeaders,
  aiEndpoint,
  normalizeBaseUrl,
  normalizeParams,
  type AiParams,
} from "@/lib/ai";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Потолок на тело запроса: история + картинки в data-URL. */
const MAX_BODY_BYTES = 12 * 1024 * 1024;
/** Страховка от «зависшего» локального сервера. */
const UPSTREAM_TIMEOUT_MS = 5 * 60 * 1000;

type AiMessage = { role: "system" | "user" | "assistant"; content: unknown };

type UpstreamChunk = {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
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

function settingsFromRequest(req: Request) {
  const headerBase = req.headers.get("x-ai-base") ?? "";
  const baseUrl =
    normalizeBaseUrl(headerBase) ??
    normalizeBaseUrl(process.env.AI_BASE_URL ?? "") ??
    AI_DEFAULT_BASE_URL;
  const apiKey = (req.headers.get("x-ai-key") ?? process.env.AI_API_KEY ?? "").trim();
  const model = (req.headers.get("x-ai-model") ?? process.env.AI_MODEL ?? "").trim();
  return { baseUrl, apiKey, model };
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

function describeUpstreamError(status: number, body: string): string {
  const trimmed = body.trim();
  const hint =
    status === 400 || status === 422
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

  const { baseUrl, apiKey, model } = settingsFromRequest(req);
  if (!model) {
    return Response.json(
      { error: "Не указана модель. Впишите имя модели в настройках блока «Чат с ИИ»." },
      { status: 400 },
    );
  }

  let messages: AiMessage[];
  let params: AiParams = normalizeParams(null);
  let ragContext = "";
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) {
      return Response.json({ error: "Слишком большой запрос: уменьшите вложение" }, { status: 413 });
    }
    const body = JSON.parse(raw) as { messages?: AiMessage[]; params?: unknown; ragContext?: unknown };
    params = normalizeParams(body.params);
    ragContext = typeof body.ragContext === "string" ? body.ragContext.slice(0, 12_000) : "";
    messages = (body.messages ?? []).filter(
      (m) => m && (m.role === "user" || m.role === "assistant" || m.role === "system"),
    );
  } catch {
    return Response.json({ error: "Некорректный запрос" }, { status: 400 });
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
  const trimmed = messages.slice(-AI_MAX_CONTEXT_MESSAGES);

  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = typeof AbortSignal.any === "function" ? AbortSignal.any([req.signal, timeout]) : timeout;

  let upstream: Response;
  try {
    upstream = await fetch(aiEndpoint(baseUrl, "/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...aiAuthHeaders(apiKey) },
      body: JSON.stringify(buildUpstreamBody(model, trimmed, params)),
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

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "");
    return Response.json({ error: describeUpstreamError(upstream.status, body) }, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const encoder = new TextEncoder();

  // Не-streaming ответ (некоторые сборки игнорируют stream: true) отдаём одним куском.
  if (!upstream.body || !contentType.includes("text/event-stream")) {
    const body = await upstream.text();
    let text = "";
    try {
      const parsed = JSON.parse(body) as UpstreamChunk;
      text = readDelta(parsed);
      if (!text) text = parsed.error?.message ?? "";
    } catch {
      text = body;
    }
    if (!text) {
      return Response.json({ error: describeUpstreamError(upstream.status, body) }, { status: 502 });
    }
    const single = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: text })}\n\n`));
        controller.enqueue(encoder.encode(`data: {"done":true}\n\n`));
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
              if (delta) push({ delta });
              const thinking = readReasoning(chunk);
              if (thinking) push({ reasoning: thinking });
            } catch {
              /* служебные строки локальных серверов пропускаем */
            }
          }
        }
        push({ done: true });
      } catch (error) {
        push({ error: error instanceof Error ? error.message : "Поток прерван" });
        push({ done: true });
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
