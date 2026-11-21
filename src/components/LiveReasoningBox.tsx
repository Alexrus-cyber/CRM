"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Раскрывающийся блок «Размышления модели».
 * Во время генерации автоматически раскрывается, показывает пульсирующий индикатор
 * «в эфире» и прокручивает текст рассуждений вниз при обновлениях и каждую секунду.
 */
export function LiveReasoningBox({
  text,
  streaming = false,
  className,
  bodyClassName,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
  bodyClassName?: string;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const userToggledRef = useRef(false);

  useEffect(() => {
    if (!streaming) {
      userToggledRef.current = false;
      return;
    }
    if (detailsRef.current && !userToggledRef.current) {
      detailsRef.current.open = true;
    }
    const scrollBody = () => {
      if (bodyRef.current) {
        bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
      }
    };
    scrollBody();
    const timer = window.setInterval(scrollBody, 1000);
    return () => window.clearInterval(timer);
  }, [streaming]);

  useEffect(() => {
    if (streaming && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [text, streaming]);

  return (
    <details
      ref={detailsRef}
      onToggle={() => {
        if (streaming && detailsRef.current) {
          userToggledRef.current = !detailsRef.current.open;
        }
      }}
      className={cn(
        "rounded-xl border border-border bg-card px-2 py-1.5 text-[11px] text-muted",
        className,
      )}
    >
      <summary className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] font-medium">
        <span>Размышления · {text.length} симв.</span>
        {streaming && (
          <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            в эфире
          </span>
        )}
      </summary>
      <p
        ref={bodyRef}
        className={cn(
          "mt-1 max-h-52 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed text-muted",
          bodyClassName,
        )}
      >
        {text}
      </p>
    </details>
  );
}
