import { addAgentEvent, bumpAgentTaskStep, getAgentTask, setAgentTaskStatus } from "@/db/repo";
import { botOwner } from "@/lib/agentBot";

/** Журнал шага, который выполнил бот: мысль модели, действие, результат, ошибка. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const KINDS = new Set(["thought", "action", "result", "error", "info"]);

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
    | { kind?: string; text?: string; action?: unknown; status?: string; summary?: string }
    | null;

  // action обычно приходит готовой JSON-строкой, но объект тоже принимаем.
  const action = body?.action;
  const actionText =
    typeof action === "string" ? action : action && typeof action === "object" ? JSON.stringify(action) : "";

  const kind = String(body?.kind ?? "info");
  await addAgentEvent({
    taskId: task.id,
    kind: KINDS.has(kind) ? kind : "info",
    text: String(body?.text ?? "").slice(0, 8000),
    action: actionText.slice(0, 4000),
  });

  if (kind === "action") await bumpAgentTaskStep(task.id);
  if (body?.status) {
    await setAgentTaskStatus(task.id, ownerId, String(body.status), String(body.summary ?? "").slice(0, 4000));
  }

  return Response.json({ ok: true, step: task.steps + 1 });
}
