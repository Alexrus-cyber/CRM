"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type Subagent = {
  id: number;
  userId: number;
  slug: string;
  name: string;
  roleTitle: string;
  description: string;
  systemPrompt: string;
  color: string;
  isActive: boolean;
  parentSubagentId: number | null;
  orchestratorCanCall: boolean;
  allowedCallees: string[];
  unlockApi: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyHint: string;
  reasoningMode: string;
  runsCount: number;
  conversationsCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SubagentRun = {
  id: number;
  subagentId: number;
  subagentSlug?: string;
  subagentName?: string;
  subagentColor?: string;
  agentConversationId: number | null;
  subagentConversationId: number;
  callerKind: "orchestrator" | "subagent" | "user";
  callerSubagentId: number | null;
  callerSubagentName?: string;
  sandboxProject: string;
  inputSummary: string;
  outputSummary: string;
  status: "running" | "completed" | "handoff" | "blocked" | "error";
  requestedCalleeSlug: string;
  requestedCalleeTask: string;
  actionsCount: number;
  filesTouched: string[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  usedCustomApi: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SubagentConversation = {
  id: number;
  kind: "subagent";
  subagentId?: number;
  title: string;
  messagesCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SubagentMessage = {
  id: number;
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  reasoning: string;
  attachments: string[];
  actions: string[];
  files: string[];
  error: string;
  createdAt: string;
};

export type SubagentLimits = {
  maxStored: number;
  maxActive: number;
  totalCount: number;
  activeCount: number;
};

type Props = {
  settings: { baseUrl: string; model: string; apiKey?: string };
  params: Record<string, unknown>;
  trustLevel: string;
  modelContextLength?: number | null;
  github?: { owner: string; repo: string; branch: string } | null;
  onOpenModelTab?: () => void;
  onStats?: (stats: { totalCount: number; activeCount: number; runs: number }) => void;
};

const EMPTY_FORM: Partial<Subagent> & { apiKey: string; allowedCalleesText: string } = {
  name: "",
  roleTitle: "",
  description: "",
  systemPrompt: "",
  color: "#6366f1",
  isActive: true,
  parentSubagentId: null,
  orchestratorCanCall: true,
  allowedCalleesText: "*",
  unlockApi: false,
  provider: "",
  baseUrl: "",
  model: "",
  apiKey: "",
  reasoningMode: "default",
  slug: "",
};

const COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#0ea5e9", "#a855f7", "#ec4899", "#14b8a6"];

function slugifyFallback(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "subagent";
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(".", ",")} млн`;
  if (n >= 10_000) return `${Math.round(n / 1000)} тыс.`;
  return String(n);
}

export function SubagentsPanel({ settings, params, trustLevel, modelContextLength, github, onOpenModelTab, onStats }: Props) {
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
  const [editing, setEditing] = useState<(Partial<Subagent> & { allowedCalleesText?: string }) | null>(null);
  const [showTree, setShowTree] = useState(false);
  const [viewChatFor, setViewChatFor] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/subagents", { cache: "no-store" });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? "Не удалось загрузить субагентов");
      }
      const data = (await res.json()) as {
        subagents: Subagent[];
        runs: SubagentRun[];
        conversations: SubagentConversation[];
        limits: SubagentLimits;
      };
      setSubagents(data.subagents ?? []);
      setRuns(data.runs ?? []);
      setConversations(data.conversations ?? []);
      setLimits(data.limits ?? limits);
      if (selectedId && !data.subagents.some((s) => s.id === selectedId)) setSelectedId(null);
      onStats?.({
        totalCount: data.limits?.totalCount ?? data.subagents?.length ?? 0,
        activeCount: data.limits?.activeCount ?? (data.subagents ?? []).filter((s) => s.isActive).length,
        runs: (data.runs ?? []).length,
      });
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка загрузки");
      setLoading(false);
    }
  }, [limits, selectedId, onStats]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const activeSubagents = useMemo(() => subagents.filter((s) => s.isActive), [subagents]);

  const createOrUpdate = useCallback(
    async (form: Partial<Subagent> & { apiKey?: string; allowedCalleesText: string }) => {
      setError(null);
      const allowedCallees = form.allowedCalleesText
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
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
        allowedCallees,
        unlockApi: form.unlockApi,
        provider: form.provider,
        baseUrl: form.baseUrl,
        model: form.model,
        reasoningMode: form.reasoningMode,
      };
      if (editing?.id) {
        body.name = form.name;
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
        if (form.apiKey && form.apiKey.trim()) body.apiKey = form.apiKey.trim();
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
      await load();
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
        if (selectedId === id) setSelectedId(null);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Ошибка удаления");
      }
    },
    [load, selectedId],
  );

  const saveTree = useCallback(
    async (nodes: Array<{ id: number; isActive?: boolean; parentSubagentId?: number | null; orchestratorCanCall?: boolean; allowedCallees?: string[] }>) => {
      setError(null);
      try {
        const res = await fetch("/api/agent/subagents", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nodes }),
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error ?? "Не удалось сохранить дерево зависимостей");
        }
        setShowTree(false);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Ошибка сохранения дерева");
      }
    },
    [load],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-card p-3">
        <div>
          <h3 className="text-sm font-semibold text-text">Субагенты и Оркестратор</h3>
          <p className="text-[11px] text-muted">
            Активно: <b className={cn(limits.activeCount >= limits.maxActive ? "text-red-400" : "text-text")}>{limits.activeCount}</b> / {limits.maxActive} · Всего в базе: <b>{limits.totalCount}</b> / {limits.maxStored}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setEditing({ ...EMPTY_FORM });
              setSelectedId(null);
            }}
            disabled={limits.totalCount >= limits.maxStored}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            + Создать субагента
          </button>
          <button
            type="button"
            onClick={() => setShowTree((v) => !v)}
            className="rounded-lg border border-border bg-card2 px-3 py-1.5 text-xs text-text hover:border-accent/50"
          >
            Дерево зависимостей
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg border border-border bg-card2 px-3 py-1.5 text-xs text-muted hover:text-text"
          >
            Обновить
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>
      )}

      {showTree && (
        <DependencyTreeEditor
          subagents={subagents}
          onCancel={() => setShowTree(false)}
          onSave={saveTree}
        />
      )}

      {editing && (
        <SubagentFormEditor
          initial={editing}
          subagents={subagents}
          limits={limits}
          onCancel={() => setEditing(null)}
          onSave={createOrUpdate}
        />
      )}

      <div className="grid gap-2 md:grid-cols-2">
        {subagents.length === 0 && !loading && (
          <div className="rounded-xl border border-border bg-card p-4 text-xs text-muted">
            Субагентов пока нет. Создайте специализированного помощника, который Оркестратор (Главный Агент) сможет
            вызывать для узких задач в изолированном чате.
          </div>
        )}
        {subagents.map((s) => {
          const subRuns = runs.filter((r) => r.subagentId === s.id).slice(0, 3);
          const subChats = conversations.filter((c) => c.subagentId === s.id);
          const selected = selectedId === s.id;
          return (
            <div
              key={s.id}
              className={cn(
                "rounded-xl border bg-card p-3 transition",
                selected ? "border-accent/50 ring-1 ring-accent/30" : "border-border",
              )}
            >
              <div className="flex items-start gap-2">
                <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ background: s.color }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-text">{s.name}</span>
                    {s.isActive ? (
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">активен</span>
                    ) : (
                      <span className="rounded bg-card2 px-1.5 py-0.5 text-[10px] text-muted">выкл</span>
                    )}
                    {s.unlockApi && (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">свой API</span>
                    )}
                  </div>
                  <p className="truncate text-[11px] text-muted">`{s.slug}`{s.roleTitle ? ` · ${s.roleTitle}` : ""}</p>
                  {s.description && <p className="mt-1 line-clamp-2 text-[11px] text-muted">{s.description}</p>}
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(s.id);
                    setEditing({ ...s, allowedCalleesText: (s.allowedCallees || ["*"]).join(", ") });
                  }}
                  className="rounded-md border border-border bg-card2 px-2 py-1 text-[11px] text-text hover:border-accent/50"
                >
                  Редактировать
                </button>
                <button
                  type="button"
                  onClick={() => setViewChatFor(s.id)}
                  className="rounded-md border border-border bg-card2 px-2 py-1 text-[11px] text-text hover:border-accent/50"
                >
                  Чаты ({subChats.length})
                </button>
                <button
                  type="button"
                  onClick={() => void remove(s.id)}
                  className="rounded-md border border-red-500/30 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/10"
                >
                  Удалить
                </button>
              </div>

              {subRuns.length > 0 && (
                <div className="mt-2 space-y-1 border-t border-border pt-2">
                  {subRuns.map((r) => (
                    <div key={r.id} className="flex items-center justify-between gap-2 text-[10px] text-muted">
                      <span className="truncate">
                        #{r.id} · {r.callerKind} · {r.sandboxProject || "."}
                      </span>
                      <span className="shrink-0">{formatTokens(r.totalTokens)} ток</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {viewChatFor !== null && (
        <SubagentChatViewer
          subagentId={viewChatFor}
          subagents={subagents}
          conversations={conversations}
          settings={settings}
          params={params}
          trustLevel={trustLevel}
          modelContextLength={modelContextLength}
          github={github}
          onClose={() => setViewChatFor(null)}
          onChanged={load}
          onOpenModelTab={onOpenModelTab}
        />
      )}
    </div>
  );
}

function SubagentFormEditor({
  initial,
  subagents,
  limits,
  onCancel,
  onSave,
}: {
  initial: Partial<Subagent> & { allowedCalleesText?: string };
  subagents: Subagent[];
  limits: SubagentLimits;
  onCancel: () => void;
  onSave: (form: Partial<Subagent> & { apiKey?: string; allowedCalleesText: string }) => Promise<void>;
}) {
  const [form, setForm] = useState<Partial<Subagent> & { apiKey: string; allowedCalleesText: string }>({
    ...EMPTY_FORM,
    ...initial,
    apiKey: "",
    allowedCalleesText: initial.allowedCalleesText ?? (initial.allowedCallees || ["*"]).join(", "),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = subagents.filter((s) => s.id !== initial.id);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

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
    <div className="rounded-2xl border border-accent/30 bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-text">{initial.id ? "Редактирование субагента" : "Новый субагент"}</h4>
        <button type="button" onClick={onCancel} className="text-xs text-muted hover:text-text">
          Закрыть
        </button>
      </div>
      {error && <div className="mb-2 rounded-lg border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">{error}</div>}
      <div className="grid gap-2 md:grid-cols-2">
        <Field label="Название *">
          <input className="input" value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="Например: QA-инженер" />
        </Field>
        <Field label="Slug (латиница, опционально)">
          <input className="input" value={form.slug ?? ""} onChange={(e) => set("slug", e.target.value)} placeholder={slugifyFallback(form.name || "subagent")} />
        </Field>
        <Field label="Роль / должность">
          <input className="input" value={form.roleTitle ?? ""} onChange={(e) => set("roleTitle", e.target.value)} placeholder="Специализация" />
        </Field>
        <Field label="Цвет">
          <div className="flex flex-wrap gap-1">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => set("color", c)}
                className={cn("h-5 w-5 rounded-full ring-2", form.color === c ? "ring-text" : "ring-transparent")}
                style={{ background: c }}
              />
            ))}
          </div>
        </Field>
        <div className="md:col-span-2">
          <Field label="Описание зоны ответственности">
            <textarea className="input min-h-[48px]" value={form.description ?? ""} onChange={(e) => set("description", e.target.value)} />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Системный промпт субагента (обязателен к исполнению)">
            <textarea className="input min-h-[96px] font-mono text-[11px]" value={form.systemPrompt ?? ""} onChange={(e) => set("systemPrompt", e.target.value)} placeholder="Ты — узкоспециализированный субагент. Твоя задача: ..." />
          </Field>
        </div>
        <Field label="Родительский субагент">
          <select className="input" value={form.parentSubagentId ?? ""} onChange={(e) => set("parentSubagentId", e.target.value ? Number(e.target.value) : null)}>
            <option value="">— нет (прямой вызов) —</option>
            {others.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Разрешённые вызываемые субагенты">
          <input className="input" value={form.allowedCalleesText ?? ""} onChange={(e) => set("allowedCalleesText", e.target.value)} placeholder="* — любые, либо slug через запятую" />
        </Field>
        <label className="flex items-center gap-2 text-xs text-text">
          <input type="checkbox" checked={!!form.isActive} onChange={(e) => set("isActive", e.target.checked)} />
          Активен (участвует в дереве вызовов)
        </label>
        <label className="flex items-center gap-2 text-xs text-text">
          <input type="checkbox" checked={!!form.orchestratorCanCall} onChange={(e) => set("orchestratorCanCall", e.target.checked)} />
          Оркестратор может вызывать напрямую
        </label>

        <div className="md:col-span-2 rounded-xl border border-border bg-card2 p-2">
          <label className="flex items-center gap-2 text-xs font-medium text-text">
            <input type="checkbox" checked={!!form.unlockApi} onChange={(e) => set("unlockApi", e.target.checked)} />
            Разблокировать API (своё локальное / LAN / облачное подключение)
          </label>
          <p className="mt-1 text-[10px] text-muted">
            Если не отмечено — субагент строго использует заблокированный API Оркестратора (нельзя указать свой baseUrl / модель / ключ).
          </p>
          {form.unlockApi && (
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <Field label="Provider">
                <input className="input" value={form.provider ?? ""} onChange={(e) => set("provider", e.target.value)} placeholder="openai / vllm / ollama ..." />
              </Field>
              <Field label="Reasoning mode">
                <input className="input" value={form.reasoningMode ?? ""} onChange={(e) => set("reasoningMode", e.target.value)} placeholder="default" />
              </Field>
              <Field label="Base URL">
                <input className="input" value={form.baseUrl ?? ""} onChange={(e) => set("baseUrl", e.target.value)} placeholder="http://localhost:8000/v1" />
              </Field>
              <Field label="Модель">
                <input className="input" value={form.model ?? ""} onChange={(e) => set("model", e.target.value)} placeholder="model-name" />
              </Field>
              <div className="md:col-span-2">
                <Field label={initial.id ? "API-ключ (оставьте пустым, чтобы не менять)" : "API-ключ"}>
                  <input className="input" type="password" value={form.apiKey ?? ""} onChange={(e) => set("apiKey", e.target.value)} placeholder="sk-..." />
                </Field>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg border border-border bg-card2 px-3 py-1.5 text-xs text-muted hover:text-text">
          Отмена
        </button>
        <button type="button" onClick={() => void submit()} disabled={busy} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
          {busy ? "Сохраняю…" : "Сохранить"}
        </button>
      </div>
    </div>
  );
}

function DependencyTreeEditor({
  subagents,
  onCancel,
  onSave,
}: {
  subagents: Subagent[];
  onCancel: () => void;
  onSave: (
    nodes: Array<{ id: number; isActive?: boolean; parentSubagentId?: number | null; orchestratorCanCall?: boolean; allowedCallees?: string[] }>,
  ) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Record<number, { isActive: boolean; parentSubagentId: number | null; orchestratorCanCall: boolean; allowedCalleesText: string }>>(() =>
    Object.fromEntries(
      subagents.map((s) => [
        s.id,
        { isActive: s.isActive, parentSubagentId: s.parentSubagentId, orchestratorCanCall: s.orchestratorCanCall, allowedCalleesText: (s.allowedCallees || ["*"]).join(", ") },
      ]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (id: number, patch: Partial<(typeof draft)[number]>) =>
    setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const nodes = subagents.map((s) => {
        const d = draft[s.id];
        return {
          id: s.id,
          isActive: d.isActive,
          parentSubagentId: d.parentSubagentId,
          orchestratorCanCall: d.orchestratorCanCall,
          allowedCallees: d.allowedCalleesText.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
        };
      });
      await onSave(nodes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  };

  const activeCount = Object.values(draft).filter((d) => d.isActive).length;

  return (
    <div className="rounded-2xl border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-text">Дерево зависимостей «Оркестратор ↔ Субагенты»</h4>
        <span className="text-[11px] text-muted">Активно: {activeCount}</span>
      </div>
      {error && <div className="mb-2 rounded-lg border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">{error}</div>}
      <div className="space-y-2">
        {subagents.map((s) => {
          const d = draft[s.id];
          const others = subagents.filter((o) => o.id !== s.id);
          return (
            <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card2 p-2">
              <span className="h-3 w-3 rounded-full" style={{ background: s.color }} />
              <span className="text-xs font-medium text-text">{s.name}</span>
              <label className="flex items-center gap-1 text-[10px] text-text">
                <input type="checkbox" checked={d.isActive} onChange={(e) => update(s.id, { isActive: e.target.checked })} />
                активен
              </label>
              <label className="flex items-center gap-1 text-[10px] text-text">
                <input type="checkbox" checked={d.orchestratorCanCall} onChange={(e) => update(s.id, { orchestratorCanCall: e.target.checked })} />
                Орк. вызывает
              </label>
              <select
                className="input h-7 w-auto text-[11px]"
                value={d.parentSubagentId ?? ""}
                onChange={(e) => update(s.id, { parentSubagentId: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">— родитель: нет —</option>
                {others.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
              <input
                className="input h-7 w-40 text-[11px]"
                value={d.allowedCalleesText}
                onChange={(e) => update(s.id, { allowedCalleesText: e.target.value })}
                placeholder="* — любые"
              />
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg border border-border bg-card2 px-3 py-1.5 text-xs text-muted hover:text-text">
          Отмена
        </button>
        <button type="button" onClick={() => void submit()} disabled={busy} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
          {busy ? "Сохраняю…" : "Сохранить дерево"}
        </button>
      </div>
    </div>
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
  const myChats = conversations.filter((c) => c.subagentId === subagentId);
  const [activeConvId, setActiveConvId] = useState<number | null>(myChats[0]?.id ?? null);
  const [messages, setMessages] = useState<SubagentMessage[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<{ reasoning: string; text: string; status: string }>({ reasoning: "", text: "", status: "" });
  const [tokenUsage, setTokenUsage] = useState<{ prompt: number; completion: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const loadConversation = useCallback(
    async (convId: number) => {
      try {
        const res = await fetch(`/api/agent/subagents?subagentId=${subagentId}&conversationId=${convId}`, { cache: "no-store" });
        if (!res.ok) throw new Error("Не удалось загрузить чат");
        const data = (await res.json()) as {
          selectedConversation: { conversation: SubagentConversation; messages: SubagentMessage[]; tokens: { prompt: number; completion: number; total: number } };
        };
        setMessages(data.selectedConversation?.messages ?? []);
        setTokenUsage(data.selectedConversation?.tokens ?? null);
        setLive({ reasoning: "", text: "", status: "" });
        setLoadingConv(false);
      } catch {
        setMessages([]);
        setLoadingConv(false);
      }
    },
    [subagentId],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (activeConvId) void loadConversation(activeConvId);
  }, [activeConvId, loadConversation]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, live]);

  const newChat = async () => {
    try {
      const res = await fetch("/api/agent/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "subagent", subagentId, title: sub ? `Чат: ${sub.name}` : "Чат субагента" }),
      });
      if (!res.ok) throw new Error("Не удалось создать чат");
      const data = (await res.json()) as { conversation: SubagentConversation };
      onChanged();
      setActiveConvId(data.conversation.id);
      setMessages([]);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Ошибка создания чата");
    }
  };

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt || !sub || running) return;
    const history = [...messages.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: prompt }];
    setMessages((m) => [...m, { id: -Date.now(), conversationId: activeConvId ?? -1, role: "user", content: prompt, reasoning: "", attachments: [], actions: [], files: [], error: "", createdAt: new Date().toISOString() }]);
    setDraft("");
    setRunning(true);
    setLive({ reasoning: "", text: "", status: "Запуск субагента…" });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
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
          settings: { baseUrl: settings.baseUrl, model: settings.model, ...(settings.apiKey ? { apiKey: settings.apiKey } : {}) },
          orchestratorSettings: { baseUrl: settings.baseUrl, model: settings.model, ...(settings.apiKey ? { apiKey: settings.apiKey } : {}) },
          params,
          trustLevel,
          maxSteps: 0,
          ...(modelContextLength ? { modelContextLength } : {}),
          ...(github ? { githubEnabled: true, githubOwner: github.owner, githubRepo: github.repo, githubBranch: github.branch } : { githubEnabled: false }),
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
      let fullText = "";
      let fullReason = "";
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
        if (ev === "subagent_reasoning") {
          fullReason = String(data.text ?? "");
          setLive((l) => ({ ...l, reasoning: fullReason }));
        } else if (ev === "subagent_text") {
          fullText = String(data.text ?? "");
          setLive((l) => ({ ...l, text: fullText }));
        } else if (ev === "subagent_status") {
          setLive((l) => ({ ...l, status: String(data.text ?? "") }));
        } else if (ev === "subagent_done") {
          const u = (data.usage && typeof data.usage === "object" ? data.usage : {}) as { prompt?: number; completion?: number; total?: number };
          setTokenUsage({
            prompt: Number(u.prompt ?? 0),
            completion: Number(u.completion ?? 0),
            total: Number(u.total ?? 0),
          });
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
      onChanged();
      if (activeConvId) await loadConversation(activeConvId);
    } catch (e) {
      setLive({ reasoning: "", text: "", status: e instanceof Error ? e.message : "Ошибка" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded-2xl border border-accent/30 bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {sub && <span className="h-3 w-3 rounded-full" style={{ background: sub.color }} />}
          <h4 className="text-sm font-semibold text-text">Чаты субагента: {sub?.name ?? `#${subagentId}`}</h4>
        </div>
        <button type="button" onClick={onClose} className="text-xs text-muted hover:text-text">
          Закрыть
        </button>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {myChats.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setActiveConvId(c.id)}
            className={cn(
              "rounded-lg border px-2 py-1 text-[11px]",
              activeConvId === c.id ? "border-accent/50 bg-accent/10 text-text" : "border-border bg-card2 text-muted hover:text-text",
            )}
          >
            {c.title} ({c.messagesCount})
          </button>
        ))}
        <button type="button" onClick={() => void newChat()} className="rounded-lg bg-accent px-2 py-1 text-[11px] font-medium text-white">
          + Новый чат
        </button>
      </div>

      <div ref={scrollRef} className="max-h-[42vh] space-y-2 overflow-y-auto rounded-xl border border-border bg-card2 p-2">
        {loadingConv && <p className="text-[11px] text-muted">Загрузка…</p>}
        {!loadingConv && messages.length === 0 && (
          <p className="text-[11px] text-muted">Нет сообщений. Напишите субагенту в изолированном чате.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={cn("rounded-lg p-2 text-[12px]", m.role === "user" ? "bg-accent/10" : "bg-card")}>
            <div className="mb-0.5 text-[10px] text-muted">{m.role === "user" ? "Вы" : sub?.name ?? "Субагент"}</div>
            {m.reasoning && <pre className="mb-1 whitespace-pre-wrap text-[10px] text-muted">{m.reasoning}</pre>}
            <div className="whitespace-pre-wrap text-text">{m.content}</div>
          </div>
        ))}
        {running && (
          <div className="rounded-lg bg-card p-2 text-[12px]">
            {live.reasoning && <pre className="mb-1 whitespace-pre-wrap text-[10px] text-muted">{live.reasoning}</pre>}
            {live.text && <div className="whitespace-pre-wrap text-text">{live.text}</div>}
            {live.status && <div className="mt-1 text-[10px] text-muted">{live.status}</div>}
          </div>
        )}
      </div>

      {tokenUsage && (
        <p className="mt-1 text-[10px] text-muted">
          Токены: {formatTokens(tokenUsage.prompt)} prompt · {formatTokens(tokenUsage.completion)} completion · {formatTokens(tokenUsage.total)} всего
        </p>
      )}

      <div className="mt-2 flex items-end gap-2">
        <textarea
          className="input min-h-[40px] flex-1"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          }}
          placeholder="Сообщение субагенту (Ctrl/Cmd+Enter)…"
        />
        <button type="button" onClick={() => void send()} disabled={running || !draft.trim()} className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-50">
          {running ? "…" : "Отправить"}
        </button>
        {onOpenModelTab && (
          <button type="button" onClick={onOpenModelTab} className="rounded-lg border border-border bg-card2 px-3 py-2 text-[11px] text-muted hover:text-text">
            Модель
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-[11px] text-muted">
      <span className="mb-0.5 block">{label}</span>
      {children}
    </label>
  );
}
