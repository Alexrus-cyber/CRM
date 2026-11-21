"use client";

import { useState, type ReactNode } from "react";
import { Brain, ChevronDown, ChevronUp, Loader2, RefreshCw, SlidersHorizontal } from "lucide-react";
import { Badge, Button, Card, Input } from "@/components/ui";
import { Combobox } from "@/components/Combobox";
import { AI_MAX_GENERATION_TOKENS, AI_REASONING_MODES, type ReasoningMode } from "@/lib/ai";
import { describeGenParams, normalizeGenParams, type GenParams } from "@/lib/genParams";
import { buildReasoningOptions, type ModelCapabilities } from "@/lib/modelCapabilities";

/**
 * Блок «Раздумья и генерация» для вкладок «Агент» и «Оператор».
 *
 * Ровно те же ручки, что в «Чате с моделью»: динамический список типов раздумий
 * (подтягивается из возможностей выбранной модели), бюджет, temperature, top_p,
 * max_tokens, seed. Для Главного администратора (`unlimited`) нет искусственных
 * потолков на max_tokens и thinking_budget.
 */

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0 space-y-1">
      <span className="block text-[10px] uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  );
}

function formatContextBadge(tokens: number | null): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${Math.round((tokens / 1_000_000) * 10) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export function GenSettings({
  value,
  onChange,
  subtitle = "Те же ручки, что в «Чате с моделью». Пустое поле — параметр не передаём.",
  defaultOpen = false,
  capabilities = null,
  allowedModes,
  unlimited = false,
  modelName,
  onRefreshCapabilities,
  refreshingCapabilities = false,
  children,
}: {
  value: GenParams;
  onChange: (next: GenParams) => void;
  subtitle?: string;
  defaultOpen?: boolean;
  capabilities?: ModelCapabilities | null;
  allowedModes?: ReasoningMode[];
  unlimited?: boolean;
  modelName?: string;
  onRefreshCapabilities?: () => void;
  refreshingCapabilities?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const params = normalizeGenParams(value, { unlimited });
  const options = buildReasoningOptions(capabilities, allowedModes);
  const mode = options.find((item) => item.value === params.reasoning) ?? AI_REASONING_MODES.find((item) => item.value === params.reasoning);
  const modeUnsupported =
    Boolean(capabilities) &&
    capabilities !== null &&
    capabilities.source !== "unknown" &&
    !options.some((item) => item.value === params.reasoning);

  const update = (patch: Partial<GenParams>) =>
    onChange(normalizeGenParams({ ...params, ...patch }, { unlimited }));

  const ctxBadge = formatContextBadge(capabilities?.contextLength ?? null);
  const displayModel = (modelName ?? capabilities?.model ?? "").trim();

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <Brain size={13} className="text-accent2" />
          Раздумья и генерация
          <Badge className="border-border text-muted">{describeGenParams(params)}</Badge>
          {capabilities && (
            <Badge className="border-accent/30 bg-accent/10 text-accent2">
              {capabilities.supportsReasoning
                ? `раздумья: ${capabilities.reasoningModes.filter((m) => m !== "default").join("/") || "да"}`
                : "обычная модель (без раздумий)"}
            </Badge>
          )}
        </span>
      }
      subtitle={subtitle}
      action={
        <Button size="sm" variant="secondary" onClick={() => setOpen((prev) => !prev)}>
          <SlidersHorizontal size={12} />
          {open ? "Свернуть" : "Настроить"}
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </Button>
      }
    >
      {open && (
        <div className="space-y-3">
          {capabilities && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card2/60 px-2.5 py-2 text-[10px] text-muted">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-text">
                  Возможности{displayModel ? ` (${displayModel})` : ""}:
                </span>
                <span>{capabilities.note}</span>
                {ctxBadge && (
                  <span className="rounded border border-border bg-card px-1.5 py-0.5 text-text">
                    контекст: {ctxBadge}
                  </span>
                )}
                {capabilities.supportsVision === true && (
                  <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-500">
                    Vision
                  </span>
                )}
                {capabilities.supportsTools === true && (
                  <span className="rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-cyan-400">
                    Tools
                  </span>
                )}
              </div>
              {onRefreshCapabilities && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={onRefreshCapabilities}
                  disabled={refreshingCapabilities}
                  className="h-7 px-2 text-[10px]"
                >
                  {refreshingCapabilities ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <RefreshCw size={11} />
                  )}
                  Подтянуть возможности
                </Button>
              )}
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-1">
              <span className="block text-[10px] uppercase tracking-wide text-muted">Тип раздумий</span>
              <Combobox
                aria-label="Тип раздумий"
                value={params.reasoning}
                onChange={(next) => update({ reasoning: next as ReasoningMode })}
                placeholder="По умолчанию"
                options={options}
                size="sm"
              />
            </div>
            {params.reasoning === "budget" ? (
              <Field label="Бюджет раздумий, токенов">
                <Input
                  type="number"
                  min={unlimited ? 1 : 64}
                  max={unlimited ? undefined : AI_MAX_GENERATION_TOKENS}
                  step={64}
                  value={params.thinkingBudget ?? ""}
                  onChange={(event) =>
                    update({ thinkingBudget: event.target.value === "" ? null : Number(event.target.value) })
                  }
                  placeholder={unlimited ? "2048 (без лимита)" : "2048"}
                  className="h-9 text-xs"
                />
              </Field>
            ) : (
              <div className="flex items-end pb-1">
                <p className="text-[10px] leading-relaxed text-muted">{mode?.hint}</p>
              </div>
            )}
          </div>

          {modeUnsupported && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[10px] text-amber-500">
              <span>
                Режим «{mode?.label ?? params.reasoning}» не входит в возможности выбранной модели.
              </span>
              <button
                type="button"
                onClick={() => update({ reasoning: "default", thinkingBudget: null })}
                className="rounded border border-amber-500/40 bg-card px-2 py-0.5 text-[10px] font-medium text-text hover:border-amber-400"
              >
                Сбросить на «По умолчанию»
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Field label="temperature">
              <Input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={params.temperature ?? ""}
                onChange={(event) =>
                  update({ temperature: event.target.value === "" ? null : Number(event.target.value) })
                }
                placeholder="—"
                className="h-9 text-xs"
              />
            </Field>
            <Field label="top_p">
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={params.topP ?? ""}
                onChange={(event) => update({ topP: event.target.value === "" ? null : Number(event.target.value) })}
                placeholder="—"
                className="h-9 text-xs"
              />
            </Field>
            <Field label="max_tokens">
              <Input
                type="number"
                min={1}
                max={unlimited ? undefined : AI_MAX_GENERATION_TOKENS}
                step={64}
                value={params.maxTokens ?? ""}
                onChange={(event) =>
                  update({ maxTokens: event.target.value === "" ? null : Number(event.target.value) })
                }
                placeholder={unlimited ? "без лимита" : "до 384000"}
                className="h-9 text-xs"
              />
            </Field>
            <Field label="seed">
              <Input
                type="number"
                min={0}
                step={1}
                value={params.seed ?? ""}
                onChange={(event) => update({ seed: event.target.value === "" ? null : Number(event.target.value) })}
                placeholder="—"
                className="h-9 text-xs"
              />
            </Field>
          </div>

          <label className="flex items-start gap-2 text-[10px] leading-relaxed text-muted">
            <input
              type="checkbox"
              checked={params.sendThinkingFlag}
              onChange={(event) => update({ sendThinkingFlag: event.target.checked })}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[#7c5cff]"
            />
            <span>
              Дублировать режим в <code className="font-mono">chat_template_kwargs.enable_thinking</code> — нужно
              Qwen3/Unsloth; если сервер ругается на незнакомое поле, снимите галочку.
            </span>
          </label>

          {children}
        </div>
      )}
    </Card>
  );
}
