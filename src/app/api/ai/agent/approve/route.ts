import { getAgentTask } from "@/db/repo";
import { consumeAgentApproval, peekAgentApproval } from "@/lib/agentApprovals";
import { fetchAgent, resolveSafeAgentUrl } from "@/lib/agentConfig";
import { hasAgentAccess, hasOperatorAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";

/**
 * Подтверждение или отклонение команды / переноса файлов из Sandbox для запущенного Python-агента.
 * Требует владения approvalId + одноразовый серверный nonce (P0-4).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me) && !hasOperatorAccess(me)) {
    return Response.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  let agentUrl: string;
  try {
    agentUrl = resolveSafeAgentUrl();
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as
    | {
        approvalId?: string;
        approved?: boolean;
        note?: string;
        destination?: string;
        taskId?: number;
        taskPrompt?: string;
        mode?: string;
        coachMode?: string;
        operatorTrustLevel?: string;
        screenshot?: string;
        screenSummary?: string;
        commitMessage?: string;
        branch?: string;
        prTitle?: string;
        prBody?: string;
        mergeMethod?: string;
      }
    | null;

  const approvalId = String(body?.approvalId ?? "").trim();
  if (!approvalId) {
    return Response.json({ error: "Не указан approvalId" }, { status: 400 });
  }

  if (Number.isFinite(body?.taskId) && Number(body?.taskId) > 0) {
    const ownedTask = await getAgentTask(me.id, Number(body?.taskId));
    if (!ownedTask) {
      return Response.json({ error: "Чужая или несуществующая задача Оператора" }, { status: 403 });
    }
  }

  const checked = peekAgentApproval(approvalId, me.id);
  if (!checked.ok) {
    return Response.json({ error: checked.error }, { status: checked.status });
  }

  const rawScreenshot = typeof body?.screenshot === "string" ? body.screenshot : "";
  const validScreenshot =
    rawScreenshot.startsWith("data:image/") && rawScreenshot.length <= 2_800_000 ? rawScreenshot : "";

  try {
    const { response: upstream } = await fetchAgent(
      agentUrl,
      "/approve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId,
          ...(checked.nonce ? { nonce: checked.nonce } : {}),
          approved: Boolean(body?.approved),
          approverUserId: me.id,
          note: typeof body?.note === "string" ? body.note.slice(0, 500) : "",
          destination: typeof body?.destination === "string" ? body.destination.slice(0, 500) : "",
          ...(Number.isFinite(body?.taskId) ? { taskId: Number(body?.taskId) } : {}),
          ...(typeof body?.taskPrompt === "string" ? { taskPrompt: body.taskPrompt.slice(0, 4000) } : {}),
          ...(typeof body?.mode === "string" ? { mode: body.mode.slice(0, 40) } : {}),
          ...(typeof body?.coachMode === "string" ? { coachMode: body.coachMode.slice(0, 40) } : {}),
          ...(typeof body?.operatorTrustLevel === "string"
            ? { operatorTrustLevel: body.operatorTrustLevel.slice(0, 20) }
            : {}),
          ...(validScreenshot ? { screenshot: validScreenshot } : {}),
          ...(typeof body?.screenSummary === "string"
            ? { screenSummary: body.screenSummary.slice(0, 8000) }
            : {}),
          ...(typeof body?.commitMessage === "string"
            ? { commitMessage: body.commitMessage.slice(0, 1000) }
            : {}),
          ...(typeof body?.branch === "string" ? { branch: body.branch.slice(0, 200) } : {}),
          ...(typeof body?.prTitle === "string" ? { prTitle: body.prTitle.slice(0, 300) } : {}),
          ...(typeof body?.prBody === "string" ? { prBody: body.prBody.slice(0, 8000) } : {}),
          ...(typeof body?.mergeMethod === "string" ? { mergeMethod: body.mergeMethod.slice(0, 20) } : {}),
        }),
        cache: "no-store",
      },
      { timeoutMs: 10_000, reqSignal: req.signal },
    );
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    if (upstream.ok || upstream.status === 404 || upstream.status === 403) {
      consumeAgentApproval(approvalId, me.id);
    }
    return Response.json(data, { status: upstream.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Агент недоступен" }, { status: 503 });
  }
}
