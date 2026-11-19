import { listNewMessagesFor, maxMessageId } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

/**
 * Новые сообщения для всплывающих уведомлений.
 *
 * `after=0` — запрос «точки отсчёта»: при открытии вкладки уведомления не
 * должны всплывать на всю старую переписку, поэтому первый ответ содержит
 * только `lastId`.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const after = Math.max(Number(url.searchParams.get("after") ?? 0) || 0, 0);

  if (after === 0) {
    return Response.json(
      { lastId: await maxMessageId(), messages: [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const messages = await listNewMessagesFor(me.id, after, 5);
  return Response.json(
    { lastId: Math.max(await maxMessageId(), after), messages },
    { headers: { "Cache-Control": "no-store" } },
  );
}
