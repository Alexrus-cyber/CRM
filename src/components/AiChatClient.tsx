"use client";

import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  Bot,
  Brain,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Gauge,
  History,
  Image as ImageIcon,
  Loader2,
  MessageSquarePlus,
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
import { cn, formatTime, ROLE_LABELS } from "@/lib/utils";
import {
  AI_DEFAULT_BASE_URL,
  AI_DEFAULT_PARAMS,
  AI_MAX_FILE_BYTES,
  AI_MAX_FILES,
  AI_MAX_GENERATION_TOKENS,
  AI_REASONING_MODES,
  AI_STORAGE_PARAMS,
  AI_STORAGE_SETTINGS,
  estimateMessagesTokens,
  estimateTokens,
  formatBytes,
  normalizeParams,
  type AiParams,
  type AiSettings,
  type ReasoningMode,
} from "@/lib/ai";
import { LiveReasoningBox } from "./LiveReasoningBox";
import { extractClipboardFiles, hasTransferFiles } from "@/lib/clipboardFiles";
import { extractFile, imageToDataUrl } from "@/lib/fileExtract";
import { RAG_CHARS_PER_TOKEN, snippet, splitIntoChunks } from "@/lib/rag";
import { formatTokenCount, type AiRolePolicy } from "@/lib/aiPolicy";
import { useStoredJson, useStoredNumber } from "@/lib/useStoredValue";
import type { Role } from "@/db/schema";

/* --------------------------------- типы --------------------------------- */

type AttKind = "image" | "text" | "unreadable";

type AttachmentMeta = { name: string; mime: string; size: number; kind: AttKind; note?: string };

type Usage = { prompt: number; completion: number; total: number; estimated: boolean };

type Bubble = {
  id: string;
  role: "user" | "assistant";
  text: string;
  reasoning: string;
  attachments: AttachmentMeta[];
  at: number;
  error?: boolean;
  ragHits?: number;
  /** Режим «вся база»: сколько фрагментов вошло и сколько всего было. */
  ragFull?: RagFullStats | null;
  usage?: Usage;
};

type PendingFile = {
  id: string;
  file: File;
  kind: AttKind;
  text: string;
  note: string;
  truncated: boolean;
  preview: string | null;
};

type OutgoingMessage = { role: "user" | "assistant"; content: unknown };

type RagFolder = {
  id: number;
  name: string;
  filesCount: number;
  chunksCount: number;
  chars: number;
  updatedAt: string;
};

type RagHit = { path: string; text: string; score: number };

type RagFullStats = {
  used: number;
  total: number;
  chars: number;
  truncated: boolean;
  budgetChars: number;
  contextLimit: number;
};

type ChatInfo = {
  id: number;
  title: string;
  tokensTotal: number;
  tokensPrompt: number;
  tokensCompletion: number;
  tokensLeft: number;
  tokensLimit: number;
  messagesCount: number;
  createdAt: string;
  updatedAt: string;
};

type UsageInfo = {
  role: Role;
  policy: AiRolePolicy;
  totals: { prompt: number; completion: number; total: number; events: number };
  monthly: { used: number; limit: number | null; left: number | null };
  chats: { count: number };
};

const STORAGE_RAG = "crm.ai.rag.v1";
const STORAGE_CHAT = "crm.ai.chat.v1";

/* ------------------------------- хранилище ------------------------------ */

const DEFAULT_SETTINGS: AiSettings = { baseUrl: AI_DEFAULT_BASE_URL, apiKey: "", model: "" };

/** Разбор сохранённых настроек — вызывается уже после гидратации. */
function decodeSettings(raw: string): AiSettings {
  const parsed = JSON.parse(raw) as Partial<AiSettings>;
  return {
    baseUrl: parsed.baseUrl?.trim() || DEFAULT_SETTINGS.baseUrl,
    apiKey: parsed.apiKey ?? "",
    model: parsed.model ?? "",
  };
}

function decodeParams(raw: string): AiParams {
  return normalizeParams(JSON.parse(raw));
}

function parseAttachments(raw: string): AttachmentMeta[] {
  try {
    const parsed = JSON.parse(raw) as AttachmentMeta[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item.name === "string").slice(0, 8);
  } catch {
    return [];
  }
}

/** Время сообщения: вынесено из рендера, чтобы не звать Date.now() напрямую. */
function nowMs(): number {
  return Date.now();
}

function readNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const value = Number(window.localStorage.getItem(key) ?? "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/* ------------------------------- разметка ------------------------------- */

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

const ATTACHMENT_ICON: Record<AttKind, ReactNode> = {
  image: <ImageIcon size={10} />,
  text: <FileText size={10} />,
  unreadable: <AlertTriangle size={10} />,
};

export function AiChatClient({ userName }: { userName: string }) {
  const [settings, setSettings] = useStoredJson<AiSettings>(
    AI_STORAGE_SETTINGS,
    DEFAULT_SETTINGS,
    decodeSettings,
  );
  const [params, setParams] = useStoredJson<AiParams>(AI_STORAGE_PARAMS, AI_DEFAULT_PARAMS, decodeParams);
  const [showKey, setShowKey] = useState(false);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [chat, setChat] = useState<ChatInfo | null>(null);
  const [chats, setChats] = useState<ChatInfo[]>([]);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [contextTokens, setContextTokens] = useState(0);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [extracting, setExtracting] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [folders, setFolders] = useState<RagFolder[]>([]);
  const [folderId, setFolderId] = useStoredNumber(STORAGE_RAG, 0);
  const [ragBusy, setRagBusy] = useState(false);
  const [ragProgress, setRagProgress] = useState<{ done: number; total: number; phase: "read" | "upload" } | null>(null);
  const [ragQuery, setRagQuery] = useState("");
  const [ragHits, setRagHits] = useState<RagHit[] | null>(null);
  const [ragError, setRagError] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);
  const autoScrollPausedRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const contextRef = useRef<OutgoingMessage[]>([]);
  const previewsRef = useRef<string[]>([]);

  const activeFolder = folders.find((folder) => folder.id === folderId) ?? null;

  const updateSettings = (patch: Partial<AiSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    setNotice(null);
  };

  const updateParams = (patch: Partial<AiParams>) => {
    setParams((prev) => ({ ...prev, ...patch }));
    setNotice(null);
  };

  /* ----------------------------- сохранение ----------------------------- */

  useEffect(() => {
    const node = listRef.current;
    if (!node || autoScrollPausedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [bubbles]);

  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(() => {
      const node = listRef.current;
      if (node && !autoScrollPausedRef.current) {
        node.scrollTop = node.scrollHeight;
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [streaming]);

  useEffect(() => () => {
    for (const url of previewsRef.current) URL.revokeObjectURL(url);
    previewsRef.current = [];
  }, []);

  /** Очистка выбранных файлов — нужна и при смене чата, поэтому объявлена выше. */
  const clearPending = () => {
    for (const url of previewsRef.current) URL.revokeObjectURL(url);
    previewsRef.current = [];
    setPending([]);
  };

  /* ------------------------ чаты и токены аккаунта ---------------------- */

  const applyUsage = (data: UsageInfo | null) => {
    if (!data) return;
    setUsage(data);
    // Роль могла не разрешать выбранный режим раздумий — приводим к допустимому.
    setParams((prev) =>
      data.policy.reasoning.includes(prev.reasoning)
        ? prev
        : { ...prev, reasoning: data.policy.reasoning.includes("low") ? "low" : data.policy.reasoning[0] },
    );
    if (!data.policy.rag) setFolderId(0);
  };

  const reloadUsage = async () => {
    try {
      const res = await fetch("/api/ai/usage", { cache: "no-store" });
      if (!res.ok) return null;
      const data = (await res.json()) as UsageInfo;
      applyUsage(data);
      return data;
    } catch {
      return null;
    }
  };

  const reloadChats = async (): Promise<ChatInfo[]> => {
    try {
      const res = await fetch("/api/ai/chats", { cache: "no-store" });
      if (!res.ok) return [];
      const data = (await res.json()) as { chats?: ChatInfo[] };
      const list = data.chats ?? [];
      setChats(list);
      return list;
    } catch {
      return [];
    }
  };

  const openChat = async (id: number) => {
    setHistoryBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ai/chats/${id}`, { cache: "no-store" });
      if (!res.ok) {
        setError("Чат не найден — возможно, он удалён");
        return;
      }
      const data = (await res.json()) as {
        chat: ChatInfo;
        messages: Array<{
          id: number;
          role: "user" | "assistant";
          content: string;
          reasoning: string;
          attachments: string;
          promptTokens: number;
          completionTokens: number;
          createdAt: string;
        }>;
      };
      const restored: Bubble[] = data.messages.map((message) => ({
        id: `m-${message.id}`,
        role: message.role,
        text: message.content,
        reasoning: message.reasoning,
        attachments: parseAttachments(message.attachments),
        at: new Date(message.createdAt).getTime(),
        usage:
          message.role === "assistant" && (message.promptTokens || message.completionTokens)
            ? {
                prompt: message.promptTokens,
                completion: message.completionTokens,
                total: message.promptTokens + message.completionTokens,
                estimated: false,
              }
            : undefined,
      }));
      setChat(data.chat);
      setBubbles(restored);
      contextRef.current = restored
        .filter((bubble) => bubble.text.trim())
        .map((bubble) => ({ role: bubble.role, content: bubble.text }));
      const lastUsage = [...restored].reverse().find((bubble) => bubble.usage)?.usage;
      setContextTokens(lastUsage?.total ?? 0);
      setText("");
      clearPending();
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(STORAGE_CHAT, String(id));
        } catch {
          /* не критично */
        }
      }
    } catch {
      setError("Не удалось загрузить чат");
    } finally {
      setHistoryBusy(false);
    }
  };

  const createChat = async (): Promise<ChatInfo | null> => {
    setHistoryBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Не удалось создать чат");
        return null;
      }
      const data = (await res.json()) as { chat: ChatInfo };
      setChat(data.chat);
      setChats((prev) => [data.chat, ...prev.filter((item) => item.id !== data.chat.id)]);
      setBubbles([]);
      contextRef.current = [];
      setContextTokens(0);
      setText("");
      clearPending();
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(STORAGE_CHAT, String(data.chat.id));
        } catch {
          /* не критично */
        }
      }
      return data.chat;
    } catch {
      setError("Не удалось создать чат");
      return null;
    } finally {
      setHistoryBusy(false);
    }
  };

  const removeChat = async (id: number) => {
    setError(null);
    try {
      const res = await fetch(`/api/ai/chats?id=${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Не удалось удалить чат");
        return;
      }
      const remaining = chats.filter((item) => item.id !== id);
      setChats(remaining);
      if (chat?.id === id) {
        setChat(null);
        setBubbles([]);
        contextRef.current = [];
        setContextTokens(0);
        if (remaining.length > 0) await openChat(remaining[0].id);
        else await createChat();
      }
      void reloadUsage();
    } catch {
      setError("Не удалось удалить чат");
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [usageRes, chatsRes] = await Promise.all([
        fetch("/api/ai/usage", { cache: "no-store" }).catch(() => null),
        fetch("/api/ai/chats", { cache: "no-store" }).catch(() => null),
      ]);
      if (cancelled) return;
      if (usageRes?.ok) {
        const data = (await usageRes.json()) as UsageInfo;
        if (!cancelled) applyUsage(data);
      }
      if (chatsRes?.ok) {
        const data = (await chatsRes.json()) as { chats?: ChatInfo[] };
        const list = data.chats ?? [];
        if (cancelled) return;
        setChats(list);
        const remembered = readNumber(STORAGE_CHAT, 0);
        const target = list.find((item) => item.id === remembered) ?? list[0];
        if (target) void openChat(target.id);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------- RAG: список папок -------------------------- */

  const reloadFolders = async (): Promise<RagFolder[]> => {
    try {
      const res = await fetch("/api/ai/rag", { cache: "no-store" });
      if (!res.ok) return [];
      const data = (await res.json()) as { folders?: RagFolder[] };
      const list = data.folders ?? [];
      setFolders(list);
      return list;
    } catch {
      setRagError("Не удалось получить список папок");
      return [];
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/ai/rag", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { folders?: RagFolder[] };
        if (!cancelled) setFolders(data.folders ?? []);
      } catch {
        /* сеть недоступна — блок работает без RAG */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const uploadFolder = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0 || ragBusy) return;

    setRagError(null);
    setNotice(null);
    setRagBusy(true);
    setRagProgress({ done: 0, total: files.length, phase: "read" });
    const folderName = (files[0].webkitRelativePath?.split("/")[0] || "Папка").slice(0, 100);

    try {
      const items: Array<{ path: string; chunks: string[] }> = [];
      let skipped = 0;

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const path = (file.webkitRelativePath || file.name).slice(0, 300);
        if (file.size > AI_MAX_FILE_BYTES) {
          skipped += 1;
        } else {
          const extracted = await extractFile(file);
          if (extracted.kind === "text" && extracted.text.trim()) {
            items.push({ path, chunks: splitIntoChunks(extracted.text) });
          } else {
            skipped += 1;
          }
        }
        if (index % 5 === 0) setRagProgress({ done: index + 1, total: files.length, phase: "read" });
      }

      if (items.length === 0) {
        setRagError("В папке не нашлось текста для индексации: нужны текстовые файлы, docx/xlsx/pptx/pdf/rtf или картинки с распознаваемым текстом.");
        return;
      }

      const createdRes = await fetch("/api/ai/rag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `${folderName}${skipped > 0 ? ` (+${skipped} пропущено)` : ""}` }),
      });
      if (!createdRes.ok) {
        const data = (await createdRes.json().catch(() => ({}))) as { error?: string };
        setRagError(data.error ?? "Не удалось создать папку");
        return;
      }
      const created = (await createdRes.json()) as { folder: RagFolder };
      const newId = created.folder.id;
      setFolderId(newId);
      setFolders((prev) => [created.folder, ...prev]);

      // Грузим порциями: 3 млн символов и не больше 150 файлов за запрос.
      let batch: Array<{ path: string; chunks: string[] }> = [];
      let batchChars = 0;
      let uploaded = 0;
      const flush = async () => {
        if (batch.length === 0) return;
        const res = await fetch("/api/ai/rag/chunks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folderId: newId, items: batch }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? "Не удалось загрузить часть файлов");
        }
        const data = (await res.json()) as { folder?: RagFolder };
        if (data.folder) {
          const updated = data.folder;
          setFolders((prev) => prev.map((folder) => (folder.id === updated.id ? updated : folder)));
        }
        batch = [];
        batchChars = 0;
      };

      for (const item of items) {
        const chars = item.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        if (batch.length >= 150 || batchChars + chars > 3_000_000) await flush();
        batch.push(item);
        batchChars += chars;
        uploaded += 1;
        setRagProgress({ done: uploaded, total: items.length, phase: "upload" });
      }
      await flush();

      const list = await reloadFolders();
      const saved = list.find((folder) => folder.id === newId);
      setNotice(
        `Папка «${folderName}» проиндексирована: ${saved?.filesCount ?? items.length} файлов, ${saved?.chunksCount ?? 0} фрагментов, ${formatBytes(saved?.chars ?? 0)} текста.`,
      );
      setRagHits(null);
    } catch (caught) {
      setRagError(caught instanceof Error ? caught.message : "Не удалось проиндексировать папку");
    } finally {
      setRagBusy(false);
      setRagProgress(null);
    }
  };

  const removeFolder = async () => {
    if (!folderId || ragBusy) return;
    setRagError(null);
    try {
      const res = await fetch(`/api/ai/rag?id=${folderId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setRagError(data.error ?? "Не удалось удалить папку");
        return;
      }
      setFolders((prev) => prev.filter((folder) => folder.id !== folderId));
      setFolderId(0);
      setRagHits(null);
      setNotice("Папка удалена из базы.");
    } catch {
      setRagError("Сеть недоступна");
    }
  };

  const testRag = async () => {
    if (!folderId || !ragQuery.trim()) return;
    setRagError(null);
    try {
      const res = await fetch("/api/ai/rag/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId, query: ragQuery, limit: 3 }),
      });
      const data = (await res.json().catch(() => ({}))) as { hits?: RagHit[]; error?: string };
      if (!res.ok) {
        setRagError(data.error ?? "Поиск не сработал");
        return;
      }
      setRagHits(data.hits ?? []);
    } catch {
      setRagError("Сеть недоступна");
    }
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

  /* ------------------------------- вложения ------------------------------ */

  const appendFiles = async (picked: File[]) => {
    if (picked.length === 0) return;
    setError(null);

    const room = AI_MAX_FILES - pending.length;
    if (room <= 0) {
      setError(`Можно приложить не больше ${AI_MAX_FILES} файлов к одному вопросу`);
      return;
    }
    const accepted = picked.slice(0, room);
    if (picked.length > accepted.length) {
      setError(`Взяли первые ${accepted.length} файлов: больше ${AI_MAX_FILES} за раз нельзя`);
    }

    setExtracting(accepted.length);
    const added: PendingFile[] = [];
    for (const file of accepted) {
      try {
        if (file.size > AI_MAX_FILE_BYTES) {
          setError(`Файл «${file.name}» больше ${formatBytes(AI_MAX_FILE_BYTES)}`);
          continue;
        }
        const extracted = await extractFile(file);
        const preview = extracted.kind === "image" ? URL.createObjectURL(file) : null;
        if (preview) previewsRef.current.push(preview);
        added.push({
          id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`,
          file,
          kind: extracted.kind,
          text: extracted.text,
          note: extracted.truncated ? `${extracted.note}, обрезано до ${Math.round(extracted.text.length / 1000)} тыс. символов` : extracted.note,
          truncated: extracted.truncated,
          preview,
        });
      } catch {
        setError(`Не удалось прочитать «${file.name}»`);
      } finally {
        setExtracting((left) => Math.max(left - 1, 0));
      }
    }
    setPending((prev) => [...prev, ...added]);
  };

  const addFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    await appendFiles(picked);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const { files, hasPlainText } = extractClipboardFiles(event.clipboardData);
    if (files.length === 0) return;
    if (!hasPlainText) event.preventDefault();
    void appendFiles(files);
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasTransferFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasTransferFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (!dragging) setDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!hasTransferFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    dragDepthRef.current = 0;
    setDragging(false);
    if (!hasTransferFiles(event.dataTransfer)) return;
    event.preventDefault();
    const dropped = Array.from(event.dataTransfer.files ?? []);
    if (dropped.length > 0) void appendFiles(dropped);
  };

  const removePending = (id: string) => {
    const target = pending.find((item) => item.id === id);
    if (target?.preview) {
      URL.revokeObjectURL(target.preview);
      previewsRef.current = previewsRef.current.filter((url) => url !== target.preview);
    }
    setPending(pending.filter((item) => item.id !== id));
  };

  /* --------------------------------- чат -------------------------------- */

  const totals = bubbles.reduce(
    (acc, bubble) => {
      if (!bubble.usage) return acc;
      return {
        prompt: acc.prompt + bubble.usage.prompt,
        completion: acc.completion + bubble.usage.completion,
      };
    },
    { prompt: 0, completion: 0 },
  );
  const totalTokens = totals.prompt + totals.completion;

  const limit = params.contextLimit;
  const usedPercent = limit > 0 ? Math.min(100, Math.round((contextTokens / limit) * 100)) : 0;
  const overLimit = limit > 0 && contextTokens >= limit;

  const policy = usage?.policy ?? null;
  const chatLimit = chat?.tokensLimit ?? policy?.perChatTokens ?? 0;
  const chatLeft = chat ? Math.max(chatLimit - chat.tokensTotal, 0) : chatLimit;
  const chatUsedPercent = chatLimit > 0 ? Math.min(100, Math.round(((chat?.tokensTotal ?? 0) / chatLimit) * 100)) : 0;
  const chatExhausted = Boolean(chat && chatLimit > 0 && chat.tokensTotal >= chatLimit);
  const monthLimit = usage?.monthly.limit ?? null;
  const monthUsed = usage?.monthly.used ?? 0;
  const monthLeft = usage?.monthly.left ?? null;
  const monthExhausted = monthLimit !== null && monthUsed >= monthLimit;
  const reasoningOptions = AI_REASONING_MODES.filter((mode) => policy?.reasoning.includes(mode.value) ?? true);

  const newChat = async () => {
    if (streaming) abortRef.current?.abort();
    await createChat();
  };

  const send = async () => {
    const question = text.trim();
    if (streaming) return;
    if (!question && pending.length === 0) return;
    if (!settings.model.trim()) {
      setError("Укажите модель — например, через «Проверить подключение» или вручную.");
      return;
    }
    if (overLimit) {
      setError("Контекст заполнен: нажмите «Новый чат», чтобы начать заново и обнулить счётчик токенов.");
      return;
    }
    if (chatExhausted) {
      setError(
        `В этом чате закончился лимит токенов (${formatTokenCount(chat?.tokensTotal ?? 0)} из ${formatTokenCount(chatLimit)}). Начните новый чат.`,
      );
      return;
    }
    if (monthExhausted) {
      setError(
        `Месячный лимит токенов исчерпан (${formatTokenCount(monthUsed)} из ${formatTokenCount(monthLimit)}). Расширить лимит может администратор.`,
      );
      return;
    }
    setError(null);
    setNotice(null);
    autoScrollPausedRef.current = false;

    let activeChat = chat;
    if (!activeChat) {
      activeChat = await createChat();
      if (!activeChat) return;
    }

    const parts: Array<Record<string, unknown>> = [];
    const metas: AttachmentMeta[] = [];
    for (const item of pending) {
      if (item.kind === "image") {
        const prepared = await imageToDataUrl(item.file).catch(() => null);
        if (prepared) {
          parts.push({ type: "image_url", image_url: { url: prepared.dataUrl } });
          metas.push({ name: item.file.name, mime: item.file.type, size: item.file.size, kind: "image", note: prepared.note });
        } else {
          metas.push({ name: item.file.name, mime: item.file.type, size: item.file.size, kind: "unreadable", note: "не удалось прочитать" });
        }
      } else if (item.kind === "text") {
        parts.push({ type: "text", text: `Файл «${item.file.name}»:\n\n${item.text}` });
        metas.push({ name: item.file.name, mime: item.file.type, size: item.file.size, kind: "text", note: item.note });
      } else {
        parts.push({
          type: "text",
          text: `[Вложение «${item.file.name}» (${formatBytes(item.file.size)}, ${item.file.type || "неизвестный тип"}) — содержимое недоступно модели, известны только имя и размер.]`,
        });
        metas.push({ name: item.file.name, mime: item.file.type, size: item.file.size, kind: "unreadable", note: item.note });
      }
    }
    if (question) parts.unshift({ type: "text", text: question });

    if (contextRef.current.length === 0 && bubbles.length > 0) {
      contextRef.current = bubbles.map((bubble) => ({ role: bubble.role, content: bubble.text }));
    }
    const outgoing = question && parts.length === 1 && parts[0].type === "text" ? question : parts;
    contextRef.current.push({ role: "user", content: outgoing });

    const projected = estimateMessagesTokens(contextRef.current) + (params.system ? estimateTokens(params.system) : 0);
    if (limit > 0 && projected > limit) {
      contextRef.current.pop();
      setError(
        `Сообщение не влезает в контекст модели (≈${projected} из ${limit} токенов). Начните новый чат или уменьшите вложение.`,
      );
      return;
    }

    const now = nowMs();
    const replyId = `a-${now}`;
    setBubbles((prev) => [
      ...prev,
      { id: `u-${now}`, role: "user", text: question, reasoning: "", attachments: metas, at: now },
      { id: replyId, role: "assistant", text: "", reasoning: "", attachments: [], at: now },
    ]);
    setText("");
    clearPending();
    if (inputRef.current) inputRef.current.focus();

    await runCompletion(replyId, question || "Опиши вложения.", activeChat.id, metas);
  };

  const runCompletion = async (
    replyId: string,
    ragQueryText: string,
    chatId: number,
    attachments: AttachmentMeta[],
  ) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    let accumulated = "";
    let thinking = "";
    let turnUsage: Usage | null = null;
    let ragHits = 0;
    let ragFull: RagFullStats | null = null;

    const promptEstimate = estimateMessagesTokens(contextRef.current) + (params.system ? estimateTokens(params.system) : 0);

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
        body: JSON.stringify({
          messages: contextRef.current,
          params,
          chatId,
          attachments,
          ragFolderId: policy?.rag ? folderId || 0 : 0,
          ragQuery: ragQueryText,
        }),
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
      let finished = false;
      while (!finished) {
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
          const data = JSON.parse(payload) as {
            delta?: string;
            reasoning?: string;
            usage?: { prompt: number; completion: number; total: number; estimated?: boolean };
            ragHits?: number;
            ragFull?: RagFullStats | null;
            done?: boolean;
            error?: string;
            chat?: ChatInfo | null;
            monthly?: { used: number; limit: number | null; left: number | null };
          };
          if (data.error) throw new Error(data.error);
          if (typeof data.ragHits === "number") ragHits = data.ragHits;
          if (data.ragFull) ragFull = data.ragFull;
          if (data.usage) {
            turnUsage = {
              prompt: data.usage.prompt,
              completion: data.usage.completion,
              total: data.usage.total || data.usage.prompt + data.usage.completion,
              estimated: Boolean(data.usage.estimated),
            };
          }
          if (data.chat) {
            setChat(data.chat);
            setChats((prev) =>
              prev.map((item) => (item.id === data.chat?.id ? { ...item, ...data.chat } : item)),
            );
          }
          if (data.monthly) {
            setUsage((prev) =>
              prev
                ? { ...prev, monthly: data.monthly ?? prev.monthly, totals: { ...prev.totals, total: data.monthly?.used ?? prev.totals.total } }
                : prev,
            );
          }
          if (data.reasoning) {
            thinking += data.reasoning;
            patch({ reasoning: thinking });
          }
          if (data.delta) {
            accumulated += data.delta;
            patch({ text: accumulated, reasoning: thinking });
          }
          if (data.done) {
            finished = true;
            break;
          }
        }
      }

      if (!accumulated.trim()) {
        patch({ text: "Модель вернула пустой ответ.", error: true });
        return;
      }

      // Сервер не прислал usage — считаем сами и помечаем как оценку.
      // Оценка промпта учитывает и RAG-контекст: в режиме «вся база» он весит больше всего.
      const ragPromptTokens = ragFull ? Math.round(ragFull.chars / RAG_CHARS_PER_TOKEN) : 0;
      const finalUsage: Usage = turnUsage ?? {
        prompt: promptEstimate + ragPromptTokens,
        completion: estimateTokens(accumulated),
        total: promptEstimate + ragPromptTokens + estimateTokens(accumulated),
        estimated: true,
      };
      patch({ usage: finalUsage, ragHits, ragFull });
      // Следующий запрос пойдёт с промптом ≈ (промпт + ответ) этого хода.
      setContextTokens(finalUsage.total);
      void reloadChats();
      void reloadUsage();
      if (contextRef.current.length > 0) contextRef.current.push({ role: "assistant", content: accumulated });
    } catch (caught) {
      const aborted = controller.signal.aborted;
      if (aborted) {
        if (accumulated.trim()) {
          // Остановили вручную: часть ответа уже в контексте, токены считаем оценкой.
          const partial = promptEstimate + estimateTokens(accumulated);
          patch({
            usage: { prompt: promptEstimate, completion: estimateTokens(accumulated), total: partial, estimated: true },
          });
          setContextTokens(partial);
          contextRef.current.push({ role: "assistant", content: accumulated });
        } else {
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
      const usage = bubble.usage
        ? `\nТокены: ${bubble.usage.prompt} → ${bubble.usage.completion}${bubble.usage.estimated ? " (оценка)" : ""}`
        : "";
      const reasoning = bubble.reasoning.trim() ? `\n<details><summary>Размышления</summary>\n\n${bubble.reasoning}\n\n</details>` : "";
      return `### ${who} · ${new Date(bubble.at).toLocaleString("ru-RU")}${files}${usage}\n\n${bubble.text}${reasoning}`;
    });
    const header =
      `# Стенограмма чата с ИИ «${chat?.title ?? "Новый чат"}»\n\nМодель: ${settings.model || "—"}\nСервер: ${settings.baseUrl}\n` +
      `Токены: отправлено ${totals.prompt}, получено ${totals.completion}\nRAG: ${activeFolder ? activeFolder.name : "без папки"}\n\n`;
    const blob = new Blob([header + lines.join("\n\n---\n\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ai-chat-${chat?.id ?? 0}-${new Date().toISOString().slice(0, 10)}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const reasoningMode = AI_REASONING_MODES.find((mode) => mode.value === params.reasoning);

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      {/* ----------------------------- параметры ----------------------------- */}
      <div className="order-2 min-w-0 space-y-3 xl:order-1">
        <Section
          title="Токены аккаунта"
          subtitle={usage ? `Роль: ${ROLE_LABELS[usage.role]}` : "Считаются по всем чатам в базе"}
          icon={<Gauge size={14} className="text-emerald-500" />}
          action={
            <Badge className="border-border text-muted">
              {usage ? formatTokenCount(usage.monthly.used) : "—"}
            </Badge>
          }
        >
          <div className="space-y-3">
            {usage ? (
              <>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="rounded-xl border border-border bg-card2/60 px-2 py-1.5">
                    <p className="text-muted">Всего в аккаунте</p>
                    <p className="text-sm font-semibold">{formatTokenCount(usage.totals.total)}</p>
                  </div>
                  <div className="rounded-xl border border-border bg-card2/60 px-2 py-1.5">
                    <p className="text-muted">В этом месяце</p>
                    <p className="text-sm font-semibold">{formatTokenCount(usage.monthly.used)}</p>
                  </div>
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
                    <span>Месячный лимит</span>
                    <span>
                      {formatTokenCount(usage.monthly.used)} / {formatTokenCount(usage.monthly.limit)}
                    </span>
                  </div>
                  {usage.monthly.limit !== null ? (
                    <>
                      <div className="h-1.5 overflow-hidden rounded-full bg-card2">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all",
                            monthExhausted ? "bg-red-500" : monthUsed / usage.monthly.limit > 0.8 ? "bg-amber-500" : "bg-emerald-500",
                          )}
                          style={{
                            width: `${Math.max(Math.min(100, Math.round((monthUsed / Math.max(usage.monthly.limit, 1)) * 100)), 2)}%`,
                          }}
                        />
                      </div>
                      <p className={cn("mt-1 text-[11px]", monthExhausted ? "text-red-500" : "text-muted")}>
                        Осталось: {formatTokenCount(monthLeft)} · лимит расширяет только администратор
                      </p>
                    </>
                  ) : (
                    <p className="text-[11px] text-muted">Без месячного лимита — полный доступ</p>
                  )}
                </div>
                <p className="text-[11px] text-muted">{usage.policy.summary}</p>
                <div className="flex flex-wrap gap-1.5 text-[10px] text-muted">
                  <Badge className="border-border text-muted">RAG: {usage.policy.rag ? "да" : "нет"}</Badge>
                  <Badge className="border-border text-muted">Чатов: {usage.chats.count}</Badge>
                  <Badge className="border-border text-muted">На чат: {formatTokenCount(usage.policy.perChatTokens)}</Badge>
                </div>
              </>
            ) : (
              <p className="text-[11px] text-muted">Загружаем счётчики…</p>
            )}
          </div>
        </Section>

        <Section
          title="История чатов"
          subtitle="Сколько токенов осталось в каждом чате"
          icon={<History size={14} className="text-accent2" />}
          action={
            <Button variant="secondary" size="sm" onClick={() => void newChat()} disabled={historyBusy || streaming}>
              <MessageSquarePlus size={13} />
              Новый
            </Button>
          }
        >
          <div className="space-y-2">
            {chats.length === 0 && <p className="text-[11px] text-muted">Чатов пока нет — создайте первый.</p>}
            {chats.length > 0 && (
              <div className="max-h-64 space-y-1.5 overflow-y-auto pr-0.5">
                {chats.map((item) => {
                  const active = item.id === chat?.id;
                  const left = Math.max(item.tokensLimit - item.tokensTotal, 0);
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        "flex min-w-0 items-center gap-1.5 rounded-xl border px-2 py-1.5",
                        active ? "border-accent/60 bg-accent/10" : "border-border bg-card2/40",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => void openChat(item.id)}
                        className="min-w-0 flex-1 text-left"
                        title={`Открыть чат «${item.title}»`}
                      >
                        <p className="truncate text-[11px] font-medium">{item.title}</p>
                        <p className="truncate text-[10px] text-muted">
                          {new Date(item.updatedAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                          {" · "}осталось {formatTokenCount(left)}
                        </p>
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeChat(item.id)}
                        className="shrink-0 rounded p-1 text-muted transition hover:text-red-500"
                        title="Удалить чат"
                        aria-label={`Удалить чат «${item.title}»`}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-[11px] text-muted">
              История хранится в базе за вашим аккаунтом: чаты и токены видны с любого устройства.
            </p>
          </div>
        </Section>

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
          subtitle={
            policy && !policy.reasoning.includes("high")
              ? `Ваша роль: доступны только «без раздумий» и «коротко».`
              : "Если сервер не понимает эти параметры — выберите «По умолчанию»."
          }
          icon={<Brain size={14} className="text-accent2" />}
        >
          <div className="space-y-3">
            <Combobox
              aria-label="Тип раздумий"
              value={params.reasoning}
              onChange={(next) => updateParams({ reasoning: next as ReasoningMode })}
              placeholder="По умолчанию"
              options={reasoningOptions.map((mode) => ({ value: mode.value, label: mode.label, hint: mode.hint }))}
            />
            {reasoningMode && <p className="text-[11px] text-muted">{reasoningMode.hint}</p>}
            {params.reasoning === "budget" && (
              <Field label="Бюджет раздумий, токенов">
                <Input
                  type="number"
                  min={64}
                  max={AI_MAX_GENERATION_TOKENS}
                  step={64}
                  value={params.thinkingBudget ?? ""}
                  onChange={(event) =>
                    updateParams({ thinkingBudget: event.target.value === "" ? null : Number(event.target.value) })
                  }
                  placeholder="до 384000"
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
                Qwen3/Unsloth; некоторым сборкам это поле мешает (тогда снимите галочку).
              </span>
            </label>
          </div>
        </Section>

        <Section
          title="Контекст и токены"
          subtitle="Счётчик идёт по текущему чату; «Новый чат» обнуляет его."
          icon={<Gauge size={14} className="text-accent2" />}
          action={
            <Badge className={cn("border-border", chatExhausted && "border-red-500/40 bg-red-500/10 text-red-500")}>
              осталось {formatTokenCount(chatLeft)}
            </Badge>
          }
        >
          <div className="space-y-3">
            <div className="rounded-xl border border-border bg-card2/60 px-2 py-1.5">
              <div className="mb-1 flex items-center justify-between text-[11px]">
                <span className="text-muted">Токены чата</span>
                <span className={cn("font-medium", chatExhausted && "text-red-500")}>
                  {formatTokenCount(chat?.tokensTotal ?? 0)} / {formatTokenCount(chatLimit)}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-card2">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    chatExhausted ? "bg-red-500" : chatUsedPercent > 80 ? "bg-amber-500" : "bg-emerald-500",
                  )}
                  style={{ width: `${Math.max(chatUsedPercent, 2)}%` }}
                />
              </div>
              <p className="mt-1 text-[10px] text-muted">
                {chat ? `Чат «${chat.title}»` : "Чат ещё не создан"} · «Новый чат» обнуляет счётчик
              </p>
            </div>
            <Field label="Лимит контекста модели, токенов (0 — не следить)">
              <Input
                type="number"
                min={0}
                step={512}
                value={params.contextLimit}
                onChange={(event) => updateParams({ contextLimit: Math.max(0, Math.floor(Number(event.target.value) || 0)) })}
                className="h-9 text-xs"
              />
            </Field>
            {limit > 0 && (
              <div>
                <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
                  <span>
                    Занято ≈{contextTokens} из {limit}
                  </span>
                  <span>{usedPercent}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-card2">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      usedPercent >= 100 ? "bg-red-500" : usedPercent > 80 ? "bg-amber-500" : "bg-emerald-500",
                    )}
                    style={{ width: `${Math.max(usedPercent, 2)}%` }}
                  />
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 text-[11px] text-muted">
              <p>
                Чат, отправлено: <b className="text-text">{totals.prompt}</b>
              </p>
              <p>
                Чат, получено: <b className="text-text">{totals.completion}</b>
              </p>
            </div>
            <p className="text-[11px] text-muted">
              Если сервер не присылает usage, токены считаются оценкой по символам (кириллица ≈ 2,5 символа на токен).
            </p>
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
                    max={AI_MAX_GENERATION_TOKENS}
                    step={64}
                    value={params.maxTokens ?? ""}
                    onChange={(event) => updateParams({ maxTokens: event.target.value === "" ? null : Number(event.target.value) })}
                    className="h-9 text-xs"
                    placeholder="до 384000"
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
                    max={50}
                    step={1}
                    value={params.ragChunks}
                    disabled={params.ragFull}
                    onChange={(event) => updateParams({ ragChunks: Math.max(0, Math.floor(Number(event.target.value) || 0)) })}
                    className="h-9 text-xs disabled:opacity-50"
                  />
                  <label className="mt-1.5 flex items-start gap-2 text-[11px] text-muted">
                    <input
                      type="checkbox"
                      checked={params.ragFull}
                      onChange={(event) => updateParams({ ragFull: event.target.checked })}
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[#7c5cff]"
                    />
                    <span>
                      Вся база: отдавать модели <b>весь индекс</b> папки, без ограничения фрагментов. Объём упрётся
                      только в контекст модели ({params.contextLimit > 0 ? `${params.contextLimit} токенов` : "не отслеживается"}) —
                      остальное честно отбрасывается с пометкой в ответе.
                    </span>
                  </label>
                </Field>
                <label className="col-span-2 flex items-start gap-2 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    checked={params.streamUsage}
                    onChange={(event) => updateParams({ streamUsage: event.target.checked })}
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[#7c5cff]"
                  />
                  <span>
                    Просить у сервера usage в потоке (<code className="font-mono">stream_options.include_usage</code>).
                    Если сервер ругается — снимите галочку, токены будут считаться оценкой.
                  </span>
                </label>
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
          subtitle={
            policy && !policy.rag
              ? "Для вашей роли RAG выключен — модель отвечает без документов."
              : "Папка хранится в базе и может быть любого размера."
          }
          icon={<FolderOpen size={14} className="text-accent2" />}
          action={
            <Badge
              className={cn(
                "border-border",
                policy && !policy.rag
                  ? "bg-red-500/10 text-red-500"
                  : activeFolder
                    ? "bg-emerald-500/10 text-emerald-500"
                    : "text-muted",
              )}
            >
              {policy && !policy.rag ? "недоступно" : activeFolder ? `${activeFolder.chunksCount} фрагм.` : "нет"}
            </Badge>
          }
        >
          {policy && !policy.rag ? (
            <p className="rounded-xl border border-border bg-card2/50 px-2.5 py-2 text-[11px] text-muted">
              RAG-папки доступны администраторам, разработчикам и главному админу. Модель ответит только по переписке
              и вложениям.
            </p>
          ) : (
          <div className="space-y-3">
            <input
              ref={dirRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => void uploadFolder(event)}
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => dirRef.current?.click()} disabled={ragBusy || streaming}>
                {ragBusy ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />}
                Загрузить папку
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void reloadFolders()} disabled={ragBusy}>
                <RefreshCw size={13} />
              </Button>
              {folderId > 0 && (
                <Button variant="ghost" size="sm" onClick={() => void removeFolder()} disabled={ragBusy}>
                  <Trash2 size={13} />
                  Удалить
                </Button>
              )}
            </div>

            {folders.length > 0 && (
              <Combobox
                aria-label="RAG папка"
                value={folderId ? String(folderId) : ""}
                onChange={(next) => {
                  setFolderId(Number(next) || 0);
                  setRagHits(null);
                }}
                clearable
                clearTitle="Без RAG"
                placeholder="Без RAG"
                size="sm"
                options={[
                  { value: "", label: "Без RAG", hint: "модель отвечает без папки" },
                  ...folders.map((folder) => ({
                    value: String(folder.id),
                    label: folder.name,
                    hint: `${folder.filesCount} файлов · ${folder.chunksCount} фрагм. · ${formatBytes(folder.chars)}`,
                  })),
                ]}
              />
            )}

            {ragProgress && (
              <p className="text-[11px] text-muted">
                {ragProgress.phase === "read" ? "Читаем файлы" : "Загружаем в базу"}: {ragProgress.done}/
                {ragProgress.total}
              </p>
            )}

            {activeFolder && (
              <div className="rounded-xl border border-border bg-card2/60 px-2.5 py-2 text-[11px] text-muted">
                <p className="break-words">
                  <b className="text-text">{activeFolder.name}</b>
                </p>
                <p className="mt-0.5">
                  {activeFolder.filesCount} файлов · {activeFolder.chunksCount} фрагментов · {formatBytes(activeFolder.chars)}
                </p>
                <p className="mt-0.5">Обновлена: {new Date(activeFolder.updatedAt).toLocaleString("ru-RU")}</p>
              </div>
            )}

            {folderId > 0 && (
              <>
                <div className="flex gap-2">
                  <Input
                    value={ragQuery}
                    onChange={(event) => setRagQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void testRag();
                      }
                    }}
                    placeholder="Проверить поиск по папке..."
                    className="h-9 text-xs"
                  />
                  <Button variant="secondary" size="sm" className="shrink-0" onClick={() => void testRag()} disabled={!ragQuery.trim()}>
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
                  {params.ragFull ? (
                    <>
                      В контекст уходит <b>весь индекс папки</b> (~{Math.round(activeFolder?.chars ? activeFolder.chars / 1000 : 0)} тыс.
                      символов, {activeFolder?.chunksCount ?? 0} фрагментов). Если весь текст не влезает в контекст модели,
                      бот отдаст самое релевантное вопросу и скажет, сколько фрагментов вошло.
                    </>
                  ) : (
                    <>
                      На каждый вопрос из базы достаются до {params.ragChunks} фрагментов (~900 символов каждый). Включите
                      «Вся база», чтобы отдавать весь индекс без ограничения фрагментов.
                    </>
                  )}{" "}
                  Индекс хранится в базе за вашим пользователем, поэтому ограничения на размер папки нет.
                </p>
              </>
            )}
            {ragError && <p className="text-[11px] text-red-500">{ragError}</p>}
            {!activeFolder && folders.length === 0 && !ragBusy && (
              <p className="text-[11px] text-muted">
                Выберите папку с документацией или кодом: текст, docx, xlsx, pptx, pdf и rtf разбираются в браузере и
                загружаются в базу частями. Лимит на файл — {formatBytes(AI_MAX_FILE_BYTES)}.
              </p>
            )}
          </div>
          )}
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
              {chat?.title ?? "Новый чат"}
              <Badge className="border-border text-muted">{settings.model.trim() || "модель не выбрана"}</Badge>
              <Badge className={cn("border-border", chatExhausted ? "bg-red-500/10 text-red-500" : "text-muted")}>
                осталось {formatTokenCount(chatLeft)}
              </Badge>
              <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-500">Harness</Badge>
              {activeFolder && <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-500">RAG</Badge>}
            </span>
          }
          subtitle="История хранится в базе аккаунта; «Новый чат» начинает разговор и счётчик токенов заново."
          action={
            <div className="flex items-center gap-1">
              <Button variant="secondary" size="sm" onClick={() => void newChat()} title="Начать новый чат и обнулить счётчик">
                <MessageSquarePlus size={13} />
                Новый чат
              </Button>
              <Button variant="ghost" size="sm" onClick={exportTranscript} disabled={bubbles.length === 0} title="Скачать стенограмму">
                <Download size={13} />
              </Button>
            </div>
          }
        >
          <div
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={cn(
              "relative flex h-[520px] flex-col overflow-hidden rounded-xl border bg-card2/30 transition sm:h-[620px]",
              dragging ? "border-accent ring-2 ring-[var(--ring)]" : "border-border",
            )}
          >
            {dragging && (
              <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent/10 backdrop-blur-[1px]">
                <p className="rounded-xl border border-accent/40 bg-card px-4 py-2 text-xs font-medium text-text shadow">
                  Отпустите файл или картинку, чтобы приложить к сообщению
                </p>
              </div>
            )}
            <div
              ref={listRef}
              onScroll={() => {
                const el = listRef.current;
                if (!el) return;
                autoScrollPausedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight > 220;
              }}
              className="flex-1 space-y-3 overflow-y-auto px-2.5 py-3 sm:px-4"
            >
              {bubbles.length === 0 && (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                  <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-[#7c5cff] to-[#a78bfa] text-white">
                    <Bot size={20} />
                  </span>
                  <p className="text-sm font-medium">{chat?.title ?? "Новый чат"} готов к работе</p>
                  <p className="max-w-md text-xs text-muted">
                    Выберите модель, при желании папку RAG и тип раздумий. Можно приложить любые файлы до{" "}
                    {formatBytes(AI_MAX_FILE_BYTES)} — текст, docx/xlsx/pptx, pdf, картинки (также работают Ctrl+V и drag-and-drop).
                  </p>
                </div>
              )}

              {bubbles.map((bubble, bubbleIndex) => {
                const mine = bubble.role === "user";
                const isLastStreaming = streaming && !mine && bubbleIndex === bubbles.length - 1;
                const emptyStreaming = isLastStreaming && !bubble.text;
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
                        <LiveReasoningBox
                          text={bubble.reasoning}
                          streaming={isLastStreaming}
                          className="mb-2 rounded-lg border-border/70 bg-card2/60"
                          bodyClassName="max-h-56"
                        />
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
                              title={[`${attachment.mime || "файл"} · ${formatBytes(attachment.size)}`, attachment.note]
                                .filter(Boolean)
                                .join(" · ")}
                            >
                              {ATTACHMENT_ICON[attachment.kind]}
                              <span className="truncate">{attachment.name}</span>
                            </span>
                          ))}
                        </div>
                      )}
                      <div className={cn("mt-1 flex items-center justify-end gap-1.5 text-[10px]", mine ? "text-white/70" : "text-muted/80")}>
                        {!mine && (bubble.ragHits ?? 0) > 0 && (
                          <span
                            className={cn("flex items-center gap-0.5", bubble.ragFull?.truncated && "text-amber-500")}
                            title={
                              bubble.ragFull
                                ? `Вся база: ${bubble.ragFull.used} из ${bubble.ragFull.total} фрагментов ` +
                                  `(${Math.round(bubble.ragFull.chars / 1024)} КБ). ` +
                                  (bubble.ragFull.truncated
                                    ? `Не влезло в контекст модели${bubble.ragFull.contextLimit > 0 ? ` (${bubble.ragFull.contextLimit} токенов)` : ""} — отдано самое релевантное.`
                                    : "Весь индекс отправлен модели.")
                                : "Фрагментов RAG в контексте"
                            }
                          >
                            <FolderOpen size={10} />
                            {bubble.ragFull ? `${bubble.ragFull.used}/${bubble.ragFull.total}` : bubble.ragHits}
                          </span>
                        )}
                        {bubble.usage && (
                          <span title={`Токены: отправлено ${bubble.usage.prompt}, получено ${bubble.usage.completion}${bubble.usage.estimated ? " (оценка)" : ""}`}>
                            ↑{bubble.usage.prompt} ↓{bubble.usage.completion}
                          </span>
                        )}
                        <span>{formatTime(new Date(bubble.at))}</span>
                      </div>
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
              {chatExhausted && (
                <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-2.5 py-2 text-[11px] text-red-500">
                  <AlertTriangle size={13} className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    Лимит чата исчерпан ({formatTokenCount(chat?.tokensTotal ?? 0)} из {formatTokenCount(chatLimit)}).
                    Начните новый чат — счётчик обнулится, история останется.
                  </span>
                  <Button type="button" variant="secondary" size="sm" onClick={() => void newChat()}>
                    <MessageSquarePlus size={12} />
                    Новый чат
                  </Button>
                </div>
              )}
              {monthExhausted && (
                <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-2.5 py-2 text-[11px] text-red-500">
                  <AlertTriangle size={13} className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    Месячный лимит токенов исчерпан ({formatTokenCount(monthUsed)} из {formatTokenCount(monthLimit)}).
                    Расширить лимит на этот месяц может администратор.
                  </span>
                </div>
              )}
              {overLimit && (
                <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-500">
                  <AlertTriangle size={13} className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    Контекст заполнен (≈{contextTokens} из {limit} токенов). Начните новый чат — счётчик токенов обнулится.
                  </span>
                  <Button type="button" variant="secondary" size="sm" onClick={() => void newChat()}>
                    <MessageSquarePlus size={12} />
                    Новый чат
                  </Button>
                </div>
              )}
              {pending.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {pending.map((item) => (
                    <span
                      key={item.id}
                      className="flex max-w-full items-center gap-1.5 rounded-xl border border-border bg-card2 px-1.5 py-1 text-[11px]"
                      title={item.note}
                    >
                      {item.preview ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.preview} alt={item.file.name} className="h-6 w-6 shrink-0 rounded object-cover" />
                      ) : (
                        <FileText size={12} className="shrink-0 text-muted" />
                      )}
                      <span className="flex min-w-0 flex-col">
                        <span className="max-w-[9rem] truncate">{item.file.name}</span>
                        <span className="max-w-[9rem] truncate text-[9px] text-muted">{item.note}</span>
                      </span>
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
                  title={`Любой файл до ${formatBytes(AI_MAX_FILE_BYTES)}: текст, docx/xlsx/pptx, pdf, картинки`}
                >
                  {extracting > 0 ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}
                  <input ref={fileRef} type="file" multiple className="hidden" onChange={(event) => void addFiles(event)} />
                </label>
                <textarea
                  ref={inputRef}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onPaste={handlePaste}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  rows={1}
                  placeholder="Спросите модель... (Enter — отправить, Ctrl+V — вставить картинку, или перетащите файл)"
                  className="max-h-32 min-h-[40px] min-w-0 flex-1 resize-none rounded-xl border border-border bg-card2 px-3 py-2 text-sm outline-none focus:border-accent"
                />
                {streaming ? (
                  <Button type="button" variant="secondary" size="icon" onClick={stop} title="Остановить">
                    <Square size={14} />
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    size="icon"
                    disabled={(!text.trim() && pending.length === 0) || overLimit || chatExhausted || monthExhausted}
                    title="Отправить"
                  >
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
                  {activeFolder ? `${activeFolder.filesCount} файлов · до ${params.ragChunks} фрагм.` : "без RAG"}
                </span>
                <span className={cn("flex items-center gap-1", chatExhausted && "text-red-500")}>
                  <Gauge size={10} />
                  чат: осталось {formatTokenCount(chatLeft)} из {formatTokenCount(chatLimit)}
                </span>
                <span className={cn("flex items-center gap-1", monthExhausted && "text-red-500")}>
                  месяц: {formatTokenCount(monthUsed)}
                  {monthLimit !== null ? ` / ${formatTokenCount(monthLimit)}` : " / без лимита"}
                </span>
                {params.temperature !== null && <span>t={params.temperature}</span>}
                {params.maxTokens !== null && <span>max={params.maxTokens}</span>}
                {params.seed !== null && <span>seed={params.seed}</span>}
                <span className="ml-auto">{settings.baseUrl.replace(/^https?:\/\//, "")}</span>
              </div>
            </form>
          </div>
        </Card>
      </div>
    </div>
  );
}
