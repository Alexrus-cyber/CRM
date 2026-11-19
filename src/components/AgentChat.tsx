"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  PlayCircle,
  PlugZap,
  Send,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { AI_DEFAULT_BASE_URL, AI_STORAGE_SETTINGS, formatBytes, type AiSettings } from "@/lib/ai";
import { cn } from "@/lib/utils";

/**
 * Вкладка «Агент» блока ИИ (эксперимент, только главный админ).
 *
 * В отличие от обычного чата, агент умеет действовать: создаёт файлы и
 * открывает сайты в браузере. Сами решения принимает Python-процесс
 * (`agent/agent.py`), а этот компонент показывает шаги, действия и файлы.
 */

type AgentFile = { name: string; mime: string; size: number; data: string };
type AgentAction = { type: "open_url"; url: string; label: string; autoplay?: boolean };

type Turn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  actions: AgentAction[];
  files: AgentFile[];
  error?: string;
};

type Health = {
  available: boolean;
  endpoint?: string;
  hint?: string;
  model?: string | null;
  tools?: string[];
};

const EXAMPLES = [
  "Открой YouTube и включи видео про космос",
  "Открой сайт новостей и покажи, что там сегодня",
  "Сделай CSV-файл с планом на неделю по продажам",
];

function loadSettings(): AiSettings {
  if (typeof window === "undefined") {
    return { baseUrl: AI_DEFAULT_BASE_URL, apiKey: "", model: "" };
  }
  try {
    const raw = localStorage.getItem(AI_STORAGE_SETTINGS);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AiSettings>;
      return {
        baseUrl: String(parsed.baseUrl ?? AI_DEFAULT_BASE_URL),
        apiKey: String(parsed.apiKey ?? ""),
        model: String(parsed.model ?? ""),
      };
    }
  } catch {
    /* локальные настройки не читаются — берём значения по умолчанию */
  }
  return { baseUrl: AI_DEFAULT_BASE_URL, apiKey: "", model: "" };
}

