"use client";

import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  Coins,
  FlaskConical,
  History,
  Loader2,
  MessageSquarePlus,
  Play,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import type { AiSettings } from "@/lib/ai";
import type { GenParams } from "@/lib/genParams";
import { cn } from "@/lib/utils";
import { LiveReasoningBox } from "../LiveReasoningBox";

export type TesterIssueItem = {
  title: string;
  description: string;
  file?: string;
  line?: number;
  fixHint?: string;
  severity: "critical" | "minor";
};

export type TesterCheckItem = {
  name: string;
  tool?: string;
  status: "pass" | "fail" | "warn";
  details: string;
};

export type TesterRunItem = {
  id: number;
  userId: number;
  agentConversationId: number | null;
  testerConversationId: number;
  sandboxProject: string;
  summary: string;
  status: "running" | "passed" | "minor_issues" | "critical_issues" | "error";
  reportSummary: string;
  criticalIssues: TesterIssueItem[];
  minorIssues: TesterIssueItem[];
  checksRun: TesterCheckItem[];
  minorDecision: "not_needed" | "pending" | "approved" | "rejected";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  createdAt: string;
  updatedAt: string;
};

export type TesterConversationItem = {
  id: number;
  kind: "tester";
  title: string;
  messagesCount: number;
  createdAt?: string;
  updatedAt: string;
};

export type TesterChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  error?: string;
};

export type LiveTesterActionItem = {
  type: string;
  label?: string;
  command?: string;
  url?: string;
  action?: string;
  viewport?: string;
  summary?: string;
  error?: string;
  errorsCount?: number;
  issuesCount?: number;
  animationsCount?: number;
};

export function formatLiveTesterAction(act: LiveTesterActionItem): string {
  if (act.type === "browser_inspect") {
    const scope = act.action ? ` (${act.action}${act.viewport ? ` · ${act.viewport}` : ""})` : "";
    if (act.error) {
      return `Сбой BrowserInspector${scope}: ${act.error}`;
    }
    const detail = act.summary || act.url || "осмотр завершён";
    return `Осмотр проекта${scope}: ${detail}`;
  }
  return act.label || act.command || act.url || act.type;
}

export type LiveTesterState = {
  runKey: string;
  runId?: number;
  testerConversationId?: number;
  sandboxProject: string;
  summary: string;
  model: string;
  statusText: string;
  reasoning: string;
  content: string;
  browserLog?: string[];
  actions: LiveTesterActionItem[];
};

const STATUS_META: Record<
  TesterRunItem["status"],
  { label: string; badgeClass: string }
> = {
  running: {
    label: "Тестируется…",
    badgeClass: "border-cyan-500/40 bg-cyan-500/15 text-cyan-400",
  },
  passed: {
    label: "Ошибок нет",
    badgeClass: "border-emerald-500/40 bg-emerald-500/15 text-emerald-400",
  },
  minor_issues: {
    label: "Мелкие замечания",
    badgeClass: "border-amber-500/40 bg-amber-500/15 text-amber-400",
  },
  critical_issues: {
    label: "Критические ошибки",
    badgeClass: "border-red-500/40 bg-red-500/15 text-red-400",
  },
  error: {
    label: "Ошибка проверки",
    badgeClass: "border-red-500/40 bg-red-500/15 text-red-400",
  },
};

const DECISION_META: Record<TesterRunItem["minorDecision"], { label: string; cls: string }> = {
  not_needed: { label: "Без мелких правок", cls: "text-muted bg-card2 border-border" },
  pending: { label: "Ждёт решения человека", cls: "text-amber-400 bg-amber-500/15 border-amber-500/40" },
  approved: { label: "Одобрено человеком", cls: "text-emerald-400 bg-emerald-500/15 border-emerald-500/40" },
  rejected: { label: "Отклонено (оставить)", cls: "text-muted bg-card2 border-border" },
};

