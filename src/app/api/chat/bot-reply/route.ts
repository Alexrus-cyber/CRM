import {
  getChatBot,
  getChatRoomForUser,
  listGeneralBotIds,
} from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { runChatBotReply } from "@/lib/chatBot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Генерация ответа модели-бота в командном чате (`POST /api/chat/bot-reply`).
 * Работает в личке с ботом, в # Общем чате (если бот подключён) и в групповых/общих комнатах.
 */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { botUserId?: number; peer?: number; room?: number }
    | null;

  const botUserId = Number(body?.botUserId ?? 0) || 0;
  const peer = Number(body?.peer ?? 0) || 0;
  const roomId = Number(body?.room ?? 0) || 0;
  if (!botUserId) return Response.json({ error: "Укажите бота" }, { status: 400 });

  const bot = await getChatBot(botUserId);
  if (!bot) return Response.json({ error: "Бот не найден" }, { status: 404 });
  if (!bot.isActive) return Response.json({ error: "Бот сейчас выключен" }, { status: 409 });

  if (roomId > 0) {
    const room = await getChatRoomForUser(me.id, roomId);
    if (!room) return Response.json({ error: "Чат не найден" }, { status: 404 });
    if (!room.members.some((m) => m.userId === botUserId)) {
      return Response.json({ error: "Этот бот не добавлен в выбранный чат" }, { status: 400 });
    }
  } else if (peer === 0) {
    const generalBotIds = await listGeneralBotIds();
    if (!generalBotIds.includes(botUserId)) {
      return Response.json({ error: "Этот бот не добавлен в Общий чат" }, { status: 400 });
    }
  } else if (peer !== botUserId) {
    return Response.json({ error: "Неверная переписка для ответа бота" }, { status: 400 });
  }

  const result = await runChatBotReply({
    botUserId,
    requesterId: me.id,
    peerId: peer,
    roomId: roomId > 0 ? roomId : null,
  });

  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 502 });
  }

  return Response.json({ ok: true, id: result.messageId });
}
