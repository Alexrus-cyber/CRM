"use client";

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  Bot,
  Brain,
  Check,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Avatar, Badge, Button, Card, Field, Input } from "./ui";
import { Combobox } from "./Combobox";
import { cn, formatTime } from "@/lib/utils";
import {
  AI_DEFAULT_BASE_URL,
  AI_DEFAULT_PARAMS,
  AI_MAX_FILES,
  AI_MAX_IMAGE_BYTES,
  AI_MAX_TEXT_BYTES,
  AI_REASONING_MODES,
  AI_STORAGE_HISTORY,
  AI_STORAGE_PARAMS,
  AI_STORAGE_SETTINGS,
  formatBytes,
  isImageMime,
  isTextFile,
  normalizeParams,
  type AiParams,
  type AiSettings,
  type ReasoningMode,
} from "@/lib/ai";
import {
  RAG_MAX_FILE_BYTES,
  RAG_MAX_FILES,
  RAG_MAX_TOTAL_CHARS,
  buildRagIndex,
  formatRagContext,
  isIndexableFile,
  searchRag,
  snippet,
  type RagHit,
  type RagIndex,
} from "@/lib/rag";

type AttKind = "image" | "text";

type AttachmentMeta = { name: string; mime: string; size: number; kind: AttKind };

type Bubble = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** «Размышления» модели, если сервер их отдаёт. */
  reasoning: string;
  attachments: AttachmentMeta[];
  at: number;
  error?: boolean;
  /** Сколько фрагментов RAG подмешали к этому вопросу. */
  ragHits?: number;
};

type PendingFile = { id: string; file: File; preview: string | null };

type OutgoingMessage = { role: "user" | "assistant"; content: unknown };

type RagState = {
  index: RagIndex | null;
  folder: string;
  building: boolean;
  progress: { done: number; total: number };
  skipped: number;
  error: string | null;
};

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

function readParams(): AiParams {
  if (typeof window === "undefined") return AI_DEFAULT_PARAMS;
  try {
    const raw = window.localStorage.getItem(AI_STORAGE_PARAMS);
    if (!raw) return AI_DEFAULT_PARAMS;
    return normalizeParams(JSON.parse(raw));
  } catch {
    return AI_DEFAULT_PARAMS;
  }
}

