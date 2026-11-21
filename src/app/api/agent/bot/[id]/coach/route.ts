import { getAgentTask, setAgentTaskGuidance } from "@/db/repo";
import { botOwner } from "@/lib/agentBot";
import { requestAgentStepCoaching } from "@/lib/agentCoach";
import { AGENT_URL } from "@/app/api/ai/agent/route";

/**
 * Пошаговое сопровождение Оператора после каждого действия:
 * `POST /api/agent/bot/<id>/coach`
 *
 * Возвращает свежую подсказку от пользователя или от Агента, чтобы Оператор
 * и пользователь сразу знали, что делать дальше.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await botOwner(req);
  if (!ownerId) return Response.json({ error: "Неверный токен агента" }, { status: 401 });

  const { id } = await ctx.params;
  const task = await getAgentTask(ownerId, Number(id) || 0);
  if (!task) return Response.json({ error: "Задание не найдено" }, { status: 404 });
  if (task.status === "cancelled") {
    return Response.json({ ok: false, cancelled: true, error: "Задание отменено пользователем" }, { status: 409 });
  }

  const body = (await req.json().catch(() => null)) as
    | {
        step?: number;
        phase?: "after_step" | "before_action";
        plannedAction?: unknown;
        aimPoint?: { x?: number; y?: number };
        lastAction?: unknown;
        lastResult?: string;
        observation?: string;
        lastGuidanceId?: string;
        history?: string[];
        screenshot?: string;
        askAgent?: boolean;
      }
    | null;

  const phase = body?.phase === "before_action" ? "before_action" : "after_step";

  // Если пользователь уже оставил новое указание на сайте, отдаём его сразу.
  const lastSeenId = String(body?.lastGuidanceId ?? "");
  if (task.guidanceNote && task.guidanceNote.id !== lastSeenId && task.guidanceNote.author === "user") {
    return Response.json(
      {
        ok: true,
        guidance: task.guidanceNote,
        approved: phase === "before_action" ? false : true,
        reason: phase === "before_action" ? "Получено новое указание пользователя" : undefined,
        visionUsed: true,
        source: "user",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (task.coachMode !== "agent" && !body?.askAgent) {
    return Response.json(
      { ok: true, guidance: null, skipped: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const advice = await requestAgentStepCoaching({
    agentUrl: AGENT_URL,
    taskPrompt: task.prompt,
    taskMode: task.taskMode,
    phase,
    step: Number(body?.step ?? task.steps) || task.steps,
    plannedAction: body?.plannedAction,
    aimPoint: body?.aimPoint,
    lastAction: body?.lastAction,
    lastResult: body?.lastResult,
    observation: body?.observation,
    history: Array.isArray(body?.history) ? body.history.map((s) => String(s)).slice(-10) : [],
    screenshot: typeof body?.screenshot === "string" ? body.screenshot : undefined,
  });

  if (advice.source === "heuristic" && (task.coachMode !== "agent" || phase === "before_action")) {
    return Response.json({
      ok: true,
      guidance: null,
      approved: true,
      visionUsed: false,
      fallback: true,
      source: "heuristic",
    });
  }

  const saved = await setAgentTaskGuidance(task.id, ownerId, {
    author: advice.source === "agent" || advice.source === "model" ? "agent" : "operator",
    text: advice.guidanceForOperator,
    userAdvice: advice.adviceForUser,
    addEvent: true,
  });

  return Response.json(
    {
      ok: true,
      guidance: saved?.guidance ?? null,
      approved: advice.approved ?? true,
      reason: advice.reason ?? "",
      visionUsed: advice.visionUsed ?? false,
      source: advice.source,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
