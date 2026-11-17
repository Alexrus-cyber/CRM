"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  Eye,
  EyeOff,
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Avatar, Badge, Button, Card, Field, Input } from "./ui";
import { cn, formatTime } from "@/lib/utils";
import {
  AI_DEFAULT_BASE_URL,
  AI_MAX_FILES,
  AI_MAX_IMAGE_BYTES,
  AI_MAX_TEXT_BYTES,
  AI_STORAGE_HISTORY,
  AI_STORAGE_SETTINGS,
  formatBytes,
  isImageMime,
  isTextFile,
  type AiSettings,
} from "@/lib/ai";

type AttKind = "image" | "text" | "skipped";

type AttachmentMeta = { name: string; mime: string; size: number; kind: AttKind };

type Bubble = {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments: AttachmentMeta[];
  at: number;
  error?: boolean;
};

type PendingFile = { id: string; file: File; preview: string | null };

/** Сообщение в формате OpenAI API, которое уходит на локальный сервер. */
type OutgoingMessage = { role: "user" | "assistant" | "system"; content: unknown };

const HISTORY_LIMIT = 40;

function readSettings(): AiSettings {
  const fallback: AiSettings = { baseUrl: AI_DEFAULT_BASE_URL, apiKey: "", model: "" };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(AI_STORAGE_SETTINGS);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    return {
      baseUrl: parsed.baseUrl?.trim() || fallback.baseUrl,
      apiKey: parsed.apiKey ?? "",
      model: parsed.model ?? "",
    };
  } catch {
    return fallback;
  }
}

function readHistory(): Bubble[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(AI_STORAGE_HISTORY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Bubble[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item.text === "string" && (item.role === "user" || item.role === "assistant"));
  } catch {
    return [];
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.readAsDataURL(file);
  });
}

