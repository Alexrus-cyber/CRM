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
import { canManageData, PRIORITY_ORDER, STATUS_ORDER } from "@/lib/utils";
import { publishLiveEvent } from "@/lib/events";
import { normalizeTime } from "@/lib/taskTime";
import { parseJsonBody, taskInputSchema } from "@/lib/validation";
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
  const parsed = parseJsonBody(input, taskInputSchema, "Некорректные данные задачи");
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const data = parsed.data;
  const title = data.title;
  const hours = data.hours;
  const deadlineTime = data.deadlineTime ? normalizeTime(data.deadlineTime) : null;
  if (data.deadlineTime && !deadlineTime) return { ok: false, error: "Некорректное время (ЧЧ:ММ)" };

  if (data.id) {
    const existing = await getTaskAccess(data.id);
    if (!existing) return { ok: false, error: "Задача не найдена" };
    const isOwner = canManageData(me.role) || existing.authorId === me.id;
    const isAssignee = existing.assigneeId === me.id;
    if (!isOwner && !isAssignee) return { ok: false, error: "Нет доступа к задаче" };
    if (data.status === "closed" && !isOwner && existing.status !== "closed") {
      return { ok: false, error: "Закрыть задачу может только автор или администратор" };
    }
    const ts =
      data.status !== existing.status
        ? statusTimestamps(data.status, existing)
        : { completedAt: existing.completedAt, closedAt: existing.closedAt };
    // Taking the task into work counts as accepting it.
    const acceptedAt = ts.completedAt
      ? ts.completedAt
      : existing.acceptedAt ?? (data.status !== "new" ? new Date().toISOString() : null);
    if (isOwner) {
      await updateTask(data.id, {
        title,
        description: data.description?.trim() || null,
        assigneeId: data.assigneeId,
        authorId: existing.authorId,
        counterpartyId: data.counterpartyId || null,
        deadline: data.deadline,
        deadlineTime,
        hours,
        status: data.status,
        priority: data.priority,
        acceptedAt,
        ...ts,
      });
    } else {
      await updateTaskAsAssignee(data.id, {
        status: data.status,
        hours,
        description: data.description?.trim() || null,
        acceptedAt,
        ...ts,
      });
    }
    revalidatePath("/", "layout");
    publishLiveEvent("tasks", me.id);
    return { ok: true, id: data.id };
  }

  const ts = statusTimestamps(data.status, { completedAt: null, closedAt: null });
  const acceptedAt =
    data.status === "new" ? null : ts.completedAt ?? new Date().toISOString();
  const id = await insertTask({
    title,
    description: data.description?.trim() || null,
    assigneeId: data.assigneeId,
    authorId: me.id,
    counterpartyId: data.counterpartyId || null,
    deadline: data.deadline,
    deadlineTime,
    hours,
    status: data.status,
    priority: data.priority,
    acceptedAt,
    ...ts,
  });
  revalidatePath("/", "layout");
  publishLiveEvent("tasks", me.id);
  return { ok: true, id };
}

export async function setTaskStatusAction(id: number, status: TaskStatus): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Не авторизован" };
  if (!STATUS_ORDER.includes(status)) return { ok: false, error: "Некорректный статус" };
  const existing = await getTaskAccess(id);
  if (!existing) return { ok: false, error: "Задача не найдена" };
  const isOwner = canManageData(me.role) || existing.authorId === me.id;
  const isAssignee = existing.assigneeId === me.id;
  if (!isOwner && !isAssignee) return { ok: false, error: "Нет доступа к задаче" };
  if (status === "closed" && !isOwner) {
    return { ok: false, error: "Закрыть задачу может только автор или администратор" };
  }
  const ts = statusTimestamps(status, existing);
  const acceptedAt = existing.acceptedAt ?? (status !== "new" ? new Date().toISOString() : null);
  await setTaskStatusRow(id, { status, ...ts, acceptedAt });
  revalidatePath("/", "layout");
  publishLiveEvent("tasks", me.id);
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
  if (!canManageData(me.role) && existing.authorId !== me.id) {
    return { ok: false, error: "Перенести срок может только автор или администратор" };
  }
  await setTaskDeadlineAndTime(id, deadline, time === undefined ? existing.deadlineTime : time);
  revalidatePath("/", "layout");
  publishLiveEvent("tasks", me.id);
  return { ok: true, id };
}

/** Assignee (or admin) accepts the task — it stops being "new" and starts the clock out. */
export async function acceptTaskAction(id: number): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Не авторизован" };
  const existing = await getTaskAccess(id);
  if (!existing) return { ok: false, error: "Задача не найдена" };
  if (!canManageData(me.role) && existing.assigneeId !== me.id && existing.authorId !== me.id) {
    return { ok: false, error: "Принять задачу может только исполнитель" };
  }
  if (existing.acceptedAt) return { ok: true, id };
  await acceptTask(id);
  revalidatePath("/", "layout");
  publishLiveEvent("tasks", me.id);
  return { ok: true, id };
}

export async function deleteTaskAction(id: number): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Не авторизован" };
  const existing = await getTaskAccess(id);
  if (!existing) return { ok: false, error: "Задача не найдена" };
  if (!canManageData(me.role) && existing.authorId !== me.id) {
    return { ok: false, error: "Удалить задачу может только автор или администратор" };
  }
  await deleteTask(id);
  revalidatePath("/", "layout");
  publishLiveEvent("tasks", me.id);
  return { ok: true, id };
}
