"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlarmClock, CheckCircle2, Clock, Hand, Lock, Trash2 } from "lucide-react";
import type { TaskPriority, TaskStatus, Role } from "@/db/schema";
import type { TaskRow, UserLite } from "@/lib/data";
import { acceptTaskAction, deleteTaskAction, saveTaskAction } from "@/app/actions/tasks";
import {
  formatDateTime,
  canManageData,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  STATUS_LABELS,
  STATUS_ORDER,
  todayStr,
} from "@/lib/utils";
import {
  DEFAULT_TASK_TIME,
  formatMinutesLeft,
  formatTaskMoment,
  formatTimeLabel,
  minutesToAccept,
  needsAcceptance,
  normalizeTime,
  scheduledAt,
} from "@/lib/taskTime";
import { Button, Field, Input, Modal, Textarea, Avatar, StatusBadge } from "./ui";
import { Combobox } from "./Combobox";
import { TaskChat } from "./TaskChat";

export type TaskModalProps = {
  open: boolean;
  onClose: () => void;
  task?: TaskRow | null;
  defaultDeadline?: string;
  defaultTime?: string;
  users: UserLite[];
  counterparties: { id: number; name: string }[];
  me: { id: number; role: Role };
};

export function TaskModal({
  open,
  onClose,
  task,
  defaultDeadline,
  defaultTime,
  users,
  counterparties,
  me,
}: TaskModalProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState<number>(me.id);
  const [counterpartyId, setCounterpartyId] = useState<number | "">("");
  const [deadline, setDeadline] = useState(defaultDeadline ?? todayStr());
  const [deadlineTime, setDeadlineTime] = useState(defaultTime ?? DEFAULT_TASK_TIME);
  const [hours, setHours] = useState<string>("1");
  const [status, setStatus] = useState<TaskStatus>("new");
  const [priority, setPriority] = useState<TaskPriority>("medium");

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNow(new Date());
    if (task) {
      setTitle(task.title);
      setDescription(task.description ?? "");
      setAssigneeId(task.assigneeId);
      setCounterpartyId(task.counterpartyId ?? "");
      setDeadline(task.deadline);
      setDeadlineTime(task.deadlineTime ?? "");
      setHours(String(task.hours));
      setStatus(task.status);
      setPriority(task.priority);
    } else {
      setTitle("");
      setDescription("");
      setAssigneeId(me.id);
      setCounterpartyId("");
      setDeadline(defaultDeadline ?? todayStr());
      setDeadlineTime(defaultTime ?? DEFAULT_TASK_TIME);
      setHours("1");
      setStatus("new");
      setPriority("medium");
    }
  }, [open, task, defaultDeadline, defaultTime, me.id]);

  const isNew = !task;
  const isOwner = isNew || canManageData(me.role) || task?.authorId === me.id;
  const canClose = isOwner;
  const canDelete = !isNew && isOwner;
  const canAccept = !!task && task.status === "new" && !task.acceptedAt &&
    (canManageData(me.role) || task.assigneeId === me.id || task.authorId === me.id);
  const mustAccept = !!task && needsAcceptance(task, now);

  const availableStatuses = useMemo(
    () => STATUS_ORDER.filter((s) => s !== "closed" || canClose || task?.status === "closed"),
    [canClose, task?.status],
  );

  const scheduledPreview = deadline
    ? new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Europe/Moscow",
        day: "2-digit",
        month: "long",
        weekday: "short",
      }).format(scheduledAt(deadline, deadlineTime))
    : "";

  function submit(overrideStatus?: TaskStatus) {
    setError(null);
    start(async () => {
      const res = await saveTaskAction({
        id: task?.id,
        title,
        description,
        assigneeId,
        counterpartyId: counterpartyId === "" ? null : Number(counterpartyId),
        deadline,
        deadlineTime: normalizeTime(deadlineTime),
        hours: parseFloat(hours.replace(",", ".")) || 0,
        status: overrideStatus ?? status,
        priority,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  function accept() {
    if (!task) return;
    setError(null);
    start(async () => {
      const res = await acceptTaskAction(task.id);
      if (!res.ok) return setError(res.error);
      router.refresh();
      onClose();
    });
  }

  function remove() {
    if (!task) return;
    if (!confirm("Удалить задачу? Это действие необратимо.")) return;
    start(async () => {
      const res = await deleteTaskAction(task.id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{isNew ? "Новая задача" : `Задача #${task?.id}`}</span>
          {task && <StatusBadge status={task.status} />}
        </span>
      }
      wide
      footer={
        <>
          {canDelete && (
            <Button variant="danger" size="sm" onClick={remove} disabled={pending} className="mr-auto">
              <Trash2 size={14} /> Удалить
            </Button>
          )}
          {canAccept && (
            <Button variant={mustAccept ? "primary" : "secondary"} size="sm" onClick={accept} disabled={pending}>
              <Hand size={14} /> Принять в работу
            </Button>
          )}
          {!isNew && task?.status !== "closed" && canClose && (
            <Button variant="secondary" size="sm" onClick={() => submit("closed")} disabled={pending}>
              <Lock size={14} /> Закрыть задачу
            </Button>
          )}
          {!isNew && task?.status !== "done" && task?.status !== "closed" && (
            <Button variant="secondary" size="sm" onClick={() => submit("done")} disabled={pending}>
              <CheckCircle2 size={14} /> Выполнена
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Отмена
          </Button>
          <Button size="sm" onClick={() => submit()} disabled={pending}>
            {pending ? "Сохраняем..." : isNew ? "Создать задачу" : "Сохранить"}
          </Button>
        </>
      }
    >
      {task && mustAccept && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-xs">
          <AlarmClock size={16} className="mt-0.5 shrink-0 text-red-500" />
          <p className="text-red-500">
            <b>Обязан взять в работу.</b>{" "}
            <span className="text-muted">
              Задача стояла на {formatTaskMoment(task.deadline, task.deadlineTime)}, час на принятие истёк.{" "}
              {formatMinutesLeft(minutesToAccept(task, now))}. Если не взять её в работу до конца дня, она станет просроченной.
            </span>
          </p>
        </div>
      )}

      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Field label="Название *" className="sm:col-span-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например: Подготовить КП для клиента" disabled={!isOwner} autoFocus />
        </Field>
        <Field label="Описание" className="sm:col-span-2">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Детали, ссылки, критерии приёмки..." />
        </Field>
        <Field label="Исполнитель *">
          <Combobox
            aria-label="Исполнитель"
            value={String(assigneeId)}
            onChange={(next) => setAssigneeId(Number(next))}
            disabled={!isOwner}
            placeholder="Найдите сотрудника..."
            options={users.map((u) => ({
              value: String(u.id),
              label: `${u.name}${u.id === me.id ? " (я)" : ""}`,
              hint: u.position ?? undefined,
            }))}
          />
        </Field>
        <Field label="Контрагент">
          <Combobox
            aria-label="Контрагент"
            value={counterpartyId === "" ? "" : String(counterpartyId)}
            onChange={(next) => setCounterpartyId(next === "" ? "" : Number(next))}
            disabled={!isOwner}
            clearable
            clearTitle="Без контрагента"
            placeholder="— Без контрагента —"
            options={[
              { value: "", label: "— Без контрагента —", hint: "внутренняя задача" },
              ...counterparties.map((c) => ({ value: String(c.id), label: c.name })),
            ]}
          />
        </Field>
        <Field label="Дата *">
          <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} disabled={!isOwner} />
        </Field>
        <Field label="Время (на какое назначена)">
          <div className="flex min-w-0 gap-2">
            <Input type="time" value={deadlineTime} onChange={(e) => setDeadlineTime(e.target.value)} disabled={!isOwner} className="min-w-0 flex-1" />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="shrink-0 px-2"
              onClick={() => setDeadlineTime("")}
              disabled={!isOwner || deadlineTime === ""}
              title="Без точного времени"
            >
              <Clock size={14} />
            </Button>
          </div>
        </Field>
        <Field label="Часы (план)">
          <Input type="number" min={0} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
        <Field label="Статус">
          <Combobox
            aria-label="Статус"
            value={status}
            onChange={(next) => setStatus(next as TaskStatus)}
            placeholder="Выберите статус"
            options={availableStatuses.map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
          />
        </Field>
        <Field label="Срочность" className="sm:col-span-2 sm:max-w-[240px]">
          <Combobox
            aria-label="Срочность"
            value={priority}
            onChange={(next) => setPriority(next as TaskPriority)}
            disabled={!isOwner}
            placeholder="Выберите срочность"
            options={PRIORITY_ORDER.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
          />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card2 px-3 py-2 text-xs text-muted">
        <Clock size={13} className="text-accent2" />
        Задача назначена на <b className="text-text">{formatTaskMoment(deadline, deadlineTime)}</b>
        {scheduledPreview && <span className="text-muted">({scheduledPreview})</span>}
        {deadlineTime ? <span className="rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent2">слот {formatTimeLabel(deadlineTime)}</span> : <span className="rounded-md bg-card px-1.5 py-0.5 text-[10px]">без времени</span>}
      </div>

      {task && (
        <div className="mt-3 grid gap-3 rounded-xl border border-border bg-card2 p-3 text-xs text-muted sm:grid-cols-2">
          <div className="flex min-w-0 items-center gap-2">
            <Avatar name={task.authorName} color={task.authorColor} url={task.authorAvatar} size={24} />
            <span className="truncate">Автор: <span className="text-text">{task.authorName}</span></span>
          </div>
          <div>Создана: <span className="text-text">{formatDateTime(task.createdAt)}</span></div>
          <div>Принята в работу: <span className={task.acceptedAt ? "text-emerald-500" : "text-amber-500"}>{task.acceptedAt ? formatDateTime(task.acceptedAt) : "ещё не принята"}</span></div>
          <div>Выполнена: <span className="text-text">{formatDateTime(task.completedAt)}</span></div>
          <div>Закрыта: <span className="text-text">{formatDateTime(task.closedAt)}</span></div>
          <div>Исполнитель: <span className="text-text">{task.assigneeName}</span></div>
        </div>
      )}

      {task && <TaskChat taskId={task.id} me={me} />}

      {!isOwner && (
        <p className="mt-3 text-xs text-muted">Вы исполнитель этой задачи: можно менять статус, часы и описание. Остальные поля редактирует автор или администратор.</p>
      )}
      {error && <p className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">{error}</p>}
    </Modal>
  );
}
