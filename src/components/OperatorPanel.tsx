"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ClipboardCopy,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Inbox,
  KeyRound,
  Loader2,
  MonitorCog,
  Play,
  RefreshCw,
  Rocket,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import { Badge, Button, Card, EmptyState, Input, Textarea } from "@/components/ui";
import { cn, formatDateTime, formatTime } from "@/lib/utils";
import {
  OPERATOR_PROVIDERS,
  buildCommandWithKey,
  buildEnvLine,
  buildOperatorCommand,
  findProvider,
  looksTextOnlyModel,
} from "@/lib/operatorCommand";
import {
  ActionGlyph,
  ActionLink,
  AgentFileCard,
  describeAction,
  MetricCard,
  StatusChip,
  type OperatorEvent,
  type OperatorTask,
} from "./operator/shared";

/**
 * Вкладка «Оператор» блока ИИ — в стиле остальной Nova CRM.
 *
 * Внутри три подвкладки:
 *   • Пульт — поставить задание и смотреть, что бот делает шаг за шагом;
 *   • Запуски — история заданий со статусами и фильтрами;
 *   • Подключение — токен бота, установка зависимостей и готовые команды
 *     запуска для локальной модели или облачного API.
 *
 * Сам бот живёт на компьютере пользователя (`agent/desktop_operator.py`),
 * сюда он присылает шаги и файлы.
 */

const SUBTABS = [
  { id: "desk", label: "Пульт", icon: MonitorCog, hint: "новое задание и ход выполнения" },
  { id: "runs", label: "Запуски", icon: Inbox, hint: "история заданий" },
  { id: "setup", label: "Подключение", icon: Settings2, hint: "токен и запуск бота" },
] as const;

type SubTab = (typeof SUBTABS)[number]["id"];

const PRESETS = [
  "Открой блокнот, напиши план на день и сохрани в файл plan.docx",
  "Открой YouTube и включи видео про космос",
  "Сделай таблицу расходов за неделю и сохрани в xlsx",
  "Открой почту и проверь новые письма",
];

const RUN_FILTERS = [
  { id: "all", label: "Все" },
  { id: "queued", label: "В очереди" },
  { id: "running", label: "Выполняются" },
  { id: "done", label: "Готово" },
] as const;

function statusFilterMatches(status: string, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "queued") return status === "queued" || status === "paused";
  if (filter === "running") return status === "running";
  if (filter === "done") return status === "done";
  return true;
}

