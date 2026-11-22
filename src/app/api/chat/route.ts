import {
  canAccessChatRoom,
  ensureRoomMember,
  getChatBot,
  getChatRoomForUser,
  getPeerReadId,
  getRoomActiveBots,
  insertMessage,
  insertMessageAttachment,
  listGeneralActiveBots,
  listGeneralReaders,
  listMessages,
  listMessagesAround,
  listMessagesBefore,
  listRoomReaders,
  touchChatRoom,
  userExists,
} from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { findTriggeredBots } from "@/lib/chatBot";
import { publishChatMessage } from "@/lib/events";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_TEXT = 4000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Имя файла без путей и управляющих символов. */
function sanitizeFileName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return (clean || "файл").slice(0, 120);
}

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const room = Math.max(0, Number(url.searchParams.get("room") ?? 0) || 0);
  const peer = room > 0 ? 0 : Number(url.searchParams.get("peer") ?? 0) || 0;
  const after = Number(url.searchParams.get("after") ?? 0) || 0;
  const around = Number(url.searchParams.get("around") ?? 0) || 0;
  const before = Number(url.searchParams.get("before") ?? 0) || 0;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 30) || 30, 10), 100);

  if (room > 0) {
    if (!(await canAccessChatRoom(me.id, room))) {
      return Response.json({ error: "Чат не найден" }, { status: 404 });
    }
  } else {
    if (peer === me.id) return Response.json({ error: "Нельзя писать самому себе" }, { status: 400 });
    if (peer !== 0 && !(await userExists(peer))) {
      return Response.json({ error: "Пользователь не найден" }, { status: 404 });
    }
  }

  // Кто дочитал: для личной переписки — собеседник, для общей/комнаты — все остальные.
  const [peerReadId, generalReaders, roomReaders] = await Promise.all([
    room > 0 || peer === 0 ? Promise.resolve(0) : getPeerReadId(me.id, peer),
    room === 0 && peer === 0 ? listGeneralReaders(me.id) : Promise.resolve([]),
    room > 0 ? listRoomReaders(me.id, room) : Promise.resolve([]),
  ]);

  if (around > 0) {
    const { messages, hasOlder, hasNewer } = await listMessagesAround(me.id, peer, around, room);
    return Response.json({ messages, peerReadId, generalReaders, roomReaders, context: { hasOlder, hasNewer } });
  }

  if (before > 0) {
    const { messages, hasOlder } = await listMessagesBefore(me.id, peer, before, limit, room);
    return Response.json({ messages, hasOlder, peerReadId, generalReaders, roomReaders });
  }

  const { messages, hasOlder } = await listMessages(me.id, peer, after, limit, room);
  return Response.json({ messages, hasOlder, peerReadId, generalReaders, roomReaders });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const rl = checkApiRateLimit({
    scope: "chat_send",
    userId: me.id,
    ip: extractClientIp(req.headers),
    maxRequests: 60,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const contentType = req.headers.get("content-type") ?? "";
  let peer = 0;
  let room = 0;
  let triggerBotId = 0;
  let content = "";
  let file: File | null = null;

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      room = Math.max(0, Number(form.get("room") ?? 0) || 0);
      peer = room > 0 ? 0 : Number(form.get("peer") ?? 0) || 0;
      triggerBotId = Math.max(0, Number(form.get("triggerBotId") ?? 0) || 0);
      content = String(form.get("content") ?? "").trim();
      const raw = form.get("file");
      if (raw instanceof File && raw.size > 0) file = raw;
    } else {
      const body = (await req.json()) as { peer?: number; room?: number; triggerBotId?: number; content?: string } | null;
      room = Math.max(0, Number(body?.room ?? 0) || 0);
      peer = room > 0 ? 0 : Number(body?.peer ?? 0) || 0;
      triggerBotId = Math.max(0, Number(body?.triggerBotId ?? 0) || 0);
      content = (body?.content ?? "").trim();
    }
  } catch {
    return Response.json({ error: "Некорректный запрос" }, { status: 400 });
  }

  const unlimited = me.role === "super_admin";
  if (!content && !file) return Response.json({ error: "Пустое сообщение" }, { status: 400 });
  if (!unlimited && content.length > MAX_TEXT) {
    return Response.json({ error: "Слишком длинное сообщение" }, { status: 400 });
  }

  let roomInfo: Awaited<ReturnType<typeof getChatRoomForUser>> = null;
  if (room > 0) {
    roomInfo = await getChatRoomForUser(me.id, room);
    if (!roomInfo) return Response.json({ error: "Чат не найден" }, { status: 404 });
    if (!roomInfo.isMember) {
      const joined = await ensureRoomMember(room, me.id, me.id);
      if (!joined) return Response.json({ error: "Нет доступа к этому чату" }, { status: 403 });
      roomInfo = await getChatRoomForUser(me.id, room);
    }
  } else {
    if (peer === me.id) return Response.json({ error: "Нельзя писать самому себе" }, { status: 400 });
    if (peer !== 0 && !(await userExists(peer))) {
      return Response.json({ error: "Пользователь не найден" }, { status: 404 });
    }
  }

  if (!unlimited && file && file.size > MAX_FILE_BYTES) {
    return Response.json({ error: "Файл больше 5 МБ" }, { status: 413 });
  }

  const recipientId = room > 0 ? null : peer === 0 ? null : peer;
  const id = await insertMessage(me.id, recipientId, content, room > 0 ? room : null);
  if (room > 0) {
    await touchChatRoom(room);
  }

  if (file) {
    const buffer = Buffer.from(await file.arrayBuffer());
    await insertMessageAttachment(id, {
      name: sanitizeFileName(file.name),
      mime: file.type || "application/octet-stream",
      size: file.size,
      data: buffer.toString("base64"),
    });
  }

  let triggeredBotIds: number[] = [];
  if (room > 0) {
    const activeBots = await getRoomActiveBots(room);
    triggeredBotIds = findTriggeredBots(activeBots, content, { triggerBotId });
  } else if (peer === 0) {
    const activeBots = await listGeneralActiveBots();
    triggeredBotIds = findTriggeredBots(activeBots, content, { triggerBotId });
  } else {
    const bot = await getChatBot(peer);
    if (bot && bot.isActive) {
      triggeredBotIds = [bot.userId];
    }
  }

  // Всплывающее уведомление участникам.
  publishChatMessage({
    messageId: id,
    senderId: me.id,
    senderName: me.name,
    senderColor: me.avatarColor,
    recipientId,
    roomId: room > 0 ? room : null,
    roomName: roomInfo?.name ?? null,
    isSharedRoom: roomInfo ? roomInfo.kind === "shared" : false,
    memberIds: roomInfo ? roomInfo.members.map((m) => m.userId) : undefined,
    preview: (content || (file ? `Вложение: ${file.name}` : "Новое сообщение")).slice(0, 160),
  });

  return Response.json({ ok: true, id, triggeredBotIds });
}
