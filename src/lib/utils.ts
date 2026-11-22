import type { Role, TaskPriority, TaskStatus } from "@/db/schema";
import {
  ROLE_LABELS as PERMISSION_ROLE_LABELS,
  canManageData,
  canManageTeam,
  canResetPasswords,
  isAdminRole,
  isCompanyRole,
} from "./permissions";

export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export const TZ = "Europe/Moscow";

export const STATUS_LABELS: Record<TaskStatus, string> = {
  new: "Новая",
  in_progress: "В работе",
  review: "На проверке",
  done: "Выполнена",
  closed: "Закрыта",
  cancelled: "Отменена",
};

export const STATUS_ORDER: TaskStatus[] = [
  "new",
  "in_progress",
  "review",
  "done",
  "closed",
  "cancelled",
];

export const STATUS_COLORS: Record<TaskStatus, string> = {
  new: "#60a5fa",
  in_progress: "#a78bfa",
  review: "#f59e0b",
  done: "#34d399",
  closed: "#10b981",
  cancelled: "#6b7280",
};

export const STATUS_BADGE: Record<TaskStatus, string> = {
  new: "bg-sky-500/15 text-sky-500 border-sky-500/30",
  in_progress: "bg-violet-500/15 text-violet-400 border-violet-500/30",
  review: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  done: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
  closed: "bg-emerald-600/20 text-emerald-600 border-emerald-600/30",
  cancelled: "bg-gray-500/15 text-gray-400 border-gray-500/30",
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Низкая",
  medium: "Средняя",
  high: "Высокая",
  critical: "Критическая",
};

export const PRIORITY_ORDER: TaskPriority[] = [
  "low",
  "medium",
  "high",
  "critical",
];

export const PRIORITY_COLORS: Record<TaskPriority, string> = {
  low: "#6b7280",
  medium: "#60a5fa",
  high: "#f59e0b",
  critical: "#ef4444",
};

export const PRIORITY_BADGE: Record<TaskPriority, string> = {
  low: "bg-gray-500/15 text-gray-400 border-gray-500/30",
  medium: "bg-sky-500/15 text-sky-500 border-sky-500/30",
  high: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  critical: "bg-red-500/15 text-red-500 border-red-500/30",
};

export const ROLE_LABELS: Record<Role, string> = PERMISSION_ROLE_LABELS;

export const OPEN_STATUSES: TaskStatus[] = ["new", "in_progress", "review"];
export const FINISHED_STATUSES: TaskStatus[] = ["done", "closed"];

export const AVATAR_COLORS = [
  "#7c5cff",
  "#a78bfa",
  "#ec4899",
  "#f43f5e",
  "#f97316",
  "#f59e0b",
  "#22c55e",
  "#10b981",
  "#06b6d4",
  "#3b82f6",
  "#6366f1",
  "#64748b",
];

export { isAdminRole, isCompanyRole, canManageTeam, canManageData, canResetPasswords };

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

/** Today as YYYY-MM-DD in the app timezone (deterministic on server and client). */
export function todayStr(): string {
  return dateToStr(new Date());
}

export function dateToStr(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Format YYYY-MM-DD -> DD.MM.YYYY */
export function formatDate(s: string | null | undefined): string {
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  if (!y || !m || !d) return s;
  return `${d}.${m}.${y}`;
}

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatTime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Difference in whole days between two YYYY-MM-DD strings (b - a). */
export function diffDays(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.round((db - da) / 86400000);
}

export function addDays(s: string, days: number): string {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Add N business days (Mon-Fri) to a YYYY-MM-DD date. */
export function addBusinessDays(s: string, days: number): string {
  let d = new Date(s + "T00:00:00Z");
  let left = Math.max(0, Math.ceil(days));
  while (left > 0) {
    d = new Date(d.getTime() + 86400000);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

export function pluralRu(n: number, one: string, few: string, many: string) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/** Plural forms for "просрочено N дней" (accusative, same endings as nominative here). */
export function pluralDaysAcc(n: number) {
  return pluralRu(n, "день", "дня", "дней");
}

export function formatHours(h: number) {
  return Number.isInteger(h) ? `${h} ч` : `${h.toFixed(1)} ч`;
}

export function roleBadgeClass(role: Role) {
  switch (role) {
    case "super_admin":
      return "bg-amber-500/15 text-amber-500 border-amber-500/30";
    case "admin":
      return "bg-violet-500/15 text-violet-400 border-violet-500/30";
    case "manager":
      return "bg-emerald-500/15 text-emerald-500 border-emerald-500/30";
    case "developer":
      return "bg-cyan-500/15 text-cyan-400 border-cyan-500/30";
    case "consultant":
      return "bg-fuchsia-500/15 text-fuchsia-400 border-fuchsia-500/30";
    default:
      return "bg-sky-500/15 text-sky-500 border-sky-500/30";
  }
}
