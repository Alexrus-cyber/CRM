import { getAgentTask, listAgentEvents } from "@/db/repo";
import { botOwner } from "@/lib/agentBot";

/**
 * Статус задания для бота: `GET /api/agent/bot/<id>`.
 *
 * Раньше бот «поддерживал соединение» запросом `/bot/next` — а тот забирает
 * следующее задание из очереди. Теперь бот спрашивает только статус: если
 * пользователь нажал «Остановить», бот видит `cancelled` и сразу выходит.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await botOwner(req);
  if (!ownerId) return Response.json({ error: "Неверный токен агента" }, { status: 401 });

  const { id } = await ctx.params;
  const task = await getAgentTask(ownerId, Number(id) || 0);
  if (!task) return Response.json({ error: "Задание не найдено" }, { status: 404 });

  // Вложения задания: бот скачивает их отдельным маршрутом по eventId.
  const events = await listAgentEvents(task.id);
  const attachments = events
    .filter((event) => event.kind === "attachment" && event.hasFile)
    .map((event) => ({
      id: event.id,
      name: event.fileName || event.text,
      mime: event.fileMime,
      size: event.fileSize,
    }));

  return Response.json(
    {
      task: {
        id: task.id,
        status: task.status,
        steps: task.steps,
        maxSteps: task.maxSteps,
        summary: task.summary,
        trustLevel: task.trustLevel,
        taskMode: task.taskMode,
        source: task.source,
        coachMode: task.coachMode,
        guidanceNote: task.guidanceNote,
        pendingApproval: task.pendingApproval,
        approvalResponse: task.approvalResponse,
      },
      attachments,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
