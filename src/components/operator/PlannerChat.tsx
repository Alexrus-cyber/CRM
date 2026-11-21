"use client";

import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import {
  ArrowRight,
  Check,
  History,
  Loader2,
  MessageSquarePlus,
  Paperclip,
  Send,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Badge, Button, Card, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { DEFAULT_PLAN_PROMPT } from "@/lib/operatorPlan";
import { extractClipboardFiles, hasTransferFiles } from "@/lib/clipboardFiles";
import { formatFileSize, readOperatorFiles, type OperatorAttachment } from "./files";
import type { GenParams } from "@/lib/genParams";

/**
 * Первый чат на «Пульте»: планировщик.
 *
 * Переписка и индивидуальный системный промпт сохраняются в базе аккаунта.
 * Модель уточняет задачу и пишет точный план; понравившийся план переносится
 * в чат с действиями, где он становится заданием бота.
 */

export type PlanMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
  files: Array<{ name: string; size: number }>;
  reasoning?: string;
};

type PlanConversation = {
  id: number;
  kind: "plan";
  title: string;
  messagesCount: number;
  updatedAt: string;
};

type StoredMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  attachments?: Array<{ name?: string; size?: number }>;
};

type Props = {
  baseUrl: string;
  model: string;
  apiKey: string;
  providerLabel: string;
  params: GenParams;
  onTransfer: (prompt: string, files: OperatorAttachment[]) => Promise<void>;
  onOpenSetup: () => void;
};

function decodeMessage(message: StoredMessage): PlanMessage {
  return {
    id: message.id,
    role: message.role === "assistant" ? "assistant" : "user",
    text: String(message.content ?? ""),
    reasoning: String(message.reasoning ?? ""),
    files: Array.isArray(message.attachments)
      ? message.attachments.map((file) => ({ name: String(file.name ?? "файл"), size: Number(file.size ?? 0) }))
      : [],
  };
}

