"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Download,
  FileText,
  Loader2,
  MonitorCog,
  Play,
  RefreshCw,
  Square,
  Terminal,
  XCircle,
} from "lucide-react";
import { cn, formatDateTime } from "@/lib/utils";

/**
 * Вкладка «Оператор»: очередь заданий для бота, который управляет рабочим
 * столом пользователя (`agent/desktop_operator.py`).
 *
 * Здесь видно, что бот делает шаг за шагом, и сюда же приходят файлы, которые
 * он собрал, — скачиваются прямо из браузера. Сам бот работает на машине
 * пользователя и забирает задания по токену.
 */

type AgentTask = {
  id: number;
  prompt: string;
  status: string;
  maxSteps: number;
  steps: number;
  summary: string;
  createdAt: string;
  updatedAt: string;
};

type AgentEvent = {
  id: number;
  kind: string;
  text: string;
  action: string;
  fileName: string;
  fileMime: string;
  fileSize: number;
  hasFile: boolean;
  createdAt: string;
};

const STATUS: Record<string, { label: string; className: string }> = {
  queued: { label: "в очереди", className: "bg-amber-500/15 text-amber-500" },
  running: { label: "выполняется", className: "bg-accent/20 text-accent2" },
  done: { label: "готово", className: "bg-emerald-500/15 text-emerald-500" },
  failed: { label: "ошибка", className: "bg-red-500/15 text-red-500" },
  cancelled: { label: "отменено", className: "bg-card2 text-muted" },
};

