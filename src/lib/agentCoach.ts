import { aiAuthHeaders, aiEndpoint, normalizeBaseUrl } from "@/lib/ai";
import { findTaskMode, type OperatorTaskMode } from "@/lib/operatorModes";

export type CoachInput = {
  agentUrl: string;
  taskPrompt: string;
  taskMode: OperatorTaskMode;
  step: number;
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
  const actionStr = shortJson(input.lastAction);
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
        step: input.step,
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
      };
      const forOp = String(data.guidanceForOperator ?? "").trim();
      const forUser = String(data.adviceForUser ?? "").trim();
      if (forOp) {
        return {
          guidanceForOperator: forOp,
          adviceForUser: forUser || forOp,
          source: "agent",
        };
      }
    }
  } catch {
    /* Агент может быть не запущен — переключаемся на модель из настроек или эвристику */
  }

  // 2. Fallback: прямая подсказка через модель (если настроены baseUrl + model).
  const baseUrl = normalizeBaseUrl(input.settings?.baseUrl ?? "");
  const model = (input.settings?.model ?? process.env.AI_MODEL ?? "").trim();
  const apiKey = (input.settings?.apiKey ?? process.env.AI_API_KEY ?? "").trim();
  if (baseUrl && model) {
    try {
      const promptLines = [
        `Цель задачи: ${input.taskPrompt}`,
        `Режим Оператора: ${modeMeta.label} (${input.taskMode})`,
        `Выполнен шаг #${input.step}`,
      ];
      if (actionStr) promptLines.push(`Действие Оператора: ${actionStr}`);
      if (resultStr) promptLines.push(`Результат: ${resultStr}`);
      if (obsStr) promptLines.push(`Что видно на экране: ${obsStr}`);
      if (userHintStr) promptLines.push(`Комментарий пользователя: ${userHintStr}`);
      if (input.history?.length) {
        promptLines.push(`Предыдущие шаги:\n${input.history.slice(-6).join("\n")}`);
      }
      promptLines.push(
        "Ответь JSON: {\"guidanceForOperator\":\"точная команда Оператору на следующий шаг\",\"adviceForUser\":\"короткий понятный совет пользователю, что происходит и что делать дальше\"}",
      );

      const res = await fetch(aiEndpoint(baseUrl, "/chat/completions"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...aiAuthHeaders(apiKey) },
        body: JSON.stringify({
          model,
          temperature: 0.25,
          max_tokens: 320,
          stream: false,
          messages: [
            {
              role: "system",
              content:
                "Ты — наставник Оператора ПК. После КАЖДОГО выполненного действия подсказывай Оператору и пользователю, " +
                "что делать дальше. Для режима «game» учитывай управление персонажем (WASD удержание, камеру, прыжок, взаимодействие). " +
                "Отвечай строго JSON.",
            },
            { role: "user", content: promptLines.join("\n") },
          ],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const raw = String(data.choices?.[0]?.message?.content ?? "").trim();
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as {
            guidanceForOperator?: string;
            adviceForUser?: string;
          };
          const forOp = String(parsed.guidanceForOperator ?? "").trim();
          const forUser = String(parsed.adviceForUser ?? "").trim();
          if (forOp) {
            return { guidanceForOperator: forOp, adviceForUser: forUser || forOp, source: "model" };
          }
        }
        if (raw) {
          return {
            guidanceForOperator: raw.slice(0, 400),
            adviceForUser: raw.slice(0, 400),
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
    source: "heuristic",
  };
}
