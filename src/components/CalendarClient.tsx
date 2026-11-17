"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { ru } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Plus, CheckCircle2, Lock, Trash2, Hand, GripVertical } from "lucide-react";
import type { Role, TaskStatus } from "@/db/schema";
import type { TaskRow, UserLite } from "@/lib/data";
import { deleteTaskAction, rescheduleTaskAction, setTaskStatusAction } from "@/app/actions/tasks";
import { cn, formatDate, isAdminRole, OPEN_STATUSES, STATUS_COLORS, STATUS_LABELS, STATUS_ORDER, todayStr } from "@/lib/utils";
import { formatTimeLabel, nextHourTime, needsAcceptance, scheduledAt } from "@/lib/taskTime";
import { Avatar, Button, PriorityBadge, Select, StatusBadge } from "./ui";
import { TaskModal } from "./TaskModal";

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export function CalendarClient({
  tasks,
  users,
  counterparties,
  me,
}: {
  tasks: TaskRow[];
  users: UserLite[];
  counterparties: { id: number; name: string }[];
  me: { id: number; role: Role };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const today = todayStr();
  const [cursor, setCursor] = useState(() => {
    const [y, m] = today.split("-").map(Number);
    return new Date(y, m - 1, 1);
  });
  const [selected, setSelected] = useState<string>(today);
  const [assignee, setAssignee] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [modal, setModal] = useState<{ open: boolean; task: TaskRow | null; deadline?: string; time?: string }>({ open: false, task: null });
  const [dragId, setDragId] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const filtered = useMemo(
    () =>
      tasks.filter((t) => {
        if (assignee !== "all" && t.assigneeId !== Number(assignee)) return false;
        if (statusFilter === "open" && !OPEN_STATUSES.includes(t.status)) return false;
        if (statusFilter !== "all" && statusFilter !== "open" && t.status !== statusFilter) return false;
        return true;
      }),
    [tasks, assignee, statusFilter],
  );

  const byDay = useMemo(() => {
    const m = new Map<string, TaskRow[]>();
    for (const t of filtered) {
      const arr = m.get(t.deadline) ?? [];
      arr.push(t);
      m.set(t.deadline, arr);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => scheduledAt(a.deadline, a.deadlineTime).getTime() - scheduledAt(b.deadline, b.deadlineTime).getTime());
    }
    return m;
  }, [filtered]);

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 });
    const end = endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 });
    return eachDayOfInterval({ start, end });
  }, [cursor]);

  const monthTasks = filtered.filter((t) => t.deadline.slice(0, 7) === format(cursor, "yyyy-MM"));
  const selectedTasks = byDay.get(selected) ?? [];

  const quick = (id: number, status: TaskStatus) =>
    start(async () => {
      const res = await setTaskStatusAction(id, status);
      if (!res.ok) alert(res.error);
      router.refresh();
    });
  const remove = (id: number) => {
    if (!confirm("Удалить задачу?")) return;
    start(async () => {
      const res = await deleteTaskAction(id);
      if (!res.ok) alert(res.error);
      router.refresh();
    });
  };
  const drop = (day: string) => {
    if (dragId === null) return;
    const t = tasks.find((x) => x.id === dragId);
    setDragId(null);
    setDragOver(null);
    if (!t || t.deadline === day) return;
    start(async () => {
      const res = await rescheduleTaskAction(t.id, day);
      if (!res.ok) alert(res.error);
      router.refresh();
    });
  };

  const canManage = (t: TaskRow) => isAdminRole(me.role) || t.authorId === me.id;
  const defaultTimeFor = (day: string) => (day === today ? nextHourTime() : "10:00");

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button onClick={() => setCursor(addMonths(cursor, -1))} className="rounded-lg p-2 text-muted hover:bg-card2 hover:text-text"><ChevronLeft size={18} /></button>
            <h2 className="min-w-[160px] text-center text-base font-semibold capitalize">{format(cursor, "LLLL yyyy", { locale: ru })}</h2>
            <button onClick={() => setCursor(addMonths(cursor, 1))} className="rounded-lg p-2 text-muted hover:bg-card2 hover:text-text"><ChevronRight size={18} /></button>
            <Button variant="ghost" size="sm" onClick={() => { const [y, m] = today.split("-").map(Number); setCursor(new Date(y, m - 1, 1)); setSelected(today); }}>Сегодня</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="h-9 w-44 text-xs">
              <option value="all">Все исполнители</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-9 w-36 text-xs">
              <option value="all">Все статусы</option>
              <option value="open">Открытые</option>
              {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </Select>
            <Button size="sm" onClick={() => setModal({ open: true, task: null, deadline: selected, time: defaultTimeFor(selected) })}><Plus size={14} /> Задача</Button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold uppercase tracking-wide text-muted">
          {WEEKDAYS.map((d) => <div key={d} className="py-1">{d}</div>)}
        </div>
        <div className="mt-1 grid grid-cols-7 gap-1">
          {days.map((day) => {
            const key = format(day, "yyyy-MM-dd");
            const list = byDay.get(key) ?? [];
            const inMonth = isSameMonth(day, cursor);
            const isToday = key === today;
            const isSel = key === selected;
            const weekend = day.getDay() === 0 || day.getDay() === 6;
            const hasOverdue = list.some((t) => OPEN_STATUSES.includes(t.status) && t.deadline < today);
            return (
              <div
                key={key}
                onClick={() => setSelected(key)}
                onDoubleClick={() => setModal({ open: true, task: null, deadline: key, time: defaultTimeFor(key) })}
                onDragOver={(e) => { e.preventDefault(); if (dragOver !== key) setDragOver(key); }}
                onDragLeave={() => dragOver === key && setDragOver(null)}
                onDrop={() => drop(key)}
                className={cn(
                  "group relative flex min-h-[86px] cursor-pointer flex-col rounded-xl border p-1.5 text-left transition sm:min-h-[104px]",
                  inMonth ? "bg-card2/40" : "bg-transparent opacity-50",
                  isSel ? "border-accent ring-1 ring-accent/40" : "border-border/60 hover:border-accent/40",
                  dragOver === key && "border-accent bg-accent/10",
                )}
              >
                <div className="flex items-center justify-between">
                  <span className={cn("flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium", isToday && "bg-gradient-to-br from-[#7c5cff] to-[#a78bfa] text-white", !isToday && weekend && "text-muted")}>{format(day, "d")}</span>
                  {hasOverdue && <span className="h-1.5 w-1.5 rounded-full bg-red-500" title="Есть просроченные" />}
                  <button onClick={(e) => { e.stopPropagation(); setModal({ open: true, task: null, deadline: key, time: defaultTimeFor(key) }); }} className="hidden rounded-md p-0.5 text-muted hover:bg-card hover:text-text group-hover:block" title="Создать задачу"><Plus size={12} /></button>
                </div>
                <div className="mt-1 flex flex-1 flex-col gap-0.5 overflow-hidden">
                  {list.slice(0, 3).map((t) => (
                    <button
                      key={t.id}
                      draggable={canManage(t)}
                      onDragStart={() => setDragId(t.id)}
                      onDragEnd={() => { setDragId(null); setDragOver(null); }}
                      onClick={(e) => { e.stopPropagation(); setModal({ open: true, task: t }); }}
                      className={cn(
                        "flex min-w-0 items-center gap-1 rounded-md border-l-2 bg-card px-1 py-0.5 text-left text-[10px] leading-4 hover:brightness-110 sm:px-1.5 sm:text-[11px]",
                        OPEN_STATUSES.includes(t.status) && t.deadline < today && "text-red-500",
                        needsAcceptance(t) && "bg-red-500/15 font-semibold text-red-500",
                      )}
                      style={{ borderLeftColor: STATUS_COLORS[t.status] }}
                      title={`${formatTimeLabel(t.deadlineTime)} · ${t.title} — ${t.assigneeName}`}
                    >
                      {t.deadlineTime && <span className="shrink-0 tabular-nums opacity-80">{t.deadlineTime.slice(0, 5)}</span>}
                      <span className="min-w-0 truncate">{t.title}</span>
                    </button>
                  ))}
                  {list.length > 3 && <span className="px-1 text-[10px] text-muted">+{list.length - 3} ещё</span>}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted">
          {STATUS_ORDER.map((s) => (
            <span key={s} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLORS[s] }} />{STATUS_LABELS[s]}</span>
          ))}
          <span className="ml-auto flex items-center gap-1"><GripVertical size={12} /> перетащите задачу на другой день (время сохраняется) · двойной клик — новая задача</span>
        </div>
      </div>

      <aside className="space-y-3">
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted">Выбранный день</p>
              <p className="text-base font-semibold">{formatDate(selected)}</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setModal({ open: true, task: null, deadline: selected, time: defaultTimeFor(selected) })}><Plus size={14} /> Добавить</Button>
          </div>
          <div className="mt-3 space-y-2">
            {selectedTasks.length === 0 && <p className="rounded-xl border border-dashed border-border py-6 text-center text-xs text-muted">На этот день задач нет</p>}
            {selectedTasks.map((t) => {
              const overdue = OPEN_STATUSES.includes(t.status) && t.deadline < today;
              const mustAccept = needsAcceptance(t);
              return (
                <div key={t.id} className={cn("rounded-xl border p-3", mustAccept ? "border-red-500/50 bg-red-500/10" : "border-border bg-card2/60")}>
                  <button onClick={() => setModal({ open: true, task: t })} className="w-full text-left">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-semibold tabular-nums", mustAccept ? "bg-red-500/20 text-red-500" : "bg-accent/15 text-accent2")}>
                        {t.deadlineTime ? formatTimeLabel(t.deadlineTime) : "без времени"}
                      </span>
                      {mustAccept && <span className="rounded-md bg-red-500 px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">обязан взять</span>}
                    </div>
                    <p className={cn("text-sm font-medium leading-tight", overdue && "text-red-500")}>{t.title}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={t.status} />
                      <PriorityBadge priority={t.priority} />
                      <span className="text-[11px] text-muted">{t.hours} ч</span>
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                      <Avatar name={t.assigneeName} color={t.assigneeColor} url={t.assigneeAvatar} size={20} />
                      {t.assigneeName}{t.counterpartyName ? ` · ${t.counterpartyName}` : ""}
                    </div>
                  </button>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {t.status === "new" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className={cn("h-7 px-2 text-[11px]", mustAccept && "border-red-500/50 text-red-500")}
                        disabled={pending}
                        onClick={() => quick(t.id, "in_progress")}
                      >
                        <Hand size={12} /> Принять
                      </Button>
                    )}
                    {OPEN_STATUSES.includes(t.status) && <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={pending} onClick={() => quick(t.id, "done")}><CheckCircle2 size={12} /> Выполнена</Button>}
                    {t.status !== "closed" && canManage(t) && <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={pending} onClick={() => quick(t.id, "closed")}><Lock size={12} /> Закрыть</Button>}
                    {canManage(t) && <Button size="sm" variant="danger" className="h-7 px-2 text-[11px]" disabled={pending} onClick={() => remove(t.id)}><Trash2 size={12} /></Button>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-xs font-semibold text-muted">Итоги месяца</p>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-card2 p-2"><p className="text-lg font-semibold">{monthTasks.length}</p><p className="text-[10px] text-muted">задач</p></div>
            <div className="rounded-xl bg-card2 p-2"><p className="text-lg font-semibold text-violet-400">{monthTasks.filter((t) => OPEN_STATUSES.includes(t.status)).length}</p><p className="text-[10px] text-muted">открыто</p></div>
            <div className="rounded-xl bg-card2 p-2"><p className="text-lg font-semibold text-red-500">{monthTasks.filter((t) => OPEN_STATUSES.includes(t.status) && t.deadline < today).length}</p><p className="text-[10px] text-muted">просрочено</p></div>
          </div>
        </div>
      </aside>

      <TaskModal
        open={modal.open}
        onClose={() => setModal({ open: false, task: null })}
        task={modal.task}
        defaultDeadline={modal.deadline}
        defaultTime={modal.time}
        users={users}
        counterparties={counterparties}
        me={me}
      />
    </div>
  );
}
