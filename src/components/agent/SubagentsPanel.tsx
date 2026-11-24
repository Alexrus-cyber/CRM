"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Brain,
  Check,
  Coins,
  Cpu,
  GitBranch,
  History,
  KeyRound,
  Loader2,
  Lock,
  MessageSquare,
  MessageSquarePlus,
  Network,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Unlock,
  Wrench,
  X,
} from "lucide-react";
import { ApprovalToast } from "../ApprovalToast";
import { LiveReasoningBox } from "../LiveReasoningBox";
import {
  formatFileSize,
  readOperatorFiles,
  type OperatorAttachment,
} from "../operator/files";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Label,
  Select,
  Textarea,
} from "@/components/ui";
import { AI_REASONING_MODES } from "@/lib/ai";
import { cn } from "@/lib/utils";
import {
  DependencyTreeCanvas,
  type DependencyTreeNodePayload,
  type OrchestratorPosition,
} from "./DependencyTreeCanvas";
import {
  formatTokensCount,
  parseCalleesList,
  type OverseerConfig,
  type OverseerMode,
  type OverseerVerdictMeta,
  type Subagent,
  type SubagentConversation,
  type SubagentLimits,
  type SubagentMessage,
  type SubagentRoutingMode,
  type SubagentRun,
  type SubagentToolProfile,
} from "./subagentTypes";

export type {
  Subagent,
  SubagentRun,
  SubagentConversation,
  SubagentMessage,
  SubagentLimits,
} from "./subagentTypes";

type Props = {
  settings: { baseUrl: string; model: string; apiKey?: string };
  params: Record<string, unknown>;
  trustLevel: string;
  modelContextLength?: number | null;
  github?: { owner: string; repo: string; branch: string } | null;
  refreshKey?: number;
  onOpenModelTab?: () => void;
  onStats?: (stats: {
    totalCount: number;
    activeCount: number;
    runs: number;
    routingMode?: SubagentRoutingMode;
    overseerEnabled?: boolean;
  }) => void;
};

type SubagentFormState = Partial<Subagent> & {
  apiKey: string;
  clearApiKey?: boolean;
  allowedCalleesText: string;
};

const DEFAULT_OVERSEER: OverseerConfig = {
  enabled: true,
  mode: "strict",
  systemPrompt: "",
  unlockApi: false,
  provider: "local",
  baseUrl: "",
  model: "",
  hasApiKey: false,
  apiKeyHint: "",
};

const EMPTY_FORM: SubagentFormState = {
  name: "",
  roleTitle: "",
  description: "",
  systemPrompt: "",
  color: "#7c5cff",
  isActive: true,
  parentSubagentId: null,
  orchestratorCanCall: true,
  allowedCalleesText: "*",
  toolProfile: "restricted",
  unlockApi: false,
  provider: "local",
  baseUrl: "",
  model: "",
  apiKey: "",
  clearApiKey: false,
  reasoningMode: "default",
  slug: "",
};

const SUBAGENT_COLORS = [
  "#7c5cff",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#0ea5e9",
  "#06b6d4",
  "#a855f7",
  "#ec4899",
];

const SUBAGENT_PROVIDERS: Array<{ id: string; label: string; baseUrl: string; model: string }> = [
  { id: "local", label: "Локальная (vLLM / llama.cpp / LM Studio)", baseUrl: "http://127.0.0.1:8888/v1", model: "" },
  { id: "openai", label: "OpenAI API", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "qwen/qwen2.5-vl-72b-instruct" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "together", label: "Together", baseUrl: "https://api.together.xyz/v1", model: "Qwen/Qwen2.5-72B-Instruct-Turbo" },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", model: "mistral-large-latest" },
  { id: "custom", label: "Свой адрес…", baseUrl: "", model: "" },
];

const RUN_STATUS_META: Record<
  SubagentRun["status"],
  { label: string; badgeClass: string }
> = {
  running: {
    label: "выполняется",
    badgeClass: "border-cyan-500/35 bg-cyan-500/15 text-cyan-400",
  },
  completed: {
    label: "готово",
    badgeClass: "border-emerald-500/35 bg-emerald-500/15 text-emerald-500",
  },
  handoff: {
    label: "передача",
    badgeClass: "border-violet-500/35 bg-violet-500/15 text-violet-400",
  },
  blocked: {
    label: "заблокирован",
    badgeClass: "border-amber-500/35 bg-amber-500/15 text-amber-500",
  },
  error: {
    label: "Ошибка",
    badgeClass: "border-red-500/35 bg-red-500/15 text-red-500",
  },
  // Автоперенос контекста в новый чат — это НЕ передача задачи другому субагенту.
  rotated: {
    label: "Перенос в новый чат",
    badgeClass: "border-sky-500/35 bg-sky-500/15 text-sky-300",
  },
  cancelled: {
    label: "Отменён",
    badgeClass: "border-border bg-card2 text-muted",
  },
};

/** Запуск без heartbeat дольше 10 минут считаем «устаревшим» (как на сервере). */
const SUBAGENT_RUN_STALE_MS = 10 * 60 * 1000;

/** Понятные названия полей дерева для баннера конфликта версий. */
const TREE_FIELD_LABELS: Record<string, string> = {
  isActive: "активность",
  parentSubagentId: "родительский субагент",
  orchestratorCanCall: "прямой вызов Оркестратором",
  allowedCallees: "разрешённые вызываемые субагенты",
  routingMode: "режим маршрутизации",
};

/** «5 мин назад» — чтобы у застрявшего запуска был виден возраст. */
function formatElapsedSince(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const diffMs = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "только что";
  if (mins < 60) return `${mins} мин назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.floor(hours / 24)} дн назад`;
}

function slugifyFallback(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "subagent";
}

function resolveProviderId(provider: string, baseUrl: string): string {
  const cleanProvider = (provider ?? "").trim().toLowerCase();
  if (SUBAGENT_PROVIDERS.some((p) => p.id === cleanProvider)) return cleanProvider;
  const cleanUrl = (baseUrl ?? "").trim().replace(/\/+$/, "").toLowerCase();
  const matched = SUBAGENT_PROVIDERS.find(
    (p) => p.baseUrl && p.baseUrl.toLowerCase() === cleanUrl,
  );
  if (matched) return matched.id;
  return cleanUrl ? "custom" : "local";
}