export function TesterPanel({
  settings,
  params,
  sandboxProjects,
  runs,
  conversations,
  selectedConvId,
  messages,
  loading,
  directRunning,
  directPrompt,
  directProject,
  liveTester,
  decisionBusyRunId,
  agentRunning,
  error,
  onSelectConv,
  onNewChat,
  onDeleteChat,
  onRefresh,
  onChangePrompt,
  onChangeProject,
  onRunDirect,
  onDecideMinor,
  onOpenModelTab,
  onOpenAgentChat,
}: {
  settings: AiSettings;
  params: GenParams;
  sandboxProjects: Array<{ name: string; files?: number }>;
  runs: TesterRunItem[];
  conversations: TesterConversationItem[];
  selectedConvId: number | null;
  messages: TesterChatMessage[];
  loading: boolean;
  directRunning: boolean;
  directPrompt: string;
  directProject: string;
  liveTester: LiveTesterState | null;
  decisionBusyRunId: number | null;
  agentRunning: boolean;
  error: string | null;
  onSelectConv: (id: number) => void;
  onNewChat: () => void;
  onDeleteChat: (id: number) => void;
  onRefresh: () => void;
  onChangePrompt: (value: string) => void;
  onChangeProject: (value: string) => void;
  onRunDirect: () => void;
  onDecideMinor: (runId: number, decision: "approved" | "rejected") => void;
  onOpenModelTab: () => void;
  onOpenAgentChat: (conversationId: number) => void;
}) {
  const activeRun =
    (selectedConvId
      ? runs.find((r) => r.testerConversationId === selectedConvId)
      : undefined) ??
    runs[0] ??
    null;

  const activeCriticalIssues = Array.isArray(activeRun?.criticalIssues) ? activeRun.criticalIssues : [];
  const activeMinorIssues = Array.isArray(activeRun?.minorIssues) ? activeRun.minorIssues : [];
  const activeChecksRun = Array.isArray(activeRun?.checksRun) ? activeRun.checksRun : [];
  const totalRunTokens = activeRun?.totalTokens ?? 0;
  const activeModelLabel = settings.model.trim() || "по умолчанию";

  return (
    <div className="space-y-3">
      {/* Синхронизация модели и счётчик токенов отдельного чата */}
      <div className="rounded-2xl border border-border bg-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 font-semibold text-text">
              <FlaskConical size={14} className="text-violet-400" /> Под-агент Тестировщик (QA)
            </span>
            <span className="rounded-md border border-violet-500/35 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-300">
              Модель синхронизирована с Агентом: {activeModelLabel}
            </span>
            <span className="rounded-md border border-border bg-card2 px-2 py-0.5 text-[10px] text-muted">
              Раздумья: {params.reasoning}
              {params.temperature !== undefined && params.temperature !== null
                ? ` · t=${params.temperature}`
                : ""}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onOpenModelTab}
              className="rounded-lg border border-border bg-card2 px-2 py-1 text-[10px] font-medium text-muted transition hover:text-text"
            >
              Изменить модель обоих
            </button>
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="flex items-center gap-1 rounded-lg border border-border bg-card2 px-2 py-1 text-[10px] text-muted transition hover:text-text disabled:opacity-40"
              title="Обновить список прогонов и отчётов"
            >
              <RefreshCw size={11} className={loading ? "animate-spin" : ""} /> Обновить
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-[11px] text-muted">
          Когда Агент заканчивает приложение или блок кода, он передаёт summary и Sandbox-проект Тестировщику.
          Тестировщик создаёт <span className="text-text font-medium">отдельный новый чат</span> (берёт токены
          только со своего чата), проверяет проект расширенными QA-инструментами и возвращает отчёт в БД Агенту.
        </p>
      </div>

      {/* Выбор отдельного чата Тестировщика + счётчик токенов этого чата */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-card p-2">
        <History size={13} className="ml-1 text-muted" />
        <select
          aria-label="Чаты и прогоны тестировщика"
          value={selectedConvId ?? ""}
          onChange={(e) => {
            const id = Number(e.target.value);
            if (id > 0) onSelectConv(id);
          }}
          disabled={loading || conversations.length === 0}
          className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent disabled:opacity-60"
        >
          {conversations.length === 0 ? (
            <option value="">{loading ? "Загружаю чаты тестировщика…" : "Проверок тестировщика пока нет"}</option>
          ) : (
            conversations.map((conv) => {
              const linked = runs.find((r) => r.testerConversationId === conv.id);
              const badge = linked ? ` · ${STATUS_META[linked.status].label}` : "";
              const toks = linked && linked.totalTokens > 0 ? ` · ${linked.totalTokens} ток.` : "";
              return (
                <option key={conv.id} value={conv.id}>
                  {conv.title || `QA #${conv.id}`} ({conv.messagesCount} сообщ.{badge}{toks})
                </option>
              );
            })
          )}
        </select>
        {activeRun && (
          <span
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-card2 px-2 py-1 text-[10px] text-text"
            title={`Токены отдельного QA-чата: вход ${activeRun.promptTokens}, ответ ${activeRun.completionTokens}`}
          >
            <Coins size={11} className="text-amber-400" />
            Токены QA-чата: {totalRunTokens.toLocaleString("ru-RU")}
          </span>
        )}
        <button
          type="button"
          onClick={onNewChat}
          disabled={directRunning || agentRunning}
          className="flex h-8 items-center gap-1 rounded-lg border border-border bg-card2 px-2 text-[10px] font-medium text-muted transition hover:text-text disabled:opacity-40"
        >
          <MessageSquarePlus size={12} /> Новый чат тестировщика
        </button>
        {selectedConvId !== null && (
          <button
            type="button"
            onClick={() => onDeleteChat(selectedConvId)}
            disabled={directRunning || agentRunning}
            aria-label="Удалить чат тестировщика"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card2 text-muted transition hover:text-red-500 disabled:opacity-40"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {/* Живой поток работы Тестировщика (когда Агент вызвал call_tester) */}
      {liveTester && (
        <div className="space-y-2 rounded-2xl border border-violet-500/40 bg-violet-500/5 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 font-semibold text-violet-300">
              <Loader2 size={13} className="animate-spin" />
              Тестировщик проверяет: {liveTester.sandboxProject || "."}
            </span>
            <span className="text-[10px] text-muted">Модель: {liveTester.model || activeModelLabel}</span>
          </div>
          {liveTester.statusText && (
            <p className="text-[11px] text-muted">{liveTester.statusText}</p>
          )}
          {liveTester.browserLog && liveTester.browserLog.length > 0 && (
            <div className="space-y-1 rounded-xl border border-cyan-500/30 bg-card/80 p-2">
              <p className="text-[10px] font-semibold text-cyan-400">
                Ход BrowserInspector ({liveTester.browserLog.length})
              </p>
              <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted">
                {liveTester.browserLog.slice(-16).join("\n")}
              </pre>
            </div>
          )}
          {liveTester.reasoning && (
            <LiveReasoningBox text={liveTester.reasoning} streaming />
          )}
          {liveTester.content && (
            <p className="whitespace-pre-wrap rounded-xl border border-border bg-card2 p-2 text-[11px] text-text">
              {liveTester.content}
            </p>
          )}
          {liveTester.actions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {liveTester.actions.slice(-8).map((act, idx) => (
                <span
                  key={`${act.type}-${idx}`}
                  className={cn(
                    "max-w-full truncate rounded-md border px-2 py-0.5 text-[10px]",
                    act.error
                      ? "border-red-500/40 bg-red-500/10 text-red-300"
                      : act.type === "browser_inspect"
                        ? "border-cyan-500/35 bg-cyan-500/10 text-cyan-300"
                        : "border-border bg-card text-muted",
                  )}
                  title={formatLiveTesterAction(act)}
                >
                  {formatLiveTesterAction(act)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Карточка структурированного QA-отчёта из БД */}
      {activeRun && (
        <div className="space-y-3 rounded-2xl border border-border bg-card p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold",
                  STATUS_META[activeRun.status].badgeClass,
                )}
              >
                {activeRun.status === "passed" ? (
                  <CheckCircle2 size={11} />
                ) : activeRun.status === "critical_issues" || activeRun.status === "error" ? (
                  <ShieldAlert size={11} />
                ) : (
                  <AlertCircle size={11} />
                )}
                {STATUS_META[activeRun.status].label}
              </span>
              <span className="text-[11px] font-medium text-text">
                Sandbox: <span className="font-mono">{activeRun.sandboxProject || "."}</span>
              </span>
              {activeRun.model && (
                <span className="text-[10px] text-muted">модель: {activeRun.model}</span>
              )}
            </div>
            {activeRun.agentConversationId && (
              <button
                type="button"
                onClick={() => onOpenAgentChat(activeRun.agentConversationId!)}
                className="inline-flex items-center gap-1 rounded-lg border border-border bg-card2 px-2 py-0.5 text-[10px] text-accent2 hover:underline"
              >
                <Bot size={11} /> Чат Агента #{activeRun.agentConversationId}
              </button>
            )}
          </div>

          {activeRun.reportSummary && (
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-text">
              {activeRun.reportSummary}
            </p>
          )}

          {activeCriticalIssues.length > 0 && (
            <div className="space-y-1.5 rounded-xl border border-red-500/35 bg-red-500/5 p-2.5">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-red-400">
                <TriangleAlert size={13} /> Критические ошибки ({activeCriticalIssues.length}) — переданы Агенту на исправление
              </p>
              <ul className="space-y-1.5">
                {activeCriticalIssues.map((iss, idx) => (
                  <li key={`crit-${idx}`} className="rounded-lg border border-red-500/20 bg-card px-2.5 py-1.5 text-[11px]">
                    <p className="font-medium text-text">
                      {iss.title}
                      {iss.file && (
                        <span className="ml-1.5 font-mono text-[10px] text-red-300">
                          {iss.file}
                          {iss.line ? `:${iss.line}` : ""}
                        </span>
                      )}
                    </p>
                    {iss.description && iss.description !== iss.title && (
                      <p className="mt-0.5 text-[10px] text-muted">{iss.description}</p>
                    )}
                    {iss.fixHint && (
                      <p className="mt-0.5 text-[10px] text-emerald-400">Подсказка: {iss.fixHint}</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {activeMinorIssues.length > 0 && (
            <div className="space-y-2 rounded-xl border border-amber-500/35 bg-amber-500/5 p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-400">
                  <Sparkles size={13} /> Мелкие / некритические замечания ({activeMinorIssues.length})
                </p>
                <span
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-[10px] font-medium",
                    (DECISION_META[activeRun.minorDecision] ?? DECISION_META.pending).cls,
                  )}
                >
                  {(DECISION_META[activeRun.minorDecision] ?? DECISION_META.pending).label}
                </span>
              </div>
              <ul className="space-y-1">
                {activeMinorIssues.map((iss, idx) => (
                  <li key={`minor-${idx}`} className="rounded-lg border border-amber-500/20 bg-card px-2.5 py-1.5 text-[11px]">
                    <p className="font-medium text-text">
                      {iss.title}
                      {iss.file && (
                        <span className="ml-1.5 font-mono text-[10px] text-amber-300">
                          {iss.file}
                          {iss.line ? `:${iss.line}` : ""}
                        </span>
                      )}
                    </p>
                    {iss.description && iss.description !== iss.title && (
                      <p className="mt-0.5 text-[10px] text-muted">{iss.description}</p>
                    )}
                  </li>
                ))}
              </ul>
              {activeRun.minorDecision === "pending" && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="text-[10px] text-amber-300">Нужно ли вносить эти мелкие изменения?</span>
                  <button
                    type="button"
                    onClick={() => onDecideMinor(activeRun.id, "approved")}
                    disabled={decisionBusyRunId === activeRun.id}
                    className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-[10px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    <Check size={11} /> Внести изменения
                  </button>
                  <button
                    type="button"
                    onClick={() => onDecideMinor(activeRun.id, "rejected")}
                    disabled={decisionBusyRunId === activeRun.id}
                    className="inline-flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-[10px] font-medium text-red-400 hover:bg-red-500/20 disabled:opacity-50"
                  >
                    <X size={11} /> Оставить как есть
                  </button>
                </div>
              )}
            </div>
          )}

          {activeChecksRun.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                Выполненные QA-проверки ({activeChecksRun.length})
              </p>
              <div className="grid gap-1 sm:grid-cols-2">
                {activeChecksRun.map((chk, idx) => (
                  <div
                    key={`chk-${idx}`}
                    className="rounded-lg border border-border bg-card2 px-2 py-1.5 text-[10px]"
                  >
                    <div className="flex items-center justify-between gap-1 font-medium text-text">
                      <span className="truncate">{chk.name}</span>
                      <span
                        className={cn(
                          "shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase",
                          chk.status === "pass"
                            ? "bg-emerald-500/15 text-emerald-400"
                            : chk.status === "fail"
                              ? "bg-red-500/15 text-red-400"
                              : "bg-amber-500/15 text-amber-400",
                        )}
                      >
                        {chk.status}
                      </span>
                    </div>
                    {chk.details && (
                      <p className="mt-0.5 line-clamp-2 text-muted" title={chk.details}>
                        {chk.details}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Лента сообщений отдельного чата Тестировщика */}
      <div className="rounded-2xl border border-border bg-card">
        <div className="max-h-[300px] space-y-2 overflow-y-auto p-3">
          {loading ? (
            <p className="flex items-center justify-center gap-1.5 py-6 text-[11px] text-muted">
              <Loader2 size={12} className="animate-spin" /> Загружаю переписку тестировщика…
            </p>
          ) : messages.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-muted">
              Отдельный чат Тестировщика пуст. Агент автоматически вызовет его после создания проекта,
              либо вы можете запустить ручную QA-проверку ниже.
            </p>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[92%] space-y-1.5 rounded-2xl px-3 py-2 text-xs",
                    msg.role === "user" ? "bg-violet-500/20" : "border border-border bg-card2",
                  )}
                >
                  {msg.reasoning && <LiveReasoningBox text={msg.reasoning} />}
                  <p className="whitespace-pre-wrap break-words leading-relaxed">{msg.content}</p>
                  {msg.error && (
                    <p className="text-[11px] text-red-400">{msg.error}</p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Ручной запуск Тестировщика по проекту в Sandbox с той же моделью */}
        <div className="space-y-2 border-t border-border p-3">
          {error && <p className="text-[11px] text-red-500">{error}</p>}
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <label className="flex items-center gap-1.5 text-muted">
              <span>Проект Sandbox:</span>
              <select
                aria-label="Проект Sandbox для тестировщика"
                value={directProject}
                onChange={(e) => onChangeProject(e.target.value)}
                disabled={directRunning || agentRunning}
                className="h-8 rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
              >
                <option value=".">. (вся песочница)</option>
                {sandboxProjects.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                    {typeof p.files === "number" ? ` (${p.files})` : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex min-w-0 items-end gap-2">
            <textarea
              value={directPrompt}
              onChange={(e) => onChangePrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onRunDirect();
                }
              }}
              rows={2}
              aria-label="Задача для Тестировщика"
              placeholder="Задача для Тестировщика: проверь вёрстку, ссылки, консоль и тесты проекта…"
              disabled={directRunning || agentRunning}
              className="max-h-28 min-h-10 min-w-0 flex-1 resize-y rounded-xl border border-border bg-card2 px-3 py-2 text-xs outline-none focus:border-accent disabled:opacity-60"
            />
            <button
              type="button"
              onClick={onRunDirect}
              disabled={directRunning || agentRunning || !directPrompt.trim()}
              className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-violet-600 px-3 text-xs font-medium text-white transition hover:bg-violet-500 disabled:opacity-40"
            >
              {directRunning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              Проверить проект
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
