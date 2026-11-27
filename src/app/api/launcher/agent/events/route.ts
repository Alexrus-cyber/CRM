import {
  completeSubagentRun,
  completeTesterRun,
  createSubagentRunWithConversation,
  createTesterRunWithConversation,
  recordAgentUsage,
  touchSubagentRun,
  updateTesterMinorDecision,
  type AgentUsageKind,
  type SubagentCallerKind,
  type SubagentRunStatus,
  type TesterMinorDecision,
  type TesterRunStatus,
} from "@/db/repo";
import { hasAgentAccess, hasOperatorAccess } from "@/lib/aiPolicy";
import { getRequestUser } from "@/lib/auth";

/**
 * Синхронизация событий жизненного цикла локального `agent.py`
 * (субагенты, тестировщик, расход токенов) в БД CRM из десктоп-приложения.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const me = await getRequestUser(req);
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me) && !hasOperatorAccess(me)) {
    return Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.action !== "string") {
    return Response.json({ error: "Не указан action" }, { status: 400 });
  }

  const action = body.action;

  if (action === "subagent_start") {
    if (!hasAgentAccess(me)) return Response.json({ error: "Нет доступа" }, { status: 403 });
    const parsedSubId = Number(body.subagentId ?? 0);
    if (!Number.isFinite(parsedSubId) || parsedSubId <= 0) {
      return Response.json({ error: "Не указан subagentId" }, { status: 400 });
    }
    const rawCaller = String(body.callerKind ?? "orchestrator");
    const callerKind: SubagentCallerKind =
      rawCaller === "subagent" || rawCaller === "user" ? rawCaller : "orchestrator";
    const agentRole = body.agentRole === "subagent" ? "subagent" : "agent";
    const existingConvRaw = Number(body.existingConversationId ?? 0);
    const existingConvId = Number.isFinite(existingConvRaw) && existingConvRaw > 0 ? Math.floor(existingConvRaw) : null;
    const isNewSubChat = Boolean(body.forceNewChat || body.isContinuation);
    const agentConvRaw = Number(body.agentConversationId ?? 0);
    const agentConversationId = Number.isFinite(agentConvRaw) && agentConvRaw > 0 ? Math.floor(agentConvRaw) : null;
    const callerSubRaw = Number(body.callerSubagentId ?? 0);
    const callerSubagentId = Number.isFinite(callerSubRaw) && callerSubRaw > 0 ? Math.floor(callerSubRaw) : null;

    const created = await createSubagentRunWithConversation({
      userId: me.id,
      subagentId: Math.floor(parsedSubId),
      agentConversationId,
      existingConversationId: agentRole === "subagent" && !isNewSubChat ? existingConvId : null,
      skipInitialMessage: agentRole === "subagent" && !isNewSubChat && Boolean(existingConvId),
      callerKind,
      callerSubagentId,
      sandboxProject: typeof body.sandboxProject === "string" ? body.sandboxProject.slice(0, 300) : "",
      inputSummary: typeof body.summary === "string" ? body.summary : "",
      taskPrompt: typeof body.task === "string" ? body.task : "",
      model: typeof body.model === "string" ? body.model.slice(0, 200) : "",
      usedCustomApi: Boolean(body.usedCustomApi),
    });

    return Response.json(
      {
        ok: true,
        runId: created.run.id,
        subagentId: created.run.subagentId,
        subagentSlug: created.run.subagentSlug,
        subagentName: created.run.subagentName,
        subagentColor: created.run.subagentColor,
        subagentConversationId: created.conversation.id,
        callerKind: created.run.callerKind,
        sandboxProject: created.run.sandboxProject,
        model: created.run.model,
        usedCustomApi: created.run.usedCustomApi,
        run: created.run,
        conversation: created.conversation,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (action === "subagent_heartbeat") {
    const runIds = Array.isArray(body.runIds)
      ? body.runIds.map((x) => Math.floor(Number(x))).filter((n) => Number.isFinite(n) && n > 0)
      : Number.isFinite(Number(body.runId)) && Number(body.runId) > 0
        ? [Math.floor(Number(body.runId))]
        : [];
    await Promise.all(runIds.map((id) => touchSubagentRun(me.id, id).catch(() => undefined)));
    return Response.json({ ok: true });
  }

  if (action === "subagent_done") {
    const runId = Math.floor(Number(body.runId ?? 0));
    if (!Number.isFinite(runId) || runId <= 0) {
      return Response.json({ error: "Не указан runId" }, { status: 400 });
    }
    const rawStatus = String(body.status ?? "completed");
    const safeStatus: SubagentRunStatus =
      rawStatus === "handoff" ||
      rawStatus === "blocked" ||
      rawStatus === "error" ||
      rawStatus === "completed" ||
      rawStatus === "rotated" ||
      rawStatus === "cancelled"
        ? rawStatus
        : "completed";

    const savedRun = await completeSubagentRun({
      userId: me.id,
      runId,
      status: safeStatus,
      outputSummary: typeof body.outputSummary === "string" ? body.outputSummary : "",
      requestedCalleeSlug: typeof body.requestedCalleeSlug === "string" ? body.requestedCalleeSlug : "",
      requestedCalleeTask: typeof body.requestedCalleeTask === "string" ? body.requestedCalleeTask : "",
      filesTouched: Array.isArray(body.filesTouched) ? body.filesTouched.map((x) => String(x)) : [],
      promptTokens: Math.max(0, Math.round(Number(body.promptTokens ?? 0) || 0)),
      completionTokens: Math.max(0, Math.round(Number(body.completionTokens ?? 0) || 0)),
      totalTokens: Math.max(0, Math.round(Number(body.totalTokens ?? 0) || 0)),
      model: typeof body.model === "string" ? body.model.slice(0, 200) : "",
      usedCustomApi: Boolean(body.usedCustomApi),
      assistantContent: typeof body.fullResponse === "string" ? body.fullResponse : undefined,
      assistantReasoning: typeof body.reasoning === "string" ? body.reasoning : undefined,
      assistantActions: Array.isArray(body.actions) ? body.actions : undefined,
      assistantFiles: Array.isArray(body.files) ? body.files : undefined,
      assistantError: typeof body.error === "string" ? body.error : undefined,
    });
    return Response.json({ ok: true, run: savedRun }, { headers: { "Cache-Control": "no-store" } });
  }

  if (action === "finalize_subagent_runs") {
    const runIds = Array.isArray(body.runIds)
      ? body.runIds.map((x) => Math.floor(Number(x))).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    const model = typeof body.model === "string" ? body.model.slice(0, 200) : "";
    await Promise.all(
      runIds.map((runId) =>
        completeSubagentRun({
          userId: me.id,
          runId,
          status: "error",
          outputSummary:
            "Запуск прерван: соединение с клиентом закрыто до завершения. Используйте «Повторить», чтобы продолжить задачу.",
          model,
        }).catch(() => null),
      ),
    );
    return Response.json({ ok: true });
  }

  if (action === "tester_start") {
    if (!hasAgentAccess(me)) return Response.json({ error: "Нет доступа" }, { status: 403 });
    const agentConvRaw = Number(body.agentConversationId ?? 0);
    const testerConvRaw = Number(body.testerConversationId ?? 0);
    const created = await createTesterRunWithConversation({
      userId: me.id,
      agentConversationId: Number.isFinite(agentConvRaw) && agentConvRaw > 0 ? Math.floor(agentConvRaw) : null,
      testerConversationId: Number.isFinite(testerConvRaw) && testerConvRaw > 0 ? Math.floor(testerConvRaw) : null,
      title: typeof body.title === "string" ? body.title : undefined,
      sandboxProject: typeof body.sandboxProject === "string" ? body.sandboxProject.slice(0, 300) : "",
      summary: typeof body.summary === "string" ? body.summary : "",
      model: typeof body.model === "string" ? body.model.slice(0, 200) : "",
      skipInitialMessage: body.agentRole === "tester" && Number.isFinite(testerConvRaw) && testerConvRaw > 0,
    });
    return Response.json(
      {
        ok: true,
        runId: created.run.id,
        testerConversationId: created.conversation.id,
        run: created.run,
        conversation: created.conversation,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (action === "tester_done") {
    const runId = Math.floor(Number(body.runId ?? 0));
    if (!Number.isFinite(runId) || runId <= 0) {
      return Response.json({ error: "Не указан runId" }, { status: 400 });
    }
    const rawStatus = String(body.status ?? "passed") as TesterRunStatus;
    const rawDecision =
      body.minorDecision !== undefined ? (String(body.minorDecision) as TesterMinorDecision) : undefined;
    const savedRun = await completeTesterRun(me.id, runId, {
      status: rawStatus,
      reportSummary: typeof body.reportSummary === "string" ? body.reportSummary : "",
      criticalIssues: body.criticalIssues,
      minorIssues: body.minorIssues,
      checksRun: body.checksRun,
      minorDecision: rawDecision,
      promptTokens: Math.max(0, Math.round(Number(body.promptTokens ?? 0) || 0)),
      completionTokens: Math.max(0, Math.round(Number(body.completionTokens ?? 0) || 0)),
      totalTokens: Math.max(0, Math.round(Number(body.totalTokens ?? 0) || 0)),
      model: typeof body.model === "string" ? body.model.slice(0, 200) : "",
      fullResponse: typeof body.fullResponse === "string" ? body.fullResponse : "",
      reasoning: typeof body.reasoning === "string" ? body.reasoning : "",
      actions: Array.isArray(body.actions) ? body.actions : [],
      files: Array.isArray(body.files) ? body.files : [],
      error: typeof body.error === "string" ? body.error : "",
      skipUsageRecord: Boolean(body.skipUsageRecord),
    });
    return Response.json({ ok: true, run: savedRun }, { headers: { "Cache-Control": "no-store" } });
  }

  if (action === "tester_decision") {
    const runId = Math.floor(Number(body.runId ?? 0));
    if (!Number.isFinite(runId) || runId <= 0) {
      return Response.json({ error: "Не указан runId" }, { status: 400 });
    }
    const decision =
      body.decision === "approved" ? "approved" : body.decision === "rejected" ? "rejected" : "pending";
    const updated = await updateTesterMinorDecision(
      me.id,
      runId,
      decision,
      typeof body.note === "string" ? body.note : undefined,
    );
    return Response.json({ ok: true, run: updated }, { headers: { "Cache-Control": "no-store" } });
  }

  if (action === "usage") {
    const kind: AgentUsageKind = body.kind === "operator" ? "operator" : "agent";
    const allowed = kind === "operator" ? hasOperatorAccess(me) : hasAgentAccess(me);
    if (!allowed) return Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 });
    const prompt = Math.max(0, Math.round(Number(body.promptTokens ?? 0) || 0));
    const completion = Math.max(0, Math.round(Number(body.completionTokens ?? 0) || 0));
    const total = Math.max(prompt + completion, Math.round(Number(body.totalTokens ?? 0) || 0));
    if (total > 0 || prompt > 0 || completion > 0) {
      await recordAgentUsage({
        userId: me.id,
        kind,
        refId: Number(body.refId ?? 0) || 0,
        model: String(body.model ?? "").slice(0, 160),
        prompt,
        completion,
        total,
      });
    }
    return Response.json({ ok: true });
  }

  return Response.json({ error: `Неизвестный action: ${action}` }, { status: 400 });
}
