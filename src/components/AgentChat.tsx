"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Download,
  ExternalLink,
  FileText,
  History,
  Loader2,
  MessageSquarePlus,
  Paperclip,
  PlayCircle,
  PlugZap,
  Send,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { AI_DEFAULT_BASE_URL, AI_STORAGE_SETTINGS, formatBytes, type AiSettings } from "@/lib/ai";
import { Input } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useStoredJson, useStoredNumber } from "@/lib/useStoredValue";
import { GenSettings } from "./GenSettings";
import {
  AGENT_MAX_STEPS,
  GEN_DEFAULT_PARAMS,
  decodeGenParams,
  type GenParams,
} from "@/lib/genParams";
import { formatFileSize, readOperatorFiles, type OperatorAttachment } from "./operator/files";

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
  /** Что приложил пользователь в этом сообщении. */
  attached?: Array<{ name: string; size: number }>;
  /** Размышления модели, если сервер их отдаёт. */
  reasoning?: string;
  error?: string;
};

type AgentConversation = {
  id: number;
  kind: "agent";
  title: string;
  messagesCount: number;
  updatedAt: string;
};

type StoredTurn = {
  id: number;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  error?: string;
  attachments?: Array<{ name?: string; size?: number }>;
  actions?: AgentAction[];
  files?: Array<{ name?: string; mime?: string; size?: number }>;
};

type Health = {
  available: boolean;
  endpoint?: string;
  hint?: string;
  model?: string | null;
  tools?: string[];
};

function decodeStoredTurn(message: StoredTurn): Turn {
  return {
    id: `m${message.id}`,
    role: message.role === "assistant" ? "assistant" : "user",
    content: String(message.content ?? ""),
    reasoning: String(message.reasoning ?? ""),
    error: String(message.error ?? "") || undefined,
    actions: Array.isArray(message.actions) ? message.actions : [],
    files: Array.isArray(message.files)
      ? message.files.map((file) => ({
          name: String(file.name ?? "файл"),
          mime: String(file.mime ?? "application/octet-stream"),
          size: Number(file.size ?? 0),
          data: "",
        }))
      : [],
    attached: Array.isArray(message.attachments)
      ? message.attachments.map((file) => ({ name: String(file.name ?? "файл"), size: Number(file.size ?? 0) }))
      : [],
  };
}

/** Пресеты OpenAI-совместимых API: локальная модель или облако по ключу. */
const PROVIDERS: Array<{ id: string; label: string; baseUrl: string; model: string }> = [
  { id: "local", label: "Локальная (vLLM / llama.cpp / LM Studio)", baseUrl: "http://127.0.0.1:8888/v1", model: "" },
  { id: "openai", label: "OpenAI API", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "qwen/qwen2.5-vl-72b-instruct" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "together", label: "Together", baseUrl: "https://api.together.xyz/v1", model: "Qwen/Qwen2.5-72B-Instruct-Turbo" },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", model: "mistral-large-latest" },
  { id: "custom", label: "Свой адрес…", baseUrl: "", model: "" },
];

const EXAMPLES = [
  "Открой YouTube и включи видео про космос",
  "Открой сайт новостей и покажи, что там сегодня",
  "Сделай CSV-файл с планом на неделю по продажам",
];

const DEFAULT_SETTINGS: AiSettings = { baseUrl: AI_DEFAULT_BASE_URL, apiKey: "", model: "" };

/** Разбор сохранённых настроек — уже после гидратации, через useStoredJson. */
function decodeSettings(raw: string): AiSettings {
  const parsed = JSON.parse(raw) as Partial<AiSettings>;
  return {
    baseUrl: String(parsed.baseUrl ?? DEFAULT_SETTINGS.baseUrl),
    apiKey: String(parsed.apiKey ?? ""),
    model: String(parsed.model ?? ""),
  };
}

