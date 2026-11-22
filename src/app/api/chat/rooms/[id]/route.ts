import {
  addChatRoomMember,
  deleteChatRoom,
  ensureRoomMember,
  getChatBot,
  getChatRoomForUser,
  getUser,
  removeChatRoomMember,
  updateChatRoomInfo,
} from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { publishLiveEvent } from "@/lib/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const roomId = Number((await params).id) || 0;
  if (!roomId) return Response.json({ error: "Некорректный чат" }, { status: 400 });

  const room = await getChatRoomForUser(me.id, roomId);
  if (!room) return Response.json({ error: "Чат не найден" }, { status: 404 });

  return Response.json({ room }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Управление участниками и ботами группового/общего чата:
 *   - войти в открытый общий чат (`action: "join"`) или выйти (`action: "leave"`) — любой пользователь;
 *   - подключить/убрать бота, добавить/удалить участника, переименовать/изменить описание —
 *     только владелец комнаты (`myRole === "owner"` / `createdBy === me.id`) или `super_admin` (P1).
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const roomId = Number((await params).id) || 0;
  if (!roomId) return Response.json({ error: "Некорректный чат" }, { status: 400 });

  const room = await getChatRoomForUser(me.id, roomId);
  if (!room) return Response.json({ error: "Чат не найден" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as
    | {
        action?: string;
        name?: string;
        description?: string;
        addMemberIds?: unknown;
        removeMemberId?: number;
        addBotId?: number;
        removeBotId?: number;
      }
    | null;

  if (!body) return Response.json({ error: "Пустой запрос" }, { status: 400 });

  if (body.action === "join") {
    if (room.kind !== "shared" && !room.isMember) {
      return Response.json({ error: "В закрытую группу добавляют участники" }, { status: 403 });
    }
    await ensureRoomMember(roomId, me.id, me.id);
    const updated = await getChatRoomForUser(me.id, roomId);
    publishLiveEvent("chat", me.id);
    return Response.json({ room: updated });
  }

  if (body.action === "leave") {
    await removeChatRoomMember(roomId, me.id);
    publishLiveEvent("chat", me.id);
    return Response.json({ ok: true });
  }

  const canManageRoom =
    me.role === "super_admin" ||
    room.myRole === "owner" ||
    (room.createdBy !== null && room.createdBy === me.id);
  if (!canManageRoom) {
    return Response.json(
      { error: "Управлять участниками, ботами и настройками чата может только его владелец или главный администратор" },
      { status: 403 },
    );
  }

  if (body.addBotId) {
    const bot = await getChatBot(Number(body.addBotId));
    if (!bot) return Response.json({ error: "Бот не найден" }, { status: 404 });
    await addChatRoomMember(roomId, bot.userId, me.id);
  }

  if (body.removeBotId) {
    const bot = await getChatBot(Number(body.removeBotId));
    if (bot) await removeChatRoomMember(roomId, bot.userId);
  }

  if (Array.isArray(body.addMemberIds)) {
    for (const rawId of body.addMemberIds) {
      const uid = Number(rawId) || 0;
      if (uid <= 0) continue;
      const target = await getUser(uid);
      if (target) await addChatRoomMember(roomId, uid, me.id);
    }
  }

  if (body.removeMemberId) {
    const uid = Number(body.removeMemberId) || 0;
    if (uid > 0) await removeChatRoomMember(roomId, uid);
  }

  if (body.name !== undefined || body.description !== undefined) {
    await updateChatRoomInfo(roomId, {
      ...(body.name !== undefined ? { name: String(body.name) } : {}),
      ...(body.description !== undefined ? { description: String(body.description) } : {}),
    });
  }

  const updated = await getChatRoomForUser(me.id, roomId);
  publishLiveEvent("chat", me.id);
  return Response.json({ room: updated }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const roomId = Number((await params).id) || 0;
  if (!roomId) return Response.json({ error: "Некорректный чат" }, { status: 400 });

  const room = await getChatRoomForUser(me.id, roomId);
  if (!room) return Response.json({ error: "Чат не найден" }, { status: 404 });

  if (room.createdBy !== me.id && me.role !== "super_admin") {
    return Response.json({ error: "Удалить чат может только создатель или главный админ" }, { status: 403 });
  }

  await deleteChatRoom(roomId);
  publishLiveEvent("chat", me.id);
  return Response.json({ ok: true });
}
