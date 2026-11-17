"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CheckCheck, FileText, Hash, Paperclip, Search, Send, X } from "lucide-react";
import type { UserLite } from "@/lib/data";
import { cn, formatDate, formatTime, dateToStr } from "@/lib/utils";
import { Avatar, Button } from "./ui";

type Attachment = { id: number; name: string; mime: string; size: number };

type Msg = {
  id: number;
  senderId: number;
  recipientId: number | null;
  content: string;
  createdAt: string;
  senderName: string;
  senderColor: string;
  senderAvatar: string | null;
  attachment: Attachment | null;
};

type Readers = Array<{ userId: number; lastReadId: number }>;

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SEARCH_MIN = 2;

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

export function ChatClient({ users, meId, initialPeer = 0 }: { users: UserLite[]; meId: number; initialPeer?: number }) {
  const [peer, setPeer] = useState<number>(initialPeer);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [peerReadId, setPeerReadId] = useState(0);
  const [generalReaders, setGeneralReaders] = useState<Readers>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
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

  const [context, setContext] = useState<{ hasOlder: boolean; hasNewer: boolean } | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);

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

  /** Переключение собеседника: сбрасываем переписку, дальше её грузит эффект. */
  const changePeer = useCallback((id: number) => {
    lastId.current = 0;
    lastMarked.current = 0;
    setPeer(id);
    setMsgs([]);
    setLoading(true);
    setQuery("");
    setResults([]);
    setSearching(false);
    setContext(null);
    setHighlightId(null);
  }, []);

  const refreshUnread = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/state", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { unread?: Record<string, number> };
      setUnread(data.unread ?? {});
    } catch {
      /* сеть моргнула — обновимся на следующем тике */
    }
  }, []);

  /** Отметить переписку прочитанной до последнего видимого сообщения. */
  const markRead = useCallback(
    async (targetPeer: number, id: number) => {
      if (id <= 0 || lastMarked.current >= id) return;
      lastMarked.current = id;
      try {
        await fetch("/api/chat/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ peer: targetPeer, id }),
        });
        await refreshUnread();
      } catch {
        lastMarked.current = 0;
      }
    },
    [refreshUnread],
  );

  const applyMessages = useCallback(
    (data: { messages: Msg[]; peerReadId?: number; generalReaders?: Readers }) => {
      setPeerReadId(data.peerReadId ?? 0);
      setGeneralReaders(data.generalReaders ?? []);
      return data.messages;
    },
    [],
  );

  const load = useCallback(
    async (full: boolean) => {
      try {
        const after = full ? 0 : lastId.current;
        const res = await fetch(`/api/chat?peer=${peer}&after=${after}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { messages: Msg[]; peerReadId?: number; generalReaders?: Readers };
        if (full) {
          const list = applyMessages(data);
          setMsgs(list);
          lastId.current = list.at(-1)?.id ?? 0;
          setContext(null);
          scrollDown();
          if (document.visibilityState === "visible") await markRead(peer, lastId.current);
        } else if (data.messages.length) {
          setPeerReadId(data.peerReadId ?? 0);
          setGeneralReaders(data.generalReaders ?? []);
          setMsgs((prev) => [...prev, ...data.messages.filter((m) => !prev.some((p) => p.id === m.id))]);
          lastId.current = data.messages.at(-1)!.id;
          scrollDown();
          if (document.visibilityState === "visible") await markRead(peer, lastId.current);
        }
      } finally {
        setLoading(false);
      }
    },
    [peer, applyMessages, markRead],
  );

  // Загрузка переписки при смене собеседника + опрос новых сообщений.
  useEffect(() => {
    void load(true);
    const timer = setInterval(() => {
      // В режиме просмотра найденного фрагмента не подмешиваем новые сообщения.
      if (document.visibilityState === "visible" && !contextRef.current) void load(false);
    }, 3000);
    return () => clearInterval(timer);
  }, [load]);

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

  // Освобождаем blob-URL превью при размонтировании.
  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  /** Ввод в поиске: сбрасываем результаты, если запрос стал слишком коротким. */
  const updateQuery = (value: string) => {
    setQuery(value);
    if (value.trim().length < SEARCH_MIN) {
      setResults([]);
      setSearching(false);
    }
  };

  // Поиск с задержкой, чтобы не дёргать сервер на каждую букву.
  useEffect(() => {
    const needle = query.trim();
    if (needle.length < SEARCH_MIN) return;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/chat/search?peer=${peer}&q=${encodeURIComponent(needle)}`, { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as { results: Msg[] };
          setResults(data.results);
        }
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, peer]);

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
    if (picked.size > MAX_FILE_BYTES) {
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

  const send = async () => {
    const content = text.trim();
    if ((!content && !file) || sending) return;
    setSending(true);
    setError(null);
    try {
      let res: Response;
      if (file) {
        const form = new FormData();
        form.set("peer", String(peer));
        form.set("content", content);
        form.set("file", file);
        res = await fetch("/api/chat", { method: "POST", body: form });
      } else {
        res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ peer, content }),
        });
      }
      if (res.ok) {
        setText("");
        clearFile();
        await load(false);
        await refreshUnread();
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

  /** Перейти к найденному сообщению: показать окно переписки вокруг него. */
  const openAround = async (messageId: number) => {
    setSearching(true);
    setError(null);
    try {
      const res = await fetch(`/api/chat?peer=${peer}&around=${messageId}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        messages: Msg[];
        peerReadId?: number;
        generalReaders?: Readers;
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

  const peerUser = users.find((u) => u.id === peer);
  const others = users.filter((u) => u.id !== meId);
  const needle = peerFilter.trim().toLowerCase();
  const visibleOthers = needle
    ? others.filter((u) => `${u.name} ${u.position ?? ""} ${u.email}`.toLowerCase().includes(needle))
    : others;
  const unreadFor = (id: number) => unread[String(id)] ?? 0;
  const totalUnread = Object.values(unread).reduce((sum, value) => sum + value, 0);

  const readersOf = (message: Msg) => {
    if (peer !== 0) return message.id <= peerReadId ? null : 0;
    return generalReaders.filter((r) => r.lastReadId >= message.id).length;
  };

  return (
    <div className="flex h-[600px] w-full min-w-0 overflow-hidden rounded-2xl border border-border bg-card sm:h-[680px]">
      {/* Список чатов */}
      <div className="hidden w-60 shrink-0 flex-col border-r border-border sm:flex">
        <p className="flex items-center justify-between px-4 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">
          Чаты
          {totalUnread > 0 && (
            <span className="rounded-md bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent2">{totalUnread}</span>
          )}
        </p>
        <div className="px-2 pb-2">
          <div className="relative">
            <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={peerFilter}
              onChange={(e) => setPeerFilter(e.target.value)}
              placeholder="Найти коллегу..."
              className="h-8 w-full rounded-lg border border-border bg-card2 pl-7 pr-2 text-[11px] outline-none focus:border-accent focus:ring-2 focus:ring-[var(--ring)]"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          <button
            onClick={() => changePeer(0)}
            className={cn(
              "mb-1 flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm",
              peer === 0 ? "bg-accent/15 text-text" : "text-muted hover:bg-card2 hover:text-text",
            )}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#7c5cff] to-[#a78bfa] text-white"><Hash size={14} /></span>
            <span className="min-w-0 flex-1 truncate font-medium">Общий чат</span>
            {unreadFor(0) > 0 && <UnreadBadge count={unreadFor(0)} />}
          </button>
          <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">Личные</p>
          {visibleOthers.map((u) => (
            <button
              key={u.id}
              onClick={() => changePeer(u.id)}
              className={cn(
                "mb-0.5 flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm",
                peer === u.id ? "bg-accent/15 text-text" : "text-muted hover:bg-card2 hover:text-text",
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
          {visibleOthers.length === 0 && (
            <p className="px-2 py-3 text-center text-[11px] text-muted">Никого не нашли</p>
          )}
        </div>
      </div>

      {/* Переписка */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5 sm:px-4 sm:py-3">
          <select
            value={peer}
            onChange={(e) => changePeer(Number(e.target.value))}
            className="min-w-0 max-w-[45%] rounded-lg border border-border bg-card2 px-2 py-1 text-xs sm:hidden"
          >
            <option value={0}>Общий чат{unreadFor(0) ? ` (${unreadFor(0)})` : ""}</option>
            {others.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}{unreadFor(u.id) ? ` (${unreadFor(u.id)})` : ""}
              </option>
            ))}
          </select>
          <div className="hidden min-w-0 items-center gap-2 sm:flex">
            {peerUser ? <Avatar name={peerUser.name} color={peerUser.avatarColor} url={peerUser.avatarUrl} size={30} /> : <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#7c5cff] to-[#a78bfa] text-white"><Hash size={14} /></span>}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{peerUser ? peerUser.name : "Общий чат"}</p>
              <p className="truncate text-[11px] text-muted">{peerUser ? peerUser.position || peerUser.email : `${users.length} участников`}</p>
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => { setSearchOpen((open) => !open); if (searchOpen) { updateQuery(""); setResults([]); } }}
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
                placeholder={peerUser ? `Поиск в переписке с ${peerUser.name}...` : "Поиск в общем чате..."}
                autoFocus
                className="h-9 w-full rounded-lg border border-border bg-card pl-8 pr-8 text-xs outline-none focus:border-accent focus:ring-2 focus:ring-[var(--ring)]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => { updateQuery(""); setResults([]); }}
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
                          <span className="shrink-0">{formatDate(dateToStr(new Date(m.createdAt)))} · {formatTime(m.createdAt)}</span>
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

        <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3 sm:px-4 sm:py-4">
          {loading && <p className="text-center text-xs text-muted">Загрузка...</p>}
          {!loading && msgs.length === 0 && (
            <p className="py-10 text-center text-xs text-muted">Сообщений пока нет. Напишите первым!</p>
          )}
          {msgs.map((m, index) => {
            const mine = m.senderId === meId;
            const day = dateToStr(new Date(m.createdAt));
            const prev = index > 0 ? dateToStr(new Date(msgs[index - 1].createdAt)) : null;
            const showDay = day !== prev;
            const readers = readersOf(m);
            return (
              <div key={m.id} data-mid={m.id} ref={(node) => {
                if (node) nodes.current.set(m.id, node);
                else nodes.current.delete(m.id);
              }}>
                {showDay && <div className="my-2 text-center text-[10px] font-medium uppercase tracking-wide text-muted">{formatDate(day)}</div>}
                <div className={cn("flex items-end gap-2 rounded-xl transition", mine && "flex-row-reverse", highlightId === m.id && "bg-amber-400/20 ring-1 ring-amber-400/40")}>
                  <Avatar name={m.senderName} color={m.senderColor} url={m.senderAvatar} size={28} />
                  <div className={cn("max-w-[78%] min-w-0 rounded-2xl px-3 py-2 text-sm", mine ? "rounded-br-sm bg-gradient-to-br from-[#7c5cff] to-[#8f6cff] text-white" : "rounded-bl-sm border border-border bg-card2")}>
                    {!mine && peer === 0 && <p className="mb-0.5 text-[11px] font-semibold text-accent2">{m.senderName}</p>}
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
                            <span className={cn("shrink-0 text-[10px]", mine ? "text-white/70" : "text-muted")}>{formatSize(m.attachment.size)}</span>
                          </a>
                        )}
                      </div>
                    )}
                    <div className={cn("mt-1 flex items-center justify-end gap-1 text-[10px]", mine ? "text-white/70" : "text-muted")}>
                      <span>{formatTime(m.createdAt)}</span>
                      {mine && readers !== null && (
                        peer === 0 ? (
                          readers > 0 && <span title={`Прочитали: ${readers}`} className="flex items-center gap-0.5"><CheckCheck size={12} />{readers}</span>
                        ) : readers ? (
                          <span title="Прочитано" className="flex items-center"><CheckCheck size={12} /></span>
                        ) : (
                          <span title="Отправлено" className="flex items-center"><Check size={12} /></span>
                        )
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); void send(); }}
          className="border-t border-border p-3"
        >
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
              <button type="button" onClick={clearFile} className="shrink-0 rounded p-0.5 text-muted hover:text-red-500" title="Убрать файл">
                <X size={13} />
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <label
              className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-border bg-card2 text-muted transition hover:text-text"
              title="Прикрепить файл или картинку (до 5 МБ)"
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
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder={peerUser ? `Сообщение для ${peerUser.name}...` : "Сообщение в общий чат... (Enter — отправить, Shift+Enter — перенос)"}
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
