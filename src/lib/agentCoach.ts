import { aiAuthHeaders, aiEndpoint, normalizeBaseUrl } from "@/lib/ai";
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
  history?: string[];
  screenshot?: string;
  settings?: { baseUrl?: string; apiKey?: string; model?: string };
};

export type CoachAdvice = {
  guidanceForOperator: string;
  adviceForUser: string;
  approved?: boolean;
  reason?: string;
  visionUsed?: boolean;
  source: "agent" | "model" | "heuristic";
};

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
              ...(actionStr ? [`Задуманное действие: ${actionStr}`] : []),
              ...(obsStr ? [`Ожидаемая цель под курсором: ${obsStr}`] : []),
              ...(userHintStr ? [`Комментарий пользователя: ${userHintStr}`] : []),
              ...(input.history?.length ? [`Предыдущие шаги:\n${input.history.slice(-6).join("\n")}`] : []),
              "Посмотри на красный крестик курсора на скриншоте: он точно на нужном элементе? Ответь строго JSON: " +
                '{"approved":true|false,"reason":"что под крестиком и почему да/нет","guidanceForOperator":"если false — куда перенавести; если true — подтверждение","adviceForUser":"короткий статус"}',
            ]
          : [
              `Цель задачи: ${input.taskPrompt}`,
              `Режим Оператора: ${modeMeta.label} (${input.taskMode})`,
              `Выполнен шаг #${input.step}`,
              ...(actionStr ? [`Действие Оператора: ${actionStr}`] : []),
              ...(resultStr ? [`Результат: ${resultStr}`] : []),
              ...(obsStr ? [`Что видно на экране: ${obsStr}`] : []),
              ...(userHintStr ? [`Комментарий пользователя: ${userHintStr}`] : []),
              ...(input.history?.length ? [`Предыдущие шаги:\n${input.history.slice(-6).join("\n")}`] : []),
              'Ответь JSON: {"guidanceForOperator":"точная команда Оператору на следующий шаг","adviceForUser":"короткий понятный совет пользователю, что происходит и что делать дальше"}',
            ];

      const promptText = promptLines.join("\n");
      const hasImage = typeof input.screenshot === "string" && input.screenshot.startsWith("data:image/");
      const sysPrompt =
        phase === "before_action"
          ? "Ты — наставник Оператора ПК. Перед кликом/двойным кликом/вводом текста Оператор навёл курсор (красный крестик) и советуется с тобой. Проверь наведение и ответь строго JSON."
          : "Ты — наставник Оператора ПК. После КАЖДОГО выполненного действия подсказывай Оператору и пользователю, что делать дальше. Для режима «game» учитывай управление персонажем (WASD удержание, камеру, прыжок, взаимодействие). Отвечай строго JSON.";

      let visionUsed = hasImage;
      const callCoachLlm = async (withImage: boolean) =>
        fetch(aiEndpoint(baseUrl, "/chat/completions"), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...aiAuthHeaders(apiKey) },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: 550,
            stream: false,
            messages: [
              { role: "system", content: sysPrompt },
              {
                role: "user",
                content:
                  withImage && hasImage
                    ? [
                        { type: "text", text: promptText },
                        { type: "image_url", image_url: { url: input.screenshot } },
                      ]
                    : promptText,
              },
            ],
          }),
          signal: AbortSignal.timeout(20_000),
        });

      let res = await callCoachLlm(hasImage);
      if (!res.ok && hasImage) {
        visionUsed = false;
        res = await callCoachLlm(false);
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
    source: "heuristic",
  };
}
