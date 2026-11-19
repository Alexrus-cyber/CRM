import { getAgentTask } from "@/db/repo";
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

  return Response.json(
    {
      task: {
        id: task.id,
        status: task.status,
        steps: task.steps,
        maxSteps: task.maxSteps,
        summary: task.summary,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
