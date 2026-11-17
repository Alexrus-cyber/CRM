import { markChatRead, maxConversationMessageId } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

/**
 * Отметка «дочитал до сообщения id» для текущей переписки.
 * Больше последнего сообщения в переписке отметить нельзя.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { peer?: number; id?: number } | null;
  const peer = Number(body?.peer ?? 0) || 0;
  const id = Number(body?.id ?? 0) || 0;
  if (peer === me.id) return Response.json({ error: "Некорректная переписка" }, { status: 400 });

  const lastId = await maxConversationMessageId(me.id, peer);
  await markChatRead(me.id, peer, Math.min(id, lastId));
  return Response.json({ ok: true, lastReadId: Math.min(id, lastId) });
}
