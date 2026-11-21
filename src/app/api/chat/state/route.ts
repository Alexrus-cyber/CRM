import { unreadCounts, unreadRoomCounts } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

/** Непрочитанные сообщения по перепискам и групповым/общим комнатам — для значков в списке чатов. */
export const dynamic = "force-dynamic";

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const [unread, roomUnread] = await Promise.all([unreadCounts(me.id), unreadRoomCounts(me.id)]);
  return Response.json({ unread, roomUnread }, { headers: { "Cache-Control": "no-store" } });
}
