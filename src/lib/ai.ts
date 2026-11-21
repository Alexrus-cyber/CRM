/**
 * Общие настройки «Чата с ИИ» — используются и в браузере (`AiChatClient`),
 * и в API-роутах (`/api/ai/*`).
 *
 * Блок тестовый: он разговаривает с любым OpenAI-совместимым сервером
 * (`/v1/chat/completions`), например Unsloth / llama.cpp / vLLM / LM Studio.
 * Адрес, ключ и модель вводятся прямо в интерфейсе и хранятся в localStorage;
 * если в интерфейсе пусто, берутся переменные окружения AI_BASE_URL,
 * AI_API_KEY и AI_MODEL.
 */

export type AiSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export const AI_DEFAULT_BASE_URL = "http://127.0.0.1:8888/v1";

export const AI_STORAGE_SETTINGS = "crm.ai.settings.v1";
export const AI_STORAGE_HISTORY = "crm.ai.history.v1";

/** Сколько вложений можно приложить к одному вопросу. */
export const AI_MAX_FILES = 4;
/**
 * Потолок на один файл. Тип не ограничиваем: текст, docx/xlsx/pptx, pdf, rtf
 * и картинки разбираются в браузере, остальное уходит метаданными.
 */
export const AI_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Сколько сообщений истории отправлять модели. */
export const AI_MAX_CONTEXT_MESSAGES = 30;
/** Максимум токенов генерации (`max_tokens` и `thinking_budget`): современные модели поддерживают до 384K вывода. */
export const AI_MAX_GENERATION_TOKENS = 384_000;

const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif|bmp)$/i;
const TEXT_MIME =
  /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript|x-ndjson|sql|csv|toml|graphql)|message\/http)/i;
const TEXT_EXT =
  /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ya?ml|xml|html?|css|js|jsx|ts|tsx|py|rb|go|java|kt|c|h|cpp|cs|php|sh|sql|ini|conf|env|toml)$/i;

export function isImageMime(mime: string): boolean {
  return IMAGE_MIME.test(mime);
}

export function isTextFile(mime: string, name: string): boolean {
  return TEXT_MIME.test(mime) || TEXT_EXT.test(name);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} КБ`;
  return `${Math.round(bytes / 104857.6) / 10} МБ`;
}

/**
 * Приводит адрес к виду `http(s)://host[:port]/path` без хвостового слэша.
 * Возвращает null, если это не http(s)-адрес: запрос уходит с сервера, и
 * произвольные схемы (`file:`, `gopher:`) ему ни к чему.
 */
