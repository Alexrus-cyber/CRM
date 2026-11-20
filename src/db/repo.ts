import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { nowIso, q, q1, toIso, toNum, toYmd } from "./dialect";
import { tokenize } from "@/lib/rag";
import { normalizeTrustLevel, type TrustLevel } from "@/lib/trust";
import { OPERATOR_MAX_EXTEND_STEPS } from "@/lib/genParams";
import type { Role, TaskPriority, TaskStatus } from "./schema";

export type UserLite = {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  position: string | null;
  role: Role;
  avatarColor: string;
  avatarUrl: string | null;
  bio: string | null;
  createdAt: string;
};

export type TaskRow = {
  id: number;
  title: string;
  description: string | null;
  assigneeId: number;
  authorId: number;
  counterpartyId: number | null;
  deadline: string;
  deadlineTime: string | null;
  acceptedAt: string | null;
  hours: number;
  status: TaskStatus;
  priority: TaskPriority;
  completedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  assigneeName: string;
  assigneeColor: string;
  assigneeAvatar: string | null;
  authorName: string;
  authorColor: string;
  authorAvatar: string | null;
  counterpartyName: string | null;
  counterpartyInn: string | null;
  counterpartyKpp: string | null;
  /** Сколько сообщений в быстрой переписке по задаче. */
  messagesCount: number;
};

export type CounterpartyRow = {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  inn: string | null;
  kpp: string | null;
  notes: string | null;
  createdById: number | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  tasksCount: number;
};

export type AuthUserRow = {
  id: number;
  email: string;
  passwordHash: string;
  role: Role;
  name: string;
};

export type TaskAccessRow = {
  id: number;
  title: string;
  authorId: number;
  assigneeId: number;
  status: TaskStatus;
  priority: TaskPriority;
  deadline: string;
  deadlineTime: string | null;
  acceptedAt: string | null;
  hours: number;
  completedAt: string | null;
  closedAt: string | null;
};

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
  content: string;
  createdAt: string;
  senderName: string;
  senderColor: string;
  senderAvatar: string | null;
  attachment: ChatAttachmentMeta | null;
};

export type ChatAttachmentRow = ChatAttachmentMeta & {
  messageId: number;
  senderId: number;
  recipientId: number | null;
  data: string;
};

/* ----------------------------- mapping ----------------------------- */

type Raw = Record<string, unknown>;

function mapUser(r: Raw): UserLite {
  return {
    id: toNum(r.id),
    name: String(r.name),
    email: String(r.email),
    phone: (r.phone as string | null) ?? null,
    position: (r.position as string | null) ?? null,
    role: (r.role as Role) ?? "user",
    avatarColor: String(r.avatar_color ?? "#7c5cff"),
    avatarUrl: (r.avatar_url as string | null) ?? null,
    bio: (r.bio as string | null) ?? null,
    createdAt: toIso(r.created_at) ?? nowIso(),
  };
}

const USER_FIELDS = sql`id, name, email, phone, position, role, avatar_color, avatar_url, bio, created_at`;

const TASK_SELECT = sql`t.id, t.title, t.description, t.assignee_id, t.author_id, t.counterparty_id,
  t.deadline, t.deadline_time, t.accepted_at, t.hours, t.status, t.priority, t.completed_at, t.closed_at, t.created_at, t.updated_at,
  a.name as assignee_name, a.avatar_color as assignee_color, a.avatar_url as assignee_avatar,
  au.name as author_name, au.avatar_color as author_color, au.avatar_url as author_avatar,
  c.name as counterparty_name, c.inn as counterparty_inn, c.kpp as counterparty_kpp,
  (select count(*) from task_messages tm where tm.task_id = t.id) as messages_count`;

const TASK_FROM = sql`from tasks t
  join users a on a.id = t.assignee_id
  join users au on au.id = t.author_id
  left join counterparties c on c.id = t.counterparty_id`;

function mapTask(r: Raw): TaskRow {
  return {
    id: toNum(r.id),
    title: String(r.title),
    description: (r.description as string | null) ?? null,
    assigneeId: toNum(r.assignee_id),
    authorId: toNum(r.author_id),
    counterpartyId: r.counterparty_id === null || r.counterparty_id === undefined ? null : toNum(r.counterparty_id),
    deadline: toYmd(r.deadline),
    deadlineTime: r.deadline_time ? String(r.deadline_time).slice(0, 5) : null,
    acceptedAt: toIso(r.accepted_at),
    hours: toNum(r.hours),
    status: (r.status as TaskStatus) ?? "new",
    priority: (r.priority as TaskPriority) ?? "medium",
    completedAt: toIso(r.completed_at),
    closedAt: toIso(r.closed_at),
    createdAt: toIso(r.created_at) ?? nowIso(),
    updatedAt: toIso(r.updated_at) ?? nowIso(),
    assigneeName: String(r.assignee_name ?? ""),
    assigneeColor: String(r.assignee_color ?? "#7c5cff"),
    assigneeAvatar: (r.assignee_avatar as string | null) ?? null,
    authorName: String(r.author_name ?? ""),
    authorColor: String(r.author_color ?? "#7c5cff"),
    authorAvatar: (r.author_avatar as string | null) ?? null,
    counterpartyName: (r.counterparty_name as string | null) ?? null,
    counterpartyInn: (r.counterparty_inn as string | null) ?? null,
    counterpartyKpp: (r.counterparty_kpp as string | null) ?? null,
    messagesCount: toNum(r.messages_count),
  };
}

/* ------------------------------ users ------------------------------ */

export async function listUsers(): Promise<UserLite[]> {
  const rows = await q(sql`select ${USER_FIELDS} from users order by name asc`);
  return rows.map(mapUser);
}

export async function getUser(id: number): Promise<UserLite | null> {
  const row = await q1(sql`select ${USER_FIELDS} from users where id = ${id} limit 1`);
  return row ? mapUser(row) : null;
}

export async function countSuperAdmins(): Promise<number> {
  const row = await q1<{ id: number }>(sql`select id from users where role = 'super_admin' limit 1`);
  return row ? 1 : 0;
}

export async function findUserAuthByEmail(email: string): Promise<AuthUserRow | null> {
  const row = await q1(sql`select id, email, password_hash, role, name from users where email = ${email} limit 1`);
  if (!row) return null;
  return {
    id: toNum(row.id),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    role: (row.role as Role) ?? "user",
    name: String(row.name),
  };
}

export async function findUserIdByEmail(email: string): Promise<number | null> {
  const row = await q1<{ id: number }>(sql`select id from users where email = ${email} limit 1`);
  return row ? toNum(row.id) : null;
}

export async function getPasswordHash(id: number): Promise<string | null> {
  const row = await q1<{ password_hash: string }>(sql`select password_hash from users where id = ${id} limit 1`);
  return row ? String(row.password_hash) : null;
}

export async function getRole(id: number): Promise<Role | null> {
  const row = await q1<{ role: Role }>(sql`select role from users where id = ${id} limit 1`);
  return row ? row.role : null;
}

export type InsertUserInput = {
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  position?: string | null;
  phone?: string | null;
  avatarColor: string;
  bio?: string | null;
  createdAt?: string;
};

export async function insertUser(input: InsertUserInput): Promise<number> {
  const now = input.createdAt ?? nowIso();
  const row = await q1<{ id: number }>(sql`
    insert into users (email, password_hash, name, phone, position, bio, role, avatar_color, created_at, updated_at)
    values (${input.email}, ${input.passwordHash}, ${input.name}, ${input.phone ?? null}, ${input.position ?? null},
            ${input.bio ?? null}, ${input.role}, ${input.avatarColor}, ${now}, ${now})
    returning id`);
  return toNum(row?.id);
}

export async function updateProfile(
  id: number,
  values: {
    name: string;
    email: string;
    phone: string | null;
    position: string | null;
    bio: string | null;
    avatarColor: string;
    avatarUrl: string | null;
  },
): Promise<void> {
  await q(sql`update users set
      name = ${values.name}, email = ${values.email}, phone = ${values.phone}, position = ${values.position},
      bio = ${values.bio}, avatar_color = ${values.avatarColor}, avatar_url = ${values.avatarUrl},
      updated_at = ${nowIso()}
    where id = ${id}`);
}

export async function setUserPassword(id: number, passwordHash: string): Promise<void> {
  await q(sql`update users set password_hash = ${passwordHash}, updated_at = ${nowIso()} where id = ${id}`);
}

export async function setUserRole(id: number, role: Role): Promise<void> {
  await q(sql`update users set role = ${role}, updated_at = ${nowIso()} where id = ${id} and role <> 'super_admin'`);
}

export async function promoteSuperAdmin(id: number): Promise<void> {
  await q(sql`update users set role = 'super_admin', updated_at = ${nowIso()} where id = ${id}`);
}

export async function deleteUser(id: number): Promise<void> {
  await q(sql`delete from users where id = ${id} and role <> 'super_admin'`);
}

/* ----------------------------- sessions ---------------------------- */

export async function insertSession(token: string, userId: number, expiresAt: string): Promise<void> {
  await q(sql`insert into sessions (token, user_id, expires_at, created_at) values (${token}, ${userId}, ${expiresAt}, ${nowIso()})`);
}

export async function findSessionUser(token: string): Promise<{ user: UserLite } | null> {
  const row = await q1(sql`
    select u.id, u.name, u.email, u.phone, u.position, u.role, u.avatar_color, u.avatar_url, u.bio, u.created_at
    from sessions s join users u on u.id = s.user_id
    where s.token = ${token} and s.expires_at > ${nowIso()}
    limit 1`);
  return row ? { user: mapUser(row) } : null;
}

export async function deleteSession(token: string): Promise<void> {
  await q(sql`delete from sessions where token = ${token}`);
}

/* -------------------------- counterparties ------------------------- */

