"use client";

import { ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { TRUST_LEVELS, type TrustLevel } from "@/lib/trust";
import { cn } from "@/lib/utils";

const ICONS: Record<TrustLevel, typeof ShieldCheck> = {
  full: ShieldAlert,
  verified: ShieldCheck,
  none: ShieldOff,
};

export function TrustSelector({
  value,
  onChange,
  disabled,
  compact,
  label = "Уровень доверия ИИ",
}: {
  value: TrustLevel;
  onChange: (next: TrustLevel) => void;
  disabled?: boolean;
  compact?: boolean;
  label?: string;
}) {
  const active = TRUST_LEVELS.find((item) => item.value === value) ?? TRUST_LEVELS[1];

  return (
    <div className="rounded-xl border border-border bg-card p-2.5">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-text">{label}</span>
        <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-medium", active.badgeClass)}>
          {active.shortLabel}
        </span>
      </div>

      <div
        role="radiogroup"
        aria-label={label}
        className={cn("grid gap-1.5", compact ? "sm:grid-cols-3" : "grid-cols-1 sm:grid-cols-3")}
      >
        {TRUST_LEVELS.map((tier) => {
          const Icon = ICONS[tier.value];
          const selected = tier.value === value;
          return (
            <button
              key={tier.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(tier.value)}
              className={cn(
                "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left text-[11px] transition disabled:opacity-50",
                selected
                  ? "border-accent/60 bg-accent/10 text-text ring-1 ring-accent/30"
                  : "border-border bg-card2/60 text-muted hover:border-border/80 hover:text-text",
              )}
            >
              <Icon
                size={14}
                className={cn(
                  "mt-0.5 shrink-0",
                  selected
                    ? tier.value === "full"
                      ? "text-emerald-500"
                      : tier.value === "verified"
                        ? "text-amber-500"
                        : "text-red-500"
                    : "text-muted",
                )}
              />
              <span className="min-w-0 flex-1 leading-snug font-medium">{tier.label}</span>
            </button>
          );
        })}
      </div>

      <p className="mt-1.5 text-[10px] leading-relaxed text-muted">{active.hint}</p>
    </div>
  );
}