export function SubagentsPanel({
  settings,
  params,
  trustLevel,
  modelContextLength,
  github,
  refreshKey = 0,
  onOpenModelTab,
  onStats,
}: Props) {
  const [subagents, setSubagents] = useState<Subagent[]>([]);
  const [runs, setRuns] = useState<SubagentRun[]>([]);
  const [conversations, setConversations] = useState<SubagentConversation[]>([]);
  const [limits, setLimits] = useState<SubagentLimits>({
    maxStored: 50,
    maxActive: 10,
    totalCount: 0,
    activeCount: 0,
  });
  const [routingMode, setRoutingMode] = useState<SubagentRoutingMode>("linear");
  const [orchestratorPos, setOrchestratorPos] = useState<OrchestratorPosition>({ x: null, y: null });
  const [overseer, setOverseer] = useState<OverseerConfig>(DEFAULT_OVERSEER);
  const [overseerSyncKey, setOverseerSyncKey] = useState(0);
  const [showOverseer, setShowOverseer] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<SubagentFormState | null>(null);
  const [showTree, setShowTree] = useState(true);
  const [viewChatFor, setViewChatFor] = useState<number | null>(null);
  /** Версия дерева из GET — для оптимистичной блокировки PUT (P0-4). */
  const [treeVersion, setTreeVersion] = useState<string | null>(null);
  const [treeConflict, setTreeConflict] = useState<{
    message: string;
    conflicts: Array<{ id: number; name: string; field: string }>;
  } | null>(null);
  /** Какой запуск сейчас выполняет cancel/retry — чтобы блокировать кнопки. */
  const [runActionBusy, setRunActionBusy] = useState<number | null>(null);
  /** Чат, который нужно открыть после retry: {субагент, conversation.id из ответа}. */
  const [presetChat, setPresetChat] = useState<{ subagentId: number; convId: number } | null>(null);

  const onStatsRef = useRef(onStats);
  const selectedIdRef = useRef(selectedId);
  const inFlightLoadRef = useRef<Promise<void> | null>(null);
  const abortLoadRef = useRef<AbortController | null>(null);
  /** Номер последнего запроса load(): устаревшие ответы игнорируются. */
  const loadSeqRef = useRef(0);
  /** Последний payload дерева — для «Сохранить принудительно» после 409. */
  const lastTreePayloadRef = useRef<{
    nodes: DependencyTreeNodePayload[];
    nextOrchPos?: OrchestratorPosition;
  } | null>(null);
  const mountedRef = useRef(true);
  const prevRefreshKeyRef = useRef(refreshKey);

  useEffect(() => {
    onStatsRef.current = onStats;
  }, [onStats]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortLoadRef.current?.abort();
      inFlightLoadRef.current = null;
    };
  }, []);

  /**
   * Единый загрузчик: новый вызов отменяет предыдущий запрос, а устаревший ответ
   * игнорируется (иначе `await load()` после сохранения мог откатить UI к старым данным).
   */
  const load = useCallback(async (opts?: { showSpinner?: boolean }) => {
    abortLoadRef.current?.abort();
    const controller = new AbortController();
    abortLoadRef.current = controller;
    const seq = ++loadSeqRef.current;
    const isCurrent = () =>
      !controller.signal.aborted && seq === loadSeqRef.current && mountedRef.current;

    const promise = (async () => {
      if (opts?.showSpinner && mountedRef.current) {
        setLoading(true);
      }
      try {
        const res = await fetch("/api/agent/subagents", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error ?? "Не удалось загрузить субагентов");
        }
        const data = (await res.json()) as {
          subagents?: Subagent[];
          runs?: SubagentRun[];
          conversations?: SubagentConversation[];
          limits?: SubagentLimits;
          routingMode?: SubagentRoutingMode;
          orchestratorPos?: OrchestratorPosition | null;
          overseer?: Partial<OverseerConfig>;
          treeVersion?: string;
        };
        if (!isCurrent()) return;

        const nextSubs = Array.isArray(data.subagents) ? data.subagents : [];
        const nextRuns = Array.isArray(data.runs) ? data.runs : [];
        const nextConvs = Array.isArray(data.conversations) ? data.conversations : [];
        const nextLimits: SubagentLimits = data.limits ?? {
          maxStored: 50,
          maxActive: 10,
          totalCount: nextSubs.length,
          activeCount: nextSubs.filter((s) => s.isActive).length,
        };
        const nextRouting: SubagentRoutingMode =
          data.routingMode === "layered" ? "layered" : "linear";
        const nextOrchPos: OrchestratorPosition = {
          x: typeof data.orchestratorPos?.x === "number" ? data.orchestratorPos.x : null,
          y: typeof data.orchestratorPos?.y === "number" ? data.orchestratorPos.y : null,
        };
        const nextOverseer: OverseerConfig = {
          ...DEFAULT_OVERSEER,
          ...(data.overseer ?? {}),
          mode: data.overseer?.mode === "rules_only" ? "rules_only" : "strict",
          enabled: data.overseer?.enabled !== undefined ? Boolean(data.overseer.enabled) : true,
        };

        setSubagents(nextSubs);
        setRuns(nextRuns);
        setConversations(nextConvs);
        setLimits(nextLimits);
        setRoutingMode(nextRouting);
        setOrchestratorPos(nextOrchPos);
        setOverseer(nextOverseer);
        setTreeVersion(typeof data.treeVersion === "string" ? data.treeVersion : null);
        // P2-1: карточку Надсмотрщика НЕ перемонтируем на каждом load() — иначе
        // несохранённые правки стираются после любого SSE-события.
        setError(null);

        if (selectedIdRef.current && !nextSubs.some((s) => s.id === selectedIdRef.current)) {
          setSelectedId(null);
        }

        onStatsRef.current?.({
          totalCount: nextLimits.totalCount,
          activeCount: nextLimits.activeCount,
          runs: nextRuns.length,
          routingMode: nextRouting,
          overseerEnabled: nextOverseer.enabled,
        });
      } catch (e) {
        if (!isCurrent()) return;
        setError(e instanceof Error ? e.message : "Ошибка загрузки");
      } finally {
        if (abortLoadRef.current === controller) {
          inFlightLoadRef.current = null;
        }
        if (mountedRef.current && seq === loadSeqRef.current) {
          setLoading(false);
        }
      }
    })();

    inFlightLoadRef.current = promise;
    return promise;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (prevRefreshKeyRef.current !== refreshKey) {
      prevRefreshKeyRef.current = refreshKey;
      void load();
    }
  }, [refreshKey, load]);

  // P1-3: пока есть хотя бы один `running`-запуск — обновляем статусы раз в 15 секунд.
  const hasRunningRuns = useMemo(() => runs.some((r) => r.status === "running"), [runs]);
  useEffect(() => {
    if (!hasRunningRuns) return;
    const timer = setInterval(() => {
      void load();
    }, 15_000);
    return () => clearInterval(timer);
  }, [hasRunningRuns, load]);

  const byId = useMemo(() => new Map(subagents.map((s) => [s.id, s])), [subagents]);
  const totalRunsTokens = useMemo(
    () => runs.reduce((acc, r) => acc + Math.max(0, Number(r.totalTokens) || 0), 0),
    [runs],
  );
  const orchestratorModelLabel = settings.model.trim() || "по умолчанию";

  const createOrUpdate = useCallback(
    async (form: SubagentFormState) => {
      setError(null);
      const allowedCallees = parseCalleesList(form.allowedCalleesText);
      const body: Record<string, unknown> = {
        name: form.name,
        slug: form.slug || undefined,
        roleTitle: form.roleTitle,
        description: form.description,
        systemPrompt: form.systemPrompt,
        color: form.color,
        isActive: form.isActive,
        parentSubagentId: form.parentSubagentId ?? null,
        orchestratorCanCall: form.orchestratorCanCall,
        allowedCallees: allowedCallees.length > 0 ? allowedCallees : ["*"],
        toolProfile: (form.toolProfile === "full" ? "full" : "restricted") as SubagentToolProfile,
        unlockApi: Boolean(form.unlockApi),
        provider: form.provider,
        baseUrl: form.baseUrl,
        model: form.model,
        reasoningMode: form.reasoningMode,
      };
      if (form.apiKey && form.apiKey.trim()) {
        body.apiKey = form.apiKey.trim();
      }
      if (form.clearApiKey) {
        body.clearApiKey = true;
      }

      if (editing?.id) {
        const res = await fetch(`/api/agent/subagents/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error ?? "Не удалось обновить субагента");
        }
      } else {
        const res = await fetch("/api/agent/subagents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error ?? "Не удалось создать субагента");
        }
      }
      setEditing(null);
      await load({ showSpinner: true });
    },
    [editing, load],
  );

  const remove = useCallback(
    async (id: number) => {
      if (!confirm("Удалить субагента безвозвратно?")) return;
      setError(null);
      try {
        const res = await fetch(`/api/agent/subagents/${id}`, { method: "DELETE" });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error ?? "Не удалось удалить субагента");
        }
        if (selectedIdRef.current === id) setSelectedId(null);
        if (viewChatFor === id) setViewChatFor(null);
        await load({ showSpinner: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Ошибка удаления");
      }
    },
    [load, viewChatFor],
  );

  const saveTree = useCallback(
    async (
      nodes: DependencyTreeNodePayload[],
      nextOrchPos?: OrchestratorPosition,
      opts?: { force?: boolean },
    ) => {
      setError(null);
      if (!opts?.force) setTreeConflict(null);
      lastTreePayloadRef.current = { nodes, nextOrchPos };
      const res = await fetch("/api/agent/subagents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodes,
          routingMode,
          ...(nextOrchPos !== undefined ? { orchestratorPos: nextOrchPos } : {}),
          // P0-4: оптимистичная блокировка — сервер сравнит версию и вернёт 409 при конфликте.
          ...(treeVersion && !opts?.force ? { expectedVersion: treeVersion } : {}),
          ...(opts?.force ? { force: true } : {}),
        }),
      });
      if (res.status === 409) {
        const d = (await res.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
          currentVersion?: string;
          conflicts?: Array<{ id: number; name: string; field: string }>;
        };
        const conflicts = Array.isArray(d.conflicts) ? d.conflicts : [];
        const detail = conflicts
          .map((c) => `«${c.name}»: ${TREE_FIELD_LABELS[c.field] ?? c.field}`)
          .join("; ");
        const message =
          (d.error || "Дерево зависимостей изменено в другой вкладке") + (detail ? ` — ${detail}` : "");
        setTreeConflict({ message, conflicts });
        // Ошибка сохранения обязана попадать в ОБЩИЙ баннер панели, а не только внутрь блока дерева.
        setError(message);
        throw new Error(message);
      }
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        const message = d.error ?? "Не удалось сохранить дерево зависимостей";
        setError(message);
        throw new Error(message);
      }
      const data = (await res.json().catch(() => ({}))) as { treeVersion?: string };
      if (typeof data.treeVersion === "string") setTreeVersion(data.treeVersion);
      setTreeConflict(null);
      await load({ showSpinner: true });
    },
    [load, routingMode, treeVersion],
  );

  /** «Сохранить принудительно» — повторяем PUT с force: true поверх чужой правки. */
  const forceSaveTree = useCallback(async () => {
    const last = lastTreePayloadRef.current;
    if (!last) {
      setTreeConflict(null);
      await load({ showSpinner: true });
      return;
    }
    try {
      await saveTree(last.nodes, last.nextOrchPos, { force: true });
    } catch {
      /* текст ошибки уже показан в общем баннере панели */
    }
  }, [load, saveTree]);

  /** «Обновить данные» — отбрасываем локальные правки и перечитываем дерево с сервера. */
  const reloadTree = useCallback(() => {
    setTreeConflict(null);
    setError(null);
    void load({ showSpinner: true });
  }, [load]);

  /** P1-3: остановить запуск на сервере (running -> cancelled). */
  const cancelRun = useCallback(
    async (runId: number) => {
      setRunActionBusy(runId);
      setError(null);
      try {
        const res = await fetch(`/api/agent/subagents/runs/${runId}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Запуск остановлен пользователем из карточки запуска" }),
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error ?? "Не удалось остановить запуск");
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Ошибка остановки запуска");
      } finally {
        setRunActionBusy(null);
      }
    },
    [load],
  );

  /** P1-3: повторить запуск в том же изолированном чате и открыть его. */
  const retryRun = useCallback(
    async (run: SubagentRun) => {
      setRunActionBusy(run.id);
      setError(null);
      try {
        const res = await fetch(`/api/agent/subagents/runs/${run.id}/retry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const d = (await res.json().catch(() => ({}))) as {
          error?: string;
          conversation?: { id?: number };
        };
        if (!res.ok) throw new Error(d.error ?? "Не удалось повторить запуск");
        const convId = Number(d.conversation?.id ?? 0);
        setViewChatFor(run.subagentId);
        if (Number.isSafeInteger(convId) && convId > 0) {
          setPresetChat({ subagentId: run.subagentId, convId });
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Ошибка повторного запуска");
      } finally {
        setRunActionBusy(null);
      }
    },
    [load],
  );

  const changeRoutingMode = useCallback(
    async (nextMode: SubagentRoutingMode) => {
      setError(null);
      const res = await fetch("/api/agent/subagents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routingMode: nextMode }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? "Не удалось сохранить режим маршрутизации");
      }
      const data = (await res.json()) as { routingMode?: SubagentRoutingMode };
      const savedMode = data.routingMode === "layered" ? "layered" : "linear";
      setRoutingMode(savedMode);
      onStatsRef.current?.({
        totalCount: limits.totalCount,
        activeCount: limits.activeCount,
        runs: runs.length,
        routingMode: savedMode,
        overseerEnabled: overseer.enabled,
      });
    },
    [limits.activeCount, limits.totalCount, overseer.enabled, runs.length],
  );

  const saveOverseer = useCallback(
    async (payload: {
      enabled: boolean;
      mode: OverseerMode;
      systemPrompt: string;
      unlockApi: boolean;
      provider: string;
      baseUrl: string;
      model: string;
      apiKey?: string;
      clearApiKey?: boolean;
    }) => {
      setError(null);
      const res = await fetch("/api/agent/subagents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overseer: payload }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? "Не удалось сохранить настройки Надсмотрщика");
      }
      const data = (await res.json()) as { overseer?: OverseerConfig };
      if (data.overseer) {
        setOverseer(data.overseer);
        onStatsRef.current?.({
          totalCount: limits.totalCount,
          activeCount: limits.activeCount,
          runs: runs.length,
          routingMode,
          overseerEnabled: data.overseer.enabled,
        });
      }
    },
    [limits.activeCount, limits.totalCount, routingMode, runs.length],
  );

  const openNewForm = useCallback(() => {
    setSelectedId(null);
    setEditing({ ...EMPTY_FORM });
  }, []);

  const openEditForm = useCallback((s: Subagent) => {
    setSelectedId(s.id);
    setEditing({
      ...s,
      apiKey: "",
      clearApiKey: false,
      allowedCalleesText: (s.allowedCallees && s.allowedCallees.length > 0 ? s.allowedCallees : ["*"]).join(", "),
    });
  }, []);

  return (
    <div className="space-y-3">
      {/* Шапка вкладки «Субагенты и Оркестратор» в стиле TesterPanel & CRM */}
      <div className="rounded-2xl border border-border bg-card p-3.5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-text">
                <Network size={15} className="text-cyan-400" />
                Субагенты и Оркестратор
              </span>
              <Badge className="border-violet-500/35 bg-violet-500/10 text-violet-300">
                Модель Оркестратора: {orchestratorModelLabel}
              </Badge>
              <Badge
                className={
                  limits.activeCount >= limits.maxActive
                    ? "border-red-500/35 bg-red-500/15 text-red-400"
                    : "border-emerald-500/35 bg-emerald-500/10 text-emerald-500"
                }
              >
                Активно: {limits.activeCount}/{limits.maxActive}
              </Badge>
              <Badge className="border-border bg-card2 text-muted">
                В базе: {limits.totalCount}/{limits.maxStored}
              </Badge>
              {runs.length > 0 && (
                <Badge className="border-cyan-500/30 bg-cyan-500/10 text-cyan-400">
                  Запуски: {runs.length} · {formatTokensCount(totalRunsTokens)} ток.
                </Badge>
              )}
              <Badge
                className={
                  overseer.enabled
                    ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-400"
                    : "border-amber-500/35 bg-amber-500/10 text-amber-400"
                }
              >
                {overseer.enabled ? <ShieldCheck size={10} /> : <ShieldAlert size={10} />}
                Надсмотрщик: {overseer.enabled ? (overseer.mode === "strict" ? "строгий" : "правила") : "выкл"}
              </Badge>
            </div>
            <p className="text-[11px] text-muted">
              Главный Агент выступает <span className="font-medium text-text">Оркестратором</span>: делегирует задачи
              субагентам по дереву зависимостей в изолированные чаты. У каждого субагента по умолчанию используется API
              Оркестратора, либо свой собственный провайдер при разблокировке.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {onOpenModelTab && (
              <Button size="sm" variant="secondary" onClick={onOpenModelTab}>
                <Cpu size={13} /> Модель Оркестратора
              </Button>
            )}
            <Button
              size="sm"
              variant={showOverseer ? "primary" : "secondary"}
              onClick={() => {
                // Перемонтируем карточку только при явном открытии — несохранённые правки не теряются.
                if (!showOverseer) setOverseerSyncKey((k) => k + 1);
                setShowOverseer(!showOverseer);
              }}
              title="Настройки агента-Надсмотрщика (защита от побега из Sandbox и утечки данных)"
            >
              <ShieldCheck size={13} className={overseer.enabled ? "text-emerald-400" : "text-amber-400"} />
              Надсмотрщик
            </Button>
            <Button
              size="sm"
              variant={showTree ? "secondary" : "outline"}
              onClick={() => setShowTree((v) => !v)}
            >
              <GitBranch size={13} className="text-cyan-400" />
              {showTree ? "Скрыть дерево" : "Дерево зависимостей"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void load({ showSpinner: true })}
              disabled={loading}
              title="Обновить субагентов, запуски и чаты"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
              Обновить
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={openNewForm}
              disabled={limits.totalCount >= limits.maxStored}
            >
              <Plus size={14} /> Создать субагента
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <AlertTriangle size={14} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {treeConflict && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-300">
          <div className="flex items-start gap-2">
            <GitBranch size={14} className="mt-0.5 shrink-0" />
            <div className="min-w-0 space-y-1">
              <div className="font-semibold">Конфликт версий дерева зависимостей</div>
              <p className="leading-relaxed">{treeConflict.message}</p>
              {treeConflict.conflicts.length > 0 && (
                <ul className="list-inside list-disc text-[11px] text-amber-200/90">
                  {treeConflict.conflicts.map((c) => (
                    <li key={`${c.id}-${c.field}`}>
                      «{c.name}» — {TREE_FIELD_LABELS[c.field] ?? c.field}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={reloadTree}>
              <RefreshCw size={12} /> Обновить данные
            </Button>
            <Button size="sm" variant="primary" onClick={() => void forceSaveTree()}>
              <Check size={12} /> Сохранить принудительно
            </Button>
          </div>
        </div>
      )}

      {/* Настройки агента-Надсмотрщика */}
      {showOverseer && (
        <OverseerConfigCard
          key={overseerSyncKey}
          initial={overseer}
          orchestratorModelLabel={orchestratorModelLabel}
          onOpenModelTab={onOpenModelTab}
          onClose={() => setShowOverseer(false)}
          onSave={saveOverseer}
        />
      )}

      {/* Интерактивное нейронное дерево зависимостей */}
      {showTree && (
        <DependencyTreeCanvas
          subagents={subagents}
          dataVersion={treeVersion ?? ""}
          orchestratorModel={orchestratorModelLabel}
          maxActive={limits.maxActive}
          routingMode={routingMode}
          orchestratorPos={orchestratorPos}
          onChangeRoutingMode={changeRoutingMode}
          onSave={saveTree}
          onCreateNew={limits.totalCount < limits.maxStored ? openNewForm : undefined}
          onEditSubagent={openEditForm}
          onOpenChat={(id) => setViewChatFor(id)}
          onClose={() => setShowTree(false)}
        />
      )}

      {/* Форма создания / редактирования субагента */}
      {editing && (
        <SubagentFormEditor
          // P0-1: без key форма держала useState(initial) от прошлой записи и PATCH уходил с чужими данными.
          key={editing.id ?? "new"}
          initial={editing}
          subagents={subagents}
          limits={limits}
          orchestratorModelLabel={orchestratorModelLabel}
          onOpenModelTab={onOpenModelTab}
          onCancel={() => setEditing(null)}
          onSave={createOrUpdate}
        />
      )}

      {/* Сетка карточек субагентов */}
      {subagents.length === 0 && !loading ? (
        <EmptyState
          title="Субагентов пока нет"
          hint="Создайте специализированного помощника (например: QA-инженера, UI-дизайнера, Backend-аудитора), которого Оркестратор сможет вызывать в изолированном чате."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {subagents.map((s) => {
            const subRuns = runs.filter((r) => r.subagentId === s.id);
            const recentRuns = subRuns.slice(0, 3);
            const subChats = conversations.filter((c) => c.subagentId === s.id);
            const subTokens = subRuns.reduce((sum, r) => sum + Math.max(0, Number(r.totalTokens) || 0), 0);
            const parentObj = s.parentSubagentId ? byId.get(s.parentSubagentId) : null;
            const selected = selectedId === s.id;
            const calleesCountLabel = s.allowedCallees.includes("*")
              ? "* Все"
              : s.allowedCallees.length > 0
                ? `${s.allowedCallees.length} шт.`
                : "Нет";

            return (
              <div
                key={s.id}
                className={cn(
                  "card-hover relative overflow-hidden rounded-2xl border bg-card p-4 transition",
                  selected ? "border-accent/60 ring-1 ring-accent/35" : "border-border",
                )}
              >
                {/* Мягкое угловое свечение как в StatCard */}
                <div
                  className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full opacity-20 blur-2xl"
                  style={{ background: s.color }}
                />

                <div className="relative flex items-start gap-3">
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/15 text-white shadow-sm"
                    style={{
                      background: `linear-gradient(135deg, ${s.color}, ${s.color}bb)`,
                    }}
                  >
                    <Bot size={18} />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h4 className="truncate text-sm font-semibold text-text">{s.name}</h4>
                      <Badge
                        className={
                          s.isActive
                            ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-500"
                            : "border-border bg-card2 text-muted"
                        }
                      >
                        {s.isActive ? "Активен" : "Выключен"}
                      </Badge>
                      <Badge
                        className={
                          s.unlockApi
                            ? "border-amber-500/35 bg-amber-500/10 text-amber-500"
                            : "border-accent/30 bg-accent/10 text-accent2"
                        }
                      >
                        {s.unlockApi ? <Unlock size={10} /> : <Lock size={10} />}
                        {s.unlockApi ? (s.model.trim() || "Свой API") : "API Орк."}
                      </Badge>
                      <Badge
                        className={
                          s.toolProfile === "full"
                            ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-400"
                            : "border-border bg-card2 text-muted"
                        }
                      >
                        <Wrench size={10} />
                        {s.toolProfile === "full" ? "Полные инструменты" : "Урезанные"}
                      </Badge>
                    </div>

                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                      <code className="rounded bg-card2 px-1.5 py-0.5 font-mono text-[10px] text-text">
                        {s.slug}
                      </code>
                      {s.roleTitle && <span>· {s.roleTitle}</span>}
                      <span>
                        ·{" "}
                        {parentObj
                          ? `Подчинён: ${parentObj.name}`
                          : s.orchestratorCanCall
                            ? "Оркестратор напрямую"
                            : "Только ручной вызов"}
                      </span>
                    </div>

                    {s.description && (
                      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted">
                        {s.description}
                      </p>
                    )}
                  </div>
                </div>

                {/* Компактная полоса метрик */}
                <div className="mt-3 grid grid-cols-4 gap-1.5 rounded-xl border border-border bg-card2/70 p-2 text-center">
                  <div>
                    <div className="text-[10px] text-muted">Запуски</div>
                    <div className="text-xs font-semibold text-text">{s.runsCount}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted">Чаты</div>
                    <div className="text-xs font-semibold text-text">{subChats.length || s.conversationsCount}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted">Токены</div>
                    <div className="text-xs font-semibold text-text">{formatTokensCount(subTokens)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted">Может вызывать</div>
                    <div className="text-xs font-semibold text-text">{calleesCountLabel}</div>
                  </div>
                </div>

                {/* Последние запуски */}
                {recentRuns.length > 0 && (
                  <div className="mt-2.5 space-y-1 rounded-xl border border-border/70 bg-card2/40 p-2">
                    <div className="text-[10px] font-medium text-muted">Последние запуски</div>
                    {recentRuns.map((r) => {
                      const statusMeta = RUN_STATUS_META[r.status] ?? RUN_STATUS_META.completed;
                      const isRunning = r.status === "running";
                      const stale = isRunning && Date.now() - Date.parse(r.updatedAt) > SUBAGENT_RUN_STALE_MS;
                      return (
                        <div key={r.id} className="space-y-1">
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                              <Badge className={cn("px-1.5 py-0 text-[9px]", statusMeta.badgeClass)}>
                                {statusMeta.label}
                              </Badge>
                              {stale && (
                                <Badge className="border-amber-500/40 bg-amber-500/15 px-1.5 py-0 text-[9px] text-amber-400">
                                  Устарел / нет heartbeat
                                </Badge>
                              )}
                              <span className="truncate text-muted">
                                #{r.id} · {r.callerKind} · {r.sandboxProject || "."}
                              </span>
                              {isRunning && (
                                <span className="shrink-0 text-[10px] text-muted">
                                  {formatElapsedSince(r.updatedAt)}
                                </span>
                              )}
                            </div>
                            <span className="shrink-0 font-mono text-[10px] text-text">
                              {formatTokensCount(r.totalTokens)} ток.
                            </span>
                          </div>
                          {isRunning && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => void cancelRun(r.id)}
                                disabled={runActionBusy === r.id}
                              >
                                <Square size={11} /> Остановить
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => void retryRun(r)}
                                disabled={runActionBusy === r.id}
                              >
                                <RefreshCw size={11} /> Повторить
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Кнопки действий карточки */}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant={viewChatFor === s.id ? "primary" : "secondary"}
                      onClick={() => setViewChatFor(s.id)}
                    >
                      <MessageSquare size={12} /> Чаты ({subChats.length})
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => openEditForm(s)}>
                      <Pencil size={12} /> Редактировать
                    </Button>
                  </div>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => void remove(s.id)}
                    aria-label={`Удалить субагента ${s.name}`}
                  >
                    <Trash2 size={12} /> Удалить
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Изолированный чат выбранного субагента */}
      {viewChatFor !== null && (
        <SubagentChatViewer
          key={`chat-${viewChatFor}-${
            presetChat && presetChat.subagentId === viewChatFor ? presetChat.convId : 0
          }`}
          subagentId={viewChatFor}
          presetConvId={
            presetChat && presetChat.subagentId === viewChatFor ? presetChat.convId : null
          }
          subagents={subagents}
          conversations={conversations}
          settings={settings}
          params={params}
          trustLevel={trustLevel}
          modelContextLength={modelContextLength}
          github={github}
          onClose={() => setViewChatFor(null)}
          onChanged={() => void load()}
          onOpenModelTab={onOpenModelTab}
        />
      )}
    </div>
  );
}

function collectFormDescendantIds(rootId: number | undefined, all: Subagent[]): Set<number> {
  const blocked = new Set<number>();
  if (!rootId) return blocked;
  blocked.add(rootId);
  let added = true;
  while (added) {
    added = false;
    for (const s of all) {
      if (!blocked.has(s.id) && s.parentSubagentId !== null && blocked.has(s.parentSubagentId)) {
        blocked.add(s.id);
        added = true;
      }
    }
  }
  return blocked;
}

function SubagentFormEditor({
  initial,
  subagents,
  limits,
  orchestratorModelLabel,
  onOpenModelTab,
  onCancel,
  onSave,
}: {
  initial: SubagentFormState;
  subagents: Subagent[];
  limits: SubagentLimits;
  orchestratorModelLabel: string;
  onOpenModelTab?: () => void;
  onCancel: () => void;
  onSave: (form: SubagentFormState) => Promise<void>;
}) {
  const [form, setForm] = useState<SubagentFormState>(() => ({
    ...EMPTY_FORM,
    ...initial,
    apiKey: "",
    clearApiKey: false,
    provider: initial.provider || resolveProviderId("", initial.baseUrl || ""),
    allowedCalleesText:
      initial.allowedCalleesText ??
      (initial.allowedCallees && initial.allowedCallees.length > 0 ? initial.allowedCallees : ["*"]).join(", "),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    name?: string;
    systemPrompt?: string;
    allowedCalleesText?: string;
    parentSubagentId?: string;
  }>({});

  const others = useMemo(() => subagents.filter((s) => s.id !== initial.id), [subagents, initial.id]);
  const blockedParents = useMemo(() => collectFormDescendantIds(initial.id, subagents), [initial.id, subagents]);
  const activeProviderId = resolveProviderId(form.provider ?? "", form.baseUrl ?? "");
  const calleesList = parseCalleesList(form.allowedCalleesText);
  const allowAllCallees = calleesList.includes("*");

  const set = <K extends keyof SubagentFormState>(key: K, value: SubagentFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const applyProviderPreset = (providerId: string) => {
    const preset = SUBAGENT_PROVIDERS.find((p) => p.id === providerId);
    if (!preset) return;
    setForm((f) => ({
      ...f,
      provider: preset.id,
      baseUrl: preset.id === "custom" ? f.baseUrl : preset.baseUrl,
      model: preset.model ? preset.model : f.model,
    }));
  };

  const toggleCalleeChip = (slug: string) => {
    if (slug === "*") {
      const next = allowAllCallees ? calleesList.filter((x) => x !== "*") : ["*"];
      set("allowedCalleesText", next.join(", "));
      return;
    }
    const base = calleesList.filter((x) => x !== "*");
    const next = base.includes(slug) ? base.filter((x) => x !== slug) : [...base, slug];
    set("allowedCalleesText", next.join(", "));
  };

  const validate = (): string | null => {
    const next: {
      name?: string;
      systemPrompt?: string;
      allowedCalleesText?: string;
      parentSubagentId?: string;
    } = {};
    if (!form.name?.trim()) next.name = "Укажите название субагента";
    if (!(form.systemPrompt ?? "").trim()) {
      next.systemPrompt = "Системный промпт обязателен: опишите правила работы субагента";
    }
    const knownSlugs = new Set(others.map((s) => s.slug));
    const unknownCallees = calleesList.filter((slug) => slug !== "*" && !knownSlugs.has(slug));
    if (unknownCallees.length > 0) {
      next.allowedCalleesText = `Неизвестные slug: ${unknownCallees.join(", ")}. Доступны: ${
        Array.from(knownSlugs).join(", ") || "—"
      }`;
    }
    const parentId = form.parentSubagentId ?? null;
    if (parentId !== null && blockedParents.has(parentId)) {
      next.parentSubagentId = "Нельзя выбрать потомка — это создаст цикл в дереве";
    }
    setFieldErrors(next);
    return Object.values(next).find(Boolean) ?? null;
  };

  const submit = async () => {
    setError(null);
    const invalid = validate();
    if (invalid) return;
    setBusy(true);
    try {
      if (form.isActive && others.filter((s) => s.isActive).length >= limits.maxActive && !initial.isActive) {
        throw new Error(`Одновременно может быть активно не более ${limits.maxActive} субагентов`);
      }
      await onSave(form);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка сохранения");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      className="border-accent/40 glow-accent"
      title={
        <span className="flex items-center gap-2">
          <Sparkles size={15} className="text-accent2" />
          {initial.id ? `Редактирование субагента: ${initial.name}` : "Новый субагент"}
        </span>
      }
      subtitle="Задайте специализацию, обязательный системный промпт, роль в дереве зависимостей и параметры модели."
      action={
        <Button size="sm" variant="ghost" onClick={onCancel} aria-label="Закрыть редактор">
          <X size={14} /> Закрыть
        </Button>
      }
    >
      {error && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <AlertTriangle size={14} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {/* Секция 1: Профиль и специализация */}
        <div className="space-y-3 rounded-2xl border border-border bg-card2/40 p-3.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-text">
            <Bot size={14} className="text-accent2" />
            Профиль и специализация
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Название субагента *">
              <Input
                value={form.name ?? ""}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Например: QA-инженер"
                aria-invalid={Boolean(fieldErrors.name)}
              />
              {fieldErrors.name && <p className="mt-1 text-[11px] text-red-400">{fieldErrors.name}</p>}
            </Field>
            <Field label="Slug (латиница, опционально)">
              <Input
                value={form.slug ?? ""}
                onChange={(e) => set("slug", e.target.value)}
                placeholder={slugifyFallback(form.name || "subagent")}
                className="font-mono"
              />
            </Field>
            <Field label="Роль / должность">
              <Input
                value={form.roleTitle ?? ""}
                onChange={(e) => set("roleTitle", e.target.value)}
                placeholder="Например: Аудит безопасности, UI-дизайнер"
              />
            </Field>
            <div>
              <Label>Акцентный цвет</Label>
              <div className="flex min-h-10 flex-wrap items-center gap-2 rounded-xl border border-border bg-card2 px-3 py-1.5">
                {SUBAGENT_COLORS.map((c) => {
                  const active = form.color === c;
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => set("color", c)}
                      aria-label={`Выбрать цвет ${c}`}
                      className={cn(
                        "flex h-6 w-6 items-center justify-center rounded-full transition-transform",
                        active
                          ? "scale-110 ring-2 ring-text ring-offset-2 ring-offset-card2"
                          : "opacity-80 hover:scale-105 hover:opacity-100",
                      )}
                      style={{ background: c }}
                    >
                      {active && <Check size={12} className="text-white drop-shadow" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <Field label="Описание зоны ответственности">
            <Textarea
              value={form.description ?? ""}
              onChange={(e) => set("description", e.target.value)}
              rows={2}
              className="min-h-[64px]"
              placeholder="Кратко опишите, какие задачи Оркестратор должен передавать этому субагенту…"
            />
          </Field>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <Label className="mb-0">Системный промпт субагента (обязателен к исполнению)</Label>
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <span>{(form.systemPrompt ?? "").length}/16000</span>
                {(form.systemPrompt ?? "").length > 0 && (
                  <button
                    type="button"
                    onClick={() => set("systemPrompt", "")}
                    className="text-red-400 hover:underline"
                  >
                    Очистить
                  </button>
                )}
              </div>
            </div>
            <Textarea
              value={form.systemPrompt ?? ""}
              onChange={(e) => set("systemPrompt", e.target.value.slice(0, 16_000))}
              rows={4}
              className="min-h-[112px] font-mono text-xs"
              placeholder="Ты — узкоспециализированный субагент. Твоя задача: …"
              aria-invalid={Boolean(fieldErrors.systemPrompt)}
            />
            {fieldErrors.systemPrompt && (
              <p className="text-[11px] text-red-400">{fieldErrors.systemPrompt}</p>
            )}
          </div>
        </div>

        {/* Секция 2: Оркестрация и дерево зависимостей */}
        <div className="space-y-3 rounded-2xl border border-border bg-card2/40 p-3.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-text">
            <GitBranch size={14} className="text-cyan-400" />
            Маршрутизация и дерево зависимостей
          </div>

          <div className="grid gap-2.5 sm:grid-cols-2">
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-card p-3 transition hover:border-accent/40">
              <input
                type="checkbox"
                checked={!!form.isActive}
                onChange={(e) => set("isActive", e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[#7c5cff]"
              />
              <div>
                <div className="text-xs font-semibold text-text">Активен в дереве вызовов</div>
                <div className="mt-0.5 text-[11px] text-muted">
                  Доступен Оркестратору и другим субагентам при запуске (лимит {limits.maxActive} активных).
                </div>
              </div>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-card p-3 transition hover:border-accent/40">
              <input
                type="checkbox"
                checked={!!form.orchestratorCanCall}
                onChange={(e) => set("orchestratorCanCall", e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[#7c5cff]"
              />
              <div>
                <div className="text-xs font-semibold text-text">Оркестратор вызывает напрямую</div>
                <div className="mt-0.5 text-[11px] text-muted">
                  Если снять, субагент вызывается только по иерархии от родителя или вручную в чате.
                </div>
              </div>
            </label>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Профиль инструментов">
              <Select
                aria-label="Профиль инструментов субагента"
                value={form.toolProfile === "full" ? "full" : "restricted"}
                onChange={(e) =>
                  set("toolProfile", e.target.value === "full" ? "full" : "restricted")
                }
              >
                <option value="restricted">
                  Урезанные (без браузерного инспектора — быстро, без лишних трат)
                </option>
                <option value="full">
                  Полные (с браузерным инспектором и QA-инструментами)
                </option>
              </Select>
              <p className="mt-1 text-[11px] text-muted">
                {form.toolProfile === "full"
                  ? "Субагенту доступны browse_project, qa_browser_audit и запуск headless-браузера."
                  : "Без инструментов браузера (browse_project / qa_browser_audit), меньше контекста и нагрузки."}
              </p>
            </Field>

            <Field label="Родительский субагент">
              <Select
                value={form.parentSubagentId ?? ""}
                onChange={(e) =>
                  set("parentSubagentId", e.target.value ? Number(e.target.value) : null)
                }
                aria-invalid={Boolean(fieldErrors.parentSubagentId)}
              >
                <option value="">— нет (прямой узел под Оркестратором) —</option>
                {others.map((s) => {
                  const createsCycle = blockedParents.has(s.id);
                  return (
                    <option key={s.id} value={s.id} disabled={createsCycle}>
                      {s.name}{createsCycle ? " (нельзя: цикл)" : ""}
                    </option>
                  );
                })}
              </Select>
              {fieldErrors.parentSubagentId && (
                <p className="mt-1 text-[11px] text-red-400">{fieldErrors.parentSubagentId}</p>
              )}
            </Field>

            <Field label="Разрешённые вызываемые субагенты (handoff)">
              <div className="space-y-1.5">
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => toggleCalleeChip("*")}
                    className={cn(
                      "rounded-lg border px-2 py-1 text-[11px] font-medium transition",
                      allowAllCallees
                        ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-400"
                        : "border-border bg-card text-muted hover:text-text",
                    )}
                  >
                    * Любые активные
                  </button>
                  {others.map((o) => {
                    const picked = !allowAllCallees && calleesList.includes(o.slug);
                    return (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => toggleCalleeChip(o.slug)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition",
                          picked
                            ? "border-accent/60 bg-accent/15 text-text"
                            : "border-border bg-card text-muted hover:text-text",
                        )}
                      >
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: o.color }} />
                        {o.slug}
                      </button>
                    );
                  })}
                </div>
                <Input
                  value={form.allowedCalleesText ?? ""}
                  onChange={(e) => set("allowedCalleesText", e.target.value)}
                  placeholder="* — любые, либо slug через запятую"
                  className="font-mono text-xs"
                  aria-invalid={Boolean(fieldErrors.allowedCalleesText)}
                />
                {fieldErrors.allowedCalleesText && (
                  <p className="text-[11px] text-red-400">{fieldErrors.allowedCalleesText}</p>
                )}
              </div>
            </Field>
          </div>
        </div>

        {/* Секция 3: Подключение API и модель */}
        <div
          className={cn(
            "space-y-3 rounded-2xl border p-3.5 transition",
            form.unlockApi
              ? "border-amber-500/40 bg-amber-500/5"
              : "border-border bg-card2/50",
          )}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <label className="flex cursor-pointer items-start gap-2.5 text-xs">
              <input
                type="checkbox"
                checked={!!form.unlockApi}
                onChange={(e) => set("unlockApi", e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[#7c5cff]"
              />
              <div>
                <span className="inline-flex items-center gap-1.5 font-semibold text-text">
                  {form.unlockApi ? (
                    <Unlock size={13} className="text-amber-400" />
                  ) : (
                    <Lock size={13} className="text-accent2" />
                  )}
                  Разблокировать API (своё локальное / LAN / облачное подключение)
                </span>
                <p className="mt-0.5 text-[11px] text-muted">
                  {form.unlockApi
                    ? "Субагент использует указанные ниже Base URL, модель и API-ключ независимо от Оркестратора."
                    : `API заблокирован: субагент строго использует общую модель Оркестратора (${orchestratorModelLabel}).`}
                </p>
              </div>
            </label>
            {!form.unlockApi && onOpenModelTab && (
              <Button size="sm" variant="secondary" onClick={onOpenModelTab}>
                <ShieldCheck size={12} /> Модель Оркестратора
              </Button>
            )}
          </div>

          {form.unlockApi && (
            <div className="grid gap-3 border-t border-border/80 pt-3 md:grid-cols-2">
              <Field label="Провайдер">
                <Select
                  value={activeProviderId}
                  onChange={(e) => applyProviderPreset(e.target.value)}
                >
                  {SUBAGENT_PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Режим раздумий">
                <Select
                  value={form.reasoningMode ?? "default"}
                  onChange={(e) => set("reasoningMode", e.target.value)}
                >
                  {AI_REASONING_MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label} — {m.hint}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Base URL">
                <Input
                  value={form.baseUrl ?? ""}
                  onChange={(e) => set("baseUrl", e.target.value)}
                  placeholder="http://127.0.0.1:8888/v1"
                />
              </Field>
              <Field label="Модель">
                <Input
                  value={form.model ?? ""}
                  onChange={(e) => set("model", e.target.value)}
                  placeholder="например, qwen3:8b или gpt-4o-mini"
                />
              </Field>
              <div className="md:col-span-2">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <Label className="mb-0 inline-flex items-center gap-1.5">
                    <KeyRound size={12} className="text-muted" />
                    {initial.id
                      ? "API-ключ (оставьте пустым, чтобы сохранить текущий)"
                      : "API-ключ (необязательно для локального сервера)"}
                  </Label>
                  {initial.hasApiKey && !form.clearApiKey && (
                    <button
                      type="button"
                      onClick={() => set("clearApiKey", true)}
                      className="text-[11px] text-red-400 hover:underline"
                    >
                      Удалить сохранённый ({initial.apiKeyHint || "sk-•••"})
                    </button>
                  )}
                  {form.clearApiKey && (
                    <button
                      type="button"
                      onClick={() => set("clearApiKey", false)}
                      className="text-[11px] text-amber-400 hover:underline"
                    >
                      Отменить удаление ключа
                    </button>
                  )}
                </div>
                <Input
                  type="password"
                  value={form.apiKey ?? ""}
                  onChange={(e) => {
                    set("apiKey", e.target.value);
                    if (e.target.value && form.clearApiKey) set("clearApiKey", false);
                  }}
                  placeholder={
                    initial.hasApiKey && !form.clearApiKey
                      ? `Сохранён на сервере (${initial.apiKeyHint || "sk-•••"})`
                      : "sk-..."
                  }
                />
              </div>
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-border pt-3">
          <Button size="md" variant="secondary" onClick={onCancel} disabled={busy}>
            Отмена
          </Button>
          <Button size="md" type="submit" variant="primary" disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {busy ? "Сохраняю…" : initial.id ? "Сохранить изменения" : "Создать"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function OverseerConfigCard({
  initial,
  orchestratorModelLabel,
  onOpenModelTab,
  onClose,
  onSave,
}: {
  initial: OverseerConfig;
  orchestratorModelLabel: string;
  onOpenModelTab?: () => void;
  onClose: () => void;
  onSave: (payload: {
    enabled: boolean;
    mode: OverseerMode;
    systemPrompt: string;
    unlockApi: boolean;
    provider: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
    clearApiKey?: boolean;
  }) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [mode, setMode] = useState<OverseerMode>(initial.mode);
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt);
  const [unlockApi, setUnlockApi] = useState(initial.unlockApi);
  const [provider, setProvider] = useState(initial.provider || "local");
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl || "");
  const [model, setModel] = useState(initial.model || "");
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const activeProviderId = resolveProviderId(provider, baseUrl);
  const applyProviderPreset = (id: string) => {
    const p = SUBAGENT_PROVIDERS.find((x) => x.id === id);
    if (!p) return;
    setProvider(p.id);
    if (p.id !== "custom") setBaseUrl(p.baseUrl);
    if (p.model) setModel(p.model);
  };

  const handleSave = async () => {
    setBusy(true);
    setErr(null);
    setSavedMsg(null);
    try {
      await onSave({
        enabled,
        mode,
        systemPrompt,
        unlockApi,
        provider: activeProviderId,
        baseUrl,
        model,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(clearApiKey ? { clearApiKey: true } : {}),
      });
      setApiKey("");
      setClearApiKey(false);
      setSavedMsg("Настройки Надсмотрщика сохранены");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось сохранить Надсмотрщика");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      className="border-emerald-500/30"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <ShieldCheck size={15} className="text-emerald-400" />
          Агент-Надсмотрщик (Guard безопасности)
          <Badge
            className={
              enabled
                ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-400"
                : "border-amber-500/35 bg-amber-500/10 text-amber-400"
            }
          >
            {enabled ? "Активен" : "Отключён"}
          </Badge>
        </span>
      }
      subtitle="Контролирует все потенциально опасные действия Оркестратора и субагентов (побег из Sandbox, утечка секретов, команды ПК, экспорт, сеть) — работает даже при полном доверии."
      action={
        <Button size="sm" variant="ghost" onClick={onClose}>
          <X size={14} /> Свернуть
        </Button>
      }
    >
      {err && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <AlertTriangle size={14} className="shrink-0" />
          <span>{err}</span>
        </div>
      )}
      {savedMsg && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
          <Check size={14} className="shrink-0" />
          <span>{savedMsg}</span>
        </div>
      )}

      <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-card2/60 p-3 transition hover:border-emerald-500/40">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[#10b981]"
            />
            <div>
              <div className="text-xs font-semibold text-text">Включить Надсмотрщика</div>
              <div className="mt-0.5 text-[11px] text-muted">
                При угрозе или сомнительной операции запрашивает явное решение человека в окне подтверждения на сайте.
              </div>
            </div>
          </label>

          <Field label="Режим проверки">
            <Select
              aria-label="Режим проверки Надсмотрщика"
              value={mode}
              onChange={(e) => setMode(e.target.value === "rules_only" ? "rules_only" : "strict")}
            >
              <option value="strict">Строгий — правила + ИИ-аудит подозрительных операций</option>
              <option value="rules_only">Только статические правила (без доп. запросов к LLM)</option>
            </Select>
          </Field>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-xs">
            <Label className="mb-0">Дополнительные правила / системный промпт Надсмотрщика</Label>
            {systemPrompt && (
              <button
                type="button"
                onClick={() => setSystemPrompt("")}
                className="text-[11px] text-red-400 hover:underline"
              >
                Очистить
              </button>
            )}
          </div>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value.slice(0, 12_000))}
            rows={3}
            className="font-mono text-xs"
            placeholder="Оставьте пустым для встроенной политики безопасности, либо добавьте особые запреты (например: запретить удаление файлов старше …, проверять все curl/fetch к внешним доменам)."
          />
        </div>

        <div
          className={cn(
            "space-y-3 rounded-2xl border p-3.5 transition",
            unlockApi ? "border-amber-500/40 bg-amber-500/5" : "border-border bg-card2/50",
          )}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <label className="flex cursor-pointer items-start gap-2.5 text-xs">
              <input
                type="checkbox"
                checked={unlockApi}
                onChange={(e) => setUnlockApi(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[#7c5cff]"
              />
              <div>
                <span className="inline-flex items-center gap-1.5 font-semibold text-text">
                  {unlockApi ? (
                    <Unlock size={13} className="text-amber-400" />
                  ) : (
                    <Lock size={13} className="text-accent2" />
                  )}
                  Разблокировать API Надсмотрщика (отдельная модель проверки)
                </span>
                <p className="mt-0.5 text-[11px] text-muted">
                  {unlockApi
                    ? "Надсмотрщик использует указанный ниже API независимо от модели Оркестратора."
                    : `API заблокирован — Надсмотрщик использует общую модель Оркестратора (${orchestratorModelLabel}).`}
                </p>
              </div>
            </label>
            {!unlockApi && onOpenModelTab && (
              <Button size="sm" variant="secondary" onClick={onOpenModelTab}>
                <ShieldCheck size={12} /> Модель Оркестратора
              </Button>
            )}
          </div>

          {unlockApi && (
            <div className="grid gap-3 border-t border-border/80 pt-3 md:grid-cols-2">
              <Field label="Провайдер">
                <Select
                  value={activeProviderId}
                  onChange={(e) => applyProviderPreset(e.target.value)}
                >
                  {SUBAGENT_PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Модель Надсмотрщика">
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="например, qwen3:8b или gpt-4o-mini"
                />
              </Field>
              <Field label="Base URL">
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8888/v1"
                />
              </Field>
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <Label className="mb-0 inline-flex items-center gap-1.5">
                    <KeyRound size={12} className="text-muted" />
                    API-ключ (опционально для локальных)
                  </Label>
                  {initial.hasApiKey && !clearApiKey && (
                    <button
                      type="button"
                      onClick={() => setClearApiKey(true)}
                      className="text-[11px] text-red-400 hover:underline"
                    >
                      Удалить ({initial.apiKeyHint || "sk-•••"})
                    </button>
                  )}
                  {clearApiKey && (
                    <button
                      type="button"
                      onClick={() => setClearApiKey(false)}
                      className="text-[11px] text-amber-400 hover:underline"
                    >
                      Отменить удаление
                    </button>
                  )}
                </div>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    if (e.target.value && clearApiKey) setClearApiKey(false);
                  }}
                  placeholder={
                    initial.hasApiKey && !clearApiKey
                      ? `Сохранён на сервере (${initial.apiKeyHint || "sk-•••"})`
                      : "sk-..."
                  }
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex justify-end border-t border-border pt-3">
        <Button size="md" variant="primary" onClick={() => void handleSave()} disabled={busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          {busy ? "Сохраняю…" : "Сохранить Надсмотрщика"}
        </Button>
      </div>
    </Card>
  );
}

function SubagentChatViewer({
  subagentId,
  presetConvId,
  subagents,
  conversations,
  settings,
  params,
  trustLevel,
  modelContextLength,
  github,
  onClose,
  onChanged,
  onOpenModelTab,
}: {
  subagentId: number;
  /** Чат, который нужно открыть после «Повторить» (conversation.id из ответа retry). */
  presetConvId?: number | null;
  subagents: Subagent[];
  conversations: SubagentConversation[];
  settings: { baseUrl: string; model: string; apiKey?: string };
  params: Record<string, unknown>;
  trustLevel: string;
  modelContextLength?: number | null;
  github?: { owner: string; repo: string; branch: string } | null;
  onClose: () => void;
  onChanged: () => void;
  onOpenModelTab?: () => void;
}) {
  const sub = subagents.find((s) => s.id === subagentId);
  const myChats = useMemo(
    () => conversations.filter((c) => c.subagentId === subagentId),
    [conversations, subagentId],
  );
  const [selectedConvId, setSelectedConvId] = useState<number | null>(
    () => (typeof presetConvId === "number" && presetConvId > 0 ? presetConvId : (myChats[0]?.id ?? null)),
  );
  const activeConvId =
    selectedConvId && myChats.some((c) => c.id === selectedConvId)
      ? selectedConvId
      : (selectedConvId ?? myChats[0]?.id ?? null);

  const [messages, setMessages] = useState<SubagentMessage[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<OperatorAttachment[]>([]);
  const [sessionAttachments, setSessionAttachments] = useState<OperatorAttachment[]>([]);
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<{
    reasoning: string;
    text: string;
    status: string;
    actorLabel: string;
    overseerReasoning: string;
  }>({
    reasoning: "",
    text: "",
    status: "",
    actorLabel: "",
    overseerReasoning: "",
  });
  const [subApproval, setSubApproval] = useState<{
    approvalId: string;
    kind: string;
    title: string;
    description: string;
    command?: string;
    cwd?: string;
    overseer?: OverseerVerdictMeta;
  } | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<{ prompt: number; completion: number; total: number } | null>(null);
  /** Статус последнего запуска — чтобы упавший запуск не выглядел успешным. */
  const [lastRunStatus, setLastRunStatus] = useState<string | null>(null);
  /** ID запуска (из события subagent_run) — нужен для cancel на сервере. */
  const lastRunIdRef = useRef<number | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const convAbortRef = useRef<AbortController | null>(null);
  const streamRunningRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadConversation = useCallback(
    async (convId: number) => {
      convAbortRef.current?.abort();
      const ctrl = new AbortController();
      convAbortRef.current = ctrl;
      setLoadingConv(true);
      setChatError(null);
      try {
        const res = await fetch(
          `/api/agent/subagents?subagentId=${subagentId}&conversationId=${convId}&onlyConversation=1`,
          { cache: "no-store", signal: ctrl.signal },
        );
        if (!res.ok) throw new Error("Не удалось загрузить историю чата");
        const data = (await res.json()) as {
          selectedConversation: {
            conversation: SubagentConversation;
            messages: SubagentMessage[];
            tokens: { prompt: number; completion: number; total: number };
          } | null;
        };
        if (ctrl.signal.aborted) return;
        setMessages(data.selectedConversation?.messages ?? []);
        setTokenUsage(data.selectedConversation?.tokens ?? null);
        setLive({ reasoning: "", text: "", status: "", actorLabel: "", overseerReasoning: "" });
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setChatError(e instanceof Error ? e.message : "Ошибка загрузки чата");
        setMessages([]);
      } finally {
        if (!ctrl.signal.aborted) setLoadingConv(false);
      }
    },
    [subagentId],
  );

  useEffect(() => {
    if (!activeConvId || streamRunningRef.current) return;
    let alive = true;
    const ctrl = new AbortController();
    fetch(
      `/api/agent/subagents?subagentId=${subagentId}&conversationId=${activeConvId}&onlyConversation=1`,
      { cache: "no-store", signal: ctrl.signal },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error("Не удалось загрузить историю чата");
        return (await res.json()) as {
          selectedConversation: {
            conversation: SubagentConversation;
            messages: SubagentMessage[];
            tokens: { prompt: number; completion: number; total: number };
          } | null;
        };
      })
      .then((data) => {
        if (!alive) return;
        setMessages(data.selectedConversation?.messages ?? []);
        setTokenUsage(data.selectedConversation?.tokens ?? null);
        setChatError(null);
      })
      .catch((e) => {
        if (!alive || ctrl.signal.aborted) return;
        setChatError(e instanceof Error ? e.message : "Ошибка загрузки чата");
      });

    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [activeConvId, subagentId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, live]);

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
      convAbortRef.current?.abort();
    };
  }, []);

  const newChat = async () => {
    setChatError(null);
    try {
      const res = await fetch("/api/agent/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "subagent",
          subagentId,
          title: sub ? `Чат: ${sub.name}` : "Чат субагента",
        }),
      });
      if (!res.ok) throw new Error("Не удалось создать чат");
      const data = (await res.json()) as { conversation: SubagentConversation };
      setSelectedConvId(data.conversation.id);
      setMessages([]);
      setTokenUsage(null);
      onChanged();
    } catch (e) {
      setChatError(e instanceof Error ? e.message : "Ошибка создания чата");
    }
  };

  const deleteChat = async (convId: number) => {
    if (!confirm("Удалить этот чат субагента?")) return;
    setChatError(null);
    try {
      const res = await fetch(`/api/agent/conversations/${convId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Не удалось удалить чат");
      const remaining = myChats.filter((c) => c.id !== convId);
      setSelectedConvId(remaining[0]?.id ?? null);
      setMessages([]);
      setTokenUsage(null);
      onChanged();
    } catch (e) {
      setChatError(e instanceof Error ? e.message : "Ошибка удаления чата");
    }
  };

  const stop = () => {
    streamAbortRef.current?.abort();
    // Останавливаем запуск и на сервере: иначе он навсегда останется `running` в БД.
    const runId = lastRunIdRef.current;
    if (runId) {
      void fetch(`/api/agent/subagents/runs/${runId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Запуск остановлен пользователем из чата субагента" }),
      })
        .then(() => onChanged())
        .catch(() => undefined);
    }
  };

  const resolveSubApproval = async (approved: boolean) => {
    if (!subApproval || approvalBusy) return;
    setApprovalBusy(true);
    try {
      await fetch("/api/ai/agent/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId: subApproval.approvalId, approved }),
      });
      setSubApproval(null);
      setLive((l) => ({
        ...l,
        actorLabel: sub?.name ?? "Субагент",
        status: approved ? "Разрешение получено — продолжаю…" : "Действие отклонено человеком",
      }));
    } catch {
      setChatError("Не удалось отправить подтверждение");
    } finally {
      setApprovalBusy(false);
    }
  };

  const attachFiles = async (fileList: FileList | File[]) => {
    const { files: next, errors } = await readOperatorFiles(attachments, fileList);
    if (errors.length > 0) setChatError(errors.join(". "));
    if (next.length > 0) {
      setAttachments((prev) => [...prev, ...next].slice(0, 8));
    }
  };

  const runSubagentTurn = async (
    promptText: string,
    opts?: {
      convIdOverride?: number | null;
      attachmentsOverride?: OperatorAttachment[];
      sessionAttachmentsOverride?: OperatorAttachment[];
      historyOverride?: Array<{ role: string; content: string }>;
      handoffDepth?: number;
    },
  ): Promise<void> => {
    const prompt = promptText.trim();
    if (!prompt || !sub) return;
    const handoffDepth = opts?.handoffDepth ?? 0;
    const currentAttachments = opts?.attachmentsOverride ?? attachments;
    const targetConvId =
      opts?.convIdOverride !== undefined ? opts.convIdOverride : activeConvId;

    // Собираем вложения для модели: свежие + файлы дизайна/контекста из текущей сессии
    const mergedSession = [...(opts?.sessionAttachmentsOverride ?? sessionAttachments)];
    for (const att of currentAttachments) {
      if (!mergedSession.some((x) => x.name === att.name && x.size === att.size)) {
        mergedSession.push(att);
      }
    }
    const nextSessionAttachments = mergedSession.slice(-10);
    if (currentAttachments.length > 0 || opts?.sessionAttachmentsOverride) {
      setSessionAttachments(nextSessionAttachments);
    }

    const freshKeys = new Set(currentAttachments.map((a) => `${a.name}:${a.size}`));
    const historySessionPayload = mergedSession
      .filter((a) => !freshKeys.has(`${a.name}:${a.size}`))
      .map((a) => ({
        name: a.name,
        mime: a.mime,
        size: a.size,
        text: a.text,
        note: a.note,
        data: a.data,
        ...(a.image ? { image: a.image } : {}),
        fromHistory: true,
      }));
    const freshPayload = currentAttachments.map((a) => ({
      name: a.name,
      mime: a.mime,
      size: a.size,
      text: a.text,
      note: a.note,
      data: a.data,
      ...(a.image ? { image: a.image } : {}),
      fromHistory: false,
    }));
    const attachmentsPayload = [...freshPayload, ...historySessionPayload].slice(0, 12);

    const historyBase =
      opts?.historyOverride ?? messages.map((m) => ({ role: m.role, content: m.content }));
    const history = [...historyBase, { role: "user", content: prompt }];

    const uiAttachments = currentAttachments.map((a) => ({
      name: a.name,
      mime: a.mime,
      size: a.size,
      note: a.note,
      ...(a.image ? { image: a.image } : {}),
    }));

    setMessages((m) => [
      ...m,
      {
        id: -Date.now() - handoffDepth,
        conversationId: targetConvId ?? -1,
        role: "user",
        content: prompt,
        reasoning: "",
        attachments: uiAttachments,
        actions: [],
        files: [],
        error: "",
        createdAt: new Date().toISOString(),
      },
    ]);
    if (!opts?.attachmentsOverride) setAttachments([]);
    if (!opts?.convIdOverride) setDraft("");
    setChatError(null);
    setRunning(true);
    setLive({
      reasoning: "",
      text: "",
      status: handoffDepth > 0 ? "Продолжение в новом чате…" : "Запуск субагента…",
      actorLabel: sub.name,
      overseerReasoning: "",
    });

    // Сохраняем сообщение пользователя в БД, если чат уже существует (при создании с нуля его сохранит subagent_start)
    if (targetConvId) {
      void fetch(`/api/agent/conversations/${targetConvId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "user",
          content: prompt,
          attachments: currentAttachments.map((a) => ({
            name: a.name,
            mime: a.mime,
            size: a.size,
            note: a.note,
          })),
        }),
      }).catch(() => undefined);
    }

    const ctrl = new AbortController();
    streamAbortRef.current = ctrl;
    streamRunningRef.current = true;
    let resolvedConvId: number | null = targetConvId;
    let pendingHandoff: { summary: string; continuationPrompt: string; steps: number } | null = null;

    try {
      const res = await fetch("/api/ai/agent", {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentRole: "subagent",
          activeSubagent: {
            id: sub.id,
            slug: sub.slug,
            name: sub.name,
            roleTitle: sub.roleTitle,
            description: sub.description,
            systemPrompt: sub.systemPrompt,
            allowedCallees: sub.allowedCallees,
            toolProfile: sub.toolProfile ?? "restricted",
            unlockApi: sub.unlockApi,
            usedCustomApi: sub.unlockApi,
          },
          ...(targetConvId ? { subagentConversationId: targetConvId } : {}),
          messages: history,
          attachments: attachmentsPayload,
          settings: {
            baseUrl: settings.baseUrl,
            model: settings.model,
            ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
          },
          orchestratorSettings: {
            baseUrl: settings.baseUrl,
            model: settings.model,
            ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
          },
          params,
          trustLevel,
          maxSteps: 0,
          ...(modelContextLength ? { modelContextLength } : {}),
          ...(github
            ? {
                githubEnabled: true,
                githubOwner: github.owner,
                githubRepo: github.repo,
                githubBranch: github.branch,
              }
            : { githubEnabled: false }),
          subagents: subagents.map((s) => ({
            id: s.id,
            slug: s.slug,
            name: s.name,
            roleTitle: s.roleTitle,
            description: s.description,
            systemPrompt: s.systemPrompt,
            color: s.color,
            parentSubagentId: s.parentSubagentId,
            orchestratorCanCall: s.orchestratorCanCall,
            allowedCallees: s.allowedCallees,
            toolProfile: s.toolProfile ?? "restricted",
            unlockApi: s.unlockApi,
          })),
        }),
      });
      if (!res.ok || !res.body) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? "Субагент недоступен");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let trailingCr = false;

      const append = (chunk: string) => {
        let normalized = (trailingCr ? "\r" : "") + chunk;
        trailingCr = normalized.endsWith("\r");
        if (trailingCr) normalized = normalized.slice(0, -1);
        buffer += normalized.replace(/\r\n/g, "\n");
      };

      const process = (raw: string) => {
        const lines = raw.split("\n");
        const ev = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() || "message";
        const dataLines = lines.filter((l) => l.startsWith("data:"));
        if (dataLines.length === 0) return;
        const dataText = dataLines.map((l) => l.slice(5).trimStart()).join("\n");
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(dataText) as Record<string, unknown>;
        } catch {
          return;
        }
        const incomingConvId = Number(data.subagentConversationId ?? 0);
        if (Number.isSafeInteger(incomingConvId) && incomingConvId > 0) {
          resolvedConvId = incomingConvId;
        }
        if (ev === "subagent_reasoning") {
          setLive((l) => ({ ...l, actorLabel: sub.name, reasoning: String(data.text ?? "") }));
        } else if (ev === "subagent_text") {
          setLive((l) => ({ ...l, text: String(data.text ?? "") }));
        } else if (ev === "subagent_status") {
          setLive((l) => ({ ...l, actorLabel: sub.name, status: String(data.text ?? "") }));
        } else if (ev === "subagent_run") {
          const runId = Number(data.runId ?? 0);
          if (Number.isSafeInteger(runId) && runId > 0) lastRunIdRef.current = runId;
          setLastRunStatus("running");
        } else if (ev === "subagent_chat_rotated") {
          // Автоперенос контекста — это НЕ передача задачи другому субагенту.
          setHandoffNotice(`Контекст перенесён в новый чат (${Number(data.steps ?? 300)} шагов).`);
        } else if (ev === "subagent_handoff_new_chat") {
          const summary = String(data.summary ?? "").trim();
          const continuationPrompt = String(data.continuationPrompt ?? "").trim();
          const steps = Number(data.steps ?? 300) || 300;
          if (continuationPrompt) {
            pendingHandoff = { summary, continuationPrompt, steps };
          }
          setHandoffNotice(
            `Достигнут лимит шагов (${steps}). Сохранено summary и открывается новый чат для продолжения…`,
          );
        } else if (ev === "overseer_start" || ev === "overseer_status") {
          setLive((l) => ({
            ...l,
            actorLabel: "Надсмотрщик",
            status: String(data.text ?? `Надсмотрщик проверяет ${String(data.tool ?? "")}…`),
          }));
        } else if (ev === "overseer_reasoning") {
          setLive((l) => ({
            ...l,
            actorLabel: "Надсмотрщик",
            overseerReasoning: String(data.text ?? ""),
          }));
        } else if (ev === "overseer_done") {
          setLive((l) => ({ ...l, actorLabel: sub.name }));
        } else if (ev === "approval_required") {
          const ov =
            data.overseer && typeof data.overseer === "object"
              ? (data.overseer as OverseerVerdictMeta)
              : undefined;
          setSubApproval({
            approvalId: String(data.approvalId ?? ""),
            kind: String(data.kind ?? "command"),
            title: String(data.title ?? "Требуется разрешение"),
            description: String(data.description ?? data.reason ?? ""),
            command: data.command ? String(data.command) : undefined,
            cwd: data.cwd ? String(data.cwd) : undefined,
            overseer: ov,
          });
        } else if (ev === "subagent_done") {
          const u = (data.usage && typeof data.usage === "object" ? data.usage : {}) as {
            prompt?: number;
            completion?: number;
            total?: number;
          };
          setTokenUsage({
            prompt: Number(u.prompt ?? 0),
            completion: Number(u.completion ?? 0),
            total: Number(u.total ?? 0),
          });
          const runId = Number(data.runId ?? data.subagentRunId ?? 0);
          if (Number.isSafeInteger(runId) && runId > 0) lastRunIdRef.current = runId;
          const status = String(data.status ?? "completed");
          setLastRunStatus(status);
          // P1-2: упавший/заблокированный/отменённый запуск больше не выглядит успешным.
          if (status === "error" || status === "blocked" || status === "cancelled") {
            const label = RUN_STATUS_META[status as SubagentRun["status"]]?.label ?? status;
            const reason = String(data.error ?? data.outputSummary ?? "").trim();
            setChatError(reason ? `${label}: ${reason}` : label);
          } else if (status === "rotated") {
            setHandoffNotice("Контекст перенесён в новый чат");
          }
        } else if (ev === "subagent_error") {
          setLastRunStatus("error");
          setChatError(String(data.message ?? data.error ?? "Ошибка выполнения субагента"));
        } else if (ev === "error") {
          const msg = String(data.message ?? data.error ?? "Ошибка выполнения субагента");
          setChatError(msg);
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        append(decoder.decode(value, { stream: true }));
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (frame.trim()) process(frame);
        }
      }

      setLive({ reasoning: "", text: "", status: "", actorLabel: "", overseerReasoning: "" });
      setSubApproval(null);
      if (resolvedConvId && resolvedConvId !== targetConvId) {
        setSelectedConvId(resolvedConvId);
      }
      onChanged();

      if (pendingHandoff && !ctrl.signal.aborted && handoffDepth < 3) {
        const handoffInfo: { summary: string; continuationPrompt: string; steps: number } =
          pendingHandoff;
        const convRes = await fetch("/api/agent/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "subagent",
            subagentId,
            title: `${sub.name}: Продолжение #${handoffDepth + 1}`,
          }),
        });
        if (convRes.ok) {
          const convData = (await convRes.json()) as { conversation: SubagentConversation };
          setSelectedConvId(convData.conversation.id);
          setMessages([]);
          setTokenUsage(null);
          onChanged();
          await runSubagentTurn(handoffInfo.continuationPrompt, {
            convIdOverride: convData.conversation.id,
            attachmentsOverride: [],
            sessionAttachmentsOverride: nextSessionAttachments,
            historyOverride: [],
            handoffDepth: handoffDepth + 1,
          });
          return;
        }
      }

      if (resolvedConvId) {
        await loadConversation(resolvedConvId);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        setChatError(e instanceof Error ? e.message : "Ошибка");
      }
      setLive({ reasoning: "", text: "", status: "", actorLabel: "", overseerReasoning: "" });
      setSubApproval(null);
    } finally {
      streamRunningRef.current = false;
      setRunning(false);
    }
  };

  const send = async () => {
    if (!draft.trim() || !sub || running) return;
    await runSubagentTurn(draft);
  };

  return (
    <Card
      className="border-accent/40 glow-accent"
      title={
        <span className="flex flex-wrap items-center gap-2">
          {sub && (
            <span
              className="flex h-6 w-6 items-center justify-center rounded-lg text-white"
              style={{ background: sub.color }}
            >
              <Bot size={13} />
            </span>
          )}
          Изолированный чат: {sub?.name ?? `#${subagentId}`}
          <Badge
            className={
              sub?.unlockApi
                ? "border-amber-500/35 bg-amber-500/10 text-amber-500"
                : "border-accent/30 bg-accent/10 text-accent2"
            }
          >
            {sub?.unlockApi ? <Unlock size={10} /> : <Lock size={10} />}
            {sub?.unlockApi
              ? sub.model.trim() || "Свой API"
              : `API Оркестратора (${settings.model.trim() || "по умолчанию"})`}
          </Badge>
          <Badge
            className={
              sub?.toolProfile === "full"
                ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-400"
                : "border-border bg-card2 text-muted"
            }
          >
            <Wrench size={10} />
            {sub?.toolProfile === "full" ? "Полные инструменты" : "Урезанные"}
          </Badge>
          {lastRunStatus && (
            <Badge
              className={cn(
                "text-[10px]",
                RUN_STATUS_META[lastRunStatus as SubagentRun["status"]]?.badgeClass ??
                  "border-border bg-card2 text-muted",
              )}
            >
              {RUN_STATUS_META[lastRunStatus as SubagentRun["status"]]?.label ?? lastRunStatus}
            </Badge>
          )}
        </span>
      }
      subtitle={sub?.roleTitle || "Переписка изолирована от основного контекста Оркестратора."}
      action={
        <div className="flex items-center gap-1.5">
          {onOpenModelTab && (
            <Button size="sm" variant="secondary" onClick={onOpenModelTab}>
              <Cpu size={12} /> Модель
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X size={14} /> Закрыть
          </Button>
        </div>
      }
    >
      {/* Панель выбора чата в стиле TesterPanel */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card2/70 p-2">
        <History size={14} className="ml-1 text-muted" />
        <Select
          aria-label="Чаты субагента"
          value={activeConvId ?? ""}
          onChange={(e) => {
            const id = Number(e.target.value);
            if (id > 0) setSelectedConvId(id);
          }}
          disabled={loadingConv || myChats.length === 0}
          className="h-8 min-w-0 flex-1 text-xs"
        >
          {myChats.length === 0 ? (
            <option value="">Чатов пока нет — создайте или отправьте сообщение</option>
          ) : (
            myChats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title} ({c.messagesCount} сообщ.)
              </option>
            ))
          )}
        </Select>
        {tokenUsage && (
          <span
            aria-label={`Токены: ${tokenUsage.total}`}
            title={`Вход: ${tokenUsage.prompt} · Ответ: ${tokenUsage.completion} · Всего: ${tokenUsage.total}`}
          >
            <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-400">
              <Coins size={11} />
              {formatTokensCount(tokenUsage.total)} ток.
            </Badge>
          </span>
        )}
        <Button size="sm" variant="secondary" onClick={() => void newChat()} disabled={running}>
          <MessageSquarePlus size={12} /> Новый чат
        </Button>
        {activeConvId !== null && (
          <Button
            size="sm"
            variant="danger"
            onClick={() => void deleteChat(activeConvId)}
            disabled={running}
            aria-label="Удалить чат субагента"
          >
            <Trash2 size={12} />
          </Button>
        )}
      </div>

      {chatError && (
        <div className="mb-2.5 flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <AlertTriangle size={14} className="shrink-0" />
          <span>{chatError}</span>
        </div>
      )}

      {handoffNotice && (
        <div className="mb-2.5 flex items-center justify-between gap-2 rounded-xl border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-xs text-violet-300">
          <span className="inline-flex items-center gap-1.5">
            <Sparkles size={13} className="shrink-0" />
            {handoffNotice}
          </span>
          <button
            type="button"
            onClick={() => setHandoffNotice(null)}
            className="text-[11px] opacity-75 hover:opacity-100"
          >
            Скрыть
          </button>
        </div>
      )}

      {/* Лента сообщений */}
      <div
        ref={scrollRef}
        className="max-h-[44vh] min-h-[160px] space-y-2.5 overflow-y-auto rounded-2xl border border-border bg-card2/60 p-3"
      >
        {loadingConv && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 size={13} className="animate-spin" /> Загружаю сообщения…
          </div>
        )}
        {!loadingConv && messages.length === 0 && !running && (
          <p className="py-6 text-center text-xs text-muted">
            Сообщений нет. Напишите субагенту напрямую — задача выполнится в его собственном изолированном контексте.
          </p>
        )}
        {messages.map((m) => {
          const normalizedAttachments = (Array.isArray(m.attachments) ? m.attachments : []).map(
            (att) => (typeof att === "string" ? { name: att } : att),
          );
          const rotationActions = (Array.isArray(m.actions) ? m.actions : []).filter(
            (act): act is { type: string; summary?: string; steps?: number } =>
              typeof act === "object" &&
              act !== null &&
              (act.type === "subagent_chat_rotated" || act.type === "subagent_handoff_new_chat"),
          );

          return (
            <div
              key={m.id}
              className={cn(
                "rounded-xl border p-3 text-xs",
                m.role === "user"
                  ? "border-accent/30 bg-accent/10"
                  : "border-border bg-card",
              )}
            >
              <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-medium text-muted">
                <span>{m.role === "user" ? "Вы" : sub?.name ?? "Субагент"}</span>
              </div>
              {m.reasoning && (
                <div className="mb-2 rounded-lg border border-border/80 bg-card2/70 p-2">
                  <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted">
                    <Brain size={11} className="text-accent2" /> Размышления
                  </div>
                  <pre className="max-h-36 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] text-muted">
                    {m.reasoning}
                  </pre>
                </div>
              )}
              {normalizedAttachments.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {normalizedAttachments.map((att, idx) => (
                    <div
                      key={`${att.name}-${idx}`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card2/80 px-2 py-1 text-[11px] text-text"
                    >
                      {att.image && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={att.image}
                          alt={att.name}
                          className="h-6 w-6 rounded object-cover"
                        />
                      )}
                      <Paperclip size={11} className="text-cyan-400" />
                      <span className="max-w-[180px] truncate font-medium">{att.name}</span>
                      {typeof att.size === "number" && att.size > 0 && (
                        <span className="text-[10px] text-muted">{formatFileSize(att.size)}</span>
                      )}
                      {att.sandboxPath && (
                        <code className="rounded bg-card px-1 text-[10px] text-cyan-300">
                          {att.sandboxPath}
                        </code>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {rotationActions.map((act, idx) => (
                <div
                  key={`rot-${idx}`}
                  className="mb-2 rounded-lg border border-violet-500/35 bg-violet-500/10 px-2.5 py-1.5 text-[11px] text-violet-200"
                >
                  <div className="font-semibold">
                    Перенос в новый чат ({act.steps ?? 300} шагов)
                  </div>
                  {act.summary && (
                    <p className="mt-0.5 whitespace-pre-wrap text-[10px] text-violet-300/90">
                      {act.summary}
                    </p>
                  )}
                </div>
              ))}
              <div className="whitespace-pre-wrap leading-relaxed text-text">{m.content}</div>
              {m.error && (
                <div className="mt-2 rounded-lg border border-red-500/35 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-400">
                  {m.error}
                </div>
              )}
            </div>
          );
        })}
        {running && (
          <div className="space-y-2 rounded-xl border border-cyan-500/35 bg-card p-3 text-xs">
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-cyan-400">
              <Loader2 size={12} className="animate-spin" />
              {live.actorLabel && (
                <Badge className="border-cyan-500/35 bg-cyan-500/10 text-cyan-300">
                  {live.actorLabel}
                </Badge>
              )}
              <span>{live.status || "Субагент работает…"}</span>
            </div>
            {live.overseerReasoning && (
              <LiveReasoningBox
                text={live.overseerReasoning}
                streaming={live.actorLabel === "Надсмотрщик"}
                badgeLabel="Надсмотрщик · в эфире"
              />
            )}
            {live.reasoning && (
              <LiveReasoningBox
                text={live.reasoning}
                streaming={live.actorLabel !== "Надсмотрщик"}
                defaultOpen
                badgeLabel={`${sub?.name ?? "Субагент"} · в эфире`}
              />
            )}
            {live.text && <div className="whitespace-pre-wrap leading-relaxed text-text">{live.text}</div>}
          </div>
        )}
      </div>

      {subApproval && (
        <ApprovalToast
          kind={subApproval.kind}
          badgeLabel={subApproval.overseer ? "Надсмотрщик безопасности" : "Запрос разрешения"}
          title={subApproval.title}
          description={subApproval.description}
          onDismiss={() => void resolveSubApproval(false)}
          dismissDisabled={approvalBusy}
          actions={
            <>
              <Button
                size="sm"
                variant="primary"
                disabled={approvalBusy}
                onClick={() => void resolveSubApproval(true)}
              >
                <Check size={12} /> Разрешить
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={approvalBusy}
                onClick={() => void resolveSubApproval(false)}
              >
                <X size={12} /> Отклонить
              </Button>
            </>
          }
        >
          {subApproval.command && (
            <pre className="max-h-24 overflow-auto rounded-lg bg-card2 px-2 py-1.5 font-mono text-[11px] text-text">
              {subApproval.command}
              {subApproval.cwd ? `\n# cwd: ${subApproval.cwd}` : ""}
            </pre>
          )}
          {subApproval.overseer?.reason && (
            <p className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
              {subApproval.overseer.reason}
            </p>
          )}
        </ApprovalToast>
      )}

      {/* Прикреплённые файлы / макеты дизайна (доступны субагенту и сохраняются в сессии) */}
      {(attachments.length > 0 || sessionAttachments.length > 0) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-card2/60 p-2">
          {attachments.map((att, idx) => (
            <span
              key={`new-${att.name}-${idx}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-200"
            >
              {att.image && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={att.image} alt={att.name} className="h-4 w-4 rounded object-cover" />
              )}
              <Paperclip size={11} />
              <span className="max-w-[150px] truncate">{att.name}</span>
              <span className="text-[10px] opacity-70">{formatFileSize(att.size)}</span>
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                aria-label={`Убрать вложение ${att.name}`}
                className="text-muted hover:text-text"
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {sessionAttachments
            .filter((sa) => !attachments.some((a) => a.name === sa.name && a.size === sa.size))
            .map((sa, idx) => (
              <span
                key={`hist-${sa.name}-${idx}`}
                className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 text-[11px] text-muted"
                title="Файл дизайна/контекста из предыдущего сообщения будет передан в _shared_files"
              >
                <Paperclip size={10} />
                <span className="max-w-[140px] truncate">{sa.name}</span>
                <button
                  type="button"
                  onClick={() =>
                    setSessionAttachments((prev) =>
                      prev.filter((x) => !(x.name === sa.name && x.size === sa.size)),
                    )
                  }
                  aria-label={`Удалить из памяти сессии ${sa.name}`}
                  className="hover:text-text"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
        </div>
      )}

      {/* Поле отправки */}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          aria-label="Файлы для субагента"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) {
              void attachFiles(e.target.files);
              e.target.value = "";
            }
          }}
        />
        <Button
          type="button"
          size="md"
          variant="secondary"
          disabled={running}
          onClick={() => fileInputRef.current?.click()}
          title="Прикрепить файлы, скриншоты или макеты дизайна (доступны субагентам в _shared_files)"
          aria-label="Прикрепить файл для субагента"
        >
          <Paperclip size={14} />
        </Button>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          className="min-h-[48px] flex-1 resize-none"
          placeholder="Сообщение субагенту (Ctrl/Cmd+Enter для отправки)…"
        />
        <div className="flex items-center gap-2 self-end">
          {running ? (
            <Button size="md" variant="danger" onClick={stop}>
              <Square size={13} /> Стоп
            </Button>
          ) : (
            <Button size="md" variant="primary" onClick={() => void send()} disabled={!draft.trim()}>
              <Send size={13} /> Отправить
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
