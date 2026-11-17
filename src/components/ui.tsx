"use client";

import { useEffect, type ReactNode, type ComponentProps } from "react";
import { X } from "lucide-react";
import type { TaskPriority, TaskStatus } from "@/db/schema";
import {
  cn,
  initials,
  PRIORITY_BADGE,
  PRIORITY_LABELS,
  STATUS_BADGE,
  STATUS_LABELS,
} from "@/lib/utils";

/* ---------- Card ---------- */
export function Card({
  className,
  children,
  title,
  subtitle,
  action,
}: {
  className?: string;
  children: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section
      className={cn(
        "min-w-0 max-w-full rounded-2xl border border-border bg-card p-3.5 shadow-sm sm:p-5",
        className,
      )}
    >
      {(title || action) && (
        <header className="mb-3 flex flex-col items-start gap-1.5 min-[420px]:mb-4 min-[420px]:flex-row min-[420px]:flex-wrap min-[420px]:items-start min-[420px]:justify-between min-[420px]:gap-x-3 min-[420px]:gap-y-1">
          <div className="min-w-0 w-full min-[420px]:flex-1">
            {title && <h3 className="text-sm font-semibold tracking-tight">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/* ---------- Button ---------- */
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";
export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: "sm" | "md" | "lg" | "icon" }) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
  const sizes = {
    sm: "h-8 px-3 text-xs",
    md: "h-10 px-4 text-sm",
    lg: "h-11 px-5 text-sm",
    icon: "h-9 w-9",
  };
  const variants: Record<ButtonVariant, string> = {
    primary:
      "bg-gradient-to-r from-[#7c5cff] to-[#a78bfa] text-white shadow-[0_8px_24px_-8px_var(--glow)] hover:brightness-110",
    secondary: "bg-card2 text-text border border-border hover:border-accent/50",
    ghost: "text-muted hover:text-text hover:bg-card2",
    outline: "border border-border text-text hover:bg-card2",
    danger: "bg-red-500/15 text-red-500 border border-red-500/30 hover:bg-red-500/25",
  };
  return <button className={cn(base, sizes[size], variants[variant], className)} {...props} />;
}

/* ---------- Inputs ---------- */
const fieldBase =
  "w-full min-w-0 max-w-full rounded-xl border border-border bg-card2 px-3 py-2 text-sm text-text placeholder:text-muted/70 outline-none transition focus:border-accent focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(fieldBase, "h-10", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(fieldBase, "min-h-[88px] resize-y", className)} {...props} />;
}

export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select className={cn(fieldBase, "h-10 appearance-none pr-8 bg-no-repeat", className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238a8a9f' stroke-width='2'><path d='m6 9 6 6 6-6'/></svg>\")",
        backgroundPosition: "right 0.75rem center",
      }}
      {...props}
    >
      {children}
    </select>
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("mb-1.5 block text-xs font-medium text-muted", className)} {...props} />;
}

export function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

/* ---------- Badges ---------- */
export function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] font-medium leading-5", className)}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <Badge className={STATUS_BADGE[status]}>{STATUS_LABELS[status]}</Badge>;
}

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return (
    <Badge className={PRIORITY_BADGE[priority]}>
      {priority === "critical" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />}
      {PRIORITY_LABELS[priority]}
    </Badge>
  );
}

/* ---------- Avatar ---------- */
export function Avatar({
  name,
  color,
  url,
  size = 36,
  className,
}: {
  name: string;
  color: string;
  url?: string | null;
  size?: number;
  className?: string;
}) {
  const style = { width: size, height: size, fontSize: Math.max(10, size * 0.38) };
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={name}
        style={style}
        className={cn("shrink-0 rounded-full object-cover ring-2 ring-border", className)}
      />
    );
  }
  return (
    <div
      style={{ ...style, background: `linear-gradient(135deg, ${color}, ${color}aa)` }}
      className={cn("flex shrink-0 items-center justify-center rounded-full font-semibold text-white shadow-inner", className)}
    >
      {initials(name) || "?"}
    </div>
  );
}

/* ---------- Modal ---------- */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className={cn(
          "animate-in max-h-[92vh] w-full overflow-hidden rounded-t-2xl border border-border bg-card shadow-2xl sm:rounded-2xl",
          wide ? "sm:max-w-3xl" : "sm:max-w-xl",
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-card2 hover:text-text" aria-label="Закрыть">
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[calc(92vh-130px)] overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-5">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------- Misc ---------- */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  accent,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  accent?: string;
}) {
  return (
    <div className="card-hover relative min-w-0 max-w-full overflow-hidden rounded-2xl border border-border bg-card p-3 sm:p-4">
      <div
        className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full opacity-30 blur-2xl"
        style={{ background: accent ?? "var(--accent)" }}
      />
      <div className="flex items-start justify-between gap-1.5">
        <p className="min-w-0 text-[11px] font-medium leading-tight text-muted sm:text-xs">{label}</p>
        {icon && <span className="shrink-0 text-muted">{icon}</span>}
      </div>
      <p className="mt-1.5 break-words text-xl font-semibold leading-tight tracking-tight sm:mt-2 sm:text-2xl">{value}</p>
      {hint && <p className="mt-0.5 truncate text-[10px] text-muted sm:mt-1 sm:text-xs">{hint}</p>}
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="break-words text-lg font-semibold leading-tight tracking-tight sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-xs text-muted sm:text-sm">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
