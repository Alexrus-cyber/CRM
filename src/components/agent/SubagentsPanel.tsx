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
  Pencil,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
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
} from "./DependencyTreeCanvas";
import {
  formatTokensCount,
  parseCalleesList,
  type Subagent,
  type SubagentConversation,
  type SubagentLimits,
  type SubagentMessage,
  type SubagentRun,
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
  onStats?: (stats: { totalCount: number; activeCount: number; runs: number }) => void;
};

type SubagentFormState = Partial<Subagent> & {
  apiKey: string;
  clearApiKey?: boolean;
  allowedCalleesText: string;
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
    label: "ошибка",
    badgeClass: "border-red-500/35 bg-red-500/15 text-red-500",
  },
};

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<SubagentFormState | null>(null);
  const [showTree, setShowTree] = useState(true);
  const [viewChatFor, setViewChatFor] = useState<number | null>(null);

  const onStatsRef = useRef(onStats);
  const selectedIdRef = useRef(selectedId);
  const inFlightLoadRef = useRef<Promise<void> | null>(null);
  const abortLoadRef = useRef<AbortController | null>(null);
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

  /** Стабильный единичный загрузчик: без циклических зависимостей и с дедупликацией. */
  const load = useCallback(async (opts?: { showSpinner?: boolean }) => {
    if (inFlightLoadRef.current && !abortLoadRef.current?.signal.aborted) {
      return inFlightLoadRef.current;
    }

    const controller = new AbortController();
    abortLoadRef.current = controller;

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
        };
        if (controller.signal.aborted || !mountedRef.current) return;

        const nextSubs = Array.isArray(data.subagents) ? data.subagents : [];
        const nextRuns = Array.isArray(data.runs) ? data.runs : [];
        const nextConvs = Array.isArray(data.conversations) ? data.conversations : [];
        const nextLimits: SubagentLimits = data.limits ?? {
          maxStored: 50,
          maxActive: 10,
          totalCount: nextSubs.length,
          activeCount: nextSubs.filter((s) => s.isActive).length,
        };

        setSubagents(nextSubs);
        setRuns(nextRuns);
        setConversations(nextConvs);
        setLimits(nextLimits);
        setError(null);

        if (selectedIdRef.current && !nextSubs.some((s) => s.id === selectedIdRef.current)) {
          setSelectedId(null);
        }

        onStatsRef.current?.({
          totalCount: nextLimits.totalCount,
          activeCount: nextLimits.activeCount,
          runs: nextRuns.length,
        });
      } catch (e) {
        if (controller.signal.aborted || !mountedRef.current) return;
        setError(e instanceof Error ? e.message : "Ошибка загрузки");
      } finally {
        if (abortLoadRef.current === controller) {
          inFlightLoadRef.current = null;
        }
        if (mountedRef.current) {
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
    async (nodes: DependencyTreeNodePayload[]) => {
      setError(null);
      const res = await fetch("/api/agent/subagents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? "Не удалось сохранить дерево зависимостей");
      }
      await load({ showSpinner: true });
    },
    [load],
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

      {/* Интерактивное нейронное дерево зависимостей */}
      {showTree && (
        <DependencyTreeCanvas
          subagents={subagents}
          orchestratorModel={orchestratorModelLabel}
          maxActive={limits.maxActive}
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
                    <div className="text-[10px] text-muted">Handoff</div>
                    <div className="text-xs font-semibold text-text">{calleesCountLabel}</div>
                  </div>
                </div>

                {/* Последние запуски */}
                {recentRuns.length > 0 && (
                  <div className="mt-2.5 space-y-1 rounded-xl border border-border/70 bg-card2/40 p-2">
                    <div className="text-[10px] font-medium text-muted">Последние запуски</div>
                    {recentRuns.map((r) => {
                      const statusMeta = RUN_STATUS_META[r.status] ?? RUN_STATUS_META.completed;
                      return (
                        <div
                          key={r.id}
                          className="flex items-center justify-between gap-2 text-[11px]"
                        >
                          <div className="flex min-w-0 items-center gap-1.5">
                            <Badge className={cn("px-1.5 py-0 text-[9px]", statusMeta.badgeClass)}>
                              {statusMeta.label}
                            </Badge>
                            <span className="truncate text-muted">
                              #{r.id} · {r.callerKind} · {r.sandboxProject || "."}
                            </span>
                          </div>
                          <span className="shrink-0 font-mono text-[10px] text-text">
                            {formatTokensCount(r.totalTokens)} ток.
                          </span>
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
          key={`chat-${viewChatFor}`}
          subagentId={viewChatFor}
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

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!form.name?.trim()) throw new Error("Укажите название субагента");
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

      <div className="space-y-4">
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
              />
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
            />
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
            <Field label="Родительский субагент">
              <Select
                value={form.parentSubagentId ?? ""}
                onChange={(e) =>
                  set("parentSubagentId", e.target.value ? Number(e.target.value) : null)
                }
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
                />
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
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-border pt-3">
        <Button size="md" variant="secondary" onClick={onCancel} disabled={busy}>
          Отмена
        </Button>
        <Button size="md" variant="primary" onClick={() => void submit()} disabled={busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          {busy ? "Сохраняю…" : initial.id ? "Сохранить изменения" : "Создать"}
        </Button>
      </div>
    </Card>
  );
}

function SubagentChatViewer({
  subagentId,
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
  const [selectedConvId, setSelectedConvId] = useState<number | null>(() => myChats[0]?.id ?? null);
  const activeConvId =
    selectedConvId && myChats.some((c) => c.id === selectedConvId)
      ? selectedConvId
      : (selectedConvId ?? myChats[0]?.id ?? null);

  const [messages, setMessages] = useState<SubagentMessage[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<{ reasoning: string; text: string; status: string }>({
    reasoning: "",
    text: "",
    status: "",
  });
  const [tokenUsage, setTokenUsage] = useState<{ prompt: number; completion: number; total: number } | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const convAbortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
        setLive({ reasoning: "", text: "", status: "" });
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
    if (!activeConvId) return;
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
  };

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt || !sub || running) return;
    const history = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: prompt },
    ];
    setMessages((m) => [
      ...m,
      {
        id: -Date.now(),
        conversationId: activeConvId ?? -1,
        role: "user",
        content: prompt,
        reasoning: "",
        attachments: [],
        actions: [],
        files: [],
        error: "",
        createdAt: new Date().toISOString(),
      },
    ]);
    setDraft("");
    setChatError(null);
    setRunning(true);
    setLive({ reasoning: "", text: "", status: "Запуск субагента…" });

    const ctrl = new AbortController();
    streamAbortRef.current = ctrl;
    let resolvedConvId: number | null = activeConvId;

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
            unlockApi: sub.unlockApi,
            usedCustomApi: sub.unlockApi,
          },
          ...(activeConvId ? { subagentConversationId: activeConvId } : {}),
          messages: history,
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
          setLive((l) => ({ ...l, reasoning: String(data.text ?? "") }));
        } else if (ev === "subagent_text") {
          setLive((l) => ({ ...l, text: String(data.text ?? "") }));
        } else if (ev === "subagent_status") {
          setLive((l) => ({ ...l, status: String(data.text ?? "") }));
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
        } else if (ev === "error" || ev === "subagent_error") {
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

      setLive({ reasoning: "", text: "", status: "" });
      if (resolvedConvId && resolvedConvId !== activeConvId) {
        setSelectedConvId(resolvedConvId);
      }
      onChanged();
      if (resolvedConvId) {
        await loadConversation(resolvedConvId);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        setChatError(e instanceof Error ? e.message : "Ошибка");
      }
      setLive({ reasoning: "", text: "", status: "" });
    } finally {
      setRunning(false);
    }
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
        {messages.map((m) => (
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
            <div className="whitespace-pre-wrap leading-relaxed text-text">{m.content}</div>
            {m.error && (
              <div className="mt-2 rounded-lg border border-red-500/35 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-400">
                {m.error}
              </div>
            )}
          </div>
        ))}
        {running && (
          <div className="rounded-xl border border-cyan-500/35 bg-card p-3 text-xs">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-cyan-400">
              <Loader2 size={12} className="animate-spin" />
              {live.status || "Субагент работает…"}
            </div>
            {live.reasoning && (
              <pre className="mb-2 max-h-36 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-card2/70 p-2 font-mono text-[11px] text-muted">
                {live.reasoning}
              </pre>
            )}
            {live.text && <div className="whitespace-pre-wrap leading-relaxed text-text">{live.text}</div>}
          </div>
        )}
      </div>

      {/* Поле отправки */}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
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
