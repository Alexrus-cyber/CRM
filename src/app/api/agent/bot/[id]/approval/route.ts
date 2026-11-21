import { getAgentTask, requestAgentTaskApproval, syncOperatorTaskToConversation } from "@/db/repo";
import { botOwner } from "@/lib/agentBot";

/**
 * Бот запрашивает подтверждение опасного действия или расширение лимита шагов на сайте:
 * `POST /api/agent/bot/<id>/approval`
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_KINDS = new Set(["dangerous_action", "step_limit", "sandbox_export", "shell_command"]);

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
        id?: string;
        approvalId?: string;
        kind?: string;
        title?: string;
        description?: string;
        action?: Record<string, unknown>;
        extraSteps?: number;
      }
    | null;

  const rawKind = String(body?.kind ?? "dangerous_action");
  const kind = ALLOWED_KINDS.has(rawKind)
    ? (rawKind as "dangerous_action" | "step_limit" | "sandbox_export" | "shell_command")
    : "dangerous_action";
  const approvalId =
    (typeof body?.approvalId === "string" && body.approvalId.trim()) ||
    (typeof body?.id === "string" && body.id.trim()) ||
    `appr_${task.id}_${Date.now()}`;

  const created = await requestAgentTaskApproval(task.id, ownerId, {
    id: approvalId.slice(0, 120),
    kind,
    title: String(body?.title ?? "Требуется подтверждение на сайте"),
    description: String(body?.description ?? ""),
    action: body?.action && typeof body.action === "object" ? body.action : undefined,
    extraSteps: Number.isFinite(body?.extraSteps) ? Math.max(1, Number(body?.extraSteps)) : undefined,
  });

  if (!created) {
    return Response.json({ ok: false, cancelled: true, error: "Задание отменено" }, { status: 409 });
  }
  await syncOperatorTaskToConversation(ownerId, task.id);

  return Response.json({ ok: true, approval: created }, { headers: { "Cache-Control": "no-store" } });
}
