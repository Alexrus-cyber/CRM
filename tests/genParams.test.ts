import { describe, expect, it } from "vitest";
import { normalizeParams } from "@/lib/ai";
import { decodeGenParams, normalizeGenParams } from "@/lib/genParams";

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
});
