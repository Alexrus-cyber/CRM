import { describe, expect, it } from "vitest";
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

  it("нормализует значения из запроса", () => {
    expect(normalizeGenParams({ temperature: 5 }).temperature).toBe(2);
    expect(normalizeGenParams({ reasoning: "budget", thinkingBudget: 2048 }).thinkingBudget).toBe(2048);
  });
});