export async function listCounterparties(): Promise<CounterpartyRow[]> {
  const rows = await q(sql`
    select c.id, c.name, c.phone, c.email, c.address, c.inn, c.kpp, c.notes, c.created_by_id,
           u.name as created_by_name, c.created_at, c.updated_at,
           (select count(*) from tasks t where t.counterparty_id = c.id) as tasks_count
    from counterparties c
    left join users u on u.id = c.created_by_id
    order by c.name asc`);
  return rows.map((r) => ({
    id: toNum(r.id),
    name: String(r.name),
    phone: (r.phone as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    address: (r.address as string | null) ?? null,
    inn: (r.inn as string | null) ?? null,
    kpp: (r.kpp as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    createdById: r.created_by_id === null || r.created_by_id === undefined ? null : toNum(r.created_by_id),
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: toIso(r.created_at) ?? nowIso(),
    updatedAt: toIso(r.updated_at) ?? nowIso(),
    tasksCount: toNum(r.tasks_count),
  }));
}

export type CounterpartyValues = {
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  inn: string | null;
  kpp: string | null;
  notes: string | null;
};

export async function insertCounterparty(values: CounterpartyValues, createdById: number): Promise<number> {
  const now = nowIso();
  const row = await q1<{ id: number }>(sql`
    insert into counterparties (name, phone, email, address, inn, kpp, notes, created_by_id, created_at, updated_at)
    values (${values.name}, ${values.phone}, ${values.email}, ${values.address}, ${values.inn}, ${values.kpp},
            ${values.notes}, ${createdById}, ${now}, ${now})
    returning id`);
  return toNum(row?.id);
}

export async function updateCounterparty(id: number, values: CounterpartyValues): Promise<void> {
  await q(sql`update counterparties set
      name = ${values.name}, phone = ${values.phone}, email = ${values.email}, address = ${values.address},
      inn = ${values.inn}, kpp = ${values.kpp}, notes = ${values.notes}, updated_at = ${nowIso()}
    where id = ${id}`);
}

export async function deleteCounterparty(id: number): Promise<void> {
  await q(sql`delete from counterparties where id = ${id}`);
}

export type CounterpartyRef = { id: number; name: string; kpp: string | null };

/** Существующие контрагенты по списку ИНН (для импорта из Excel). */
export async function findCounterpartiesByInns(inns: string[]): Promise<Map<string, CounterpartyRef>> {
  const found = new Map<string, CounterpartyRef>();
  const unique = [...new Set(inns.filter(Boolean))];
  // Порции по 500 значений: у PostgreSQL лимит параметров, у SQLite — переменных.
  const CHUNK = 500;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const rows = await q(sql`
      select id, name, inn, kpp from counterparties
      where inn in (${sql.join(chunk.map((value) => sql`${value}`), sql`, `)})`);
    for (const row of rows) {
      const inn = (row.inn as string | null) ?? null;
      if (!inn) continue;
      found.set(inn, {
        id: toNum(row.id),
        name: String(row.name),
        kpp: (row.kpp as string | null) ?? null,
      });
    }
  }
  return found;
}

/** Массовая вставка контрагентов одной командой на порцию строк. */
export async function insertCounterpartiesBulk(
  rows: CounterpartyValues[],
  createdById: number,
): Promise<number> {
  if (rows.length === 0) return 0;
  const now = nowIso();
  const CHUNK = 200;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk.map(
      (v) => sql`(${v.name}, ${v.phone}, ${v.email}, ${v.address}, ${v.inn}, ${v.kpp}, ${v.notes}, ${createdById}, ${now}, ${now})`,
    );
    const created = await q<{ id: number }>(sql`
      insert into counterparties (name, phone, email, address, inn, kpp, notes, created_by_id, created_at, updated_at)
      values ${sql.join(values, sql`, `)}
      returning id`);
    inserted += created.length;
  }
  return inserted;
}

/** Обновление из импорта: имя и КПП, остальные реквизиты не затираем. */
export async function updateCounterpartyFromImport(
  id: number,
  name: string,
  kpp: string | null,
): Promise<void> {
  await q(sql`update counterparties set name = ${name}, kpp = coalesce(${kpp}, kpp), updated_at = ${nowIso()} where id = ${id}`);
}

/* ------------------------------- tasks ----------------------------- */

export async function listTasks(scopeUserId: number | null): Promise<TaskRow[]> {
  const rows = scopeUserId
    ? await q(sql`select ${TASK_SELECT} ${TASK_FROM}
        where t.assignee_id = ${scopeUserId} or t.author_id = ${scopeUserId}
        order by t.deadline asc, t.id desc`)
    : await q(sql`select ${TASK_SELECT} ${TASK_FROM} order by t.deadline asc, t.id desc`);
  return rows.map(mapTask);
}

export async function getTask(id: number): Promise<TaskRow | null> {
  const row = await q1(sql`select ${TASK_SELECT} ${TASK_FROM} where t.id = ${id} limit 1`);
  return row ? mapTask(row) : null;
}

export async function getTaskAccess(id: number): Promise<TaskAccessRow | null> {
  const row = await q1(sql`select id, title, author_id, assignee_id, status, priority, deadline, deadline_time, accepted_at,
      hours, completed_at, closed_at
    from tasks where id = ${id} limit 1`);
  if (!row) return null;
  return {
    id: toNum(row.id),
    title: String(row.title),
    authorId: toNum(row.author_id),
    assigneeId: toNum(row.assignee_id),
    status: (row.status as TaskStatus) ?? "new",
    priority: (row.priority as TaskPriority) ?? "medium",
    deadline: toYmd(row.deadline),
    deadlineTime: row.deadline_time ? String(row.deadline_time).slice(0, 5) : null,
    acceptedAt: toIso(row.accepted_at),
    hours: toNum(row.hours),
    completedAt: toIso(row.completed_at),
    closedAt: toIso(row.closed_at),
  };
}

export type TaskValues = {
  title: string;
  description: string | null;
  assigneeId: number;
  authorId: number;
  counterpartyId: number | null;
  deadline: string;
  deadlineTime: string | null;
  acceptedAt: string | null;
  hours: number;
  status: TaskStatus;
  priority: TaskPriority;
  completedAt: string | null;
  closedAt: string | null;
};

export async function insertTask(values: TaskValues): Promise<number> {
  const now = nowIso();
  const row = await q1<{ id: number }>(sql`
    insert into tasks (title, description, assignee_id, author_id, counterparty_id, deadline, deadline_time, accepted_at,
                       hours, status, priority, completed_at, closed_at, created_at, updated_at)
    values (${values.title}, ${values.description}, ${values.assigneeId}, ${values.authorId}, ${values.counterpartyId},
            ${values.deadline}, ${values.deadlineTime}, ${values.acceptedAt}, ${values.hours}, ${values.status},
            ${values.priority}, ${values.completedAt}, ${values.closedAt}, ${now}, ${now})
    returning id`);
  return toNum(row?.id);
}

export async function updateTask(id: number, values: TaskValues): Promise<void> {
  await q(sql`update tasks set
      title = ${values.title}, description = ${values.description}, assignee_id = ${values.assigneeId},
      counterparty_id = ${values.counterpartyId}, deadline = ${values.deadline}, deadline_time = ${values.deadlineTime},
      accepted_at = ${values.acceptedAt}, hours = ${values.hours},
      status = ${values.status}, priority = ${values.priority}, completed_at = ${values.completedAt},
      closed_at = ${values.closedAt}, updated_at = ${nowIso()}
    where id = ${id}`);
}

export async function updateTaskAsAssignee(
  id: number,
  values: {
    status: TaskStatus;
    hours: number;
    description: string | null;
    completedAt: string | null;
    closedAt: string | null;
    acceptedAt?: string | null;
  },
): Promise<void> {
  await q(sql`update tasks set status = ${values.status}, hours = ${values.hours}, description = ${values.description},
      completed_at = ${values.completedAt}, closed_at = ${values.closedAt},
      accepted_at = ${values.acceptedAt ?? null}, updated_at = ${nowIso()}
    where id = ${id}`);
}

/** Assignee takes the task into work: journal the acceptance moment. */
export async function acceptTask(id: number): Promise<string> {
  const now = nowIso();
  await q(sql`update tasks set accepted_at = ${now},
      status = case when status = 'new' then 'in_progress' else status end,
      updated_at = ${now}
    where id = ${id}`);
  return now;
}

export async function setTaskDeadlineAndTime(id: number, deadline: string, deadlineTime: string | null): Promise<void> {
  await q(sql`update tasks set deadline = ${deadline}, deadline_time = ${deadlineTime}, updated_at = ${nowIso()} where id = ${id}`);
}

export async function setTaskStatusRow(
  id: number,
  values: { status: TaskStatus; completedAt: string | null; closedAt: string | null; acceptedAt?: string | null },
): Promise<void> {
  await q(sql`update tasks set status = ${values.status}, completed_at = ${values.completedAt},
      closed_at = ${values.closedAt},
      accepted_at = coalesce(${values.acceptedAt ?? null}, accepted_at),
      updated_at = ${nowIso()} where id = ${id}`);
}

export async function setTaskDeadline(id: number, deadline: string): Promise<void> {
  await q(sql`update tasks set deadline = ${deadline}, updated_at = ${nowIso()} where id = ${id}`);
}

export async function deleteTask(id: number): Promise<void> {
  await q(sql`delete from tasks where id = ${id}`);
}

/* ------------------------------ messages --------------------------- */

export async function messageCountsBySender(): Promise<Map<number, number>> {
  const rows = await q(sql`select sender_id, count(*) as c from messages group by sender_id`);
  return new Map(rows.map((r) => [toNum(r.sender_id), toNum(r.c)]));
}

/** Условие «это сообщение из переписки me ↔ peer» (peer = 0 — общий чат). */
function conversationFilter(meId: number, peer: number) {
  return peer === 0
    ? sql`m.recipient_id is null`
    : sql`((m.sender_id = ${meId} and m.recipient_id = ${peer}) or (m.sender_id = ${peer} and m.recipient_id = ${meId}))`;
}

const MESSAGE_SELECT = sql`m.id, m.sender_id, m.recipient_id, m.content, m.created_at,
  u.name as sender_name, u.avatar_color as sender_color, u.avatar_url as sender_avatar,
  a.id as attachment_id, a.name as attachment_name, a.mime as attachment_mime, a.size as attachment_size`;

const MESSAGE_FROM = sql`from messages m
  join users u on u.id = m.sender_id
  left join message_attachments a on a.message_id = m.id`;

