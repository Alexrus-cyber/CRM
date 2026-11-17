/**
 * Task scheduling helpers.
 *
 * A task has a calendar date (`deadline`, YYYY-MM-DD) and an optional time slot
 * (`deadlineTime`, HH:MM). All comparisons are done in the app timezone
 * (Europe/Moscow) so behaviour is identical on the server and in the browser.
 */
import { dateToStr } from "./utils";

export const APP_TZ_OFFSET = "+03:00";
export const ACCEPT_WINDOW_MS = 60 * 60 * 1000; // 1 hour to accept the task
export const DEFAULT_TASK_TIME = "18:00";
export const END_OF_DAY_TIME = "23:59";

export function normalizeTime(value?: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Scheduled moment of the task (date + time). Without time — end of that day. */
export function scheduledAt(deadline: string, deadlineTime?: string | null): Date {
  const time = normalizeTime(deadlineTime) ?? END_OF_DAY_TIME;
  const parsed = new Date(`${deadline}T${time}:00${APP_TZ_OFFSET}`);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  return new Date(`${deadline}T${END_OF_DAY_TIME}:00${APP_TZ_OFFSET}`);
}

export function formatTimeLabel(deadlineTime?: string | null): string {
  return normalizeTime(deadlineTime) ?? "—";
}

/** "14.11.2026" + "15:00" -> "14.11.2026, 15:00" */
export function formatTaskMoment(deadline: string, deadlineTime?: string | null): string {
  const [y, m, d] = deadline.split("-");
  const date = y && m && d ? `${d}.${m}.${y}` : deadline;
  const time = normalizeTime(deadlineTime);
  return time ? `${date}, ${time}` : date;
}

export type TaskTiming = {
  status: "new" | "in_progress" | "review" | "done" | "closed" | "cancelled";
  deadline: string;
  deadlineTime?: string | null;
  acceptedAt?: string | null;
};

const OPEN: TaskTiming["status"][] = ["new", "in_progress", "review"];

export function isOpenStatus(status: TaskTiming["status"]) {
  return OPEN.includes(status);
}

/** Task is on today's schedule (or was scheduled earlier and is still open). */
export function isForToday(deadline: string, now: Date = new Date()) {
  return deadline === dateToStr(now);
}

/** Scheduled day is already in the past — the whole day was missed. */
export function isOverdueByDay(deadline: string, now: Date = new Date()) {
  return deadline < dateToStr(now);
}

/**
 * The task must be accepted: it is still "new", the scheduled moment plus the
 * one hour acceptance window has passed, and the scheduled day is not over yet.
 * Such tasks are highlighted for the assignee ("обязан взять в работу").
 */
export function needsAcceptance(task: TaskTiming, now: Date = new Date()): boolean {
  if (task.status !== "new") return false;
  if (task.acceptedAt) return false;
  if (isOverdueByDay(task.deadline, now)) return false;
  const scheduled = scheduledAt(task.deadline, task.deadlineTime).getTime();
  return now.getTime() >= scheduled + ACCEPT_WINDOW_MS;
}

/** Scheduled time has already started but the acceptance hour is not over yet. */
export function isDueNow(task: TaskTiming, now: Date = new Date()): boolean {
  if (task.status !== "new" || task.acceptedAt) return false;
  if (isOverdueByDay(task.deadline, now)) return false;
  const scheduled = scheduledAt(task.deadline, task.deadlineTime).getTime();
  return now.getTime() >= scheduled && now.getTime() < scheduled + ACCEPT_WINDOW_MS;
}

/** Minutes left before the acceptance deadline (negative when overdue). */
export function minutesToAccept(task: TaskTiming, now: Date = new Date()): number {
  const scheduled = scheduledAt(task.deadline, task.deadlineTime).getTime();
  return Math.round((scheduled + ACCEPT_WINDOW_MS - now.getTime()) / 60000);
}

export function formatMinutesLeft(minutes: number): string {
  if (minutes <= 0) return "время на принятие истекло";
  if (minutes < 60) return `принять в течение ${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `принять в течение ${hours} ч ${rest} мин` : `принять в течение ${hours} ч`;
}

/** Hour bucket used by the "today" timeline: "15:00" or "Без времени". */
export function hourBucket(deadlineTime?: string | null): string {
  const time = normalizeTime(deadlineTime);
  if (!time) return "Без времени";
  return `${time.slice(0, 2)}:00`;
}

/** Next full hour as HH:MM — handy default when creating a task for today. */
export function nextHourTime(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const hour = Math.min(23, (get("hour") + 1) % 24);
  return `${String(hour).padStart(2, "0")}:00`;
}

export type TaskPriorityLevel = "needs_accept" | "overdue" | "due" | "today" | "upcoming" | "done";

/** Priority ordering used by the "today" widget and by the tasks list. */
export function taskPriorityRank(task: TaskTiming, now: Date = new Date()): number {
  if (!isOpenStatus(task.status)) return 5;
  if (needsAcceptance(task, now)) return 0;
  if (isOverdueByDay(task.deadline, now)) return 1;
  if (task.deadline === dateToStr(now)) return 2;
  return 3;
}
