import { aiAuthHeaders, aiEndpoint, normalizeBaseUrl, type ReasoningMode } from "@/lib/ai";
import { applyGenParams, normalizeGenParams, type GenParams } from "@/lib/genParams";
import { findTaskMode, type OperatorTaskMode } from "@/lib/operatorModes";

export type CoachInput = {
  agentUrl: string;
  taskPrompt: string;
  taskMode: OperatorTaskMode;
  step: number;
  phase?: "after_step" | "before_action";
  plannedAction?: unknown;
  aimPoint?: { x?: number; y?: number };
  lastAction?: unknown;
  lastResult?: string;
  observation?: string;
  userHint?: string;
  cursorContext?: string;
  cursorCrop?: string;
  repeatStreak?: number;
  failedChecks?: number;
  params?: Partial<GenParams> | null;
  history?: string[];
  screenshot?: string;
  settings?: { baseUrl?: string; apiKey?: string; model?: string };
};

export type CoachTunedMeta = {
  reasoning: ReasoningMode;
  temperature: number;
  stuckLevel: number;
  userReasoning: ReasoningMode;
  userTemperature: number | null;
};

export type CoachAdvice = {
  guidanceForOperator: string;
  adviceForUser: string;
  approved?: boolean;
  reason?: string;
  visionUsed?: boolean;
  tuned?: CoachTunedMeta;
  source: "agent" | "model" | "heuristic";
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Подбирает параметры рассуждений и температуры для Агента-советчика:
 * 1) Сначала учитывает пользовательские настройки (`params`),
 * 2) Затем Агент повышает качество: `reasoning` `medium` и выше, а `temperature`
 *    адаптивно растёт при зацикливании (`repeatStreak` / `failedChecks`).
 */
export function resolveAdaptiveCoachParams(
  userParams: Partial<GenParams> | null | undefined,
  opts: { repeatStreak?: number; failedChecks?: number; phase?: "after_step" | "before_action" } = {},
): { params: GenParams; meta: CoachTunedMeta } {
  const base = normalizeGenParams(userParams ?? {});
  const repeatStreak = Math.max(0, Number(opts.repeatStreak ?? 0) || 0);
  const failedChecks = Math.max(0, Number(opts.failedChecks ?? 0) || 0);
  const phase = opts.phase === "before_action" ? "before_action" : "after_step";
  const stuckLevel = Math.max(0, repeatStreak - 1, failedChecks);

  const userTemp = base.temperature;
  const baseTemp = userTemp !== null ? userTemp : 0.2;
  let effTemp = baseTemp;
  if (stuckLevel === 1) {
    effTemp = round2(Math.min(1.2, Math.max(baseTemp, baseTemp + 0.2)));
  } else if (stuckLevel === 2) {
    effTemp = round2(Math.min(1.25, Math.max(baseTemp + 0.35, 0.55)));
  } else if (stuckLevel >= 3) {
    effTemp = round2(Math.min(1.3, Math.max(baseTemp + 0.5, 0.75)));
  }

  const userReasoning = base.reasoning;
  let effReasoning: ReasoningMode = userReasoning;
  if (userReasoning === "default") {
    effReasoning = stuckLevel >= 1 || phase === "before_action" ? "high" : "medium";
  } else if (userReasoning === "medium") {
    effReasoning = stuckLevel >= 2 ? "high" : "medium";
  } else if (userReasoning === "off" || userReasoning === "low") {
    // Сначала стоит пользовательская настройка; при зацикливании Агент пробует усилить качество.
    if (stuckLevel >= 2) effReasoning = "high";
    else if (stuckLevel === 1) effReasoning = "medium";
    else effReasoning = userReasoning;
  }

  const minTokens =
    effReasoning === "medium" || effReasoning === "high" || effReasoning === "max" || effReasoning === "budget"
      ? 900
      : 600;
  const effMaxTokens = base.maxTokens !== null ? Math.max(minTokens, base.maxTokens) : minTokens;

  const params: GenParams = {
    ...base,
    reasoning: effReasoning,
    temperature: effTemp,
    maxTokens: effMaxTokens,
  };
  return {
    params,
    meta: {
      reasoning: effReasoning,
      temperature: effTemp,
      stuckLevel,
      userReasoning,
      userTemperature: userTemp,
    },
  };
}

