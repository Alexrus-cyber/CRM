"use client";

import { useEffect, useId, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Camera, MonitorCog, ShieldAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";

const TOAST_STACK_ID = "crm-approval-toast-stack";

const claimedKeys = new Map<string, string>();
const keyListeners = new Set<() => void>();

function notifyKeyListeners() {
  for (const fn of keyListeners) fn();
}

function subscribeKeys(listener: () => void) {
  keyListeners.add(listener);
  return () => {
    keyListeners.delete(listener);
  };
}

function claimToastKey(key: string, ownerId: string) {
  const existing = claimedKeys.get(key);
  if (!existing || existing === ownerId) {
    claimedKeys.set(key, ownerId);
    notifyKeyListeners();
  }
}

function releaseToastKey(key: string, ownerId: string) {
  if (claimedKeys.get(key) === ownerId) {
    claimedKeys.delete(key);
    notifyKeyListeners();
  }
}

function ensureToastStack(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  let el = document.getElementById(TOAST_STACK_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = TOAST_STACK_ID;
    el.className =
      "pointer-events-none fixed bottom-4 right-4 z-50 flex max-h-[calc(100vh-2rem)] w-[min(420px,calc(100vw-2rem))] flex-col gap-2.5 overflow-y-auto";
    document.body.appendChild(el);
  }
  return el;
}

function noopSubscribe() {
  return () => {};
}

export type ApprovalToastTone = "amber" | "cyan";

export function ApprovalToast({
  title,
  description,
  kind,
  tone = "amber",
  badgeLabel = "Требуется разрешение",
  dedupeKey,
  onDismiss,
  dismissDisabled,
  children,
  actions,
}: {
  title: string;
  description?: string;
  kind?: string;
  tone?: ApprovalToastTone;
  badgeLabel?: string;
  dedupeKey?: string;
  onDismiss?: () => void;
  dismissDisabled?: boolean;
  children?: ReactNode;
  actions: ReactNode;
}) {
  const instanceId = useId();
  const stackEl = useSyncExternalStore(noopSubscribe, ensureToastStack, () => null);

  useEffect(() => {
    if (!dedupeKey) return;
    claimToastKey(dedupeKey, instanceId);
    return () => {
      releaseToastKey(dedupeKey, instanceId);
    };
  }, [dedupeKey, instanceId]);

  const owner = useSyncExternalStore(
    subscribeKeys,
    () => (dedupeKey ? claimedKeys.get(dedupeKey) : instanceId),
    () => (dedupeKey ? undefined : instanceId),
  );

  if (!stackEl) return null;
  if (dedupeKey && owner && owner !== instanceId) return null;

  const isScreen = kind === "capture_screen";
  const isOperator = kind === "call_operator";

  return createPortal(
    <div
      role="alertdialog"
      aria-modal="false"
      aria-label={title}
      data-approval-kind={kind ?? "approval"}
      className={cn(
        "pointer-events-auto space-y-2.5 rounded-2xl border bg-card p-3.5 text-xs shadow-2xl backdrop-blur-sm transition-all",
        tone === "cyan" || isScreen
          ? "border-cyan-500/60 ring-1 ring-cyan-500/25"
          : "border-amber-500/60 ring-1 ring-amber-500/25",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border",
            tone === "cyan" || isScreen
              ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-400"
              : "border-amber-500/40 bg-amber-500/15 text-amber-500",
          )}
        >
          {isScreen ? (
            <Camera size={15} />
          ) : isOperator ? (
            <MonitorCog size={15} />
          ) : (
            <ShieldAlert size={15} />
          )}
        </span>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span
              className={cn(
                "rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                tone === "cyan" || isScreen
                  ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-400"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-500",
              )}
            >
              {badgeLabel}
            </span>
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                disabled={dismissDisabled}
                aria-label="Закрыть запрос разрешения"
                className="rounded-md p-0.5 text-muted transition hover:bg-card2 hover:text-text disabled:opacity-40"
              >
                <X size={13} />
              </button>
            )}
          </div>
          <p className="font-semibold leading-snug text-text">{title}</p>
          {description && <p className="text-[11px] leading-relaxed text-muted">{description}</p>}
        </div>
      </div>

      {children}

      <div className="flex flex-wrap gap-2 pt-0.5">{actions}</div>
    </div>,
    stackEl,
  );
}
