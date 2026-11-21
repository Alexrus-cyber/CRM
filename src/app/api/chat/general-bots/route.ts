import { addGeneralBot, getChatBot, listGeneralBotIds, removeGeneralBot } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { publishLiveEvent } from "@/lib/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Боты, подключённые к # Общему чату (подключать/отключать может любой сотрудник). */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const botIds = await listGeneralBotIds();
  return Response.json({ botIds }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { botId?: number } | null;
  const botId = Number(body?.botId ?? 0) || 0;
  if (!botId) return Response.json({ error: "Укажите бота" }, { status: 400 });
  const bot = await getChatBot(botId);
  if (!bot) return Response.json({ error: "Бот не найден" }, { status: 404 });

  await addGeneralBot(botId, me.id);
  publishLiveEvent("chat", me.id);
  return Response.json({ ok: true, botIds: await listGeneralBotIds() });
}

export async function DELETE(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const botId = Number(new URL(req.url).searchParams.get("botId") ?? 0) || 0;
  if (!botId) return Response.json({ error: "Укажите бота" }, { status: 400 });

  await removeGeneralBot(botId);
  publishLiveEvent("chat", me.id);
  return Response.json({ ok: true, botIds: await listGeneralBotIds() });
}