function shortJson(val: unknown): string {
  if (!val) return "";
  if (typeof val === "string") return val.slice(0, 400);
  try {
    return JSON.stringify(val).slice(0, 400);
  } catch {
    return String(val).slice(0, 400);
  }
}

export async function requestAgentStepCoaching(input: CoachInput): Promise<CoachAdvice> {
  const modeMeta = findTaskMode(input.taskMode);
  const phase = input.phase === "before_action" ? "before_action" : "after_step";
  const actionStr = shortJson(phase === "before_action" ? input.plannedAction ?? input.lastAction : input.lastAction);
  const resultStr = String(input.lastResult ?? "").trim().slice(0, 400);
  const obsStr = String(input.observation ?? "").trim().slice(0, 400);
  const userHintStr = String(input.userHint ?? "").trim().slice(0, 400);
  const cursorCtxStr = String(input.cursorContext ?? "").trim().slice(0, 400);
  const repeatStreak = Math.max(0, Number(input.repeatStreak ?? 0) || 0);
  const failedChecks = Math.max(0, Number(input.failedChecks ?? 0) || 0);
  const { params: resolvedParams, meta: tunedMeta } = resolveAdaptiveCoachParams(input.params, {
    repeatStreak,
    failedChecks,
    phase,
  });

  // 1. Сначала пробуем обратиться напрямую к работающему процессу Агента (`agent/agent.py /coach`).
  try {
    const res = await fetch(`${input.agentUrl}/coach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskPrompt: input.taskPrompt,
        taskMode: input.taskMode,
        phase,
        step: input.step,
        ...(input.plannedAction !== undefined ? { plannedAction: input.plannedAction } : {}),
        ...(input.aimPoint ? { aimPoint: input.aimPoint } : {}),
        lastAction: input.lastAction ?? null,
        lastResult: resultStr,
        observation: obsStr,
        userHint: userHintStr,
        ...(cursorCtxStr ? { cursorContext: cursorCtxStr } : {}),
        ...(input.cursorCrop ? { cursorCrop: input.cursorCrop } : {}),
        repeatStreak,
        failedChecks,
        params: input.params ?? resolvedParams,
        history: (input.history ?? []).slice(-10),
        ...(input.screenshot ? { screenshot: input.screenshot } : {}),
        ...(input.settings ? { settings: input.settings } : {}),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        ok?: boolean;
        guidanceForOperator?: string;
        adviceForUser?: string;
        approved?: boolean;
        reason?: string;
        visionUsed?: boolean;
        tuned?: CoachTunedMeta;
        source?: string;
      };
      const forOp = String(data.guidanceForOperator ?? "").trim();
      const forUser = String(data.adviceForUser ?? "").trim();
      const reason = String(data.reason ?? "").trim();
      if (forOp && data.source !== "heuristic") {
        return {
          guidanceForOperator: forOp,
          adviceForUser: forUser || forOp,
          approved: data.approved !== undefined ? Boolean(data.approved) : true,
          reason: reason || undefined,
          visionUsed: data.visionUsed,
          tuned: data.tuned ?? tunedMeta,
          source: "agent",
        };
      }
    }
  } catch {
    /* Агент может быть не запущен — переключаемся на модель из настроек или эвристику */
  }

  // 2. Fallback: прямая подсказка через модель (если настроены baseUrl + model).
  const baseUrl = normalizeBaseUrl(input.settings?.baseUrl ?? process.env.AI_BASE_URL ?? "");
  const model = (input.settings?.model ?? process.env.AI_MODEL ?? "").trim();
  const apiKey = (input.settings?.apiKey ?? process.env.AI_API_KEY ?? "").trim();
  if (baseUrl && model) {
    try {
      const promptLines =
        phase === "before_action"
          ? [
              `Цель задачи: ${input.taskPrompt}`,
              `Режим Оператора: ${modeMeta.label} (${input.taskMode})`,
              `Шаг #${input.step}: Оператор ТОЛЬКО НАВЁЛ курсор и ещё не кликал / не вводил текст.`,
              ...(input.aimPoint ? [`Координаты наведения: (${input.aimPoint.x ?? "?"}, ${input.aimPoint.y ?? "?"})`] : []),
              ...(cursorCtxStr ? [`Признаки окружения и выделенной строки: ${cursorCtxStr}`] : []),
              ...(actionStr ? [`Задуманное действие: ${actionStr}`] : []),
              ...(obsStr ? [`Ожидаемая цель под курсором: ${obsStr}`] : []),
              ...(userHintStr ? [`Комментарий пользователя: ${userHintStr}`] : []),
              ...(input.history?.length ? [`Предыдущие шаги:\n${input.history.slice(-6).join("\n")}`] : []),
              ...(repeatStreak >= 2 || failedChecks >= 1
                ? [`Внимание: повторов=${repeatStreak}, неудач=${failedChecks} — при промахе предложи альтернативу (hotkey, key, scroll, launch_app или pc_command).`]
                : []),
              "Посмотри на выделенную строку/рамку, открытый прицел и увеличенную лупу ×2.5 на скриншоте: курсор точно на нужном элементе? Ответь строго JSON: " +
                '{"approved":true|false,"reason":"что в выделенной строке и почему да/нет","guidanceForOperator":"если false — куда перенавести или какую команду/клавишу выбрать; если true — подтверждение","adviceForUser":"короткий статус"}',
            ]
          : [
              `Цель задачи: ${input.taskPrompt}`,
              `Режим Оператора: ${modeMeta.label} (${input.taskMode})`,
              `Выполнен шаг #${input.step}`,
              ...(actionStr ? [`Действие Оператора: ${actionStr}`] : []),
              ...(resultStr ? [`Результат: ${resultStr}`] : []),
              ...(obsStr ? [`Что видно на экране: ${obsStr}`] : []),
              ...(cursorCtxStr ? [`Контекст курсора и окна: ${cursorCtxStr}`] : []),
              ...(userHintStr ? [`Комментарий пользователя: ${userHintStr}`] : []),
              ...(input.history?.length ? [`Предыдущие шаги:\n${input.history.slice(-6).join("\n")}`] : []),
              ...(repeatStreak >= 2 || failedChecks >= 1
                ? [`Обнаружено зацикливание/сбой (повторов=${repeatStreak}, неудач=${failedChecks}). Предложи смену тактики: горячие клавиши, pc_command, переключение окна.`]
                : []),
              'Ответь JSON: {"guidanceForOperator":"точная команда Оператору на следующий шаг","adviceForUser":"короткий понятный совет пользователю, что происходит и что делать дальше"}',
            ];

      const promptText = promptLines.join("\n");
      const hasMainImage = typeof input.screenshot === "string" && input.screenshot.startsWith("data:image/");
      const hasCropImage = typeof input.cursorCrop === "string" && input.cursorCrop.startsWith("data:image/");
      const hasImage = hasMainImage || hasCropImage;
      const sysPrompt =
        phase === "before_action"
          ? "Ты — наставник Оператора ПК. Перед кликом/двойным кликом/вводом текста Оператор навёл курсор, выделил строку и показал увеличенную лупу ×2.5 + признаки окна/элемента. Проверь наведение по окружению (не только по пикселям) и ответь строго JSON."
          : "Ты — наставник Оператора ПК. После КАЖДОГО выполненного действия подсказывай Оператору и пользователю, что делать дальше. Для режима «game» учитывай управление персонажем (WASD удержание, камеру, прыжок, взаимодействие); для ПК — контекст окна и полные возможности (pc_command, hotkey, key). Отвечай строго JSON.";

      let visionUsed = hasImage;
      const buildBody = (withImage: boolean, withReasoning: boolean) => {
        const imageParts: Array<{ type: "image_url"; image_url: { url: string } }> = [];
        if (withImage && hasMainImage && input.screenshot) {
          imageParts.push({ type: "image_url", image_url: { url: input.screenshot } });
        }
        if (withImage && hasCropImage && input.cursorCrop) {
          imageParts.push({ type: "image_url", image_url: { url: input.cursorCrop } });
        }
        const payload: Record<string, unknown> = {
          model,
          temperature: resolvedParams.temperature ?? 0.2,
          max_tokens: resolvedParams.maxTokens ?? 900,
          stream: false,
          messages: [
            { role: "system", content: sysPrompt },
            {
              role: "user",
              content:
                imageParts.length > 0
                  ? [{ type: "text", text: promptText }, ...imageParts]
                  : promptText,
            },
          ],
        };
        if (withReasoning) {
          applyGenParams(payload, resolvedParams);
        } else {
          const noReasoning: GenParams = { ...resolvedParams, reasoning: "default" };
          applyGenParams(payload, noReasoning);
        }
        return payload;
      };

      const callCoachLlm = async (withImage: boolean, withReasoning: boolean) =>
        fetch(aiEndpoint(baseUrl, "/chat/completions"), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...aiAuthHeaders(apiKey) },
          body: JSON.stringify(buildBody(withImage, withReasoning)),
          signal: AbortSignal.timeout(20_000),
        });

      let allowReasoning = true;
      let res = await callCoachLlm(hasImage, allowReasoning);
      if (!res.ok && (res.status === 400 || res.status === 422)) {
        const errText = (await res.clone().text().catch(() => "")).toLowerCase();
        if (/reasoning|thinking|chat_template|unknown|unsupported|extra/.test(errText)) {
          allowReasoning = false;
          res = await callCoachLlm(hasImage, false);
        }
      }
      if (!res.ok && hasImage) {
        visionUsed = false;
        res = await callCoachLlm(false, allowReasoning);
      }
      if (res.ok) {
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const raw = String(data.choices?.[0]?.message?.content ?? "").trim();
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as {
            guidanceForOperator?: string;
            adviceForUser?: string;
            approved?: boolean;
            reason?: string;
          };
          const reason = String(parsed.reason ?? "").trim();
          const forOp = String(parsed.guidanceForOperator ?? "").trim() || reason;
          const forUser = String(parsed.adviceForUser ?? "").trim() || reason;
          const approved = parsed.approved !== undefined ? Boolean(parsed.approved) : true;
          if (forOp || phase === "before_action") {
            return {
              guidanceForOperator: forOp || (approved ? "Наведение подтверждено." : "Курсор не на цели."),
              adviceForUser: forUser || forOp || "Наведение проверено.",
              approved,
              reason: reason || undefined,
              visionUsed,
              tuned: tunedMeta,
              source: "model",
            };
          }
        }
        if (raw) {
          return {
            guidanceForOperator: raw.slice(0, 400),
            adviceForUser: raw.slice(0, 400),
            approved: true,
            visionUsed,
            tuned: tunedMeta,
            source: "model",
          };
        }
      }
    } catch {
      /* переходим к эвристике */
    }
  }

  // 3. Детерминированная подсказка, если ни Агент, ни LLM не ответили.
  const baseObs = obsStr || resultStr || actionStr || `шаг ${input.step}`;
  if (phase === "before_action") {
    const advice = `Наведение перед «${baseObs.slice(0, 120)}» — передано на проверку Оператору.`;
    return {
      guidanceForOperator: advice,
      adviceForUser: advice,
      approved: true,
      visionUsed: false,
      tuned: tunedMeta,
      source: "heuristic",
    };
  }
  const modeHint =
    input.taskMode === "game"
      ? "Оцени свежий кадр игры: скорректируй камеру/направление (hold_key / move_mouse_rel) или нажми действие взаимодействия."
      : input.taskMode === "copilot"
        ? "Проверь изменение на экране после шага и выполни следующий пункт плана или подскажи пользователю."
        : "Оцени результат шага по экрану и переходи к следующему действию задачи.";
  const advice = `После «${baseObs.slice(0, 120)}»: ${modeHint}`;
  return {
    guidanceForOperator: advice,
    adviceForUser: advice,
    approved: true,
    visionUsed: false,
    tuned: tunedMeta,
    source: "heuristic",
  };
}
