"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ClipboardCopy,
  Compass,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Gamepad2,
  Inbox,
  KeyRound,
  Loader2,
  MonitorCog,
  Paperclip,
  Play,
  PlugZap,
  Plus,
  Rocket,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  TriangleAlert,
  X,
} from "lucide-react";
import { Badge, Button, Card, EmptyState, Input, Textarea } from "@/components/ui";
import { cn, formatDateTime, formatTime } from "@/lib/utils";
import { useStoredJson } from "@/lib/useStoredValue";
import { GenSettings } from "./GenSettings";
import { TrustSelector } from "./TrustSelector";
import {
  AGENT_MAX_STEPS,
  GEN_DEFAULT_PARAMS,
  OPERATOR_MAX_EXTEND_STEPS,
  decodeGenParams,
  type GenParams,
} from "@/lib/genParams";
import {
  DEFAULT_TRUST_LEVEL,
  decodeTrustLevel,
  findTrustLevel,
  normalizeTrustLevel,
  type TrustLevel,
} from "@/lib/trust";
import {
  DEFAULT_OPERATOR_COACH_MODE,
  DEFAULT_OPERATOR_TASK_MODE,
  OPERATOR_COACH_MODES,
  OPERATOR_TASK_MODES,
  findTaskMode,
  normalizeCoachMode,
  normalizeTaskMode,
  type OperatorCoachMode,
  type OperatorTaskMode,
} from "@/lib/operatorModes";
import {
  OPERATOR_PROVIDERS,
  buildCommandWithKey,
  buildEnvLine,
  buildOperatorCommand,
  findProvider,
  looksTextOnlyModel,
  providerBaseUrl,
} from "@/lib/operatorCommand";
import {
  ActionGlyph,
  ActionLink,
  AgentFileCard,
  describeAction,
  MetricCard,
  parsePendingApproval,
  StatusChip,
  type OperatorEvent,
  type OperatorTask,
} from "./operator/shared";
import { ApprovalToast } from "./ApprovalToast";
import { PlannerChat } from "./operator/PlannerChat";
import { ConnectionsCard, type ConnectionSelection } from "./operator/ConnectionsCard";
import { formatFileSize, readOperatorFiles, type OperatorAttachment } from "./operator/files";

/**
 * Вкладка «Оператор» блока ИИ — в стиле остальной Nova CRM.
 *
 * Внутри три подвкладки:
 *   • Пульт — поставить задание и смотреть, что бот делает шаг за шагом;
 *   • Запуски — история заданий со статусами и фильтрами;
 *   • Подключение — токен бота, установка зависимостей и готовые команды
 *     запуска для локальной модели или облачного API.
 *
 * Сам бот живёт на компьютере пользователя (`agent/desktop_operator.py`),
 * сюда он присылает шаги и файлы.
 */

const SUBTABS = [
  { id: "desk", label: "Пульт", icon: MonitorCog, hint: "новое задание и ход выполнения" },
  { id: "runs", label: "Запуски", icon: Inbox, hint: "история заданий" },
  { id: "setup", label: "Подключение", icon: Settings2, hint: "токен и запуск бота" },
] as const;

type SubTab = (typeof SUBTABS)[number]["id"];

const PRESETS = [
  "Открой блокнот, напиши план на день и сохрани в файл plan.docx",
  "Открой YouTube и включи видео про космос",
  "Сделай таблицу расходов за неделю и сохрани в xlsx",
  "Открой почту и проверь новые письма",
];

const GAME_PRESETS = [
  "Управляй персонажем в игре: осмотри экран, беги вперёд (hold_key W), поверни камеру и взаимодействуй (E)",
  "Помоги пройти текущий участок уровня в игре и подсказывай следующий шаг после каждого действия",
];

const COPILOT_PRESETS = [
  "Помоги пошагово настроить и проверить открытое окно программы на экране",
];

const RUN_FILTERS = [
  { id: "all", label: "Все" },
  { id: "queued", label: "В очереди" },
  { id: "running", label: "Выполняются" },
  { id: "done", label: "Готово" },
] as const;

/** Флаг из localStorage: `useStoredJson` отдаёт строку JSON. */
function decodeFlag(raw: string): boolean {
  return raw === "true";
}

function decodeTaskModeStorage(raw: string): OperatorTaskMode {
  return normalizeTaskMode(raw.replace(/^"|"$/g, ""));
}

function decodeCoachModeStorage(raw: string): OperatorCoachMode {
  return normalizeCoachMode(raw.replace(/^"|"$/g, ""));
}

function statusFilterMatches(status: string, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "queued") return status === "queued" || status === "paused";
  if (filter === "running") return status === "running" || status === "waiting_approval" || status === "waiting_steps";
  if (filter === "done") return status === "done";
  return true;
}

function formatAgo(seconds: number): string {
  if (seconds < 5) return "только что";
  if (seconds < 60) return `${seconds} с назад`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин назад`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} ч назад`;
  return `${Math.floor(seconds / 86_400)} дн назад`;
}

type BotCheckState = {
  state: "idle" | "busy" | "online" | "warn" | "fail";
  text: string;
  checkedAt?: string;
};

