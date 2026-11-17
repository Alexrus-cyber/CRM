import { sql } from "drizzle-orm";
import { nowIso, q, q1, toIso, toNum, toYmd } from "./dialect";
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

export type ChatMessage = {
  id: number;
  senderId: number;
  recipientId: number | null;
  content: string;
  createdAt: string;
  senderName: string;
  senderColor: string;
  senderAvatar: string | null;
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
  c.name as counterparty_name, c.inn as counterparty_inn, c.kpp as counterparty_kpp`;

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

export async function listMessages(meId: number, peer: number, afterId: number): Promise<ChatMessage[]> {
  const conversation = peer === 0
    ? sql`m.recipient_id is null`
    : sql`((m.sender_id = ${meId} and m.recipient_id = ${peer}) or (m.sender_id = ${peer} and m.recipient_id = ${meId}))`;
  const filter = afterId > 0 ? sql`${conversation} and m.id > ${afterId}` : conversation;
  const rows = await q(sql`
    select m.id, m.sender_id, m.recipient_id, m.content, m.created_at,
           u.name as sender_name, u.avatar_color as sender_color, u.avatar_url as sender_avatar
    from messages m join users u on u.id = m.sender_id
    where ${filter}
    order by m.id desc limit 150`);
  return rows
    .map((r) => ({
      id: toNum(r.id),
      senderId: toNum(r.sender_id),
      recipientId: r.recipient_id === null || r.recipient_id === undefined ? null : toNum(r.recipient_id),
      content: String(r.content),
      createdAt: toIso(r.created_at) ?? nowIso(),
      senderName: String(r.sender_name ?? ""),
      senderColor: String(r.sender_color ?? "#7c5cff"),
      senderAvatar: (r.sender_avatar as string | null) ?? null,
    }))
    .reverse();
}

export async function insertMessage(senderId: number, recipientId: number | null, content: string): Promise<number> {
  const row = await q1<{ id: number }>(sql`
    insert into messages (sender_id, recipient_id, content, created_at)
    values (${senderId}, ${recipientId}, ${content}, ${nowIso()}) returning id`);
  return toNum(row?.id);
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

export async function userExists(id: number): Promise<boolean> {
  const row = await q1<{ id: number }>(sql`select id from users where id = ${id} limit 1`);
  return Boolean(row);
}