export function normalizeBaseUrl(raw: string): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/** Нормализованный адрес + путь эндпоинта (`/chat/completions`). */
export function aiEndpoint(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl) ?? AI_DEFAULT_BASE_URL;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Заголовок Authorization: локальные серверы часто работают без ключа. */
export function aiAuthHeaders(apiKey: string): Record<string, string> {
  const key = (apiKey ?? "").trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/* ---------------------------- параметры генерации ------------------------- */

export type ReasoningMode = "default" | "off" | "low" | "medium" | "high" | "budget";

export type AiParams = {
  /** Системный промпт — уходит первым сообщением. */
  system: string;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  seed: number | null;
  /** Сколько «думать»: у разных серверов это reasoning_effort или enable_thinking. */
  reasoning: ReasoningMode;
  /** Свой бюджет раздумий в токенах (для режима «budget»). */
  thinkingBudget: number | null;
  /** Дублировать режим в chat_template_kwargs.enable_thinking (Qwen3/Unsloth). */
  sendThinkingFlag: boolean;
  /** Сколько фрагментов RAG подмешивать в контекст. */
  ragChunks: number;
  /**
   * «Вся база»: отправлять модели весь индекс папки, а не топ-N фрагментов.
   * Объём упирается только в контекст модели (`contextLimit`).
   */
  ragFull: boolean;
  /** Контекст модели в токенах: 0 — не следить за ним. */
  contextLimit: number;
  /** Просить у сервера usage в потоке (stream_options.include_usage). */
  streamUsage: boolean;
};

export const AI_DEFAULT_PARAMS: AiParams = {
  system: "Ты — ассистент внутри CRM. Отвечай кратко и по делу, на русском языке.",
  temperature: null,
  topP: null,
  maxTokens: null,
  seed: null,
  reasoning: "default",
  thinkingBudget: null,
  sendThinkingFlag: true,
  ragChunks: 6,
  ragFull: false,
  contextLimit: 8192,
  streamUsage: true,
};

export const AI_STORAGE_PARAMS = "crm.ai.params.v1";

export const AI_REASONING_MODES: Array<{ value: ReasoningMode; label: string; hint: string }> = [
  { value: "default", label: "По умолчанию", hint: "ничего не передаём — решает сервер и шаблон модели" },
  { value: "off", label: "Без раздумий", hint: "reasoning_effort: none, enable_thinking: false" },
  { value: "low", label: "Коротко", hint: "reasoning_effort: low" },
  { value: "medium", label: "Средне", hint: "reasoning_effort: medium" },
  { value: "high", label: "Глубоко", hint: "reasoning_effort: high" },
  { value: "budget", label: "Свой бюджет", hint: "thinking_budget — число токенов на размышления" },
];

/** Приводит «сырые» параметры из localStorage/тела запроса к безопасному виду. */
export function normalizeParams(raw: unknown): AiParams {
  const source = (raw ?? {}) as Partial<AiParams>;
  const num = (value: unknown, min: number, max: number): number | null => {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.min(Math.max(parsed, min), max);
  };
  const reasoning = AI_REASONING_MODES.some((mode) => mode.value === source.reasoning)
    ? (source.reasoning as ReasoningMode)
    : AI_DEFAULT_PARAMS.reasoning;
  return {
    system: typeof source.system === "string" ? source.system.slice(0, 8000) : AI_DEFAULT_PARAMS.system,
    temperature: num(source.temperature, 0, 2),
    topP: num(source.topP, 0, 1),
    maxTokens: num(source.maxTokens, 1, AI_MAX_GENERATION_TOKENS),
    seed: num(source.seed, 0, 2 ** 31),
    reasoning,
    thinkingBudget: num(source.thinkingBudget, 64, AI_MAX_GENERATION_TOKENS),
    sendThinkingFlag: source.sendThinkingFlag !== false,
    ragChunks: num(source.ragChunks, 0, 50) ?? AI_DEFAULT_PARAMS.ragChunks,
    ragFull: source.ragFull === true,
    contextLimit: num(source.contextLimit, 0, 1_000_000) ?? AI_DEFAULT_PARAMS.contextLimit,
    streamUsage: source.streamUsage !== false,
  };
}

/**
 * Грубая оценка токенов, когда сервер не вернул usage:
 * латиница ≈ 4 символа на токен, кириллица — примерно 2,5.
 */
export function estimateTokens(text: string): number {
  if (!text.trim()) return 0;
  const cyrillic = (text.match(/[А-Яа-яЁё]/g) ?? []).length;
  const rest = text.length - cyrillic;
  return Math.ceil(cyrillic / 2.5 + rest / 4);
}

/** Оценка токенов всего контекста: строки и массивы частей сообщений. */
export function estimateMessagesTokens(messages: Array<{ content: unknown }>): number {
  let total = 4; // служебные токены на ответ
  for (const message of messages) {
    if (typeof message.content === "string") {
      total += estimateTokens(message.content) + 4;
    } else if (Array.isArray(message.content)) {
      for (const part of message.content as Array<{ type?: string; text?: string; image_url?: { url?: string } }>) {
        if (part?.type === "text" && part.text) total += estimateTokens(part.text) + 3;
        // Картинка в vision-моделях обычно стоит 300–800 токенов в зависимости от размера.
        if (part?.type === "image_url") total += 600;
      }
      total += 4;
    }
  }
  return total;
}
