import { getAgentTask, listAgentEvents, setAgentTaskGuidance } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { requestAgentStepCoaching } from "@/lib/agentCoach";
import { AGENT_URL } from "../route";

/**
 * Совет Агента после выполненного шага Оператора (вызывается из интерфейса
 * блока «Агент» или «Оператор»): анализирует последние события задачи,
 * просит Агента/LLM подсказать, что делать дальше, и сохраняет наставление
 * прямо в задачу Оператора.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "super_admin") {
    return Response.json({ error: "Доступно только главному администратору" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | {
        taskId?: number;
        userHint?: string;
        settings?: { baseUrl?: string; apiKey?: string; model?: string };
      }
    | null;

  const taskId = Number(body?.taskId ?? 0) || 0;
  if (!taskId) return Response.json({ error: "Не указан taskId" }, { status: 400 });

  const task = await getAgentTask(me.id, taskId);
  if (!task) return Response.json({ error: "Задание не найдено" }, { status: 404 });
  if (["done", "failed", "cancelled"].includes(task.status)) {
    return Response.json({ error: "Задание уже завершено" }, { status: 409 });
  }

  const events = await listAgentEvents(task.id, 60);
  const lastActionEv = [...events].reverse().find((e) => e.kind === "action");
  const lastThoughtEv = [...events].reverse().find((e) => e.kind === "thought");
  const lastResultEv = [...events].reverse().find((e) => e.kind === "result");
  const history = events
    .filter((e) => e.kind === "action" || e.kind === "result" || e.kind === "guidance")
    .slice(-8)
    .map((e) => `[${e.kind}] ${e.text || e.action}`);

  const advice = await requestAgentStepCoaching({
    agentUrl: AGENT_URL,
    taskPrompt: task.prompt,
    taskMode: task.taskMode,
    step: task.steps,
    lastAction: lastActionEv?.action || undefined,
    lastResult: lastResultEv?.text || lastActionEv?.text || "",
    observation: lastThoughtEv?.text || "",
    userHint: typeof body?.userHint === "string" ? body.userHint : "",
    history,
    settings: body?.settings,
  });

  const saved = await setAgentTaskGuidance(task.id, me.id, {
    author: "agent",
    text: advice.guidanceForOperator,
    userAdvice: advice.adviceForUser,
    addEvent: true,
  });

  return Response.json(
    {
      ok: true,
      task: saved?.task ?? task,
      guidance: saved?.guidance ?? null,
      source: advice.source,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
