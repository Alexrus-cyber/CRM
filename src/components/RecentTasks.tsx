"use client";

import type { TaskRow } from "@/lib/data";
import { cn, formatDate, OPEN_STATUSES } from "@/lib/utils";
import { formatTimeLabel } from "@/lib/taskTime";
import { Avatar, StatusBadge } from "./ui";
import { LoadMore, useProgressiveList } from "./lazy";

/**
 * Блок «Последние задачи» на дашборде.
 *
 * Раньше здесь сразу рендерились все строки (8 на десктопе и 6 на телефоне
 * отдельными проходами по всему списку задач). Теперь список приходит уже
 * отсортированным и обрезанным на сервере, а рисуется порциями по 6 — при
 * прокрутке подгружается следующая порция.
 */
export function RecentTasks({
  tasks,
  today,
  initial = 6,
  step = 6,
}: {
  tasks: TaskRow[];
  today: string;
  initial?: number;
  step?: number;
}) {
  const list = useProgressiveList(tasks, { initial, step });

  return (
    <>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[40%]" />
            <col className="w-[26%]" />
            <col className="w-[18%]" />
            <col className="w-[16%]" />
          </colgroup>
          <thead className="text-[11px] uppercase tracking-wide text-muted">
            <tr className="border-b border-border">
              <th className="py-2 pr-2 text-left font-semibold">Название</th>
              <th className="py-2 pr-2 text-left font-semibold">Исполнитель</th>
              <th className="py-2 pr-2 text-left font-semibold">Срок</th>
              <th className="py-2 text-left font-semibold">Статус</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((t) => (
              <tr key={t.id} className="border-b border-border/50 last:border-0">
                <td className="py-2 pr-2">
                  <p className="truncate font-medium">{t.title}</p>
                  <p className="truncate text-[11px] text-muted">
                    {t.authorName}
                    {t.counterpartyName ? ` · ${t.counterpartyName}` : ""}
                  </p>
                </td>
                <td className="py-2 pr-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <Avatar name={t.assigneeName} color={t.assigneeColor} url={t.assigneeAvatar} size={24} />
                    <span className="truncate">{t.assigneeName}</span>
                  </span>
                </td>
                <td className={cn("py-2 pr-2 whitespace-nowrap tabular-nums", OPEN_STATUSES.includes(t.status) && t.deadline < today && "text-red-500")}>
                  {formatDate(t.deadline)}
                  {t.deadlineTime && <span className="ml-1 text-muted">{formatTimeLabel(t.deadlineTime)}</span>}
                </td>
                <td className="py-2">
                  <StatusBadge status={t.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-border/60 sm:hidden">
        {list.items.map((t) => (
          <li key={t.id} className="py-2.5 first:pt-0 last:pb-0">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 flex-1 text-[13px] font-medium leading-snug sm:text-sm">{t.title}</p>
              <span className="shrink-0">
                <StatusBadge status={t.status} />
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
              <span className="flex items-center gap-1.5">
                <Avatar name={t.assigneeName} color={t.assigneeColor} url={t.assigneeAvatar} size={18} />
                <span className="truncate">{t.assigneeName}</span>
              </span>
              <span className={cn("tabular-nums", OPEN_STATUSES.includes(t.status) && t.deadline < today && "font-medium text-red-500")}>
                {formatDate(t.deadline)}
                {t.deadlineTime ? ` ${formatTimeLabel(t.deadlineTime)}` : ""}
              </span>
            </div>
            {t.counterpartyName && <p className="mt-1 truncate text-[11px] text-muted">{t.counterpartyName}</p>}
          </li>
        ))}
      </ul>

      <LoadMore
        shown={list.shown}
        total={list.total}
        hasMore={list.hasMore}
        loading={list.loading}
        onShowMore={list.showMore}
        sentinelRef={list.sentinelRef}
        initial={initial}
        unit="задач"
        className="mt-3"
      />
    </>
  );
}
