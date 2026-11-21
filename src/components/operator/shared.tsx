"use client";

import type { ReactNode } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock3,
  Download,
  ExternalLink,
  FileText,
  Flag,
  Gamepad2,
  Globe,
  Keyboard,
  Loader2,
  MousePointerClick,
  MousePointerSquareDashed,
  Move,
  PauseCircle,
  ScrollText,
  Sparkles,
  Timer,
  Type as TypeIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  OperatorCoachMode,
  OperatorTaskMode,
  OperatorTaskSource,
  TaskGuidanceNote,
} from "@/lib/operatorModes";

/** Общие кусочки интерфейса оператора — в стиле остальной CRM. */

export type OperatorTask = {
  id: number;
  prompt: string;
  status: string;
  maxSteps: number;
  steps: number;
  summary: string;
  trustLevel?: string;
  taskMode?: OperatorTaskMode;
  source?: OperatorTaskSource;
  coachMode?: OperatorCoachMode;
  guidanceNote?: TaskGuidanceNote | null;
  pendingApproval?: PendingTaskApproval | string | null;
  approvalResponse?: Record<string, unknown> | string | null;
  createdAt: string;
  updatedAt: string;
};

export type PendingTaskApproval = {
  id: string;
  kind: string;
  title: string;
  description?: string;
  extraSteps?: number;
  action?: Record<string, unknown> | null;
  createdAt?: string;
  requestedAt?: string;
};

export function parsePendingApproval(
  raw?: PendingTaskApproval | Record<string, unknown> | string | null,
): PendingTaskApproval | null {
  if (!raw) return null;
  let parsed: Partial<PendingTaskApproval> | null = null;
  if (typeof raw === "string") {
    if (!raw.trim().startsWith("{")) return null;
    try {
      parsed = JSON.parse(raw) as Partial<PendingTaskApproval>;
    } catch {
      return null;
    }
  } else if (typeof raw === "object") {
    parsed = raw as Partial<PendingTaskApproval>;
  }
  if (!parsed || typeof parsed.title !== "string") return null;
  return {
    id: String(parsed.id ?? ""),
    kind: String(parsed.kind ?? "dangerous_action"),
    title: parsed.title,
    description: parsed.description ? String(parsed.description) : undefined,
    extraSteps: typeof parsed.extraSteps === "number" ? parsed.extraSteps : undefined,
    action: parsed.action && typeof parsed.action === "object" ? parsed.action : null,
    createdAt: parsed.createdAt
      ? String(parsed.createdAt)
      : parsed.requestedAt
        ? String(parsed.requestedAt)
        : undefined,
  };
}

export type OperatorEvent = {
  id: number;
  kind: string;
  text: string;
  action: string;
  fileName: string;
  fileMime: string;
  fileSize: number;
  hasFile: boolean;
  createdAt: string;
};

export const TASK_STATUS: Record<
  string,
  { label: string; className: string; Icon: typeof Clock3 }
> = {
  queued: { label: "в очереди", className: "border-amber-500/40 bg-amber-500/10 text-amber-500", Icon: Clock3 },
  running: { label: "выполняется", className: "border-accent/40 bg-accent/15 text-accent2", Icon: Loader2 },
  waiting_approval: {
    label: "ждёт подтверждения",
    className: "border-amber-500/50 bg-amber-500/15 text-amber-500",
    Icon: PauseCircle,
  },
  waiting_steps: {
    label: "лимит шагов",
    className: "border-amber-500/50 bg-amber-500/15 text-amber-500",
    Icon: PauseCircle,
  },
  done: { label: "готово", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-500", Icon: CheckCircle2 },
  failed: { label: "ошибка", className: "border-red-500/40 bg-red-500/10 text-red-500", Icon: AlertTriangle },
  cancelled: { label: "отменено", className: "border-border bg-card2 text-muted", Icon: Ban },
  paused: { label: "пауза", className: "border-amber-500/40 bg-amber-500/10 text-amber-500", Icon: PauseCircle },
};

export function StatusChip({ status, className }: { status: string; className?: string }) {
  const meta = TASK_STATUS[status] ?? TASK_STATUS.queued;
  const Icon = meta.Icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border px-1.5 py-0.5 text-[10px] font-medium",
        meta.className,
        className,
      )}
    >
      <Icon size={10} className={status === "running" ? "animate-spin" : undefined} />
      {meta.label}
    </span>
  );
}