export function OperatorPanel() {
  const [tab, setTab] = useState<SubTab>("desk");
  // Подключение и токен из карточки «Подключения и токены» (хранятся в базе).
  const [connection, setConnection] = useState<ConnectionSelection | null>(null);
  // Ручная вставка: пригодится, если токен выдан на другой машине.
  const [tokenInput, setTokenInput] = useState("");
  const [check, setCheck] = useState<{ state: "idle" | "busy" | "ok" | "fail"; text: string }>({
    state: "idle",
    text: "",
  });
  // Ручная проверка подключения настольного бота: срабатывает только по кнопке,
  // без фонового опроса и постоянного индикатора.
  const [botCheck, setBotCheck] = useState<BotCheckState>({ state: "idle", text: "" });
  const [tasks, setTasks] = useState<OperatorTask[]>([]);
  const [events, setEvents] = useState<OperatorEvent[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [runFilter, setRunFilter] = useState<string>("all");
  const taskFileRef = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState("");
  const [taskFiles, setTaskFiles] = useState<OperatorAttachment[]>([]);
  const [maxSteps, setMaxSteps] = useState(15);
  // Раздумья и генерация: общие для планировщика и команды запуска бота.
  const [genParams, setGenParams] = useStoredJson<GenParams>(
    "crm.ai.operator.params.v1",
    GEN_DEFAULT_PARAMS,
    decodeGenParams,
  );
  const [trustLevel, setTrustLevel] = useStoredJson<TrustLevel>(
    "crm.ai.operator.trust.v1",
    DEFAULT_TRUST_LEVEL,
    decodeTrustLevel,
  );
  const [taskMode, setTaskMode] = useStoredJson<OperatorTaskMode>(
    "crm.ai.operator.taskmode.v1",
    DEFAULT_OPERATOR_TASK_MODE,
    decodeTaskModeStorage,
  );
  const [coachMode, setCoachMode] = useStoredJson<OperatorCoachMode>(
    "crm.ai.operator.coachmode.v1",
    DEFAULT_OPERATOR_COACH_MODE,
    decodeCoachModeStorage,
  );
  const [guidanceInput, setGuidanceInput] = useState("");
  const [coachBusy, setCoachBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  // Храним именно «выключено»: useStoredNumber не сохраняет 0 и переключатель
  // нельзя было выключить.
  const [verifyOff, setVerifyOff] = useStoredJson<boolean>(
    "crm.ai.operator.verify.off.v1",
    false,
    decodeFlag,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Параметры для сборки команды запуска.
  const [provider, setProvider] = useState<string>("local");
  const [model, setModel] = useState("");
  const [server, setServer] = useState("http://localhost:3000");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keyMode, setKeyMode] = useState<"inline" | "env">("inline");
  const [once, setOnce] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [assumeYes, setAssumeYes] = useState(false);
  const [textOnly, setTextOnly] = useState(false);

  /* ------------------------------ загрузка ------------------------------ */

  // Последнее применённое подключение: адрес подставляем только когда сменилось
  // само подключение, иначе ручная правка «Адреса CRM» затиралась бы на каждом
  // обновлении списка токенов.
  const appliedConnection = useRef<{ id: number | null; server: string }>({ id: null, server: "" });

  const onConnectionChange = useCallback((next: ConnectionSelection) => {
    setConnection(next);
    const applied = appliedConnection.current;
    const changed = applied.id !== next.connectionId || applied.server !== next.server;
    appliedConnection.current = { id: next.connectionId, server: next.server };
    // Адрес CRM берём из подключения: команда должна смотреть в тот же сервер.
    if (changed && next.server) setServer(next.server);
  }, []);

  const fetchTasks = useCallback(async (): Promise<OperatorTask[] | null> => {
    try {
      const res = await fetch("/api/agent/tasks", { cache: "no-store" });
      if (!res.ok) return null;
      const data = (await res.json()) as { tasks?: OperatorTask[] };
      return data.tasks ?? [];
    } catch {
      return null;
    }
  }, []);

  const fetchTask = useCallback(
    async (id: number): Promise<{ task: OperatorTask | null; events: OperatorEvent[] } | null> => {
      try {
        const res = await fetch(`/api/agent/tasks/${id}`, { cache: "no-store" });
        if (!res.ok) return null;
        const data = (await res.json()) as { task?: OperatorTask; events?: OperatorEvent[] };
        return { task: data.task ?? null, events: data.events ?? [] };
      } catch {
        return null;
      }
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    void fetchTasks().then((list) => {
      if (!alive) return;
      if (list) setTasks(list);
    });
    return () => {
      alive = false;
    };
  }, [fetchTasks]);

  const activeTask = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? tasks[0] ?? null,
    [tasks, selectedId],
  );
  const activeId = activeTask?.id ?? null;

  // Очередь обновляется сама: бот работает в фоне.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fetchTasks().then((list) => {
        if (list) setTasks(list);
      });
    }, 3500);
    return () => window.clearInterval(timer);
  }, [fetchTasks]);

  // Открытое задание: шаги подтягиваются на лету.
  useEffect(() => {
    if (!activeId || tab !== "desk") return;
    let alive = true;
    void fetchTask(activeId).then((data) => {
      if (!alive || !data) return;
      setEvents(data.events);
      if (data.task) {
        setTasks((prev) => prev.map((task) => (task.id === activeId ? data.task! : task)));
      }
    });
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fetchTask(activeId).then((data) => {
        if (!data) return;
        setEvents(data.events);
        if (data.task) {
          setTasks((prev) => prev.map((task) => (task.id === activeId ? data.task! : task)));
        }
      });
    }, 2500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [activeId, tab, fetchTask]);

  /* ------------------------------ действия ------------------------------ */

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Браузер не разрешил доступ к буферу обмена — скопируйте вручную");
    }
  };

  const checkConnection = async () => {
    const value = (connection?.token.trim() || tokenInput.trim()).trim();
    if (!value) {
      setCheck({
        state: "fail",
        text: "Сначала создайте токен в подключении или нажмите «Показать» у существующего.",
      });
      return;
    }
    setCheck({ state: "busy", text: "" });
    try {
      const res = await fetch("/api/agent/bot/whoami", {
        headers: { "x-agent-token": value, "x-check-only": "1" },
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as {
        owner?: { name?: string };
        counts?: { queued?: number; running?: number };
        error?: string;
        hint?: string;
      };
      if (!res.ok) {
        const text = [data.error, data.hint].filter(Boolean).join(" · ");
        setCheck({ state: "fail", text: text || `CRM ответила HTTP ${res.status}` });
        return;
      }
      setCheck({
        state: "ok",
        text: `Токен принят${data.owner?.name ? ` · ${data.owner.name}` : ""} · в очереди ${
          data.counts?.queued ?? 0
        }, в работе ${data.counts?.running ?? 0}`,
      });
    } catch {
      setCheck({ state: "fail", text: "CRM не отвечает — проверьте адрес CRM в шаге 3." });
    }
  };

  /**
   * Ручная проверка подключения бота по нажатию кнопки: проверяет реальную
   * активность токенов и текущих запусков в CRM (без автоопроса и heartbeat).
   */
  const checkBotConnection = async () => {
    if (botCheck.state === "busy") return;
    setBotCheck({ state: "busy", text: "" });
    try {
      const query = connection?.connectionId ? `?connectionId=${connection.connectionId}` : "";
      const res = await fetch(`/api/agent/bot/status${query}`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as {
        state?: "online" | "stale" | "never" | "no_tokens";
        secondsAgo?: number | null;
        tokenName?: string;
        tokenHint?: string;
        connectionName?: string;
        tokensCount?: number;
        totalTokensCount?: number;
        runningTask?: { id: number; steps: number; maxSteps: number } | null;
        queue?: { queued?: number; running?: number };
        checkedAt?: string;
        error?: string;
      };
      if (!res.ok || !data.state) {
        setBotCheck({ state: "fail", text: data.error ?? `Не удалось проверить подключение (HTTP ${res.status})` });
        return;
      }

      const checkedAt = data.checkedAt ? formatTime(data.checkedAt) : formatTime(new Date());
      const tokenLabel = data.tokenName
        ? `токен «${data.tokenName}»${data.tokenHint ? ` ${data.tokenHint}` : ""}`
        : data.tokenHint || "токен";
      const connLabel = data.connectionName ? `, подключение «${data.connectionName}»` : "";
      const queueLabel = `в очереди ${data.queue?.queued ?? 0}, в работе ${data.queue?.running ?? 0}`;

      if (data.state === "no_tokens") {
        setBotCheck({
          state: "warn",
          checkedAt,
          text:
            connection?.connectionName && (data.totalTokensCount ?? 0) > 0
              ? `В подключении «${connection.connectionName}» нет токенов — создайте токен во вкладке «Подключение».`
              : "Нет токенов подключения — создайте токен во вкладке «Подключение» и запустите desktop_operator.py.",
        });
        return;
      }

      if (data.state === "never") {
        setBotCheck({
          state: "warn",
          checkedAt,
          text: `Бот ещё ни разу не подключался к CRM (токенов: ${data.tokensCount ?? 0}). Запустите desktop_operator.py с флагом --watch · ${queueLabel}.`,
        });
        return;
      }

      if (data.state === "online") {
        const ago = data.secondsAgo !== null && data.secondsAgo !== undefined ? formatAgo(data.secondsAgo) : "сейчас";
        const taskPart = data.runningTask
          ? `выполняет запуск #${data.runningTask.id} (шаг ${data.runningTask.steps}/${data.runningTask.maxSteps})`
          : `последний опрос ${ago}`;
        setBotCheck({
          state: "online",
          checkedAt,
          text: `Бот подключён · ${taskPart} (${tokenLabel}${connLabel}) · ${queueLabel}`,
        });
        return;
      }

      const ago = data.secondsAgo !== null && data.secondsAgo !== undefined ? formatAgo(data.secondsAgo) : "давно";
      setBotCheck({
        state: "warn",
        checkedAt,
        text: `Бот сейчас не на связи · последний опрос ${ago} (${tokenLabel}${connLabel}) · проверьте, запущен ли desktop_operator.py --watch`,
      });
    } catch {
      setBotCheck({ state: "fail", text: "CRM не отвечает — не удалось проверить подключение бота." });
    }
  };

  /**
   * Ставит задание в очередь. Вызывается и из чата с действиями, и кнопкой
   * «Перенести в выполнение» из планировщика — во втором случае план уже
   * содержит уточнённые шаги, поэтому prompt приходит аргументом.
   */
  const createTask = async (planText?: string, planFiles?: OperatorAttachment[]) => {
    const text = (planText ?? prompt).trim();
    if (!text) throw new Error("Опишите задачу: пустой план выполнять нечего");
    if (busy) throw new Error("Подождите: предыдущее задание ещё ставится в очередь");
    const files = planFiles ?? taskFiles;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: text,
          maxSteps: Math.max(maxSteps, 1),
          trustLevel,
          taskMode,
          coachMode,
          files: files.map((file) => ({
            name: file.name,
            mime: file.mime,
            size: file.size,
            data: file.data,
          })),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        task?: OperatorTask;
        error?: string;
      };
      if (!res.ok || !data.task) {
        throw new Error(data.error ?? "Не удалось поставить задание");
      }
      if (planText === undefined) {
        setPrompt("");
        setTaskFiles([]);
      }
      setTasks((prev) => [data.task!, ...prev]);
      setSelectedId(data.task.id);
      setEvents([]);
      setTab("desk");
    } finally {
      setBusy(false);
    }
  };

  const attachToTask = async (list: FileList | File[]) => {
    if (list.length === 0) return;
    setError(null);
    const { files: added, errors } = await readOperatorFiles(taskFiles, list);
    setTaskFiles((prev) => [...prev, ...added]);
    if (errors.length > 0) setError(errors[0]);
  };

  const cancelTask = async (id: number) => {
    const res = await fetch(`/api/agent/tasks/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    });
    if (!res.ok) {
      setError("Не удалось отменить задание");
      return;
    }
    setTasks((prev) => prev.map((task) => (task.id === id ? { ...task, status: "cancelled" } : task)));
  };

  const respondApproval = async (id: number, decision: "approve" | "reject", approvalId?: string) => {
    if (actionBusy) return;
    setActionBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent/tasks/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: decision, approvalId }),
      });
      const data = (await res.json().catch(() => ({}))) as { task?: OperatorTask; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Не удалось отправить ответ");
        return;
      }
      if (data.task) {
        setTasks((prev) => prev.map((task) => (task.id === id ? data.task! : task)));
      }
    } finally {
      setActionBusy(false);
    }
  };

  const sendGuidance = async (id: number, noteText: string) => {
    const clean = noteText.trim();
    if (!clean || coachBusy) return;
    setCoachBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent/tasks/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "guidance", text: clean }),
      });
      const data = (await res.json().catch(() => ({}))) as { task?: OperatorTask; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Не удалось отправить подсказку Оператору");
        return;
      }
      setGuidanceInput("");
      if (data.task) {
        setTasks((prev) => prev.map((task) => (task.id === id ? data.task! : task)));
      }
      const updated = await fetchTask(id);
      if (updated) setEvents(updated.events);
    } finally {
      setCoachBusy(false);
    }
  };

  const askAgentNextStep = async (id: number) => {
    if (coachBusy) return;
    setCoachBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/agent/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: id, userHint: guidanceInput.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { task?: OperatorTask; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Не удалось получить совет от Агента");
        return;
      }
      if (data.task) {
        setTasks((prev) => prev.map((task) => (task.id === id ? data.task! : task)));
      }
      const updated = await fetchTask(id);
      if (updated) setEvents(updated.events);
    } finally {
      setCoachBusy(false);
    }
  };

  const extendSteps = async (id: number, addSteps = 20) => {
    if (actionBusy) return;
    setActionBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent/tasks/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "extend_steps", addSteps }),
      });
      const data = (await res.json().catch(() => ({}))) as { task?: OperatorTask; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Не удалось продлить лимит шагов");
        return;
      }
      if (data.task) {
        setTasks((prev) => prev.map((task) => (task.id === id ? data.task! : task)));
      }
    } finally {
      setActionBusy(false);
    }
  };

  /* ------------------------------- выводы ------------------------------- */

  const counts = useMemo(
    () => ({
      all: tasks.length,
      queued: tasks.filter((task) => task.status === "queued" || task.status === "paused").length,
      running: tasks.filter(
        (task) => task.status === "running" || task.status === "waiting_approval" || task.status === "waiting_steps",
      ).length,
      done: tasks.filter((task) => task.status === "done").length,
    }),
    [tasks],
  );

  const files = useMemo(() => events.filter((event) => event.kind === "file"), [events]);
  const currentAction = useMemo(
    () => [...events].reverse().find((event) => event.kind === "action" && event.action) ?? null,
    [events],
  );
  const currentThought = useMemo(() => {
    const index = currentAction ? events.findIndex((event) => event.id === currentAction.id) : -1;
    if (index <= 0) return "";
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (events[cursor].kind === "thought" && events[cursor].text) return events[cursor].text;
      if (events[cursor].kind === "action") break;
    }
    return "";
  }, [events, currentAction]);

  const latestGuidance = useMemo(
    () =>
      activeTask?.guidanceNote?.text
        ? {
            text: activeTask.guidanceNote.text,
            userAdvice: activeTask.guidanceNote.userAdvice,
            author: activeTask.guidanceNote.author,
          }
        : [...events]
            .reverse()
            .find((event) => event.kind === "guidance" && event.text)
            ? {
                text: [...events].reverse().find((event) => event.kind === "guidance" && event.text)!.text,
                userAdvice: undefined,
                author: "operator",
              }
            : null,
    [activeTask, events],
  );
  const parsedAction = describeAction(currentAction?.action ?? "");
  const pendingApproval = useMemo(
    () => parsePendingApproval(activeTask?.pendingApproval),
    [activeTask?.pendingApproval],
  );
  const progress = activeTask ? Math.min(100, Math.round((activeTask.steps / Math.max(activeTask.maxSteps, 1)) * 100)) : 0;
  const finished = activeTask ? ["done", "failed", "cancelled"].includes(activeTask.status) : false;

  const effectiveToken = (connection?.token.trim() || tokenInput.trim()).trim();

  const providerMeta = findProvider(provider);
  const commandOptions = useMemo(
    () => ({
      provider,
      token: effectiveToken,
      model,
      server,
      apiKey,
      keyMode,
      once,
      dryRun,
      assumeYes,
      textOnly,
      trustLevel,
      taskMode,
      coachMode,
      gen: genParams,
      verifyActions: !verifyOff,
    }),
    [
      provider,
      effectiveToken,
      model,
      server,
      apiKey,
      keyMode,
      once,
      dryRun,
      assumeYes,
      textOnly,
      trustLevel,
      taskMode,
      coachMode,
      genParams,
      verifyOff,
    ],
  );
  const command = useMemo(() => buildOperatorCommand(commandOptions), [commandOptions]);
  const commandToCopy = useMemo(() => buildCommandWithKey(commandOptions), [commandOptions]);
  const envLine = keyMode === "env" && apiKey.trim() ? buildEnvLine(provider, apiKey) : "";

  const visibleTasks = useMemo(
    () => tasks.filter((task) => statusFilterMatches(task.status, runFilter)),
    [tasks, runFilter],
  );

  return (
    <div className="space-y-3">
      {/* Подвкладки оператора */}
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Разделы оператора"
          className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1"
        >
          {SUBTABS.map((item) => {
            const Icon = item.icon;
            const active = item.id === tab;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                title={item.hint}
                onClick={() => setTab(item.id)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition",
                  active ? "bg-accent/15 text-text ring-1 ring-accent/30" : "text-muted hover:bg-card2 hover:text-text",
                )}
              >
                <Icon size={13} />
                {item.label}
              </button>
            );
          })}
        </div>
        <Badge className="border-border text-muted">
          <Terminal size={11} /> desktop_operator.py
        </Badge>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {connection && connection.connectionId !== null && connection.tokensCount === 0 && (
            <button
              type="button"
              onClick={() => setTab("setup")}
              className="flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-500"
            >
              <KeyRound size={11} /> нет токенов
            </button>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void checkBotConnection()}
            disabled={botCheck.state === "busy"}
            title="Разовая проверка: выходил ли бот на связь с CRM"
          >
            {botCheck.state === "busy" ? <Loader2 size={12} className="animate-spin" /> : <PlugZap size={12} />}
            Проверить подключение бота
          </Button>
        </div>
      </div>

      {botCheck.state !== "idle" && botCheck.state !== "busy" && (
        <div
          className={cn(
            "flex items-start gap-2 rounded-xl border px-3 py-2 text-[11px] leading-relaxed",
            botCheck.state === "online"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
              : botCheck.state === "warn"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
                : "border-red-500/40 bg-red-500/10 text-red-500",
          )}
        >
          {botCheck.state === "online" ? (
            <Check size={13} className="mt-0.5 shrink-0" />
          ) : (
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          )}
          <span className="min-w-0 flex-1">
            {botCheck.text}
            {botCheck.checkedAt && <span className="ml-1.5 text-[10px] opacity-80">· проверено в {botCheck.checkedAt}</span>}
          </span>
          <button
            type="button"
            onClick={() => setBotCheck({ state: "idle", text: "" })}
            className="shrink-0 opacity-70 transition hover:opacity-100"
            aria-label="Скрыть результат проверки бота"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Пульт */}
      {tab === "desk" && (
        <div className="space-y-3">
          <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
            <MetricCard label="В очереди" value={counts.queued} hint="ждёт бота" icon={<Inbox size={12} />} />
            <MetricCard label="В работе" value={counts.running} hint="выполняется сейчас" icon={<Loader2 size={12} />} />
            <MetricCard label="Готово" value={counts.done} hint="из последних запусков" icon={<Check size={12} />} />
            <MetricCard label="Файлы" value={files.length} hint="в открытом запуске" icon={<FileText size={12} />} />
          </div>

          <TrustSelector value={trustLevel} onChange={setTrustLevel} />

          <GenSettings
            value={genParams}
            onChange={setGenParams}
            defaultOpen
            subtitle="Раздумья модели и параметры генерации. Действуют и на планировщик, и на команду запуска бота."
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex items-start gap-2 text-[11px] text-muted">
                <input
                  type="checkbox"
                  checked={!verifyOff}
                  onChange={(event) => setVerifyOff(!event.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[#7c5cff]"
                />
                <span>
                  Анализировать экран <strong className="font-medium text-text">после каждого действия</strong>:
                  бот делает скриншот и спрашивает модель, получилось ли. Надёжнее, но на один запрос к модели больше.
                </span>
              </label>
              <div className="space-y-1.5">
                <p className="text-[10px] leading-relaxed text-muted">
                  Бот получает эти настройки флагами{" "}
                  <code className="font-mono">--temperature</code>, <code className="font-mono">--reasoning</code> и
                  другими. Скопируйте команду и перезапустите бота — ключ API в CRM не сохраняется.
                </p>
                <Button size="sm" variant="secondary" onClick={() => void copy(commandToCopy, "gen-command")}>
                  <ClipboardCopy size={12} />
                  {copied === "gen-command" ? "Команда скопирована" : "Скопировать команду с этими настройками"}
                </Button>
              </div>
            </div>
          </GenSettings>

          {/* Два чата: сначала план, потом действия на компьютере */}
          <div className="grid gap-3 lg:grid-cols-2">
            <PlannerChat
              providerLabel={providerMeta.label}
              params={genParams}
              baseUrl={providerBaseUrl(provider)}
              model={model.trim() || providerMeta.defaultModel}
              apiKey={apiKey.trim()}
              onOpenSetup={() => setTab("setup")}
              onTransfer={(plan, planFiles) => createTask(plan, planFiles)}
            />

            <Card
              title={
                <span className="flex flex-wrap items-center gap-2">
                  2. Выполнение
                  <Badge className="border-border text-muted">
                    <Play size={11} /> шагов: до {maxSteps}
                  </Badge>
                  <Badge className={findTaskMode(taskMode).badgeClass}>
                    {taskMode === "game" ? <Gamepad2 size={11} /> : <Compass size={11} />}
                    {findTaskMode(taskMode).shortLabel}
                  </Badge>
                </span>
              }
              subtitle="Задание уходит в очередь: бот кликает по экрану, играет или помогает шаг за шагом."
              action={
                <Badge className="border-border text-muted">
                  <MonitorCog size={11} /> на вашем ПК
                </Badge>
              }
            >
              {/* Выбор режима Оператора (автопилот / помощник ПК / игра и персонаж) и сопровождения */}
              <div className="mb-2.5 space-y-2 rounded-xl border border-border bg-card2/50 p-2">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="mr-1 text-[10px] font-medium text-muted">Режим:</span>
                  {OPERATOR_TASK_MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        setTaskMode(m.id);
                        if (m.id === "game" && maxSteps < 40) setMaxSteps(50);
                        if (m.id !== "autonomous" && coachMode === "off") setCoachMode("agent");
                      }}
                      title={m.description}
                      className={cn(
                        "flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-medium transition",
                        taskMode === m.id
                          ? m.badgeClass
                          : "border-border bg-card text-muted hover:text-text",
                      )}
                    >
                      {m.id === "game" && <Gamepad2 size={11} />}
                      {m.shortLabel}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                  <span className="text-muted">После каждого шага:</span>
                  {OPERATOR_COACH_MODES.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setCoachMode(c.id)}
                      title={c.hint}
                      className={cn(
                        "rounded-lg border px-2 py-0.5 transition",
                        coachMode === c.id
                          ? "border-accent/50 bg-accent/15 text-text"
                          : "border-border bg-card text-muted hover:text-text",
                      )}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                {taskMode === "game" && (
                  <p className="text-[10px] leading-snug text-accent2">
                    Игровой режим: доступны удержание клавиш (WASD/Space/Shift), поворот камеры мышью и быстрые серии,
                    а после выхода клавиши автоматически отпускаются.
                  </p>
                )}
              </div>

              <Textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={3}
                maxLength={4000}
                placeholder={
                  taskMode === "game"
                    ? "Опишите цель в игре и управление (например: иди вперёд по тропе, нажми E у двери)"
                    : "План из чата слева или своя формулировка задачи"
                }
                className="text-[11px]"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(taskMode === "game" ? GAME_PRESETS : taskMode === "copilot" ? [...COPILOT_PRESETS, ...PRESETS] : PRESETS).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setPrompt(preset)}
                    className="max-w-full truncate rounded-lg border border-border bg-card2 px-2 py-1 text-[10px] text-muted transition hover:border-accent/50 hover:text-text"
                  >
                    {preset}
                  </button>
                ))}
              </div>

              {taskFiles.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {taskFiles.map((file) => (
                    <span
                      key={`${file.name}-${file.size}`}
                      className="flex items-center gap-1 rounded-lg border border-border bg-card2 px-1.5 py-0.5 text-[10px] text-muted"
                    >
                      {file.name} · {formatFileSize(file.size)}
                      <button
                        type="button"
                        onClick={() => setTaskFiles((prev) => prev.filter((item) => item !== file))}
                        className="text-muted transition hover:text-red-500"
                        aria-label={`Убрать ${file.name}`}
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-[11px] text-muted">
                  Лимит шагов
                  <Input
                    type="number"
                    min={1}
                    max={AGENT_MAX_STEPS}
                    value={maxSteps}
                    onChange={(event) =>
                      setMaxSteps(Math.min(AGENT_MAX_STEPS, Math.max(1, Number(event.target.value) || 15)))
                    }
                    className="h-8 w-16 px-2 text-[11px]"
                  />
                </label>
                <input
                  ref={taskFileRef}
                  type="file"
                  multiple
                  className="sr-only"
                  aria-label="Приложить файлы к заданию"
                  onChange={(event) => {
                    // Снимок до очистки: иначе браузер опустошает FileList.
                    const list = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    void attachToTask(list);
                  }}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => taskFileRef.current?.click()}
                  title="Файлы (до 5 по 10 МБ) — бот прочитает текст и учтёт в плане"
                >
                  <Paperclip size={11} /> файлы
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    void createTask().catch((caught: unknown) =>
                      setError(caught instanceof Error ? caught.message : "Не удалось поставить задание"),
                    );
                  }}
                  disabled={busy || prompt.trim().length === 0}
                  className="ml-auto"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                  В очередь
                </Button>
              </div>
              {error && <p className="mt-2 text-[11px] text-red-500">{error}</p>}
            </Card>
          </div>

          {!activeTask ? (
            <EmptyState
              title="Запусков пока нет"
              hint="Поставьте первое задание — бот заберёт его из очереди, как только вы его запустите."
            />
          ) : (
            <div className="space-y-3">
              <Card
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    Запуск #{activeTask.id}
                    <StatusChip status={activeTask.status} />
                    {activeTask.trustLevel && (
                      <span
                        className={cn(
                          "rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                          findTrustLevel(normalizeTrustLevel(activeTask.trustLevel)).badgeClass,
                        )}
                      >
                        {findTrustLevel(normalizeTrustLevel(activeTask.trustLevel)).shortLabel}
                      </span>
                    )}
                    {activeTask.taskMode && activeTask.taskMode !== "autonomous" && (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                          findTaskMode(activeTask.taskMode).badgeClass,
                        )}
                      >
                        {activeTask.taskMode === "game" ? <Gamepad2 size={10} /> : <Compass size={10} />}
                        {findTaskMode(activeTask.taskMode).shortLabel}
                      </span>
                    )}
                    {activeTask.source === "agent" && (
                      <span className="rounded-md border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-400">
                        запущено из Агента
                      </span>
                    )}
                    {activeTask.coachMode === "agent" && (
                      <span className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-medium text-cyan-400">
                        Агент подсказывает
                      </span>
                    )}
                    <span className="text-[10px] font-normal text-muted">
                      {formatDateTime(activeTask.createdAt)}
                    </span>
                  </span>
                }
                subtitle={activeTask.prompt}
                action={
                  !finished ? (
                    <Button size="sm" variant="danger" onClick={() => void cancelTask(activeTask.id)}>
                      <Square size={12} /> Остановить
                    </Button>
                  ) : (
                    <Badge className="border-border text-muted">
                      <Check size={11} /> {activeTask.status === "done" ? "выполнено" : "завершено"}
                    </Badge>
                  )
                }
              >
                <div className="flex items-center gap-2 text-[10px] text-muted">
                  <span>
                    шаг {activeTask.steps}/{activeTask.maxSteps}
                  </span>
                  <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-card2">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        activeTask.status === "failed"
                          ? "bg-red-500"
                          : activeTask.status === "done"
                            ? "bg-emerald-500"
                            : "bg-accent",
                      )}
                      style={{ width: `${Math.max(progress, 2)}%` }}
                    />
                  </div>
                  {!finished && activeTask.maxSteps < OPERATOR_MAX_EXTEND_STEPS && (
                    <button
                      type="button"
                      onClick={() => void extendSteps(activeTask.id, 20)}
                      disabled={actionBusy}
                      className="flex shrink-0 items-center gap-0.5 rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent2 hover:bg-accent/20 disabled:opacity-50"
                      title="Продлить лимит шагов этой задачи без потери контекста (до 2000)"
                    >
                      <Plus size={10} /> +20 шагов
                    </button>
                  )}
                  {activeTask.summary && <span className="truncate">{activeTask.summary}</span>}
                </div>

                {(pendingApproval || activeTask.status === "waiting_steps" || activeTask.status === "waiting_approval") && (
                  <p className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] font-medium text-amber-400">
                    Запрос подтверждения показан во всплывающем окне справа внизу экрана.
                  </p>
                )}

                {activeTask.status === "queued" && events.length === 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-muted">
                    <TriangleAlert size={13} className="text-amber-500" />
                    <span>
                      Задание в очереди. Запустите бота с токеном —
                      <button
                        type="button"
                        onClick={() => setTab("setup")}
                        className="ml-1 font-medium text-accent2 underline-offset-2 hover:underline"
                      >
                        команда запуска
                      </button>
                      . Уже запускали?
                      <button
                        type="button"
                        onClick={() => void checkBotConnection()}
                        className="ml-1 font-medium text-accent2 underline-offset-2 hover:underline"
                      >
                        Проверить подключение бота
                      </button>
                      .
                    </span>
                  </div>
                )}

                <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
                  {/* Текущий шаг */}
                  <div className="min-w-0 rounded-xl border border-border bg-card2/60 p-3">
                    <p className="text-[10px] uppercase tracking-wide text-muted">Текущий шаг</p>
                    {parsedAction ? (
                      <div className="mt-2 space-y-2">
                        <div className="flex items-start gap-2">
                          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent2">
                            <ActionGlyph type={parsedAction.type} size={14} />
                          </span>
                          <div className="min-w-0">
                            <p className="text-xs font-medium leading-snug">{parsedAction.title}</p>
                            {currentThought && (
                              <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-muted">{currentThought}</p>
                            )}
                          </div>
                        </div>
                        {currentAction?.text && currentAction.text !== parsedAction.title && (
                          <p className="rounded-lg bg-card px-2 py-1.5 text-[11px] text-emerald-500">
                            → {currentAction.text}
                          </p>
                        )}
                        {parsedAction.json && (
                          <details className="rounded-lg border border-border bg-card">
                            <summary className="cursor-pointer px-2 py-1 text-[10px] text-muted">action.json</summary>
                            <pre className="max-h-40 overflow-auto border-t border-border px-2 py-1.5 text-[10px] leading-relaxed text-muted">
                              {parsedAction.json}
                            </pre>
                          </details>
                        )}
                      </div>
                    ) : (
                      <p className="mt-2 text-[11px] leading-relaxed text-muted">
                        {activeTask.status === "queued"
                          ? "Бот ещё не забрал задание — шаги появятся здесь."
                          : "Шагов пока нет."}
                      </p>
                    )}

                    {files.length > 0 && (
                      <div className="mt-3 space-y-1.5">
                        <p className="text-[10px] uppercase tracking-wide text-muted">Файлы задания</p>
                        {files.map((file) => (
                          <AgentFileCard key={file.id} event={file} compact />
                        ))}
                      </div>
                    )}

                    {/* Пошаговая помощь: что делать дальше (подсказки Агента и ручное управление) */}
                    <div className="mt-3 space-y-2 rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-cyan-400">
                          <Compass size={11} /> Помощь: что делать дальше
                        </p>
                        {!finished && (
                          <button
                            type="button"
                            onClick={() => void askAgentNextStep(activeTask.id)}
                            disabled={coachBusy}
                            className="flex items-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-50"
                          >
                            {coachBusy ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                            Совет Агента
                          </button>
                        )}
                      </div>
                      {latestGuidance ? (
                        <div className="rounded-lg border border-border bg-card px-2 py-1.5 text-[11px] leading-relaxed">
                          <p className="text-text">{latestGuidance.userAdvice || latestGuidance.text}</p>
                          {latestGuidance.userAdvice && latestGuidance.text !== latestGuidance.userAdvice && (
                            <p className="mt-0.5 text-[10px] text-muted">Для Оператора: {latestGuidance.text}</p>
                          )}
                        </div>
                      ) : (
                        <p className="text-[10px] text-muted">
                          После каждого действия здесь появится подсказка, что делать дальше — либо задайте направление вручную.
                        </p>
                      )}
                      {!finished && (
                        <div className="flex gap-1.5">
                          <Input
                            value={guidanceInput}
                            onChange={(e) => setGuidanceInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void sendGuidance(activeTask.id, guidanceInput);
                              }
                            }}
                            placeholder="Подсказка на следующий шаг (напр. «нажми E у двери»)"
                            className="h-8 text-[11px]"
                          />
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void sendGuidance(activeTask.id, guidanceInput)}
                            disabled={coachBusy || !guidanceInput.trim()}
                          >
                            <Send size={11} /> Подсказать
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Лента шагов */}
                  <div className="flex min-w-0 max-h-[420px] flex-col overflow-hidden rounded-xl border border-border bg-card2/40">
                    <div className="flex items-center justify-between border-b border-border px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-muted">Лента действий</p>
                      <span className="text-[10px] text-muted">{events.length} записей</span>
                    </div>
                    <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
                      {events.length === 0 ? (
                        <p className="px-1 py-6 text-center text-[11px] text-muted">
                          Здесь появятся мысль модели, действие и результат по каждому кадру.
                        </p>
                      ) : (
                        events.map((event) => (
                          <EventRow key={event.id} event={event} />
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </div>
      )}

      {/* Запуски */}
      {tab === "runs" && (
        <Card
          title="Запуски"
          subtitle="Все задания бота — от новых к старым"
          action={
            <div className="flex flex-wrap gap-1">
              {RUN_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => setRunFilter(filter.id)}
                  className={cn(
                    "rounded-lg border px-2 py-1 text-[10px] transition",
                    runFilter === filter.id
                      ? "border-accent/40 bg-accent/15 text-text"
                      : "border-border bg-card2 text-muted hover:text-text",
                  )}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          }
        >
          {visibleTasks.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-muted">Ничего не найдено под этот фильтр.</p>
          ) : (
            <div className="divide-y divide-border">
              {visibleTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(task.id);
                    setEvents([]);
                    setTab("desk");
                  }}
                  className={cn(
                    "flex w-full items-start gap-2 px-1 py-2 text-left transition hover:bg-card2/60",
                    task.id === activeTask?.id && "bg-accent/5",
                  )}
                >
                  <span className="mt-0.5 text-[10px] text-muted">#{task.id}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{task.prompt}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
                      <StatusChip status={task.status} />
                      <span>
                        шагов {task.steps}/{task.maxSteps}
                      </span>
                      <span>{formatDateTime(task.createdAt)}</span>
                      {task.summary && <span className="truncate">· {task.summary}</span>}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Подключение */}
      {tab === "setup" && (
        <div className="space-y-3">
          <ConnectionsCard defaultServer={server} onChange={onConnectionChange} />

          <Card
            title="Проверка токена"
            subtitle="Убедиться, что бот с этим токеном видит очередь CRM"
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={tokenInput}
                onChange={(event) => {
                  setTokenInput(event.target.value);
                  setCheck({ state: "idle", text: "" });
                }}
                placeholder="crmop_… — если токен выдан на другой машине"
                spellCheck={false}
                autoComplete="off"
                className="h-9 min-w-0 flex-1 font-mono text-[11px]"
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void checkConnection()}
                disabled={check.state === "busy"}
              >
                {check.state === "busy" ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                Проверить связь
              </Button>
            </div>
            {check.state !== "idle" && check.state !== "busy" && (
              <p
                className={cn(
                  "mt-1.5 flex items-start gap-1.5 text-[10px] leading-relaxed",
                  check.state === "ok" ? "text-emerald-500" : "text-red-500",
                )}
              >
                {check.state === "ok" ? <Check size={11} className="mt-0.5 shrink-0" /> : <TriangleAlert size={11} className="mt-0.5 shrink-0" />}
                {check.text}
              </p>
            )}
            <p className="mt-1.5 text-[10px] leading-relaxed text-muted">
              Проверяется токен, выбранный в подключении (если он показан) или вставленный вручную.
              Маска вида «…abcdef» не подойдёт — нажмите «Показать» у нужного токена.
            </p>
          </Card>

          <Card
            title="2. Установка зависимостей"
            subtitle="Нужны один раз: pyautogui делает скриншоты и клики, Pillow сжимает кадр"
          >
            <pre className="overflow-x-auto rounded-xl bg-card2 px-3 py-2 text-[11px]">
              pip install -r agent/requirements.txt
            </pre>
            <p className="mt-2 text-[11px] text-muted">
              Linux: дополнительно <code className="rounded bg-card2 px-1">sudo apt install python3-tk scrot</code>. macOS:
              разрешите терминалу «Запись экрана» и «Универсальный доступ».
            </p>
          </Card>

          <Card
            title="3. Команда запуска"
            subtitle="Соберите её под свою модель — локальную или облачную"
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-[11px] text-muted">
                Провайдер
                <select
                  value={provider}
                  onChange={(event) => {
                    const next = findProvider(event.target.value);
                    setProvider(next.id);
                    if (!model.trim() && next.defaultModel) setModel(next.defaultModel);
                  }}
                  className="mt-1 h-9 w-full rounded-xl border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
                >
                  {OPERATOR_PROVIDERS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] text-muted">
                Модель (необязательно)
                <Input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder={`например, ${providerMeta.visionModel}`}
                  className="mt-1 h-9 text-[11px]"
                />
                <span className="mt-1 block text-[10px]">
                  Зрение проверяется при запуске — модель должна понимать картинки.
                </span>
              </label>
              <div className="text-[11px] text-muted sm:col-span-2">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                  <span>
                    Ключ API{" "}
                    <span className="text-[10px]">
                      {providerMeta.needsKey ? `— обязателен для ${providerMeta.label}, нужен боту, не CRM` : "— локальной модели обычно не нужен"}
                    </span>
                  </span>
                  <div className="flex shrink-0 gap-1">
                    {(["inline", "env"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setKeyMode(mode)}
                        className={cn(
                          "rounded-lg border px-1.5 py-0.5 text-[10px] transition",
                          keyMode === mode
                            ? "border-accent/40 bg-accent/15 text-text"
                            : "border-border bg-card2 text-muted hover:text-text",
                        )}
                      >
                        {mode === "inline" ? "--api-key" : providerMeta.keyEnv}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <Input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={providerMeta.needsKey ? "sk-… (ключ провайдера)" : "обычно не требуется"}
                    spellCheck={false}
                    autoComplete="off"
                    className="h-9 min-w-0 flex-1 font-mono text-[11px]"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setShowKey((value) => !value)}
                    title={showKey ? "Скрыть ключ" : "Показать ключ"}
                    aria-label={showKey ? "Скрыть ключ" : "Показать ключ"}
                  >
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </Button>
                </div>
                {providerMeta.needsKey && !apiKey.trim() && (
                  <p className="mt-1 text-[10px] text-amber-500">
                    Без ключа {providerMeta.label} ответит 401 «Модель отклонила ключ API». Вставьте ключ
                    или задайте переменную <code className="rounded bg-card2 px-1">{providerMeta.keyEnv}</code>.
                  </p>
                )}
                <p className="mt-1 text-[10px] text-muted">
                  Ключ не уходит в CRM и не сохраняется: он попадает только в текст команды в вашем браузере.
                </p>
              </div>
              <label className="text-[11px] text-muted">
                Адрес CRM
                <Input
                  value={server}
                  onChange={(event) => setServer(event.target.value)}
                  placeholder="http://localhost:3000"
                  className="mt-1 h-9 text-[11px]"
                />
              </label>
              <div className="flex flex-wrap items-end gap-2 text-[11px] text-muted">
                <FlagToggle label="один запуск" checked={once} onChange={setOnce} />
                <FlagToggle label="только план" checked={dryRun} onChange={setDryRun} />
                <FlagToggle label="без вопросов" checked={assumeYes} onChange={setAssumeYes} />
                <FlagToggle label="без скриншотов" checked={textOnly} onChange={setTextOnly} />
                <label className="flex items-center gap-1.5 text-[10px] text-muted">
                  Режим (--task-mode)
                  <select
                    value={taskMode}
                    onChange={(event) => setTaskMode(normalizeTaskMode(event.target.value))}
                    className="h-7 rounded-lg border border-border bg-card2 px-1.5 text-[10px] text-text"
                  >
                    {OPERATOR_TASK_MODES.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.shortLabel}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-[10px] text-muted">
                  Советы (--coach)
                  <select
                    value={coachMode}
                    onChange={(event) => setCoachMode(normalizeCoachMode(event.target.value))}
                    className="h-7 rounded-lg border border-border bg-card2 px-1.5 text-[10px] text-text"
                  >
                    {OPERATOR_COACH_MODES.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            {looksTextOnlyModel(model) && (
              <div className="mt-2 flex items-start gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-amber-500">
                <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                <span>
                  «{model.trim()}» — текстовая модель, картинки она не принимает: экран бот не увидит
                  и будет промахиваться. Для работы по скриншоту укажите{" "}
                  <button
                    type="button"
                    onClick={() => setModel(providerMeta.visionModel)}
                    className="font-medium underline underline-offset-2"
                  >
                    {providerMeta.visionModel}
                  </button>
                  .
                </span>
              </div>
            )}

            <div className="mt-3 rounded-xl border border-border bg-card2 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted">
                  <Terminal size={11} /> терминал
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void copy(commandToCopy, "command")}
                  disabled={!effectiveToken}
                >
                  {copied === "command" ? <Check size={12} /> : <Copy size={12} />}
                  {copied === "command" ? "скопировано" : "копировать"}
                </Button>
              </div>
              <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-card px-2.5 py-2 text-[11px] leading-relaxed">
                {envLine ? `${envLine}\n${command}` : command}
              </pre>
              {keyMode === "env" && apiKey.trim() && (
                <p className="mt-1.5 text-[10px] text-muted">
                  Windows (cmd): <code className="rounded bg-card2 px-1">set {providerMeta.keyEnv}={apiKey.trim()}</code>{" "}
                  отдельной строкой перед запуском.
                </p>
              )}
              {!effectiveToken && (
                <p className="mt-1.5 text-[10px] text-amber-500">
                  Сначала создайте токен в шаге 1 или вставьте сохранённый в «Проверку токена» — команда
                  с плейсхолдером CRM не примет.
                </p>
              )}
            </div>

            <p className="mt-2 text-[11px] text-muted">
              Бот берёт ключ из <code className="rounded bg-card2 px-1">--api-key</code> или из переменной
              окружения провайдера — оба варианта собираются выше. Перед запуском команду можно проверить
              флагом <code className="rounded bg-card2 px-1">--check</code>: он покажет связь с CRM, не обращаясь
              к модели.
            </p>
          </Card>

          <Card title="4. Как это работает" subtitle="Коротко о том, что происходит дальше">
            <ol className="space-y-1.5 text-[11px] text-muted">
              <li className="flex gap-2">
                <span className="font-semibold text-text">1.</span> Вы ставите задание на «Пульте» — оно попадает в очередь.
              </li>
              <li className="flex gap-2">
                <span className="font-semibold text-text">2.</span> Бот забирает его по токену, делает скриншот и спрашивает модель.
              </li>
              <li className="flex gap-2">
                <span className="font-semibold text-text">3.</span> Каждое действие (клик, ввод, файл) появляется в «Ленте действий».
              </li>
              <li className="flex gap-2">
                <span className="font-semibold text-text">4.</span> Файлы, которые собрал бот, скачиваются прямо из карточки.
              </li>
            </ol>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => setTab("desk")}>
                <Rocket size={13} /> К заданиям
              </Button>
              <span className="text-[10px] text-muted">
                Аварийная остановка: уведите мышь в левый верхний угол экрана.
              </span>
            </div>
          </Card>
        </div>
      )}

      {(() => {
        const isWaiting = (t: OperatorTask) =>
          Boolean(parsePendingApproval(t.pendingApproval)) ||
          t.status === "waiting_steps" ||
          t.status === "waiting_approval";
        const waitingTask =
          activeTask && isWaiting(activeTask) ? activeTask : tasks.find(isWaiting) ?? null;
        if (!waitingTask) return null;
        const waitingApproval = parsePendingApproval(waitingTask.pendingApproval);
        const isStepLimit = waitingApproval?.kind === "step_limit" || waitingTask.status === "waiting_steps";
        return (
          <ApprovalToast
            dedupeKey={`op-task-${waitingTask.id}-${waitingApproval?.id ?? waitingTask.status}`}
            kind={waitingApproval?.kind ?? waitingTask.status}
            badgeLabel={`Оператор #${waitingTask.id}`}
            title={
              waitingApproval?.title ??
              (isStepLimit
                ? `Достигнут лимит ${waitingTask.maxSteps} шагов`
                : "Оператор ждёт вашего подтверждения")
            }
            description={waitingApproval?.description}
            actions={
              isStepLimit ? (
                <>
                  <Button
                    size="sm"
                    onClick={() => void extendSteps(waitingTask.id, waitingApproval?.extraSteps ?? 20)}
                    disabled={actionBusy}
                  >
                    <Plus size={12} /> +{waitingApproval?.extraSteps ?? 20} шагов и продолжить
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void extendSteps(waitingTask.id, 50)}
                    disabled={actionBusy}
                  >
                    <Plus size={12} /> +50 шагов
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => void cancelTask(waitingTask.id)}
                    disabled={actionBusy}
                  >
                    <Square size={12} /> Остановить
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    onClick={() => void respondApproval(waitingTask.id, "approve", waitingApproval?.id)}
                    disabled={actionBusy}
                  >
                    <Check size={12} /> Разрешить выполнение
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => void respondApproval(waitingTask.id, "reject", waitingApproval?.id)}
                    disabled={actionBusy}
                  >
                    <X size={12} /> Отклонить
                  </Button>
                </>
              )
            }
          >
            {waitingApproval?.action && (
              <pre className="max-h-32 overflow-auto rounded-lg bg-card2 px-2 py-1.5 font-mono text-[10px] text-text">
                {JSON.stringify(waitingApproval.action, null, 2)}
              </pre>
            )}
          </ApprovalToast>
        );
      })()}
    </div>
  );
}

