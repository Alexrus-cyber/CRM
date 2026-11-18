"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlarmClock, Check, ChevronRight, CircleAlert, Clock, Hand, Sunrise, Users } from "lucide-react";
import type { TaskRow } from "@/lib/data";
import { acceptTaskAction, setTaskStatusAction } from "@/app/actions/tasks";
import { CheckCircle } from "lucide-react";
import { dateToStr, formatDate, cn, todayStr } from "@/lib/utils";
import {
  formatMinutesLeft,
  formatTimeLabel,
  hourBucket,
  isOpenStatus,
  isOverdueByDay,
  minutesToAccept,
  needsAcceptance,
  scheduledAt,
} from "@/lib/taskTime";
import { Avatar, PriorityBadge, StatusBadge } from "./ui";

const currentHourKey = (now: Date) =>
  `${new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Moscow", hour: "2-digit", hour12: false }).format(now)}:00`;

export function TodayTimeline({
  tasks,
  meId,
  userName,
  showOthers = false,
}: {
  tasks: TaskRow[];
  meId: number;
  userName: string;
  /** Админам и менеджерам показываем ещё и задачи коллег на сегодня. */
  showOthers?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [now, setNow] = useState(() => new Date());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  const today = todayStr();

  const { mine, overdue, accept, acceptedToday, hours, noTime, hourKeys, todayCount, othersToday } = useMemo(() => {
    const mine = tasks.filter((t) => t.assigneeId === meId && isOpenStatus(t.status));
    const overdueList = mine.filter((t) => isOverdueByDay(t.deadline, now));
    const todayList = mine
      .filter((t) => t.deadline === today)
      .sort((a, b) => scheduledAt(a.deadline, a.deadlineTime).getTime() - scheduledAt(b.deadline, b.deadlineTime).getTime());
    const acceptList = mine.filter((t) => needsAcceptance(t, now));
    const acceptedTodayCount = tasks.filter(
      (t) => t.assigneeId === meId && t.acceptedAt && dateToStr(new Date(t.acceptedAt)) === today,
    ).length;
    const grouped = new Map<string, TaskRow[]>();
    for (const t of todayList) {
      const key = hourBucket(t.deadlineTime);
      const list = grouped.get(key) ?? [];
      list.push(t);
      grouped.set(key, list);
    }
    const keys = [...grouped.keys()].filter((key) => key !== "Без времени").sort();
    return {
      mine,
      overdue: overdueList,
      accept: acceptList,
      acceptedToday: acceptedTodayCount,
      hours: grouped,
      noTime: grouped.get("Без времени") ?? [],
      hourKeys: keys,
      todayCount: todayList.length,
      // Задачи коллег на сегодня — только для чтения, свои всегда идут первыми.
      othersToday: tasks
        .filter((t) => t.assigneeId !== meId && isOpenStatus(t.status) && t.deadline === today)
        .sort(
          (a, b) =>
            scheduledAt(a.deadline, a.deadlineTime).getTime() - scheduledAt(b.deadline, b.deadlineTime).getTime(),
        ),
    };
  }, [tasks, meId, now, today]);

  const acceptTask = (id: number) => {
    setError(null);
    start(async () => {
      const res = await acceptTaskAction(id);
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  };

  const startTask = (id: number) => {
    setError(null);
    start(async () => {
      const res = await setTaskStatusAction(id, "in_progress");
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  };

  const completeTask = (id: number) => {
    setError(null);
    start(async () => {
      const res = await setTaskStatusAction(id, "done");
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  };

  const row = (t: TaskRow, highlight: boolean) => {
    const overdueTask = isOverdueByDay(t.deadline, now);
    const minutesLeft = minutesToAccept(t, now);
    return (
      <li
        key={t.id}
        className={cn(
          "flex min-w-0 flex-col gap-2 rounded-xl border p-2.5 sm:flex-row sm:items-center",
          highlight
            ? "border-red-500/50 bg-red-500/10 shadow-[0_0_0_1px_rgba(239,68,68,0.25)]"
            : overdueTask
              ? "border-red-500/25 bg-card2/60"
              : "border-border bg-card2/40",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              "flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-lg text-[11px] font-semibold tabular-nums",
              highlight ? "bg-red-500/20 text-red-500" : "bg-accent/15 text-accent2",
            )}
          >
            {formatTimeLabel(t.deadlineTime).slice(0, 5)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="truncate text-[13px] font-medium leading-tight">{t.title}</p>
              {highlight && (
                <span className="flex shrink-0 items-center gap-1 rounded-md bg-red-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-red-500">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" /> обязан взять
                </span>
              )}
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted sm:text-[11px]">
              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: t.assigneeColor }} />вы</span>
              <span>{t.hours} ч</span>
              {t.counterpartyName && <span className="truncate">· {t.counterpartyName}</span>}
              {highlight && <span className="text-red-500">{formatMinutesLeft(minutesLeft)}</span>}
            </div>
          </div>
          <span className="hidden shrink-0 sm:block"><StatusBadge status={t.status} /></span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <span className="sm:hidden"><StatusBadge status={t.status} /></span>
          <span className="hidden min-[420px]:block"><PriorityBadge priority={t.priority} /></span>
          {t.status === "new" && (
            <button
              type="button"
              onClick={() => acceptTask(t.id)}
              disabled={pending}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-medium transition disabled:opacity-50",
                highlight ? "bg-red-500 text-white hover:brightness-110" : "border border-border bg-card hover:border-accent/60",
              )}
            >
              <Hand size={12} /> Принять
            </button>
          )}
          {t.status === "new" && (
            <button
              type="button"
              onClick={() => startTask(t.id)}
              disabled={pending}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-card px-2 text-[11px] font-medium transition hover:border-accent/60 disabled:opacity-50"
              title="Сразу перевести в работу"
            >
              <ChevronRight size={12} /> В работу
            </button>
          )}
          {t.status !== "new" && t.status !== "done" && (
            <button
              type="button"
              onClick={() => completeTask(t.id)}
              disabled={pending}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-card px-2 text-[11px] font-medium transition hover:border-emerald-500/60 hover:text-emerald-500 disabled:opacity-50"
              title="Отметить выполненной"
            >
              <CheckCircle size={12} /> Выполнено
            </button>
          )}
          {t.status !== "new" && (
            <Link href="/tasks" className="inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-card px-2 text-[11px] text-muted transition hover:text-text" title="Открыть в списке задач">
              <Check size={12} /> В задачах
            </Link>
          )}
        </div>
      </li>
    );
  };

  return (
    <section className="min-w-0 rounded-2xl border border-border bg-card p-3 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <Sunrise size={15} className="shrink-0 text-amber-400" />
            <span className="truncate">Задачи на сегодня</span>
          </h2>
          <p className="mt-0.5 text-xs text-muted">Расписание по часам: {userName} — сначала то, что нужно принять</p>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          <span className="rounded-lg bg-card2 px-2 py-1">На сегодня: <b className="text-text">{todayCount}</b></span>
          <span className="rounded-lg bg-card2 px-2 py-1">Принято: <b className="text-emerald-500">{acceptedToday}</b></span>
          <span className={cn("rounded-lg px-2 py-1", accept.length ? "bg-red-500/15 text-red-500" : "bg-card2")}>Обязан взять: <b>{accept.length}</b></span>
          <span className={cn("rounded-lg px-2 py-1", overdue.length ? "bg-red-500/10 text-red-500" : "bg-card2")}>Просрочено: <b>{overdue.length}</b></span>
        </div>
      </div>

      {error && <p className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">{error}</p>}

      {accept.length > 0 && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-2.5 text-[11px] text-red-500">
          <AlarmClock size={14} className="mt-0.5 shrink-0" />
          <p>
            <b>{accept.length}</b>{" "}
            {accept.length === 1
              ? "задача не принята в течение часа после назначенного времени — вы обязаны взять её в работу. Если не взять в работу до конца дня, она станет просроченной."
              : `${accept.length < 5 ? "задачи не приняты" : "задач не приняты"} в течение часа после назначенного времени — вы обязаны взять их в работу. Если не взять в работу до конца дня, они станут просроченными.`}
          </p>
        </div>
      )}

      {overdue.length > 0 && (
        <div className="mt-3 min-w-0">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-red-500">
            <CircleAlert size={12} /> Просрочено ({overdue.length})
          </p>
          <ul className="space-y-1.5">
            {overdue.slice(0, 4).map((t) => (
              <li key={t.id} className="flex min-w-0 items-center gap-2 rounded-xl border border-red-500/25 bg-red-500/5 p-2">
                <span className="shrink-0 rounded-md bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-500">{formatDate(t.deadline)}</span>
                <p className="min-w-0 flex-1 truncate text-[12px] font-medium">{t.title}</p>
                {t.status === "new" && (
                  <button onClick={() => acceptTask(t.id)} disabled={pending} className="shrink-0 rounded-lg bg-red-500/90 px-2 py-1 text-[10px] font-medium text-white disabled:opacity-50">
                    Принять
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 min-w-0">
        {hourKeys.length === 0 && noTime.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-8 text-center">
            <Clock size={18} className="mx-auto mb-1.5 text-muted" />
            <p className="text-xs text-muted">На сегодня задач нет — можно планировать новые</p>
            <Link href="/calendar" className="mt-1 inline-block text-[11px] font-medium text-accent2 hover:underline">Открыть календарь →</Link>
          </div>
        ) : (
          <div className="space-y-2">
            {hourKeys.map((hour) => {
              const list = hours.get(hour) ?? [];
              const isCurrentHour = currentHourKey(now) === hour;
              return (
                <div key={hour} className="flex min-w-0 gap-2 sm:gap-3">
                  <div className="flex w-11 shrink-0 flex-col items-end pt-1.5 sm:w-14">
                    <span className={cn("text-[11px] font-semibold tabular-nums", isCurrentHour ? "text-accent2" : "text-muted")}>{hour}</span>
                    {isCurrentHour && <span className="text-[9px] text-accent2">сейчас</span>}
                  </div>
                  <div className={cn("min-w-0 flex-1 space-y-1.5 border-l-2 pl-2 sm:pl-3", isCurrentHour ? "border-accent" : "border-border")}>
                    {list.map((t) => row(t, needsAcceptance(t, now)))}
                  </div>
                </div>
              );
            })}
            {noTime.length > 0 && (
              <div className="flex min-w-0 gap-2 sm:gap-3">
                <div className="flex w-11 shrink-0 flex-col items-end pt-1.5 sm:w-14">
                  <span className="text-[11px] font-semibold text-muted">—</span>
                  <span className="text-[9px] text-muted">весь день</span>
                </div>
                <div className="min-w-0 flex-1 space-y-1.5 border-l-2 border-dashed border-border pl-2 sm:pl-3">
                  {noTime.map((t) => row(t, needsAcceptance(t, now)))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {showOthers && (
        <div className="mt-4 min-w-0 border-t border-border pt-3">
          <p className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <Users size={12} /> Задачи коллег на сегодня ({othersToday.length})
            <span className="font-normal normal-case tracking-normal">— свои всегда выше</span>
          </p>
          {othersToday.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-2.5 py-3 text-[11px] text-muted">
              У коллег на сегодня открытых задач нет.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {othersToday.slice(0, 30).map((t) => (
                <li
                  key={t.id}
                  className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border bg-card2/40 p-2"
                >
                  <span className="w-11 shrink-0 rounded-md bg-card2 px-1.5 py-0.5 text-center text-[10px] font-semibold tabular-nums text-muted">
                    {formatTimeLabel(t.deadlineTime).slice(0, 5)}
                  </span>
                  <Avatar name={t.assigneeName} color={t.assigneeColor} url={t.assigneeAvatar} size={22} />
                  <span className="min-w-0 max-w-[8rem] shrink-0 truncate text-[11px] text-muted">{t.assigneeName}</span>
                  <p className="min-w-0 flex-1 truncate text-[12px] font-medium">{t.title}</p>
                  {t.counterpartyName && (
                    <span className="hidden max-w-[9rem] truncate text-[10px] text-muted sm:block">{t.counterpartyName}</span>
                  )}
                  <span className="shrink-0">
                    <StatusBadge status={t.status} />
                  </span>
                  <Link
                    href={`/team/${t.assigneeId}`}
                    className="shrink-0 rounded-lg border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted transition hover:text-text"
                  >
                    Профиль
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {othersToday.length > 30 && (
            <p className="mt-1.5 text-[10px] text-muted">Показаны первые 30 из {othersToday.length} — остальные в разделе «Задачи».</p>
          )}
        </div>
      )}
    </section>
  );
}
