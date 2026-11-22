import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { nowIso, q, q1, toBool, toIso, toNum } from "../dialect";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { deleteStoredFile, readStoredBase64, saveStoredBase64 } from "@/lib/storage";
import type { ChatRoomKind } from "../schema";
import type { Raw } from "./shared";

export type ChatAttachmentMeta = {
  id: number;
  name: string;
  mime: string;
  size: number;
};

export type ChatMessage = {
  id: number;
  senderId: number;
  recipientId: number | null;
  roomId: number | null;
  content: string;
  createdAt: string;
  senderName: string;
  senderColor: string;
  senderAvatar: string | null;
  senderIsBot: boolean;
  attachment: ChatAttachmentMeta | null;
};

export type ChatAttachmentRow = ChatAttachmentMeta & {
  messageId: number;
  senderId: number;
  recipientId: number | null;
  roomId: number | null;
  data: string;
};

export type ChatNotificationRow = {
  id: number;
  senderId: number;
  senderName: string;
  senderColor: string;
  recipientId: number | null;
  roomId: number | null;
  roomName: string | null;
  preview: string;
  createdAt: string;
};

export type ChatBotRow = {
  userId: number;
  name: string;
  position: string | null;
  bio: string | null;
  avatarColor: string;
  avatarUrl: string | null;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  paramsJson: string;
  replyMode: "mention" | "always";
  isActive: boolean;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatRoomMemberRow = {
  userId: number;
  name: string;
  position: string | null;
  avatarColor: string;
  avatarUrl: string | null;
  isBot: boolean;
  role: "owner" | "member";
};

export type ChatRoomRow = {
  id: number;
  name: string;
  description: string;
  kind: ChatRoomKind;
  createdBy: number | null;
  isMember: boolean;
  myRole: "owner" | "member" | null;
  members: ChatRoomMemberRow[];
  createdAt: string;
  updatedAt: string;
};

function conversationFilter(meId: number, peer: number, room = 0) {
  if (room > 0) return sql`m.room_id = ${room}`;
  return peer === 0
    ? sql`m.room_id is null and m.recipient_id is null`
    : sql`m.room_id is null and ((m.sender_id = ${meId} and m.recipient_id = ${peer}) or (m.sender_id = ${peer} and m.recipient_id = ${meId}))`;
}

const MESSAGE_SELECT = sql`m.id, m.sender_id, m.recipient_id, m.room_id, m.content, m.created_at,
  u.name as sender_name, u.avatar_color as sender_color, u.avatar_url as sender_avatar, u.is_bot as sender_is_bot,
  a.id as attachment_id, a.name as attachment_name, a.mime as attachment_mime, a.size as attachment_size`;

const MESSAGE_FROM = sql`from messages m
  join users u on u.id = m.sender_id
  left join message_attachments a on a.message_id = m.id`;

function mapMessage(r: Raw): ChatMessage {
  return {
    id: toNum(r.id),
    senderId: toNum(r.sender_id),
    recipientId: r.recipient_id === null || r.recipient_id === undefined ? null : toNum(r.recipient_id),
    roomId: r.room_id === null || r.room_id === undefined ? null : toNum(r.room_id),
    content: String(r.content),
    createdAt: toIso(r.created_at) ?? nowIso(),
    senderName: String(r.sender_name ?? ""),
    senderColor: String(r.sender_color ?? "#7c5cff"),
    senderAvatar: (r.sender_avatar as string | null) ?? null,
    senderIsBot: toBool(r.sender_is_bot),
    attachment: r.attachment_id === null || r.attachment_id === undefined
      ? null
      : {
          id: toNum(r.attachment_id),
          name: String(r.attachment_name ?? "файл"),
          mime: String(r.attachment_mime ?? "application/octet-stream"),
          size: toNum(r.attachment_size),
        },
  };
}

export async function messageCountsBySender(): Promise<Map<number, number>> {
  const rows = await q(sql`select sender_id, count(*) as c from messages group by sender_id`);
  return new Map(rows.map((r) => [toNum(r.sender_id), toNum(r.c)]));
}

export async function listMessages(
  meId: number,
  peer: number,
  afterId: number,
  limit = 30,
  room = 0,
): Promise<{ messages: ChatMessage[]; hasOlder: boolean }> {
  const conversation = conversationFilter(meId, peer, room);
  const filter = afterId > 0 ? sql`${conversation} and m.id > ${afterId}` : conversation;
  const rows = await q(sql`select ${MESSAGE_SELECT} ${MESSAGE_FROM} where ${filter} order by m.id desc limit ${limit}`);
  const messages = rows.map(mapMessage).reverse();
  const oldestId = messages[0]?.id ?? 0;
  const hasOlder = oldestId > 0 && afterId === 0
    ? Boolean(await q1(sql`select 1 as ok ${MESSAGE_FROM} where ${conversation} and m.id < ${oldestId} limit 1`))
    : false;
  return { messages, hasOlder };
}

export async function listMessagesBefore(
  meId: number,
  peer: number,
  beforeId: number,
  limit = 30,
  room = 0,
): Promise<{ messages: ChatMessage[]; hasOlder: boolean }> {
  const conversation = conversationFilter(meId, peer, room);
  const rows = await q(sql`
    select ${MESSAGE_SELECT} ${MESSAGE_FROM}
    where ${conversation} and m.id < ${beforeId}
    order by m.id desc limit ${limit}`);
  const messages = rows.map(mapMessage).reverse();
  const oldestId = messages[0]?.id ?? 0;
  const hasOlder = oldestId > 0
    ? Boolean(await q1(sql`select 1 as ok ${MESSAGE_FROM} where ${conversation} and m.id < ${oldestId} limit 1`))
    : false;
  return { messages, hasOlder };
}

export async function listMessagesAround(
  meId: number,
  peer: number,
  messageId: number,
  room = 0,
): Promise<{ messages: ChatMessage[]; hasOlder: boolean; hasNewer: boolean }> {
  const conversation = conversationFilter(meId, peer, room);
  const before = await q(sql`
    select ${MESSAGE_SELECT} ${MESSAGE_FROM}
    where ${conversation} and m.id <= ${messageId}
    order by m.id desc limit 60`);
  const after = await q(sql`
    select ${MESSAGE_SELECT} ${MESSAGE_FROM}
    where ${conversation} and m.id > ${messageId}
    order by m.id asc limit 60`);
  const messages = [...before.map(mapMessage).reverse(), ...after.map(mapMessage)];
  const minId = messages[0]?.id ?? 0;
  const hasOlder = minId > 0
    ? Boolean(await q1(sql`select 1 as ok ${MESSAGE_FROM} where ${conversation} and m.id < ${minId} limit 1`))
    : false;
  const maxId = messages.at(-1)?.id ?? 0;
  const hasNewer = maxId > 0
    ? Boolean(await q1(sql`select 1 as ok ${MESSAGE_FROM} where ${conversation} and m.id > ${maxId} limit 1`))
    : false;
  return { messages, hasOlder, hasNewer };
}

export async function insertMessage(
  senderId: number,
  recipientId: number | null,
  content: string,
  roomId: number | null = null,
): Promise<number> {
  const row = await q1<{ id: number }>(sql`
    insert into messages (sender_id, recipient_id, room_id, content, content_lower, created_at)
    values (${senderId}, ${roomId ? null : recipientId}, ${roomId}, ${content}, ${content.toLowerCase()}, ${nowIso()}) returning id`);
  return toNum(row?.id);
}

/** Вложение к сообщению сохраняется в файловом хранилище (`storage_key`), не раздувая БД. */
export async function insertMessageAttachment(
  messageId: number,
  file: { name: string; mime: string; size: number; data: string },
): Promise<number> {
  const stored = await saveStoredBase64("chat", file.data, file.name);
  const row = await q1<{ id: number }>(sql`
    insert into message_attachments (message_id, name, name_lower, mime, size, storage_key, data, created_at)
    values (${messageId}, ${file.name}, ${file.name.toLowerCase()}, ${file.mime}, ${file.size || stored.byteSize}, ${stored.storageKey}, '', ${nowIso()})
    returning id`);
  return toNum(row?.id);
}

export async function getMessageAttachment(id: number): Promise<ChatAttachmentRow | null> {
  const row = await q1(sql`
    select a.id, a.message_id, a.name, a.mime, a.size, a.storage_key, a.data, m.sender_id, m.recipient_id, m.room_id
    from message_attachments a join messages m on m.id = a.message_id
    where a.id = ${id} limit 1`);
  if (!row) return null;
  const storageKey = String(row.storage_key ?? "");
  let data = String(row.data ?? "");
  if (storageKey) {
    const diskData = await readStoredBase64(storageKey);
    if (diskData !== null) data = diskData;
  }
  return {
    id: toNum(row.id),
    messageId: toNum(row.message_id),
    name: String(row.name),
    mime: String(row.mime),
    size: toNum(row.size),
    data,
    senderId: toNum(row.sender_id),
    recipientId: row.recipient_id === null || row.recipient_id === undefined ? null : toNum(row.recipient_id),
    roomId: row.room_id === null || row.room_id === undefined ? null : toNum(row.room_id),
  };
}

export async function markChatRead(userId: number, peerId: number, lastReadId: number): Promise<void> {
  if (lastReadId <= 0) return;
  const existing = await q1<{ id: number; last_read_id: number }>(sql`
    select id, last_read_id from chat_reads where user_id = ${userId} and peer_id = ${peerId} limit 1`);
  if (!existing) {
    await q(sql`
      insert into chat_reads (user_id, peer_id, last_read_id, updated_at)
      values (${userId}, ${peerId}, ${lastReadId}, ${nowIso()})`);
    return;
  }
  if (toNum(existing.last_read_id) >= lastReadId) return;
  await q(sql`update chat_reads set last_read_id = ${lastReadId}, updated_at = ${nowIso()} where id = ${toNum(existing.id)}`);
}

export async function markRoomRead(userId: number, roomId: number, lastReadId: number): Promise<void> {
  if (lastReadId <= 0 || roomId <= 0) return;
  const existing = await q1<{ id: number; last_read_id: number }>(sql`
    select id, last_read_id from chat_room_reads where user_id = ${userId} and room_id = ${roomId} limit 1`);
  if (!existing) {
    await q(sql`
      insert into chat_room_reads (user_id, room_id, last_read_id, updated_at)
      values (${userId}, ${roomId}, ${lastReadId}, ${nowIso()})`);
    return;
  }
  if (toNum(existing.last_read_id) >= lastReadId) return;
  await q(sql`update chat_room_reads set last_read_id = ${lastReadId}, updated_at = ${nowIso()} where id = ${toNum(existing.id)}`);
}

export async function getPeerReadId(meId: number, peerId: number): Promise<number> {
  const row = await q1<{ last_read_id: number }>(sql`
    select last_read_id from chat_reads where user_id = ${peerId} and peer_id = ${meId} limit 1`);
  return row ? toNum(row.last_read_id) : 0;
}

export async function listGeneralReaders(meId: number): Promise<Array<{ userId: number; lastReadId: number }>> {
  const rows = await q(sql`
    select user_id, last_read_id from chat_reads where peer_id = 0 and user_id <> ${meId}`);
  return rows.map((r) => ({ userId: toNum(r.user_id), lastReadId: toNum(r.last_read_id) }));
}

export async function listRoomReaders(meId: number, roomId: number): Promise<Array<{ userId: number; lastReadId: number }>> {
  const rows = await q(sql`
    select user_id, last_read_id from chat_room_reads where room_id = ${roomId} and user_id <> ${meId}`);
  return rows.map((r) => ({ userId: toNum(r.user_id), lastReadId: toNum(r.last_read_id) }));
}

export async function maxConversationMessageId(meId: number, peer: number, room = 0): Promise<number> {
  const row = await q1<{ id: number | null }>(sql`
    select max(m.id) as id ${MESSAGE_FROM} where ${conversationFilter(meId, peer, room)}`);
  return row ? toNum(row.id) : 0;
}

export async function unreadCounts(meId: number): Promise<Record<string, number>> {
  const rows = await q(sql`
    select t.peer as peer, count(*) as c
    from (
      select case
               when m.recipient_id is null then 0
               when m.sender_id = ${meId} then m.recipient_id
               else m.sender_id
             end as peer,
             m.id as id
      from messages m
      where m.room_id is null
        and m.sender_id <> ${meId}
        and (m.recipient_id is null or m.recipient_id = ${meId})
    ) t
    left join chat_reads r on r.user_id = ${meId} and r.peer_id = t.peer
    where t.id > coalesce(r.last_read_id, 0)
    group by t.peer`);
  const result: Record<string, number> = {};
  for (const row of rows) result[String(toNum(row.peer))] = toNum(row.c);
  return result;
}

export async function unreadRoomCounts(meId: number): Promise<Record<string, number>> {
  const rows = await q(sql`
    select m.room_id as room_id, count(*) as c
    from messages m
    join chat_rooms cr on cr.id = m.room_id
    left join chat_room_reads r on r.user_id = ${meId} and r.room_id = m.room_id
    where m.room_id is not null
      and m.sender_id <> ${meId}
      and (
        cr.kind = 'shared'
        or exists (
          select 1 from chat_room_members cm
          where cm.room_id = m.room_id and cm.user_id = ${meId}
        )
      )
      and m.id > coalesce(r.last_read_id, 0)
    group by m.room_id`);
  const result: Record<string, number> = {};
  for (const row of rows) result[String(toNum(row.room_id))] = toNum(row.c);
  return result;
}

export async function searchMessages(
  meId: number,
  peer: number,
  query: string,
  limit = 50,
  room = 0,
): Promise<ChatMessage[]> {
  const clean = query.toLowerCase().replace(/[%_\\]/g, "").trim();
  if (!clean) return [];
  const needle = `%${clean}%`;
  const rows = await q(sql`
    select ${MESSAGE_SELECT} ${MESSAGE_FROM}
    where ${conversationFilter(meId, peer, room)}
      and (m.content_lower like ${needle} or a.name_lower like ${needle})
    order by m.id desc limit ${limit}`);
  return rows.map(mapMessage).reverse();
}

export async function maxMessageId(): Promise<number> {
  const row = await q1<{ id: number | null }>(sql`select max(id) as id from messages`);
  return row ? toNum(row.id) : 0;
}

export async function listNewMessagesFor(meId: number, afterId: number, limit = 5): Promise<ChatNotificationRow[]> {
  const rows = await q(sql`
    select m.id, m.sender_id, m.recipient_id, m.room_id, cr.name as room_name,
      m.content, m.created_at,
      u.name as sender_name, u.avatar_color as sender_color,
      a.name as attachment_name
    from messages m
    join users u on u.id = m.sender_id
    left join chat_rooms cr on cr.id = m.room_id
    left join message_attachments a on a.message_id = m.id
    where m.id > ${afterId}
      and m.sender_id <> ${meId}
      and (
        (m.room_id is null and (m.recipient_id is null or m.recipient_id = ${meId}))
        or (
          m.room_id is not null and (
            cr.kind = 'shared'
            or exists (
              select 1 from chat_room_members cm
              where cm.room_id = m.room_id and cm.user_id = ${meId}
            )
          )
        )
      )
    order by m.id asc
    limit ${limit}`);
  return rows.map((r) => {
    const text = String(r.content ?? "").replace(/\s+/g, " ").trim();
    const attachment = r.attachment_name ? String(r.attachment_name) : "";
    const preview = text || (attachment ? `Вложение: ${attachment}` : "Новое сообщение");
    return {
      id: toNum(r.id),
      senderId: toNum(r.sender_id),
      senderName: String(r.sender_name ?? ""),
      senderColor: String(r.sender_color ?? "#7c5cff"),
      recipientId: r.recipient_id === null || r.recipient_id === undefined ? null : toNum(r.recipient_id),
      roomId: r.room_id === null || r.room_id === undefined ? null : toNum(r.room_id),
      roomName: (r.room_name as string | null) ?? null,
      preview: preview.length > 160 ? `${preview.slice(0, 160)}…` : preview,
      createdAt: toIso(r.created_at) ?? nowIso(),
    };
  });
}

/* ------------- групповые/общие чаты и модели-боты ------------------ */

function mapChatBot(r: Raw): ChatBotRow {
  const rawKey = String(r.api_key ?? "");
  return {
    userId: toNum(r.user_id ?? r.id),
    name: String(r.name ?? "Модель ИИ"),
    position: (r.position as string | null) ?? null,
    bio: (r.bio as string | null) ?? null,
    avatarColor: String(r.avatar_color ?? "#06b6d4"),
    avatarUrl: (r.avatar_url as string | null) ?? null,
    provider: String(r.provider ?? "local"),
    baseUrl: String(r.base_url ?? ""),
    apiKey: rawKey ? decryptSecret(rawKey) : "",
    model: String(r.model ?? ""),
    systemPrompt: String(r.system_prompt ?? ""),
    paramsJson: String(r.params_json ?? "{}"),
    replyMode: r.reply_mode === "always" ? "always" : "mention",
    isActive: toBool(r.is_active),
    createdBy: r.created_by === null || r.created_by === undefined ? null : toNum(r.created_by),
    createdAt: toIso(r.created_at) ?? nowIso(),
    updatedAt: toIso(r.updated_at) ?? nowIso(),
  };
}

export async function listChatBots(): Promise<ChatBotRow[]> {
  const rows = await q(sql`
    select u.id as user_id, u.name, u.position, u.bio, u.avatar_color, u.avatar_url,
      c.provider, c.base_url, c.api_key, c.model, c.system_prompt, c.params_json,
      c.reply_mode, c.is_active, c.created_by, c.created_at, c.updated_at
    from users u
    join ai_bot_configs c on c.user_id = u.id
    where u.is_bot = true
    order by u.name asc`);
  return rows.map(mapChatBot);
}

export async function getChatBot(botUserId: number): Promise<ChatBotRow | null> {
  const row = await q1(sql`
    select u.id as user_id, u.name, u.position, u.bio, u.avatar_color, u.avatar_url,
      c.provider, c.base_url, c.api_key, c.model, c.system_prompt, c.params_json,
      c.reply_mode, c.is_active, c.created_by, c.created_at, c.updated_at
    from users u
    join ai_bot_configs c on c.user_id = u.id
    where u.is_bot = true and u.id = ${botUserId}
    limit 1`);
  return row ? mapChatBot(row) : null;
}

export async function createChatBot(input: {
  createdBy: number;
  name: string;
  position?: string | null;
  bio?: string | null;
  avatarColor?: string;
  avatarUrl?: string | null;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  systemPrompt?: string;
  paramsJson?: string;
  replyMode?: "mention" | "always";
  isActive?: boolean;
}): Promise<ChatBotRow> {
  const now = nowIso();
  const suffix = randomBytes(8).toString("hex");
  const email = `bot-${suffix}@bot.crm.local`;
  const fakeHash = `bot:${randomBytes(24).toString("hex")}`;
  const name = input.name.trim().slice(0, 80) || "Модель ИИ";
  const position = input.position?.trim().slice(0, 80) || "ИИ-модель (бот)";
  const bio = input.bio?.trim().slice(0, 500) || null;
  const avatarColor = input.avatarColor?.trim() || "#06b6d4";
  const avatarUrl = input.avatarUrl?.trim() || null;

  const userRow = await q1<{ id: number }>(sql`
    insert into users (email, password_hash, name, position, bio, role, avatar_color, avatar_url, is_bot, can_use_agent, can_use_operator, created_at, updated_at)
    values (${email}, ${fakeHash}, ${name}, ${position}, ${bio}, 'user', ${avatarColor}, ${avatarUrl}, true, false, false, ${now}, ${now})
    returning id`);
  const userId = toNum(userRow?.id);

  const plainApiKey = String(input.apiKey ?? "").trim().slice(0, 400);
  const encryptedApiKey = plainApiKey ? encryptSecret(plainApiKey) : "";

  await q(sql`
    insert into ai_bot_configs (user_id, provider, base_url, api_key, model, system_prompt, params_json, reply_mode, is_active, created_by, created_at, updated_at)
    values (${userId}, ${String(input.provider ?? "local").slice(0, 40)}, ${String(input.baseUrl ?? "").trim().slice(0, 400)},
            ${encryptedApiKey}, ${String(input.model ?? "").trim().slice(0, 160)},
            ${String(input.systemPrompt ?? "").slice(0, 4000)}, ${String(input.paramsJson ?? "{}").slice(0, 2000)},
            ${input.replyMode === "always" ? "always" : "mention"}, ${input.isActive !== false},
            ${input.createdBy}, ${now}, ${now})`);

  const created = await getChatBot(userId);
  if (!created) throw new Error("Не удалось создать бота");
  return created;
}

export async function updateChatBot(
  botUserId: number,
  input: {
    name?: string;
    position?: string | null;
    bio?: string | null;
    avatarColor?: string;
    avatarUrl?: string | null;
    provider?: string;
    baseUrl?: string;
    apiKey?: string;
    clearApiKey?: boolean;
    model?: string;
    systemPrompt?: string;
    paramsJson?: string;
    replyMode?: "mention" | "always";
    isActive?: boolean;
  },
): Promise<ChatBotRow | null> {
  const existing = await getChatBot(botUserId);
  if (!existing) return null;
  const now = nowIso();
  const nextName = input.name !== undefined ? input.name.trim().slice(0, 80) || existing.name : existing.name;
  const nextPosition = input.position !== undefined ? input.position?.trim().slice(0, 80) || null : existing.position;
  const nextBio = input.bio !== undefined ? input.bio?.trim().slice(0, 500) || null : existing.bio;
  const nextColor = input.avatarColor !== undefined ? input.avatarColor.trim() || existing.avatarColor : existing.avatarColor;
  const nextAvatar = input.avatarUrl !== undefined ? input.avatarUrl?.trim() || null : existing.avatarUrl;

  await q(sql`
    update users
    set name = ${nextName}, position = ${nextPosition}, bio = ${nextBio},
        avatar_color = ${nextColor}, avatar_url = ${nextAvatar}, updated_at = ${now}
    where id = ${botUserId} and is_bot = true`);

  const nextProvider = input.provider !== undefined ? String(input.provider).slice(0, 40) : existing.provider;
  const nextBaseUrl = input.baseUrl !== undefined ? String(input.baseUrl).trim().slice(0, 400) : existing.baseUrl;
  const nextPlainKey = input.clearApiKey
    ? ""
    : input.apiKey !== undefined && input.apiKey.trim() !== ""
      ? input.apiKey.trim().slice(0, 400)
      : existing.apiKey;
  const nextEncryptedKey = nextPlainKey ? encryptSecret(nextPlainKey) : "";
  const nextModel = input.model !== undefined ? String(input.model).trim().slice(0, 160) : existing.model;
  const nextPrompt = input.systemPrompt !== undefined ? String(input.systemPrompt).slice(0, 4000) : existing.systemPrompt;
  const nextParams = input.paramsJson !== undefined ? String(input.paramsJson).slice(0, 2000) : existing.paramsJson;
  const nextReplyMode = input.replyMode !== undefined ? (input.replyMode === "always" ? "always" : "mention") : existing.replyMode;
  const nextActive = input.isActive !== undefined ? Boolean(input.isActive) : existing.isActive;

  await q(sql`
    update ai_bot_configs
    set provider = ${nextProvider}, base_url = ${nextBaseUrl}, api_key = ${nextEncryptedKey},
        model = ${nextModel}, system_prompt = ${nextPrompt}, params_json = ${nextParams},
        reply_mode = ${nextReplyMode}, is_active = ${nextActive}, updated_at = ${now}
    where user_id = ${botUserId}`);

  return getChatBot(botUserId);
}

export async function deleteChatBot(botUserId: number): Promise<boolean> {
  const existing = await getChatBot(botUserId);
  if (!existing) return false;
  const attachmentRows = await q<{ storage_key: string }>(sql`
    select ma.storage_key
    from message_attachments ma
    join messages m on m.id = ma.message_id
    where m.sender_id = ${botUserId} or m.recipient_id = ${botUserId}`);

  await q(sql`delete from chat_general_bots where bot_user_id = ${botUserId}`);
  await q(sql`delete from chat_room_members where user_id = ${botUserId}`);
  await q(sql`delete from message_attachments where message_id in (select id from messages where sender_id = ${botUserId} or recipient_id = ${botUserId})`);
  await q(sql`delete from messages where sender_id = ${botUserId} or recipient_id = ${botUserId}`);
  await q(sql`delete from ai_bot_configs where user_id = ${botUserId}`);
  await q(sql`delete from users where id = ${botUserId} and is_bot = true`);

  for (const row of attachmentRows) {
    if (row.storage_key) {
      await deleteStoredFile(String(row.storage_key));
    }
  }
  return true;
}

export async function listGeneralBotIds(): Promise<number[]> {
  const rows = await q(sql`
    select g.bot_user_id
    from chat_general_bots g
    join users u on u.id = g.bot_user_id
    where u.is_bot = true
    order by g.id asc`);
  return rows.map((r) => toNum(r.bot_user_id));
}

export async function listGeneralActiveBots(): Promise<ChatBotRow[]> {
  const rows = await q(sql`
    select u.id as user_id, u.name, u.position, u.bio, u.avatar_color, u.avatar_url,
      c.provider, c.base_url, c.api_key, c.model, c.system_prompt, c.params_json,
      c.reply_mode, c.is_active, c.created_by, c.created_at, c.updated_at
    from chat_general_bots g
    join users u on u.id = g.bot_user_id
    join ai_bot_configs c on c.user_id = u.id
    where u.is_bot = true and c.is_active = true
    order by u.name asc`);
  return rows.map(mapChatBot);
}

export async function addGeneralBot(botUserId: number, addedBy: number): Promise<boolean> {
  const bot = await getChatBot(botUserId);
  if (!bot) return false;
  const existing = await q1<{ id: number }>(sql`select id from chat_general_bots where bot_user_id = ${botUserId} limit 1`);
  if (!existing) {
    await q(sql`
      insert into chat_general_bots (bot_user_id, added_by, created_at)
      values (${botUserId}, ${addedBy}, ${nowIso()})`);
  }
  return true;
}

export async function removeGeneralBot(botUserId: number): Promise<boolean> {
  await q(sql`delete from chat_general_bots where bot_user_id = ${botUserId}`);
  return true;
}

async function loadRoomMembersMap(roomIds: number[]): Promise<Map<number, ChatRoomMemberRow[]>> {
  const map = new Map<number, ChatRoomMemberRow[]>();
  if (roomIds.length === 0) return map;
  const idList = sql.join(roomIds.map((id) => sql`${id}`), sql`, `);
  const rows = await q(sql`
    select m.room_id, m.user_id, m.role,
      u.name, u.position, u.avatar_color, u.avatar_url, u.is_bot
    from chat_room_members m
    join users u on u.id = m.user_id
    where m.room_id in (${idList})
    order by u.is_bot asc, m.id asc`);
  for (const r of rows) {
    const rid = toNum(r.room_id);
    const arr = map.get(rid) ?? [];
    arr.push({
      userId: toNum(r.user_id),
      name: String(r.name ?? ""),
      position: (r.position as string | null) ?? null,
      avatarColor: String(r.avatar_color ?? "#7c5cff"),
      avatarUrl: (r.avatar_url as string | null) ?? null,
      isBot: toBool(r.is_bot),
      role: r.role === "owner" ? "owner" : "member",
    });
    map.set(rid, arr);
  }
  return map;
}

export async function listChatRoomsForUser(userId: number): Promise<ChatRoomRow[]> {
  const rows = await q(sql`
    select cr.id, cr.name, cr.description, cr.kind, cr.created_by, cr.created_at, cr.updated_at
    from chat_rooms cr
    where cr.kind = 'shared'
       or exists (select 1 from chat_room_members cm where cm.room_id = cr.id and cm.user_id = ${userId})
    order by cr.updated_at desc, cr.id desc`);
  const ids = rows.map((r) => toNum(r.id));
  const membersMap = await loadRoomMembersMap(ids);
  return rows.map((r) => {
    const id = toNum(r.id);
    const members = membersMap.get(id) ?? [];
    const me = members.find((m) => m.userId === userId) ?? null;
    return {
      id,
      name: String(r.name ?? "Чат"),
      description: String(r.description ?? ""),
      kind: r.kind === "shared" ? "shared" : "group",
      createdBy: r.created_by === null || r.created_by === undefined ? null : toNum(r.created_by),
      isMember: Boolean(me),
      myRole: me ? me.role : null,
      members,
      createdAt: toIso(r.created_at) ?? nowIso(),
      updatedAt: toIso(r.updated_at) ?? nowIso(),
    };
  });
}

export async function getChatRoomForUser(userId: number, roomId: number): Promise<ChatRoomRow | null> {
  const row = await q1(sql`
    select cr.id, cr.name, cr.description, cr.kind, cr.created_by, cr.created_at, cr.updated_at
    from chat_rooms cr
    where cr.id = ${roomId}
      and (
        cr.kind = 'shared'
        or exists (select 1 from chat_room_members cm where cm.room_id = cr.id and cm.user_id = ${userId})
      )
    limit 1`);
  if (!row) return null;
  const membersMap = await loadRoomMembersMap([roomId]);
  const members = membersMap.get(roomId) ?? [];
  const me = members.find((m) => m.userId === userId) ?? null;
  return {
    id: toNum(row.id),
    name: String(row.name ?? "Чат"),
    description: String(row.description ?? ""),
    kind: row.kind === "shared" ? "shared" : "group",
    createdBy: row.created_by === null || row.created_by === undefined ? null : toNum(row.created_by),
    isMember: Boolean(me),
    myRole: me ? me.role : null,
    members,
    createdAt: toIso(row.created_at) ?? nowIso(),
    updatedAt: toIso(row.updated_at) ?? nowIso(),
  };
}

export async function canAccessChatRoom(userId: number, roomId: number): Promise<boolean> {
  const room = await getChatRoomForUser(userId, roomId);
  return room !== null;
}

export async function createChatRoom(input: {
  creatorId: number;
  name: string;
  description?: string;
  kind: ChatRoomKind;
  memberIds?: number[];
  botIds?: number[];
}): Promise<ChatRoomRow> {
  const now = nowIso();
  const cleanName = input.name.trim().slice(0, 100) || "Новый чат";
  const cleanDesc = String(input.description ?? "").trim().slice(0, 300);
  const kind: ChatRoomKind = input.kind === "shared" ? "shared" : "group";
  const row = await q1<{ id: number }>(sql`
    insert into chat_rooms (name, description, kind, created_by, created_at, updated_at)
    values (${cleanName}, ${cleanDesc}, ${kind}, ${input.creatorId}, ${now}, ${now})
    returning id`);
  const roomId = toNum(row?.id);

  await q(sql`
    insert into chat_room_members (room_id, user_id, added_by, role, created_at)
    values (${roomId}, ${input.creatorId}, ${input.creatorId}, 'owner', ${now})`);

  const candidateIds = Array.from(
    new Set([...(input.memberIds ?? []), ...(input.botIds ?? [])].map((n) => Math.floor(Number(n))).filter((n) => n > 0 && n !== input.creatorId)),
  );
  if (candidateIds.length > 0) {
    const idList = sql.join(candidateIds.map((id) => sql`${id}`), sql`, `);
    const validUsers = await q<{ id: number }>(sql`select id from users where id in (${idList})`);
    for (const u of validUsers) {
      const uid = toNum(u.id);
      await q(sql`
        insert into chat_room_members (room_id, user_id, added_by, role, created_at)
        values (${roomId}, ${uid}, ${input.creatorId}, 'member', ${now})`);
    }
  }

  const created = await getChatRoomForUser(input.creatorId, roomId);
  if (!created) throw new Error("Не удалось создать чат");
  return created;
}

export async function ensureRoomMember(roomId: number, userId: number, addedBy = userId): Promise<boolean> {
  const room = await getChatRoomForUser(userId, roomId);
  if (!room) return false;
  if (room.isMember) return true;
  if (room.kind !== "shared") return false;
  await q(sql`
    insert into chat_room_members (room_id, user_id, added_by, role, created_at)
    values (${roomId}, ${userId}, ${addedBy}, 'member', ${nowIso()})`);
  return true;
}

export async function addChatRoomMember(roomId: number, targetUserId: number, addedBy: number): Promise<boolean> {
  const existing = await q1<{ id: number }>(sql`
    select id from chat_room_members where room_id = ${roomId} and user_id = ${targetUserId} limit 1`);
  if (existing) return true;
  const userRow = await q1<{ id: number }>(sql`select id from users where id = ${targetUserId} limit 1`);
  if (!userRow) return false;
  await q(sql`
    insert into chat_room_members (room_id, user_id, added_by, role, created_at)
    values (${roomId}, ${targetUserId}, ${addedBy}, 'member', ${nowIso()})`);
  await q(sql`update chat_rooms set updated_at = ${nowIso()} where id = ${roomId}`);
  return true;
}

export async function removeChatRoomMember(roomId: number, targetUserId: number): Promise<boolean> {
  await q(sql`delete from chat_room_members where room_id = ${roomId} and user_id = ${targetUserId}`);
  await q(sql`update chat_rooms set updated_at = ${nowIso()} where id = ${roomId}`);
  return true;
}

export async function updateChatRoomInfo(
  roomId: number,
  input: { name?: string; description?: string },
): Promise<void> {
  const current = await q1<{ name: string; description: string }>(sql`
    select name, description from chat_rooms where id = ${roomId} limit 1`);
  if (!current) return;
  const nextName = input.name !== undefined ? input.name.trim().slice(0, 100) || String(current.name) : String(current.name);
  const nextDesc = input.description !== undefined ? input.description.trim().slice(0, 300) : String(current.description ?? "");
  await q(sql`update chat_rooms set name = ${nextName}, description = ${nextDesc}, updated_at = ${nowIso()} where id = ${roomId}`);
}

export async function touchChatRoom(roomId: number): Promise<void> {
  await q(sql`update chat_rooms set updated_at = ${nowIso()} where id = ${roomId}`);
}

export async function deleteChatRoom(roomId: number): Promise<boolean> {
  const row = await q1<{ id: number }>(sql`select id from chat_rooms where id = ${roomId} limit 1`);
  if (!row) return false;
  await q(sql`delete from chat_rooms where id = ${roomId}`);
  return true;
}

export async function getRoomActiveBots(roomId: number): Promise<ChatBotRow[]> {
  const rows = await q(sql`
    select u.id as user_id, u.name, u.position, u.bio, u.avatar_color, u.avatar_url,
      c.provider, c.base_url, c.api_key, c.model, c.system_prompt, c.params_json,
      c.reply_mode, c.is_active, c.created_by, c.created_at, c.updated_at
    from chat_room_members m
    join users u on u.id = m.user_id
    join ai_bot_configs c on c.user_id = u.id
    where m.room_id = ${roomId} and u.is_bot = true and c.is_active = true
    order by u.name asc`);
  return rows.map(mapChatBot);
}
