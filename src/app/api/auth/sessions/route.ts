import { listUserSessions, revokeOtherSessions, revokeSessionById } from "@/db/repo";
import { getCurrentSessionToken, getRequestUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await getRequestUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const currentToken = await getCurrentSessionToken();
  const sessions = await listUserSessions(user.id, currentToken);
  return Response.json({ sessions }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: Request) {
  const user = await getRequestUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  if (url.searchParams.get("others") === "1") {
    const currentToken = await getCurrentSessionToken();
    if (!currentToken) {
      return Response.json({ error: "Текущая сессия не определена" }, { status: 400 });
    }
    const revoked = await revokeOtherSessions(user.id, currentToken);
    return Response.json({ ok: true, revoked }, { headers: { "Cache-Control": "no-store" } });
  }

  const sessionId = Number(url.searchParams.get("id") ?? 0) || 0;
  if (!sessionId) {
    return Response.json({ error: "Укажите id сессии или others=1" }, { status: 400 });
  }

  const ok = await revokeSessionById(user.id, sessionId);
  if (!ok) return Response.json({ error: "Сессия не найдена" }, { status: 404 });
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
