"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { subscribeAppEvents } from "@/lib/clientEvents";
import { cn } from "@/lib/utils";

/**
 * Всплывающие уведомления о новых сообщениях (правый нижний угол).
 *
 * Два источника:
 *  1. SSE `/api/events` — мгновенно, событие приходит только адресату;
 *  2. тихий опрос `/api/chat/notifications` — страховка, если прокси режет SSE.
 *
 * Нажатие на уведомление открывает нужную переписку на странице «Команда».
 * Пока пользователь находится в чате на видимой вкладке, уведомления не
 * показываются: он и так видит новые сообщения.
 */

type Toast = {
  messageId: number;
  senderId: number;
  senderName: string;
  senderColor: string;
  recipientId: number | null;
  roomId?: number | null;
  roomName?: string | null;
  preview: string;
};

const TTL_MS = 12000;
const MAX_TOASTS = 3;
const POLL_MS = 20000;

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function MessageToasts({ userId }: { userId: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seen = useRef(new Set<number>());
  const timers = useRef(new Map<number, number>());
  const pathRef = useRef(pathname);

  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);

  const dismiss = useCallback((messageId: number) => {
    setToasts((prev) => prev.filter((t) => t.messageId !== messageId));
    const timer = timers.current.get(messageId);
    if (timer) {
      window.clearTimeout(timer);
      timers.current.delete(messageId);
    }
  }, []);

  const show = useCallback(
    (toast: Toast) => {
      if (seen.current.has(toast.messageId)) return;
      seen.current.add(toast.messageId);
      // В самом чате на видимой вкладке сообщение и так на экране.
      if (pathRef.current === "/team" && document.visibilityState === "visible") return;
      setToasts((prev) => [...prev.slice(Math.max(prev.length - MAX_TOASTS + 1, 0)), toast]);
      const timer = window.setTimeout(() => dismiss(toast.messageId), TTL_MS);
      timers.current.set(toast.messageId, timer);
    },
    [dismiss],
  );

  useEffect(() => {
    let disposed = false;
    const pendingTimers = timers.current;
    let lastId = 0;
    let interval: number | null = null;

    // 1. Точка отсчёта: старые сообщения не должны всплывать пачкой.
    const baseline = async () => {
      try {
        const res = await fetch("/api/chat/notifications?after=0", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { lastId?: number };
        if (typeof data.lastId === "number") lastId = Math.max(lastId, data.lastId);
      } catch {
        /* нет сети — попробуем позже */
      }
    };
    void baseline();

    // 2. Мгновенный канал (общий для вкладки).
    const unsubscribe = subscribeAppEvents({
      onUpdate: (raw) => {
        try {
          const data = JSON.parse(raw) as {
            scope?: string;
            chat?: Toast & { at?: number };
          };
          if (data.scope !== "chat" || !data.chat) return;
          const chat = data.chat;
          if (chat.senderId === userId) return;
          if (chat.messageId <= lastId) {
            // Событие опередило опрос — просто запомним id.
            lastId = Math.max(lastId, chat.messageId);
            return;
          }
          lastId = Math.max(lastId, chat.messageId);
          show({
            messageId: chat.messageId,
            senderId: chat.senderId,
            senderName: chat.senderName,
            senderColor: chat.senderColor,
            recipientId: chat.recipientId,
            roomId: chat.roomId ?? null,
            roomName: chat.roomName ?? null,
            preview: chat.preview,
          });
        } catch {
          /* некорректный пакет — игнорируем */
        }
      },
    });

    // 3. Страховочный опрос.
    const poll = async () => {
      if (disposed || document.visibilityState === "hidden" || lastId === 0) return;
      try {
        const res = await fetch(`/api/chat/notifications?after=${lastId}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          lastId?: number;
          messages?: Array<{
            id: number;
            senderId: number;
            senderName: string;
            senderColor: string;
            recipientId: number | null;
            roomId?: number | null;
            roomName?: string | null;
            preview: string;
          }>;
        };
        for (const m of data.messages ?? []) {
          show({
            messageId: m.id,
            senderId: m.senderId,
            senderName: m.senderName,
            senderColor: m.senderColor,
            recipientId: m.recipientId,
            roomId: m.roomId ?? null,
            roomName: m.roomName ?? null,
            preview: m.preview,
          });
        }
        if (typeof data.lastId === "number") lastId = Math.max(lastId, data.lastId);
      } catch {
        /* нет сети — следующий тик */
      }
    };
    interval = window.setInterval(poll, POLL_MS);

    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribe();
      if (interval !== null) window.clearInterval(interval);
      for (const timer of pendingTimers.values()) window.clearTimeout(timer);
      pendingTimers.clear();
    };
  }, [router, show, userId]);

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-[60] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-80"
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.messageId}
          className="pointer-events-auto relative overflow-hidden rounded-2xl border border-border bg-card shadow-[0_18px_45px_-18px_rgba(0,0,0,0.55)]"
        >
          <button
            type="button"
            onClick={() => {
              dismiss(toast.messageId);
              if (toast.roomId && toast.roomId > 0) {
                router.push(`/team?room=${toast.roomId}`);
              } else {
                const peer = toast.recipientId === null ? 0 : toast.senderId;
                router.push(peer === 0 ? "/team?chat=0" : `/team?chat=${peer}`);
              }
            }}
            className="flex w-full items-start gap-2.5 p-3 pr-8 text-left transition hover:bg-card2"
          >
            <span
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
              style={{ backgroundColor: toast.senderColor }}
            >
              {initials(toast.senderName) || <MessageSquare size={14} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-semibold">{toast.senderName}</span>
                <span className="shrink-0 rounded-md bg-accent/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent2">
                  {toast.roomId ? toast.roomName || "группа" : toast.recipientId === null ? "общий чат" : "личное"}
                </span>
              </span>
              <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-muted">{toast.preview}</span>
              <span className="mt-1 block text-[10px] font-medium text-accent2">Открыть чат →</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => dismiss(toast.messageId)}
            className={cn(
              "absolute right-1.5 top-1.5 rounded-lg p-1.5 text-muted transition hover:bg-card2 hover:text-text",
            )}
            aria-label="Закрыть уведомление"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
