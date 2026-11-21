import { addAgentEvent, createAgentTask } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { aiAuthHeaders, aiEndpoint, normalizeBaseUrl } from "@/lib/ai";
import { AGENT_MAX_STEPS } from "@/lib/genParams";
import {
  normalizeCoachMode,
  normalizeTaskMode,
  type OperatorCoachMode,
  type OperatorTaskMode,
} from "@/lib/operatorModes";
import { normalizeTrustLevel } from "@/lib/trust";

/**
 * Мост из блока «Агент» в блок «Оператор»:
 *   - `action: "formulate"` — помогает пользователю превратить просьбу в чёткую
 *     задачу для Оператора (с подходящим режимом, шагами и правилами);
 *   - `action: "launch"` (по умолчанию) — ставит подтверждённую пользователем
 *     задачу в очередь Оператора (`source = "agent"`).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_PROMPT = 4000;

function heuristicFormulate(goal: string): {
  prompt: string;
  taskMode: OperatorTaskMode;
  coachMode: OperatorCoachMode;
  maxSteps: number;
  notes: string;
} {
  const clean = goal.trim();
  const isGame = /игр|персонаж|гейм|беги|прыг|стрел|квест|уровн|wasd|бой|камер/i.test(clean);
  const taskMode: OperatorTaskMode = isGame ? "game" : "copilot";
  const maxSteps = isGame ? 60 : 30;
  const prompt = isGame
    ? `Режим игры / управления персонажем. Цель: ${clean}.\n1. Осмотри игровой экран и определи позицию персонажа/курсора.\n2. Управляй движением через hold_key (WASD/Shift/Space), поворотом камеры (move_mouse_rel) и взаимодействием (sequence/key).\n3. После каждого действия оценивай изменение сцены и подсказывай следующий ход.`
    : `Пошаговая помощь пользователю на экране. Цель: ${clean}.\n1. Посмотри на активное окно на скриншоте.\n2. Выполняй по одному аккуратному действию (клик, ввод, горячие клавиши, прокрутка) и проверяй результат.\n3. После каждого действия кратко подсказывай пользователю, что сделано и что делать дальше.`;
  return {
    prompt,
    taskMode,
    coachMode: "agent",
    maxSteps,
    notes: isGame
      ? "Выбран игровой режим с удержанием клавиш и пошаговым ведением Агента."
      : "Выбран режим помощника на ПК с разбором после каждого шага.",
  };
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "super_admin") {
    return Response.json({ error: "Доступно только главному администратору" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | {
        action?: "formulate" | "launch";
        goal?: string;
        prompt?: string;
        taskMode?: string;
        mode?: string;
        coachMode?: string;
        trustLevel?: string;
        maxSteps?: number;
        contextSummary?: string;
        settings?: { baseUrl?: string; apiKey?: string; model?: string };
      }
    | null;

  const action = body?.action === "formulate" ? "formulate" : "launch";

  if (action === "formulate") {
    const goal = String(body?.goal ?? body?.prompt ?? "").trim();
    if (!goal) return Response.json({ error: "Опишите, чем нужно помочь на экране" }, { status: 400 });

    const fallback = heuristicFormulate(goal);
    const baseUrl = normalizeBaseUrl(body?.settings?.baseUrl ?? "");
    const model = (body?.settings?.model ?? process.env.AI_MODEL ?? "").trim();
    const apiKey = (body?.settings?.apiKey ?? process.env.AI_API_KEY ?? "").trim();
    if (!baseUrl || !model) {
      return Response.json({ ...fallback, source: "heuristic" }, { headers: { "Cache-Control": "no-store" } });
    }

    try {
      const res = await fetch(aiEndpoint(baseUrl, "/chat/completions"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...aiAuthHeaders(apiKey) },
        body: JSON.stringify({
          model,
          temperature: 0.25,
          max_tokens: 650,
          stream: false,
          messages: [
            {
              role: "system",
              content:
                "Ты — ИИ-агент CRM. Помоги пользователю сформулировать точную, понятную и безопасную задачу для " +
                "Настольного Оператора экрана (который видит скриншоты, кликает, печатает, переключает раскладку, а в играх " +
                "удерживает клавиши hold_key, поворачивает камеру move_mouse_rel и делает sequence).\n" +
                "Ответь строго JSON: {\"prompt\":\"точная пошаговая инструкция для Оператора + критерий готовности\",\"taskMode\":\"autonomous|copilot|game\",\"coachMode\":\"agent|after_step\",\"maxSteps\":30,\"notes\":\"почему выбран такой план\"}",
            },
            {
              role: "user",
              content:
                `Просьба пользователя: ${goal}` +
                (body?.contextSummary ? `\nКонтекст чата:\n${String(body.contextSummary).slice(0, 2000)}` : ""),
            },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const raw = String(data.choices?.[0]?.message?.content ?? "").trim();
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as {
            prompt?: string;
            taskMode?: string;
            coachMode?: string;
            maxSteps?: number;
            notes?: string;
          };
          const prompt = String(parsed.prompt ?? "").trim();
          if (prompt) {
            return Response.json(
              {
                prompt: prompt.slice(0, MAX_PROMPT),
                taskMode: normalizeTaskMode(parsed.taskMode),
                coachMode: normalizeCoachMode(parsed.coachMode || "agent"),
                maxSteps: Math.min(AGENT_MAX_STEPS, Math.max(5, Number(parsed.maxSteps ?? 30) || 30)),
                notes: String(parsed.notes ?? "").trim().slice(0, 400),
                source: "model",
              },
              { headers: { "Cache-Control": "no-store" } },
            );
          }
        }
      }
    } catch {
      /* fallback ниже */
    }
    return Response.json({ ...fallback, source: "heuristic" }, { headers: { "Cache-Control": "no-store" } });
  }

  // Запуск задачи Оператора после явного разрешения пользователя.
  const prompt = String(body?.prompt ?? "").trim();
  if (!prompt) return Response.json({ error: "Укажите задачу для Оператора" }, { status: 400 });
  if (prompt.length > MAX_PROMPT) return Response.json({ error: "Слишком длинное задание" }, { status: 400 });

  const taskMode = normalizeTaskMode(body?.taskMode ?? body?.mode);
  const coachMode = taskMode === "inspect" ? "off" : normalizeCoachMode(body?.coachMode ?? "agent");
  const trustLevel = normalizeTrustLevel(body?.trustLevel ?? "verified");
  const maxSteps =
    taskMode === "inspect"
      ? 2
      : Math.min(AGENT_MAX_STEPS, Math.max(1, Number(body?.maxSteps ?? 30) || 30));

  const task = await createAgentTask(me.id, prompt, maxSteps, trustLevel, {
    taskMode,
    coachMode,
    source: "agent",
  });

  await addAgentEvent({
    taskId: task.id,
    kind: "info",
    text: `Задача создана из блока «Агент» с разрешения пользователя (режим: ${taskMode}, сопровождение: ${coachMode}, доверие: ${trustLevel}).`,
  });

  return Response.json({ ok: true, task }, { headers: { "Cache-Control": "no-store" } });
}