export function OperatorPanel() {
  const [tab, setTab] = useState<SubTab>("desk");
  const [tokenExists, setTokenExists] = useState<boolean | null>(null);
  const [tokenHint, setTokenHint] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [check, setCheck] = useState<{ state: "idle" | "busy" | "ok" | "fail"; text: string }>({
    state: "idle",
    text: "",
  });
  const [tasks, setTasks] = useState<OperatorTask[]>([]);
  const [events, setEvents] = useState<OperatorEvent[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [runFilter, setRunFilter] = useState<string>("all");
  const [prompt, setPrompt] = useState("");
  const [maxSteps, setMaxSteps] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Параметры для сборки команды запуска.
  const [provider, setProvider] = useState<string>("local");
  const [model, setModel] = useState("");
  const [server, setServer] = useState("http://localhost:3000");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keyMode, setKeyMode] = useState<"inline" | "env">("inline");
  const [once, setOnce] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [assumeYes, setAssumeYes] = useState(false);
  const [textOnly, setTextOnly] = useState(false);

  /* ------------------------------ загрузка ------------------------------ */

  const fetchToken = useCallback(async (): Promise<{ exists: boolean; hint: string | null } | null> => {
    try {
      const res = await fetch("/api/agent/token", { cache: "no-store" });
      if (!res.ok) return null;
      const data = (await res.json()) as { exists?: boolean; hint?: string | null };
      return { exists: Boolean(data.exists), hint: data.hint ?? null };
    } catch {
      return null;
    }
  }, []);

  const fetchTasks = useCallback(async (): Promise<OperatorTask[] | null> => {
    try {
      const res = await fetch("/api/agent/tasks", { cache: "no-store" });
      if (!res.ok) return null;
      const data = (await res.json()) as { tasks?: OperatorTask[] };
      return data.tasks ?? [];
    } catch {
      return null;
    }
  }, []);

  const fetchTask = useCallback(
    async (id: number): Promise<{ task: OperatorTask | null; events: OperatorEvent[] } | null> => {
      try {
        const res = await fetch(`/api/agent/tasks/${id}`, { cache: "no-store" });
        if (!res.ok) return null;
        const data = (await res.json()) as { task?: OperatorTask; events?: OperatorEvent[] };
        return { task: data.task ?? null, events: data.events ?? [] };
      } catch {
        return null;
      }
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    void Promise.all([fetchToken(), fetchTasks()]).then(([token, list]) => {
      if (!alive) return;
      if (token) {
        setTokenExists(token.exists);
        setTokenHint(token.hint);
      }
      if (list) setTasks(list);
    });
    return () => {
      alive = false;
    };
  }, [fetchToken, fetchTasks]);

  const activeTask = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? tasks[0] ?? null,
    [tasks, selectedId],
  );
  const activeId = activeTask?.id ?? null;

  // Очередь обновляется сама: бот работает в фоне.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fetchTasks().then((list) => {
        if (list) setTasks(list);
      });
    }, 3500);
    return () => window.clearInterval(timer);
  }, [fetchTasks]);

  // Открытое задание: шаги подтягиваются на лету.
  useEffect(() => {
    if (!activeId || tab !== "desk") return;
    let alive = true;
    void fetchTask(activeId).then((data) => {
      if (!alive || !data) return;
      setEvents(data.events);
      if (data.task) {
        setTasks((prev) => prev.map((task) => (task.id === activeId ? data.task! : task)));
      }
    });
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fetchTask(activeId).then((data) => {
        if (!data) return;
        setEvents(data.events);
        if (data.task) {
          setTasks((prev) => prev.map((task) => (task.id === activeId ? data.task! : task)));
        }
      });
    }, 2500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [activeId, tab, fetchTask]);

  /* ------------------------------ действия ------------------------------ */

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Браузер не разрешил доступ к буферу обмена — скопируйте вручную");
    }
  };

  const createToken = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent/token", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!res.ok || !data.token) {
        setError(data.error ?? "Не удалось создать токен");
        return;
      }
      setFreshToken(data.token);
      setTokenInput(data.token);
      setTokenHint(`…${data.token.slice(-6)}`);
      setCheck({ state: "idle", text: "" });
      setTokenExists(true);
    } finally {
      setBusy(false);
    }
  };

  const checkConnection = async () => {
    const value = (tokenInput.trim() || freshToken || "").trim();
    if (!value) {
      setCheck({ state: "fail", text: "Вставьте токен: он показывается один раз при создании." });
      return;
    }
    setCheck({ state: "busy", text: "" });
    try {
      const res = await fetch("/api/agent/bot/whoami", {
        headers: { "x-agent-token": value },
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as {
        owner?: { name?: string };
        counts?: { queued?: number; running?: number };
        error?: string;
        hint?: string;
      };
      if (!res.ok) {
        const text = [data.error, data.hint].filter(Boolean).join(" · ");
        setCheck({ state: "fail", text: text || `CRM ответила HTTP ${res.status}` });
        return;
      }
      setCheck({
        state: "ok",
        text: `Токен принят${data.owner?.name ? ` · ${data.owner.name}` : ""} · в очереди ${
          data.counts?.queued ?? 0
        }, в работе ${data.counts?.running ?? 0}`,
      });
    } catch {
      setCheck({ state: "fail", text: "CRM не отвечает — проверьте адрес CRM в шаге 3." });
    }
  };

  const createTask = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, maxSteps }),
      });
      const data = (await res.json().catch(() => ({}))) as { task?: OperatorTask; error?: string };
      if (!res.ok || !data.task) {
        setError(data.error ?? "Не удалось поставить задание");
        return;
      }
      setPrompt("");
      setTasks((prev) => [data.task!, ...prev]);
      setSelectedId(data.task.id);
      setEvents([]);
      setTab("desk");
    } finally {
      setBusy(false);
    }
  };

  const cancelTask = async (id: number) => {
    const res = await fetch(`/api/agent/tasks/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    });
    if (!res.ok) {
      setError("Не удалось отменить задание");
      return;
    }
    setTasks((prev) => prev.map((task) => (task.id === id ? { ...task, status: "cancelled" } : task)));
  };

  /* ------------------------------- выводы ------------------------------- */

  const counts = useMemo(
    () => ({
      all: tasks.length,
      queued: tasks.filter((task) => task.status === "queued" || task.status === "paused").length,
      running: tasks.filter((task) => task.status === "running").length,
      done: tasks.filter((task) => task.status === "done").length,
    }),
    [tasks],
  );

  const files = useMemo(() => events.filter((event) => event.kind === "file"), [events]);
  const currentAction = useMemo(
    () => [...events].reverse().find((event) => event.kind === "action" && event.action) ?? null,
    [events],
  );
  const currentThought = useMemo(() => {
    const index = currentAction ? events.findIndex((event) => event.id === currentAction.id) : -1;
    if (index <= 0) return "";
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (events[cursor].kind === "thought" && events[cursor].text) return events[cursor].text;
      if (events[cursor].kind === "action") break;
    }
    return "";
  }, [events, currentAction]);

  const parsedAction = describeAction(currentAction?.action ?? "");
  const progress = activeTask ? Math.min(100, Math.round((activeTask.steps / Math.max(activeTask.maxSteps, 1)) * 100)) : 0;
  const finished = activeTask ? ["done", "failed", "cancelled"].includes(activeTask.status) : false;

  const effectiveToken = (tokenInput.trim() || freshToken || "").trim();

  const providerMeta = findProvider(provider);
  const commandOptions = useMemo(
    () => ({
      provider,
      token: effectiveToken,
      model,
      server,
      apiKey,
      keyMode,
      once,
      dryRun,
      assumeYes,
      textOnly,
    }),
    [provider, effectiveToken, model, server, apiKey, keyMode, once, dryRun, assumeYes, textOnly],
  );
  const command = useMemo(() => buildOperatorCommand(commandOptions), [commandOptions]);
  const commandToCopy = useMemo(() => buildCommandWithKey(commandOptions), [commandOptions]);
  const envLine = keyMode === "env" && apiKey.trim() ? buildEnvLine(provider, apiKey) : "";

  const visibleTasks = useMemo(
    () => tasks.filter((task) => statusFilterMatches(task.status, runFilter)),
    [tasks, runFilter],
  );

  return (
    <div className="space-y-3">
      {/* Подвкладки оператора */}
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Разделы оператора"
          className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1"
        >
          {SUBTABS.map((item) => {
            const Icon = item.icon;
            const active = item.id === tab;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                title={item.hint}
                onClick={() => setTab(item.id)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition",
                  active ? "bg-accent/15 text-text ring-1 ring-accent/30" : "text-muted hover:bg-card2 hover:text-text",
                )}
              >
                <Icon size={13} />
                {item.label}
              </button>
            );
          })}
        </div>
        <Badge className="border-border text-muted">
          <Terminal size={11} /> desktop_operator.py
        </Badge>
        {tokenExists === false && (
          <button
            type="button"
            onClick={() => setTab("setup")}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-500"
          >
            <KeyRound size={11} /> токен не создан
          </button>
        )}
      </div>

      {/* Пульт */}
      {tab === "desk" && (
        <div className="space-y-3">
          <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
            <MetricCard label="В очереди" value={counts.queued} hint="ждёт бота" icon={<Inbox size={12} />} />
            <MetricCard label="В работе" value={counts.running} hint="выполняется сейчас" icon={<Loader2 size={12} />} />
            <MetricCard label="Готово" value={counts.done} hint="из последних запусков" icon={<Check size={12} />} />
            <MetricCard label="Файлы" value={files.length} hint="в открытом запуске" icon={<FileText size={12} />} />
          </div>

          <Card
            title="Что сделать на экране?"
            subtitle="Опишите цель обычными словами — бот сам найдёт кнопки и поля"
            action={
              <Badge className="border-border text-muted">
                <Sparkles size={11} /> шагов: до {maxSteps}
              </Badge>
            }
          >
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Например: открой блокнот, напиши план на день и сохрани в файл plan.docx"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setPrompt(preset)}
                  className="max-w-full truncate rounded-lg border border-border bg-card2 px-2 py-1 text-[10px] text-muted transition hover:border-accent/50 hover:text-text"
                >
                  {preset}
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-[11px] text-muted">
                Лимит шагов
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={maxSteps}
                  onChange={(event) => setMaxSteps(Math.min(100, Math.max(1, Number(event.target.value) || 15)))}
                  className="h-8 w-16 px-2 text-[11px]"
                />
              </label>
              <Button
                size="sm"
                onClick={() => void createTask()}
                disabled={busy || prompt.trim().length === 0}
                className="ml-auto"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                В очередь
              </Button>
            </div>
            {error && <p className="mt-2 text-[11px] text-red-500">{error}</p>}
          </Card>

          {!activeTask ? (
            <EmptyState
              title="Запусков пока нет"
              hint="Поставьте первое задание — бот заберёт его из очереди, как только вы его запустите."
            />
          ) : (
            <div className="space-y-3">
              <Card
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    Запуск #{activeTask.id}
                    <StatusChip status={activeTask.status} />
                    <span className="text-[10px] font-normal text-muted">
                      {formatDateTime(activeTask.createdAt)}
                    </span>
                  </span>
                }
                subtitle={activeTask.prompt}
                action={
                  !finished ? (
                    <Button size="sm" variant="danger" onClick={() => void cancelTask(activeTask.id)}>
                      <Square size={12} /> Остановить
                    </Button>
                  ) : (
                    <Badge className="border-border text-muted">
                      <Check size={11} /> {activeTask.status === "done" ? "выполнено" : "завершено"}
                    </Badge>
                  )
                }
              >
                <div className="flex items-center gap-2 text-[10px] text-muted">
                  <span>
                    шаг {activeTask.steps}/{activeTask.maxSteps}
                  </span>
                  <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-card2">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        activeTask.status === "failed"
                          ? "bg-red-500"
                          : activeTask.status === "done"
                            ? "bg-emerald-500"
                            : "bg-accent",
                      )}
                      style={{ width: `${Math.max(progress, 2)}%` }}
                    />
                  </div>
                  {activeTask.summary && <span className="truncate">{activeTask.summary}</span>}
                </div>

                {activeTask.status === "queued" && events.length === 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-muted">
                    <TriangleAlert size={13} className="text-amber-500" />
                    <span>
                      Задание в очереди. Запустите бота с токеном —
                      <button
                        type="button"
                        onClick={() => setTab("setup")}
                        className="ml-1 font-medium text-accent2 underline-offset-2 hover:underline"
                      >
                        команда запуска
                      </button>
                      . Уже запускали? Проверьте токен кнопкой «Проверить связь».
                    </span>
                  </div>
                )}

                <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
                  {/* Текущий шаг */}
                  <div className="min-w-0 rounded-xl border border-border bg-card2/60 p-3">
                    <p className="text-[10px] uppercase tracking-wide text-muted">Текущий шаг</p>
                    {parsedAction ? (
                      <div className="mt-2 space-y-2">
                        <div className="flex items-start gap-2">
                          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent2">
                            <ActionGlyph type={parsedAction.type} size={14} />
                          </span>
                          <div className="min-w-0">
                            <p className="text-xs font-medium leading-snug">{parsedAction.title}</p>
                            {currentThought && (
                              <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-muted">{currentThought}</p>
                            )}
                          </div>
                        </div>
                        {currentAction?.text && currentAction.text !== parsedAction.title && (
                          <p className="rounded-lg bg-card px-2 py-1.5 text-[11px] text-emerald-500">
                            → {currentAction.text}
                          </p>
                        )}
                        {parsedAction.json && (
                          <details className="rounded-lg border border-border bg-card">
                            <summary className="cursor-pointer px-2 py-1 text-[10px] text-muted">action.json</summary>
                            <pre className="max-h-40 overflow-auto border-t border-border px-2 py-1.5 text-[10px] leading-relaxed text-muted">
                              {parsedAction.json}
                            </pre>
                          </details>
                        )}
                      </div>
                    ) : (
                      <p className="mt-2 text-[11px] leading-relaxed text-muted">
                        {activeTask.status === "queued"
                          ? "Бот ещё не забрал задание — шаги появятся здесь."
                          : "Шагов пока нет."}
                      </p>
                    )}

                    {files.length > 0 && (
                      <div className="mt-3 space-y-1.5">
                        <p className="text-[10px] uppercase tracking-wide text-muted">Файлы задания</p>
                        {files.map((file) => (
                          <AgentFileCard key={file.id} event={file} compact />
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Лента шагов */}
                  <div className="flex min-w-0 max-h-[420px] flex-col overflow-hidden rounded-xl border border-border bg-card2/40">
                    <div className="flex items-center justify-between border-b border-border px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-muted">Лента действий</p>
                      <span className="text-[10px] text-muted">{events.length} записей</span>
                    </div>
                    <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
                      {events.length === 0 ? (
                        <p className="px-1 py-6 text-center text-[11px] text-muted">
                          Здесь появятся мысль модели, действие и результат по каждому кадру.
                        </p>
                      ) : (
                        events.map((event) => (
                          <EventRow key={event.id} event={event} />
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </div>
      )}

      {/* Запуски */}
      {tab === "runs" && (
        <Card
          title="Запуски"
          subtitle="Все задания бота — от новых к старым"
          action={
            <div className="flex flex-wrap gap-1">
              {RUN_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => setRunFilter(filter.id)}
                  className={cn(
                    "rounded-lg border px-2 py-1 text-[10px] transition",
                    runFilter === filter.id
                      ? "border-accent/40 bg-accent/15 text-text"
                      : "border-border bg-card2 text-muted hover:text-text",
                  )}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          }
        >
          {visibleTasks.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-muted">Ничего не найдено под этот фильтр.</p>
          ) : (
            <div className="divide-y divide-border">
              {visibleTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(task.id);
                    setEvents([]);
                    setTab("desk");
                  }}
                  className={cn(
                    "flex w-full items-start gap-2 px-1 py-2 text-left transition hover:bg-card2/60",
                    task.id === activeTask?.id && "bg-accent/5",
                  )}
                >
                  <span className="mt-0.5 text-[10px] text-muted">#{task.id}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{task.prompt}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
                      <StatusChip status={task.status} />
                      <span>
                        шагов {task.steps}/{task.maxSteps}
                      </span>
                      <span>{formatDateTime(task.createdAt)}</span>
                      {task.summary && <span className="truncate">· {task.summary}</span>}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Подключение */}
      {tab === "setup" && (
        <div className="space-y-3">
          <Card
            title="1. Токен бота"
            subtitle="Один токен на аккаунт — по нему бот забирает свои задания"
            action={
              <Badge
                className={cn(
                  "border",
                  tokenExists ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500" : "border-amber-500/40 bg-amber-500/10 text-amber-500",
                )}
              >
                <KeyRound size={11} />
                {tokenExists === null ? "проверяю…" : tokenExists ? `создан ·${tokenHint ?? ""}` : "не создан"}
              </Badge>
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant={tokenExists ? "secondary" : "primary"} onClick={() => void createToken()} disabled={busy}>
                {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                {tokenExists ? "Обновить токен" : "Создать токен"}
              </Button>
              <span className="text-[10px] text-muted">старый токен перестанет работать сразу</span>
            </div>

            {freshToken && (
              <div className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-2.5">
                <p className="text-[10px] text-muted">Токен показывается один раз — сохраните его в команде из шага 3.</p>
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-lg bg-card2 px-2 py-1.5 text-[11px]">{freshToken}</code>
                  <Button size="sm" variant="ghost" onClick={() => void copy(freshToken, "token")}>
                    {copied === "token" ? <Check size={12} /> : <ClipboardCopy size={12} />}
                    {copied === "token" ? "скопировано" : "копировать"}
                  </Button>
                </div>
              </div>
            )}

            <div className="mt-3 rounded-xl border border-border bg-card2/50 p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-muted">Проверка токена</p>
              <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
                <Input
                  value={tokenInput}
                  onChange={(event) => {
                    setTokenInput(event.target.value);
                    setCheck({ state: "idle", text: "" });
                  }}
                  placeholder="crmop_… (вставьте токен целиком)"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-9 min-w-0 flex-1 font-mono text-[11px]"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void checkConnection()}
                  disabled={check.state === "busy"}
                >
                  {check.state === "busy" ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                  Проверить связь
                </Button>
              </div>
              {check.state !== "idle" && check.state !== "busy" && (
                <p
                  className={cn(
                    "mt-1.5 flex items-start gap-1.5 text-[10px] leading-relaxed",
                    check.state === "ok" ? "text-emerald-500" : "text-red-500",
                  )}
                >
                  {check.state === "ok" ? <Check size={11} className="mt-0.5 shrink-0" /> : <TriangleAlert size={11} className="mt-0.5 shrink-0" />}
                  {check.text}
                </p>
              )}
              <p className="mt-1.5 text-[10px] leading-relaxed text-muted">
                Токен виден только при создании: вставьте сохранённый — проверим его и подставим в команду.
                Маска вида «…abcdef» не подойдёт.
              </p>
            </div>
          </Card>

          <Card
            title="2. Установка зависимостей"
            subtitle="Нужны один раз: pyautogui делает скриншоты и клики, Pillow сжимает кадр"
          >
            <pre className="overflow-x-auto rounded-xl bg-card2 px-3 py-2 text-[11px]">
              pip install -r agent/requirements.txt
            </pre>
            <p className="mt-2 text-[11px] text-muted">
              Linux: дополнительно <code className="rounded bg-card2 px-1">sudo apt install python3-tk scrot</code>. macOS:
              разрешите терминалу «Запись экрана» и «Универсальный доступ».
            </p>
          </Card>

          <Card
            title="3. Команда запуска"
            subtitle="Соберите её под свою модель — локальную или облачную"
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-[11px] text-muted">
                Провайдер
                <select
                  value={provider}
                  onChange={(event) => {
                    const next = findProvider(event.target.value);
                    setProvider(next.id);
                    if (!model.trim() && next.defaultModel) setModel(next.defaultModel);
                  }}
                  className="mt-1 h-9 w-full rounded-xl border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
                >
                  {OPERATOR_PROVIDERS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] text-muted">
                Модель (необязательно)
                <Input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder={`например, ${providerMeta.visionModel}`}
                  className="mt-1 h-9 text-[11px]"
                />
                <span className="mt-1 block text-[10px]">
                  Зрение проверяется при запуске — модель должна понимать картинки.
                </span>
              </label>
              <div className="text-[11px] text-muted sm:col-span-2">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                  <span>
                    Ключ API{" "}
                    <span className="text-[10px]">
                      {providerMeta.needsKey ? `— обязателен для ${providerMeta.label}, нужен боту, не CRM` : "— локальной модели обычно не нужен"}
                    </span>
                  </span>
                  <div className="flex shrink-0 gap-1">
                    {(["inline", "env"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setKeyMode(mode)}
                        className={cn(
                          "rounded-lg border px-1.5 py-0.5 text-[10px] transition",
                          keyMode === mode
                            ? "border-accent/40 bg-accent/15 text-text"
                            : "border-border bg-card2 text-muted hover:text-text",
                        )}
                      >
                        {mode === "inline" ? "--api-key" : providerMeta.keyEnv}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <Input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={providerMeta.needsKey ? "sk-… (ключ провайдера)" : "обычно не требуется"}
                    spellCheck={false}
                    autoComplete="off"
                    className="h-9 min-w-0 flex-1 font-mono text-[11px]"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setShowKey((value) => !value)}
                    title={showKey ? "Скрыть ключ" : "Показать ключ"}
                    aria-label={showKey ? "Скрыть ключ" : "Показать ключ"}
                  >
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </Button>
                </div>
                {providerMeta.needsKey && !apiKey.trim() && (
                  <p className="mt-1 text-[10px] text-amber-500">
                    Без ключа {providerMeta.label} ответит 401 «Модель отклонила ключ API». Вставьте ключ
                    или задайте переменную <code className="rounded bg-card2 px-1">{providerMeta.keyEnv}</code>.
                  </p>
                )}
                <p className="mt-1 text-[10px] text-muted">
                  Ключ не уходит в CRM и не сохраняется: он попадает только в текст команды в вашем браузере.
                </p>
              </div>
              <label className="text-[11px] text-muted">
                Адрес CRM
                <Input
                  value={server}
                  onChange={(event) => setServer(event.target.value)}
                  placeholder="http://localhost:3000"
                  className="mt-1 h-9 text-[11px]"
                />
              </label>
              <div className="flex flex-wrap items-end gap-2 text-[11px] text-muted">
                <FlagToggle label="один запуск" checked={once} onChange={setOnce} />
                <FlagToggle label="только план" checked={dryRun} onChange={setDryRun} />
                <FlagToggle label="без вопросов" checked={assumeYes} onChange={setAssumeYes} />
                <FlagToggle label="без скриншотов" checked={textOnly} onChange={setTextOnly} />
              </div>
            </div>

            {looksTextOnlyModel(model) && (
              <div className="mt-2 flex items-start gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-amber-500">
                <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                <span>
                  «{model.trim()}» — текстовая модель, картинки она не принимает: экран бот не увидит
                  и будет промахиваться. Для работы по скриншоту укажите{" "}
                  <button
                    type="button"
                    onClick={() => setModel(providerMeta.visionModel)}
                    className="font-medium underline underline-offset-2"
                  >
                    {providerMeta.visionModel}
                  </button>
                  .
                </span>
              </div>
            )}

            <div className="mt-3 rounded-xl border border-border bg-card2 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted">
                  <Terminal size={11} /> терминал
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void copy(commandToCopy, "command")}
                  disabled={!effectiveToken}
                >
                  {copied === "command" ? <Check size={12} /> : <Copy size={12} />}
                  {copied === "command" ? "скопировано" : "копировать"}
                </Button>
              </div>
              <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-card px-2.5 py-2 text-[11px] leading-relaxed">
                {envLine ? `${envLine}\n${command}` : command}
              </pre>
              {keyMode === "env" && apiKey.trim() && (
                <p className="mt-1.5 text-[10px] text-muted">
                  Windows (cmd): <code className="rounded bg-card2 px-1">set {providerMeta.keyEnv}={apiKey.trim()}</code>{" "}
                  отдельной строкой перед запуском.
                </p>
              )}
              {!effectiveToken && (
                <p className="mt-1.5 text-[10px] text-amber-500">
                  Сначала создайте токен в шаге 1 или вставьте сохранённый в «Проверку токена» — команда
                  с плейсхолдером CRM не примет.
                </p>
              )}
            </div>

            <p className="mt-2 text-[11px] text-muted">
              Бот берёт ключ из <code className="rounded bg-card2 px-1">--api-key</code> или из переменной
              окружения провайдера — оба варианта собираются выше. Перед запуском команду можно проверить
              флагом <code className="rounded bg-card2 px-1">--check</code>: он покажет связь с CRM, не обращаясь
              к модели.
            </p>
          </Card>

          <Card title="4. Как это работает" subtitle="Коротко о том, что происходит дальше">
            <ol className="space-y-1.5 text-[11px] text-muted">
              <li className="flex gap-2">
                <span className="font-semibold text-text">1.</span> Вы ставите задание на «Пульте» — оно попадает в очередь.
              </li>
              <li className="flex gap-2">
                <span className="font-semibold text-text">2.</span> Бот забирает его по токену, делает скриншот и спрашивает модель.
              </li>
              <li className="flex gap-2">
                <span className="font-semibold text-text">3.</span> Каждое действие (клик, ввод, файл) появляется в «Ленте действий».
              </li>
              <li className="flex gap-2">
                <span className="font-semibold text-text">4.</span> Файлы, которые собрал бот, скачиваются прямо из карточки.
              </li>
            </ol>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => setTab("desk")}>
                <Rocket size={13} /> К заданиям
              </Button>
              <span className="text-[10px] text-muted">
                Аварийная остановка: уведите мышь в левый верхний угол экрана.
              </span>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

/* --------------------------- вспомогательные --------------------------- */

/** Адрес из action.json — только для ссылки «открыть». */
function urlFromAction(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as { url?: unknown };
    return typeof data.url === "string" ? data.url : null;
  } catch {
    return null;
  }
}

function FlagToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      className={cn(
        "flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[10px] transition",
        checked ? "border-accent/40 bg-accent/15 text-text" : "border-border bg-card2 text-muted hover:text-text",
      )}
    >
      <span
        className={cn(
          "flex h-3 w-3 items-center justify-center rounded border",
          checked ? "border-accent bg-accent text-white" : "border-border",
        )}
      >
        {checked && <Check size={8} />}
      </span>
      {label}
    </button>
  );
}

function EventRow({ event }: { event: OperatorEvent }) {
  if (event.kind === "file") {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-1.5">
        <AgentFileCard event={event} compact />
        <p className="mt-1 px-1 text-[9px] text-muted">{formatTime(event.createdAt)}</p>
      </div>
    );
  }

  const parsed = describeAction(event.action);
  const iconType = parsed?.type ?? (event.kind === "error" ? "error" : "info");
  const title =
    parsed?.title ||
    (event.kind === "thought"
      ? "Мысль модели"
      : event.kind === "error"
        ? "Ошибка"
        : event.kind === "info"
          ? "Служебное сообщение"
          : "Действие");

  return (
    <div className="rounded-lg border border-border bg-card px-2 py-1.5">
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md",
            event.kind === "error" ? "bg-red-500/10 text-red-500" : "bg-card2 text-muted",
          )}
        >
          {event.kind === "thought" ? (
            <Sparkles size={11} />
          ) : event.kind === "error" ? (
            <TriangleAlert size={11} />
          ) : (
            <ActionGlyph type={iconType} size={11} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          {parsed && event.kind === "action" && (
            <p className="text-[11px] font-medium leading-snug">{title}</p>
          )}
          {event.text && event.text !== title && (
            <p
              className={cn(
                "text-[11px] leading-relaxed",
                event.kind === "action" ? "text-emerald-500" : "text-muted",
                event.kind !== "action" && !parsed && "line-clamp-4",
              )}
            >
              {event.text}
            </p>
          )}
          {parsed?.json && event.kind === "action" && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[9px] text-muted">action.json</summary>
              <pre className="mt-1 max-h-32 overflow-auto rounded bg-card2 px-1.5 py-1 text-[9px] leading-relaxed text-muted">
                {parsed.json}
              </pre>
            </details>
          )}
          {event.kind === "action" && parsed?.type === "open_url" && urlFromAction(event.action) && (
            <div className="mt-1">
              <ActionLink url={urlFromAction(event.action)!} />
            </div>
          )}
        </div>
        <span className="shrink-0 text-[9px] text-muted">{formatTime(event.createdAt)}</span>
      </div>
    </div>
  );
}
