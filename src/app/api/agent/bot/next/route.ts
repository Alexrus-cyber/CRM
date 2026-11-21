import { claimAgentTask, syncOperatorTaskToConversation } from "@/db/repo";
import { botOwner } from "@/lib/agentBot";

/**
 * Бот забирает следующее задание из очереди.
 * Аутентификация — заголовок `x-agent-token` (токен создаётся в блоке ИИ).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const ownerId = await botOwner(req);
  if (!ownerId) return Response.json({ error: "Неверный токен агента" }, { status: 401 });

  const task = await claimAgentTask(ownerId);
  if (task) {
    await syncOperatorTaskToConversation(ownerId, task.id);
  }
  return Response.json({ task }, { headers: { "Cache-Control": "no-store" } });
}
