/**
 * Раздумья и параметры генерации для «Агента» и «Оператора».
 *
 * В обычном чате эти настройки живут в `AiParams` (там же RAG, контекст и
 * системный промпт). Агентам нужен тот же набор «ручек», но без лишнего,
 * поэтому здесь отдельный компактный тип и общие функции:
 *
 * * `applyGenParams()` — добавляет поля в тело `/chat/completions`
 *   (и в Next.js-прокси, и в Python-бот через проброс `params`);
 * * `genParamsFlags()` — превращает настройки во флаги `desktop_operator.py`;
 *   ключ модели при этом по-прежнему остаётся у пользователя в браузере.
 */

import { AI_MAX_GENERATION_TOKENS, AI_REASONING_MODES, type ReasoningMode } from "./ai";

export type GenParams = {
  /** Сколько «думать»: reasoning_effort у OpenAI-совместимых серверов. */
  reasoning: ReasoningMode;
  /** Бюджет раздумий в токенах — только для режима «budget». */
  thinkingBudget: number | null;
  /** Дублировать режим в chat_template_kwargs.enable_thinking (Qwen3/Unsloth). */
  sendThinkingFlag: boolean;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  seed: number | null;
};

export const GEN_DEFAULT_PARAMS: GenParams = {
  reasoning: "default",
  thinkingBudget: null,
  sendThinkingFlag: true,
  temperature: null,
  topP: null,
  maxTokens: null,
  seed: null,
};

/** Предел шагов агента и оператора для всех ролей, кроме главного администратора. */
export const AGENT_MAX_STEPS = 500;
/** Жёсткий потолок при расширении лимита шагов «на месте» (кроме главного администратора). */
export const OPERATOR_MAX_EXTEND_STEPS = 2000;

export function isUnlimitedStepsRole(role: string | null | undefined): boolean {
  return role === "super_admin";
}

export function maxStepsCapForRole(role: string | null | undefined): number | null {
  return isUnlimitedStepsRole(role) ? null : AGENT_MAX_STEPS;
}

/**
 * Нормализует лимит шагов в зависимости от роли пользователя:
 * - у главного администратора (`super_admin`) лимита нет: `0` означает «без лимита»,
 *   а любое положительное число (`>= 1`) принимается без потолка 500/2000;
 * - у всех остальных ролей (включая обычных `admin`) предел строго 500 шагов.
 */
export function resolveStepsForRole(
  role: string | null | undefined,
  raw: unknown,
  fallback: number,
): number {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (isUnlimitedStepsRole(role)) {
    if (raw === 0 || raw === "0" || raw === null) return 0;
    if (!Number.isFinite(parsed)) return fallback <= 0 ? 0 : Math.floor(fallback);
    return parsed <= 0 ? 0 : Math.floor(parsed);
  }
  const safeFallback = Math.min(AGENT_MAX_STEPS, Math.max(1, Math.floor(fallback) || 15));
  if (!Number.isFinite(parsed) || parsed <= 0) return safeFallback;
  return Math.min(AGENT_MAX_STEPS, Math.max(1, Math.floor(parsed)));
}

export type NormalizeGenParamsOptions = {
  /** Снять потолок maxTokens/thinkingBudget для Главного администратора (`super_admin`). */
  unlimited?: boolean;
};

export function normalizeGenParams(raw: unknown, options: NormalizeGenParamsOptions = {}): GenParams {
  const source = (raw ?? {}) as Partial<GenParams>;
  const unlimited = options.unlimited === true;
  const maxGen = unlimited ? Number.MAX_SAFE_INTEGER : AI_MAX_GENERATION_TOKENS;
  const num = (value: unknown, min: number, max: number): number | null => {
    const parsed = typeof value === "number" ? value : Number(value);
    if (value === null || value === undefined || value === "" || !Number.isFinite(parsed)) return null;
    return Math.min(Math.max(parsed, min), max);
  };
  const reasoning = AI_REASONING_MODES.some((mode) => mode.value === source.reasoning)
    ? (source.reasoning as ReasoningMode)
    : GEN_DEFAULT_PARAMS.reasoning;
  return {
    reasoning,
    thinkingBudget: num(source.thinkingBudget, unlimited ? 1 : 64, maxGen),
    sendThinkingFlag: source.sendThinkingFlag !== false,
    temperature: num(source.temperature, 0, 2),
    topP: num(source.topP, 0, 1),
    maxTokens: num(source.maxTokens, 1, maxGen),
    seed: num(source.seed, 0, 2 ** 31),
  };
}

