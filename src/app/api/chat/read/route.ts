import { canAccessChatRoom, markChatRead, markRoomRead, maxConversationMessageId } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

/**
 * Отметка «дочитал до сообщения id» для текущей переписки или комнаты.
 * Больше последнего сообщения в переписке отметить нельзя.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { peer?: number; room?: number; id?: number } | null;
  const room = Math.max(0, Number(body?.room ?? 0) || 0);
  const peer = room > 0 ? 0 : Number(body?.peer ?? 0) || 0;
  const id = Number(body?.id ?? 0) || 0;

  if (room > 0) {
    if (!(await canAccessChatRoom(me.id, room))) {
      return Response.json({ error: "Чат не найден" }, { status: 404 });
    }
    const lastId = await maxConversationMessageId(me.id, 0, room);
    const bounded = Math.min(id, lastId);
    await markRoomRead(me.id, room, bounded);
    return Response.json({ ok: true, lastReadId: bounded });
  }

  if (peer === me.id) return Response.json({ error: "Некорректная переписка" }, { status: 400 });

  const lastId = await maxConversationMessageId(me.id, peer);
  await markChatRead(me.id, peer, Math.min(id, lastId));
  return Response.json({ ok: true, lastReadId: Math.min(id, lastId) });
}
