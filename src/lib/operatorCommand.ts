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
  /** Нужен ли ключ: у локальной модели обычно нет. */
  needsKey: boolean;
};

export const OPERATOR_PROVIDERS: OperatorProvider[] = [
  {
    id: "local",
    label: "Локальная модель (vLLM / LM Studio)",
    keyEnv: "OPERATOR_API_KEY",
    defaultModel: "",
    needsKey: false,
  },
  {
    id: "openai",
    label: "OpenAI API",
    keyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4o-mini",
    needsKey: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    keyEnv: "OPENROUTER_API_KEY",
    defaultModel: "qwen/qwen2.5-vl-72b-instruct",
    needsKey: true,
  },
  {
    id: "groq",
    label: "Groq",
    keyEnv: "GROQ_API_KEY",
    defaultModel: "meta-llama/llama-4-scout-17b-16e-instruct",
    needsKey: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    keyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
    needsKey: true,
  },
  {
    id: "together",
    label: "Together",
    keyEnv: "TOGETHER_API_KEY",
    defaultModel: "Qwen/Qwen2.5-VL-72B-Instruct-Turbo",
    needsKey: true,
  },
  {
    id: "mistral",
    label: "Mistral",
    keyEnv: "MISTRAL_API_KEY",
    defaultModel: "pixtral-12b-2409",
    needsKey: true,
  },
];

export function findProvider(id: string): OperatorProvider {
  return OPERATOR_PROVIDERS.find((item) => item.id === id) ?? OPERATOR_PROVIDERS[0];
}

/** Имя переменной окружения с ключом для выбранного провайдера. */
export function keyEnvName(providerId: string): string {
  return findProvider(providerId).keyEnv;
}

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
