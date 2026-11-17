import { searchMessages, userExists } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

/** Поиск по переписке с конкретным человеком (peer = 0 — общий чат). */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const peer = Number(url.searchParams.get("peer") ?? 0) || 0;
  const query = (url.searchParams.get("q") ?? "").trim();
  if (peer !== 0 && !(await userExists(peer))) {
    return Response.json({ error: "Пользователь не найден" }, { status: 404 });
  }
  if (query.length < 2) return Response.json({ results: [] });

  const results = await searchMessages(me.id, peer, query.slice(0, 120), 50);
  return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
}
