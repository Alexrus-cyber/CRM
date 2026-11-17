"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Hash, Send } from "lucide-react";
import type { UserLite } from "@/lib/data";
import { cn, formatDate, formatTime, dateToStr } from "@/lib/utils";
import { Avatar, Button } from "./ui";

type Msg = {
  id: number;
  senderId: number;
  recipientId: number | null;
  content: string;
  createdAt: string;
  senderName: string;
  senderColor: string;
  senderAvatar: string | null;
};

export function ChatClient({ users, meId, initialPeer = 0 }: { users: UserLite[]; meId: number; initialPeer?: number }) {
  const [peer, setPeer] = useState<number>(initialPeer);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const lastId = useRef(0);

  const scrollDown = () => {
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    });
  };

  const load = useCallback(async (full: boolean) => {
    try {
      const after = full ? 0 : lastId.current;
      const res = await fetch(`/api/chat?peer=${peer}&after=${after}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { messages: Msg[] };
      if (full) {
        setMsgs(data.messages);
        lastId.current = data.messages.at(-1)?.id ?? 0;
        scrollDown();
      } else if (data.messages.length) {
        setMsgs((prev) => [...prev, ...data.messages.filter((m) => !prev.some((p) => p.id === m.id))]);
        lastId.current = data.messages.at(-1)!.id;
        scrollDown();
      }
    } finally {
      setLoading(false);
    }
  }, [peer]);

  useEffect(() => {
    setLoading(true);
    lastId.current = 0;
    setMsgs([]);
    load(true);
    const t = setInterval(() => load(false), 3000);
    return () => clearInterval(t);
  }, [load]);

  const send = async () => {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ peer, content }) });
      if (res.ok) {
        setText("");
        await load(false);
      } else {
        const d = await res.json().catch(() => ({}));
        alert(d.error ?? "Не удалось отправить");
      }
    } finally {
      setSending(false);
    }
  };

  const peerUser = users.find((u) => u.id === peer);
  const others = users.filter((u) => u.id !== meId);

  let lastDay = "";

  return (
    <div className="flex h-[560px] w-full min-w-0 overflow-hidden rounded-2xl border border-border bg-card sm:h-[640px]">
      {/* Conversations */}
      <div className="hidden w-56 shrink-0 flex-col border-r border-border sm:flex">
        <p className="px-4 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">Чаты</p>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          <button onClick={() => setPeer(0)} className={cn("mb-1 flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm", peer === 0 ? "bg-accent/15 text-text" : "text-muted hover:bg-card2 hover:text-text")}>
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#7c5cff] to-[#a78bfa] text-white"><Hash size={14} /></span>
            <span className="truncate font-medium">Общий чат</span>
          </button>
          <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">Личные</p>
          {others.map((u) => (
            <button key={u.id} onClick={() => setPeer(u.id)} className={cn("mb-0.5 flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm", peer === u.id ? "bg-accent/15 text-text" : "text-muted hover:bg-card2 hover:text-text")}>
              <Avatar name={u.name} color={u.avatarColor} url={u.avatarUrl} size={28} />
              <span className="min-w-0"><span className="block truncate text-xs font-medium">{u.name}</span><span className="block truncate text-[10px] opacity-70">{u.position || "—"}</span></span>
            </button>
          ))}
        </div>
      </div>

      {/* Messages */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <select value={peer} onChange={(e) => setPeer(Number(e.target.value))} className="rounded-lg border border-border bg-card2 px-2 py-1 text-xs sm:hidden">
            <option value={0}>Общий чат</option>
            {others.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <div className="hidden min-w-0 items-center gap-2 sm:flex">
            {peerUser ? <Avatar name={peerUser.name} color={peerUser.avatarColor} url={peerUser.avatarUrl} size={30} /> : <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#7c5cff] to-[#a78bfa] text-white"><Hash size={14} /></span>}
            <div>
              <p className="text-sm font-semibold">{peerUser ? peerUser.name : "Общий чат"}</p>
              <p className="text-[11px] text-muted">{peerUser ? peerUser.position || peerUser.email : `${users.length} участников`}</p>
            </div>
          </div>
        </div>

        <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {loading && <p className="text-center text-xs text-muted">Загрузка...</p>}
          {!loading && msgs.length === 0 && <p className="py-10 text-center text-xs text-muted">Сообщений пока нет. Напишите первым!</p>}
          {msgs.map((m) => {
            const mine = m.senderId === meId;
            const day = dateToStr(new Date(m.createdAt));
            const showDay = day !== lastDay;
            lastDay = day;
            return (
              <div key={m.id}>
                {showDay && <div className="my-2 text-center text-[10px] font-medium uppercase tracking-wide text-muted">{formatDate(day)}</div>}
                <div className={cn("flex items-end gap-2", mine && "flex-row-reverse")}>
                  <Avatar name={m.senderName} color={m.senderColor} url={m.senderAvatar} size={28} />
                  <div className={cn("max-w-[75%] rounded-2xl px-3 py-2 text-sm", mine ? "rounded-br-sm bg-gradient-to-br from-[#7c5cff] to-[#8f6cff] text-white" : "rounded-bl-sm border border-border bg-card2")}>
                    {!mine && peer === 0 && <p className="mb-0.5 text-[11px] font-semibold text-accent2">{m.senderName}</p>}
                    <p className="whitespace-pre-wrap break-words">{m.content}</p>
                    <p className={cn("mt-1 text-right text-[10px]", mine ? "text-white/70" : "text-muted")}>{formatTime(m.createdAt)}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex items-end gap-2 border-t border-border p-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={peerUser ? `Сообщение для ${peerUser.name}...` : "Сообщение в общий чат... (Enter — отправить, Shift+Enter — перенос)"}
            rows={1}
            className="max-h-32 min-h-[40px] min-w-0 flex-1 resize-none rounded-xl border border-border bg-card2 px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <Button type="submit" size="icon" disabled={sending || !text.trim()} title="Отправить"><Send size={16} /></Button>
        </form>
      </div>
    </div>
  );
}
