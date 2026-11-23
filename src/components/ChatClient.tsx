"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  CheckCheck,
  ChevronUp,
  FileText,
  Globe,
  Hash,
  Loader2,
  Lock,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import type { Role } from "@/db/schema";
import type { UserLite } from "@/lib/data";
import { AVATAR_COLORS, cn, formatDate, formatTime, dateToStr } from "@/lib/utils";
import { subscribeAppEvents } from "@/lib/clientEvents";
import { Avatar, Badge, Button, Field, Input, Modal, Textarea } from "./ui";
import { LoadMore, useProgressiveList } from "./lazy";

type Attachment = { id: number; name: string; mime: string; size: number };

type Msg = {
  id: number;
  senderId: number;
  recipientId: number | null;
  roomId?: number | null;
  content: string;
  createdAt: string;
  senderName: string;
  senderColor: string;
  senderAvatar: string | null;
  attachment: Attachment | null;
};

type Readers = Array<{ userId: number; lastReadId: number }>;

type ChatRoomMember = {
  userId: number;
  name: string;
  avatarColor: string;
  avatarUrl: string | null;
  position: string | null;
  isBot: boolean;
  addedAt: string;
};

type ChatRoom = {
  id: number;
  name: string;
  description: string;
  kind: "group" | "shared";
  createdBy: number | null;
  isMember: boolean;
  members: ChatRoomMember[];
  createdAt: string;
  updatedAt: string;
};

type ChatBot = {
  userId: number;
  name: string;
  position: string | null;
  bio: string | null;
  avatarColor: string;
  avatarUrl: string | null;
  model: string;
  replyMode: "mention" | "always";
  isActive: boolean;
  provider?: string;
  baseUrl?: string;
  hasApiKey?: boolean;
  apiKeyHint?: string;
  systemPrompt?: string;
};

type Target =
  | { type: "general" }
  | { type: "peer"; peerId: number }
  | { type: "room"; roomId: number };

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SEARCH_MIN = 2;

