import { addAgentEvent, getAgentTask, setAgentTaskStatus, syncOperatorTaskToConversation } from "@/db/repo";
import { botOwner } from "@/lib/agentBot";

/** Завершение задания: done, failed или cancelled. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await botOwner(req);
  if (!ownerId) return Response.json({ error: "Неверный токен агента" }, { status: 401 });

  const { id } = await ctx.params;
  const task = await getAgentTask(ownerId, Number(id) || 0);
  if (!task) return Response.json({ error: "Задание не найдено" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { status?: string; summary?: string } | null;
  const status = ["done", "failed", "cancelled"].includes(String(body?.status)) ? String(body?.status) : "done";

  // Отменённое задание нельзя «завершить» как failed: пользователь уже нажал
  // «Остановить», и бот должен просто выйти, а не переписывать статус.
  if (task.status === "cancelled" && status !== "cancelled") {
    return Response.json(
      { ok: false, cancelled: true, error: "Задание отменено пользователем" },
      { status: 409 },
    );
  }
  const summary = String(body?.summary ?? "").slice(0, 4000);

  await setAgentTaskStatus(task.id, ownerId, status, summary);
  await addAgentEvent({ taskId: task.id, kind: "info", text: summary || `Задание завершено: ${status}` });
  const conversationId = await syncOperatorTaskToConversation(ownerId, task.id, { onlyIfExisting: true });
  return Response.json({ ok: true, conversationId });
}
