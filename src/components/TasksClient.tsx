"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  ArrowUpDown,
  Download,
  Plus,
  Search,
  AlertTriangle,
  X,
  FileSpreadsheet,
  Loader2,
  History,
  ShieldAlert,
  AlarmClock,
  Hand,
  MessageSquare,
} from "lucide-react";
import type { Role, TaskPriority, TaskStatus } from "@/db/schema";
import type { TaskRow, UserLite } from "@/lib/data";
import { formatTaskMoment, formatTimeLabel, needsAcceptance, scheduledAt } from "@/lib/taskTime";
import {
  cn,
  formatDate,
  formatHours,
  OPEN_STATUSES,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  STATUS_LABELS,
  STATUS_ORDER,
  todayStr,
} from "@/lib/utils";
import { Avatar, Button, Input, PriorityBadge, StatusBadge, EmptyState, Modal } from "./ui";
import { Combobox } from "./Combobox";
import { acceptTaskAction } from "@/app/actions/tasks";
import { formatDateTime } from "@/lib/utils";
import { LoadMore, useProgressiveList } from "./lazy";

/** Модалка задачи грузится отдельным чанком — только когда её открыли. */
const TaskModal = dynamic(() => import("./TaskModal").then((module) => module.TaskModal), {
  ssr: false,
  loading: () => null,
});

type SortKey = "title" | "assignee" | "author" | "counterparty" | "deadline" | "hours" | "status" | "priority";

export type ExportState = {
  exportedTaskIds: number[];
  lastExportAt: string | null;
  isAdmin: boolean;
};