function readHistory(): Bubble[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(AI_STORAGE_HISTORY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Bubble[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.text === "string" && (item.role === "user" || item.role === "assistant"))
      .map((item) => ({ ...item, reasoning: item.reasoning ?? "", attachments: item.attachments ?? [] }));
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

function Section({
  title,
  subtitle,
  icon,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card
      title={
        <span className="flex items-center gap-1.5">
          {icon}
          {title}
        </span>
      }
      subtitle={subtitle}
      action={action}
    >
      {children}
    </Card>
  );
}

export function AiChatClient({ userName }: { userName: string }) {
  const [settings, setSettings] = useState<AiSettings>(readSettings);
  const [params, setParams] = useState<AiParams>(readParams);
  const [showKey, setShowKey] = useState(false);
  const [bubbles, setBubbles] = useState<Bubble[]>(readHistory);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [rag, setRag] = useState<RagState>({
    index: null,
    folder: "",
    building: false,
    progress: { done: 0, total: 0 },
    skipped: 0,
    error: null,
  });
  const [ragQuery, setRagQuery] = useState("");
  const [ragHits, setRagHits] = useState<RagHit[] | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const contextRef = useRef<OutgoingMessage[]>([]);
  const previewsRef = useRef<string[]>([]);

  const updateSettings = (patch: Partial<AiSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    setNotice(null);
  };

  const updateParams = (patch: Partial<AiParams>) => {
    setParams((prev) => ({ ...prev, ...patch }));
    setNotice(null);
  };

  useEffect(() => {
    try {
      window.localStorage.setItem(AI_STORAGE_SETTINGS, JSON.stringify(settings));
    } catch {
      /* приватный режим — просто не сохраняем */
    }
  }, [settings]);

  useEffect(() => {
    try {
      window.localStorage.setItem(AI_STORAGE_PARAMS, JSON.stringify(params));
    } catch {
      /* не критично */
    }
  }, [params]);

  useEffect(() => {
    try {
      const compact = bubbles.slice(-HISTORY_LIMIT);
      window.localStorage.setItem(AI_STORAGE_HISTORY, JSON.stringify(compact));
    } catch {
      /* переполнение хранилища — не критично */
    }
  }, [bubbles]);

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [bubbles]);

  /* ------------------------------ вложения ------------------------------ */

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
      next.push({ id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`, file, preview });
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

  useEffect(() => () => {
    for (const url of previewsRef.current) URL.revokeObjectURL(url);
    previewsRef.current = [];
  }, []);

  /* --------------------------- RAG: папка и поиск ------------------------ */

  const chooseFolder = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;

    const folder = files[0].webkitRelativePath?.split("/")[0] || files[0].name;
    setRagHits(null);
    setRag({ index: null, folder, building: true, progress: { done: 0, total: files.length }, skipped: 0, error: null });

    const entries: Array<{ path: string; text: string }> = [];
    let skipped = 0;
    let chars = 0;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const path = file.webkitRelativePath || file.name;
      const fits =
        entries.length < RAG_MAX_FILES &&
        isIndexableFile(file.name, file.type, file.size) &&
        chars < RAG_MAX_TOTAL_CHARS;
      if (!fits) {
        skipped += 1;
        continue;
      }
      try {
        const content = await file.text();
        entries.push({ path, text: content.slice(0, RAG_MAX_FILE_BYTES) });
        chars += content.length;
      } catch {
        skipped += 1;
      }
      if (index % 10 === 0) {
        setRag((prev) => ({ ...prev, progress: { done: index + 1, total: files.length } }));
      }
    }

    try {
      const index = buildRagIndex(entries);
      setRag({ index, folder, building: false, progress: { done: files.length, total: files.length }, skipped, error: null });
      setNotice(
        entries.length === 0
          ? "В папке нет текстовых файлов, которые можно проиндексировать (pdf, docx и картинки пропускаются)."
          : null,
      );
    } catch {
      setRag((prev) => ({ ...prev, building: false, error: "Не удалось построить индекс — попробуйте папку поменьше." }));
    }
  };

  const clearRag = () => {
    setRag({ index: null, folder: "", building: false, progress: { done: 0, total: 0 }, skipped: 0, error: null });
    setRagHits(null);
    setRagQuery("");
  };

  const testRag = () => {
    if (!rag.index || !ragQuery.trim()) return;
    setRagHits(searchRag(rag.index, ragQuery, 3));
  };

  /* ------------------------------ подключение ---------------------------- */

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

  /* --------------------------------- чат -------------------------------- */

  const send = async () => {
    const question = text.trim();
    if (streaming) return;
    if (!question && pending.length === 0) return;
    if (!settings.model.trim()) {
      setError("Укажите модель — например, через «Проверить подключение» или вручную.");
      return;
    }
    setError(null);
    setNotice(null);

    const parts: Array<Record<string, unknown>> = [];
    const metas: AttachmentMeta[] = [];
    let attachmentsText = "";
    for (const item of pending) {
      if (isImageMime(item.file.type)) {
        const dataUrl = await fileToDataUrl(item.file);
        parts.push({ type: "image_url", image_url: { url: dataUrl } });
        metas.push({ name: item.file.name, mime: item.file.type, size: item.file.size, kind: "image" });
      } else {
        const content = await item.file.text();
        attachmentsText += `\n\n${content}`;
        parts.push({ type: "text", text: `Файл «${item.file.name}»:\n\n${content}` });
        metas.push({ name: item.file.name, mime: item.file.type || "text/plain", size: item.file.size, kind: "text" });
      }
    }
    if (question) parts.unshift({ type: "text", text: question });

    // RAG: ищем фрагменты по вопросу (и по приложенным текстам).
    let ragContext = "";
    let usedChunks = 0;
    if (rag.index && params.ragChunks > 0) {
      const query = `${question}${attachmentsText}`.trim();
      if (query) {
        const hits = searchRag(rag.index, query, params.ragChunks);
        if (hits.length > 0) {
          ragContext = formatRagContext(hits, 6000);
          usedChunks = hits.length;
        }
      }
    }

    if (contextRef.current.length === 0 && bubbles.length > 0) {
      contextRef.current = bubbles.map((bubble) => ({ role: bubble.role, content: bubble.text }));
    }
    const outgoing = question && parts.length === 1 && parts[0].type === "text" ? question : parts;
    contextRef.current.push({ role: "user", content: outgoing });

    const now = Date.now();
    const replyId = `a-${now}`;
    setBubbles((prev) => [
      ...prev,
      { id: `u-${now}`, role: "user", text: question, reasoning: "", attachments: metas, at: now, ragHits: usedChunks },
      { id: replyId, role: "assistant", text: "", reasoning: "", attachments: [], at: now, ragHits: usedChunks },
    ]);
    setText("");
    clearPending();
    if (inputRef.current) inputRef.current.focus();
    await runCompletion(replyId, ragContext);
  };

  const runCompletion = async (replyId: string, ragContext: string) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    let accumulated = "";
    let thinking = "";

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
        body: JSON.stringify({ messages: contextRef.current, params, ragContext }),
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
          const data = JSON.parse(payload) as { delta?: string; reasoning?: string; done?: boolean; error?: string };
          if (data.error) throw new Error(data.error);
          if (data.reasoning) {
            thinking += data.reasoning;
            patch({ reasoning: thinking });
          }
          if (data.delta) {
            accumulated += data.delta;
            patch({ text: accumulated, reasoning: thinking });
          }
          if (data.done) break;
        }
      }

      if (!accumulated.trim()) {
        patch({ text: "Модель вернула пустой ответ.", error: true });
        return;
      }
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

  const stop = () => abortRef.current?.abort();

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

  const resetParams = () => {
    setParams(AI_DEFAULT_PARAMS);
    setNotice("Параметры сброшены к значениям по умолчанию.");
  };

  const resetConnection = () => {
    setSettings({ baseUrl: AI_DEFAULT_BASE_URL, apiKey: "", model: "" });
    setModels([]);
    setError(null);
    setNotice(null);
  };

  const exportTranscript = () => {
    const lines = bubbles.map((bubble) => {
      const who = bubble.role === "user" ? userName : "ИИ";
      const files = bubble.attachments.length
        ? `\nВложения: ${bubble.attachments.map((attachment) => attachment.name).join(", ")}`
        : "";
      const reasoning = bubble.reasoning.trim() ? `\n<details><summary>Размышления</summary>\n\n${bubble.reasoning}\n\n</details>` : "";
      return `### ${who} · ${new Date(bubble.at).toLocaleString("ru-RU")}${files}\n\n${bubble.text}${reasoning}`;
    });
    const header = `# Стенограмма чата с ИИ\n\nМодель: ${settings.model || "—"}\nМодель сервера: ${settings.baseUrl}\nПараметры: ${JSON.stringify({ ...params, system: params.system ? "…" : "" })}\n\n`;
    const blob = new Blob([header + lines.join("\n\n---\n\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ai-chat-${new Date().toISOString().slice(0, 10)}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const reasoningMode = AI_REASONING_MODES.find((mode) => mode.value === params.reasoning);
  const ragStats = rag.index
    ? `${rag.index.files.length} файлов · ${rag.index.chunks.length} фрагментов · ${formatBytes(rag.index.chars)}`
    : rag.building
      ? `Индексируем ${rag.progress.done}/${rag.progress.total}...`
      : "Папка не выбрана";

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      {/* ----------------------------- параметры ----------------------------- */}
      <div className="order-2 min-w-0 space-y-3 xl:order-1">
        <Section
          title="Подключение"
          icon={<Sparkles size={14} className="text-accent2" />}
          action={
            <Button variant="ghost" size="sm" onClick={() => setSettingsOpen((open) => !open)}>
              <Settings2 size={13} />
              <ChevronDown size={13} className={cn("transition-transform", settingsOpen && "rotate-180")} />
            </Button>
          }
        >
          {settingsOpen && (
            <div className="space-y-3">
              <Field label="Base URL">
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
              <Field label="Модель">
                <div className="flex gap-2">
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
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void checkConnection()}
                    disabled={checking || streaming}
                    title="Проверить подключение и получить список моделей"
                  >
                    {checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  </Button>
                </div>
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-muted">
                  {models.length > 0 ? `Моделей на сервере: ${models.length}` : "Модели подтянутся по кнопке проверки"}
                </span>
                <Button variant="ghost" size="sm" className="ml-auto" onClick={resetConnection} disabled={checking || streaming}>
                  <RotateCcw size={13} />
                  Сбросить
                </Button>
              </div>
            </div>
          )}
        </Section>

        <Section
          title="Раздумья модели"
          subtitle="Если сервер не понимает эти параметры — выберите «По умолчанию»."
          icon={<Brain size={14} className="text-accent2" />}
        >
          <div className="space-y-3">
            <Combobox
              aria-label="Тип раздумий"
              value={params.reasoning}
              onChange={(next) => updateParams({ reasoning: next as ReasoningMode })}
              placeholder="По умолчанию"
              options={AI_REASONING_MODES.map((mode) => ({ value: mode.value, label: mode.label, hint: mode.hint }))}
            />
            {reasoningMode && <p className="text-[11px] text-muted">{reasoningMode.hint}</p>}
            {params.reasoning === "budget" && (
              <Field label="Бюджет раздумий, токенов">
                <Input
                  type="number"
                  min={64}
                  step={64}
                  value={params.thinkingBudget ?? ""}
                  onChange={(event) =>
                    updateParams({ thinkingBudget: event.target.value === "" ? null : Number(event.target.value) })
                  }
                  placeholder="Например, 2048"
                />
              </Field>
            )}
            <label className="flex items-start gap-2 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={params.sendThinkingFlag}
                onChange={(event) => updateParams({ sendThinkingFlag: event.target.checked })}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[#7c5cff]"
              />
              <span>
                Дублировать в <code className="font-mono">chat_template_kwargs.enable_thinking</code> — нужно
                Qwen3/Unsloth, некоторым сборкам это поле мешает (тогда снимите галочку).
              </span>
            </label>
          </div>
        </Section>

        <Section
          title="Генерация"
          subtitle="Пустое поле = параметр не отправляется, решает сервер."
          action={
            <Button variant="ghost" size="sm" onClick={() => setAdvancedOpen((open) => !open)}>
              <ChevronDown size={13} className={cn("transition-transform", advancedOpen && "rotate-180")} />
            </Button>
          }
        >
          <div className="space-y-3">
            <Field label="Системный промпт">
              <textarea
                value={params.system}
                onChange={(event) => updateParams({ system: event.target.value })}
                rows={3}
                className="w-full min-w-0 resize-y rounded-xl border border-border bg-card2 px-3 py-2 text-xs text-text outline-none focus:border-accent focus:ring-2 focus:ring-[var(--ring)]"
                placeholder="Ты — ассистент внутри CRM..."
              />
            </Field>
            {advancedOpen && (
              <div className="grid grid-cols-2 gap-2">
                <Field label="temperature">
                  <Input
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={params.temperature ?? ""}
                    onChange={(event) => updateParams({ temperature: event.target.value === "" ? null : Number(event.target.value) })}
                    className="h-9 text-xs"
                    placeholder="—"
                  />
                </Field>
                <Field label="top_p">
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={params.topP ?? ""}
                    onChange={(event) => updateParams({ topP: event.target.value === "" ? null : Number(event.target.value) })}
                    className="h-9 text-xs"
                    placeholder="—"
                  />
                </Field>
                <Field label="max_tokens">
                  <Input
                    type="number"
                    min={1}
                    step={64}
                    value={params.maxTokens ?? ""}
                    onChange={(event) => updateParams({ maxTokens: event.target.value === "" ? null : Number(event.target.value) })}
                    className="h-9 text-xs"
                    placeholder="—"
                  />
                </Field>
                <Field label="seed">
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={params.seed ?? ""}
                    onChange={(event) => updateParams({ seed: event.target.value === "" ? null : Number(event.target.value) })}
                    className="h-9 text-xs"
                    placeholder="—"
                  />
                </Field>
                <Field label="Фрагментов RAG" className="col-span-2">
                  <Input
                    type="number"
                    min={0}
                    max={20}
                    step={1}
                    value={params.ragChunks}
                    onChange={(event) => updateParams({ ragChunks: Number(event.target.value) })}
                    className="h-9 text-xs"
                  />
                </Field>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAdvancedOpen((open) => !open)}>
                {advancedOpen ? "Скрыть параметры" : "Ещё параметры"}
              </Button>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={resetParams}>
                <RotateCcw size={13} />
                Сбросить всё
              </Button>
            </div>
          </div>
        </Section>

        <Section
          title="RAG окружение"
          subtitle="Папка с файлами: модель получает только найденные фрагменты."
          icon={<FolderOpen size={14} className="text-accent2" />}
          action={
            <Badge className={cn("border-border", rag.index ? "bg-emerald-500/10 text-emerald-500" : "text-muted")}>
              {rag.index ? `${rag.index.chunks.length} фрагм.` : "нет"}
            </Badge>
          }
        >
          <div className="space-y-3">
            <input
              ref={dirRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => void chooseFolder(event)}
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => dirRef.current?.click()} disabled={rag.building || streaming}>
                {rag.building ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />}
                {rag.index ? "Другая папка" : "Выбрать папку"}
              </Button>
              {rag.index && (
                <Button variant="ghost" size="sm" onClick={clearRag} disabled={rag.building || streaming}>
                  <X size={13} />
                  Убрать
                </Button>
              )}
            </div>
            <div className="rounded-xl border border-border bg-card2/60 px-2.5 py-2 text-[11px] text-muted">
              <p className="break-words">
                {rag.index ? <b className="text-text">{rag.folder}</b> : rag.folder || "Папка не выбрана"}
              </p>
              <p className="mt-0.5">{ragStats}</p>
              {rag.skipped > 0 && <p className="mt-0.5">Пропущено нетекстовых/больших файлов: {rag.skipped}</p>}
              {rag.error && <p className="mt-1 text-red-500">{rag.error}</p>}
            </div>
            {rag.index && (
              <>
                <div className="flex gap-2">
                  <Input
                    value={ragQuery}
                    onChange={(event) => setRagQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        testRag();
                      }
                    }}
                    placeholder="Проверить поиск по папке..."
                    className="h-9 text-xs"
                  />
                  <Button variant="secondary" size="sm" className="shrink-0" onClick={testRag} disabled={!ragQuery.trim()}>
                    <Search size={13} />
                  </Button>
                </div>
                {ragHits && (
                  <div className="max-h-56 space-y-1.5 overflow-y-auto">
                    {ragHits.length === 0 && <p className="text-[11px] text-muted">Совпадений не найдено.</p>}
                    {ragHits.map((hit, index) => (
                      <div key={`${hit.path}-${index}`} className="rounded-lg border border-border bg-card2/60 px-2 py-1.5">
                        <p className="flex items-center justify-between gap-2 text-[10px] text-muted">
                          <span className="truncate">{hit.path}</span>
                          <span className="shrink-0">{hit.score.toFixed(2)}</span>
                        </p>
                        <p className="mt-0.5 text-[11px] text-text/90">{snippet(hit.text, ragQuery)}</p>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-muted">
                  В контекст уходит до {params.ragChunks} фрагментов по ~900 символов. Индекс живёт в памяти
                  вкладки: перезагрузка страницы его сбросит.
                </p>
              </>
            )}
            {!rag.index && !rag.building && (
              <p className="text-[11px] text-muted">
                Выберите папку с документацией или кодом — браузер прочитает текстовые файлы локально, ничего
                не загружая на сервер. PDF, docx и картинки пропускаются.
              </p>
            )}
          </div>
        </Section>

        {error && (
          <p className="flex items-start gap-1.5 rounded-xl border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-[11px] text-red-500">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </p>
        )}
        {notice && <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-[11px] text-emerald-500">{notice}</p>}
      </div>

      {/* -------------------------------- чат -------------------------------- */}
      <div className="order-1 min-w-0 xl:order-2">
        <Card
          className="h-full"
          title={
            <span className="flex flex-wrap items-center gap-2">
              {settings.model.trim() || "Модель не выбрана"}
              <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-500">Harness</Badge>
              {rag.index && <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-500">RAG</Badge>}
            </span>
          }
          subtitle="Переписка хранится только в этом браузере; в базу ничего не пишется."
          action={
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={exportTranscript} disabled={bubbles.length === 0} title="Скачать стенограмму">
                <Download size={13} />
              </Button>
              <Button variant="ghost" size="sm" onClick={clearHistory} disabled={bubbles.length === 0 && !streaming} title="Очистить переписку">
                <Trash2 size={13} />
              </Button>
            </div>
          }
        >
          <div className="flex h-[520px] flex-col overflow-hidden rounded-xl border border-border bg-card2/30 sm:h-[620px]">
            <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-2.5 py-3 sm:px-4">
              {bubbles.length === 0 && (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                  <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-[#7c5cff] to-[#a78bfa] text-white">
                    <Bot size={20} />
                  </span>
                  <p className="text-sm font-medium">Harness готов к работе</p>
                  <p className="max-w-md text-xs text-muted">
                    Выберите модель, при желании папку с файлами (RAG) и тип раздумий. Спросите что-нибудь или
                    приложите картинку/текстовый файл.
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
                      {!mine && bubble.reasoning.trim() && (
                        <details className="mb-2 rounded-lg border border-border/70 bg-card2/60 px-2 py-1.5 text-[11px] text-muted">
                          <summary className="cursor-pointer select-none text-[11px] font-medium">
                            Размышления · {bubble.reasoning.length} симв.
                            {emptyStreaming && <span className="ml-1 inline-block animate-pulse">…</span>}
                          </summary>
                          <p className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap break-words">{bubble.reasoning}</p>
                        </details>
                      )}
                      {emptyStreaming ? (
                        <span className="flex items-center gap-1.5 text-xs text-muted">
                          <Loader2 size={12} className="animate-spin" />
                          {bubble.reasoning ? "думает..." : "генерирует..."}
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
                      <p className={cn("mt-1 flex items-center justify-end gap-1.5 text-[10px]", mine ? "text-white/70" : "text-muted/80")}>
                        {!mine && (bubble.ragHits ?? 0) > 0 && (
                          <span className="flex items-center gap-0.5" title="Фрагментов RAG в контексте">
                            <FolderOpen size={10} />
                            {bubble.ragHits}
                          </span>
                        )}
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
                  title={`Картинка (до ${formatBytes(AI_MAX_IMAGE_BYTES)}) или текстовый файл (до ${formatBytes(AI_MAX_TEXT_BYTES)})`}
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
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted">
                <span className="flex items-center gap-1">
                  <Brain size={10} />
                  {reasoningMode?.label ?? "По умолчанию"}
                </span>
                <span className="flex items-center gap-1">
                  <FolderOpen size={10} />
                  {rag.index ? `${rag.index.files.length} файлов · до ${params.ragChunks} фрагм.` : "без RAG"}
                </span>
                {params.temperature !== null && <span>t={params.temperature}</span>}
                {params.maxTokens !== null && <span>max={params.maxTokens}</span>}
                {params.seed !== null && <span>seed={params.seed}</span>}
                <span className="ml-auto flex items-center gap-1">
                  <Check size={10} />
                  {settings.baseUrl.replace(/^https?:\/\//, "")}
                </span>
              </div>
            </form>
          </div>
        </Card>
      </div>
    </div>
  );
}