function mapMessage(r: Raw): ChatMessage {
  return {
    id: toNum(r.id),
    senderId: toNum(r.sender_id),
    recipientId: r.recipient_id === null || r.recipient_id === undefined ? null : toNum(r.recipient_id),
    content: String(r.content),
    createdAt: toIso(r.created_at) ?? nowIso(),
    senderName: String(r.sender_name ?? ""),
    senderColor: String(r.sender_color ?? "#7c5cff"),
    senderAvatar: (r.sender_avatar as string | null) ?? null,
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

/**
 * Последние сообщения переписки (или всё, что новее `afterId`).
 * Отдаём порциями: полная история в один ответ на большом чате — это лишние
 * мегабайты и подвисание при отрисовке.
 */
export async function listMessages(
  meId: number,
  peer: number,
  afterId: number,
  limit = 30,
): Promise<{ messages: ChatMessage[]; hasOlder: boolean }> {
  const conversation = conversationFilter(meId, peer);
  const filter = afterId > 0 ? sql`${conversation} and m.id > ${afterId}` : conversation;
  const rows = await q(sql`select ${MESSAGE_SELECT} ${MESSAGE_FROM} where ${filter} order by m.id desc limit ${limit}`);
  const messages = rows.map(mapMessage).reverse();
  const oldestId = messages[0]?.id ?? 0;
  const hasOlder = oldestId > 0 && afterId === 0
    ? Boolean(await q1(sql`select 1 as ok ${MESSAGE_FROM} where ${conversation} and m.id < ${oldestId} limit 1`))
    : false;
  return { messages, hasOlder };
}

/** Более ранняя страница переписки — для кнопки «Показать более ранние». */
export async function listMessagesBefore(
  meId: number,
  peer: number,
  beforeId: number,
  limit = 30,
): Promise<{ messages: ChatMessage[]; hasOlder: boolean }> {
  const conversation = conversationFilter(meId, peer);
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

/**
 * Окно вокруг конкретного сообщения — для перехода к результату поиска.
 * Возвращает до 60 сообщений до и после, чтобы контекст читался.
 */
export async function listMessagesAround(
  meId: number,
  peer: number,
  messageId: number,
): Promise<{ messages: ChatMessage[]; hasOlder: boolean; hasNewer: boolean }> {
  const conversation = conversationFilter(meId, peer);
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

export async function insertMessage(senderId: number, recipientId: number | null, content: string): Promise<number> {
  const row = await q1<{ id: number }>(sql`
    insert into messages (sender_id, recipient_id, content, content_lower, created_at)
    values (${senderId}, ${recipientId}, ${content}, ${content.toLowerCase()}, ${nowIso()}) returning id`);
  return toNum(row?.id);
}

/** Вложение к сообщению. В БД лежит base64 — файл живёт вместе с базой. */
export async function insertMessageAttachment(
  messageId: number,
  file: { name: string; mime: string; size: number; data: string },
): Promise<number> {
  const row = await q1<{ id: number }>(sql`
    insert into message_attachments (message_id, name, name_lower, mime, size, data, created_at)
    values (${messageId}, ${file.name}, ${file.name.toLowerCase()}, ${file.mime}, ${file.size}, ${file.data}, ${nowIso()}) returning id`);
  return toNum(row?.id);
}

export async function getMessageAttachment(id: number): Promise<ChatAttachmentRow | null> {
  const row = await q1(sql`
    select a.id, a.message_id, a.name, a.mime, a.size, a.data, m.sender_id, m.recipient_id
    from message_attachments a join messages m on m.id = a.message_id
    where a.id = ${id} limit 1`);
  if (!row) return null;
  return {
    id: toNum(row.id),
    messageId: toNum(row.message_id),
    name: String(row.name),
    mime: String(row.mime),
    size: toNum(row.size),
    data: String(row.data),
    senderId: toNum(row.sender_id),
    recipientId: row.recipient_id === null || row.recipient_id === undefined ? null : toNum(row.recipient_id),
  };
}

/* ------------------------- прочитанные ----------------------------- */

/** Отметить переписку прочитанной до сообщения `lastReadId`. */
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

/** До какого сообщения собеседник дочитал переписку с нами. */
export async function getPeerReadId(meId: number, peerId: number): Promise<number> {
  const row = await q1<{ last_read_id: number }>(sql`
    select last_read_id from chat_reads where user_id = ${peerId} and peer_id = ${meId} limit 1`);
  return row ? toNum(row.last_read_id) : 0;
}

/** Кто и до какого сообщения дочитал общий чат (для «прочитали N»). */
export async function listGeneralReaders(meId: number): Promise<Array<{ userId: number; lastReadId: number }>> {
  const rows = await q(sql`
    select user_id, last_read_id from chat_reads where peer_id = 0 and user_id <> ${meId}`);
  return rows.map((r) => ({ userId: toNum(r.user_id), lastReadId: toNum(r.last_read_id) }));
}

/** Последний id в переписке — ограничитель для отметки «прочитано». */
export async function maxConversationMessageId(meId: number, peer: number): Promise<number> {
  const row = await q1<{ id: number | null }>(sql`
    select max(m.id) as id ${MESSAGE_FROM} where ${conversationFilter(meId, peer)}`);
  return row ? toNum(row.id) : 0;
}

/** Непрочитанные сообщения по перепискам: ключ 0 — общий чат. */
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
      where m.sender_id <> ${meId}
        and (m.recipient_id is null or m.recipient_id = ${meId})
    ) t
    left join chat_reads r on r.user_id = ${meId} and r.peer_id = t.peer
    where t.id > coalesce(r.last_read_id, 0)
    group by t.peer`);
  const result: Record<string, number> = {};
  for (const row of rows) result[String(toNum(row.peer))] = toNum(row.c);
  return result;
}

/** Поиск по переписке: текст сообщений и имена вложений (нижний регистр — заранее). */
export async function searchMessages(
  meId: number,
  peer: number,
  query: string,
  limit = 50,
): Promise<ChatMessage[]> {
  // Спецсимволы LIKE вырезаем: без них пустой запрос не должен совпадать со всем.
  const clean = query.toLowerCase().replace(/[%_\\]/g, "").trim();
  if (!clean) return [];
  const needle = `%${clean}%`;
  const rows = await q(sql`
    select ${MESSAGE_SELECT} ${MESSAGE_FROM}
    where ${conversationFilter(meId, peer)}
      and (m.content_lower like ${needle} or a.name_lower like ${needle})
    order by m.id desc limit ${limit}`);
  return rows.map(mapMessage).reverse();
}

/** Верхняя граница id сообщений — точка отсчёта для уведомлений. */
export async function maxMessageId(): Promise<number> {
  const row = await q1<{ id: number | null }>(sql`select max(id) as id from messages`);
  return row ? toNum(row.id) : 0;
}

export type ChatNotificationRow = {
  id: number;
  senderId: number;
  senderName: string;
  senderColor: string;
  recipientId: number | null;
  preview: string;
  createdAt: string;
};

/**
 * Новые сообщения, адресованные мне (личные и общий чат), начиная с `afterId`.
 * Используется всплывающими уведомлениями: сами сообщения читает чат, а здесь
 * нужен только короткий текст-превью.
 */
export async function listNewMessagesFor(meId: number, afterId: number, limit = 5): Promise<ChatNotificationRow[]> {
  const rows = await q(sql`
    select m.id, m.sender_id, m.recipient_id, m.content, m.created_at,
      u.name as sender_name, u.avatar_color as sender_color,
      a.name as attachment_name
    from messages m
    join users u on u.id = m.sender_id
    left join message_attachments a on a.message_id = m.id
    where m.id > ${afterId}
      and m.sender_id <> ${meId}
      and (m.recipient_id is null or m.recipient_id = ${meId})
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
      preview: preview.length > 160 ? `${preview.slice(0, 160)}…` : preview,
      createdAt: toIso(r.created_at) ?? nowIso(),
    };
  });
}

/* ----------------------- переписка по задаче ------------------------ */

export type TaskMessageRow = {
  id: number;
  taskId: number;
  authorId: number;
  authorName: string;
  authorColor: string;
  authorAvatar: string | null;
  content: string;
  createdAt: string;
};

/** Сколько сообщений допускается в одной переписке по задаче. */
export const TASK_MESSAGE_MAX = 2000;

export async function listTaskMessages(taskId: number, limit = 300): Promise<TaskMessageRow[]> {
  const rows = await q(sql`
    select m.id, m.task_id, m.author_id, m.content, m.created_at,
      u.name as author_name, u.avatar_color as author_color, u.avatar_url as author_avatar
    from task_messages m
    join users u on u.id = m.author_id
    where m.task_id = ${taskId}
    order by m.id asc
    limit ${limit}`);
  return rows.map((r) => ({
    id: toNum(r.id),
    taskId: toNum(r.task_id),
    authorId: toNum(r.author_id),
    authorName: String(r.author_name ?? ""),
    authorColor: String(r.author_color ?? "#7c5cff"),
    authorAvatar: (r.author_avatar as string | null) ?? null,
    content: String(r.content ?? ""),
    createdAt: toIso(r.created_at) ?? nowIso(),
  }));
}

export async function insertTaskMessage(taskId: number, authorId: number, content: string): Promise<number> {
  const row = await q1<{ id: number }>(sql`
    insert into task_messages (task_id, author_id, content, content_lower, created_at)
    values (${taskId}, ${authorId}, ${content}, ${content.toLowerCase()}, ${nowIso()}) returning id`);
  return toNum(row?.id);
}

export async function getTaskMessageAuthor(id: number): Promise<{ id: number; taskId: number; authorId: number } | null> {
  const row = await q1(sql`select id, task_id, author_id from task_messages where id = ${id} limit 1`);
  if (!row) return null;
  return { id: toNum(row.id), taskId: toNum(row.task_id), authorId: toNum(row.author_id) };
}

export async function deleteTaskMessage(id: number): Promise<void> {
  await q(sql`delete from task_messages where id = ${id}`);
}

/* ---------------------- агент-оператор рабочего стола --------------- */

export type AgentTaskApprovalRequest = {
  id: string;
  kind: "dangerous_action" | "step_limit" | "sandbox_export" | "shell_command";
  title: string;
  description: string;
  action?: Record<string, unknown>;
  extraSteps?: number;
  requestedAt: string;
};

export type AgentTaskApprovalDecision = {
  id: string;
  decision: "approved" | "rejected" | "extend_steps";
  extraSteps?: number;
  note?: string;
  decidedAt: string;
};