export function AgentChat({ userName }: { userName: string }) {
  const [settings, setSettings] = useStoredJson<AiSettings>(
    AI_STORAGE_SETTINGS,
    DEFAULT_SETTINGS,
    decodeSettings,
  );
  const [params, setParams] = useStoredJson<GenParams>(
    "crm.ai.agent.params.v1",
    GEN_DEFAULT_PARAMS,
    decodeGenParams,
  );
  const [maxSteps, setMaxSteps] = useStoredNumber("crm.ai.agent.steps.v1", 20);
  const [health, setHealth] = useState<Health | null>(null);
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<OperatorAttachment[]>([]);
  const [reading, setReading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const counter = useRef(0);

  const nextId = () => {
    counter.current += 1;
    return `t${counter.current}`;
  };

  const saveSettings = (next: AiSettings) => {
    setSettings(next);
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

  const openConversation = useCallback(async (id: number) => {
    const res = await fetch(`/api/agent/conversations/${id}`, { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as {
      conversation?: AgentConversation;
      messages?: StoredTurn[];
      error?: string;
    };
    if (!res.ok || !data.conversation) throw new Error(data.error ?? "Не удалось открыть чат агента");

    setConversationId(id);
    setTurns((data.messages ?? []).map(decodeStoredTurn));
    setAttachments([]);
    setText("");
    counter.current = 0;
    setError(null);
    setStatus(null);
  }, []);

  const createConversation = useCallback(async () => {
    const res = await fetch("/api/agent/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "agent" }),
    });
    const data = (await res.json().catch(() => ({}))) as { conversation?: AgentConversation; error?: string };
    if (!res.ok || !data.conversation) throw new Error(data.error ?? "Не удалось создать чат агента");

    const conversation = data.conversation;
    setConversations((prev) => [conversation, ...prev.filter((item) => item.id !== conversation.id)]);
    setConversationId(conversation.id);
    setTurns([]);
    setAttachments([]);
    setText("");
    setError(null);
    setStatus(null);
    return conversation;
  }, []);

  const saveConversationMessage = useCallback(async (
    id: number,
    message: {
      role: "user" | "assistant";
      content: string;
      reasoning?: string;
      error?: string;
      attachments?: Array<{ name: string; size: number }>;
      actions?: AgentAction[];
      files?: Array<{ name: string; mime: string; size: number }>;
    },
  ) => {
    const res = await fetch(`/api/agent/conversations/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: StoredTurn; error?: string };
    if (!res.ok || !data.message) throw new Error(data.error ?? "Не удалось сохранить переписку");
    return decodeStoredTurn(data.message);
  }, []);

  useEffect(() => {
    let alive = true;
    const initialize = async () => {
      try {
        const res = await fetch("/api/agent/conversations?kind=agent", { cache: "no-store" });
        const data = (await res.json().catch(() => ({}))) as {
          conversations?: AgentConversation[];
          error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? "Не удалось загрузить историю агента");
        if (!alive) return;
        const list = data.conversations ?? [];
        setConversations(list);
        if (list.length > 0) await openConversation(list[0].id);
        else await createConversation();
      } catch (caught) {
        if (alive) setError(caught instanceof Error ? caught.message : "Не удалось загрузить чаты агента");
      } finally {
        if (alive) setHistoryLoading(false);
      }
    };
    void initialize();
    return () => {
      alive = false;
    };
  }, [createConversation, openConversation]);

  const selectConversation = async (id: number) => {
    if (id === conversationId || running || historyLoading) return;
    setHistoryLoading(true);
    setError(null);
    try {
      await openConversation(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось открыть чат агента");
    } finally {
      setHistoryLoading(false);
    }
  };

  const startNewConversation = async () => {
    if (running || historyLoading) return;
    setHistoryLoading(true);
    try {
      await createConversation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось создать чат агента");
    } finally {
      setHistoryLoading(false);
    }
  };

  const deleteCurrentConversation = async () => {
    if (conversationId === null || running || historyLoading) return;
    const id = conversationId;
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/agent/conversations/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Не удалось удалить чат агента");
      const rest = conversations.filter((item) => item.id !== id);
      setConversations(rest);
      if (rest.length > 0) await openConversation(rest[0].id);
      else await createConversation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось удалить чат агента");
    } finally {
      setHistoryLoading(false);
    }
  };

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
    const typed = (preset ?? text).trim();
    const activeId = conversationId;
    // Файл без вопроса — тоже запрос: агент прочитает вложение и расскажет,
    // что в нём, вместо того чтобы требовать текст.
    const content =
      typed || (attachments.length > 0 ? "Проанализируй приложенные файлы и коротко перескажи главное." : "");
    if (!content || running || historyLoading || activeId === null) return;
    setError(null);
    if (!preset) setText("");
    const attachedTurn = attachments.map((file) => ({ name: file.name, size: file.size }));
    const userTurn: Turn = {
      id: nextId(),
      role: "user",
      content,
      actions: [],
      files: [],
      attached: attachedTurn,
    };
    const assistantId = nextId();
    const history = [...turns, userTurn];
    setTurns([
      ...history,
      { id: assistantId, role: "assistant", content: "", actions: [], files: [], reasoning: "" },
    ]);
    setRunning(true);
    setStatus("Отправляю агенту…");
    scrollDown();

    const patch = (update: (turn: Turn) => Turn) => {
      setTurns((prev) => prev.map((t) => (t.id === assistantId ? update(t) : t)));
    };
    const assistantDraft: {
      content: string;
      reasoning: string;
      actions: AgentAction[];
      files: AgentFile[];
      error: string;
    } = { content: "", reasoning: "", actions: [], files: [], error: "" };
    let userSaved = false;

    try {
      setStatus("Сохраняю переписку…");
      const storedUser = await saveConversationMessage(activeId, {
        role: "user",
        content: userTurn.content,
        attachments: attachedTurn,
      });
      userSaved = true;
      setTurns((prev) => prev.map((turn) => (turn.id === userTurn.id ? storedUser : turn)));
      setConversations((prev) => {
        const current = prev.find((item) => item.id === activeId);
        if (!current) return prev;
        const title = current.title === "Новый чат" ? content.replace(/\s+/g, " ").slice(0, 80) : current.title;
        const updated = { ...current, title, messagesCount: current.messagesCount + 1, updatedAt: new Date().toISOString() };
        return [updated, ...prev.filter((item) => item.id !== activeId)];
      });
      const res = await fetch("/api/ai/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map((t) => ({ role: t.role, content: t.content })),
          settings,
          params,
          maxSteps: Math.min(AGENT_MAX_STEPS, Math.max(1, maxSteps)),
          attachments: attachments.map((file) => ({
            name: file.name,
            note: file.note,
            text: file.text,
            ...(file.image ? { image: file.image } : {}),
          })),
        }),
      });
      // Файлы уже ушли в запросе — в следующем сообщении их быть не должно.
      setAttachments([]);

      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        assistantDraft.error = data.error ?? "Агент недоступен";
        patch((t) => ({ ...t, error: assistantDraft.error }));
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
          } else if (event === "reasoning") {
            assistantDraft.reasoning = String(data.text ?? "");
            patch((t) => ({ ...t, reasoning: assistantDraft.reasoning }));
            scrollDown();
          } else if (event === "text") {
            assistantDraft.content = String(data.text ?? "");
            patch((t) => ({ ...t, content: assistantDraft.content }));
          } else if (event === "error") {
            assistantDraft.error = String(data.error ?? "Ошибка агента");
            patch((t) => ({ ...t, error: assistantDraft.error }));
            setStatus(null);
          } else if (event === "action") {
            if (data.type === "file") {
              const file: AgentFile = {
                name: String(data.name ?? "файл"),
                mime: String(data.mime ?? "application/octet-stream"),
                size: Number(data.size ?? 0),
                data: String(data.data ?? ""),
              };
              assistantDraft.files.push(file);
              patch((t) => ({ ...t, files: [...t.files, file] }));
            } else if (data.type === "open_url") {
              const action: AgentAction = {
                type: "open_url",
                url: String(data.url ?? ""),
                label: String(data.label ?? data.url ?? ""),
                autoplay: Boolean(data.autoplay),
              };
              assistantDraft.actions.push(action);
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
    } catch (caught) {
      assistantDraft.error = userSaved
        ? "Соединение с агентом прервалось"
        : caught instanceof Error
          ? caught.message
          : "Не удалось сохранить сообщение";
      patch((t) => ({ ...t, error: assistantDraft.error }));
    } finally {
      if (userSaved) {
        try {
          const storedAssistant = await saveConversationMessage(activeId, {
            role: "assistant",
            content: assistantDraft.content,
            reasoning: assistantDraft.reasoning,
            error: assistantDraft.error,
            actions: assistantDraft.actions,
            files: assistantDraft.files.map(({ name, mime, size }) => ({ name, mime, size })),
          });
          setTurns((prev) =>
            prev.map((turn) =>
              turn.id === assistantId
                ? {
                    ...storedAssistant,
                    // Сохраняем живые байты файлов в текущем сеансе для скачивания;
                    // в базе остаются только имя, тип и размер.
                    files: assistantDraft.files.length > 0 ? assistantDraft.files : storedAssistant.files,
                  }
                : turn,
            ),
          );
          setConversations((prev) => {
            const current = prev.find((item) => item.id === activeId);
            if (!current) return prev;
            const updated = { ...current, messagesCount: current.messagesCount + 1, updatedAt: new Date().toISOString() };
            return [updated, ...prev.filter((item) => item.id !== activeId)];
          });
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "Не удалось сохранить ответ агента");
        }
      }
      setRunning(false);
      setStatus(null);
      scrollDown();
    }
  };

  const normalized = settings.baseUrl.replace(/\/+$/, "");
  const activeProvider =
    PROVIDERS.find((provider) => provider.baseUrl && provider.baseUrl === normalized)?.id ?? "custom";
  const remoteApi = !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(normalized);

  const applyProvider = (id: string) => {
    const provider = PROVIDERS.find((item) => item.id === id);
    if (!provider || id === "custom") return;
    saveSettings({
      ...settings,
      baseUrl: provider.baseUrl,
      model: provider.model || settings.model,
    });
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

      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-card p-2">
        <History size={13} className="ml-1 text-muted" />
        <select
          aria-label="История чатов агента"
          value={conversationId ?? ""}
          onChange={(event) => {
            const id = Number(event.target.value);
            if (id > 0) void selectConversation(id);
          }}
          disabled={historyLoading || conversations.length === 0}
          className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent disabled:opacity-60"
        >
          {conversations.length === 0 ? (
            <option value="">{historyLoading ? "Загружаю историю…" : "Чатов пока нет"}</option>
          ) : (
            conversations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title || "Новый чат"} · {item.messagesCount} сообщ.
              </option>
            ))
          )}
        </select>
        <button
          type="button"
          onClick={() => void startNewConversation()}
          disabled={historyLoading || running}
          className="flex h-8 items-center gap-1 rounded-lg border border-border bg-card2 px-2 text-[10px] font-medium text-muted transition hover:text-text disabled:opacity-40"
        >
          <MessageSquarePlus size={12} /> Новый чат
        </button>
        <button
          type="button"
          onClick={() => void deleteCurrentConversation()}
          disabled={conversationId === null || historyLoading || running}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card2 text-muted transition hover:text-red-500 disabled:opacity-40"
          title="Удалить этот чат"
          aria-label="Удалить чат агента"
        >
          <Trash2 size={13} />
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

      <GenSettings
        value={params}
        onChange={setParams}
        defaultOpen
        subtitle="Как модель думает и генерирует ответ. Пустое поле — параметр не передаём."
      >
        <label className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          Лимит шагов агента
          <Input
            type="number"
            min={1}
            max={AGENT_MAX_STEPS}
            value={maxSteps}
            onChange={(event) =>
              setMaxSteps(Math.min(AGENT_MAX_STEPS, Math.max(1, Number(event.target.value) || 1)))
            }
            className="h-8 w-20 px-2 text-[11px]"
          />
          <span className="text-[10px]">
            сколько раз агент может вызвать инструменты (до {AGENT_MAX_STEPS})
          </span>
        </label>
      </GenSettings>

      <div className="rounded-2xl border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 pt-3 text-[11px] text-muted">
          <label className="flex items-center gap-1.5">
            Провайдер
            <select
              value={activeProvider}
              onChange={(e) => applyProvider(e.target.value)}
              className="h-8 rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
            >
              {PROVIDERS.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
          </label>
          <span className="text-[10px]">
            {remoteApi
              ? "облачный API: ключ нужен и уходит в запросе, в базу не пишется"
              : "локальная модель: ключ обычно не нужен"}
          </span>
        </div>

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
          {historyLoading ? (
            <div className="flex h-full items-center justify-center gap-2 text-[11px] text-muted">
              <Loader2 size={13} className="animate-spin" /> Загружаю переписку…
            </div>
          ) : turns.length === 0 ? (
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

                  {turn.reasoning && turn.reasoning.trim() && (
                    <details className="rounded-xl border border-border bg-card px-2 py-1.5 text-[11px]">
                      <summary className="cursor-pointer text-muted">
                        Размышления · {turn.reasoning.length} симв.
                      </summary>
                      <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-muted">
                        {turn.reasoning}
                      </p>
                    </details>
                  )}

                  {turn.attached && turn.attached.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {turn.attached.map((file, index) => (
                        <span
                          key={`${file.name}-${index}`}
                          className="flex items-center gap-1 rounded-lg border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted"
                        >
                          <FileText size={10} /> {file.name} · {formatBytes(file.size)}
                        </span>
                      ))}
                    </div>
                  )}

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

                  {turn.files.map((file, index) =>
                    file.data ? (
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
                    ) : (
                      <div
                        key={`${file.name}-${index}`}
                        className="flex items-center gap-2 rounded-xl border border-border bg-card px-2.5 py-2 text-muted"
                        title="В историю сохраняется имя, а не содержимое файла"
                      >
                        <FileText size={14} />
                        <span className="min-w-0 flex-1 truncate">{file.name}</span>
                        <span className="text-[10px]">{formatBytes(file.size)} · файл не сохранён</span>
                      </div>
                    ),
                  )}

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
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {attachments.map((file) => (
                <span
                  key={`${file.name}-${file.size}`}
                  className="flex items-center gap-1 rounded-lg border border-border bg-card2 px-1.5 py-0.5 text-[10px] text-muted"
                >
                  <FileText size={10} /> {file.name} · {formatFileSize(file.size)}
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((item) => item !== file))}
                    className="text-muted transition hover:text-red-500"
                    aria-label={`Убрать ${file.name}`}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex min-w-0 items-end gap-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              className="sr-only"
              aria-label="Приложить файлы для анализа"
              onChange={(event) => {
                // Снимок делаем ДО input.value = "": иначе браузер очищает
                // FileList, и файл «не прикрепляется».
                const list = Array.from(event.target.files ?? []);
                event.target.value = "";
                if (list.length === 0) return;
                setReading(true);
                void readOperatorFiles(attachments, list)
                  .then(({ files, errors }) => {
                    setAttachments((prev) => [...prev, ...files]);
                    if (errors.length > 0) setError(errors[0]);
                  })
                  .finally(() => setReading(false));
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={running || reading || historyLoading || conversationId === null}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card2 text-muted transition hover:text-text disabled:opacity-40"
              title="Приложить файлы для анализа (до 5 по 10 МБ)"
              aria-label="Приложить файлы"
            >
              {reading ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
            </button>
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
              disabled={historyLoading || conversationId === null}
              className="max-h-32 min-h-10 min-w-0 flex-1 resize-y rounded-xl border border-border bg-card2 px-3 py-2 text-xs outline-none focus:border-accent focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={running || historyLoading || conversationId === null || (!text.trim() && attachments.length === 0)}
              className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 text-xs font-medium text-white transition disabled:opacity-40"
            >
              {running ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Запустить
            </button>
          </div>
          <p className="mt-1.5 text-[10px] text-muted">
            Скрепка — файлы для анализа (до 5 по 10 МБ). Переписка сохраняется в базе; в истории остаются
            имена вложений и созданных файлов, но не сами байты файлов.
          </p>
        </div>
      </div>
    </div>
  );
}
