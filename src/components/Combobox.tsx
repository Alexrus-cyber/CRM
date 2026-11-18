"use client";

/**
 * Поле ввода с выпадающим списком: заменяет `<select>` там, где важно искать
 * по списку, а не листать его. Работает как обычный input — печатайте, список
 * сужается по подстроке в названии и подсказке; стрелки и Enter выбирают,
 * Esc закрывает, клик мимо — тоже.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ComboboxOption = {
  value: string;
  label: string;
  /** Дополнительная строка справа или под названием (должность, e-mail, ИНН). */
  hint?: string;
  icon?: ReactNode;
};

export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Начните вводить...",
  className,
  inputClassName,
  clearable = false,
  clearTitle = "Сбросить",
  disabled,
  size = "md",
  emptyLabel = "Ничего не найдено",
  title,
  id,
  "aria-label": ariaLabel,
}: {
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  clearable?: boolean;
  clearTitle?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  emptyLabel?: string;
  title?: string;
  id?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selected = useMemo(() => options.find((option) => option.value === value) ?? null, [options, value]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => `${option.label} ${option.hint ?? ""}`.toLowerCase().includes(needle));
  }, [options, query]);

  // Индекс не должен вылетать за пределы списка после фильтрации.
  const activeIndex = filtered.length === 0 ? -1 : Math.min(active, filtered.length - 1);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [open]);

  // Подсвеченный пункт всегда виден, даже если список прокручен.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const choose = (next: ComboboxOption) => {
    onChange(next.value);
    setOpen(false);
    setQuery("");
    setActive(0);
  };

  const startTyping = (next: string) => {
    setQuery(next);
    setOpen(true);
    setActive(0);
  };

  const displayValue = open ? query : selected?.label ?? "";

  return (
    <div ref={wrapRef} className={cn("relative min-w-0", className)}>
      <div className="relative">
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={id ? `${id}-listbox` : undefined}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          title={title}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          value={displayValue}
          placeholder={selected ? selected.label : placeholder}
          onChange={(event) => startTyping(event.target.value)}
          // Повторный клик по полю всегда раскрывает список целиком,
          // даже если в поле что-то уже вписано или список закрыли по Esc.
          onClick={() => {
            if (open) return;
            setOpen(true);
            setQuery("");
            setActive(0);
          }}
          onFocus={() => {
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActive((index) => Math.min(index + 1, Math.max(filtered.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              if (!open) return;
              event.preventDefault();
              const option = filtered[activeIndex];
              if (option) choose(option);
            } else if (event.key === "Escape") {
              if (!open) return;
              event.preventDefault();
              setOpen(false);
              setQuery("");
            } else if (event.key === "Tab") {
              if (open) {
                setOpen(false);
                setQuery("");
              }
            }
          }}
          className={cn(
            "w-full min-w-0 rounded-xl border border-border bg-card2 pr-12 text-text placeholder:text-muted/70 outline-none transition",
            "focus:border-accent focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60",
            size === "sm" ? "h-9 pl-2.5 text-xs" : "h-10 pl-3 text-sm",
            selected && !open && "text-text",
            inputClassName,
          )}
        />
        <span className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
          {clearable && value !== "" && !disabled && (
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange("");
                setQuery("");
                setOpen(false);
                inputRef.current?.focus();
              }}
              className="rounded p-0.5 text-muted transition hover:text-text"
              title={clearTitle}
              aria-label={clearTitle}
            >
              <X size={12} />
            </button>
          )}
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (open) {
                setOpen(false);
                setQuery("");
              } else {
                setOpen(true);
                setQuery("");
                setActive(0);
                inputRef.current?.focus();
              }
            }}
            className="rounded p-0.5 text-muted transition hover:text-text disabled:opacity-60"
            title={open ? "Скрыть список" : "Показать список"}
            aria-label={open ? "Скрыть список" : "Показать список"}
          >
            <ChevronDown size={13} className={cn("transition-transform", open && "rotate-180")} />
          </button>
        </span>
      </div>

      {open && (
        <div
          ref={listRef}
          id={id ? `${id}-listbox` : undefined}
          role="listbox"
          className="absolute left-0 right-0 z-40 mt-1 max-h-64 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-[0_18px_40px_-20px_rgba(0,0,0,0.55)]"
        >
          {filtered.length === 0 && <p className="px-2.5 py-2 text-[11px] text-muted">{emptyLabel}</p>}
          {filtered.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIndex;
            return (
              <button
                key={`${option.value}-${index}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-index={index}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option)}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition",
                  isActive ? "bg-card2 text-text" : "text-muted hover:bg-card2/70 hover:text-text",
                )}
              >
                {option.icon}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-text">{option.label}</span>
                  {option.hint && <span className="block truncate text-[10px] text-muted">{option.hint}</span>}
                </span>
                {isSelected && <Check size={13} className="shrink-0 text-accent2" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