export type AgentTaskRow = {
  id: number;
  userId: number;
  prompt: string;
  status: string;
  maxSteps: number;
  steps: number;
  summary: string;
  trustLevel: TrustLevel;
  pendingApproval: AgentTaskApprovalRequest | null;
  approvalResponse: AgentTaskApprovalDecision | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentEventRow = {
  id: number;
  taskId: number;
  kind: string;
  text: string;
  action: string;
  fileName: string;
  fileMime: string;
  fileSize: number;
  hasFile: boolean;
  createdAt: string;
};

function parseJsonObject<T>(raw: unknown): T | null {
  const str = String(raw ?? "").trim();
  if (!str) return null;
  try {
    const parsed: unknown = JSON.parse(str);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function mapAgentTask(r: Raw): AgentTaskRow {
  return {
    id: toNum(r.id),
    userId: toNum(r.user_id),
    prompt: String(r.prompt ?? ""),
    status: String(r.status ?? "queued"),
    maxSteps: toNum(r.max_steps),
    steps: toNum(r.steps),
    summary: String(r.summary ?? ""),
    trustLevel: normalizeTrustLevel(r.trust_level),
    pendingApproval: parseJsonObject<AgentTaskApprovalRequest>(r.pending_approval),
    approvalResponse: parseJsonObject<AgentTaskApprovalDecision>(r.approval_response),
    createdAt: toIso(r.created_at) ?? nowIso(),
    updatedAt: toIso(r.updated_at) ?? nowIso(),
  };
}

export async function getAgentToken(userId: number): Promise<string | null> {
  const row = await q1(sql`select token from agent_tokens where user_id = ${userId} limit 1`);
  return row ? String(row.token) : null;
}

export async function saveAgentToken(userId: number, token: string): Promise<void> {
  const existing = await q1<{ id: number }>(sql`select id from agent_tokens where user_id = ${userId} limit 1`);
  if (existing) {
    await q(sql`update agent_tokens set token = ${token} where user_id = ${userId}`);
    return;
  }
  await q(sql`insert into agent_tokens (user_id, token, created_at) values (${userId}, ${token}, ${nowIso()})`);
}

/** Владелец токена — по нему бот получает доступ к своим задачам. */
export async function findAgentTokenOwner(
  token: string,
  options?: { touch?: boolean },
): Promise<number | null> {
  if (!token) return null;

  // Сначала новые токены подключений, затем legacy-таблица.
  const fresh = await q1<{ user_id: number }>(
    sql`select user_id from agent_connection_tokens where token = ${token} limit 1`,
  );
  if (fresh) {
    // Отмечаем активность: в списке токенов видно, какой бот живой.
    // При ручной проверке токена из браузера (`touch: false`) дату не трогаем,
    // чтобы не создавать ложное впечатление, что бот сейчас запущен.
    if (options?.touch !== false) {
      await q(sql`update agent_connection_tokens set last_used_at = ${nowIso()} where token = ${token}`);
    }
    return toNum(fresh.user_id);
  }

  const row = await q1(sql`select user_id from agent_tokens where token = ${token} limit 1`);
  return row ? toNum(row.user_id) : null;
}

export type AgentBotConnectionStatus = {
  state: "online" | "stale" | "never" | "no_tokens";
  connected: boolean;
  secondsAgo: number | null;
  lastSeenAt: string | null;
  tokenName: string;
  tokenHint: string;
  connectionName: string;
  tokensCount: number;
  totalTokensCount: number;
  runningTask: { id: number; steps: number; maxSteps: number; updatedAt: string } | null;
  queue: { queued: number; running: number };
};

const BOT_ONLINE_WINDOW_SEC = 30;
const BOT_RUNNING_TASK_WINDOW_SEC = 120;

/**
 * Сводка активности настольного бота для ручной проверки во вкладке «Оператор».
 * Опирается на `last_used_at` токенов (бот опрашивает `/api/agent/bot/next` каждые
 * несколько секунд) и на свежую задачу в статусе `running`.
 */
export async function getAgentBotConnectionStatus(
  userId: number,
  connectionId?: number,
): Promise<AgentBotConnectionStatus> {
  const scopeId = connectionId && connectionId > 0 ? connectionId : 0;

  const totalConnRow = await q1<{ count: number }>(sql`
    select count(*) as count from agent_connection_tokens where user_id = ${userId}`);
  const legacyRow = await q1<{ count: number }>(sql`
    select count(*) as count from agent_tokens where user_id = ${userId}`);
  const totalTokensCount = toNum(totalConnRow?.count) + toNum(legacyRow?.count);

  const tokenRows = scopeId
    ? await q(sql`
        select t.id, t.name, t.token, t.last_used_at, c.name as connection_name
        from agent_connection_tokens t
        join agent_connections c on c.id = t.connection_id
        where t.user_id = ${userId} and t.connection_id = ${scopeId}
        order by t.last_used_at desc, t.id desc`)
    : await q(sql`
        select t.id, t.name, t.token, t.last_used_at, c.name as connection_name
        from agent_connection_tokens t
        join agent_connections c on c.id = t.connection_id
        where t.user_id = ${userId}
        order by t.last_used_at desc, t.id desc`);

  const tokensCount = scopeId ? tokenRows.length : totalTokensCount;
  let latestRow: Raw | null = null;
  let latestMs = -1;
  for (const row of tokenRows) {
    const iso = toIso(row.last_used_at);
    if (!iso) continue;
    const ms = new Date(iso).getTime();
    if (!Number.isNaN(ms) && ms > latestMs) {
      latestMs = ms;
      latestRow = row;
    }
  }

  const queuedRow = await q1<{ count: number }>(sql`
    select count(*) as count from agent_tasks where user_id = ${userId} and status = 'queued'`);
  const runningCountRow = await q1<{ count: number }>(sql`
    select count(*) as count from agent_tasks where user_id = ${userId} and status in ('running', 'waiting_approval', 'waiting_steps')`);
  const runningRow = await q1(sql`
    select id, steps, max_steps, updated_at
    from agent_tasks
    where user_id = ${userId} and status in ('running', 'waiting_approval', 'waiting_steps')
    order by updated_at desc, id desc limit 1`);

  const nowMs = Date.now();
  const lastSeenAt = latestRow ? toIso(latestRow.last_used_at) : null;
  const secondsAgo = latestMs >= 0 ? Math.max(0, Math.round((nowMs - latestMs) / 1000)) : null;

  const runningTask = runningRow
    ? {
        id: toNum(runningRow.id),
        steps: toNum(runningRow.steps),
        maxSteps: toNum(runningRow.max_steps),
        updatedAt: toIso(runningRow.updated_at) ?? nowIso(),
      }
    : null;
  const runningMs = runningTask ? new Date(runningTask.updatedAt).getTime() : NaN;
  const runningSecondsAgo = !Number.isNaN(runningMs) ? Math.max(0, Math.round((nowMs - runningMs) / 1000)) : null;

  const connected =
    (secondsAgo !== null && secondsAgo <= BOT_ONLINE_WINDOW_SEC) ||
    (runningSecondsAgo !== null && runningSecondsAgo <= BOT_RUNNING_TASK_WINDOW_SEC);

  let state: AgentBotConnectionStatus["state"];
  if (tokensCount === 0) state = "no_tokens";
  else if (connected) state = "online";
  else if (lastSeenAt !== null) state = "stale";
  else state = "never";

  return {
    state,
    connected,
    secondsAgo,
    lastSeenAt,
    tokenName: latestRow ? String(latestRow.name ?? "") : "",
    tokenHint: latestRow ? maskToken(String(latestRow.token ?? "")) : "",
    connectionName: latestRow ? String(latestRow.connection_name ?? "") : "",
    tokensCount,
    totalTokensCount,
    runningTask,
    queue: {
      queued: toNum(queuedRow?.count),
      running: toNum(runningCountRow?.count),
    },
  };
}

/* --------------------- подключения и токены бота ------------------- */

export type AgentConnectionRow = {
  id: number;
  userId: number;
  name: string;
  serverUrl: string;
  isDefault: boolean;
  tokensCount: number;
  activeTokens: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentTokenRow = {
  id: number;
  connectionId: number;
  name: string;
  /** Хвост токена для списка: сам токен показываем только по кнопке «Показать». */
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
};

function maskToken(token: string): string {
  const value = String(token ?? "");
  return value ? `…${value.slice(-6)}` : "";
}

function mapAgentConnection(row: Raw): AgentConnectionRow {
  return {
    id: toNum(row.id),
    userId: toNum(row.user_id),
    name: String(row.name ?? ""),
    serverUrl: String(row.server_url ?? ""),
    isDefault: toNum(row.is_default) === 1,
    tokensCount: toNum(row.tokens_count),
    activeTokens: toNum(row.active_tokens),
    createdAt: toIso(row.created_at) ?? nowIso(),
    updatedAt: toIso(row.updated_at) ?? nowIso(),
  };
}

function mapAgentToken(row: Raw): AgentTokenRow {
  return {
    id: toNum(row.id),
    connectionId: toNum(row.connection_id),
    name: String(row.name ?? ""),
    hint: maskToken(String(row.token ?? "")),
    createdAt: toIso(row.created_at) ?? nowIso(),
    lastUsedAt: toIso(row.last_used_at),
  };
}

/** Подключения пользователя: основное — первым, дальше по дате создания. */
export async function listAgentConnections(userId: number): Promise<AgentConnectionRow[]> {
  const rows = await q(sql`
    select c.*,
           (select count(*) from agent_connection_tokens t where t.connection_id = c.id) as tokens_count,
           (select count(*) from agent_connection_tokens t
              where t.connection_id = c.id
                and (t.last_used_at is null or t.last_used_at > ${dayAgoIso()})) as active_tokens
    from agent_connections c
    where c.user_id = ${userId}
    order by c.is_default desc, c.id`);
  return rows.map(mapAgentConnection);
}

export async function getAgentConnection(userId: number, id: number): Promise<AgentConnectionRow | null> {
  const row = await q1(sql`
    select c.*,
           (select count(*) from agent_connection_tokens t where t.connection_id = c.id) as tokens_count,
           (select count(*) from agent_connection_tokens t
              where t.connection_id = c.id
                and (t.last_used_at is null or t.last_used_at > ${dayAgoIso()})) as active_tokens
    from agent_connections c
    where c.id = ${id} and c.user_id = ${userId} limit 1`);
  return row ? mapAgentConnection(row) : null;
}

/**
 * Новое подключение. Первое автоматически становится основным, чтобы
 * интерфейсу и старым клиентам всегда было что выбрать.
 */
export async function createAgentConnection(
  userId: number,
  name: string,
  serverUrl: string,
): Promise<AgentConnectionRow> {
  const now = nowIso();
  const existing = await q1<{ count: number }>(
    sql`select count(*) as count from agent_connections where user_id = ${userId}`,
  );
  const isDefault = toNum(existing?.count) === 0 ? 1 : 0;
  const inserted = await q1<{ id: number }>(sql`
    insert into agent_connections (user_id, name, server_url, is_default, created_at, updated_at)
    values (${userId}, ${name}, ${serverUrl}, ${isDefault}, ${now}, ${now}) returning id`);
  const id = toNum(inserted?.id);
  const created = await getAgentConnection(userId, id);
  if (!created) throw new Error("Не удалось создать подключение");
  return created;
}

export async function updateAgentConnection(
  userId: number,
  id: number,
  patch: { name?: string; serverUrl?: string },
): Promise<AgentConnectionRow | null> {
  const current = await getAgentConnection(userId, id);
  if (!current) return null;
  const name = patch.name?.trim() || current.name;
  const serverUrl = patch.serverUrl !== undefined ? patch.serverUrl.trim() : current.serverUrl;
  await q(sql`update agent_connections set name = ${name}, server_url = ${serverUrl}, updated_at = ${nowIso()}
    where id = ${id} and user_id = ${userId}`);
  return getAgentConnection(userId, id);
}

/** Сделать подключение основным: флаг снимается с остальных. */
export async function setDefaultAgentConnection(userId: number, id: number): Promise<boolean> {
  const current = await getAgentConnection(userId, id);
  if (!current) return false;
  await q(sql`update agent_connections set is_default = 0 where user_id = ${userId}`);
  await q(sql`update agent_connections set is_default = 1, updated_at = ${nowIso()}
    where id = ${id} and user_id = ${userId}`);
  return true;
}

/** Удаление подключения вместе с его токенами (каскад в схеме). */
export async function deleteAgentConnection(userId: number, id: number): Promise<boolean> {
  const current = await getAgentConnection(userId, id);
  if (!current) return false;
  await q(sql`delete from agent_connection_tokens where connection_id = ${id}`);
  await q(sql`delete from agent_connections where id = ${id} and user_id = ${userId}`);
  if (current.isDefault) {
    // Основным становится следующее по порядку, чтобы не остаться без выбора.
    const next = await q1<{ id: number }>(
      sql`select id from agent_connections where user_id = ${userId} order by id limit 1`,
    );
    if (next) await setDefaultAgentConnection(userId, toNum(next.id));
  }
  return true;
}

export async function listAgentTokens(userId: number, connectionId: number): Promise<AgentTokenRow[]> {
  const rows = await q(sql`
    select id, connection_id, name, token, created_at, last_used_at
    from agent_connection_tokens
    where user_id = ${userId} and connection_id = ${connectionId}
    order by id desc`);
  return rows.map(mapAgentToken);
}

/** Сколько токенов у подключения — для проверки прав и подсказок. */
export async function countAgentTokens(userId: number, connectionId: number): Promise<number> {
  const row = await q1<{ count: number }>(sql`
    select count(*) as count from agent_connection_tokens
    where user_id = ${userId} and connection_id = ${connectionId}`);
  return toNum(row?.count);
}

/**
 * Новый токен подключения. Полное значение возвращается один раз — в базе оно
 * лежит открытым (боту нужно сверять), но в интерфейсе по умолчанию маска.
 */
export async function createAgentConnectionToken(
  userId: number,
  connectionId: number,
  name: string,
): Promise<{ token: string; item: AgentTokenRow } | null> {
  const connection = await getAgentConnection(userId, connectionId);
  if (!connection) return null;
  const token = `crmop_${randomBytes(24).toString("hex")}`;
  const now = nowIso();
  const inserted = await q1<{ id: number }>(sql`
    insert into agent_connection_tokens (connection_id, user_id, name, token, created_at)
    values (${connectionId}, ${userId}, ${name}, ${token}, ${now}) returning id`);
  const id = toNum(inserted?.id);
  return {
    token,
    item: {
      id,
      connectionId,
      name,
      hint: maskToken(token),
      createdAt: now,
      lastUsedAt: null,
    },
  };
}

/** Полное значение токена — по кнопке «Показать». */
export async function revealAgentToken(userId: number, tokenId: number): Promise<string | null> {
  const row = await q1<{ token: string }>(
    sql`select token from agent_connection_tokens where id = ${tokenId} and user_id = ${userId} limit 1`,
  );
  return row ? String(row.token) : null;
}

/** Отзыв токена: строка удаляется, бот сразу теряет доступ. */
export async function deleteAgentConnectionToken(userId: number, tokenId: number): Promise<boolean> {
  const row = await q1<{ id: number }>(
    sql`select id from agent_connection_tokens where id = ${tokenId} and user_id = ${userId} limit 1`,
  );
  if (!row) return false;
  await q(sql`delete from agent_connection_tokens where id = ${tokenId} and user_id = ${userId}`);
  return true;
}

function dayAgoIso(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

export async function createAgentTask(
  userId: number,
  prompt: string,
  maxSteps: number,
  trustLevel: TrustLevel = "verified",
): Promise<AgentTaskRow> {
  const now = nowIso();
  const safeTrust = normalizeTrustLevel(trustLevel);
  const row = await q1<{ id: number }>(sql`
    insert into agent_tasks (user_id, prompt, status, max_steps, steps, summary, trust_level, pending_approval, approval_response, created_at, updated_at)
    values (${userId}, ${prompt}, 'queued', ${maxSteps}, 0, '', ${safeTrust}, '', '', ${now}, ${now}) returning id`);
  const id = toNum(row?.id);
  return {
    id,
    userId,
    prompt,
    status: "queued",
    maxSteps,
    steps: 0,
    summary: "",
    trustLevel: safeTrust,
    pendingApproval: null,
    approvalResponse: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function listAgentTasks(userId: number, limit = 12): Promise<AgentTaskRow[]> {
  const rows = await q(sql`
    select id, user_id, prompt, status, max_steps, steps, summary, trust_level, pending_approval, approval_response, created_at, updated_at
    from agent_tasks where user_id = ${userId} order by id desc limit ${limit}`);
  return rows.map(mapAgentTask);
}

export async function getAgentTask(userId: number, id: number): Promise<AgentTaskRow | null> {
  const row = await q1(sql`
    select id, user_id, prompt, status, max_steps, steps, summary, trust_level, pending_approval, approval_response, created_at, updated_at
    from agent_tasks where id = ${id} and user_id = ${userId} limit 1`);
  return row ? mapAgentTask(row) : null;
}

/** Задача глазами бота: без привязки к пользователю, доступ уже проверен токеном. */
export async function getAgentTaskForBot(id: number, userId: number): Promise<AgentTaskRow | null> {
  return getAgentTask(userId, id);
}

/**
 * Забрать следующее задание из очереди. Статус меняем условным `update`,
 * чтобы два запущенных бота не взяли одну и ту же задачу.
 */
export async function claimAgentTask(userId: number): Promise<AgentTaskRow | null> {
  const row = await q1<{ id: number }>(sql`
    select id from agent_tasks where user_id = ${userId} and status = 'queued' order by id asc limit 1`);
  if (!row) return null;
  const id = toNum(row.id);
  const now = nowIso();
  const taken = await q1<{ id: number }>(sql`
    update agent_tasks set status = 'running', updated_at = ${now}
    where id = ${id} and status = 'queued' returning id`);
  if (!taken) return null;
  return getAgentTask(userId, id);
}

export async function setAgentTaskStatus(
  id: number,
  userId: number,
  status: string,
  summary?: string,
): Promise<void> {
  const now = nowIso();
  const clearPending = ["done", "failed", "cancelled"].includes(status);
  if (summary === undefined) {
    await q(sql`update agent_tasks
      set status = ${status},
          pending_approval = case when ${clearPending} then '' else pending_approval end,
          updated_at = ${now}
      where id = ${id} and user_id = ${userId}`);
    return;
  }
  await q(sql`
    update agent_tasks
    set status = ${status},
        summary = ${summary},
        pending_approval = case when ${clearPending} then '' else pending_approval end,
        updated_at = ${now}
    where id = ${id} and user_id = ${userId}`);
}

/** Бот запрашивает подтверждение опасного действия или расширение лимита шагов на сайте. */
export async function requestAgentTaskApproval(
  taskId: number,
  userId: number,
  input: {
    id: string;
    kind: AgentTaskApprovalRequest["kind"];
    title: string;
    description: string;
    action?: Record<string, unknown>;
    extraSteps?: number;
  },
): Promise<AgentTaskApprovalRequest | null> {
  const task = await getAgentTask(userId, taskId);
  if (!task || task.status === "cancelled") return null;
  const now = nowIso();
  const reqPayload: AgentTaskApprovalRequest = {
    id: input.id,
    kind: input.kind,
    title: input.title.slice(0, 240),
    description: input.description.slice(0, 2000),
    ...(input.action ? { action: input.action } : {}),
    ...(input.extraSteps ? { extraSteps: input.extraSteps } : {}),
    requestedAt: now,
  };
  const nextStatus = input.kind === "step_limit" ? "waiting_steps" : "waiting_approval";
  await q(sql`
    update agent_tasks
    set status = ${nextStatus},
        pending_approval = ${JSON.stringify(reqPayload)},
        approval_response = '',
        updated_at = ${now}
    where id = ${taskId} and user_id = ${userId}`);
  await addAgentEvent({
    taskId,
    kind: "approval",
    text: `${reqPayload.title}${reqPayload.description ? ` — ${reqPayload.description}` : ""}`,
    action: input.action ? JSON.stringify(input.action) : "",
  });
  return reqPayload;
}

/** Пользователь на сайте одобряет/отклоняет действие или расширяет лимит шагов прямо в активной задаче. */
export async function respondAgentTaskApproval(
  taskId: number,
  userId: number,
  input: {
    approvalId?: string;
    decision: "approved" | "rejected" | "extend_steps";
    extraSteps?: number;
    note?: string;
  },
): Promise<AgentTaskRow | null> {
  const task = await getAgentTask(userId, taskId);
  if (!task || task.status === "cancelled") return null;
  const now = nowIso();
  const id = input.approvalId || task.pendingApproval?.id || `appr_${Date.now()}`;
  const addSteps =
    input.decision === "extend_steps"
      ? Math.max(1, Math.min(OPERATOR_MAX_EXTEND_STEPS - task.maxSteps, Math.round(input.extraSteps || 15)))
      : 0;
  const nextMaxSteps = Math.min(OPERATOR_MAX_EXTEND_STEPS, task.maxSteps + addSteps);
  const decisionPayload: AgentTaskApprovalDecision = {
    id,
    decision: input.decision,
    ...(addSteps > 0 ? { extraSteps: addSteps } : {}),
    ...(input.note ? { note: input.note.slice(0, 500) } : {}),
    decidedAt: now,
  };

  await q(sql`
    update agent_tasks
    set status = 'running',
        max_steps = ${nextMaxSteps},
        pending_approval = '',
        approval_response = ${JSON.stringify(decisionPayload)},
        updated_at = ${now}
    where id = ${taskId} and user_id = ${userId}`);

  const eventText =
    input.decision === "extend_steps"
      ? `Лимит шагов расширен (+${addSteps}) до ${nextMaxSteps} — продолжаем с текущего шага`
      : input.decision === "approved"
        ? `Пользователь на сайте разрешил действие${input.note ? `: ${input.note}` : ""}`
        : `Пользователь на сайте отклонил действие${input.note ? `: ${input.note}` : ""}`;
  await addAgentEvent({ taskId, kind: "info", text: eventText });
  return getAgentTask(userId, taskId);
}

/** Увеличить лимит шагов активной или ожидающей задачи прямо на месте. */
export async function extendAgentTaskSteps(
  taskId: number,
  userId: number,
  addStepsRaw: number,
): Promise<AgentTaskRow | null> {
  const task = await getAgentTask(userId, taskId);
  if (!task || task.status === "cancelled" || task.status === "done") return null;
  const addSteps = Math.max(1, Math.min(OPERATOR_MAX_EXTEND_STEPS, Math.round(addStepsRaw || 15)));
  const nextMaxSteps = Math.min(OPERATOR_MAX_EXTEND_STEPS, Math.max(task.maxSteps + addSteps, task.steps + 1));
  const actualAdded = nextMaxSteps - task.maxSteps;
  if (task.pendingApproval?.kind === "step_limit") {
    return respondAgentTaskApproval(taskId, userId, {
      approvalId: task.pendingApproval.id,
      decision: "extend_steps",
      extraSteps: Math.max(1, actualAdded),
    });
  }
  const now = nowIso();
  const nextStatus = task.status === "waiting_steps" ? "running" : task.status;
  await q(sql`
    update agent_tasks
    set max_steps = ${nextMaxSteps},
        status = ${nextStatus},
        updated_at = ${now}
    where id = ${taskId} and user_id = ${userId}`);
  await addAgentEvent({
    taskId,
    kind: "info",
    text: `Лимит шагов увеличен до ${nextMaxSteps} (+${actualAdded})`,
  });
  return getAgentTask(userId, taskId);
}

export async function bumpAgentTaskStep(id: number): Promise<void> {
  await q(sql`update agent_tasks set steps = steps + 1, updated_at = ${nowIso()} where id = ${id}`);
}

export async function addAgentEvent(input: {
  taskId: number;
  kind: string;
  text?: string;
  action?: string;
  fileName?: string;
  fileMime?: string;
  fileSize?: number;
  fileData?: string;
}): Promise<number> {
  const row = await q1<{ id: number }>(sql`
    insert into agent_events (task_id, kind, text, action, file_name, file_mime, file_size, file_data, created_at)
    values (${input.taskId}, ${input.kind}, ${input.text ?? ""}, ${input.action ?? ""},
            ${input.fileName ?? ""}, ${input.fileMime ?? ""}, ${input.fileSize ?? 0}, ${input.fileData ?? ""},
            ${nowIso()}) returning id`);
  return toNum(row?.id);
}

/** События задачи без base64-данных файлов — их отдаём отдельным маршрутом. */
export async function listAgentEvents(taskId: number, limit = 200): Promise<AgentEventRow[]> {
  const rows = await q(sql`
    select id, task_id, kind, text, action, file_name, file_mime, file_size, created_at,
      case when file_data = '' then 0 else 1 end as has_file
    from agent_events where task_id = ${taskId} order by id asc limit ${limit}`);
  return rows.map((r) => ({
    id: toNum(r.id),
    taskId: toNum(r.task_id),
    kind: String(r.kind ?? "info"),
    text: String(r.text ?? ""),
    action: String(r.action ?? ""),
    fileName: String(r.file_name ?? ""),
    fileMime: String(r.file_mime ?? ""),
    fileSize: toNum(r.file_size),
    hasFile: toNum(r.has_file) === 1,
    createdAt: toIso(r.created_at) ?? nowIso(),
  }));
}

export async function getAgentEventFile(
  eventId: number,
): Promise<{ name: string; mime: string; data: string; userId: number; taskId: number } | null> {
  const row = await q1(sql`
    select e.file_name, e.file_mime, e.file_data, t.user_id, e.task_id
    from agent_events e join agent_tasks t on t.id = e.task_id
    where e.id = ${eventId} and e.file_data <> '' limit 1`);
  if (!row) return null;
  return {
    name: String(row.file_name ?? "файл"),
    mime: String(row.file_mime ?? "application/octet-stream"),
    data: String(row.file_data ?? ""),
    userId: toNum(row.user_id),
    taskId: toNum(row.task_id),
  };
}

/* --------------------------- чаты с ИИ и токены --------------------- */

export type AiChatRow = {
  id: number;
  userId: number;
  title: string;
  tokensPrompt: number;
  tokensCompletion: number;
  tokensTotal: number;
  messagesCount: number;
  createdAt: string;
  updatedAt: string;
};

function mapAiChat(row: Raw): AiChatRow {
  const tokensPrompt = toNum(row.tokens_prompt);
  const tokensCompletion = toNum(row.tokens_completion);
  return {
    id: toNum(row.id),
    userId: toNum(row.user_id),
    title: String(row.title ?? "Новый чат"),
    tokensPrompt,
    tokensCompletion,
    tokensTotal: tokensPrompt + tokensCompletion,
    messagesCount: toNum(row.messages_count),
    createdAt: toIso(row.created_at) ?? nowIso(),
    updatedAt: toIso(row.updated_at) ?? nowIso(),
  };
}

export async function listAiChats(userId: number, limit = 50): Promise<AiChatRow[]> {
  const rows = await q(sql`select c.id, c.user_id, c.title, c.tokens_prompt, c.tokens_completion,
      c.created_at, c.updated_at,
      (select count(*) from ai_chat_messages m where m.chat_id = c.id) as messages_count
    from ai_chats c where c.user_id = ${userId} order by c.updated_at desc limit ${Math.max(1, Math.min(limit, 200))}`);
  return rows.map(mapAiChat);
}

export async function getAiChat(userId: number, id: number): Promise<AiChatRow | null> {
  const row = await q1(sql`select c.id, c.user_id, c.title, c.tokens_prompt, c.tokens_completion,
      c.created_at, c.updated_at,
      (select count(*) from ai_chat_messages m where m.chat_id = c.id) as messages_count
    from ai_chats c where c.id = ${id} and c.user_id = ${userId} limit 1`);
  return row ? mapAiChat(row) : null;
}

export async function createAiChat(userId: number, title = "Новый чат"): Promise<AiChatRow> {
  const now = nowIso();
  const row = await q1(sql`insert into ai_chats (user_id, title, tokens_prompt, tokens_completion, created_at, updated_at)
    values (${userId}, ${title}, 0, 0, ${now}, ${now}) returning id`);
  const id = toNum(row?.id);
  return {
    id,
    userId,
    title,
    tokensPrompt: 0,
    tokensCompletion: 0,
    tokensTotal: 0,
    messagesCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function renameAiChat(userId: number, id: number, title: string): Promise<boolean> {
  const row = await q(sql`update ai_chats set title = ${title.slice(0, 120)}, updated_at = ${nowIso()}
    where id = ${id} and user_id = ${userId} returning id`);
  return row.length > 0;
}

export async function deleteAiChat(userId: number, id: number): Promise<boolean> {
  const chat = await getAiChat(userId, id);
  if (!chat) return false;
  await q(sql`delete from ai_chat_messages where chat_id = ${id}`);
  await q(sql`delete from ai_chats where id = ${id} and user_id = ${userId}`);
  return true;
}

export type AiChatMessageRow = {
  id: number;
  role: "user" | "assistant";
  content: string;
  reasoning: string;
  attachments: string;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  createdAt: string;
};

export async function listAiChatMessages(chatId: number): Promise<AiChatMessageRow[]> {
  const rows = await q(sql`select id, role, content, reasoning, attachments, tokens, prompt_tokens, completion_tokens, created_at
    from ai_chat_messages where chat_id = ${chatId} order by id asc limit 400`);
  return rows.map((row) => ({
    id: toNum(row.id),
    role: row.role === "assistant" ? "assistant" : "user",
    content: String(row.content ?? ""),
    reasoning: String(row.reasoning ?? ""),
    attachments: String(row.attachments ?? "[]"),
    tokens: toNum(row.tokens),
    promptTokens: toNum(row.prompt_tokens),
    completionTokens: toNum(row.completion_tokens),
    createdAt: toIso(row.created_at) ?? nowIso(),
  }));
}

export async function insertAiChatMessage(input: {
  chatId: number;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  attachments?: string;
  tokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}): Promise<number> {
  const row = await q1(sql`insert into ai_chat_messages (chat_id, role, content, reasoning, attachments, tokens, prompt_tokens, completion_tokens, created_at)
    values (${input.chatId}, ${input.role}, ${input.content}, ${input.reasoning ?? ""}, ${input.attachments ?? "[]"}, ${input.tokens ?? 0}, ${input.promptTokens ?? 0}, ${input.completionTokens ?? 0}, ${nowIso()})
    returning id`);
  return toNum(row?.id);
}

/** Месяц в формате YYYY-MM по часовому поясу приложения. */
export function aiMonthKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}`;
}

export type AiUsageTotals = { prompt: number; completion: number; total: number; events: number };

/** Общий и месячный расход токенов пользователя. */
export async function getAiUsage(userId: number, month = aiMonthKey()): Promise<{ all: AiUsageTotals; month: AiUsageTotals }> {
  const all = await q1(sql`select coalesce(sum(prompt_tokens), 0) as prompt, coalesce(sum(completion_tokens), 0) as completion,
      coalesce(sum(total_tokens), 0) as total, count(*) as events
    from ai_usage_events where user_id = ${userId}`);
  const monthRow = await q1(sql`select coalesce(sum(prompt_tokens), 0) as prompt, coalesce(sum(completion_tokens), 0) as completion,
      coalesce(sum(total_tokens), 0) as total, count(*) as events
    from ai_usage_events where user_id = ${userId} and month = ${month}`);
  const map = (row: Raw | null): AiUsageTotals => ({
    prompt: toNum(row?.prompt),
    completion: toNum(row?.completion),
    total: toNum(row?.total),
    events: toNum(row?.events),
  });
  return { all: map(all), month: map(monthRow) };
}

/** Записать расход хода и обновить счётчики чата. Возвращает актуальные суммы. */
export async function recordAiUsage(input: {
  userId: number;
  chatId: number;
  prompt: number;
  completion: number;
}): Promise<{ chat: AiChatRow | null; all: AiUsageTotals; month: AiUsageTotals }> {
  const prompt = Math.max(0, Math.round(input.prompt));
  const completion = Math.max(0, Math.round(input.completion));
  const total = prompt + completion;
  const month = aiMonthKey();
  await q(sql`insert into ai_usage_events (user_id, chat_id, prompt_tokens, completion_tokens, total_tokens, month, created_at)
    values (${input.userId}, ${input.chatId}, ${prompt}, ${completion}, ${total}, ${month}, ${nowIso()})`);
  if (input.chatId > 0) {
    await q(sql`update ai_chats set tokens_prompt = tokens_prompt + ${prompt}, tokens_completion = tokens_completion + ${completion},
      updated_at = ${nowIso()} where id = ${input.chatId} and user_id = ${input.userId}`);
  }
  const usage = await getAiUsage(input.userId, month);
  const chat = input.chatId > 0 ? await getAiChat(input.userId, input.chatId) : null;
  return { chat, all: usage.all, month: usage.month };
}

export type AiQuotaOverrideRow = { userId: number; month: string; monthlyLimit: number };

export async function getAiQuotaOverride(userId: number, month = aiMonthKey()): Promise<AiQuotaOverrideRow | null> {
  const row = await q1(sql`select user_id, month, monthly_limit from ai_quota_overrides
    where user_id = ${userId} and month = ${month} limit 1`);
  if (!row) return null;
  return { userId: toNum(row.user_id), month: String(row.month), monthlyLimit: toNum(row.monthly_limit) };
}

export async function setAiQuotaOverride(userId: number, monthlyLimit: number, createdBy: number, month = aiMonthKey()): Promise<void> {
  const now = nowIso();
  const existing = await getAiQuotaOverride(userId, month);
  if (existing) {
    await q(sql`update ai_quota_overrides set monthly_limit = ${Math.max(0, Math.round(monthlyLimit))}
      where user_id = ${userId} and month = ${month}`);
    return;
  }
  await q(sql`insert into ai_quota_overrides (user_id, month, monthly_limit, created_by, created_at)
    values (${userId}, ${month}, ${Math.max(0, Math.round(monthlyLimit))}, ${createdBy}, ${now})`);
}

export async function clearAiQuotaOverride(userId: number, month = aiMonthKey()): Promise<void> {
  await q(sql`delete from ai_quota_overrides where user_id = ${userId} and month = ${month}`);
}

/** Расход по всем сотрудникам за месяц — для админской сводки. */
export async function listAiUsageByUser(month = aiMonthKey()): Promise<Array<{ userId: number; total: number }>> {
  const rows = await q(sql`select user_id, coalesce(sum(total_tokens), 0) as total from ai_usage_events
    where month = ${month} group by user_id`);
  return rows.map((row) => ({ userId: toNum(row.user_id), total: toNum(row.total) }));
}

/* ------------------------------- RAG для ИИ ------------------------ */

export type RagFolderRow = {
  id: number;
  userId: number;
  name: string;
  filesCount: number;
  chunksCount: number;
  chars: number;
  createdAt: string;
  updatedAt: string;
};

function mapRagFolder(row: Raw): RagFolderRow {
  return {
    id: toNum(row.id),
    userId: toNum(row.user_id),
    name: String(row.name ?? ""),
    filesCount: toNum(row.files_count),
    chunksCount: toNum(row.chunks_count),
    chars: toNum(row.chars),
    createdAt: toIso(row.created_at) ?? nowIso(),
    updatedAt: toIso(row.updated_at) ?? nowIso(),
  };
}

/** Папки RAG, загруженные пользователем. */
export async function listRagFolders(userId: number): Promise<RagFolderRow[]> {
  const rows = await q(sql`select id, user_id, name, files_count, chunks_count, chars, created_at, updated_at
    from ai_rag_folders where user_id = ${userId} order by updated_at desc`);
  return rows.map(mapRagFolder);
}

export async function getRagFolder(userId: number, id: number): Promise<RagFolderRow | null> {
  const row = await q1(sql`select id, user_id, name, files_count, chunks_count, chars, created_at, updated_at
    from ai_rag_folders where id = ${id} and user_id = ${userId} limit 1`);
  return row ? mapRagFolder(row) : null;
}

export async function createRagFolder(userId: number, name: string): Promise<RagFolderRow> {
  const now = nowIso();
  const row = await q1(sql`insert into ai_rag_folders (user_id, name, files_count, chunks_count, chars, created_at, updated_at)
    values (${userId}, ${name}, 0, 0, 0, ${now}, ${now}) returning id, user_id, name, files_count, chunks_count, chars, created_at, updated_at`);
  return mapRagFolder(row ?? { id: 0, user_id: userId, name, files_count: 0, chunks_count: 0, chars: 0, created_at: now, updated_at: now });
}

export async function deleteRagFolder(userId: number, id: number): Promise<boolean> {
  const folder = await getRagFolder(userId, id);
  if (!folder) return false;
  // Каскад в схеме есть, но SQLite включаем явно через удаление потомков.
  await q(sql`delete from ai_rag_terms where folder_id = ${id}`);
  await q(sql`delete from ai_rag_chunks where folder_id = ${id}`);
  await q(sql`delete from ai_rag_folders where id = ${id} and user_id = ${userId}`);
  return true;
}

/** Частоты основ фрагмента — то, что попадёт в обратный индекс. */
export function ragTermFrequencies(text: string): Record<string, number> {
  const terms: Record<string, number> = {};
  for (const token of tokenize(text)) terms[token] = Math.min((terms[token] ?? 0) + 1, 50);
  return terms;
}

/**
 * Догрузка файлов в папку: клиент присылает уже нарезанные фрагменты.
 * Размер порции ограничивает роут, а не эта функция — папка может расти
 * сколько угодно запросов подряд.
 */
export async function addRagChunks(
  folderId: number,
  items: Array<{ path: string; chunks: string[] }>,
): Promise<{ chunks: number; files: number; chars: number }> {
  let added = 0;
  for (const item of items) {
    for (let index = 0; index < item.chunks.length; index += 1) {
      const text = item.chunks[index];
      if (!text.trim()) continue;
      const row = await q1<{ id: number }>(sql`insert into ai_rag_chunks (folder_id, path, chunk_index, text, created_at)
        values (${folderId}, ${item.path}, ${index}, ${text}, ${nowIso()}) returning id`);
      const chunkId = toNum(row?.id);
      const terms = ragTermFrequencies(`${item.path}\n${text}`);
      const values = Object.entries(terms).map(([term, tf]) => sql`(${folderId}, ${term}, ${chunkId}, ${tf})`);
      if (values.length > 0) {
        await q(sql`insert into ai_rag_terms (folder_id, term, chunk_id, tf) values ${sql.join(values, sql`, `)}`);
      }
      added += 1;
    }
  }

  const stats = await q1(sql`select count(*) as chunks, count(distinct path) as files, coalesce(sum(length(text)), 0) as chars
    from ai_rag_chunks where folder_id = ${folderId}`);
  const chunks = toNum(stats?.chunks);
  const files = toNum(stats?.files);
  const chars = toNum(stats?.chars);
  await q(sql`update ai_rag_folders set chunks_count = ${chunks}, files_count = ${files}, chars = ${chars}, updated_at = ${nowIso()}
    where id = ${folderId}`);
  return { chunks: added, files, chars };
}

export type RagSearchHit = { id: number; path: string; text: string; score: number };

export type RagChunkRow = { id: number; path: string; text: string };

/**
 * Все фрагменты папки в документном порядке — для режима «вся база», где в
 * контекст уходит не топ-N, а весь индекс (насколько позволяет контекст модели).
 * `limit` — страховка от гигантских папок, а не смысловое ограничение.
 */
export async function listRagChunks(folderId: number, limit = 50_000): Promise<RagChunkRow[]> {
  const rows = await q(sql`select id, path, text from ai_rag_chunks
    where folder_id = ${folderId} order by path, chunk_index, id limit ${Math.max(1, Math.floor(limit))}`);
  return rows.map((row) => ({ id: toNum(row.id), path: String(row.path), text: String(row.text) }));
}

/**
 * Поиск по папке: BM25-подобный счёт по обратному индексу.
 * Индекс в базе, поэтому размер папки ничем не ограничен, а запрос остаётся
 * дешёвым: сначала выборка по (folder_id, term), потом сортировка в JS.
 */
export async function searchRagChunks(folderId: number, queryText: string, limit = 6): Promise<RagSearchHit[]> {
  const terms = Array.from(new Set(tokenize(queryText))).slice(0, 24);
  if (terms.length === 0) return [];
  const termList = sql.join(terms.map((term) => sql`${term}`), sql`, `);

  const totals = await q1(sql`select chunks_count as chunks from ai_rag_folders where id = ${folderId}`);
  const totalChunks = Math.max(toNum(totals?.chunks), 1);

  const dfRows = await q(sql`select term, count(*) as df from ai_rag_terms
    where folder_id = ${folderId} and term in (${termList}) group by term`);
  const df = new Map<string, number>();
  for (const row of dfRows) df.set(String(row.term), toNum(row.df));
  if (df.size === 0) return [];

  const rows = await q(sql`select t.term, t.tf, c.id as chunk_id, c.path, c.text, length(c.text) as len
    from ai_rag_terms t join ai_rag_chunks c on c.id = t.chunk_id
    where t.folder_id = ${folderId} and t.term in (${termList})
    limit 4000`);

  const scored = new Map<number, { id: number; path: string; text: string; score: number; terms: Set<string> }>();
  for (const row of rows) {
    const chunkId = toNum(row.chunk_id);
    const term = String(row.term);
    const tf = toNum(row.tf);
    const len = Math.max(toNum(row.len), 1);
    const idf = Math.log(1 + totalChunks / Math.max(df.get(term) ?? 1, 1));
    const weight = (Math.min(tf, 4) * idf) / Math.sqrt(len / 400);
    const current = scored.get(chunkId);
    if (current) {
      current.score += weight;
      current.terms.add(term);
    } else {
      scored.set(chunkId, {
        id: chunkId,
        path: String(row.path),
        text: String(row.text),
        score: weight,
        terms: new Set([term]),
      });
    }
  }

  return Array.from(scored.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .map((hit) => ({ id: hit.id, path: hit.path, text: hit.text, score: hit.score }));
}

/* --------------------------- export journal ------------------------ */

export async function listExportedTaskIds(userId: number): Promise<number[]> {
  const rows = await q(sql`select task_id from task_exports where user_id = ${userId}`);
  return rows.map((r) => toNum(r.task_id));
}

export async function lastExportAt(userId: number): Promise<string | null> {
  const row = await q1(sql`select created_at from task_exports where user_id = ${userId} order by id desc limit 1`);
  return row ? toIso(row.created_at) : null;
}

/** Remember that these closed tasks were downloaded by this particular user. */
export async function markTasksExported(userId: number, taskIds: number[]): Promise<void> {
  if (taskIds.length === 0) return;
  const now = nowIso();
  const values = taskIds.map((id) => sql`(${userId}, ${id}, ${now})`);
  await q(sql`insert into task_exports (user_id, task_id, created_at)
    values ${sql.join(values, sql`, `)}
    on conflict do nothing`);
}

/**
 * Отпечаток состояния данных для мягкой проверки обновлений.
 * Клиент опрашивает его раз в 20 секунд: если отпечаток изменился, значит
 * где-то создали/изменили/удалили запись и страницу пора перерисовать.
 * Дёшево: только count(*) и max(updated_at) по трём таблицам.
 */
export async function getLiveRevision(): Promise<string> {
  const rows = await q(sql`
    select
      (select count(*) from tasks) as tasks_count,
      (select max(updated_at) from tasks) as tasks_updated,
      (select count(*) from counterparties) as counterparties_count,
      (select max(updated_at) from counterparties) as counterparties_updated,
      (select count(*) from users) as users_count,
      (select max(updated_at) from users) as users_updated`);
  const row = rows[0] ?? {};
  return [
    toNum(row.tasks_count),
    toIso(row.tasks_updated) ?? "",
    toNum(row.counterparties_count),
    toIso(row.counterparties_updated) ?? "",
    toNum(row.users_count),
    toIso(row.users_updated) ?? "",
  ].join("|");
}

export async function userExists(id: number): Promise<boolean> {
  const row = await q1<{ id: number }>(sql`select id from users where id = ${id} limit 1`);
  return Boolean(row);
}

/* ---------------------- история агента и планировщика --------------------- */

export type AgentConversationKind = "plan" | "agent";

export type AgentConversationRow = {
  id: number;
  userId: number;
  kind: AgentConversationKind;
  title: string;
  systemPrompt: string;
  messagesCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentConversationMessageRow = {
  id: number;
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  reasoning: string;
  attachments: unknown[];
  actions: unknown[];
  files: unknown[];
  error: string;
  createdAt: string;
};

function parseStoredArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapAgentConversation(row: Raw): AgentConversationRow {
  return {
    id: toNum(row.id),
    userId: toNum(row.user_id),
    kind: row.kind === "plan" ? "plan" : "agent",
    title: String(row.title ?? "Новый чат"),
    systemPrompt: String(row.system_prompt ?? ""),
    messagesCount: toNum(row.messages_count),
    createdAt: toIso(row.created_at) ?? nowIso(),
    updatedAt: toIso(row.updated_at) ?? nowIso(),
  };
}

export async function listAgentConversations(
  userId: number,
  kind: AgentConversationKind,
  limit = 100,
): Promise<AgentConversationRow[]> {
  const rows = await q(sql`select c.*,
      (select count(*) from agent_conversation_messages m where m.conversation_id = c.id) as messages_count
    from agent_conversations c
    where c.user_id = ${userId} and c.kind = ${kind}
    order by c.updated_at desc, c.id desc limit ${Math.max(1, Math.min(limit, 200))}`);
  return rows.map(mapAgentConversation);
}

export async function getAgentConversation(userId: number, id: number): Promise<AgentConversationRow | null> {
  const row = await q1(sql`select c.*,
      (select count(*) from agent_conversation_messages m where m.conversation_id = c.id) as messages_count
    from agent_conversations c where c.id = ${id} and c.user_id = ${userId} limit 1`);
  return row ? mapAgentConversation(row) : null;
}

export async function createAgentConversation(
  userId: number,
  kind: AgentConversationKind,
  title = kind === "plan" ? "Новый план" : "Новый чат",
  systemPrompt = "",
): Promise<AgentConversationRow> {
  const now = nowIso();
  const row = await q1<{ id: number }>(sql`insert into agent_conversations
      (user_id, kind, title, system_prompt, created_at, updated_at)
    values (${userId}, ${kind}, ${title.slice(0, 120)}, ${systemPrompt}, ${now}, ${now}) returning id`);
  return {
    id: toNum(row?.id),
    userId,
    kind,
    title: title.slice(0, 120),
    systemPrompt,
    messagesCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateAgentConversation(
  userId: number,
  id: number,
  input: { title?: string; systemPrompt?: string },
): Promise<AgentConversationRow | null> {
  const current = await getAgentConversation(userId, id);
  if (!current) return null;
  const title = input.title === undefined ? current.title : input.title.slice(0, 120);
  const systemPrompt = input.systemPrompt === undefined ? current.systemPrompt : input.systemPrompt;
  await q(sql`update agent_conversations
    set title = ${title}, system_prompt = ${systemPrompt}, updated_at = ${nowIso()}
    where id = ${id} and user_id = ${userId}`);
  return getAgentConversation(userId, id);
}

export async function deleteAgentConversation(userId: number, id: number): Promise<boolean> {
  const current = await getAgentConversation(userId, id);
  if (!current) return false;
  await q(sql`delete from agent_conversation_messages where conversation_id = ${id}`);
  await q(sql`delete from agent_conversations where id = ${id} and user_id = ${userId}`);
  return true;
}

export async function listAgentConversationMessages(conversationId: number): Promise<AgentConversationMessageRow[]> {
  const rows = await q(sql`select id, conversation_id, role, content, reasoning, attachments, actions, files, error, created_at
    from agent_conversation_messages where conversation_id = ${conversationId} order by id asc limit 400`);
  return rows.map((row) => ({
    id: toNum(row.id),
    conversationId: toNum(row.conversation_id),
    role: row.role === "assistant" ? "assistant" : "user",
    content: String(row.content ?? ""),
    reasoning: String(row.reasoning ?? ""),
    attachments: parseStoredArray(row.attachments),
    actions: parseStoredArray(row.actions),
    files: parseStoredArray(row.files),
    error: String(row.error ?? ""),
    createdAt: toIso(row.created_at) ?? nowIso(),
  }));
}

export async function insertAgentConversationMessage(input: {
  userId: number;
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  attachments?: string;
  actions?: string;
  files?: string;
  error?: string;
}): Promise<AgentConversationMessageRow | null> {
  const createdAt = nowIso();
  const row = await q1<{ id: number }>(sql`insert into agent_conversation_messages
      (conversation_id, role, content, reasoning, attachments, actions, files, error, created_at)
    select id, ${input.role}, ${input.content}, ${input.reasoning ?? ""}, ${input.attachments ?? "[]"},
      ${input.actions ?? "[]"}, ${input.files ?? "[]"}, ${input.error ?? ""}, ${createdAt}
    from agent_conversations where id = ${input.conversationId} and user_id = ${input.userId}
    returning id`);
  if (!row) return null;

  const title = input.content.replace(/\s+/g, " ").trim().slice(0, 80);
  await q(sql`update agent_conversations set
      title = case
        when ${input.role} = 'user' and title in ('Новый план', 'Новый чат') and ${title} <> '' then ${title}
        else title
      end,
      updated_at = ${createdAt}
    where id = ${input.conversationId} and user_id = ${input.userId}`);

  return {
    id: toNum(row.id),
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    reasoning: input.reasoning ?? "",
    attachments: parseStoredArray(input.attachments),
    actions: parseStoredArray(input.actions),
    files: parseStoredArray(input.files),
    error: input.error ?? "",
    createdAt,
  };
}

/* ------------------ сохранённые переписки (файлы истории) ---------------- */

export type AgentTranscriptRow = {
  id: number;
  userId: number;
  conversationId: number;
  title: string;
  summary: string;
  fileName: string;
  content: string;
  chars: number;
  createdAt: string;
};

function mapAgentTranscript(row: Raw): AgentTranscriptRow {
  const content = String(row.content ?? "");
  return {
    id: toNum(row.id),
    userId: toNum(row.user_id),
    conversationId: toNum(row.conversation_id),
    title: String(row.title ?? "Переписка агента"),
    summary: String(row.summary ?? ""),
    fileName: String(row.file_name ?? "transcript.md"),
    content,
    chars: toNum(row.chars) || content.length,
    createdAt: toIso(row.created_at) ?? nowIso(),
  };
}

export async function createAgentTranscript(input: {
  userId: number;
  conversationId: number;
  title: string;
  summary: string;
  fileName: string;
  content: string;
}): Promise<AgentTranscriptRow> {
  const createdAt = nowIso();
  const content = String(input.content ?? "").slice(0, 2_000_000);
  const chars = content.length;
  const row = await q1<{ id: number }>(sql`
    insert into agent_transcripts (user_id, conversation_id, title, summary, file_name, content, chars, created_at)
    values (${input.userId}, ${input.conversationId}, ${input.title.slice(0, 160)}, ${input.summary.slice(0, 20_000)},
            ${input.fileName.slice(0, 160)}, ${content}, ${chars}, ${createdAt})
    returning id`);
  return {
    id: toNum(row?.id),
    userId: input.userId,
    conversationId: input.conversationId,
    title: input.title.slice(0, 160),
    summary: input.summary.slice(0, 20_000),
    fileName: input.fileName.slice(0, 160),
    content,
    chars,
    createdAt,
  };
}

export async function listAgentTranscripts(
  userId: number,
  limit = 40,
): Promise<Array<Omit<AgentTranscriptRow, "content">>> {
  const rows = await q(sql`
    select id, user_id, conversation_id, title, summary, file_name, chars, created_at
    from agent_transcripts
    where user_id = ${userId}
    order by id desc
    limit ${Math.max(1, Math.min(limit, 100))}`);
  return rows.map((row) => ({
    id: toNum(row.id),
    userId: toNum(row.user_id),
    conversationId: toNum(row.conversation_id),
    title: String(row.title ?? "Переписка агента"),
    summary: String(row.summary ?? ""),
    fileName: String(row.file_name ?? "transcript.md"),
    chars: toNum(row.chars),
    createdAt: toIso(row.created_at) ?? nowIso(),
  }));
}

export async function getAgentTranscript(userId: number, id: number): Promise<AgentTranscriptRow | null> {
  const row = await q1(sql`
    select id, user_id, conversation_id, title, summary, file_name, content, chars, created_at
    from agent_transcripts
    where id = ${id} and user_id = ${userId}
    limit 1`);
  return row ? mapAgentTranscript(row) : null;
}

export async function deleteAgentTranscript(userId: number, id: number): Promise<boolean> {
  const existing = await getAgentTranscript(userId, id);
  if (!existing) return false;
  await q(sql`delete from agent_transcripts where id = ${id} and user_id = ${userId}`);
  return true;
}