const KIND_ICON: Record<string, typeof FileText> = {
  thought: MonitorCog,
  action: Play,
  result: CheckCircle2,
  error: XCircle,
  file: FileText,
  info: CheckCircle2,
};

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} КБ`;
  return `${Math.round(bytes / 104857.6) / 10} МБ`;
}

export function OperatorPanel() {
  const [tokenExists, setTokenExists] = useState<boolean | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [prompt, setPrompt] = useState("");
  const [maxSteps, setMaxSteps] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

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

  const fetchTasks = useCallback(async (): Promise<AgentTask[] | null> => {
    try {
      const res = await fetch("/api/agent/tasks", { cache: "no-store" });
      if (!res.ok) return null;
      const data = (await res.json()) as { tasks?: AgentTask[] };
      return data.tasks ?? [];
    } catch {
      return null;
    }
  }, []);

  const fetchTask = useCallback(
    async (id: number): Promise<{ task: AgentTask | null; events: AgentEvent[] } | null> => {
      try {
        const res = await fetch(`/api/agent/tasks/${id}`, { cache: "no-store" });
        if (!res.ok) return null;
        const data = (await res.json()) as { task?: AgentTask; events?: AgentEvent[] };
        return { task: data.task ?? null, events: data.events ?? [] };
      } catch {
        return null;
      }
    },
    [],
  );

  const refreshTasks = useCallback(async () => {
    const list = await fetchTasks();
    if (list) setTasks(list);
  }, [fetchTasks]);

  const refreshTask = useCallback(
    async (id: number) => {
      const data = await fetchTask(id);
      if (!data) return;
      setEvents(data.events);
      if (data.task) setTasks((prev) => prev.map((t) => (t.id === id ? data.task! : t)));
    },
    [fetchTask],
  );

  // Первичная загрузка: токен и очередь.
  useEffect(() => {
    let alive = true;
    void Promise.all([fetchToken(), fetchTasks()]).then(([token, list]) => {
      if (!alive) return;
      if (token) {
        setTokenExists(token.exists);
        setHint(token.hint);
      }
      if (list) setTasks(list);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [fetchToken, fetchTasks]);

  // Очередь и открытое задание обновляются сами, пока вкладка видима.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshTasks();
      if (openId) void refreshTask(openId);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [refreshTasks, refreshTask, openId]);

  // Открыли задание — загружаем шаги и прокручиваем к последнему.
  useEffect(() => {
    if (!openId) return;
    let alive = true;
    void fetchTask(openId).then((data) => {
      if (!alive || !data) return;
      setEvents(data.events);
      if (data.task) setTasks((prev) => prev.map((t) => (t.id === openId ? data.task! : t)));
      bottomRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => {
      alive = false;
    };
  }, [openId, fetchTask]);

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
      setTokenExists(true);
      setCopied(false);
    } finally {
      setBusy(false);
    }
  };

  const copyToken = async () => {
    if (!freshToken) return;
    try {
      await navigator.clipboard.writeText(freshToken);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* браузер запретил буфер обмена — токен виден на экране */
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
      const data = (await res.json().catch(() => ({}))) as { task?: AgentTask; error?: string };
      if (!res.ok || !data.task) {
        setError(data.error ?? "Не удалось поставить задание");
        return;
      }
      setPrompt("");
      setTasks((prev) => [data.task!, ...prev]);
      setOpenId(data.task.id);
      setEvents([]);
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
    if (res.ok) {
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status: "cancelled" } : t)));
      if (openId === id) void refreshTask(id);
    }
  };

  const runCommand = freshToken
    ? `python3 agent/desktop_operator.py --watch --token ${freshToken} --provider local`
    : `python3 agent/desktop_operator.py --watch --token ТОКЕН --provider local`;

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-accent/30 bg-accent/5 p-3 text-[11px]">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <MonitorCog size={14} className="text-accent2" /> Оператор рабочего стола
        </p>
        <p className="mt-1 text-muted">
          Бот запускается на вашем компьютере, видит экран и выполняет задания: клики, ввод текста,
          открытие сайтов и создание файлов (docx, xlsx, csv, md, html, svg, zip). Файлы, которые он
          сделал, появляются здесь — скачиваются прямо из браузера.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-semibold">1. Токен бота</p>
          <span
            className={cn(
              "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
              tokenExists ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-500",
            )}
          >
            {tokenExists === null ? "проверяю…" : tokenExists ? `создан ·${hint ?? ""}` : "не создан"}
          </span>
          <button
            type="button"
            onClick={() => void createToken()}
            disabled={busy}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-border bg-card2 px-2 py-1 text-[11px] font-medium transition hover:border-accent/60 disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {tokenExists ? "Обновить токен" : "Создать токен"}
          </button>
        </div>

        {freshToken && (
          <div className="mt-2 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-2">
            <p className="text-[10px] text-muted">Токен показывается один раз — сохраните его в команде:</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-card2 px-2 py-1 text-[11px]">{freshToken}</code>
              <button
                type="button"
                onClick={() => void copyToken()}
                className="flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 text-[10px] transition hover:text-accent2"
              >
                <ClipboardCopy size={11} /> {copied ? "скопировано" : "копировать"}
              </button>
            </div>
          </div>
        )}

        <div className="mt-2 space-y-1.5">
          <p className="flex items-center gap-1.5 text-[11px] text-muted">
            <Terminal size={11} /> Запуск на компьютере:
          </p>
          <pre className="overflow-x-auto rounded-lg bg-card2 px-2 py-1.5 text-[11px]">pip install -r agent/requirements.txt</pre>
          <pre className="overflow-x-auto rounded-lg bg-card2 px-2 py-1.5 text-[11px]">{runCommand}</pre>
          <p className="text-[10px] text-muted">
            Модель: локальная (<code>--provider local</code>) или облачная (<code>--provider openai</code>,
            <code> openrouter</code>, <code>groq</code>, <code>deepseek</code>, <code>together</code>,
            <code> mistral</code>) — ключ передаётся боту и в CRM не сохраняется.
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-3">
        <p className="text-xs font-semibold">2. Новое задание</p>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          placeholder="Например: открой блокнот, напиши план на день и сохрани в файл plan.docx"
          className="mt-2 max-h-32 min-h-16 w-full resize-y rounded-xl border border-border bg-card2 px-3 py-2 text-xs outline-none focus:border-accent focus:ring-2 focus:ring-[var(--ring)]"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            Лимит шагов
            <input
              type="number"
              min={1}
              max={100}
              value={maxSteps}
              onChange={(e) => setMaxSteps(Math.min(100, Math.max(1, Number(e.target.value) || 15)))}
              className="h-7 w-16 rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
            />
          </label>
          <button
            type="button"
            onClick={() => void createTask()}
            disabled={busy || prompt.trim().length === 0}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[11px] font-medium text-white transition disabled:opacity-40"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            В очередь
          </button>
        </div>
        {error && <p className="mt-1.5 text-[11px] text-red-500">{error}</p>}
      </div>

      <div className="rounded-2xl border border-border bg-card">
        <p className="border-b border-border px-3 py-2 text-xs font-semibold">3. Задания и файлы</p>
        {loading ? (
          <p className="flex items-center gap-1.5 px-3 py-3 text-[11px] text-muted">
            <Loader2 size={12} className="animate-spin" /> Загружаю…
          </p>
        ) : tasks.length === 0 ? (
          <p className="px-3 py-3 text-[11px] text-muted">
            Пока пусто. Создайте токен, запустите бота и поставьте первое задание.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {tasks.map((task) => {
              const status = STATUS[task.status] ?? STATUS.queued;
              const open = openId === task.id;
              return (
                <div key={task.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenId(open ? null : task.id);
                      setEvents([]);
                    }}
                    className="flex w-full items-start gap-2 px-3 py-2 text-left transition hover:bg-card2/60"
                  >
                    <span className="mt-0.5 text-[10px] text-muted">#{task.id}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{task.prompt}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
                        <span className={cn("rounded px-1 py-0.5 font-medium", status.className)}>{status.label}</span>
                        <span>
                          шагов: {task.steps}/{task.maxSteps}
                        </span>
                        <span>{formatDateTime(task.createdAt)}</span>
                      </span>
                    </span>
                    {(task.status === "queued" || task.status === "running") && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          void cancelTask(task.id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.stopPropagation();
                            void cancelTask(task.id);
                          }
                        }}
                        className="rounded-md border border-border px-1.5 py-1 text-[10px] text-muted transition hover:text-red-500"
                        title="Отменить задание"
                      >
                        <Square size={10} />
                      </span>
                    )}
                  </button>

                  {open && (
                    <div className="space-y-1.5 bg-card2/40 px-3 py-2">
                      {events.length === 0 ? (
                        <p className="text-[11px] text-muted">
                          Пока нет шагов. Если бот не запущен — скопируйте команду выше и запустите её.
                        </p>
                      ) : (
                        events.map((event) => {
                          const Icon = KIND_ICON[event.kind] ?? AlertTriangle;
                          return (
                            <div key={event.id} className="flex items-start gap-2 text-[11px]">
                              <Icon
                                size={12}
                                className={cn(
                                  "mt-0.5 shrink-0",
                                  event.kind === "error"
                                    ? "text-red-500"
                                    : event.kind === "file"
                                      ? "text-emerald-500"
                                      : "text-muted",
                                )}
                              />
                              <div className="min-w-0 flex-1">
                                {event.kind === "file" && event.hasFile ? (
                                  <a
                                    href={`/api/agent/file/${event.id}`}
                                    className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 font-medium text-emerald-500 transition hover:bg-emerald-500/20"
                                  >
                                    <FileText size={12} />
                                    <span className="min-w-0 flex-1 truncate">{event.fileName}</span>
                                    <span className="text-[10px] text-muted">{formatSize(event.fileSize)}</span>
                                    <Download size={11} />
                                  </a>
                                ) : (
                                  <p className={cn("whitespace-pre-wrap break-words", event.kind === "error" && "text-red-500")}>
                                    {event.text || event.action}
                                  </p>
                                )}
                                <p className="text-[9px] text-muted">{formatDateTime(event.createdAt)}</p>
                              </div>
                            </div>
                          );
                        })
                      )}
                      {task.summary && <p className="text-[10px] text-muted">Итог: {task.summary}</p>}
                      <div ref={bottomRef} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
