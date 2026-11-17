import { unreadCounts } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

/** Непрочитанные сообщения по перепискам — для значков в списке чатов. */
export const dynamic = "force-dynamic";

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const unread = await unreadCounts(me.id);
  return Response.json({ unread }, { headers: { "Cache-Control": "no-store" } });
}
