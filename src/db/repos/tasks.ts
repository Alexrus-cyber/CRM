import { sql } from "drizzle-orm";
import { nowIso, q, q1, toIso, toNum, toYmd } from "../dialect";
import type { TaskPriority, TaskStatus } from "../schema";
import type { Raw } from "./shared";

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

export type CounterpartyValues = {
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  inn: string | null;
  kpp: string | null;
  notes: string | null;
};

export type CounterpartyRef = { id: number; name: string; kpp: string | null };

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

export const TASK_MESSAGE_MAX = 2000;

const TASK_SELECT = sql`t.id, t.title, t.description, t.assignee_id, t.author_id, t.counterparty_id,
  t.deadline, t.deadline_time, t.accepted_at, t.hours, t.status, t.priority, t.completed_at, t.closed_at, t.created_at, t.updated_at,
  case when a.deleted_at is null then a.name else a.name || ' (удалён)' end as assignee_name,
  a.avatar_color as assignee_color, a.avatar_url as assignee_avatar,
  case when au.deleted_at is null then au.name else au.name || ' (удалён)' end as author_name,
  au.avatar_color as author_color, au.avatar_url as author_avatar,
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

export async function findCounterpartiesByInns(inns: string[]): Promise<Map<string, CounterpartyRef>> {
  const found = new Map<string, CounterpartyRef>();
  const unique = [...new Set(inns.filter(Boolean))];
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

/* ----------------------- переписка по задаче ------------------------ */

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

/* --------------------------- export journal & live revision -------- */

export async function listExportedTaskIds(userId: number): Promise<number[]> {
  const rows = await q(sql`select task_id from task_exports where user_id = ${userId}`);
  return rows.map((r) => toNum(r.task_id));
}

export async function lastExportAt(userId: number): Promise<string | null> {
  const row = await q1(sql`select created_at from task_exports where user_id = ${userId} order by id desc limit 1`);
  return row ? toIso(row.created_at) : null;
}

export async function markTasksExported(userId: number, taskIds: number[]): Promise<void> {
  if (taskIds.length === 0) return;
  const now = nowIso();
  const values = taskIds.map((id) => sql`(${userId}, ${id}, ${now})`);
  await q(sql`insert into task_exports (user_id, task_id, created_at)
    values ${sql.join(values, sql`, `)}
    on conflict do nothing`);
}

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