/** Иконка действия модели — по типу из action.json. */
export function ActionGlyph({ type, size = 14 }: { type: string; size?: number }) {
  switch (type) {
    case "click":
    case "double_click":
    case "right_click":
    case "middle_click":
    case "triple_click":
    case "mouse_down":
    case "mouse_up":
      return <MousePointerClick size={size} />;
    case "move":
    case "move_mouse_rel":
      return <Move size={size} />;
    case "drag":
      return <MousePointerSquareDashed size={size} />;
    case "type":
    case "paste":
      return <TypeIcon size={size} />;
    case "hotkey":
    case "key":
    case "hold_key":
    case "key_down":
    case "key_up":
    case "switch_language":
    case "select_all_copy":
    case "clipboard_get":
    case "clipboard_set":
      return <Keyboard size={size} />;
    case "sequence":
      return <Gamepad2 size={size} />;
    case "scroll":
      return <ScrollText size={size} />;
    case "wait":
      return <Timer size={size} />;
    case "open_url":
      return <Globe size={size} />;
    case "make_file":
      return <FileText size={size} />;
    case "finish":
      return <Flag size={size} />;
    default:
      return <Sparkles size={size} />;
  }
}

type ParsedAction = { type: string; title: string; detail?: string; json?: string };

/** Человеческое описание действия из журнала. */
export function describeAction(raw: string): ParsedAction | null {
  if (!raw || raw === "[object Object]") return null;
  let action: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { type: "unknown", title: raw.slice(0, 120) };
    action = parsed as Record<string, unknown>;
  } catch {
    return { type: "unknown", title: raw.slice(0, 120) };
  }
  const type = String(action.type ?? "unknown");
  const point = (x: unknown, y: unknown) => `(${Number(x)}, ${Number(y)})`;
  const short = (value: unknown, limit = 120) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  };

  switch (type) {
    case "click":
      return { type, title: `Клик ${point(action.x, action.y)}`, json: raw };
    case "double_click":
      return { type, title: `Двойной клик ${point(action.x, action.y)}`, json: raw };
    case "right_click":
      return { type, title: `Правый клик ${point(action.x, action.y)}`, json: raw };
    case "middle_click":
      return { type, title: `Средний клик ${point(action.x, action.y)}`, json: raw };
    case "triple_click":
      return { type, title: `Тройной клик ${point(action.x, action.y)}`, json: raw };
    case "move":
      return { type, title: `Курсор ${point(action.x, action.y)}`, json: raw };
    case "type":
    case "paste":
      return { type, title: `Ввод текста: «${short(action.text, 80)}»`, json: raw };
    case "switch_language":
      return { type, title: `Переключить раскладку (${String(action.target ?? "toggle")})`, json: raw };
    case "select_all_copy":
      return { type, title: "Выделить всё и скопировать", json: raw };
    case "clipboard_get":
      return { type, title: "Прочитать буфер обмена", json: raw };
    case "clipboard_set":
      return { type, title: `Записать в буфер: «${short(action.text, 60)}»`, json: raw };
    case "launch_app":
      return { type, title: `Запуск приложения: ${short(action.app ?? action.path, 60)}`, json: raw };
    case "run_command":
      return { type, title: `Команда Sandbox: ${short(action.command, 80)}`, json: raw };
    case "sandbox_write_file":
      return { type, title: `Файл в Sandbox: ${short(action.path, 60)}`, json: raw };
    case "sandbox_list":
      return { type, title: `Список Sandbox: ${short(action.path ?? ".", 60)}`, json: raw };
    case "export_from_sandbox":
      return {
        type,
        title: `Экспорт из Sandbox: ${short(action.source, 40)} → ${short(action.destination, 40)}`,
        json: raw,
      };
    case "inspect_screen":
      return {
        type,
        title: "Снимок экрана ПК для Агента",
        json: raw,
      };
    case "hotkey":
      return {
        type,
        title: `Горячие клавиши: ${(Array.isArray(action.keys) ? action.keys : []).join(" + ")}`,
        json: raw,
      };
    case "key":
      return { type, title: `Клавиша ${String(action.key ?? "")}`, json: raw };
    case "hold_key":
      return {
        type,
        title: `Удержание клавиши ${String(action.key ?? "w")} (${Number(action.seconds ?? 0.5).toFixed(2)} с)`,
        json: raw,
      };
    case "key_down":
      return { type, title: `Зажата клавиша ${String(action.key ?? "")}`, json: raw };
    case "key_up":
      return { type, title: `Отпущена клавиша ${String(action.key ?? "")}`, json: raw };
    case "move_mouse_rel":
      return {
        type,
        title: `Смещение камеры/мыши (${Number(action.dx ?? 0)}, ${Number(action.dy ?? 0)})`,
        json: raw,
      };
    case "mouse_down":
      return { type, title: `Зажата кнопка мыши (${String(action.button ?? "left")})`, json: raw };
    case "mouse_up":
      return { type, title: `Отпущена кнопка мыши (${String(action.button ?? "left")})`, json: raw };
    case "sequence": {
      const count = Array.isArray(action.steps) ? action.steps.length : 0;
      return { type, title: `Игровая/быстрая серия (${count} действий)`, json: raw };
    }
    case "scroll":
      return {
        type,
        title: `Прокрутка ${Number(action.amount ?? 0) > 0 ? "вверх" : "вниз"}`,
        json: raw,
      };
    case "drag":
      return {
        type,
        title: `Перетаскивание ${point(action.fromX, action.fromY)} → ${point(action.toX, action.toY)}`,
        json: raw,
      };
    case "wait":
      return { type, title: `Пауза ${Number(action.seconds ?? 1)} с`, json: raw };
    case "open_url":
      return { type, title: `Открыть ${short(action.url, 90)}`, json: raw };
    case "make_file":
      return { type, title: `Файл ${short(action.name, 60)}`, json: raw };
    case "finish":
      return { type, title: `Завершение: ${short(action.summary, 120)}`, json: raw };
    default:
      return { type, title: type, json: raw };
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} КБ`;
  return `${Math.round(bytes / 104857.6) / 10} МБ`;
}

/** Небольшая метрика в шапке панели. */
export function MetricCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card px-3 py-2">
      <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-muted">
        <span className="truncate">{label}</span>
        {icon}
      </div>
      <p className="mt-1 text-lg font-semibold leading-none">{value}</p>
      {hint && <p className="mt-1 truncate text-[10px] text-muted">{hint}</p>}
    </div>
  );
}

/** Карточка файла, который вернул бот. */
export function AgentFileCard({
  event,
  compact,
}: {
  event: OperatorEvent;
  compact?: boolean;
}) {
  return (
    <a
      href={`/api/agent/file/${event.id}`}
      className={cn(
        "flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-2 text-emerald-500 transition hover:bg-emerald-500/20",
        compact && "text-[11px]",
      )}
    >
      <FileText size={compact ? 12 : 14} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{event.fileName || event.text}</span>
        {!compact && (
          <span className="block truncate text-[10px] text-muted">
            {event.fileMime} · {formatSize(event.fileSize)}
          </span>
        )}
      </span>
      {compact ? (
        <Download size={11} className="shrink-0" />
      ) : (
        <>
          <span className="shrink-0 text-[10px] text-muted">{formatSize(event.fileSize)}</span>
          <Download size={13} className="shrink-0" />
        </>
      )}
    </a>
  );
}

/** Ссылка на действие вроде open_url прямо из журнала. */
export function ActionLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-lg border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent2 transition hover:bg-accent/20"
    >
      <ExternalLink size={10} /> открыть
    </a>
  );
}
