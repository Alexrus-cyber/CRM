/**
 * Скелетоны для ленивой подгрузки блоков.
 *
 * Модуль без "use client" — чистая разметка, поэтому его можно рендерить
 * и из серверных страниц (`loading.tsx`), и из клиентских компонентов
 * (`LazyMount`, `LazyChat`).
 */
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** Строки-«пустышки» в форме карточек списка. */
export function ListSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} aria-hidden>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 rounded-xl border border-border/60 bg-card2/40 p-3"
        >
          <div className="h-8 w-8 shrink-0 animate-pulse rounded-lg bg-card2" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-1/2 animate-pulse rounded bg-card2" />
            <div className="h-2.5 w-1/3 animate-pulse rounded bg-card2/70" />
          </div>
          <div className="h-5 w-16 shrink-0 animate-pulse rounded bg-card2" />
        </div>
      ))}
    </div>
  );
}

/** Плейсхолдер блока: скелетон + подпись «загружаем...». */
export function BlockSkeleton({
  label = "Загружаем блок...",
  rows = 3,
  className,
}: {
  label?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)} role="status" aria-label={label}>
      <ListSkeleton rows={rows} />
      <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted">
        <Loader2 size={12} className="animate-spin" />
        {label}
      </p>
    </div>
  );
}

/** Скелетон карточки чата: шапка, пузыри сообщений, поле ввода. */
export function ChatSkeleton({ label = "Загружаем чат..." }: { label?: string }) {
  return (
    <div
      className="flex h-[560px] flex-col overflow-hidden rounded-2xl border border-border bg-card sm:h-[640px]"
      role="status"
      aria-label={label}
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="h-9 w-9 animate-pulse rounded-xl bg-card2" />
        <div className="space-y-1.5">
          <div className="h-3 w-32 animate-pulse rounded bg-card2" />
          <div className="h-2.5 w-20 animate-pulse rounded bg-card2/70" />
        </div>
      </div>
      <div className="flex-1 space-y-3 p-4">
        {[70, 50, 82, 44, 64].map((width, index) => (
          <div key={index} className={cn("flex", index % 2 === 1 && "justify-end")}>
            <div className="h-9 animate-pulse rounded-2xl bg-card2" style={{ width: `${width}%` }} />
          </div>
        ))}
      </div>
      <div className="border-t border-border p-3">
        <div className="h-10 animate-pulse rounded-xl bg-card2" />
      </div>
      <p className="flex items-center justify-center gap-1.5 pb-3 text-[11px] text-muted">
        <Loader2 size={12} className="animate-spin" />
        {label}
      </p>
    </div>
  );
}

/** Скелетон шапки страницы и сетки плиток — для route-level `loading.tsx`. */
export function PageSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="space-y-2">
        <div className="h-6 w-52 animate-pulse rounded-lg bg-card2" />
        <div className="h-3 w-72 max-w-full animate-pulse rounded bg-card2/70" />
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="h-[76px] animate-pulse rounded-2xl border border-border bg-card" />
        ))}
      </div>
      <ListSkeleton rows={4} />
    </div>
  );
}

/** Скелетон блока «Чат с ИИ»: панель настроек + лента + поле ввода. */
export function AiChatSkeleton({ label = "Загружаем чат с ИИ..." }: { label?: string }) {
  return (
    <div className="space-y-4" role="status" aria-label={label}>
      <div className="rounded-2xl border border-border bg-card p-3.5 sm:p-5">
        <div className="h-3 w-1/3 animate-pulse rounded bg-card2" />
        <div className="mt-2 h-2.5 w-2/3 animate-pulse rounded bg-card2/70" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="h-10 animate-pulse rounded-xl bg-card2/70" />
          <div className="h-10 animate-pulse rounded-xl bg-card2/70" />
        </div>
      </div>
      <div className="flex h-[480px] flex-col overflow-hidden rounded-2xl border border-border bg-card p-3.5 sm:h-[560px] sm:p-5">
        <div className="h-3 w-1/4 animate-pulse rounded bg-card2" />
        <div className="flex-1 space-y-3 py-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              className={cn(
                "h-9 max-w-[70%] animate-pulse rounded-2xl bg-card2/70",
                index % 2 === 1 && "ml-auto",
              )}
            />
          ))}
        </div>
        <div className="h-10 animate-pulse rounded-xl bg-card2/70" />
        <p className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-muted">
          <Loader2 size={12} className="animate-spin" />
          {label}
        </p>
      </div>
    </div>
  );
}
