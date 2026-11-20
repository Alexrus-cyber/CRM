/**
 * Сборка команды запуска для `agent/desktop_operator.py`.
 *
 * Вынесено из компонента, чтобы команду можно было проверить без браузера и
 * чтобы пресеты провайдеров (адрес, модель, переменная с ключом) жили в одном
 * месте с подсказками интерфейса.
 */

export type OperatorProvider = {
  id: string;
  label: string;
  /** Переменная окружения, из которой бот берёт ключ для этого провайдера. */
  keyEnv: string;
  /** Модель по умолчанию — подставляется, если поле пустое. */
  defaultModel: string;
  /** OpenAI-совместимый адрес: нужен чату-планировщику (бот берёт свой из скрипта). */
  baseUrl: string;
  /** Нужен ли ключ: у локальной модели обычно нет. */
  needsKey: boolean;
  /** Модель по умолчанию понимает картинки (иначе бот кликает вслепую). */
  visionByDefault: boolean;
  /** Какую vision-модель предложить, если выбрана текстовая. */
  visionModel: string;
};

/**
 * Заведомо текстовые модели: картинку они не принимают и координаты
 * «придумывают». Список — только для подсказки в интерфейсе: настоящую
 * проверку делает бот при запуске (читает число с тестовой плашки), поэтому
 * новая vision-модель провайдера здесь ничего не блокирует.
 */
export const TEXT_ONLY_MODEL_HINTS = [
  "deepseek-chat",
  "deepseek-reasoner",
  "deepseek-v4-pro",
  "gpt-3.5",
  "llama-3.3",
  "mixtral",
];

export function looksTextOnlyModel(model: string): boolean {
  const value = (model || "").trim().toLowerCase();
  if (!value) return false;
  return TEXT_ONLY_MODEL_HINTS.some((hint) => value.includes(hint));
}

export const OPERATOR_PROVIDERS: OperatorProvider[] = [
  {
    id: "local",
    label: "Локальная модель (vLLM / LM Studio)",
    keyEnv: "OPERATOR_API_KEY",
    defaultModel: "",
    baseUrl: "http://127.0.0.1:8000/v1",
    needsKey: false,
    visionByDefault: true,
    visionModel: "Qwen/Qwen3-VL-8B-Instruct",
  },
  {
    id: "openai",
    label: "OpenAI API",
    keyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
    needsKey: true,
    visionByDefault: true,
    visionModel: "gpt-4o-mini",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    keyEnv: "OPENROUTER_API_KEY",
    defaultModel: "qwen/qwen2.5-vl-72b-instruct",
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    visionByDefault: true,
    visionModel: "qwen/qwen2.5-vl-72b-instruct",
  },
  {
    id: "groq",
    label: "Groq",
    keyEnv: "GROQ_API_KEY",
    defaultModel: "meta-llama/llama-4-scout-17b-16e-instruct",
    baseUrl: "https://api.groq.com/openai/v1",
    needsKey: true,
    visionByDefault: true,
    visionModel: "meta-llama/llama-4-scout-17b-16e-instruct",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    keyEnv: "DEEPSEEK_API_KEY",
    // У DeepSeek картинки понимает deepseek-flash; deepseek-chat — только текст.
    defaultModel: "deepseek-flash",
    baseUrl: "https://api.deepseek.com/v1",
    needsKey: true,
    visionByDefault: true,
    visionModel: "deepseek-flash",
  },
  {
    id: "together",
    label: "Together",
    keyEnv: "TOGETHER_API_KEY",
    defaultModel: "Qwen/Qwen2.5-VL-72B-Instruct-Turbo",
    baseUrl: "https://api.together.xyz/v1",
    needsKey: true,
    visionByDefault: true,
    visionModel: "Qwen/Qwen2.5-VL-72B-Instruct-Turbo",
  },
  {
    id: "mistral",
    label: "Mistral",
    keyEnv: "MISTRAL_API_KEY",
    defaultModel: "pixtral-12b-2409",
    baseUrl: "https://api.mistral.ai/v1",
    needsKey: true,
    visionByDefault: true,
    visionModel: "pixtral-12b-2409",
  },
];

export function findProvider(id: string): OperatorProvider {
  return OPERATOR_PROVIDERS.find((item) => item.id === id) ?? OPERATOR_PROVIDERS[0];
}

/** Адрес API провайдера для чата-планировщика. */
export function providerBaseUrl(providerId: string): string {
  return findProvider(providerId).baseUrl;
}

/** Имя переменной окружения с ключом для выбранного провайдера. */
export function keyEnvName(providerId: string): string {
  return findProvider(providerId).keyEnv;
}

import { genParamsFlags, type GenParams } from "./genParams";

export type CommandOptions = {
  provider: string;
  token?: string;
  model?: string;
  server?: string;
  apiKey?: string;
  /** `inline` — `--api-key`, `env` — строка `export …` (её добавляет интерфейс). */
  keyMode?: "inline" | "env";
  once?: boolean;
  dryRun?: boolean;
  assumeYes?: boolean;
  textOnly?: boolean;
  /** Раздумья и генерация с вкладки «Оператор» — передаются боту флагами. */
  gen?: GenParams;
  /** Проверять результат после каждого действия (по умолчанию да). */
  verifyActions?: boolean;
  /** Саморазбор при неудаче действия (по умолчанию да). */
  selfReflect?: boolean;
};

/** Команда запуска бота — ровно те флаги, которые понимает скрипт. */
export function buildOperatorCommand(options: CommandOptions): string {
  const parts = ["python3 agent/desktop_operator.py", options.once ? "--once" : "--watch"];

  parts.push("--token", (options.token ?? "").trim() || "<токен из шага 1>");
  parts.push("--provider", options.provider || "local");

  const model = (options.model ?? "").trim();
  if (model) parts.push("--model", model);

  const server = (options.server ?? "").trim().replace(/\/+$/, "");
  if (server && server !== "http://localhost:3000") parts.push("--server", server);

  const key = (options.apiKey ?? "").trim();
  if (key && options.keyMode !== "env") parts.push("--api-key", key);

  if (options.gen) parts.push(...genParamsFlags(options.gen));
  if (options.verifyActions === false) parts.push("--no-verify-actions");
  if (options.selfReflect === false) parts.push("--no-self-reflect");

  if (options.dryRun) parts.push("--dry-run");
  if (options.assumeYes) parts.push("--yes");
  if (options.textOnly) parts.push("--text-only");

  return parts.join(" ");
}

/** Строка `export DEEPSEEK_API_KEY=…` для режима переменной окружения. */
export function buildEnvLine(providerId: string, apiKey: string): string {
  const key = (apiKey ?? "").trim();
  if (!key) return "";
  return `export ${keyEnvName(providerId)}=${key}`;
}

/** Что скопировать в терминал целиком. */
export function buildCommandWithKey(options: CommandOptions): string {
  const command = buildOperatorCommand(options);
  if (options.keyMode !== "env") return command;
  const env = buildEnvLine(options.provider, options.apiKey ?? "");
  return env ? `${env}\n${command}` : command;
}
