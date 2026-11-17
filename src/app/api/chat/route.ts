import { insertMessage, listMessages, userExists } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const peer = Number(url.searchParams.get("peer") ?? 0) || 0;
  const after = Number(url.searchParams.get("after") ?? 0) || 0;
  const messages = await listMessages(me.id, peer, after);
  return Response.json({ messages });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { peer?: number; content?: string } | null;
  const content = (body?.content ?? "").trim();
  const peer = Number(body?.peer ?? 0) || 0;
  if (!content) return Response.json({ error: "Пустое сообщение" }, { status: 400 });
  if (content.length > 4000) return Response.json({ error: "Слишком длинное сообщение" }, { status: 400 });
  if (peer === me.id) return Response.json({ error: "Нельзя писать самому себе" }, { status: 400 });
  if (peer !== 0 && !(await userExists(peer))) {
    return Response.json({ error: "Пользователь не найден" }, { status: 404 });
  }
  const id = await insertMessage(me.id, peer === 0 ? null : peer, content);
  return Response.json({ ok: true, id });
}
