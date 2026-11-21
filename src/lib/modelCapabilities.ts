/**
 * Динамическое определение возможностей модели (режимы раздумий, бюджет,
 * vision, tools, длина контекста) из метаданных OpenAI-совместимого API
 * (`/models`, `/models/{id}`, OpenRouter, Ollama `/api/show`, LM Studio)
 * с аккуратным резервом по семейству модели.
 */

import { AI_REASONING_MODES, type ReasoningMode } from "./ai";

export type ModelCapabilitiesSource =
  | "metadata"
  | "openrouter"
  | "lmstudio"
  | "ollama"
  | "heuristic"
  | "unknown";

export type ModelCapabilities = {
  model: string;
  source: ModelCapabilitiesSource;
  /** Поддерживает ли модель настройку раздумий вообще. */
  supportsReasoning: boolean;
  /** Допустимые режимы раздумий в порядке отображения в списке «Тип раздумий». */
  reasoningModes: ReasoningMode[];
  /** Сырые значения effort, пришедшие от сервера (если есть). */
  rawEfforts?: string[];
  /** Пояснения для конкретных режимов от модели/сервера. */
  reasoningLabels?: Partial<Record<ReasoningMode, string>>;
  supportsThinkingBudget: boolean;
  supportsEnableThinking: boolean;
  supportsVision: boolean | null;
  supportsTools: boolean | null;
  contextLength: number | null;
  maxOutputTokens: number | null;
  rawCapabilities: string[];
  note: string;
};

