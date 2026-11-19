"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageSquare, Send, Trash2 } from "lucide-react";
import type { Role } from "@/db/schema";
import { canManageData, cn, formatTime } from "@/lib/utils";
import { Avatar } from "./ui";

/**
 * Быстрая переписка по задаче.
 *
 * Это не большой чат, а короткое обсуждение конкретной задачи: пара уточнений,
 * «сделал, посмотри», ссылка. Всё хранится в базе (`task_messages`), поэтому
 * переписка не теряется при закрытии окна, и её видит и автор, и исполнитель.
 */

type Message = {
  id: number;
  taskId: number;
  authorId: number;
  authorName: string;
  authorColor: string;
  authorAvatar: string | null;
  content: string;
  createdAt: string;
};

const MAX_TEXT = 2000;
const POLL_MS = 6000;

export function TaskChat({ taskId, me }: { taskId: number; me: { id: number; role: Role } }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastId = useRef(0);

  const scrollDown = () => {
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    });
  };

  const load = useCallback(
    async (initial: boolean) => {
      try {
        const res = await fetch(`/api/tasks/${taskId}/messages`, { cache: "no-store" });
        if (!res.ok) {
          if (initial) setError("Не удалось загрузить переписку");
          return;
        }
        const data = (await res.json()) as { messages?: Message[] };
        const list = data.messages ?? [];
        const fresh = list.filter((m) => m.id > lastId.current);
        lastId.current = list.at(-1)?.id ?? 0;
        if (initial) {
          setMessages(list);
          scrollDown();
        } else if (fresh.length) {
          setMessages((prev) => [...prev, ...fresh.filter((m) => !prev.some((p) => p.id === m.id))]);
          scrollDown();
        }
      } finally {
        if (initial) setLoading(false);
      }
    },
    [taskId],
  );

  useEffect(() => {
    void load(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(false);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const send = async () => {
    const content = text.trim();
    if (!content || sending) return;
    if (content.length > MAX_TEXT) {
      setError(`Сообщение длиннее ${MAX_TEXT} символов`);
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: Message; error?: string };
      if (!res.ok || !data.message) {
        setError(data.error ?? "Не удалось отправить сообщение");
        return;
      }
      setText("");
      setMessages((prev) => [...prev, data.message!]);
      lastId.current = Math.max(lastId.current, data.message.id);
      scrollDown();
    } catch {
      setError("Нет связи с сервером");
    } finally {
      setSending(false);
    }
  };

  const remove = async (id: number) => {
    if (!confirm("Удалить сообщение из переписки по задаче?")) return;
    const res = await fetch(`/api/tasks/${taskId}/messages?messageId=${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Не удалось удалить сообщение");
      return;
    }
    setMessages((prev) => prev.filter((m) => m.id !== id));
  };

  const moderator = canManageData(me.role);

  return (
    <div className="mt-4 rounded-xl border border-border bg-card2 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <MessageSquare size={13} className="text-accent2" />
          Быстрая переписка по задаче
          {messages.length > 0 && (
            <span className="rounded-md bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent2">{messages.length}</span>
          )}
        </p>
        <span className="text-[10px] text-muted">сохраняется в базе · видна автору и исполнителю</span>
      </div>

      <div
        ref={listRef}
        className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-border/70 bg-card p-2"
      >
        {loading ? (
          <p className="flex items-center gap-1.5 px-1 py-2 text-[11px] text-muted">
            <Loader2 size={12} className="animate-spin" /> Загружаем переписку…
          </p>
        ) : messages.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted">
            Пока пусто. Напишите уточнение — сообщение увидят участники задачи.
          </p>
        ) : (
          messages.map((m) => {
            const own = m.authorId === me.id;
            return (
              <div key={m.id} className={cn("group flex min-w-0 items-start gap-2", own && "flex-row-reverse")}>
                <Avatar name={m.authorName} color={m.authorColor} url={m.authorAvatar} size={22} />
                <div className={cn("min-w-0 max-w-[85%]", own && "text-right")}>
                  <div className={cn("flex items-center gap-1.5 text-[10px] text-muted", own && "justify-end")}>
                    <span className="truncate font-medium text-text">{own ? "Вы" : m.authorName}</span>
                    <span>{formatTime(m.createdAt)}</span>
                    {(own || moderator) && (
                      <button
                        type="button"
                        onClick={() => void remove(m.id)}
                        className="rounded p-0.5 text-muted opacity-0 transition hover:text-red-500 focus:opacity-100 group-hover:opacity-100"
                        title="Удалить сообщение"
                      >
                        <Trash2 size={10} />
                      </button>
                    )}
                  </div>
                  <div
                    className={cn(
                      "mt-0.5 inline-block whitespace-pre-wrap break-words rounded-xl px-2.5 py-1.5 text-left text-[12px] leading-snug",
                      own ? "bg-accent/20 text-text" : "bg-card2 text-text",
                    )}
                  >
                    {m.content}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="mt-2 flex min-w-0 items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          maxLength={MAX_TEXT}
          placeholder="Написать участникам задачи… (Enter — отправить)"
          className="max-h-24 min-h-9 min-w-0 flex-1 resize-y rounded-xl border border-border bg-card px-3 py-2 text-xs outline-none focus:border-accent focus:ring-2 focus:ring-[var(--ring)]"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || text.trim().length === 0}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 text-xs font-medium text-white transition disabled:opacity-40"
        >
          {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
          Отправить
        </button>
      </div>
      {error && <p className="mt-1.5 text-[11px] text-red-500">{error}</p>}
    </div>
  );
}
