import { AGENT_URL } from "@/lib/agentConfig";
import { getAgentTask, getAiUserSettingsSecret, listAgentEvents, recordAgentUsage, setAgentTaskGuidance, syncOperatorTaskToConversation } from "@/db/repo";
import { hasAgentAccess, hasOperatorAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import { requestAgentStepCoaching } from "@/lib/agentCoach";
import type { GenParams } from "@/lib/genParams";

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
  if (!hasAgentAccess(me) && !hasOperatorAccess(me)) {
    return Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | {
        taskId?: number;
        userHint?: string;
        settings?: { baseUrl?: string; apiKey?: string; model?: string };
        params?: Partial<GenParams>;
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

  // Оцениваем зацикливание по последним событиям (повтор действия или неудачи проверки).
  const tailActions = events.filter((e) => e.kind === "action").slice(-4).map((e) => e.action || e.text);
  let repeatStreak = 0;
  if (tailActions.length > 0) {
    const lastAct = tailActions[tailActions.length - 1];
    for (let i = tailActions.length - 1; i >= 0 && tailActions[i] === lastAct; i--) {
      repeatStreak += 1;
    }
  }
  const failedChecks = events
    .slice(-6)
    .filter((e) => e.kind === "result" && e.text.includes("⚠️")).length;

  const savedSettings = await getAiUserSettingsSecret(me.id).catch(() => ({ baseUrl: "", model: "", apiKey: "" }));
  const mergedSettings = {
    baseUrl: body?.settings?.baseUrl || savedSettings.baseUrl,
    apiKey: (body?.settings?.apiKey ?? "").trim() || savedSettings.apiKey,
    model: (body?.settings?.model ?? "").trim() || savedSettings.model,
  };

  const advice = await requestAgentStepCoaching({
    agentUrl: AGENT_URL,
    taskPrompt: task.prompt,
    taskMode: task.taskMode,
    step: task.steps,
    lastAction: lastActionEv?.action || undefined,
    lastResult: lastResultEv?.text || lastActionEv?.text || "",
    observation: lastThoughtEv?.text || "",
    userHint: typeof body?.userHint === "string" ? body.userHint : "",
    repeatStreak,
    failedChecks,
    params: body?.params ?? null,
    history,
    settings: mergedSettings,
  });

  const saved = await setAgentTaskGuidance(task.id, me.id, {
    author: "agent",
    text: advice.guidanceForOperator,
    userAdvice: advice.adviceForUser,
    addEvent: true,
  });
  if (advice.usage) {
    await recordAgentUsage({
      userId: me.id,
      kind: "operator",
      refId: task.id,
      model: advice.usage.model ?? body?.settings?.model ?? "",
      prompt: advice.usage.prompt,
      completion: advice.usage.completion,
      total: advice.usage.total,
    }).catch(() => undefined);
  }
  const conversationId = await syncOperatorTaskToConversation(me.id, task.id, { onlyIfExisting: true });

  return Response.json(
    {
      ok: true,
      task: saved?.task ?? task,
      guidance: saved?.guidance ?? null,
      tuned: advice.tuned,
      conversationId,
      source: advice.source,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
