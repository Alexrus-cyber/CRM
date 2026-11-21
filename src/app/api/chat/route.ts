import {
  getPeerReadId,
  insertMessage,
  insertMessageAttachment,
  listGeneralReaders,
  listMessages,
  listMessagesAround,
  listMessagesBefore,
  userExists,
} from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { publishChatMessage } from "@/lib/events";

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
  const peer = Number(url.searchParams.get("peer") ?? 0) || 0;
  const after = Number(url.searchParams.get("after") ?? 0) || 0;
  const around = Number(url.searchParams.get("around") ?? 0) || 0;
  const before = Number(url.searchParams.get("before") ?? 0) || 0;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 30) || 30, 10), 100);
  if (peer === me.id) return Response.json({ error: "Нельзя писать самому себе" }, { status: 400 });
  if (peer !== 0 && !(await userExists(peer))) {
    return Response.json({ error: "Пользователь не найден" }, { status: 404 });
  }

  // Кто дочитал: для личной переписки — собеседник, для общей — все остальные.
  const [peerReadId, generalReaders] = await Promise.all([
    peer === 0 ? Promise.resolve(0) : getPeerReadId(me.id, peer),
    peer === 0 ? listGeneralReaders(me.id) : Promise.resolve([]),
  ]);

  if (around > 0) {
    const { messages, hasOlder, hasNewer } = await listMessagesAround(me.id, peer, around);
    return Response.json({ messages, peerReadId, generalReaders, context: { hasOlder, hasNewer } });
  }

  if (before > 0) {
    const { messages, hasOlder } = await listMessagesBefore(me.id, peer, before, limit);
    return Response.json({ messages, hasOlder, peerReadId, generalReaders });
  }

  const { messages, hasOlder } = await listMessages(me.id, peer, after, limit);
  return Response.json({ messages, hasOlder, peerReadId, generalReaders });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const contentType = req.headers.get("content-type") ?? "";
  let peer = 0;
  let content = "";
  let file: File | null = null;

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      peer = Number(form.get("peer") ?? 0) || 0;
      content = String(form.get("content") ?? "").trim();
      const raw = form.get("file");
      if (raw instanceof File && raw.size > 0) file = raw;
    } else {
      const body = (await req.json()) as { peer?: number; content?: string } | null;
      peer = Number(body?.peer ?? 0) || 0;
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
  if (peer === me.id) return Response.json({ error: "Нельзя писать самому себе" }, { status: 400 });
  if (peer !== 0 && !(await userExists(peer))) {
    return Response.json({ error: "Пользователь не найден" }, { status: 404 });
  }
  if (!unlimited && file && file.size > MAX_FILE_BYTES) {
    return Response.json({ error: "Файл больше 5 МБ" }, { status: 413 });
  }

  const recipientId = peer === 0 ? null : peer;
  const id = await insertMessage(me.id, recipientId, content);

  if (file) {
    const buffer = Buffer.from(await file.arrayBuffer());
    await insertMessageAttachment(id, {
      name: sanitizeFileName(file.name),
      mime: file.type || "application/octet-stream",
      size: file.size,
      data: buffer.toString("base64"),
    });
  }

  // Всплывающее уведомление у получателя (общий чат — у всех, кроме автора).
  publishChatMessage({
    messageId: id,
    senderId: me.id,
    senderName: me.name,
    senderColor: me.avatarColor,
    recipientId,
    preview: (content || (file ? `Вложение: ${file.name}` : "Новое сообщение")).slice(0, 160),
  });

  return Response.json({ ok: true, id });
}