const ALL_REASONING_MODES: ReasoningMode[] = [
  "default",
  "off",
  "low",
  "medium",
  "high",
  "max",
  "budget",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asPositiveInt(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function mapEffortToken(token: string): ReasoningMode | null {
  const clean = token.trim().toLowerCase();
  if (!clean) return null;
  if (clean === "none" || clean === "off" || clean === "disabled" || clean === "false") return "off";
  if (clean === "minimal" || clean === "low") return "low";
  if (clean === "medium" || clean === "mid" || clean === "moderate") return "medium";
  if (clean === "high") return "high";
  if (clean === "max" || clean === "maximum" || clean === "xhigh" || clean === "ultra") return "max";
  if (clean === "budget" || clean === "thinking_budget") return "budget";
  return null;
}

function sortModes(modes: Iterable<ReasoningMode>): ReasoningMode[] {
  const set = new Set<ReasoningMode>(["default"]);
  for (const mode of modes) {
    if (ALL_REASONING_MODES.includes(mode)) set.add(mode);
  }
  return ALL_REASONING_MODES.filter((mode) => set.has(mode));
}

/**
 * Профиль по названию модели, когда сервер не вернул `supported_parameters`
 * или `capabilities` (например, классический OpenAI /v1/models или DeepSeek),
 * либо чтобы уточнить допустимые уровни усилий (например, наличие `max` или `off`).
 */
export function inferCapabilitiesFromModelName(modelId: string): ModelCapabilities {
  const clean = String(modelId || "").trim();
  const id = clean.toLowerCase();

  if (!id) {
    return {
      model: "",
      source: "unknown",
      supportsReasoning: true,
      reasoningModes: [...ALL_REASONING_MODES],
      supportsThinkingBudget: true,
      supportsEnableThinking: true,
      supportsVision: null,
      supportsTools: null,
      contextLength: null,
      maxOutputTokens: null,
      rawCapabilities: [],
      note: "Модель не выбрана — показаны все доступные режимы раздумий",
    };
  }

  // Claude 4.5 / 4.6 (поддерживают adaptive/effort до max + thinking_budget)
  if (
    /claude[-_/.\s]*(?:opus|sonnet)[-_.\s]*4[-_.](?:5|6)/i.test(id) ||
    /claude[-_/.]*4[-_.](?:5|6)[-_.\s]*(?:opus|sonnet)/i.test(id)
  ) {
    return {
      model: clean,
      source: "heuristic",
      supportsReasoning: true,
      reasoningModes: ["default", "off", "low", "medium", "high", "max", "budget"],
      supportsThinkingBudget: true,
      supportsEnableThinking: false,
      supportsVision: true,
      supportsTools: true,
      contextLength: 200_000,
      maxOutputTokens: null,
      rawCapabilities: ["reasoning", "effort:max", "thinking_budget", "vision", "tools"],
      note: "Claude 4.5/4.6: поддерживает уровни усилий до Max и бюджет токенов",
    };
  }

  // Claude 3.7 / 4.0 / 4.1 / Haiku 4.5
  if (/claude[-_/.\s]*(?:3[-_.]7|4|sonnet-4|opus-4|haiku-4)/i.test(id)) {
    return {
      model: clean,
      source: "heuristic",
      supportsReasoning: true,
      reasoningModes: ["default", "off", "low", "medium", "high", "budget"],
      supportsThinkingBudget: true,
      supportsEnableThinking: false,
      supportsVision: true,
      supportsTools: true,
      contextLength: 200_000,
      maxOutputTokens: null,
      rawCapabilities: ["reasoning", "thinking_budget", "vision", "tools"],
      note: "Claude 3.7/4: поддерживает режимы раздумий и thinking_budget",
    };
  }

  // OpenAI GPT-5.1+ / Pro / Codex / o3-pro (поддерживают от off/low до max/xhigh)
  if (/gpt-5\.[1-9]|gpt-5-pro|o3-pro|codex/i.test(id)) {
    return {
      model: clean,
      source: "heuristic",
      supportsReasoning: true,
      reasoningModes: ["default", "off", "low", "medium", "high", "max"],
      supportsThinkingBudget: false,
      supportsEnableThinking: false,
      supportsVision: true,
      supportsTools: true,
      contextLength: null,
      maxOutputTokens: null,
      rawCapabilities: ["reasoning", "effort:max", "vision", "tools"],
      note: "Модель поддерживает reasoning_effort от без раздумий до Max",
    };
  }

  // OpenAI o1 / o3 / o3-mini / o4-mini / базовый gpt-5 (low/medium/high, без off и budget)
  if (/(?:^|\/)(?:o1|o3|o4)(?:$|[-_.])/i.test(id) || /^gpt-5(?:$|-mini|-nano)/i.test(id) || /\/gpt-5(?:$|-mini|-nano)/i.test(id)) {
    return {
      model: clean,
      source: "heuristic",
      supportsReasoning: true,
      reasoningModes: ["default", "low", "medium", "high"],
      supportsThinkingBudget: false,
      supportsEnableThinking: false,
      supportsVision: !/o3-mini|o1-mini/i.test(id),
      supportsTools: true,
      contextLength: null,
      maxOutputTokens: null,
      rawCapabilities: ["reasoning", "tools"],
      note: "OpenAI o-серия / GPT-5: поддерживает уровни low, medium, high",
    };
  }

  // Gemini 2.5 / Gemini 3 / thinking
  if (/gemini[-_/.]*(?:2\.5|3)|gemini.*thinking/i.test(id)) {
    const canOff = /flash|2\.5|3/i.test(id);
    return {
      model: clean,
      source: "heuristic",
      supportsReasoning: true,
      reasoningModes: sortModes([
        ...(canOff ? (["off"] as ReasoningMode[]) : []),
        "low",
        "medium",
        "high",
        "max",
        "budget",
      ]),
      supportsThinkingBudget: true,
      supportsEnableThinking: false,
      supportsVision: true,
      supportsTools: true,
      contextLength: 1_000_000,
      maxOutputTokens: null,
      rawCapabilities: ["reasoning", "thinking_budget", "vision", "tools"],
      note: "Gemini 2.5/3: уровни раздумий (включая Max) и thinking_budget",
    };
  }

  // Qwen3 / Qwen3.5 / QwQ
  if (/qwen[-_.]?3|qwq/i.test(id)) {
    return {
      model: clean,
      source: "heuristic",
      supportsReasoning: true,
      reasoningModes: ["default", "off", "low", "medium", "high", "max", "budget"],
      supportsThinkingBudget: true,
      supportsEnableThinking: true,
      supportsVision: /-vl|vl-/i.test(id) ? true : null,
      supportsTools: true,
      contextLength: null,
      maxOutputTokens: null,
      rawCapabilities: ["reasoning", "enable_thinking", "thinking_budget", "tools"],
      note: "Qwen3/QwQ: поддерживает enable_thinking, уровни до Max и бюджет токенов",
    };
  }

  // DeepSeek R1 / Reasoner
  if (/deepseek[-_.]?r1|deepseek-reasoner/i.test(id)) {
    return {
      model: clean,
      source: "heuristic",
      supportsReasoning: true,
      reasoningModes: ["default", "low", "medium", "high", "max"],
      supportsThinkingBudget: false,
      supportsEnableThinking: true,
      supportsVision: false,
      supportsTools: true,
      contextLength: 128_000,
      maxOutputTokens: null,
      rawCapabilities: ["reasoning", "enable_thinking", "tools"],
      note: "DeepSeek R1/Reasoner: всегда думает, регулируется от low до Max",
    };
  }

  // DeepSeek V3.1 / V3.2 / Chat (тумблер enable_thinking + высокий режим)
  if (/deepseek[-_.]?(?:v3\.[1-9]|chat)/i.test(id)) {
    return {
      model: clean,
      source: "heuristic",
      supportsReasoning: true,
      reasoningModes: ["default", "off", "high", "max"],
      supportsThinkingBudget: false,
      supportsEnableThinking: true,
      supportsVision: false,
      supportsTools: true,
      contextLength: 128_000,
      maxOutputTokens: null,
      rawCapabilities: ["reasoning", "enable_thinking", "tools"],
      note: "DeepSeek V3+: переключатель раздумий (без раздумий / глубоко / Max)",
    };
  }

  // GLM-4.5+, GLM-Z1, Kimi-K2, MiniMax-M2, Grok-3-mini / Grok-4, Magistral, GPT-OSS, прочие thinking/reason модели
  if (/glm[-_.]?(?:4\.[5-9]|5|z1)|kimi[-_.]?k2|minimax[-_.]?m2|grok[-_.]?(?:3-mini|4)|magistral|gpt-oss|thinking|reason/i.test(id)) {
    return {
      model: clean,
      source: "heuristic",
      supportsReasoning: true,
      reasoningModes: ["default", "off", "low", "medium", "high", "max", "budget"],
      supportsThinkingBudget: /glm|kimi|minimax/i.test(id),
      supportsEnableThinking: true,
      supportsVision: /-vl|vision|grok-4|kimi-k2\.5/i.test(id) ? true : null,
      supportsTools: true,
      contextLength: null,
      maxOutputTokens: null,
      rawCapabilities: ["reasoning", "enable_thinking", "tools"],
      note: "Рассуждающая модель: поддерживает выбор глубины раздумий до Max",
    };
  }

  // Заведомо нерассуждающие семейства
  if (
    /(?:^|\/)(?:gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-3\.5|qwen2(?:\.5)?|llama-?3|llama-?4|mistral-large|pixtral|gemma-?[23]|phi-?[34]|deepseek-flash|deepseek-coder)/i.test(
      id,
    )
  ) {
    return {
      model: clean,
      source: "heuristic",
      supportsReasoning: false,
      reasoningModes: ["default"],
      supportsThinkingBudget: false,
      supportsEnableThinking: false,
      supportsVision: /4o|4\.1|vl|pixtral|scout|maverick|gemma-3/i.test(id) ? true : null,
      supportsTools: true,
      contextLength: null,
      maxOutputTokens: null,
      rawCapabilities: [],
      note: `Модель «${clean}» не поддерживает режим раздумий — используется обычный вывод`,
    };
  }

  return {
    model: clean,
    source: "unknown",
    supportsReasoning: true,
    reasoningModes: [...ALL_REASONING_MODES],
    supportsThinkingBudget: true,
    supportsEnableThinking: true,
    supportsVision: null,
    supportsTools: null,
    contextLength: null,
    maxOutputTokens: null,
    rawCapabilities: [],
    note: "Сервер не передал список возможностей этой модели — доступны все режимы раздумий",
  };
}

/**
 * Разбирает метаданные конкретной модели из OpenRouter / OpenAI / vLLM / LM Studio / Ollama.
 * Возвращает null, если в объекте нет никаких сведений о возможностях.
 */
export function extractCapabilitiesFromMetadata(
  modelId: string,
  meta?: Record<string, unknown> | null,
): ModelCapabilities | null {
  const clean = String(modelId || "").trim();
  const obj = asRecord(meta);
  if (!obj) return null;

  const heuristic = inferCapabilitiesFromModelName(clean);
  const rawCaps: string[] = [];

  // 1. Длина контекста и максимум токенов вывода
  const topProvider = asRecord(obj.top_provider);
  const arch = asRecord(obj.architecture);
  const metaNested = asRecord(obj.meta);
  const ollamaInfo = asRecord(obj.model_info);

  let contextLength =
    asPositiveInt(obj.context_length) ??
    asPositiveInt(obj.max_context_length) ??
    asPositiveInt(obj.max_model_len) ??
    asPositiveInt(topProvider?.context_length) ??
    asPositiveInt(metaNested?.n_ctx_train) ??
    null;

  if (!contextLength && ollamaInfo) {
    for (const [k, v] of Object.entries(ollamaInfo)) {
      if (k.endsWith(".context_length")) {
        contextLength = asPositiveInt(v);
        if (contextLength) break;
      }
    }
  }

  const maxOutputTokens =
    asPositiveInt(obj.max_output_tokens) ??
    asPositiveInt(obj.max_completion_tokens) ??
    asPositiveInt(topProvider?.max_completion_tokens) ??
    null;

  // 2. Vision & Tools
  let supportsVision: boolean | null = heuristic.supportsVision;
  let supportsTools: boolean | null = heuristic.supportsTools;

  const inputModalities = normalizeStringArray(arch?.input_modalities);
  if (inputModalities.length > 0) {
    supportsVision = inputModalities.some((m) => m.toLowerCase() === "image" || m.toLowerCase() === "video");
  }
  if (typeof obj.type === "string" && obj.type.toLowerCase() === "vlm") {
    supportsVision = true;
  }

  // 3. Явные списки усилий / supported_parameters / capabilities
  const explicitEffortsRaw = [
    ...normalizeStringArray(obj.supported_reasoning_efforts),
    ...normalizeStringArray(obj.reasoning_efforts),
    ...normalizeStringArray(obj.reasoning_effort_levels),
    ...normalizeStringArray(obj.supported_efforts),
    ...normalizeStringArray(asRecord(obj.reasoning)?.efforts),
    ...normalizeStringArray(asRecord(obj.thinking)?.efforts),
    ...normalizeStringArray(asRecord(obj.capabilities)?.reasoning_efforts),
  ];

  const supportedParams = normalizeStringArray(obj.supported_parameters).map((p) => p.toLowerCase());
  const capArray = normalizeStringArray(obj.capabilities).map((c) => c.toLowerCase());
  const capObj = asRecord(obj.capabilities);

  let source: ModelCapabilitiesSource = "metadata";
  if (supportedParams.length > 0) source = "openrouter";
  else if (ollamaInfo || capArray.includes("completion")) source = "ollama";
  else if (capObj || typeof obj.max_context_length === "number") source = "lmstudio";

  if (capArray.includes("vision") || capObj?.vision === true) {
    supportsVision = true;
    rawCaps.push("vision");
  }
  if (
    capArray.includes("tools") ||
    capArray.includes("tool_use") ||
    capObj?.trained_for_tool_use === true ||
    supportedParams.includes("tools")
  ) {
    supportsTools = true;
    rawCaps.push("tools");
  }
  if (supportedParams.length > 0) rawCaps.push(...supportedParams);
  if (capArray.length > 0) rawCaps.push(...capArray);

  const hasExplicitEfforts = explicitEffortsRaw.length > 0;
  const hasSupportedParams = supportedParams.length > 0;
  const hasCapList = capArray.length > 0 || capObj !== null;
  const hasThinkingParser = typeof obj.reasoning_parser === "string" && obj.reasoning_parser.trim().length > 0;

  // Если сервер прислал явные усилия (например ["low", "medium", "high", "xhigh"])
  if (hasExplicitEfforts) {
    const mapped = new Set<ReasoningMode>(["default"]);
    for (const token of explicitEffortsRaw) {
      const m = mapEffortToken(token);
      if (m) mapped.add(m);
    }
    const supportsBudget =
      supportedParams.some((p) => p.includes("budget")) ||
      mapped.has("budget") ||
      Boolean(asRecord(obj.thinking)?.budget_tokens);
    if (supportsBudget) mapped.add("budget");

    const modes = sortModes(mapped);
    return {
      model: clean,
      source,
      supportsReasoning: modes.some((m) => m !== "default" && m !== "off"),
      reasoningModes: modes,
      rawEfforts: explicitEffortsRaw,
      supportsThinkingBudget: supportsBudget,
      supportsEnableThinking: heuristic.supportsEnableThinking,
      supportsVision,
      supportsTools,
      contextLength: contextLength ?? heuristic.contextLength,
      maxOutputTokens: maxOutputTokens ?? heuristic.maxOutputTokens,
      rawCapabilities: Array.from(new Set([...rawCaps, ...explicitEffortsRaw.map((e) => `effort:${e}`)])),
      note: `Подтянуто из метаданных сервера (${explicitEffortsRaw.join(", ")})`,
    };
  }

  // Если сервер прислал supported_parameters (формат OpenRouter / совместимых прокси)
  if (hasSupportedParams) {
    const hasReasoningParam = supportedParams.some((p) =>
      ["reasoning", "include_reasoning", "reasoning_effort", "thinking"].includes(p),
    );
    const hasBudgetParam = supportedParams.some((p) =>
      ["thinking_budget", "budget_tokens", "max_thinking_tokens"].includes(p),
    );
    if (!hasReasoningParam && !hasBudgetParam && !hasThinkingParser) {
      return {
        model: clean,
        source,
        supportsReasoning: false,
        reasoningModes: ["default"],
        supportsThinkingBudget: false,
        supportsEnableThinking: false,
        supportsVision,
        supportsTools,
        contextLength: contextLength ?? heuristic.contextLength,
        maxOutputTokens: maxOutputTokens ?? heuristic.maxOutputTokens,
        rawCapabilities: Array.from(new Set(rawCaps)),
        note: `По данным сервера (${source}) модель не поддерживает параметры раздумий`,
      };
    }

    const baseModes = heuristic.source === "heuristic" && heuristic.supportsReasoning
      ? new Set<ReasoningMode>(heuristic.reasoningModes)
      : new Set<ReasoningMode>(ALL_REASONING_MODES);
    if (hasBudgetParam) baseModes.add("budget");
    const modes = sortModes(baseModes);
    return {
      model: clean,
      source,
      supportsReasoning: true,
      reasoningModes: modes,
      supportsThinkingBudget: hasBudgetParam || heuristic.supportsThinkingBudget,
      supportsEnableThinking: heuristic.supportsEnableThinking,
      supportsVision,
      supportsTools,
      contextLength: contextLength ?? heuristic.contextLength,
      maxOutputTokens: maxOutputTokens ?? heuristic.maxOutputTokens,
      rawCapabilities: Array.from(new Set(rawCaps)),
      note: `По данным сервера (${source}) модель поддерживает раздумья`,
    };
  }

  // Если Ollama / LM Studio прислали capabilities (список или объект)
  if (hasCapList) {
    const hasThinkingCap =
      capArray.includes("thinking") ||
      capArray.includes("reasoning") ||
      capObj?.reasoning === true;

    if (!hasThinkingCap && !hasThinkingParser) {
      return {
        model: clean,
        source,
        supportsReasoning: false,
        reasoningModes: ["default"],
        supportsThinkingBudget: false,
        supportsEnableThinking: false,
        supportsVision,
        supportsTools,
        contextLength: contextLength ?? heuristic.contextLength,
        maxOutputTokens: maxOutputTokens ?? heuristic.maxOutputTokens,
        rawCapabilities: Array.from(new Set(rawCaps)),
        note: `По данным ${source} у модели нет режима раздумий (capabilities без thinking/reasoning)`,
      };
    }

    const modes = heuristic.source === "heuristic" && heuristic.supportsReasoning
      ? heuristic.reasoningModes
      : [...ALL_REASONING_MODES];
    return {
      model: clean,
      source,
      supportsReasoning: true,
      reasoningModes: modes,
      supportsThinkingBudget: heuristic.supportsThinkingBudget,
      supportsEnableThinking: true,
      supportsVision,
      supportsTools,
      contextLength: contextLength ?? heuristic.contextLength,
      maxOutputTokens: maxOutputTokens ?? heuristic.maxOutputTokens,
      rawCapabilities: Array.from(new Set([...rawCaps, "thinking"])),
      note: `По данным ${source} модель поддерживает раздумья`,
    };
  }

  // Есть только длина контекста / reasoning_parser без списка параметров
  if (contextLength || maxOutputTokens || hasThinkingParser) {
    return {
      ...heuristic,
      source: hasThinkingParser ? "metadata" : heuristic.source,
      supportsReasoning: hasThinkingParser ? true : heuristic.supportsReasoning,
      reasoningModes:
        hasThinkingParser && !heuristic.supportsReasoning ? [...ALL_REASONING_MODES] : heuristic.reasoningModes,
      supportsVision,
      supportsTools,
      contextLength: contextLength ?? heuristic.contextLength,
      maxOutputTokens: maxOutputTokens ?? heuristic.maxOutputTokens,
      rawCapabilities: Array.from(new Set([...heuristic.rawCapabilities, ...rawCaps])),
    };
  }

  return null;
}

export function resolveModelCapabilities(
  modelId: string,
  meta?: Record<string, unknown> | null,
): ModelCapabilities {
  return extractCapabilitiesFromMetadata(modelId, meta) ?? inferCapabilitiesFromModelName(modelId);
}

export function pickCapabilitiesForModel(
  byModel: Record<string, ModelCapabilities> | null | undefined,
  modelId: string,
): ModelCapabilities {
  const clean = String(modelId || "").trim();
  if (clean && byModel) {
    if (byModel[clean]) return byModel[clean];
    const lower = clean.toLowerCase();
    const matchedKey = Object.keys(byModel).find((k) => k.toLowerCase() === lower);
    if (matchedKey) return byModel[matchedKey];
  }
  return inferCapabilitiesFromModelName(clean);
}

/**
 * Список вариантов для выпадающего списка «Тип раздумий» строго под возможности
 * выбранной модели (и при необходимости ограниченный политикой роли).
 */
export function buildReasoningOptions(
  capabilities: ModelCapabilities | null | undefined,
  allowedByRole?: ReasoningMode[],
): Array<{ value: ReasoningMode; label: string; hint: string }> {
  const modelModes =
    capabilities && capabilities.reasoningModes.length > 0
      ? capabilities.reasoningModes
      : ALL_REASONING_MODES;

  const allowedSet = allowedByRole ? new Set<ReasoningMode>(allowedByRole) : null;
  const filteredModes = allowedSet
    ? modelModes.filter((mode) => allowedSet.has(mode))
    : modelModes;

  const finalModes =
    filteredModes.length > 0
      ? filteredModes
      : allowedByRole && allowedByRole.length > 0
        ? [allowedByRole[0]]
        : (["default"] as ReasoningMode[]);

  return finalModes.map((mode) => {
    const base = AI_REASONING_MODES.find((item) => item.value === mode)!;
    const extraLabel = capabilities?.reasoningLabels?.[mode];
    const hint =
      mode === "default" && capabilities && !capabilities.supportsReasoning
        ? capabilities.note
        : extraLabel
          ? `${base.hint} · ${extraLabel}`
          : base.hint;
    return { value: base.value, label: base.label, hint };
  });
}
