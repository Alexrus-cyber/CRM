import { claimAgentTask, getUserRoleById, syncOperatorTaskToConversation } from "@/db/repo";
import { botOwner } from "@/lib/agentBot";
import { isUnlimitedStepsRole } from "@/lib/genParams";

/**
 * Бот забирает следующее задание из очереди.
 * Аутентификация — заголовок `x-agent-token` (токен создаётся в блоке ИИ).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const ownerId = await botOwner(req);
  if (!ownerId) return Response.json({ error: "Неверный токен агента" }, { status: 401 });

  const [task, ownerRole] = await Promise.all([claimAgentTask(ownerId), getUserRoleById(ownerId)]);
  if (task) {
    await syncOperatorTaskToConversation(ownerId, task.id);
  }
  const unlimited = isUnlimitedStepsRole(ownerRole);
  return Response.json(
    { task: task ? { ...task, unlimited } : null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