/**
 * Разбор значения из localStorage.
 *
 * `useStoredJson` отдаёт в `decode` **строку** JSON, а `normalizeGenParams`
 * ждёт объект. Без `JSON.parse` настройки каждый раз «сбрасывались» в
 * значения по умолчанию — интерфейс выглядел неактивным.
 */
export function decodeGenParams(raw: string, options: NormalizeGenParamsOptions = {}): GenParams {
  try {
    return normalizeGenParams(JSON.parse(raw), options);
  } catch {
    return { ...GEN_DEFAULT_PARAMS };
  }
}

/**
 * Поля для `/chat/completions`. Передаём только заданное: строгие сборки
 * отвергают незнакомые параметры, а не игнорируют их.
 */
export function applyGenParams(
  body: Record<string, unknown>,
  params: GenParams,
  options: NormalizeGenParamsOptions = {},
): void {
  const normalized = normalizeGenParams(params, options);
  if (normalized.temperature !== null) body.temperature = normalized.temperature;
  if (normalized.topP !== null) body.top_p = normalized.topP;
  if (normalized.maxTokens !== null) body.max_tokens = normalized.maxTokens;
  if (normalized.seed !== null) body.seed = normalized.seed;

  if (normalized.reasoning !== "default") {
    if (normalized.reasoning === "off") body.reasoning_effort = "none";
    else if (normalized.reasoning === "budget") {
      if (normalized.thinkingBudget) body.thinking_budget = normalized.thinkingBudget;
      body.reasoning_effort = "high";
    } else body.reasoning_effort = normalized.reasoning;

    if (normalized.sendThinkingFlag) {
      body.chat_template_kwargs = { enable_thinking: normalized.reasoning !== "off" };
    }
  }
}

/** Короткая подпись для плашки в интерфейсе. */
export function describeGenParams(params: GenParams): string {
  const normalized = normalizeGenParams(params);
  const parts: string[] = [];
  const mode = AI_REASONING_MODES.find((item) => item.value === normalized.reasoning);
  if (normalized.reasoning !== "default" && mode) parts.push(`раздумья: ${mode.label.toLowerCase()}`);
  if (normalized.reasoning === "budget" && normalized.thinkingBudget) {
    parts.push(`${normalized.thinkingBudget} ток.`);
  }
  if (normalized.temperature !== null) parts.push(`temp ${normalized.temperature}`);
  if (normalized.topP !== null) parts.push(`top_p ${normalized.topP}`);
  if (normalized.maxTokens !== null) parts.push(`max ${normalized.maxTokens}`);
  return parts.length > 0 ? parts.join(" · ") : "по умолчанию";
}

/** Флаги для `agent/desktop_operator.py`: те же настройки, но в терминале. */
export function genParamsFlags(params: GenParams): string[] {
  const normalized = normalizeGenParams(params);
  const flags: string[] = [];
  if (normalized.temperature !== null) flags.push("--temperature", String(normalized.temperature));
  if (normalized.topP !== null) flags.push("--top-p", String(normalized.topP));
  if (normalized.maxTokens !== null) flags.push("--max-tokens", String(normalized.maxTokens));
  if (normalized.seed !== null) flags.push("--seed", String(normalized.seed));
  if (normalized.reasoning !== "default") {
    flags.push("--reasoning", normalized.reasoning);
    if (normalized.reasoning === "budget" && normalized.thinkingBudget) {
      flags.push("--thinking-budget", String(normalized.thinkingBudget));
    }
    if (!normalized.sendThinkingFlag) flags.push("--no-thinking-flag");
  }
  return flags;
}
