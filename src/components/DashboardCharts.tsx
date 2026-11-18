"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { X } from "lucide-react";
import type { UserLite } from "@/lib/data";
import { PRIORITY_LABELS, PRIORITY_ORDER, STATUS_COLORS, STATUS_LABELS } from "@/lib/utils";
import type { TaskStatus } from "@/db/schema";
import { Button, Input } from "./ui";
import { Combobox } from "./Combobox";

const tick = { fill: "var(--muted)", fontSize: 11 };

/**
 * Реальная ширина контейнера графика, чтобы оси не сжимали поле.
 *
 * Важно: это callback-ref, а не `useEffect` с пустыми зависимостями.
 * Карточка может сначала показать «Нет данных» (контейнера графика в DOM нет),
 * а после смены фильтра — данные. С обычным ref эффект в такой ситуации уже
 * отработал и повторно не запустится: ширина остаётся 0, и `width > 0 &&`
 * навсегда скрывает график. Callback-ref измеряет заново каждый раз, когда
 * контейнер появляется в DOM, — графики возвращаются вместе с данными.
 */
export function useContainerWidth<T extends HTMLDivElement>() {
  const [width, setWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) {
      setWidth(0);
      return;
    }
    setWidth(node.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(node.getBoundingClientRect().width));
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  return { ref, width };
}

function shorten(value: string, limit: number) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