export function AgentChat({ userName }: { userName: string }) {
  const [settings, setSettings] = useState<AiSettings>(loadSettings);
  const [health, setHealth] = useState<Health | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const counter = useRef(0);

  const nextId = () => {
    counter.current += 1;
    return `t${counter.current}`;
  };

  const saveSettings = (next: AiSettings) => {
    setSettings(next);
    try {
      localStorage.setItem(AI_STORAGE_SETTINGS, JSON.stringify(next));
    } catch {
      /* приватный режим — настройки живут до перезагрузки */
    }
  };

  /** Состояние агента: жив ли Python-процесс и какие у него инструменты. */
  const loadHealth = useCallback(async (): Promise<Health> => {
    try {
      const res = await fetch("/api/ai/agent", { cache: "no-store" });
      if (!res.ok) return { available: false, hint: "Агент доступен только главному администратору" };
      return (await res.json()) as Health;
    } catch {
      return { available: false, hint: "Не удалось проверить агента" };
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void loadHealth().then((next) => {
      if (alive) setHealth(next);
    });
    return () => {
      alive = false;
    };
  }, [loadHealth]);

  const scrollDown = () => {
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    });
  };

  const openUrl = (url: string) => {
    const win = window.open(url, "_blank", "noopener,noreferrer");
    return Boolean(win);
  };

  const send = async (preset?: string) => {
    const content = (preset ?? text).trim();
    if (!content || running) return;
    setError(null);
    setText("");
    const userTurn: Turn = { id: nextId(), role: "user", content, actions: [], files: [] };
    const assistantId = nextId();
    const history = [...turns, userTurn];
    setTurns([...history, { id: assistantId, role: "assistant", content: "", actions: [], files: [] }]);
    setRunning(true);
    setStatus("Отправляю агенту…");
    scrollDown();

    const patch = (update: (turn: Turn) => Turn) => {
      setTurns((prev) => prev.map((t) => (t.id === assistantId ? update(t) : t)));
    };

    try {
      const res = await fetch("/api/ai/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map((t) => ({ role: t.role, content: t.content })),
          settings,
        }),
      });

      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        patch((t) => ({ ...t, error: data.error ?? "Агент недоступен" }));
        setStatus(null);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");

          const eventLine = raw.split("\n").find((line) => line.startsWith("event:"));
          const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
          if (!dataLine) continue;
          const event = eventLine ? eventLine.slice(6).trim() : "message";
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (event === "status") {
            setStatus(String(data.text ?? ""));
          } else if (event === "text") {
            const reply = String(data.text ?? "");
            patch((t) => ({ ...t, content: reply }));
          } else if (event === "error") {
            patch((t) => ({ ...t, error: String(data.error ?? "Ошибка агента") }));
            setStatus(null);
          } else if (event === "action") {
            if (data.type === "file") {
              const file: AgentFile = {
                name: String(data.name ?? "файл"),
                mime: String(data.mime ?? "application/octet-stream"),
                size: Number(data.size ?? 0),
                data: String(data.data ?? ""),
              };
              patch((t) => ({ ...t, files: [...t.files, file] }));
            } else if (data.type === "open_url") {
              const action: AgentAction = {
                type: "open_url",
                url: String(data.url ?? ""),
                label: String(data.label ?? data.url ?? ""),
                autoplay: Boolean(data.autoplay),
              };
              patch((t) => ({ ...t, actions: [...t.actions, action] }));
              // Браузер может заблокировать всплывающее окно — карточка с
              // кнопкой остаётся, поэтому действие не теряется.
              if (action.url) openUrl(action.url);
            }
            scrollDown();
          } else if (event === "done") {
            setStatus(null);
          }
        }
      }
    } catch {
      patch((t) => ({ ...t, error: "Соединение с агентом прервалось" }));
    } finally {
      setRunning(false);
      setStatus(null);
      scrollDown();
    }
  };

  const available = health?.available ?? false;
  const tools = useMemo(() => health?.tools ?? [], [health]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px]">
        <span className="flex items-center gap-1.5 font-semibold text-amber-500">
          <Sparkles size={13} /> Агент (эксперимент)
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium",
            health === null
              ? "bg-card2 text-muted"
              : available
                ? "bg-emerald-500/15 text-emerald-500"
                : "bg-red-500/15 text-red-500",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              health === null ? "bg-muted" : available ? "bg-emerald-500" : "bg-red-500",
            )}
          />
          {health === null ? "проверяю…" : available ? "агент онлайн" : "агент не запущен"}
        </span>
        {health?.endpoint && <span className="text-muted">· {health.endpoint}</span>}
        <button
          type="button"
          onClick={() => {
            void loadHealth().then(setHealth);
          }}
          className="ml-auto rounded-lg border border-border bg-card px-2 py-1 font-medium text-muted transition hover:text-text"
        >
          Проверить
        </button>
      </div>

      {health !== null && !available && (
        <div className="rounded-2xl border border-border bg-card p-3 text-[11px] text-muted">
          <p className="flex items-center gap-1.5 font-semibold text-text">
            <PlugZap size={13} className="text-amber-500" /> Как включить агента
          </p>
          <p className="mt-1">{health?.hint ?? "Агент — отдельный процесс на Python."}</p>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-card2 px-2 py-1.5 text-[11px] text-text">python3 agent/agent.py</pre>
          <p className="mt-1">
            Он использует тот же OpenAI-совместимый сервер, что и чат: адрес, ключ и модель берутся из настроек ниже.
          </p>
        </div>
      )}

      <div className="rounded-2xl border border-border bg-card">
        <div className="grid gap-2 border-b border-border p-3 sm:grid-cols-3">
          <label className="text-[11px] text-muted">
            Base URL
            <input
              value={settings.baseUrl}
              onChange={(e) => saveSettings({ ...settings, baseUrl: e.target.value })}
              placeholder={AI_DEFAULT_BASE_URL}
              className="mt-1 h-8 w-full rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
            />
          </label>
          <label className="text-[11px] text-muted">
            Модель
            <input
              value={settings.model}
              onChange={(e) => saveSettings({ ...settings, model: e.target.value })}
              placeholder="например, qwen3:8b"
              className="mt-1 h-8 w-full rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
            />
          </label>
          <label className="text-[11px] text-muted">
            API-ключ (если нужен)
            <input
              value={settings.apiKey}
              onChange={(e) => saveSettings({ ...settings, apiKey: e.target.value })}
              type="password"
              placeholder="необязательно"
              className="mt-1 h-8 w-full rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
            />
          </label>
        </div>

        <div ref={listRef} className="h-[420px] space-y-3 overflow-y-auto p-3">
          {turns.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card2/50 p-4 text-xs">
              <p className="flex items-center gap-1.5 font-semibold">
                <Bot size={14} className="text-accent2" /> {userName}, агент умеет не только отвечать
              </p>
              <ul className="mt-2 space-y-1 text-muted">
                <li>• создаёт файлы (CSV, markdown, HTML, код) и отдаёт их на скачивание;</li>
                <li>• открывает сайты в вашем браузере;</li>
                <li>• включает видео на YouTube по запросу.</li>
              </ul>
              {tools.length > 0 && (
                <p className="mt-2 text-[10px] text-muted">Инструменты: {tools.join(", ")}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => void send(example)}
                    className="rounded-lg border border-border bg-card px-2 py-1 text-[11px] text-muted transition hover:border-accent/60 hover:text-text"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((turn) => (
              <div key={turn.id} className={cn("flex", turn.role === "user" ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[92%] space-y-2 rounded-2xl px-3 py-2 text-xs",
                    turn.role === "user" ? "bg-accent/20" : "border border-border bg-card2",
                  )}
                >
                  {turn.content ? (
                    <p className="whitespace-pre-wrap break-words leading-relaxed">{turn.content}</p>
                  ) : turn.role === "assistant" && running ? (
                    <p className="flex items-center gap-1.5 text-muted">
                      <Loader2 size={12} className="animate-spin" /> агент думает…
                    </p>
                  ) : null}

                  {turn.actions.map((action, index) => (
                    <a
                      key={`${action.url}-${index}`}
                      href={action.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/10 px-2.5 py-2 font-medium text-accent2 transition hover:bg-accent/20"
                    >
                      {action.autoplay ? <PlayCircle size={14} /> : <ExternalLink size={14} />}
                      <span className="min-w-0 flex-1 truncate">{action.label}</span>
                      <span className="text-[10px] text-muted">открыть</span>
                    </a>
                  ))}

                  {turn.files.map((file, index) => (
                    <a
                      key={`${file.name}-${index}`}
                      href={`data:${file.mime};base64,${file.data}`}
                      download={file.name}
                      className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-2 font-medium text-emerald-500 transition hover:bg-emerald-500/20"
                    >
                      <FileText size={14} />
                      <span className="min-w-0 flex-1 truncate">{file.name}</span>
                      <span className="text-[10px] text-muted">{formatBytes(file.size)}</span>
                      <Download size={13} />
                    </a>
                  ))}

                  {turn.error && (
                    <p className="flex items-start gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-500">
                      <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                      {turn.error}
                    </p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="border-t border-border p-3">
          {status && (
            <p className="mb-2 flex items-center gap-1.5 text-[11px] text-muted">
              <Loader2 size={11} className="animate-spin" /> {status}
            </p>
          )}
          {error && <p className="mb-2 text-[11px] text-red-500">{error}</p>}
          <div className="flex min-w-0 items-end gap-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder="Например: открой ютуб и включи видео про космос…"
              className="max-h-32 min-h-10 min-w-0 flex-1 resize-y rounded-xl border border-border bg-card2 px-3 py-2 text-xs outline-none focus:border-accent focus:ring-2 focus:ring-[var(--ring)]"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={running || text.trim().length === 0}
              className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 text-xs font-medium text-white transition disabled:opacity-40"
            >
              {running ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Запустить
            </button>
            {turns.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setTurns([]);
                  setError(null);
                  setStatus(null);
                }}
                disabled={running}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card2 text-muted transition hover:text-red-500 disabled:opacity-40"
                title="Очистить диалог с агентом"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
          <p className="mt-1.5 text-[10px] text-muted">
            История агента не сохраняется в базе — это тестовый режим. Действия выполняются в вашем браузере.
          </p>
        </div>
      </div>
    </div>
  );
}