const BOT_PROVIDERS = [
  { id: "local", label: "Ollama (локально)", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b" },
  { id: "lmstudio", label: "LM Studio (локально)", baseUrl: "http://127.0.0.1:1234/v1", model: "" },
  { id: "openai", label: "OpenAI API", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "groq", label: "Groq API", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
  { id: "custom", label: "Свой OpenAI-совместимый URL", baseUrl: "", model: "" },
] as const;

function isImage(mime: string) {
  return /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(mime);
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} КБ`;
  return `${Math.round(bytes / 104857.6) / 10} МБ`;
}

/** Подсветка совпадений в результатах поиска (без регулярок — регистр не важен). */
function highlightMatch(text: string, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return text;
  const haystack = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let from = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1 && parts.length < 20) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={`${at}-${parts.length}`} className="rounded bg-accent/25 px-0.5 text-text">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
    at = haystack.indexOf(needle, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

export function ChatClient({
  users,
  meId,
  meRole = "user",
  initialPeer = 0,
  initialRoom = 0,
  unlimited = false,
}: {
  users: UserLite[];
  meId: number;
  meRole?: Role;
  initialPeer?: number;
  initialRoom?: number;
  unlimited?: boolean;
}) {
  const isSuperAdmin = meRole === "super_admin";

  const [target, setTarget] = useState<Target>(() => {
    if (initialRoom > 0) return { type: "room", roomId: initialRoom };
    if (initialPeer > 0) return { type: "peer", peerId: initialPeer };
    return { type: "general" };
  });

  const peer = target.type === "peer" ? target.peerId : 0;
  const roomId = target.type === "room" ? target.roomId : 0;

  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [peerReadId, setPeerReadId] = useState(0);
  const [generalReaders, setGeneralReaders] = useState<Readers>([]);
  const [roomReaders, setRoomReaders] = useState<Readers>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [roomUnread, setRoomUnread] = useState<Record<string, number>>({});

  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [generalBotIds, setGeneralBotIds] = useState<number[]>([]);
  const [bots, setBots] = useState<ChatBot[]>([]);
  const [replyingBots, setReplyingBots] = useState<number[]>([]);

  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [peerFilter, setPeerFilter] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Msg[]>([]);
  const [searching, setSearching] = useState(false);

  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [context, setContext] = useState<{ hasOlder: boolean; hasNewer: boolean } | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);

  // Модалка создания группы/общего чата (для всех сотрудников).
  const [createRoomOpen, setCreateRoomOpen] = useState(false);
  const [roomForm, setRoomForm] = useState({
    name: "",
    description: "",
    kind: "group" as "group" | "shared",
    memberIds: [] as number[],
    botIds: [] as number[],
  });
  const [roomBusy, setRoomBusy] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);

  // Модалка участников и ботов текущего чата (для Общего чата и комнат).
  const [manageOpen, setManageOpen] = useState(false);
  const [manageName, setManageName] = useState("");
  const [manageBusy, setManageBusy] = useState(false);
  const [manageError, setManageError] = useState<string | null>(null);

  // Модалка создания/редактирования модели-бота (ТОЛЬКО super_admin).
  const [botModalOpen, setBotModalOpen] = useState(false);
  const [editingBotId, setEditingBotId] = useState<number | null>(null);
  const [botForm, setBotForm] = useState({
    name: "",
    position: "ИИ-помощник",
    bio: "",
    avatarColor: "#06b6d4",
    provider: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "",
    clearApiKey: false,
    hasExistingKey: false,
    existingKeyHint: "",
    model: "qwen3:8b",
    systemPrompt: "Ты полезный ИИ-помощник команды в CRM. Отвечай чётко, дружелюбно и по делу.",
    replyMode: "mention" as "mention" | "always",
    isActive: true,
  });
  const [botModels, setBotModels] = useState<string[]>([]);
  const [botFetchingModels, setBotFetchingModels] = useState(false);
  const [botBusy, setBotBusy] = useState(false);
  const [botError, setBotError] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<string | null>(null);
  const lastId = useRef(0);
  const nodes = useRef(new Map<number, HTMLDivElement>());
  const lastMarked = useRef(0);
  const contextRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollDown = () => {
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    });
  };

  const selectTarget = useCallback((next: Target) => {
    lastId.current = 0;
    lastMarked.current = 0;
    setTarget(next);
    setMsgs([]);
    setLoading(true);
    setError(null);
    setQuery("");
    setResults([]);
    setSearching(false);
    setContext(null);
    setHasOlder(false);
    setHighlightId(null);
  }, []);

  const refreshMetadata = useCallback(async () => {
    try {
      const [roomsRes, botsRes] = await Promise.all([
        fetch("/api/chat/rooms", { cache: "no-store" }),
        fetch("/api/chat/bots", { cache: "no-store" }),
      ]);
      if (roomsRes.ok) {
        const data = (await roomsRes.json()) as { rooms?: ChatRoom[]; generalBotIds?: number[] };
        if (Array.isArray(data.rooms)) setRooms(data.rooms);
        if (Array.isArray(data.generalBotIds)) setGeneralBotIds(data.generalBotIds);
      }
      if (botsRes.ok) {
        const data = (await botsRes.json()) as { bots?: ChatBot[] };
        if (Array.isArray(data.bots)) setBots(data.bots);
      }
    } catch {
      /* фоновая подгрузка */
    }
  }, []);

  const refreshUnread = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/state", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        unread?: Record<string, number>;
        roomUnread?: Record<string, number>;
      };
      setUnread(data.unread ?? {});
      setRoomUnread(data.roomUnread ?? {});
    } catch {
      /* сеть моргнула — обновимся на следующем тике */
    }
  }, []);

  /** Отметить переписку или комнату прочитанной до последнего видимого сообщения. */
  const markRead = useCallback(
    async (t: Target, id: number) => {
      if (id <= 0 || lastMarked.current >= id) return;
      lastMarked.current = id;
      try {
        await fetch("/api/chat/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            t.type === "room"
              ? { room: t.roomId, id }
              : { peer: t.type === "peer" ? t.peerId : 0, id },
          ),
        });
        await refreshUnread();
      } catch {
        lastMarked.current = 0;
      }
    },
    [refreshUnread],
  );

  const applyMessages = useCallback(
    (data: { messages: Msg[]; peerReadId?: number; generalReaders?: Readers; roomReaders?: Readers }) => {
      setPeerReadId(data.peerReadId ?? 0);
      setGeneralReaders(data.generalReaders ?? []);
      setRoomReaders(data.roomReaders ?? []);
      return data.messages;
    },
    [],
  );

  const buildChatQuery = useCallback(
    (extra: Record<string, string | number>) => {
      const qs = new URLSearchParams();
      if (target.type === "room") qs.set("room", String(target.roomId));
      else qs.set("peer", String(target.type === "peer" ? target.peerId : 0));
      for (const [k, v] of Object.entries(extra)) {
        qs.set(k, String(v));
      }
      return `/api/chat?${qs.toString()}`;
    },
    [target],
  );

  const load = useCallback(
    async (full: boolean) => {
      try {
        const after = full ? 0 : lastId.current;
        const res = await fetch(buildChatQuery({ after, limit: 30 }), { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          messages: Msg[];
          peerReadId?: number;
          generalReaders?: Readers;
          roomReaders?: Readers;
          hasOlder?: boolean;
        };
        if (full) {
          const list = applyMessages(data);
          setMsgs(list);
          setHasOlder(Boolean(data.hasOlder));
          lastId.current = list.at(-1)?.id ?? 0;
          setContext(null);
          scrollDown();
          if (document.visibilityState === "visible") await markRead(target, lastId.current);
        } else if (data.messages.length) {
          setPeerReadId(data.peerReadId ?? 0);
          setGeneralReaders(data.generalReaders ?? []);
          setRoomReaders(data.roomReaders ?? []);
          setMsgs((prev) => [...prev, ...data.messages.filter((m) => !prev.some((p) => p.id === m.id))]);
          lastId.current = data.messages.at(-1)!.id;
          scrollDown();
          if (document.visibilityState === "visible") await markRead(target, lastId.current);
        }
      } finally {
        setLoading(false);
      }
    },
    [buildChatQuery, applyMessages, markRead, target],
  );

  /** Догрузить более раннюю страницу, сохранив позицию прокрутки. */
  const loadOlder = useCallback(async () => {
    const first = msgs[0]?.id;
    if (!first || loadingOlder || !hasOlder) return;
    setLoadingOlder(true);
    const node = listRef.current;
    const previousHeight = node?.scrollHeight ?? 0;
    const previousTop = node?.scrollTop ?? 0;
    try {
      const res = await fetch(buildChatQuery({ before: first, limit: 30 }), { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { messages: Msg[]; hasOlder?: boolean };
      if (data.messages.length === 0) {
        setHasOlder(false);
        return;
      }
      setMsgs((prev) => [...data.messages.filter((m) => !prev.some((p) => p.id === m.id)), ...prev]);
      setHasOlder(Boolean(data.hasOlder));
      requestAnimationFrame(() => {
        if (!listRef.current) return;
        listRef.current.scrollTop = previousTop + (listRef.current.scrollHeight - previousHeight);
      });
    } finally {
      setLoadingOlder(false);
    }
  }, [msgs, loadingOlder, hasOlder, buildChatQuery]);

  // Первичная загрузка комнат/ботов и опрос.
  useEffect(() => {
    const initTimer = setTimeout(() => {
      void refreshMetadata();
    }, 0);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshMetadata();
    }, 10_000);
    return () => {
      clearTimeout(initTimer);
      clearInterval(timer);
    };
  }, [refreshMetadata]);

  // Загрузка переписки при смене собеседника/комнаты + опрос новых сообщений.
  useEffect(() => {
    void load(true);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !contextRef.current) void load(false);
    }, 3000);
    return () => clearInterval(timer);
  }, [load]);

  // Мгновенные обновления через общий SSE-канал `/api/events`.
  useEffect(() => {
    return subscribeAppEvents({
      onUpdate: (raw) => {
        try {
          const payload = JSON.parse(raw) as { scope?: string };
          if (payload.scope === "chat") {
            if (!contextRef.current) void load(false);
            void refreshUnread();
            void refreshMetadata();
          } else if (payload.scope === "users") {
            void refreshMetadata();
          }
        } catch {
          /* игнор */
        }
      },
    });
  }, [load, refreshMetadata, refreshUnread]);

  useEffect(() => {
    contextRef.current = context !== null;
  }, [context]);

  // Значки непрочитанного в списке чатов.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refreshUnread();
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 5000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refreshUnread]);

  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  const updateQuery = (value: string) => {
    setQuery(value);
    if (value.trim().length < SEARCH_MIN) {
      setResults([]);
      setSearching(false);
    }
  };

  useEffect(() => {
    const needle = query.trim();
    if (needle.length < SEARCH_MIN) return;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const qs = new URLSearchParams({ q: needle });
        if (target.type === "room") qs.set("room", String(target.roomId));
        else qs.set("peer", String(target.type === "peer" ? target.peerId : 0));
        const res = await fetch(`/api/chat/search?${qs.toString()}`, { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as { results: Msg[] };
          setResults(data.results);
        }
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, target]);

  const clearFile = () => {
    if (previewRef.current) {
      URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    }
    setFilePreview(null);
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const pickFile = (picked: File | null | undefined) => {
    setError(null);
    if (!picked) return;
    if (!unlimited && picked.size > MAX_FILE_BYTES) {
      setError("Файл больше 5 МБ");
      clearFile();
      return;
    }
    if (previewRef.current) {
      URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    }
    if (isImage(picked.type)) {
      const url = URL.createObjectURL(picked);
      previewRef.current = url;
      setFilePreview(url);
    } else {
      setFilePreview(null);
    }
    setFile(picked);
  };

  const triggerBotReplies = async (botUserIds: number[], snapPeer: number, snapRoom: number) => {
    if (botUserIds.length === 0) return;
    setReplyingBots((prev) => [...new Set([...prev, ...botUserIds])]);
    try {
      for (const botUserId of botUserIds) {
        try {
          const res = await fetch("/api/chat/bot-reply", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ botUserId, peer: snapPeer, room: snapRoom }),
          });
          if (!res.ok) {
            const errData = (await res.json().catch(() => ({}))) as { error?: string };
            setError(errData.error ?? "Модель-бот не смогла ответить");
          }
          await load(false);
        } finally {
          setReplyingBots((prev) => prev.filter((id) => id !== botUserId));
        }
      }
    } catch {
      setReplyingBots((prev) => prev.filter((id) => !botUserIds.includes(id)));
    }
  };

  const send = async () => {
    const content = text.trim();
    if ((!content && !file) || sending) return;
    setSending(true);
    setError(null);
    const snapPeer = peer;
    const snapRoom = roomId;
    try {
      let res: Response;
      if (file) {
        const form = new FormData();
        if (snapRoom > 0) form.set("room", String(snapRoom));
        else form.set("peer", String(snapPeer));
        form.set("content", content);
        form.set("file", file);
        res = await fetch("/api/chat", { method: "POST", body: form });
      } else {
        res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(snapRoom > 0 ? { room: snapRoom, content } : { peer: snapPeer, content }),
        });
      }
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { triggeredBotIds?: number[] };
        setText("");
        clearFile();
        await load(false);
        await refreshUnread();
        if (Array.isArray(data.triggeredBotIds) && data.triggeredBotIds.length > 0) {
          void triggerBotReplies(data.triggeredBotIds, snapPeer, snapRoom);
        }
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Не удалось отправить");
      }
    } catch {
      setError("Нет связи с сервером");
    } finally {
      setSending(false);
    }
  };

  /** Принудительно позвать конкретного бота в текущем чате (кнопка или @упоминание). */
  const askBotNow = async (bot: ChatBot) => {
    if (sending) return;
    const hasMention = text.toLowerCase().includes(`@${bot.name.toLowerCase()}`);
    if (text.trim()) {
      const nextContent = hasMention ? text.trim() : `@${bot.name} ${text.trim()}`;
      setSending(true);
      setError(null);
      const snapPeer = peer;
      const snapRoom = roomId;
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            snapRoom > 0
              ? { room: snapRoom, content: nextContent, triggerBotId: bot.userId }
              : { peer: snapPeer, content: nextContent, triggerBotId: bot.userId },
          ),
        });
        if (res.ok) {
          const data = (await res.json().catch(() => ({}))) as { triggeredBotIds?: number[] };
          setText("");
          clearFile();
          await load(false);
          await refreshUnread();
          const toCall = data.triggeredBotIds?.length ? data.triggeredBotIds : [bot.userId];
          void triggerBotReplies(toCall, snapPeer, snapRoom);
        } else {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error ?? "Не удалось отправить");
        }
      } finally {
        setSending(false);
      }
      return;
    }
    setText((prev) => (prev ? `${prev} @${bot.name} ` : `@${bot.name} `));
  };

  /** Перейти к найденному сообщению: показать окно переписки вокруг него. */
  const openAround = async (messageId: number) => {
    setSearching(true);
    setError(null);
    try {
      const res = await fetch(buildChatQuery({ around: messageId }), { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        messages: Msg[];
        peerReadId?: number;
        generalReaders?: Readers;
        roomReaders?: Readers;
        context?: { hasOlder: boolean; hasNewer: boolean };
      };
      const list = applyMessages(data);
      setMsgs(list);
      lastId.current = list.at(-1)?.id ?? 0;
      setContext(data.context ?? null);
      setHighlightId(messageId);
      setResults([]);
      setSearchOpen(false);
      setQuery("");
      requestAnimationFrame(() => {
        nodes.current.get(messageId)?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    } finally {
      setSearching(false);
    }
  };

  const backToLatest = async () => {
    setHighlightId(null);
    setContext(null);
    setLoading(true);
    await load(true);
  };

  /* -------------------- Управление комнатами и ботами -------------------- */

  const submitCreateRoom = async () => {
    if (!roomForm.name.trim() || roomBusy) return;
    setRoomBusy(true);
    setRoomError(null);
    try {
      const res = await fetch("/api/chat/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: roomForm.name.trim(),
          description: roomForm.description.trim(),
          kind: roomForm.kind,
          memberIds: roomForm.memberIds,
          botIds: roomForm.botIds,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { room?: ChatRoom; error?: string };
      if (!res.ok || !data.room) {
        setRoomError(data.error ?? "Не удалось создать чат");
        return;
      }
      setCreateRoomOpen(false);
      setRoomForm({ name: "", description: "", kind: "group", memberIds: [], botIds: [] });
      await refreshMetadata();
      selectTarget({ type: "room", roomId: data.room.id });
    } catch {
      setRoomError("Нет связи с сервером");
    } finally {
      setRoomBusy(false);
    }
  };

  const toggleGeneralBot = async (botUserId: number, currentlyConnected: boolean) => {
    setManageBusy(true);
    setManageError(null);
    try {
      const res = currentlyConnected
        ? await fetch(`/api/chat/general-bots?botId=${botUserId}`, { method: "DELETE" })
        : await fetch("/api/chat/general-bots", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ botId: botUserId }),
          });
      const data = (await res.json().catch(() => ({}))) as { botIds?: number[]; error?: string };
      if (!res.ok) {
        setManageError(data.error ?? "Не удалось обновить ботов общего чата");
        return;
      }
      if (Array.isArray(data.botIds)) setGeneralBotIds(data.botIds);
      else await refreshMetadata();
    } finally {
      setManageBusy(false);
    }
  };

  const patchRoom = async (roomTargetId: number, payload: Record<string, unknown>) => {
    setManageBusy(true);
    setManageError(null);
    try {
      const res = await fetch(`/api/chat/rooms/${roomTargetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { room?: ChatRoom; error?: string };
      if (!res.ok) {
        setManageError(data.error ?? "Не удалось обновить чат");
        return;
      }
      await refreshMetadata();
    } finally {
      setManageBusy(false);
    }
  };

  const deleteRoom = async (roomTargetId: number) => {
    setManageBusy(true);
    setManageError(null);
    try {
      const res = await fetch(`/api/chat/rooms/${roomTargetId}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setManageError(data.error ?? "Не удалось удалить чат");
        return;
      }
      setManageOpen(false);
      await refreshMetadata();
      selectTarget({ type: "general" });
    } finally {
      setManageBusy(false);
    }
  };

  const openCreateBotModal = () => {
    setEditingBotId(null);
    setBotError(null);
    setBotModels([]);
    setBotForm({
      name: "",
      position: "ИИ-помощник",
      bio: "",
      avatarColor: "#06b6d4",
      provider: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "",
      clearApiKey: false,
      hasExistingKey: false,
      existingKeyHint: "",
      model: "qwen3:8b",
      systemPrompt: "Ты полезный ИИ-помощник команды в CRM. Отвечай чётко, дружелюбно и по делу.",
      replyMode: "mention",
      isActive: true,
    });
    setBotModalOpen(true);
  };

  const openEditBotModal = (bot: ChatBot) => {
    setEditingBotId(bot.userId);
    setBotError(null);
    setBotModels([]);
    setBotForm({
      name: bot.name,
      position: bot.position ?? "ИИ-помощник",
      bio: bot.bio ?? "",
      avatarColor: bot.avatarColor || "#06b6d4",
      provider: bot.provider ?? "local",
      baseUrl: bot.baseUrl ?? "",
      apiKey: "",
      clearApiKey: false,
      hasExistingKey: Boolean(bot.hasApiKey),
      existingKeyHint: bot.apiKeyHint ?? "",
      model: bot.model ?? "",
      systemPrompt: bot.systemPrompt ?? "",
      replyMode: bot.replyMode ?? "mention",
      isActive: bot.isActive !== false,
    });
    setBotModalOpen(true);
  };

  const fetchBotModels = async () => {
    if (botFetchingModels || !botForm.baseUrl.trim()) return;
    setBotFetchingModels(true);
    setBotError(null);
    try {
      const res = await fetch("/api/ai/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: botForm.baseUrl.trim(),
          ...(botForm.apiKey.trim() ? { apiKey: botForm.apiKey.trim() } : {}),
        }),
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as { models?: string[]; error?: string };
      if (!res.ok) {
        setBotError(data.error ?? "Не удалось получить список моделей");
        return;
      }
      if (Array.isArray(data.models)) {
        setBotModels(data.models);
        if (!botForm.model.trim() && data.models[0]) {
          setBotForm((prev) => ({ ...prev, model: data.models![0] }));
        }
      }
    } finally {
      setBotFetchingModels(false);
    }
  };

  const submitBotForm = async () => {
    if (!botForm.name.trim() || botBusy) return;
    setBotBusy(true);
    setBotError(null);
    try {
      const payload = {
        name: botForm.name.trim(),
        position: botForm.position.trim() || "ИИ-модель (бот)",
        bio: botForm.bio.trim() || null,
        avatarColor: botForm.avatarColor,
        provider: botForm.provider,
        baseUrl: botForm.baseUrl.trim(),
        ...(botForm.apiKey.trim() ? { apiKey: botForm.apiKey.trim() } : {}),
        ...(botForm.clearApiKey ? { clearApiKey: true } : {}),
        model: botForm.model.trim(),
        systemPrompt: botForm.systemPrompt,
        replyMode: botForm.replyMode,
        isActive: botForm.isActive,
      };
      const res = editingBotId
        ? await fetch(`/api/chat/bots/${editingBotId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/chat/bots", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const data = (await res.json().catch(() => ({}))) as { bot?: ChatBot; error?: string };
      if (!res.ok) {
        setBotError(data.error ?? "Не удалось сохранить модель-бота");
        return;
      }
      setBotModalOpen(false);
      await refreshMetadata();
    } finally {
      setBotBusy(false);
    }
  };

  const removeBot = async (botUserId: number) => {
    if (botBusy) return;
    setBotBusy(true);
    setBotError(null);
    try {
      const res = await fetch(`/api/chat/bots/${botUserId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setBotError(data.error ?? "Не удалось удалить бота");
        return;
      }
      setBotModalOpen(false);
      if (target.type === "peer" && target.peerId === botUserId) {
        selectTarget({ type: "general" });
      }
      await refreshMetadata();
    } finally {
      setBotBusy(false);
    }
  };

  /* --------------------------- Вычисления UI --------------------------- */

  const activeRoom = target.type === "room" ? rooms.find((r) => r.id === target.roomId) ?? null : null;
  const peerUser = target.type === "peer" ? users.find((u) => u.id === target.peerId) ?? null : null;
  const peerBot = target.type === "peer" ? bots.find((b) => b.userId === target.peerId) ?? null : null;

  const botIdsSet = useMemo(() => new Set(bots.map((b) => b.userId)), [bots]);

  const activeChatBots = useMemo(() => {
    if (target.type === "general") {
      return bots.filter((b) => b.isActive && generalBotIds.includes(b.userId));
    }
    if (target.type === "room" && activeRoom) {
      const memberIds = new Set(activeRoom.members.map((m) => m.userId));
      return bots.filter((b) => b.isActive && memberIds.has(b.userId));
    }
    return [];
  }, [target.type, bots, generalBotIds, activeRoom]);

  const others = useMemo(() => users.filter((u) => u.id !== meId), [users, meId]);
  const needle = peerFilter.trim().toLowerCase();

  const visibleRooms = useMemo(
    () => (needle ? rooms.filter((r) => `${r.name} ${r.description}`.toLowerCase().includes(needle)) : rooms),
    [rooms, needle],
  );
  const visibleBots = useMemo(
    () => (needle ? bots.filter((b) => `${b.name} ${b.position ?? ""} ${b.model}`.toLowerCase().includes(needle)) : bots),
    [bots, needle],
  );
  const visibleOthers = useMemo(
    () =>
      needle
        ? others.filter((u) => `${u.name} ${u.position ?? ""} ${u.email}`.toLowerCase().includes(needle))
        : others,
    [others, needle],
  );

  const convList = useProgressiveList(visibleOthers, { initial: 8, step: 10, resetKey: peerFilter });
  const unreadFor = (id: number) => unread[String(id)] ?? 0;
  const roomUnreadFor = (id: number) => roomUnread[String(id)] ?? 0;
  const totalUnread =
    Object.values(unread).reduce((sum, value) => sum + value, 0) +
    Object.values(roomUnread).reduce((sum, value) => sum + value, 0);

  const readersOf = (message: Msg) => {
    if (target.type === "room") return roomReaders.filter((r) => r.lastReadId >= message.id).length;
    if (target.type === "general") return generalReaders.filter((r) => r.lastReadId >= message.id).length;
    return message.id <= peerReadId ? null : 0;
  };

  const mobileSelectValue =
    target.type === "room" ? `room:${target.roomId}` : target.type === "peer" ? `peer:${target.peerId}` : "peer:0";

  return (
    <div className="flex h-[600px] w-full min-w-0 overflow-hidden rounded-2xl border border-border bg-card sm:h-[680px]">
      {/* Список чатов */}
      <div className="hidden w-64 shrink-0 flex-col border-r border-border sm:flex">
        <p className="flex items-center justify-between px-4 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">
          Чаты
          {totalUnread > 0 && (
            <span className="rounded-md bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent2">
              {totalUnread}
            </span>
          )}
        </p>
        <div className="px-2 pb-2">
          <div className="relative">
            <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={peerFilter}
              onChange={(e) => setPeerFilter(e.target.value)}
              placeholder="Найти чат, бота, коллегу..."
              className="h-8 w-full rounded-lg border border-border bg-card2 pl-7 pr-2 text-[11px] outline-none focus:border-accent focus:ring-2 focus:ring-[var(--ring)]"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          <button
            type="button"
            onClick={() => selectTarget({ type: "general" })}
            className={cn(
              "mb-1 flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm",
              target.type === "general" ? "bg-accent/15 text-text" : "text-muted hover:bg-card2 hover:text-text",
            )}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#7c5cff] to-[#a78bfa] text-white">
              <Hash size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">Общий чат</span>
              {generalBotIds.length > 0 && (
                <span className="block truncate text-[10px] text-cyan-400">
                  ботов: {generalBotIds.length}
                </span>
              )}
            </span>
            {unreadFor(0) > 0 && <UnreadBadge count={unreadFor(0)} />}
          </button>

          {/* Групповые и общие чаты (создать может любой сотрудник) */}
          <div className="flex items-center justify-between px-2 pb-1 pt-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Группы и общие</p>
            <button
              type="button"
              onClick={() => {
                setRoomError(null);
                setCreateRoomOpen(true);
              }}
              className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-accent2 hover:bg-accent/10"
              title="Создать группу или общий чат для нескольких человек"
            >
              <Plus size={11} /> Создать
            </button>
          </div>
          {visibleRooms.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => selectTarget({ type: "room", roomId: r.id })}
              className={cn(
                "mb-0.5 flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm",
                target.type === "room" && target.roomId === r.id
                  ? "bg-accent/15 text-text"
                  : "text-muted hover:bg-card2 hover:text-text",
              )}
            >
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white",
                  r.kind === "shared" ? "bg-emerald-600/80" : "bg-indigo-600/80",
                )}
              >
                {r.kind === "shared" ? <Globe size={13} /> : <Lock size={12} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{r.name}</span>
                <span className="block truncate text-[10px] opacity-70">
                  {r.kind === "shared" ? "общий чат" : "группа"} · {r.members.length} уч.
                </span>
              </span>
              {roomUnreadFor(r.id) > 0 && <UnreadBadge count={roomUnreadFor(r.id)} />}
            </button>
          ))}
          {visibleRooms.length === 0 && (
            <p className="px-2 py-1 text-[10px] text-muted/80">Групп пока нет</p>
          )}

          {/* Модели-боты (создаёт и настраивает только super_admin; писать и добавлять в чаты могут все) */}
          <div className="flex items-center justify-between px-2 pb-1 pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Модели-боты</p>
            {isSuperAdmin && (
              <button
                type="button"
                onClick={openCreateBotModal}
                className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-cyan-400 hover:bg-cyan-500/10"
                title="Создать и настроить нового ИИ-бота"
              >
                <Plus size={11} /> Бот
              </button>
            )}
          </div>
          {visibleBots.map((b) => (
            <div
              key={b.userId}
              className={cn(
                "group mb-0.5 flex items-center gap-1 rounded-xl pr-1",
                target.type === "peer" && target.peerId === b.userId
                  ? "bg-accent/15 text-text"
                  : "text-muted hover:bg-card2 hover:text-text",
              )}
            >
              <button
                type="button"
                onClick={() => selectTarget({ type: "peer", peerId: b.userId })}
                className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-sm"
              >
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white"
                  style={{ backgroundColor: b.avatarColor }}
                >
                  <Bot size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1">
                    <span className="truncate text-xs font-medium">{b.name}</span>
                    {!b.isActive && <span className="text-[9px] text-amber-500">выкл</span>}
                  </span>
                  <span className="block truncate text-[10px] opacity-70">{b.model || b.position || "ИИ-бот"}</span>
                </span>
                {unreadFor(b.userId) > 0 && <UnreadBadge count={unreadFor(b.userId)} />}
              </button>
              {isSuperAdmin && (
                <button
                  type="button"
                  onClick={() => openEditBotModal(b)}
                  className="rounded-lg p-1 text-muted opacity-70 transition hover:bg-card hover:text-text group-hover:opacity-100"
                  title="Настроить модель-бота"
                  aria-label={`Настроить бота ${b.name}`}
                >
                  <Settings2 size={12} />
                </button>
              )}
            </div>
          ))}
          {visibleBots.length === 0 && (
            <p className="px-2 py-1 text-[10px] text-muted/80">
              {isSuperAdmin ? "Нажмите «+ Бот», чтобы добавить модель" : "Ботов пока нет"}
            </p>
          )}

          {/* Личные переписки с коллегами */}
          <p className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-muted">Личные</p>
          {convList.items.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => selectTarget({ type: "peer", peerId: u.id })}
              className={cn(
                "mb-0.5 flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm",
                target.type === "peer" && target.peerId === u.id
                  ? "bg-accent/15 text-text"
                  : "text-muted hover:bg-card2 hover:text-text",
              )}
            >
              <Avatar name={u.name} color={u.avatarColor} url={u.avatarUrl} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{u.name}</span>
                <span className="block truncate text-[10px] opacity-70">{u.position || "—"}</span>
              </span>
              {unreadFor(u.id) > 0 && <UnreadBadge count={unreadFor(u.id)} />}
            </button>
          ))}
          <LoadMore
            shown={convList.shown}
            total={convList.total}
            hasMore={convList.hasMore}
            loading={convList.loading}
            onShowMore={convList.showMore}
            sentinelRef={convList.sentinelRef}
            initial={8}
            unit="чатов"
            className="px-2 pb-1"
          />
          {visibleOthers.length === 0 && (
            <p className="px-2 py-3 text-center text-[11px] text-muted">Никого не нашли</p>
          )}
        </div>
      </div>

      {/* Переписка */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5 sm:px-4 sm:py-3">
          <select
            value={mobileSelectValue}
            onChange={(e) => {
              const val = e.target.value;
              if (val.startsWith("room:")) selectTarget({ type: "room", roomId: Number(val.slice(5)) });
              else {
                const pid = Number(val.slice(5)) || 0;
                selectTarget(pid === 0 ? { type: "general" } : { type: "peer", peerId: pid });
              }
            }}
            className="min-w-0 max-w-[52%] rounded-lg border border-border bg-card2 px-2 py-1 text-xs sm:hidden"
          >
            <option value="peer:0">Общий чат{unreadFor(0) ? ` (${unreadFor(0)})` : ""}</option>
            {rooms.map((r) => (
              <option key={`r-${r.id}`} value={`room:${r.id}`}>
                [{r.kind === "shared" ? "Общий" : "Группа"}] {r.name}
                {roomUnreadFor(r.id) ? ` (${roomUnreadFor(r.id)})` : ""}
              </option>
            ))}
            {bots.map((b) => (
              <option key={`b-${b.userId}`} value={`peer:${b.userId}`}>
                [Бот] {b.name}
                {unreadFor(b.userId) ? ` (${unreadFor(b.userId)})` : ""}
              </option>
            ))}
            {others.map((u) => (
              <option key={`u-${u.id}`} value={`peer:${u.id}`}>
                {u.name}
                {unreadFor(u.id) ? ` (${unreadFor(u.id)})` : ""}
              </option>
            ))}
          </select>

          <div className="hidden min-w-0 items-center gap-2 sm:flex">
            {activeRoom ? (
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white",
                  activeRoom.kind === "shared" ? "bg-emerald-600/85" : "bg-indigo-600/85",
                )}
              >
                {activeRoom.kind === "shared" ? <Globe size={14} /> : <Lock size={14} />}
              </span>
            ) : peerBot ? (
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white"
                style={{ backgroundColor: peerBot.avatarColor }}
              >
                <Bot size={15} />
              </span>
            ) : peerUser ? (
              <Avatar name={peerUser.name} color={peerUser.avatarColor} url={peerUser.avatarUrl} size={30} />
            ) : (
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#7c5cff] to-[#a78bfa] text-white">
                <Hash size={14} />
              </span>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-sm font-semibold">
                  {activeRoom
                    ? activeRoom.name
                    : peerBot
                      ? peerBot.name
                      : peerUser
                        ? peerUser.name
                        : "Общий чат"}
                </p>
                {peerBot && (
                  <Badge className="border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0 text-[9px] text-cyan-400">
                    БОТ
                  </Badge>
                )}
                {activeRoom && (
                  <Badge className="border-border px-1.5 py-0 text-[9px] text-muted">
                    {activeRoom.kind === "shared" ? "общий чат" : "группа"}
                  </Badge>
                )}
              </div>
              <p className="truncate text-[11px] text-muted">
                {activeRoom
                  ? `${activeRoom.members.length} участников${activeChatBots.length ? ` · ботов: ${activeChatBots.length}` : ""}`
                  : peerBot
                    ? `${peerBot.position || "ИИ-модель"}${peerBot.model ? ` · ${peerBot.model}` : ""}`
                    : peerUser
                      ? peerUser.position || peerUser.email
                      : `${users.length} участников${activeChatBots.length ? ` · ботов: ${activeChatBots.length}` : ""}`}
              </p>
            </div>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {(target.type === "general" || target.type === "room") && (
              <button
                type="button"
                onClick={() => {
                  setManageError(null);
                  setManageName(activeRoom?.name ?? "");
                  setManageOpen(true);
                }}
                className="flex h-8 items-center gap-1 rounded-lg border border-border bg-card2 px-2 text-[11px] font-medium text-muted transition hover:border-accent/50 hover:text-text"
                title={
                  target.type === "general"
                    ? "Подключить или убрать ботов в общем чате"
                    : "Участники и боты этого чата"
                }
              >
                <Users size={13} />
                <span className="hidden md:inline">
                  {target.type === "general" ? "Боты" : "Участники и боты"}
                </span>
              </button>
            )}
            {target.type === "peer" && peerBot && isSuperAdmin && (
              <button
                type="button"
                onClick={() => openEditBotModal(peerBot)}
                className="flex h-8 items-center gap-1 rounded-lg border border-border bg-card2 px-2 text-[11px] font-medium text-muted transition hover:border-accent/50 hover:text-text"
              >
                <Settings2 size={13} /> Настроить бота
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setCreateRoomOpen(true);
                setRoomError(null);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card2 text-muted transition hover:text-text sm:hidden"
              title="Создать группу или общий чат"
            >
              <Plus size={14} />
            </button>
            <button
              type="button"
              onClick={() => {
                setSearchOpen((open) => !open);
                if (searchOpen) {
                  updateQuery("");
                  setResults([]);
                }
              }}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-lg transition",
                searchOpen ? "bg-accent/15 text-accent2" : "text-muted hover:bg-card2 hover:text-text",
              )}
              title="Поиск по переписке"
            >
              <Search size={15} />
            </button>
          </div>
        </div>

        {searchOpen && (
          <div className="border-b border-border bg-card2/50 px-3 py-2">
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={query}
                onChange={(e) => updateQuery(e.target.value)}
                placeholder={
                  activeRoom
                    ? `Поиск в чате «${activeRoom.name}»...`
                    : peerBot
                      ? `Поиск в переписке с ботом ${peerBot.name}...`
                      : peerUser
                        ? `Поиск в переписке с ${peerUser.name}...`
                        : "Поиск в общем чате..."
                }
                autoFocus
                className="h-9 w-full rounded-lg border border-border bg-card pl-8 pr-8 text-xs outline-none focus:border-accent focus:ring-2 focus:ring-[var(--ring)]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    updateQuery("");
                    setResults([]);
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:text-text"
                  title="Очистить"
                >
                  <X size={13} />
                </button>
              )}
            </div>
            {query.trim().length >= SEARCH_MIN && (
              <div className="mt-2 max-h-44 overflow-y-auto rounded-xl border border-border bg-card">
                {searching && results.length === 0 ? (
                  <p className="px-3 py-3 text-center text-[11px] text-muted">Ищем...</p>
                ) : results.length === 0 ? (
                  <p className="px-3 py-3 text-center text-[11px] text-muted">Ничего не найдено</p>
                ) : (
                  <>
                    <p className="border-b border-border/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                      Найдено: {results.length}
                    </p>
                    {results.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => void openAround(m.id)}
                        className="block w-full border-b border-border/60 px-3 py-2 text-left transition last:border-0 hover:bg-card2"
                      >
                        <span className="flex items-center justify-between gap-2 text-[10px] text-muted">
                          <span className="truncate">{m.senderName}</span>
                          <span className="shrink-0">
                            {formatDate(dateToStr(new Date(m.createdAt)))} · {formatTime(m.createdAt)}
                          </span>
                        </span>
                        <span className="mt-0.5 line-clamp-2 block text-xs text-text">
                          {m.content ? highlightMatch(m.content, query) : m.attachment ? m.attachment.name : "—"}
                        </span>
                        {m.content && m.attachment && (
                          <span className="mt-0.5 flex items-center gap-1 text-[10px] text-muted">
                            <Paperclip size={10} /> {m.attachment.name}
                          </span>
                        )}
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {context && (
          <div className="flex items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-500">
            <span className="truncate">
              Показан фрагмент переписки{context.hasNewer ? " — есть более новые сообщения" : ""}
            </span>
            <button type="button" onClick={() => void backToLatest()} className="shrink-0 font-medium underline">
              К последним
            </button>
          </div>
        )}

        {activeRoom && !activeRoom.isMember && activeRoom.kind === "shared" && (
          <div className="flex items-center justify-between gap-2 border-b border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[11px] text-emerald-500">
            <span>Это открытый общий чат команды — можно читать и сразу писать или присоединиться.</span>
            <button
              type="button"
              disabled={manageBusy}
              onClick={() => void patchRoom(activeRoom.id, { action: "join" })}
              className="shrink-0 rounded-md bg-emerald-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-emerald-500"
            >
              Присоединиться
            </button>
          </div>
        )}

        <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3 sm:px-4 sm:py-4">
          {hasOlder && !context && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] text-muted transition hover:bg-card2 hover:text-text disabled:opacity-60"
              >
                {loadingOlder ? <Loader2 size={12} className="animate-spin" /> : <ChevronUp size={12} />}
                {loadingOlder ? "Загружаем..." : "Показать более ранние"}
              </button>
            </div>
          )}
          {loading && <p className="text-center text-xs text-muted">Загрузка...</p>}
          {!loading && msgs.length === 0 && (
            <p className="py-10 text-center text-xs text-muted">
              {peerBot
                ? `Напишите боту ${peerBot.name} — модель ответит в этом чате.`
                : "Сообщений пока нет. Напишите первым!"}
            </p>
          )}
          {msgs.map((m, index) => {
            const mine = m.senderId === meId;
            const isBotSender = botIdsSet.has(m.senderId);
            const day = dateToStr(new Date(m.createdAt));
            const prev = index > 0 ? dateToStr(new Date(msgs[index - 1].createdAt)) : null;
            const showDay = day !== prev;
            const readers = readersOf(m);
            const showSenderLabel = !mine && (target.type === "general" || target.type === "room");
            return (
              <div
                key={m.id}
                data-mid={m.id}
                ref={(node) => {
                  if (node) nodes.current.set(m.id, node);
                  else nodes.current.delete(m.id);
                }}
              >
                {showDay && (
                  <div className="my-2 text-center text-[10px] font-medium uppercase tracking-wide text-muted">
                    {formatDate(day)}
                  </div>
                )}
                <div
                  className={cn(
                    "flex items-end gap-2 rounded-xl transition",
                    mine && "flex-row-reverse",
                    highlightId === m.id && "bg-amber-400/20 ring-1 ring-amber-400/40",
                  )}
                >
                  {isBotSender ? (
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white"
                      style={{ backgroundColor: m.senderColor }}
                    >
                      <Bot size={14} />
                    </span>
                  ) : (
                    <Avatar name={m.senderName} color={m.senderColor} url={m.senderAvatar} size={28} />
                  )}
                  <div
                    className={cn(
                      "max-w-[78%] min-w-0 rounded-2xl px-3 py-2 text-sm",
                      mine
                        ? "rounded-br-sm bg-gradient-to-br from-[#7c5cff] to-[#8f6cff] text-white"
                        : isBotSender
                          ? "rounded-bl-sm border border-cyan-500/30 bg-cyan-500/5"
                          : "rounded-bl-sm border border-border bg-card2",
                    )}
                  >
                    {showSenderLabel && (
                      <p className="mb-0.5 flex items-center gap-1.5 text-[11px] font-semibold text-accent2">
                        <span>{m.senderName}</span>
                        {isBotSender && (
                          <span className="rounded bg-cyan-500/15 px-1 py-0 text-[9px] font-semibold uppercase text-cyan-400">
                            Бот
                          </span>
                        )}
                      </p>
                    )}
                    {m.content && <p className="whitespace-pre-wrap break-words">{m.content}</p>}
                    {m.attachment && (
                      <div className={cn(m.content && "mt-1.5")}>
                        {isImage(m.attachment.mime) ? (
                          <a href={`/api/chat/attachment/${m.attachment.id}`} target="_blank" rel="noreferrer" title={m.attachment.name}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={`/api/chat/attachment/${m.attachment.id}`}
                              alt={m.attachment.name}
                              loading="lazy"
                              className="max-h-60 w-auto max-w-full rounded-xl border border-black/10 object-cover"
                            />
                          </a>
                        ) : (
                          <a
                            href={`/api/chat/attachment/${m.attachment.id}`}
                            target="_blank"
                            rel="noreferrer"
                            className={cn(
                              "flex min-w-0 items-center gap-2 rounded-xl border px-2.5 py-2 text-xs",
                              mine ? "border-white/30 bg-white/15 text-white" : "border-border bg-card text-text",
                            )}
                          >
                            <FileText size={16} className="shrink-0" />
                            <span className="min-w-0 flex-1 truncate">{m.attachment.name}</span>
                            <span className={cn("shrink-0 text-[10px]", mine ? "text-white/70" : "text-muted")}>
                              {formatSize(m.attachment.size)}
                            </span>
                          </a>
                        )}
                      </div>
                    )}
                    <div
                      className={cn(
                        "mt-1 flex items-center justify-end gap-1 text-[10px]",
                        mine ? "text-white/70" : "text-muted",
                      )}
                    >
                      <span>{formatTime(m.createdAt)}</span>
                      {mine &&
                        readers !== null &&
                        (target.type === "general" || target.type === "room" ? (
                          readers > 0 && (
                            <span title={`Прочитали: ${readers}`} className="flex items-center gap-0.5">
                              <CheckCheck size={12} />
                              {readers}
                            </span>
                          )
                        ) : readers ? (
                          <span title="Прочитано" className="flex items-center">
                            <CheckCheck size={12} />
                          </span>
                        ) : (
                          <span title="Отправлено" className="flex items-center">
                            <Check size={12} />
                          </span>
                        ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}

          {replyingBots.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-cyan-400">
              <Loader2 size={13} className="animate-spin" />
              <span>
                {replyingBots
                  .map((id) => bots.find((b) => b.userId === id)?.name ?? "Модель-бот")
                  .join(", ")}{" "}
                печатает…
              </span>
            </div>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="border-t border-border p-3"
        >
          {activeChatBots.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
              <span className="flex items-center gap-1">
                <Bot size={11} className="text-cyan-400" /> Боты в чате:
              </span>
              {activeChatBots.map((b) => (
                <button
                  key={b.userId}
                  type="button"
                  onClick={() => void askBotNow(b)}
                  className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 font-medium text-cyan-400 transition hover:bg-cyan-500/20"
                  title={
                    b.replyMode === "always"
                      ? `${b.name} отвечает на каждое сообщение (нажмите, чтобы упомянуть)`
                      : `Упомянуть @${b.name} или отправить ему вопрос`
                  }
                >
                  @{b.name}
                </button>
              ))}
            </div>
          )}
          {file && (
            <div className="mb-2 flex min-w-0 items-center gap-2 rounded-xl border border-border bg-card2 px-2.5 py-1.5 text-xs">
              {filePreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={filePreview} alt={file.name} className="h-8 w-8 shrink-0 rounded-lg object-cover" />
              ) : (
                <FileText size={16} className="shrink-0 text-muted" />
              )}
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              <span className="shrink-0 text-[10px] text-muted">{formatSize(file.size)}</span>
              <button
                type="button"
                onClick={clearFile}
                className="shrink-0 rounded p-0.5 text-muted hover:text-red-500"
                title="Убрать файл"
              >
                <X size={13} />
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <label
              className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-border bg-card2 text-muted transition hover:text-text"
              title={unlimited ? "Прикрепить файл или картинку (без лимита)" : "Прикрепить файл или картинку (до 5 МБ)"}
            >
              <Paperclip size={16} />
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  pickFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={
                activeRoom
                  ? `Сообщение в «${activeRoom.name}»...`
                  : peerBot
                    ? `Спросить бота ${peerBot.name}...`
                    : peerUser
                      ? `Сообщение для ${peerUser.name}...`
                      : "Сообщение в общий чат... (для бота напишите @Имя)"
              }
              rows={1}
              className="max-h-32 min-h-[40px] min-w-0 flex-1 resize-none rounded-xl border border-border bg-card2 px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <Button type="submit" size="icon" disabled={sending || (!text.trim() && !file)} title="Отправить">
              <Send size={16} />
            </Button>
          </div>
          {error && <p className="mt-1.5 text-[11px] text-red-500">{error}</p>}
        </form>
      </div>

      {/* Модалка: Создать групповой или общий чат */}
      <Modal
        open={createRoomOpen}
        onClose={() => setCreateRoomOpen(false)}
        title="Создать группу или общий чат"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setCreateRoomOpen(false)}>
              Отмена
            </Button>
            <Button size="sm" onClick={() => void submitCreateRoom()} disabled={roomBusy || !roomForm.name.trim()}>
              {roomBusy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              Создать чат
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Название чата *">
            <Input
              value={roomForm.name}
              onChange={(e) => setRoomForm({ ...roomForm, name: e.target.value })}
              placeholder="Например: Отдел продаж или Спринт №12"
              autoFocus
            />
          </Field>

          <Field label="Тип чата">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setRoomForm({ ...roomForm, kind: "group" })}
                className={cn(
                  "flex items-start gap-2 rounded-xl border p-2.5 text-left transition",
                  roomForm.kind === "group"
                    ? "border-accent/50 bg-accent/10 text-text"
                    : "border-border bg-card2 text-muted hover:text-text",
                )}
              >
                <Lock size={15} className="mt-0.5 shrink-0 text-indigo-400" />
                <span>
                  <span className="block text-xs font-semibold">Закрытая группа</span>
                  <span className="block text-[10px] opacity-80">Видна только выбранным участникам</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setRoomForm({ ...roomForm, kind: "shared" })}
                className={cn(
                  "flex items-start gap-2 rounded-xl border p-2.5 text-left transition",
                  roomForm.kind === "shared"
                    ? "border-emerald-500/50 bg-emerald-500/10 text-text"
                    : "border-border bg-card2 text-muted hover:text-text",
                )}
              >
                <Globe size={15} className="mt-0.5 shrink-0 text-emerald-400" />
                <span>
                  <span className="block text-xs font-semibold">Общий чат</span>
                  <span className="block text-[10px] opacity-80">Открытая комната для всех коллег</span>
                </span>
              </button>
            </div>
          </Field>

          <Field label="Описание (необязательно)">
            <Input
              value={roomForm.description}
              onChange={(e) => setRoomForm({ ...roomForm, description: e.target.value })}
              placeholder="Тема или назначение чата"
            />
          </Field>

          <Field label="Участники (сотрудники)">
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-border bg-card2/60 p-2">
              {others.map((u) => {
                const checked = roomForm.memberIds.includes(u.id);
                return (
                  <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-xs hover:bg-card">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) =>
                        setRoomForm((prev) => ({
                          ...prev,
                          memberIds: e.target.checked
                            ? [...prev.memberIds, u.id]
                            : prev.memberIds.filter((id) => id !== u.id),
                        }))
                      }
                      className="h-3.5 w-3.5 accent-[#7c5cff]"
                    />
                    <Avatar name={u.name} color={u.avatarColor} url={u.avatarUrl} size={22} />
                    <span className="min-w-0 flex-1 truncate">{u.name}</span>
                    <span className="text-[10px] text-muted">{u.position || ""}</span>
                  </label>
                );
              })}
            </div>
          </Field>

          {bots.length > 0 && (
            <Field label="Подключить ИИ-ботов (можно позже)">
              <div className="max-h-32 space-y-1 overflow-y-auto rounded-xl border border-border bg-card2/60 p-2">
                {bots.map((b) => {
                  const checked = roomForm.botIds.includes(b.userId);
                  return (
                    <label key={b.userId} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-xs hover:bg-card">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setRoomForm((prev) => ({
                            ...prev,
                            botIds: e.target.checked
                              ? [...prev.botIds, b.userId]
                              : prev.botIds.filter((id) => id !== b.userId),
                          }))
                        }
                        className="h-3.5 w-3.5 accent-[#7c5cff]"
                      />
                      <Bot size={14} className="text-cyan-400" />
                      <span className="min-w-0 flex-1 truncate">{b.name}</span>
                      <span className="text-[10px] text-muted">{b.model}</span>
                    </label>
                  );
                })}
              </div>
            </Field>
          )}

          {roomError && <p className="text-xs text-red-500">{roomError}</p>}
        </div>
      </Modal>

      {/* Модалка: Участники и боты текущего чата */}
      <Modal
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        title={activeRoom ? `Настройки чата «${activeRoom.name}»` : "Боты в Общем чате"}
        footer={
          <Button variant="ghost" size="sm" onClick={() => setManageOpen(false)}>
            Закрыть
          </Button>
        }
      >
        {target.type === "general" && (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              Выберите моделей-ботов, которые могут отвечать в общем чате. Отключить или подключить бота может любой сотрудник.
            </p>
            {bots.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border py-6 text-center text-xs text-muted">
                Моделей-ботов пока нет. Их настраивает главный администратор.
              </p>
            ) : (
              <div className="space-y-1.5">
                {bots.map((b) => {
                  const connected = generalBotIds.includes(b.userId);
                  return (
                    <div
                      key={b.userId}
                      className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card2/60 px-3 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white"
                          style={{ backgroundColor: b.avatarColor }}
                        >
                          <Bot size={14} />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold">{b.name}</p>
                          <p className="truncate text-[10px] text-muted">
                            {b.model || "модель"} · {b.replyMode === "always" ? "на каждое сообщение" : `по @${b.name}`}
                          </p>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant={connected ? "danger" : "secondary"}
                        disabled={manageBusy}
                        onClick={() => void toggleGeneralBot(b.userId, connected)}
                      >
                        {connected ? "Убрать" : "Добавить"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
            {manageError && <p className="text-xs text-red-500">{manageError}</p>}
          </div>
        )}

        {activeRoom && (() => {
          const canManageRoom = activeRoom.createdBy === meId || isSuperAdmin;
          return (
          <div className="space-y-4">
            {canManageRoom ? (
            <Field label="Название чата">
              <div className="flex gap-2">
                <Input
                  value={manageName}
                  onChange={(e) => setManageName(e.target.value)}
                  className="h-9 flex-1 text-xs"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={manageBusy || !manageName.trim() || manageName.trim() === activeRoom.name}
                  onClick={() => void patchRoom(activeRoom.id, { name: manageName.trim() })}
                >
                  Сохранить
                </Button>
              </div>
            </Field>
            ) : (
              <p className="rounded-xl border border-border bg-card2/50 px-3 py-2 text-[11px] text-muted">
                Управлять составом и названием чата может его создатель или главный администратор.
              </p>
            )}

            <div className="space-y-2">
              <p className="text-xs font-semibold">Текущие участники ({activeRoom.members.length})</p>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-border bg-card2/60 p-2">
                {activeRoom.members.map((m) => (
                  <div key={m.userId} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-xs">
                    <div className="flex min-w-0 items-center gap-2">
                      {m.isBot ? (
                        <Bot size={14} className="shrink-0 text-cyan-400" />
                      ) : (
                        <Avatar name={m.name} color={m.avatarColor} url={m.avatarUrl} size={22} />
                      )}
                      <span className="truncate font-medium">{m.name}</span>
                      {m.isBot && <span className="text-[10px] text-cyan-400">бот</span>}
                    </div>
                    {canManageRoom && m.userId !== meId && (
                      <button
                        type="button"
                        disabled={manageBusy}
                        onClick={() =>
                          void patchRoom(
                            activeRoom.id,
                            m.isBot ? { removeBotId: m.userId } : { removeMemberId: m.userId },
                          )
                        }
                        className="text-[11px] text-red-500 hover:underline"
                      >
                        Убрать
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Добавить коллег */}
            {canManageRoom && others.some((u) => !activeRoom.members.some((m) => m.userId === u.id)) && (
              <div className="space-y-2">
                <p className="text-xs font-semibold">Добавить сотрудника</p>
                <div className="flex flex-wrap gap-1.5">
                  {others
                    .filter((u) => !activeRoom.members.some((m) => m.userId === u.id))
                    .map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        disabled={manageBusy}
                        onClick={() => void patchRoom(activeRoom.id, { addMemberIds: [u.id] })}
                        className="flex items-center gap-1 rounded-lg border border-border bg-card2 px-2 py-1 text-[11px] hover:border-accent/50"
                      >
                        <UserPlus size={11} /> {u.name}
                      </button>
                    ))}
                </div>
              </div>
            )}

            {/* Подключить ботов */}
            {canManageRoom && bots.some((b) => !activeRoom.members.some((m) => m.userId === b.userId)) && (
              <div className="space-y-2">
                <p className="text-xs font-semibold">Подключить модель-бота</p>
                <div className="flex flex-wrap gap-1.5">
                  {bots
                    .filter((b) => !activeRoom.members.some((m) => m.userId === b.userId))
                    .map((b) => (
                      <button
                        key={b.userId}
                        type="button"
                        disabled={manageBusy}
                        onClick={() => void patchRoom(activeRoom.id, { addBotId: b.userId })}
                        className="flex items-center gap-1 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-400 hover:bg-cyan-500/20"
                      >
                        <Bot size={11} /> + {b.name}
                      </button>
                    ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
              {activeRoom.isMember && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={manageBusy}
                  onClick={() => {
                    void patchRoom(activeRoom.id, { action: "leave" }).then(() => {
                      setManageOpen(false);
                      selectTarget({ type: "general" });
                    });
                  }}
                >
                  Покинуть чат
                </Button>
              )}
              {canManageRoom && (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={manageBusy}
                  onClick={() => {
                    if (confirm(`Удалить чат «${activeRoom.name}» и всю его переписку?`)) {
                      void deleteRoom(activeRoom.id);
                    }
                  }}
                >
                  <Trash2 size={13} /> Удалить чат
                </Button>
              )}
            </div>
            {manageError && <p className="text-xs text-red-500">{manageError}</p>}
          </div>
          );
        })()}
      </Modal>

      {/* Модалка: Настройка модели-бота (только super_admin) */}
      {isSuperAdmin && (
        <Modal
          open={botModalOpen}
          onClose={() => setBotModalOpen(false)}
          wide
          title={editingBotId ? `Настройка бота «${botForm.name}»` : "Новая модель-бот"}
          footer={
            <div className="flex w-full items-center justify-between gap-2">
              {editingBotId ? (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={botBusy}
                  onClick={() => {
                    if (confirm(`Удалить модель-бота «${botForm.name}»?`)) void removeBot(editingBotId);
                  }}
                >
                  <Trash2 size={13} /> Удалить бота
                </Button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setBotModalOpen(false)}>
                  Отмена
                </Button>
                <Button size="sm" onClick={() => void submitBotForm()} disabled={botBusy || !botForm.name.trim()}>
                  {botBusy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  {editingBotId ? "Сохранить бота" : "Создать бота"}
                </Button>
              </div>
            </div>
          }
        >
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Имя бота в чате *">
                <Input
                  value={botForm.name}
                  onChange={(e) => setBotForm({ ...botForm, name: e.target.value })}
                  placeholder="Например: Аналитик или Код-ревьюер"
                  autoFocus
                />
              </Field>
              <Field label="Роль / подпись">
                <Input
                  value={botForm.position}
                  onChange={(e) => setBotForm({ ...botForm, position: e.target.value })}
                  placeholder="ИИ-помощник отдела продаж"
                />
              </Field>
            </div>

            <Field label="Провайдер и подключение модели (скрыто от остальных сотрудников)">
              <div className="grid gap-2 sm:grid-cols-2">
                <select
                  value={botForm.provider}
                  onChange={(e) => {
                    const p = BOT_PROVIDERS.find((x) => x.id === e.target.value);
                    setBotForm((prev) => ({
                      ...prev,
                      provider: e.target.value,
                      baseUrl: p && p.baseUrl ? p.baseUrl : prev.baseUrl,
                      model: p && p.model ? p.model : prev.model,
                    }));
                  }}
                  className="h-10 rounded-xl border border-border bg-card2 px-3 text-sm text-text outline-none focus:border-accent"
                >
                  {BOT_PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <Input
                  value={botForm.baseUrl}
                  onChange={(e) => setBotForm({ ...botForm, baseUrl: e.target.value })}
                  placeholder="http://127.0.0.1:11434/v1"
                />
              </div>
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Модель">
                <div className="flex gap-1.5">
                  {botModels.length > 0 && (
                    <select
                      value={botModels.includes(botForm.model) ? botForm.model : ""}
                      onChange={(e) => e.target.value && setBotForm({ ...botForm, model: e.target.value })}
                      className="h-10 max-w-[48%] rounded-xl border border-border bg-card2 px-2 text-xs text-text"
                    >
                      <option value="">список…</option>
                      {botModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  )}
                  <Input
                    value={botForm.model}
                    onChange={(e) => setBotForm({ ...botForm, model: e.target.value })}
                    placeholder="qwen3:8b / gpt-4o-mini"
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => void fetchBotModels()}
                    disabled={botFetchingModels || !botForm.baseUrl.trim()}
                    title="Подтянуть список моделей с сервера"
                  >
                    {botFetchingModels ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  </Button>
                </div>
              </Field>

              <Field label="API-ключ (хранится закрыто, никто кроме вас не видит)">
                <Input
                  type="password"
                  value={botForm.apiKey}
                  onChange={(e) => setBotForm({ ...botForm, apiKey: e.target.value, clearApiKey: false })}
                  placeholder={
                    botForm.hasExistingKey
                      ? `Сохранён (${botForm.existingKeyHint}) — оставьте пустым, чтобы не менять`
                      : "необязательно для локальной модели"
                  }
                />
                {botForm.hasExistingKey && (
                  <label className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                    <input
                      type="checkbox"
                      checked={botForm.clearApiKey}
                      onChange={(e) => setBotForm({ ...botForm, clearApiKey: e.target.checked })}
                      className="h-3.5 w-3.5 accent-[#7c5cff]"
                    />
                    Удалить сохранённый API-ключ
                  </label>
                )}
              </Field>
            </div>

            <Field label="Системный промпт бота">
              <Textarea
                value={botForm.systemPrompt}
                onChange={(e) => setBotForm({ ...botForm, systemPrompt: e.target.value })}
                rows={3}
                placeholder="Инструкция для модели: роль, стиль ответа, ограничения..."
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Когда бот отвечает в общих и групповых чатах">
                <select
                  value={botForm.replyMode}
                  onChange={(e) =>
                    setBotForm({ ...botForm, replyMode: e.target.value === "always" ? "always" : "mention" })
                  }
                  className="h-10 w-full rounded-xl border border-border bg-card2 px-3 text-sm text-text outline-none focus:border-accent"
                >
                  <option value="mention">Только по упоминанию (@{botForm.name || "Имя"})</option>
                  <option value="always">На каждое новое сообщение в чате</option>
                </select>
                <p className="mt-1 text-[10px] text-muted">В личных сообщениях с ботом он отвечает всегда.</p>
              </Field>

              <Field label="Цвет аватара и статус">
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {AVATAR_COLORS.slice(0, 6).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setBotForm({ ...botForm, avatarColor: c })}
                      className={cn(
                        "h-7 w-7 rounded-full transition",
                        botForm.avatarColor === c && "ring-2 ring-offset-2 ring-offset-card ring-[var(--text)]",
                      )}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={botForm.isActive}
                      onChange={(e) => setBotForm({ ...botForm, isActive: e.target.checked })}
                      className="h-4 w-4 accent-[#7c5cff]"
                    />
                    Активен
                  </label>
                </div>
              </Field>
            </div>

            {botError && <p className="text-xs text-red-500">{botError}</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function UnreadBadge({ count }: { count: number }) {
  return (
    <span
      className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[#7c5cff] px-1.5 text-[10px] font-semibold text-white shadow-[0_2px_8px_-2px_var(--glow)]"
      title={`Непрочитанных: ${count}`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
