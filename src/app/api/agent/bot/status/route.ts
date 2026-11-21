import { getAgentBotConnectionStatus } from "@/db/repo";
import { hasOperatorAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";

/**
 * Ручная проверка подключения настольного бота: `GET /api/agent/bot/status`.
 *
 * Вызывается только по явному нажатию кнопки в интерфейсе вкладки «Оператор»
 * (без автоматического опроса и heartbeat). Сообщает, выходил ли бот на связь
 * недавно, каким токеном и сколько заданий сейчас в очереди.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasOperatorAccess(me)) {
    return Response.json({ error: "Доступ к Оператору не выдан главным администратором" }, { status: 403 });
  }

  const rawConnectionId = new URL(req.url).searchParams.get("connectionId");
  const connectionId = rawConnectionId ? Number(rawConnectionId) : 0;
  const status = await getAgentBotConnectionStatus(
    me.id,
    Number.isSafeInteger(connectionId) && connectionId > 0 ? connectionId : undefined,
  );

  return Response.json(
    { ok: true, ...status, checkedAt: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