/** Простая разметка ответа: блоки кода в ``` и обычный текст с переносами. */
function RichText({ text }: { text: string }) {
  const blocks = text.split("```");
  return (
    <div className="space-y-2">
      {blocks.map((block, index) => {
        if (index % 2 === 1) {
          const body = block.replace(/^[a-zA-Z0-9+#._-]*\n/, "");
          return (
            <pre key={index} className="overflow-x-auto rounded-lg bg-black/30 p-2.5 text-[11px] leading-relaxed">
              <code className="whitespace-pre">{body.replace(/\n$/, "")}</code>
            </pre>
          );
        }
        const clean = block.trim();
        if (!clean) return null;
        return (
          <p key={index} className="whitespace-pre-wrap break-words">
            {clean}
          </p>
        );
      })}
    </div>
  );
}

export function AiChatClient({ userName }: { userName: string }) {
  const [settings, setSettings] = useState<AiSettings>(readSettings);
  const [settingsOpen, setSettingsOpen] = useState(() => !readSettings().model);
  const [showKey, setShowKey] = useState(false);
  const [bubbles, setBubbles] = useState<Bubble[]>(readHistory);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const contextRef = useRef<OutgoingMessage[]>([]);
  const previewsRef = useRef<string[]>([]);

  const updateSettings = (patch: Partial<AiSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    setNotice(null);
  };

  // Адрес/ключ/модель живут только в этом браузере.
  useEffect(() => {
    try {
      window.localStorage.setItem(AI_STORAGE_SETTINGS, JSON.stringify(settings));
    } catch {
      /* приватный режим — просто не сохраняем */
    }
  }, [settings]);

  // Текст переписки — тоже локально: сервер её не хранит.
  useEffect(() => {
    try {
      const compact = bubbles.slice(-HISTORY_LIMIT).map(({ id, role, text: body, attachments, at, error: failed }) => ({
        id,
        role,
        text: body,
        attachments,
        at,
        error: failed,
      }));
      window.localStorage.setItem(AI_STORAGE_HISTORY, JSON.stringify(compact));
    } catch {
      /* переполнение хранилища — не критично */
    }
  }, [bubbles]);

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [bubbles]);

  const addFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (picked.length === 0) return;
    setError(null);

    const next = [...pending];
    let problem: string | null = null;
    for (const file of picked) {
      if (next.length >= AI_MAX_FILES) {
        problem = `Можно приложить не больше ${AI_MAX_FILES} файлов к одному вопросу`;
        break;
      }
      if (!isImageMime(file.type) && !isTextFile(file.type, file.name)) {
        problem =
          `Файл «${file.name}» не текст и не картинка — модель его не увидит. ` +
          "Поддерживаются картинки, текстовые файлы и таблицы (.txt, .md, .csv, .json, код).";
        continue;
      }
      if (isImageMime(file.type) && file.size > AI_MAX_IMAGE_BYTES) {
        problem = `Картинка «${file.name}» больше ${formatBytes(AI_MAX_IMAGE_BYTES)}`;
        continue;
      }
      if (!isImageMime(file.type) && file.size > AI_MAX_TEXT_BYTES) {
        problem = `Текстовый файл «${file.name}» больше ${formatBytes(AI_MAX_TEXT_BYTES)}`;
        continue;
      }
      const preview = isImageMime(file.type) ? URL.createObjectURL(file) : null;
      if (preview) previewsRef.current.push(preview);
      next.push({
        id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`,
        file,
        preview,
      });
    }
    if (problem) setError(problem);
    setPending(next);
  };

  const removePending = (id: string) => {
    const target = pending.find((item) => item.id === id);
    if (target?.preview) {
      URL.revokeObjectURL(target.preview);
      previewsRef.current = previewsRef.current.filter((url) => url !== target.preview);
    }
    setPending(pending.filter((item) => item.id !== id));
  };

  const clearPending = () => {
    for (const url of previewsRef.current) URL.revokeObjectURL(url);
    previewsRef.current = [];
    setPending([]);
  };

  // Освобождаем blob-URL превью при размонтировании блока.
  useEffect(() => () => {
    for (const url of previewsRef.current) URL.revokeObjectURL(url);
    previewsRef.current = [];
  }, []);

  const checkConnection = async () => {
    if (checking || streaming) return;
    setChecking(true);
    setError(null);
    setNotice(null);
    setModels([]);
    try {
      const res = await fetch(`/api/ai/models?base=${encodeURIComponent(settings.baseUrl)}`, {
        headers: settings.apiKey.trim() ? { "x-ai-key": settings.apiKey } : undefined,
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as { models?: string[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? `Сервер ответил ${res.status}`);
        return;
      }
      const list = data.models ?? [];
      setModels(list);
      if (list.length === 0) {
        setNotice("Подключение есть, но сервер не вернул список моделей. Впишите имя модели вручную.");
      } else if (!settings.model.trim() || !list.includes(settings.model)) {
        updateSettings({ model: list[0] });
        setNotice(`Подключение работает. Выбрана модель «${list[0]}» — при необходимости замените.`);
      } else {
        setNotice(`Подключение работает, доступно моделей: ${list.length}.`);
      }
    } catch {
      setError("Не удалось проверить подключение: сеть недоступна");
    } finally {
      setChecking(false);
    }
  };

  const send = async () => {
    const question = text.trim();
    if (streaming) return;
    if (!question && pending.length === 0) return;
    if (!settings.model.trim()) {
      setSettingsOpen(true);
      setError("Укажите модель — например, через «Проверить подключение» или вручную.");
      return;
    }
    setError(null);
    setNotice(null);

    const parts: Array<Record<string, unknown>> = [];
    const metas: AttachmentMeta[] = [];
    for (const item of pending) {
      if (isImageMime(item.file.type)) {
        const dataUrl = await fileToDataUrl(item.file);
        parts.push({ type: "image_url", image_url: { url: dataUrl } });
        metas.push({ name: item.file.name, mime: item.file.type, size: item.file.size, kind: "image" });
      } else {
        const content = await item.file.text();
        parts.push({ type: "text", text: `Файл «${item.file.name}»:\n\n${content}` });
        metas.push({ name: item.file.name, mime: item.file.type || "text/plain", size: item.file.size, kind: "text" });
      }
    }
    if (question) parts.unshift({ type: "text", text: question });

    // История из localStorage — без вложений: они живут только в текущей сессии.
    if (contextRef.current.length === 0 && bubbles.length > 0) {
      contextRef.current = bubbles.map((bubble) => ({ role: bubble.role, content: bubble.text }));
    }
    const outgoing = question && parts.length === 1 && parts[0].type === "text" ? question : parts;
    contextRef.current.push({ role: "user", content: outgoing });

    const now = Date.now();
    const replyId = `a-${now}`;
    setBubbles((prev) => [
      ...prev,
      { id: `u-${now}`, role: "user", text: question, attachments: metas, at: now },
      { id: replyId, role: "assistant", text: "", attachments: [], at: now },
    ]);
    setText("");
    clearPending();
    if (inputRef.current) inputRef.current.focus();
    await runCompletion(replyId);
  };

  const runCompletion = async (replyId: string) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    let accumulated = "";

    const patch = (patchData: Partial<Bubble>) =>
      setBubbles((prev) => prev.map((bubble) => (bubble.id === replyId ? { ...bubble, ...patchData } : bubble)));

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ai-base": settings.baseUrl,
          "x-ai-key": settings.apiKey,
          "x-ai-model": settings.model,
        },
        body: JSON.stringify({ messages: contextRef.current }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Сервер ответил ${res.status}`);
      }
      if (!res.body) throw new Error("Пустой ответ сервера");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const event = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf("\n\n");
          const line = event.split("\n").find((row) => row.startsWith("data:"));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          const data = JSON.parse(payload) as { delta?: string; done?: boolean; error?: string };
          if (data.error) throw new Error(data.error);
          if (data.delta) {
            accumulated += data.delta;
            patch({ text: accumulated });
          }
          if (data.done) break;
        }
      }

      if (!accumulated.trim()) {
        patch({ text: "Модель вернула пустой ответ.", error: true });
        return;
      }
      // Если историю очистили прямо во время ответа — контекст уже пуст, не мусорим.
      if (contextRef.current.length > 0) contextRef.current.push({ role: "assistant", content: accumulated });
    } catch (caught) {
      const aborted = controller.signal.aborted;
      if (aborted) {
        if (accumulated.trim() && contextRef.current.length > 0) {
          contextRef.current.push({ role: "assistant", content: accumulated });
        } else if (!accumulated.trim()) {
          patch({ text: "Запрос остановлен.", error: false });
        }
        return;
      }
      const message = caught instanceof Error ? caught.message : "Неизвестная ошибка";
      patch({ text: message, error: true });
      setError(message);
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const clearHistory = () => {
    if (streaming) stop();
    contextRef.current = [];
    setBubbles([]);
    setError(null);
    setNotice(null);
    try {
      window.localStorage.removeItem(AI_STORAGE_HISTORY);
    } catch {
      /* не критично */
    }
  };

  const resetSettings = () => {
    setSettings({ baseUrl: AI_DEFAULT_BASE_URL, apiKey: "", model: "" });
    setModels([]);
    setNotice(null);
    setError(null);
  };

  return (
    <div className="space-y-4">
      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            Подключение к локальному ИИ
            <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-500">Тестовый блок</Badge>
          </span>
        }
        subtitle="OpenAI-совместимый сервер: /v1/chat/completions. Адрес, ключ и модель хранятся только в этом браузере."
        action={
          <Button variant="ghost" size="sm" onClick={() => setSettingsOpen((open) => !open)}>
            <Settings2 size={14} />
            {settingsOpen ? "Свернуть" : "Настроить"}
            <ChevronDown size={14} className={cn("transition-transform", settingsOpen && "rotate-180")} />
          </Button>
        }
      >
        {settingsOpen && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Base URL (baseURL)">
                <Input
                  value={settings.baseUrl}
                  onChange={(event) => updateSettings({ baseUrl: event.target.value })}
                  placeholder={AI_DEFAULT_BASE_URL}
                  spellCheck={false}
                  autoComplete="off"
                />
              </Field>
              <Field label="ApiKey">
                <div className="relative">
                  <Input
                    type={showKey ? "text" : "password"}
                    value={settings.apiKey}
                    onChange={(event) => updateSettings({ apiKey: event.target.value })}
                    placeholder="sk-unsloth-YOUR_KEY"
                    spellCheck={false}
                    autoComplete="off"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((value) => !value)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-muted hover:text-text"
                    title={showKey ? "Скрыть ключ" : "Показать ключ"}
                  >
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </Field>
            </div>
            <Field label="Модель">
              <Input
                value={settings.model}
                onChange={(event) => updateSettings({ model: event.target.value })}
                placeholder="YOUR_MODEL"
                list="ai-model-options"
                spellCheck={false}
                autoComplete="off"
              />
              <datalist id="ai-model-options">
                {models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => void checkConnection()} disabled={checking || streaming}>
                {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Проверить подключение
              </Button>
              <Button variant="ghost" size="sm" onClick={resetSettings} disabled={checking || streaming}>
                <RotateCcw size={14} />
                Сбросить
              </Button>
              {models.length > 0 && (
                <span className="text-[11px] text-muted">Найдено моделей: {models.length}</span>
              )}
            </div>
            {notice && <p className="text-[11px] text-emerald-500">{notice}</p>}
            {error && (
              <p className="flex items-start gap-1.5 rounded-xl border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-[11px] text-red-500">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span className="break-words">{error}</span>
              </p>
            )}
            <p className="rounded-xl border border-border bg-card2/60 px-2.5 py-2 text-[11px] leading-relaxed text-muted">
              Запрос выполняет сервер Nova CRM, поэтому <code className="font-mono">127.0.0.1</code> — это машина,
              где запущен CRM, а не ваш браузер. Ключ уходит на сервер в заголовке{" "}
              <code className="font-mono">x-ai-key</code> и нигде не сохраняется. Если поля пустые, берутся{" "}
              <code className="font-mono">AI_BASE_URL</code>, <code className="font-mono">AI_API_KEY</code> и{" "}
              <code className="font-mono">AI_MODEL</code> из окружения.
            </p>
          </div>
        )}
      </Card>

      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            Чат с ИИ
            <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-500">
              <Sparkles size={11} />
              {settings.model.trim() || "модель не выбрана"}
            </Badge>
          </span>
        }
        subtitle="Тестовый режим: переписка хранится только в этом браузере и в базу не пишется."
        action={
          <Button variant="ghost" size="sm" onClick={clearHistory} disabled={bubbles.length === 0 && !streaming}>
            <Trash2 size={14} />
            Очистить
          </Button>
        }
      >
        <div className="flex h-[480px] flex-col overflow-hidden rounded-xl border border-border bg-card2/30 sm:h-[560px]">
          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-2.5 py-3 sm:px-4">
            {bubbles.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-[#7c5cff] to-[#a78bfa] text-white">
                  <Bot size={20} />
                </span>
                <p className="text-sm font-medium">Спросите что-нибудь у локальной модели</p>
                <p className="max-w-sm text-xs text-muted">
                  Блок тестовый: подключите свой сервер (Unsloth, llama.cpp, vLLM, LM Studio), укажите модель — и
                  задавайте вопросы. Можно приложить картинку или текстовый файл.
                </p>
              </div>
            )}

            {bubbles.map((bubble) => {
              const mine = bubble.role === "user";
              const emptyStreaming = streaming && !mine && !bubble.text;
              return (
                <div key={bubble.id} className={cn("flex items-end gap-2", mine && "flex-row-reverse")}>
                  {mine ? (
                    <Avatar name={userName} color="#7c5cff" url={null} size={26} />
                  ) : (
                    <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-teal-400 text-white">
                      <Bot size={14} />
                    </span>
                  )}
                  <div
                    className={cn(
                      "min-w-0 max-w-[86%] rounded-2xl px-3 py-2 text-sm",
                      mine
                        ? "rounded-br-sm bg-gradient-to-br from-[#7c5cff] to-[#8f6cff] text-white"
                        : bubble.error
                          ? "rounded-bl-sm border border-red-500/40 bg-red-500/10 text-red-500"
                          : "rounded-bl-sm border border-border bg-card",
                    )}
                  >
                    {emptyStreaming ? (
                      <span className="flex items-center gap-1.5 text-xs text-muted">
                        <Loader2 size={12} className="animate-spin" />
                        думает...
                      </span>
                    ) : bubble.error ? (
                      <p className="whitespace-pre-wrap break-words text-xs">{bubble.text}</p>
                    ) : (
                      <RichText text={bubble.text} />
                    )}
                    {bubble.attachments.length > 0 && (
                      <div className={cn("mt-1.5 flex flex-wrap gap-1", bubble.text && "mt-2")}>
                        {bubble.attachments.map((attachment) => (
                          <span
                            key={`${bubble.id}-${attachment.name}`}
                            className={cn(
                              "flex max-w-full items-center gap-1 rounded-lg px-1.5 py-0.5 text-[10px]",
                              mine ? "bg-white/15 text-white" : "bg-card2 text-muted",
                            )}
                            title={`${attachment.mime} · ${formatBytes(attachment.size)}`}
                          >
                            {attachment.kind === "image" ? <ImageIcon size={10} /> : <FileText size={10} />}
                            <span className="truncate">{attachment.name}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    <p className={cn("mt-1 text-right text-[10px]", mine ? "text-white/70" : "text-muted/80")}>
                      {formatTime(new Date(bubble.at))}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
            className="border-t border-border bg-card p-2.5 sm:p-3"
          >
            {pending.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {pending.map((item) => (
                  <span
                    key={item.id}
                    className="flex max-w-full items-center gap-1.5 rounded-xl border border-border bg-card2 px-1.5 py-1 text-[11px]"
                  >
                    {item.preview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.preview} alt={item.file.name} className="h-6 w-6 shrink-0 rounded object-cover" />
                    ) : (
                      <FileText size={12} className="shrink-0 text-muted" />
                    )}
                    <span className="max-w-[9rem] truncate">{item.file.name}</span>
                    <span className="shrink-0 text-[10px] text-muted">{formatBytes(item.file.size)}</span>
                    <button
                      type="button"
                      onClick={() => removePending(item.id)}
                      className="shrink-0 rounded p-0.5 text-muted hover:text-red-500"
                      title="Убрать"
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <label
                className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-border bg-card2 text-muted transition hover:text-text"
                title="Картинка или текстовый файл (до 4 МБ картинка, до 256 КБ текст)"
              >
                <Paperclip size={16} />
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={addFiles}
                  accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,text/*,.md,.csv,.json,.jsonl,.tsv,.log,.yml,.yaml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.sql,.ini,.conf,.toml"
                />
              </label>
              <textarea
                ref={inputRef}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder="Спросите модель... (Enter — отправить, Shift+Enter — перенос)"
                className="max-h-32 min-h-[40px] min-w-0 flex-1 resize-none rounded-xl border border-border bg-card2 px-3 py-2 text-sm outline-none focus:border-accent"
              />
              {streaming ? (
                <Button type="button" variant="secondary" size="icon" onClick={stop} title="Остановить">
                  <Square size={14} />
                </Button>
              ) : (
                <Button type="submit" size="icon" disabled={!text.trim() && pending.length === 0} title="Отправить">
                  <Send size={16} />
                </Button>
              )}
            </div>
          </form>
        </div>
      </Card>
    </div>
  );
}
