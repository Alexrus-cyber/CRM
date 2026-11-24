import { describe, expect, it } from "vitest";
import { normalizeParams } from "@/lib/ai";
import {
  AGENT_MAX_STEPS,
  decodeGenParams,
  isUnlimitedStepsRole,
  maxStepsCapForRole,
  normalizeGenParams,
  resolveStepsForRole,
} from "@/lib/genParams";

describe("настройки раздумий и генерации", () => {
  it("читает сохранённые значения из localStorage", () => {
    const raw = JSON.stringify({ temperature: 0.3, topP: 0.85, reasoning: "low", maxTokens: 900 });
    const params = decodeGenParams(raw);
    expect(params.temperature).toBe(0.3);
    expect(params.topP).toBe(0.85);
    expect(params.reasoning).toBe("low");
    expect(params.maxTokens).toBe(900);
  });

  it("битая строка не роняет интерфейс", () => {
    expect(decodeGenParams("{не json").reasoning).toBe("default");
  });

  it("нормализует значения из запроса и поддерживает режим max + безлимитный режим super_admin", () => {
    expect(normalizeGenParams({ temperature: 5 }).temperature).toBe(2);
    expect(normalizeGenParams({ reasoning: "budget", thinkingBudget: 2048 }).thinkingBudget).toBe(2048);
    expect(normalizeGenParams({ reasoning: "max" }).reasoning).toBe("max");
    expect(normalizeGenParams({ maxTokens: 384000 }).maxTokens).toBe(384000);
    expect(normalizeGenParams({ maxTokens: 500000 }).maxTokens).toBe(384000);
    expect(normalizeGenParams({ maxTokens: 500000 }, { unlimited: true }).maxTokens).toBe(500000);
    expect(normalizeGenParams({ thinkingBudget: 384000 }).thinkingBudget).toBe(384000);
    expect(normalizeGenParams({ thinkingBudget: 500000 }, { unlimited: true }).thinkingBudget).toBe(500000);
    expect(normalizeParams({ maxTokens: 384000, thinkingBudget: 384000 }).maxTokens).toBe(384000);
    expect(normalizeParams({ maxTokens: 384000, thinkingBudget: 384000 }).thinkingBudget).toBe(384000);
    expect(normalizeParams({ maxTokens: 600000, reasoning: "max" }, { unlimited: true }).maxTokens).toBe(600000);
    expect(normalizeParams({ maxTokens: 600000, reasoning: "max" }, { unlimited: true }).reasoning).toBe("max");
    expect(normalizeParams({ maxTokens: null }, { unlimited: true }).maxTokens).toBeNull();
  });

  it("шаги без лимита для всех ролей: 0/null/undefined = без лимита, положительное число без потолка", () => {
    // Все роли имеют безлимитные шаги.
    expect(isUnlimitedStepsRole("super_admin")).toBe(true);
    expect(isUnlimitedStepsRole("admin")).toBe(true);
    expect(isUnlimitedStepsRole("manager")).toBe(true);

    expect(maxStepsCapForRole("super_admin")).toBeNull();
    expect(maxStepsCapForRole("admin")).toBeNull();
    expect(maxStepsCapForRole("employee")).toBeNull();

    // 0 / null / undefined -> без лимита (0)
    expect(resolveStepsForRole("super_admin", 0, 0)).toBe(0);
    expect(resolveStepsForRole("super_admin", undefined, 0)).toBe(0);
    expect(resolveStepsForRole("admin", 0, 15)).toBe(0);
    expect(resolveStepsForRole("admin", null, 15)).toBe(0);

    // любое положительное число принимается без потолка для всех ролей
    expect(resolveStepsForRole("super_admin", 5000, 0)).toBe(5000);
    expect(resolveStepsForRole("admin", 5000, 15)).toBe(5000);
    expect(resolveStepsForRole("admin", 120, 15)).toBe(120);
    expect(resolveStepsForRole("developer", 999, 15)).toBe(999);
  });
});
