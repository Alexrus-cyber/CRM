import { getAgentTask, requestAgentTaskApproval, syncOperatorTaskToConversation } from "@/db/repo";
import { botOwner } from "@/lib/agentBot";
import { formatServerBotApproval } from "@/lib/approvalFormat";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";

/**
 * Бот запрашивает подтверждение опасного действия или расширение лимита шагов на сайте:
 * `POST /api/agent/bot/<id>/approval`
 *
 * Заголовок и описание диалога формируются строго на сервере через
 * `formatServerBotApproval`, чтобы бот не мог подменить текст на безвредный (P1).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await botOwner(req);
  if (!ownerId) return Response.json({ error: "Неверный токен агента" }, { status: 401 });

  const rl = checkApiRateLimit({
    scope: "bot_approval",
    userId: ownerId,
    ip: extractClientIp(req.headers),
    maxRequests: 60,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const { id } = await ctx.params;
  const task = await getAgentTask(ownerId, Number(id) || 0);
  if (!task) return Response.json({ error: "Задание не найдено" }, { status: 404 });
  if (task.status === "cancelled") {
    return Response.json({ ok: false, cancelled: true, error: "Задание отменено пользователем" }, { status: 409 });
  }

  const body = (await req.json().catch(() => null)) as
    | {
        id?: string;
        approvalId?: string;
        kind?: string;
        action?: unknown;
        extraSteps?: number;
      }
    | null;

  const formatted = formatServerBotApproval({
    kind: body?.kind,
    action: body?.action,
    extraSteps: body?.extraSteps,
  });
  if (!formatted.ok) {
    return Response.json({ error: formatted.error }, { status: 400 });
  }

  const actionType = String(formatted.action.type ?? "");
  const dbKind: "dangerous_action" | "step_limit" | "sandbox_export" | "shell_command" =
    formatted.kind === "step_limit"
      ? "step_limit"
      : actionType === "sandbox_export" || actionType === "export_from_sandbox"
        ? "sandbox_export"
        : actionType === "pc_command" || actionType === "bash_command" || actionType === "run_command"
          ? "shell_command"
          : "dangerous_action";

  const approvalId =
    (typeof body?.approvalId === "string" && body.approvalId.trim()) ||
    (typeof body?.id === "string" && body.id.trim()) ||
    `appr_${task.id}_${Date.now()}`;

  const created = await requestAgentTaskApproval(task.id, ownerId, {
    id: approvalId.slice(0, 120),
    kind: dbKind,
    title: formatted.title,
    description: formatted.description,
    action: formatted.action,
    extraSteps: formatted.kind === "step_limit" ? formatted.extraSteps : undefined,
  });

  if (!created) {
    return Response.json({ ok: false, cancelled: true, error: "Задание отменено" }, { status: 409 });
  }
  await syncOperatorTaskToConversation(ownerId, task.id, { onlyIfExisting: true });

  return Response.json({ ok: true, approval: created }, { headers: { "Cache-Control": "no-store" } });
}