export function TasksClient({
  tasks,
  users,
  counterparties,
  me,
  exportState,
  initialAssignee,
  initialStatus,
}: {
  tasks: TaskRow[];
  users: UserLite[];
  counterparties: { id: number; name: string }[];
  me: { id: number; role: Role };
  exportState: ExportState;
  initialAssignee?: number;
  initialStatus?: TaskStatus | "open" | "overdue";
}) {
  const today = todayStr();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>(initialStatus ?? "all");
  const [assignee, setAssignee] = useState<string>(initialAssignee ? String(initialAssignee) : "all");
  const [author, setAuthor] = useState<string>("all");
  const [cp, setCp] = useState<string>("all");
  const [priority, setPriority] = useState<string>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "deadline", dir: 1 });
  const [modal, setModal] = useState<{ open: boolean; task: TaskRow | null }>({ open: false, task: null });
  const router = useRouter();
  const [acceptPending, startAccept] = useTransition();

  const now = new Date();
  const isOverdue = (t: TaskRow) => OPEN_STATUSES.includes(t.status) && t.deadline < today;
  const mustAccept = (t: TaskRow) => OPEN_STATUSES.includes(t.status) && needsAcceptance(t, now);
  const accept = (id: number) =>
    startAccept(async () => {
      const res = await acceptTaskAction(id);
      if (!res.ok) alert(res.error);
      router.refresh();
    });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = tasks.filter((t) => {
      if (q && !t.title.toLowerCase().includes(q) && !(t.counterpartyName ?? "").toLowerCase().includes(q)) return false;
      if (status === "open" && !OPEN_STATUSES.includes(t.status)) return false;
      else if (status === "overdue" && !isOverdue(t)) return false;
      else if (status === "accept" && !mustAccept(t)) return false;
      else if (status !== "all" && status !== "open" && status !== "overdue" && t.status !== status) return false;
      if (assignee !== "all" && t.assigneeId !== Number(assignee)) return false;
      if (author !== "all" && t.authorId !== Number(author)) return false;
      if (cp !== "all" && String(t.counterpartyId ?? "none") !== cp) return false;
      if (priority !== "all" && t.priority !== priority) return false;
      if (from && t.deadline < from) return false;
      if (to && t.deadline > to) return false;
      return true;
    });
    const dir = sort.dir;
    const cmp = (a: TaskRow, b: TaskRow) => {
      switch (sort.key) {
        case "title": return a.title.localeCompare(b.title, "ru") * dir;
        case "assignee": return a.assigneeName.localeCompare(b.assigneeName, "ru") * dir;
        case "author": return a.authorName.localeCompare(b.authorName, "ru") * dir;
        case "counterparty": return (a.counterpartyName ?? "").localeCompare(b.counterpartyName ?? "", "ru") * dir;
        case "deadline": {
          const diff = scheduledAt(a.deadline, a.deadlineTime).getTime() - scheduledAt(b.deadline, b.deadlineTime).getTime();
          return diff * dir || b.id - a.id;
        }
        case "hours": return (a.hours - b.hours) * dir;
        case "status": return (STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)) * dir;
        case "priority": return (PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority)) * dir;
      }
    };
    return [...list].sort(cmp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, search, status, assignee, author, cp, priority, from, to, sort, today]);

  // Список рисуем порциями: на слабых ПК сотни строк не блокируют первый кадр.
  const list = useProgressiveList(filtered, {
    initial: 25,
    step: 25,
    // Живое обновление не должно сворачивать список: сброс только по фильтрам.
    resetKey: `${search}|${status}|${assignee}|${author}|${cp}|${priority}|${from}|${to}|${sort.key}|${sort.dir}`,
  });

  // Модалка задачи грузится отдельным чанком; в простое подтягиваем его заранее,
  // чтобы первый клик по строке открывал задачу без задержки, но первый кадр
  // страницы оставался лёгким.
  useEffect(() => {
    const load = () => { void import("./TaskModal"); };
    const idle = (window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof idle === "function") return void idle(load, { timeout: 2000 });
    const timer = window.setTimeout(load, 800);
    return () => window.clearTimeout(timer);
  }, []);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  const hasFilters = search || status !== "all" || assignee !== "all" || author !== "all" || cp !== "all" || priority !== "all" || from || to;
  const reset = () => {
    setSearch(""); setStatus("all"); setAssignee("all"); setAuthor("all"); setCp("all"); setPriority("all"); setFrom(""); setTo("");
  };

  // Closed tasks of the current period split by "already downloaded by me".
  const closedTasks = tasks.filter((t) => t.status === "closed" && (!from || t.deadline >= from) && (!to || t.deadline <= to));
  const exportedSet = new Set(exportState.exportedTaskIds);
  const freshClosedCount = closedTasks.filter((t) => !exportedSet.has(t.id)).length;
  const alreadyExportedCount = closedTasks.length - freshClosedCount;
  const totals = {
    all: filtered.length,
    open: filtered.filter((t) => OPEN_STATUSES.includes(t.status)).length,
    overdue: filtered.filter(isOverdue).length,
    hours: filtered.reduce((s, t) => s + t.hours, 0),
  };

  const Th = ({ k, children, className }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <th className={cn("px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted", className)}>
      <button onClick={() => toggleSort(k)} className={cn("inline-flex items-center gap-1 hover:text-text", sort.key === k && "text-accent2")}>
        {children} <ArrowUpDown size={12} />
      </button>
    </th>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по названию или контрагенту..." className="pl-9" />
        </div>
        {exportState.isAdmin && (
          <ExportPanel
            closedCount={closedTasks.length}
            freshCount={freshClosedCount}
            exportedCount={alreadyExportedCount}
            lastExportAt={exportState.lastExportAt}
            from={from}
            to={to}
          />
        )}
        <Button onClick={() => setModal({ open: true, task: null })}>
          <Plus size={16} /> Новая задача
        </Button>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-2 rounded-2xl border border-border bg-card p-2.5 min-[360px]:grid-cols-2 sm:grid-cols-4 sm:p-3 lg:grid-cols-8">
        <Combobox
          aria-label="Статус"
          value={status}
          onChange={setStatus}
          placeholder="Все статусы"
          options={[
            { value: "all", label: "Все статусы", hint: "без отбора" },
            { value: "open", label: "Открытые", hint: "в работе и новые" },
            { value: "overdue", label: "Просроченные", hint: "срок прошёл" },
            { value: "accept", label: "Обязан взять", hint: "ждут принятия" },
            ...STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
          ]}
        />
        <Combobox
          aria-label="Исполнитель"
          value={assignee}
          onChange={setAssignee}
          placeholder="Все исполнители"
          options={[
            { value: "all", label: "Все исполнители", hint: "без отбора" },
            ...users.map((u) => ({ value: String(u.id), label: u.name, hint: u.position ?? undefined })),
          ]}
        />
        <Combobox
          aria-label="Автор"
          value={author}
          onChange={setAuthor}
          placeholder="Все авторы"
          options={[
            { value: "all", label: "Все авторы", hint: "без отбора" },
            ...users.map((u) => ({ value: String(u.id), label: u.name, hint: u.position ?? undefined })),
          ]}
        />
        <Combobox
          aria-label="Контрагент"
          value={cp}
          onChange={setCp}
          placeholder="Все контрагенты"
          options={[
            { value: "all", label: "Все контрагенты", hint: "без отбора" },
            { value: "none", label: "Без контрагента", hint: "внутренние задачи" },
            ...counterparties.map((c) => ({ value: String(c.id), label: c.name })),
          ]}
        />
        <Combobox
          aria-label="Срочность"
          value={priority}
          onChange={setPriority}
          placeholder="Любая срочность"
          options={[
            { value: "all", label: "Любая срочность", hint: "без отбора" },
            ...PRIORITY_ORDER.map((p) => ({ value: p, label: PRIORITY_LABELS[p] })),
          ]}
        />
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} title="Срок с" />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} title="Срок по" />
        <Button variant="ghost" onClick={reset} disabled={!hasFilters} className="justify-center">
          <X size={14} /> Сбросить
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 text-xs text-muted">
        <span className="rounded-lg bg-card2 px-2 py-1">Всего: <b className="text-text">{totals.all}</b></span>
        <span className="rounded-lg bg-card2 px-2 py-1">Открытых: <b className="text-text">{totals.open}</b></span>
        <span className={cn("rounded-lg px-2 py-1", totals.overdue ? "bg-red-500/10 text-red-500" : "bg-card2")}>Просрочено: <b>{totals.overdue}</b></span>
        <span className="rounded-lg bg-card2 px-2 py-1">Часы: <b className="text-text">{formatHours(Math.round(totals.hours * 10) / 10)}</b></span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="Задачи не найдены" hint="Измените фильтры или создайте новую задачу" />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-2xl border border-border bg-card md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-card2/60">
                  <tr>
                    <Th k="title">Название</Th>
                    <Th k="assignee">Исполнитель</Th>
                    <Th k="author">Автор</Th>
                    <Th k="counterparty">Контрагент</Th>
                    <Th k="deadline">Срок</Th>
                    <Th k="hours" className="text-right">Часы</Th>
                    <Th k="status">Статус</Th>
                    <Th k="priority">Срочность</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((t) => {
                    const overdue = isOverdue(t);
                    const mustAcceptRow = mustAccept(t);
                    return (
                      <tr
                        key={t.id}
                        onClick={() => setModal({ open: true, task: t })}
                        className={cn(
                          "cursor-pointer border-b border-border/60 last:border-0 hover:bg-card2/70",
                          mustAcceptRow && "bg-red-500/10 shadow-[inset_3px_0_0_0_#ef4444]",
                        )}
                      >
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            {overdue && <AlertTriangle size={14} className="shrink-0 text-red-500" />}
                            <div>
                              <p className="font-medium leading-tight">{t.title}</p>
                              <p className="flex items-center gap-1.5 text-[11px] text-muted">
                                #{t.id}
                                {t.messagesCount > 0 && (
                                  <span
                                    className="inline-flex items-center gap-0.5 rounded-md bg-accent/15 px-1 py-0.5 text-[9px] font-semibold text-accent2"
                                    title="Сообщений в переписке по задаче"
                                  >
                                    <MessageSquare size={9} />
                                    {t.messagesCount}
                                  </span>
                                )}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <Avatar name={t.assigneeName} color={t.assigneeColor} url={t.assigneeAvatar} size={26} />
                            <span className="truncate">{t.assigneeName}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <Avatar name={t.authorName} color={t.authorColor} url={t.authorAvatar} size={26} />
                            <span className="truncate">{t.authorName}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-muted">{t.counterpartyName ?? "—"}</td>
                        <td className={cn("px-3 py-2.5 whitespace-nowrap", overdue && "font-medium text-red-500")}>
                          <span className="flex items-center gap-1.5">
                            {mustAcceptRow && <AlarmClock size={12} className="shrink-0 text-red-500" />}
                            <span>{formatDate(t.deadline)}</span>
                            {t.deadlineTime && <span className="rounded bg-card2 px-1 py-0.5 text-[10px] text-muted">{formatTimeLabel(t.deadlineTime)}</span>}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{t.hours}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap items-center gap-1">
                            <StatusBadge status={t.status} />
                            {overdue && (
                              <span className="inline-flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-500">
                                <AlarmClock size={9} /> Просрочена
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center justify-end gap-2">
                            <PriorityBadge priority={t.priority} />
                            {t.status === "new" && (
                              <button
                                onClick={(e) => { e.stopPropagation(); accept(t.id); }}
                                disabled={acceptPending}
                                className={cn(
                                  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium transition disabled:opacity-50",
                                  mustAcceptRow ? "bg-red-500 text-white" : "border border-border bg-card2 hover:border-accent/60",
                                )}
                                title="Принять задачу в работу"
                              >
                                <Hand size={10} /> Принять
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="grid min-w-0 grid-cols-1 gap-2 md:hidden">
            {list.items.map((t) => {
              const overdue = isOverdue(t);
              return (
                <div
                  key={t.id}
                  onClick={() => setModal({ open: true, task: t })}
                  className={cn(
                    "card-hover cursor-pointer rounded-2xl border bg-card p-3 text-left",
                    mustAccept(t) ? "border-red-500/50 bg-red-500/10 shadow-[0_0_0_1px_rgba(239,68,68,0.25)]" : "border-border",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium leading-tight">{t.title}</p>
                    <PriorityBadge priority={t.priority} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <StatusBadge status={t.status} />
                    {overdue && <span className="rounded-md bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-500">Просрочена</span>}
                    <span className={cn(overdue && "font-medium text-red-500")}>{formatTaskMoment(t.deadline, t.deadlineTime)}</span>
                    <span>{formatHours(t.hours)}</span>
                    {t.counterpartyName && <span>· {t.counterpartyName}</span>}
                    {t.messagesCount > 0 && (
                      <span className="inline-flex items-center gap-0.5 rounded-md bg-accent/15 px-1 py-0.5 text-[9px] font-semibold text-accent2">
                        <MessageSquare size={9} />
                        {t.messagesCount}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs">
                    <Avatar name={t.assigneeName} color={t.assigneeColor} url={t.assigneeAvatar} size={22} />
                    <span className="truncate">{t.assigneeName}</span>
                    <span className="truncate text-muted">← {t.authorName}</span>
                    {mustAccept(t) && <span className="ml-auto flex items-center gap-1 rounded-md bg-red-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase text-red-500"><AlarmClock size={9} /> обязан взять</span>}
                  </div>
                  {t.status === "new" && (
                    <div className="mt-2 flex gap-1.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); accept(t.id); }}
                        disabled={acceptPending}
                        className={cn("inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-medium disabled:opacity-50", mustAccept(t) ? "bg-red-500 text-white" : "border border-border bg-card2")}
                      >
                        <Hand size={11} /> Принять
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <LoadMore
            shown={list.shown}
            total={list.total}
            hasMore={list.hasMore}
            loading={list.loading}
            onShowMore={list.showMore}
            sentinelRef={list.sentinelRef}
            initial={25}
            unit="задач"
          />
        </>
      )}

      {modal.open && (
        <TaskModal
          open={modal.open}
          onClose={() => setModal({ open: false, task: null })}
          task={modal.task}
          users={users}
          counterparties={counterparties}
          me={me}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Excel export panel — admin only, "new tasks only" by default        */
/* ------------------------------------------------------------------ */

function ExportPanel({
  closedCount,
  freshCount,
  exportedCount,
  lastExportAt,
  from,
  to,
}: {
  closedCount: number;
  freshCount: number;
  exportedCount: number;
  lastExportAt: string | null;
  from: string;
  to: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [includeAll, setIncludeAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ msg: string; ok: boolean } | null>(null);

  const willExport = includeAll ? closedCount : freshCount;

  const download = async () => {
    setNotice(null);
    setBusy(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (includeAll) params.set("all", "1");

      const res = await fetch(`/api/tasks/export?${params.toString()}`, { cache: "no-store" });
      const type = res.headers.get("content-type") ?? "";

      if (!res.ok || type.includes("application/json")) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setNotice({ msg: data?.error ?? "Не удалось выгрузить файл", ok: false });
        return;
      }

      const disposition = res.headers.get("content-disposition") ?? "";
      const nameMatch = disposition.match(/filename="?([^";]+)"?/);
      const filename = nameMatch?.[1] ?? "closed-tasks.xlsx";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      const exported = res.headers.get("x-exported-count") ?? String(willExport);
      setNotice({
        msg: `Файл «${filename}» скачан: ${exported} ${includeAll ? "задач (включая ранее выгруженные)" : "новых задач"}. Повторно эти задачи не попадут в выгрузку.`,
        ok: true,
      });
      setIncludeAll(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => { setNotice(null); setOpen(true); }}
        className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-card2 px-4 text-sm font-medium transition hover:border-accent/50"
        title="Выгрузка закрытых задач в Excel (только для администраторов)"
      >
        <FileSpreadsheet size={16} />
        <span className="hidden sm:inline">Экспорт закрытых (Excel)</span>
        <span className="sm:hidden">Excel</span>
        {freshCount > 0 && (
          <span className="rounded-md bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent2">{freshCount}</span>
        )}
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Выгрузка закрытых задач в Excel"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>Закрыть</Button>
            <Button size="sm" onClick={download} disabled={busy || willExport === 0}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {busy ? "Готовим файл..." : `Скачать (${willExport})`}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-xl border border-accent/30 bg-accent/5 p-3 text-xs">
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-accent2" />
            <p className="text-muted">
              Выгрузка доступна только администраторам. Уже скачанные <b className="text-text">вами</b> задачи повторно не попадают в файл —
              для каждого сотрудника учёт ведётся отдельно.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl border border-border bg-card2 p-2.5">
              <p className="text-lg font-semibold">{closedCount}</p>
              <p className="text-[10px] text-muted">закрыто всего</p>
            </div>
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-2.5">
              <p className="text-lg font-semibold text-emerald-500">{freshCount}</p>
              <p className="text-[10px] text-muted">новых для вас</p>
            </div>
            <div className="rounded-xl border border-border bg-card2 p-2.5">
              <p className="text-lg font-semibold">{exportedCount}</p>
              <p className="text-[10px] text-muted">уже выгружено</p>
            </div>
          </div>

          {(from || to) && (
            <p className="text-xs text-muted">
              Период выгрузки: <b className="text-text">{from ? formatDate(from) : "начало"}</b> — <b className="text-text">{to ? formatDate(to) : "сегодня"}</b>.
              Измените фильтр «Срок с / по», чтобы охватить другой период.
            </p>
          )}

          <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition ${includeAll ? "border-accent bg-accent/10" : "border-border bg-card2/60 hover:border-accent/40"}`}>
            <input
              type="checkbox"
              checked={includeAll}
              onChange={(e) => setIncludeAll(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[#7c5cff]"
            />
            <span>
              <span className="block font-medium">Выгрузить все закрытые задачи</span>
              <span className="block text-xs text-muted">
                Включая {exportedCount} ранее скачанных вами. Без этой галочки в файл попадут только новые задачи.
              </span>
            </span>
          </label>

          {lastExportAt && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted">
              <History size={12} /> Последняя ваша выгрузка: {formatDateTime(lastExportAt)}
            </p>
          )}

          {willExport === 0 && (
            <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
              {closedCount === 0
                ? "За выбранный период нет закрытых задач."
                : "Все закрытые задачи уже выгружены вами. Поставьте галочку «Выгрузить все», чтобы скачать повторно."}
            </p>
          )}

          {notice && (
            <p className={`rounded-xl border px-3 py-2 text-xs ${notice.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500" : "border-red-500/30 bg-red-500/10 text-red-500"}`}>
              {notice.msg}
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}