/* --------------------------- вспомогательные --------------------------- */

/** Адрес из action.json — только для ссылки «открыть». */
function urlFromAction(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as { url?: unknown };
    return typeof data.url === "string" ? data.url : null;
  } catch {
    return null;
  }
}

function FlagToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      className={cn(
        "flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[10px] transition",
        checked ? "border-accent/40 bg-accent/15 text-text" : "border-border bg-card2 text-muted hover:text-text",
      )}
    >
      <span
        className={cn(
          "flex h-3 w-3 items-center justify-center rounded border",
          checked ? "border-accent bg-accent text-white" : "border-border",
        )}
      >
        {checked && <Check size={8} />}
      </span>
      {label}
    </button>
  );
}

function EventRow({ event }: { event: OperatorEvent }) {
  if (event.kind === "file") {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-1.5">
        <AgentFileCard event={event} compact />
        <p className="mt-1 px-1 text-[9px] text-muted">{formatTime(event.createdAt)}</p>
      </div>
    );
  }

  const parsed = describeAction(event.action);
  const checkPassed = event.kind === "result" && event.text.startsWith("✅");
  const isGuidance = event.kind === "guidance";
  const iconType = parsed?.type ?? (event.kind === "error" ? "error" : "info");
  const title =
    parsed?.title ||
    (event.kind === "thought"
      ? "Мысль модели"
      : isGuidance
        ? "Что делать дальше"
        : event.kind === "error"
          ? "Ошибка"
          : event.kind === "approval"
            ? "Подтверждение на сайте"
            : event.kind === "screen"
              ? "Снимок экрана ПК для Агента"
              : event.kind === "result"
                ? checkPassed ? "Проверка: получилось" : "Проверка: результат под вопросом"
                : event.kind === "info"
                  ? "Служебное сообщение"
                  : "Действие");

  return (
    <div
      className={cn(
        "rounded-lg border px-2 py-1.5",
        isGuidance ? "border-cyan-500/40 bg-cyan-500/5" : "border-border bg-card",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md",
            isGuidance
              ? "bg-cyan-500/15 text-cyan-400"
              : event.kind === "error"
                ? "bg-red-500/10 text-red-500"
                : event.kind === "result"
                  ? checkPassed
                    ? "bg-emerald-500/10 text-emerald-500"
                    : "bg-amber-500/10 text-amber-500"
                  : "bg-card2 text-muted",
          )}
        >
          {isGuidance ? (
            <Compass size={11} />
          ) : event.kind === "thought" ? (
            <Sparkles size={11} />
          ) : event.kind === "error" ? (
            <TriangleAlert size={11} />
          ) : event.kind === "result" ? (
            checkPassed ? <Check size={11} /> : <TriangleAlert size={11} />
          ) : (
            <ActionGlyph type={iconType} size={11} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          {(parsed && event.kind === "action") || event.kind === "result" || isGuidance ? (
            <p
              className={cn(
                "text-[11px] font-medium leading-snug",
                isGuidance && "text-cyan-400",
                event.kind === "result" && (checkPassed ? "text-emerald-500" : "text-amber-500"),
              )}
            >
              {title}
            </p>
          ) : null}
          {event.text && event.text !== title && (
            <p
              className={cn(
                "text-[11px] leading-relaxed",
                event.kind === "action" ? "text-emerald-500" : "text-muted",
                event.kind !== "action" && !parsed && "line-clamp-4",
              )}
            >
              {event.text}
            </p>
          )}
          {parsed?.json && event.kind === "action" && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[9px] text-muted">action.json</summary>
              <pre className="mt-1 max-h-32 overflow-auto rounded bg-card2 px-1.5 py-1 text-[9px] leading-relaxed text-muted">
                {parsed.json}
              </pre>
            </details>
          )}
          {event.kind === "action" && parsed?.type === "open_url" && urlFromAction(event.action) && (
            <div className="mt-1">
              <ActionLink url={urlFromAction(event.action)!} />
            </div>
          )}
        </div>
        <span className="shrink-0 text-[9px] text-muted">{formatTime(event.createdAt)}</span>
      </div>
    </div>
  );
}
