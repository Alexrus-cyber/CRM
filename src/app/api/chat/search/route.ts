import { canAccessChatRoom, searchMessages, userExists } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

/** Поиск по переписке или групповому/общему чату. */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const room = Math.max(0, Number(url.searchParams.get("room") ?? 0) || 0);
  const peer = room > 0 ? 0 : Number(url.searchParams.get("peer") ?? 0) || 0;
  const query = (url.searchParams.get("q") ?? "").trim();

  if (room > 0) {
    if (!(await canAccessChatRoom(me.id, room))) {
      return Response.json({ error: "Чат не найден" }, { status: 404 });
    }
  } else if (peer !== 0 && !(await userExists(peer))) {
    return Response.json({ error: "Пользователь не найден" }, { status: 404 });
  }
  if (query.length < 2) return Response.json({ results: [] });

  const results = await searchMessages(me.id, peer, query.slice(0, 120), 50, room);
  return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
}