export function PlannerChat({ baseUrl, model, apiKey, providerLabel, params, onTransfer, onOpenSetup }: Props) {
  const [conversations, setConversations] = useState<PlanConversation[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<PlanMessage[]>([]);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_PLAN_PROMPT);
  const [savedPrompt, setSavedPrompt] = useState(DEFAULT_PLAN_PROMPT);
  const [promptSavingCount, setPromptSavingCount] = useState(0);
  const [promptSaveError, setPromptSaveError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<OperatorAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const counter = useRef(0);
  const dragDepthRef = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<number | null>(null);
  const promptSaveSeq = useRef(0);

  const nextId = () => {
    counter.current += 1;
    return -counter.current;
  };

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, sending]);

  const openConversation = useCallback(async (id: number) => {
    const res = await fetch(`/api/agent/conversations/${id}`, { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as {
      conversation?: PlanConversation & { systemPrompt?: string };
      messages?: StoredMessage[];
      error?: string;
    };
    if (!res.ok || !data.conversation) throw new Error(data.error ?? "Не удалось открыть план-чат");

    activeIdRef.current = id;
    promptSaveSeq.current += 1;
    setConversationId(id);
    setMessages((data.messages ?? []).map(decodeMessage));
    setFiles([]);
    const prompt = String(data.conversation.systemPrompt ?? "");
    setSavedPrompt(prompt);
    setSystemPrompt(prompt);
    setPromptSaveError(null);
    setError(null);
    setNotice(null);
  }, []);

  const createConversation = useCallback(async () => {
    const res = await fetch("/api/agent/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "plan" }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      conversation?: PlanConversation & { systemPrompt?: string };
      error?: string;
    };
    if (!res.ok || !data.conversation) throw new Error(data.error ?? "Не удалось создать план-чат");

    const conversation = data.conversation;
    activeIdRef.current = conversation.id;
    promptSaveSeq.current += 1;
    setConversations((prev) => [conversation, ...prev.filter((item) => item.id !== conversation.id)]);
    setConversationId(conversation.id);
    setMessages([]);
    setFiles([]);
    setText("");
    const prompt = String(conversation.systemPrompt ?? DEFAULT_PLAN_PROMPT);
    setSavedPrompt(prompt);
    setSystemPrompt(prompt);
    setPromptSaveError(null);
    setError(null);
    setNotice(null);
    return conversation;
  }, []);

  useEffect(() => {
    let alive = true;
    const initialize = async () => {
      try {
        const res = await fetch("/api/agent/conversations?kind=plan", { cache: "no-store" });
        const data = (await res.json().catch(() => ({}))) as { conversations?: PlanConversation[]; error?: string };
        if (!res.ok) throw new Error(data.error ?? "Не удалось загрузить историю планировщика");
        if (!alive) return;
        const list = data.conversations ?? [];
        setConversations(list);
        if (list.length > 0) await openConversation(list[0].id);
        else await createConversation();
      } catch (caught) {
        if (alive) setError(caught instanceof Error ? caught.message : "Не удалось загрузить чаты");
      } finally {
        if (alive) setHistoryLoading(false);
      }
    };
    void initialize();
    return () => {
      alive = false;
    };
  }, [createConversation, openConversation]);

  const savePrompt = useCallback(async (id: number, prompt: string) => {
    const seq = ++promptSaveSeq.current;
    setPromptSavingCount((count) => count + 1);
    try {
      const res = await fetch(`/api/agent/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemPrompt: prompt }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Не удалось сохранить системный промпт");
      if (activeIdRef.current === id && seq === promptSaveSeq.current) {
        setSavedPrompt(prompt);
        setPromptSaveError(null);
      }
    } catch (caught) {
      if (activeIdRef.current === id && seq === promptSaveSeq.current) {
        setPromptSaveError(caught instanceof Error ? caught.message : "Не удалось сохранить промпт");
      }
      throw caught;
    } finally {
      setPromptSavingCount((count) => Math.max(0, count - 1));
    }
  }, []);

  useEffect(() => {
    if (conversationId === null || systemPrompt === savedPrompt) return;
    const id = conversationId;
    const prompt = systemPrompt;
    const timer = window.setTimeout(() => {
      void savePrompt(id, prompt).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [conversationId, systemPrompt, savedPrompt, savePrompt]);

  const selectConversation = async (id: number) => {
    if (id === conversationId || sending || historyLoading) return;
    setHistoryLoading(true);
    setError(null);
    try {
      await openConversation(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось открыть план-чат");
    } finally {
      setHistoryLoading(false);
    }
  };

  const newConversation = async () => {
    if (sending || historyLoading) return;
    setHistoryLoading(true);
    try {
      await createConversation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось создать план-чат");
    } finally {
      setHistoryLoading(false);
    }
  };

  const deleteConversation = async () => {
    if (conversationId === null || sending || historyLoading) return;
    const id = conversationId;
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/agent/conversations/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Не удалось удалить план-чат");
      const rest = conversations.filter((item) => item.id !== id);
      setConversations(rest);
      if (rest.length > 0) await openConversation(rest[0].id);
      else await createConversation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось удалить план-чат");
    } finally {
      setHistoryLoading(false);
    }
  };

  const saveMessage = async (
    id: number,
    message: { role: "user" | "assistant"; content: string; reasoning?: string; attachments?: PlanMessage["files"] },
  ) => {
    const res = await fetch(`/api/agent/conversations/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: StoredMessage; error?: string };
    if (!res.ok || !data.message) throw new Error(data.error ?? "Не удалось сохранить сообщение");
    return decodeMessage(data.message);
  };

  const send = async () => {
    const typed = text.trim();
    const value =
      typed || (files.length > 0 ? "Проанализируй приложенные материалы и предложи план действий." : "");
    const activeId = conversationId;
    if (!value || sending || historyLoading || activeId === null) return;
    const userMessage: PlanMessage = {
      id: nextId(),
      role: "user",
      text: value,
      files: files.map((file) => ({ name: file.name, size: file.size })),
    };
    const history = [...messages, userMessage];
    setMessages(history);
    setText("");
    setError(null);
    setNotice(null);
    setSending(true);

    try {
      if (systemPrompt !== savedPrompt) {
        await savePrompt(activeId, systemPrompt);
      }
      const storedUser = await saveMessage(activeId, {
        role: "user",
        content: userMessage.text,
        attachments: userMessage.files,
      });
      setMessages((prev) => prev.map((message) => (message.id === userMessage.id ? storedUser : message)));
      setConversations((prev) =>
        prev.map((item) =>
          item.id === activeId
            ? {
                ...item,
                title: item.title === "Новый план" ? value.replace(/\s+/g, " ").slice(0, 80) : item.title,
                messagesCount: item.messagesCount + 1,
              }
            : item,
        ),
      );

      const res = await fetch("/api/agent/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map((message) => ({ role: message.role, content: message.text })),
          files: files.map((file) => ({
            name: file.name,
            text: file.text,
            note: file.note,
            ...(file.image ? { image: file.image } : {}),
          })),
          systemPrompt,
          settings: { baseUrl, apiKey, model, params },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        reply?: string;
        reasoning?: string;
        error?: string;
      };
      if (!res.ok || !data.reply) {
        setError(data.error ?? "Планировщик не ответил");
        return;
      }

      const assistantMessage: PlanMessage = {
        id: nextId(),
        role: "assistant",
        text: data.reply,
        files: [],
        reasoning: data.reasoning,
      };
      setMessages((prev) => [...prev, assistantMessage]);
      const storedAssistant = await saveMessage(activeId, {
        role: "assistant",
        content: assistantMessage.text,
        reasoning: assistantMessage.reasoning,
      });
      setMessages((prev) => prev.map((message) => (message.id === assistantMessage.id ? storedAssistant : message)));
      setConversations((prev) =>
        prev.map((item) => (item.id === activeId ? { ...item, messagesCount: item.messagesCount + 1 } : item)),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "CRM не отвечает — проверьте соединение");
    } finally {
      setSending(false);
    }
  };

  const attach = async (list: FileList | File[]) => {
    if (list.length === 0) return;
    setError(null);
    const { files: added, errors } = await readOperatorFiles(files, list);
    setFiles((prev) => [...prev, ...added]);
    if (errors.length > 0) setError(errors[0]);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const { files: pasted, hasPlainText } = extractClipboardFiles(event.clipboardData);
    if (pasted.length === 0) return;
    if (!hasPlainText) event.preventDefault();
    void attach(pasted);
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
    if (dropped.length > 0) void attach(dropped);
  };

  const transfer = async (message: PlanMessage) => {
    if (transferring) return;
    setTransferring(true);
    setError(null);
    try {
      await onTransfer(message.text, files);
      setNotice(
        message.files.length > 0 && files.length === 0
          ? "План перенесён без вложений: сохранена переписка и имена файлов, но сами файлы в историю не загружаются."
          : "План перенесён в «Выполнение» — задание в очереди, бот заберёт его автоматически.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось перенести план");
    } finally {
      setTransferring(false);
    }
  };

  const ready = Boolean(model.trim() && baseUrl.trim());
  const promptSaving = promptSavingCount > 0;
  const promptChanged = conversationId !== null && systemPrompt !== savedPrompt;

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          1. Планировщик
          <Badge className="border-border text-muted">
            <Sparkles size={11} /> уточняет задачу
          </Badge>
        </span>
      }
      subtitle="Опишите, что нужно сделать. Модель задаст вопросы и напишет точный план."
      action={
        <button
          type="button"
          onClick={onOpenSetup}
          title="Провайдер, ключ и модель — в «Подключении»"
          className="rounded-lg border border-border bg-card2 px-2 py-1 text-[10px] text-muted transition hover:text-text"
        >
          {providerLabel} · {model.trim() || "модель не выбрана"}
        </button>
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-card2/50 p-1.5">
        <History size={13} className="ml-1 text-muted" />
        <select
          aria-label="История чатов планировщика"
          value={conversationId ?? ""}
          onChange={(event) => void selectConversation(Number(event.target.value))}
          disabled={historyLoading || conversations.length === 0}
          className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-card px-2 text-[11px] text-text outline-none focus:border-accent disabled:opacity-60"
        >
          {conversations.length === 0 ? (
            <option value="">{historyLoading ? "Загружаю историю…" : "Чатов пока нет"}</option>
          ) : (
            conversations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title || "Новый план"}
              </option>
            ))
          )}
        </select>
        <Button size="sm" variant="secondary" onClick={() => void newConversation()} disabled={historyLoading || sending}>
          <MessageSquarePlus size={12} /> Новый чат
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => void deleteConversation()}
          disabled={conversationId === null || historyLoading || sending}
          title="Удалить этот план-чат"
          aria-label="Удалить план-чат"
        >
          <Trash2 size={13} />
        </Button>
      </div>

      <details className="mb-2 rounded-xl border border-border bg-card2/40">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-[11px] font-medium">
          <span className="flex-1">Системный промпт для этого чата</span>
          {promptSaving || promptChanged ? (
            <span className="flex items-center gap-1 text-muted"><Loader2 size={11} className="animate-spin" /> сохраняю</span>
          ) : promptSaveError ? (
            <span className="flex items-center gap-1 text-red-500"><TriangleAlert size={11} /> ошибка сохранения</span>
          ) : (
            <span className="flex items-center gap-1 text-emerald-500"><Check size={11} /> сохранён</span>
          )}
        </summary>
        <div className="space-y-1.5 border-t border-border p-2">
          <Textarea
            aria-label="Системный промпт планировщика"
            value={systemPrompt}
            onChange={(event) => {
              setSystemPrompt(event.target.value.slice(0, 12_000));
              setPromptSaveError(null);
            }}
            rows={6}
            maxLength={12_000}
            disabled={historyLoading || sending}
            placeholder={DEFAULT_PLAN_PROMPT}
            className="text-[10px] leading-relaxed"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] leading-relaxed text-muted">
              Пример уже заполнен. Он сохраняется отдельно для каждого чата; пустое поле при отправке использует примерный промпт.
              {" "}{systemPrompt.length.toLocaleString("ru-RU")}/12 000 символов.
            </p>
            {systemPrompt !== DEFAULT_PLAN_PROMPT && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSystemPrompt(DEFAULT_PLAN_PROMPT);
                  setPromptSaveError(null);
                }}
                disabled={historyLoading || sending}
              >
                Сбросить к примеру
              </Button>
            )}
          </div>
          {promptSaveError && <p className="text-[10px] text-red-500">{promptSaveError}</p>}
        </div>
      </details>

      <div
        ref={listRef}
        className="max-h-[340px] min-h-[180px] space-y-2 overflow-y-auto rounded-xl border border-border bg-card2/40 p-2"
      >
        {historyLoading ? (
          <div className="flex h-full min-h-[160px] items-center justify-center gap-2 text-[11px] text-muted">
            <Loader2 size={13} className="animate-spin" /> Загружаю переписку…
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-1.5 px-4 text-center">
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card text-accent2">
              <Sparkles size={14} />
            </span>
            <p className="text-xs font-medium">С чего начать?</p>
            <p className="text-[11px] leading-relaxed text-muted">
              «Открой Telegram, найди чат с Иваном и напиши, что я буду через 10 минут» — модель
              разложит это по шагам и уточнит, куда кликать.
            </p>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                "rounded-xl border px-2.5 py-2 text-[11px] leading-relaxed",
                message.role === "user"
                  ? "ml-6 border-accent/30 bg-accent/10"
                  : "mr-4 border-border bg-card",
              )}
            >
              <p className="whitespace-pre-wrap break-words">{message.text}</p>
              {message.files.length > 0 && (
                <p className="mt-1 flex flex-wrap gap-1">
                  {message.files.map((file, index) => (
                    <span
                      key={`${file.name}-${index}`}
                      className="rounded border border-border bg-card2 px-1 py-0.5 text-[9px] text-muted"
                    >
                      {file.name} · {formatFileSize(file.size)}
                    </span>
                  ))}
                </p>
              )}
              {message.reasoning && message.reasoning.trim() && (
                <details className="mt-1 rounded-lg border border-border bg-card2 px-1.5 py-1 text-[10px]">
                  <summary className="cursor-pointer text-muted">
                    Размышления · {message.reasoning.length} симв.
                  </summary>
                  <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-muted">
                    {message.reasoning}
                  </p>
                </details>
              )}
              {message.role === "assistant" && (
                <div className="mt-1.5 flex justify-end">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void transfer(message)}
                    disabled={transferring || historyLoading}
                    title="Создать задание с этим планом"
                  >
                    {transferring ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
                    Перенести в выполнение
                  </Button>
                </div>
              )}
            </div>
          ))
        )}
        {sending && (
          <p className="flex items-center gap-1.5 px-1 text-[10px] text-muted">
            <Loader2 size={11} className="animate-spin" /> Модель уточняет план…
          </p>
        )}
      </div>

      {files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {files.map((file, idx) => (
            <span
              key={`${file.name}-${file.size}-${idx}`}
              className="flex items-center gap-1 rounded-lg border border-border bg-card2 px-1.5 py-0.5 text-[10px] text-muted"
            >
              {file.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={file.image} alt={file.name} className="h-4 w-4 rounded object-cover" />
              )}
              {file.name} · {formatFileSize(file.size)}
              <button
                type="button"
                onClick={() => setFiles((prev) => prev.filter((item) => item !== file))}
                className="text-muted transition hover:text-red-500"
                aria-label={`Убрать ${file.name}`}
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "relative mt-2 flex items-end gap-1.5 rounded-xl transition",
          dragging && "bg-accent/10 p-1 ring-2 ring-accent/60",
        )}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          className="sr-only"
          aria-label="Приложить файлы к планировщику"
          onChange={(event) => {
            const list = Array.from(event.target.files ?? []);
            event.target.value = "";
            void attach(list);
          }}
        />
        <Button
          size="icon"
          variant="ghost"
          onClick={() => fileRef.current?.click()}
          title="Приложить файлы (до 5 по 10 МБ)"
          aria-label="Приложить файлы"
          disabled={historyLoading || sending}
        >
          <Paperclip size={14} />
        </Button>
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder="Что нужно сделать? Enter — отправить, Ctrl+V — вставить фото или перетащите файл"
          disabled={historyLoading || conversationId === null}
          className="min-w-0 flex-1 text-[11px]"
        />
        <Button
          size="icon"
          onClick={() => void send()}
          disabled={sending || historyLoading || (!text.trim() && files.length === 0) || conversationId === null}
          aria-label="Отправить"
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </Button>
      </div>

      {!ready && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[10px] text-amber-500">
          <TriangleAlert size={11} className="mt-0.5 shrink-0" />
          <span>
            Планировщику нужна модель: укажите провайдера, ключ и модель в «Подключении»
            <button type="button" onClick={onOpenSetup} className="ml-1 underline underline-offset-2">
              открыть
            </button>
            .
          </span>
        </p>
      )}
      {error && <p className="mt-1.5 text-[10px] text-red-500">{error}</p>}
      {notice && <p className="mt-1.5 text-[10px] text-emerald-500">{notice}</p>}
    </Card>
  );
}
