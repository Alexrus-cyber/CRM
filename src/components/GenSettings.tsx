"use client";

import { useState, type ReactNode } from "react";
import { Brain, ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";
import { Badge, Button, Card, Input } from "@/components/ui";
import { Combobox } from "@/components/Combobox";
import { AI_MAX_GENERATION_TOKENS, AI_REASONING_MODES, type ReasoningMode } from "@/lib/ai";
import { describeGenParams, normalizeGenParams, type GenParams } from "@/lib/genParams";

/**
 * Блок «Раздумья и генерация» для вкладок «Агент» и «Оператор».
 *
 * Ровно те же ручки, что в «Чате с моделью»: режим раздумий, бюджет,
 * temperature, top_p, max_tokens, seed. Настройки хранятся в браузере
 * (передаются в `useStoredJson`) и уходят только в запросе к модели.
 */

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0 space-y-1">
      <span className="block text-[10px] uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  );
}

export function GenSettings({
  value,
  onChange,
  subtitle = "Те же ручки, что в «Чате с моделью». Пустое поле — параметр не передаём.",
  defaultOpen = false,
  children,
}: {
  value: GenParams;
  onChange: (next: GenParams) => void;
  subtitle?: string;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const params = normalizeGenParams(value);
  const mode = AI_REASONING_MODES.find((item) => item.value === params.reasoning);
  const update = (patch: Partial<GenParams>) => onChange(normalizeGenParams({ ...params, ...patch }));

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <Brain size={13} className="text-accent2" />
          Раздумья и генерация
          <Badge className="border-border text-muted">{describeGenParams(params)}</Badge>
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
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-1">
              <span className="block text-[10px] uppercase tracking-wide text-muted">Тип раздумий</span>
              <Combobox
                aria-label="Тип раздумий"
                value={params.reasoning}
                onChange={(next) => update({ reasoning: next as ReasoningMode })}
                placeholder="По умолчанию"
                options={AI_REASONING_MODES.map((item) => ({
                  value: item.value,
                  label: item.label,
                  hint: item.hint,
                }))}
                size="sm"
              />
            </div>
            {params.reasoning === "budget" ? (
              <Field label="Бюджет раздумий, токенов">
                <Input
                  type="number"
                  min={64}
                  max={AI_MAX_GENERATION_TOKENS}
                  step={64}
                  value={params.thinkingBudget ?? ""}
                  onChange={(event) =>
                    update({ thinkingBudget: event.target.value === "" ? null : Number(event.target.value) })
                  }
                  placeholder="2048"
                  className="h-9 text-xs"
                />
              </Field>
            ) : (
              <div className="flex items-end pb-1">
                <p className="text-[10px] leading-relaxed text-muted">{mode?.hint}</p>
              </div>
            )}
          </div>

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
                max={AI_MAX_GENERATION_TOKENS}
                step={64}
                value={params.maxTokens ?? ""}
                onChange={(event) =>
                  update({ maxTokens: event.target.value === "" ? null : Number(event.target.value) })
                }
                placeholder="до 384000"
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
