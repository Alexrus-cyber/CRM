"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Loader2, Paperclip, Send, Sparkles, TriangleAlert, X } from "lucide-react";
import { Badge, Button, Card, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatFileSize, readOperatorFiles, type OperatorAttachment } from "./files";
import type { GenParams } from "@/lib/genParams";

/**
 * Первый чат на «Пульте»: планировщик.
 *
 * Пользователь описывает задачу обычными словами, модель уточняет её и пишет
 * точный план. Понравившийся план переносится в чат с действиями — там он
 * становится заданием бота, который выполняет его на компьютере.
 */

export type PlanMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
  files: Array<{ name: string; size: number }>;
  reasoning?: string;
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

export function PlannerChat({ baseUrl, model, apiKey, providerLabel, params, onTransfer, onOpenSetup }: Props) {
  const [messages, setMessages] = useState<PlanMessage[]>([]);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<OperatorAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const counter = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const nextId = () => {
    counter.current += 1;
    return counter.current;
  };

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, sending]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
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
      const res = await fetch("/api/agent/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map((message) => ({ role: message.role, content: message.text })),
          files: files.map((file) => ({ name: file.name, text: file.text, note: file.note })),
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
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "assistant", text: data.reply!, files: [], reasoning: data.reasoning },
      ]);
    } catch {
      setError("CRM не отвечает — проверьте соединение");
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

  const transfer = async (message: PlanMessage) => {
    if (transferring) return;
    setTransferring(true);
    setError(null);
    try {
      await onTransfer(message.text, files);
      setNotice("План перенесён в «Выполнение» — задание в очереди, бот заберёт его автоматически.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось перенести план");
    } finally {
      setTransferring(false);
    }
  };

  const ready = Boolean(model.trim() && baseUrl.trim());

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
      <div
        ref={listRef}
        className="max-h-[340px] min-h-[180px] space-y-2 overflow-y-auto rounded-xl border border-border bg-card2/40 p-2"
      >
        {messages.length === 0 ? (
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
                  {message.files.map((file) => (
                    <span
                      key={file.name}
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
                    disabled={transferring}
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
          {files.map((file) => (
            <span
              key={`${file.name}-${file.size}`}
              className="flex items-center gap-1 rounded-lg border border-border bg-card2 px-1.5 py-0.5 text-[10px] text-muted"
            >
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

      <div className="mt-2 flex items-end gap-1.5">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="sr-only"
          onChange={(event) => {
            // Снимок до очистки: иначе браузер опустошает FileList.
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
        >
          <Paperclip size={14} />
        </Button>
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder="Что нужно сделать? Enter — отправить, Shift+Enter — новая строка"
          className="min-w-0 flex-1 text-[11px]"
        />
        <Button size="icon" onClick={() => void send()} disabled={sending || !text.trim()} aria-label="Отправить">
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
