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

  it("нормализует значения из запроса и поддерживает вывод до 384k токенов", () => {
    expect(normalizeGenParams({ temperature: 5 }).temperature).toBe(2);
    expect(normalizeGenParams({ reasoning: "budget", thinkingBudget: 2048 }).thinkingBudget).toBe(2048);
    expect(normalizeGenParams({ maxTokens: 384000 }).maxTokens).toBe(384000);
    expect(normalizeGenParams({ maxTokens: 500000 }).maxTokens).toBe(384000);
    expect(normalizeGenParams({ thinkingBudget: 384000 }).thinkingBudget).toBe(384000);
    expect(normalizeParams({ maxTokens: 384000, thinkingBudget: 384000 }).maxTokens).toBe(384000);
    expect(normalizeParams({ maxTokens: 384000, thinkingBudget: 384000 }).thinkingBudget).toBe(384000);
  });

  it("различает безлимитный super_admin и потолок 500 шагов для остальных ролей (включая admin)", () => {
    expect(isUnlimitedStepsRole("super_admin")).toBe(true);
    expect(isUnlimitedStepsRole("admin")).toBe(false);
    expect(isUnlimitedStepsRole("manager")).toBe(false);

    expect(maxStepsCapForRole("super_admin")).toBeNull();
    expect(maxStepsCapForRole("admin")).toBe(AGENT_MAX_STEPS);
    expect(maxStepsCapForRole("employee")).toBe(AGENT_MAX_STEPS);

    // super_admin: 0 = без лимита, произвольное положительное число не режется потолком 500/2000
    expect(resolveStepsForRole("super_admin", 0, 0)).toBe(0);
    expect(resolveStepsForRole("super_admin", undefined, 0)).toBe(0);
    expect(resolveStepsForRole("super_admin", 5000, 0)).toBe(5000);

    // admin и рядовые роли: жёсткий предел 500 шагов и запрет 0 (безлимита)
    expect(resolveStepsForRole("admin", 0, 15)).toBe(15);
    expect(resolveStepsForRole("admin", 5000, 15)).toBe(AGENT_MAX_STEPS);
    expect(resolveStepsForRole("admin", 120, 15)).toBe(120);
    expect(resolveStepsForRole("developer", 999, 15)).toBe(AGENT_MAX_STEPS);
  });
});
