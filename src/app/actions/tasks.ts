"use server";

import { revalidatePath } from "next/cache";
import type { TaskPriority, TaskStatus } from "@/db/schema";
import {
  acceptTask,
  deleteTask,
  getTaskAccess,
  insertTask,
  setTaskDeadlineAndTime,
  setTaskStatusRow,
  updateTask,
  updateTaskAsAssignee,
} from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { isAdminRole, PRIORITY_ORDER, STATUS_ORDER } from "@/lib/utils";
import { normalizeTime } from "@/lib/taskTime";
import type { ActionResult } from "./users";

export type TaskInput = {
  id?: number;
  title: string;
  description?: string;
  assigneeId: number;
  counterpartyId?: number | null;
  deadline: string;
  deadlineTime?: string | null;
  hours: number;
  status: TaskStatus;
  priority: TaskPriority;
};

function statusTimestamps(
  next: TaskStatus,
  prev: { completedAt: string | null; closedAt: string | null },
) {
  const now = new Date().toISOString();
  if (next === "done") {
    return { completedAt: prev.completedAt ?? now, closedAt: null as string | null };
  }
  if (next === "closed") {
    return { completedAt: prev.completedAt ?? now, closedAt: prev.closedAt ?? now };
  }
  if (next === "cancelled") {
    return { completedAt: prev.completedAt, closedAt: prev.closedAt };
  }
  return { completedAt: null as string | null, closedAt: null as string | null };
}

export async function saveTaskAction(input: TaskInput): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Не авторизован" };
  const title = input.title.trim();
  if (!title) return { ok: false, error: "Название задачи обязательно" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.deadline)) return { ok: false, error: "Укажите срок" };
  if (!input.assigneeId) return { ok: false, error: "Выберите исполнителя" };
  if (!STATUS_ORDER.includes(input.status)) return { ok: false, error: "Некорректный статус" };
  if (!PRIORITY_ORDER.includes(input.priority)) return { ok: false, error: "Некорректная срочность" };
  const hours = Number.isFinite(input.hours) && input.hours >= 0 ? input.hours : 0;
  const deadlineTime = input.deadlineTime ? normalizeTime(input.deadlineTime) : null;
  if (input.deadlineTime && !deadlineTime) return { ok: false, error: "Некорректное время (ЧЧ:ММ)" };

  if (input.id) {
    const existing = await getTaskAccess(input.id);
    if (!existing) return { ok: false, error: "Задача не найдена" };
    const isOwner = isAdminRole(me.role) || existing.authorId === me.id;
    const isAssignee = existing.assigneeId === me.id;
    if (!isOwner && !isAssignee) return { ok: false, error: "Нет доступа к задаче" };
    if (input.status === "closed" && !isOwner && existing.status !== "closed") {
      return { ok: false, error: "Закрыть задачу может только автор или администратор" };
    }
    const ts =
      input.status !== existing.status
        ? statusTimestamps(input.status, existing)
        : { completedAt: existing.completedAt, closedAt: existing.closedAt };
    // Taking the task into work counts as accepting it.
    const acceptedAt = ts.completedAt
      ? ts.completedAt
      : existing.acceptedAt ?? (input.status !== "new" ? new Date().toISOString() : null);
    if (isOwner) {
      await updateTask(input.id, {
        title,
        description: input.description?.trim() || null,
        assigneeId: input.assigneeId,
        authorId: existing.authorId,
        counterpartyId: input.counterpartyId || null,
        deadline: input.deadline,
        deadlineTime,
        hours,
        status: input.status,
        priority: input.priority,
        acceptedAt,
        ...ts,
      });
    } else {
      await updateTaskAsAssignee(input.id, {
        status: input.status,
        hours,
        description: input.description?.trim() || null,
        acceptedAt,
        ...ts,
      });
    }
    revalidatePath("/", "layout");
    return { ok: true, id: input.id };
  }

  const ts = statusTimestamps(input.status, { completedAt: null, closedAt: null });
  const acceptedAt =
    input.status === "new" ? null : ts.completedAt ?? new Date().toISOString();
  const id = await insertTask({
    title,
    description: input.description?.trim() || null,
    assigneeId: input.assigneeId,
    authorId: me.id,
    counterpartyId: input.counterpartyId || null,
    deadline: input.deadline,
    deadlineTime,
    hours,
    status: input.status,
    priority: input.priority,
    acceptedAt,
    ...ts,
  });
  revalidatePath("/", "layout");
  return { ok: true, id };
}

export async function setTaskStatusAction(id: number, status: TaskStatus): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Не авторизован" };
  if (!STATUS_ORDER.includes(status)) return { ok: false, error: "Некорректный статус" };
  const existing = await getTaskAccess(id);
  if (!existing) return { ok: false, error: "Задача не найдена" };
  const isOwner = isAdminRole(me.role) || existing.authorId === me.id;
  const isAssignee = existing.assigneeId === me.id;
  if (!isOwner && !isAssignee) return { ok: false, error: "Нет доступа к задаче" };
  if (status === "closed" && !isOwner) {
    return { ok: false, error: "Закрыть задачу может только автор или администратор" };
  }
  const ts = statusTimestamps(status, existing);
  const acceptedAt = existing.acceptedAt ?? (status !== "new" ? new Date().toISOString() : null);
  await setTaskStatusRow(id, { status, ...ts, acceptedAt });
  revalidatePath("/", "layout");
  return { ok: true, id };
}

export async function rescheduleTaskAction(
  id: number,
  deadline: string,
  deadlineTime?: string | null,
): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Не авторизован" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return { ok: false, error: "Некорректная дата" };
  const time = deadlineTime === undefined ? undefined : deadlineTime ? normalizeTime(deadlineTime) : null;
  if (deadlineTime && time === null) return { ok: false, error: "Некорректное время (ЧЧ:ММ)" };
  const existing = await getTaskAccess(id);
  if (!existing) return { ok: false, error: "Задача не найдена" };
  if (!isAdminRole(me.role) && existing.authorId !== me.id) {
    return { ok: false, error: "Перенести срок может только автор или администратор" };
  }
  await setTaskDeadlineAndTime(id, deadline, time === undefined ? existing.deadlineTime : time);
  revalidatePath("/", "layout");
  return { ok: true, id };
}

/** Assignee (or admin) accepts the task — it stops being "new" and starts the clock out. */
export async function acceptTaskAction(id: number): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Не авторизован" };
  const existing = await getTaskAccess(id);
  if (!existing) return { ok: false, error: "Задача не найдена" };
  if (!isAdminRole(me.role) && existing.assigneeId !== me.id && existing.authorId !== me.id) {
    return { ok: false, error: "Принять задачу может только исполнитель" };
  }
  if (existing.acceptedAt) return { ok: true, id };
  await acceptTask(id);
  revalidatePath("/", "layout");
  return { ok: true, id };
}

export async function deleteTaskAction(id: number): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Не авторизован" };
  const existing = await getTaskAccess(id);
  if (!existing) return { ok: false, error: "Задача не найдена" };
  if (!isAdminRole(me.role) && existing.authorId !== me.id) {
    return { ok: false, error: "Удалить задачу может только автор или администратор" };
  }
  await deleteTask(id);
  revalidatePath("/", "layout");
  return { ok: true, id };
}