export function StatusDonut({ data }: { data: { status: TaskStatus; count: number }[] }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  const { ref, width } = useContainerWidth();
  const size = Math.max(120, Math.min(208, width || 160));
  const chart = data.filter((d) => d.count > 0).map((d) => ({ name: STATUS_LABELS[d.status], value: d.count, color: STATUS_COLORS[d.status] }));
  if (total === 0) {
    return (
      <p className="flex min-h-[160px] items-center justify-center py-10 text-center text-xs text-muted sm:min-h-[208px]">
        Нет данных
      </p>
    );
  }
  return (
    <div className="flex w-full min-w-0 flex-col items-center gap-4 sm:flex-row">
      <div ref={ref} className="relative shrink-0" style={{ width: size, height: size }}>
        <PieChart width={size} height={size}>
          <Pie data={chart} dataKey="value" nameKey="name" innerRadius={Math.round(size * 0.3)} outerRadius={Math.round(size * 0.45)} paddingAngle={3} stroke="none" isAnimationActive={false}>
            {chart.map((c) => <Cell key={c.name} fill={c.color} />)}
          </Pie>
          <Tooltip />
        </PieChart>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold">{total}</span>
          <span className="text-[11px] text-muted">задач</span>
        </div>
      </div>
      <ul className="grid w-full min-w-0 grid-cols-1 gap-x-4 gap-y-1.5 text-xs min-[380px]:grid-cols-2">
        {data.map((d) => (
          <li key={d.status} className="flex min-w-0 items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-muted">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_COLORS[d.status] }} />
              <span className="truncate">{STATUS_LABELS[d.status]}</span>
            </span>
            <span className="shrink-0 font-medium tabular-nums">{d.count}<span className="ml-1 text-muted">({total ? Math.round((d.count / total) * 100) : 0}%)</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type PersonBar = { name: string; open: number; done: number; overdue?: number; total: number };

export function PeopleBars({ data, stacked = true, height = 240 }: { data: PersonBar[]; stacked?: boolean; height?: number }) {
  const { ref, width } = useContainerWidth();
  if (data.length === 0) {
    return <p className="flex items-center justify-center py-10 text-center text-xs text-muted" style={{ minHeight: height }}>Нет данных</p>;
  }
  const h = Math.max(height, data.length * 34 + 40);
  const axisWidth = width === 0 ? 96 : Math.max(56, Math.min(120, Math.round(width * 0.34)));
  const nameLimit = Math.max(6, Math.floor(axisWidth / 6.3));
  const rows = data.map((d) => ({ ...d, label: shorten(d.name, nameLimit) }));
  return (
    <div ref={ref} className="w-full min-w-0" style={{ height: h }}>
      {width > 0 && (
        <BarChart width={width} height={h} data={rows} layout="vertical" margin={{ left: 0, right: 8, top: 4, bottom: 4 }} barCategoryGap={8}>
          <CartesianGrid horizontal={false} stroke="var(--border)" />
          <XAxis type="number" tick={tick} axisLine={false} tickLine={false} allowDecimals={false} />
          <YAxis type="category" dataKey="label" width={axisWidth} tick={tick} axisLine={false} tickLine={false} interval={0} />
          <Tooltip cursor={{ fill: "var(--glow)" }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="open" name="Открытые" stackId={stacked ? "a" : undefined} fill="#7c5cff" radius={stacked ? [0, 0, 0, 0] : [0, 6, 6, 0]} isAnimationActive={false} />
          <Bar dataKey="done" name="Выполнено" stackId={stacked ? "a" : undefined} fill="#34d399" radius={[0, 6, 6, 0]} isAnimationActive={false} />
        </BarChart>
      )}
    </div>
  );
}

export function SimpleBars({ data, color = "#a78bfa", name, unit, height = 240 }: { data: { name: string; value: number }[]; color?: string; name: string; unit?: string; height?: number }) {
  const { ref, width } = useContainerWidth();
  if (data.length === 0) {
    return <p className="flex items-center justify-center py-10 text-center text-xs text-muted" style={{ minHeight: height }}>Нет данных</p>;
  }
  const h = Math.max(height, data.length * 34 + 40);
  const axisWidth = width === 0 ? 96 : Math.max(56, Math.min(120, Math.round(width * 0.34)));
  const nameLimit = Math.max(6, Math.floor(axisWidth / 6.3));
  const showLabels = width === 0 ? true : width > 280;
  const rows = data.map((d) => ({ ...d, label: shorten(d.name, nameLimit) }));
  return (
    <div ref={ref} className="w-full min-w-0" style={{ height: h }}>
      {width > 0 && (
        <BarChart width={width} height={h} data={rows} layout="vertical" margin={{ left: 0, right: showLabels ? 26 : 8, top: 4, bottom: 4 }} barCategoryGap={8}>
          <CartesianGrid horizontal={false} stroke="var(--border)" />
          <XAxis type="number" tick={tick} axisLine={false} tickLine={false} allowDecimals={false} />
          <YAxis type="category" dataKey="label" width={axisWidth} tick={tick} axisLine={false} tickLine={false} interval={0} />
          <Tooltip cursor={{ fill: "var(--glow)" }} formatter={(v) => [`${v}${unit ? " " + unit : ""}`, name]} />
          <Bar dataKey="value" name={name} fill={color} radius={[0, 6, 6, 0]} isAnimationActive={false} label={showLabels ? { position: "right", fill: "var(--muted)", fontSize: 10 } : undefined} />
        </BarChart>
      )}
    </div>
  );
}

export type DashboardFilterValues = {
  from?: string;
  to?: string;
  assignee?: string;
  author?: string;
  counterparty?: string;
  priority?: string;
};

export function DashboardFilters({
  values,
  users,
  counterparties,
  showPeople,
}: {
  values: DashboardFilterValues;
  users: UserLite[];
  counterparties: { id: number; name: string }[];
  showPeople: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const update = (patch: Partial<DashboardFilterValues>) => {
    const next = { ...values, ...patch };
    const params = new URLSearchParams();
    Object.entries(next).forEach(([k, v]) => v && params.set(k, v));
    router.push(`${pathname}?${params.toString()}`);
  };
  const hasAny = Object.values(values).some(Boolean);
  const presets = [
    { label: "Неделя", days: 7 },
    { label: "Месяц", days: 30 },
    { label: "Квартал", days: 90 },
  ];
  const preset = (days: number) => {
    const d = new Date();
    const to = new Date(d.getTime() + days * 86400000);
    const fmt = (x: Date) => x.toISOString().slice(0, 10);
    update({ from: fmt(new Date(d.getTime() - days * 86400000)), to: fmt(to) });
  };
  return (
    <div className="grid w-full min-w-0 grid-cols-1 gap-2 rounded-2xl border border-border bg-card p-2.5 min-[360px]:grid-cols-2 sm:p-3 md:grid-cols-4 xl:grid-cols-8">
      <Input type="date" value={values.from ?? ""} onChange={(e) => update({ from: e.target.value })} title="Срок с" />
      <Input type="date" value={values.to ?? ""} onChange={(e) => update({ to: e.target.value })} title="Срок по" />
      {showPeople && (
        <>
          <Combobox
            aria-label="Исполнитель"
            value={values.assignee ?? ""}
            onChange={(next) => update({ assignee: next })}
            placeholder="Все исполнители"
            clearable
            options={[
              { value: "", label: "Все исполнители", hint: "без отбора" },
              ...users.map((u) => ({ value: String(u.id), label: u.name, hint: u.position ?? undefined })),
            ]}
          />
          <Combobox
            aria-label="Автор"
            value={values.author ?? ""}
            onChange={(next) => update({ author: next })}
            placeholder="Все авторы"
            clearable
            options={[
              { value: "", label: "Все авторы", hint: "без отбора" },
              ...users.map((u) => ({ value: String(u.id), label: u.name, hint: u.position ?? undefined })),
            ]}
          />
        </>
      )}
      <Combobox
        aria-label="Контрагент"
        value={values.counterparty ?? ""}
        onChange={(next) => update({ counterparty: next })}
        placeholder="Все контрагенты"
        clearable
        options={[
          { value: "", label: "Все контрагенты", hint: "без отбора" },
          ...counterparties.map((c) => ({ value: String(c.id), label: c.name })),
        ]}
      />
      <Combobox
        aria-label="Срочность"
        value={values.priority ?? ""}
        onChange={(next) => update({ priority: next })}
        placeholder="Любая срочность"
        clearable
        options={[
          { value: "", label: "Любая срочность", hint: "без отбора" },
          ...PRIORITY_ORDER.map((priority) => ({ value: priority, label: PRIORITY_LABELS[priority] })),
        ]}
      />
      <div className="col-span-1 grid min-w-0 grid-cols-3 gap-1 min-[360px]:col-span-2 md:col-span-1">
        {presets.map((p) => (
          <button key={p.days} onClick={() => preset(p.days)} className="min-w-0 rounded-xl border border-border bg-card2 px-1 py-2 text-[10px] font-medium text-muted transition hover:text-text sm:text-[11px]">{p.label}</button>
        ))}
      </div>
      <Button variant="ghost" onClick={() => router.push(pathname)} disabled={!hasAny} className="col-span-1 w-full min-[360px]:col-span-2 md:col-span-1"><X size={14} /> Сбросить</Button>
    </div>
  );
}
