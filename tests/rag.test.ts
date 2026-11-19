import { describe, expect, it } from "vitest";
import {
  RAG_CHARS_PER_TOKEN,
  RAG_FULL_MAX_CHARS,
  formatFullRagContext,
  ragBudgetChars,
} from "@/lib/rag";
import { AI_DEFAULT_PARAMS, normalizeParams } from "@/lib/ai";

const chunk = (path: string, text: string) => ({ id: 0, path, text, score: 0 });

describe("formatFullRagContext", () => {
  it("собирает все фрагменты и группирует один файл под общим заголовком", () => {
    const packed = formatFullRagContext([
      chunk("a.md", "первый"),
      chunk("a.md", "второй"),
      chunk("b.md", "третий"),
    ]);
    expect(packed.used).toBe(3);
    expect(packed.truncated).toBe(false);
    expect(packed.text).toContain("Файл: a.md\nпервый\nвторой");
    expect(packed.text).toContain("Файл: b.md\nтретий");
  });

  it("обрезает по бюджету и честно считает, сколько вошло", () => {
    const chunks = Array.from({ length: 10 }, (_, index) => chunk(`f${index}.md`, "x".repeat(200)));
    const packed = formatFullRagContext(chunks, 1_000);
    expect(packed.used).toBeLessThan(10);
    expect(packed.used).toBeGreaterThan(0);
    expect(packed.truncated).toBe(true);
    expect(packed.chars).toBeLessThanOrEqual(1_000);
  });

  it("не отдаёт больше потолка даже при огромном бюджете", () => {
    const chunks = Array.from({ length: 5 }, (_, index) => chunk(`f${index}.md`, "y".repeat(100)));
    const packed = formatFullRagContext(chunks, RAG_FULL_MAX_CHARS);
    expect(packed.used).toBe(5);
    expect(packed.truncated).toBe(false);
  });
});

describe("ragBudgetChars", () => {
  it("без слежения за контекстом отдаёт страховочный потолок", () => {
    expect(ragBudgetChars(0, 5_000, 1_000)).toBe(RAG_FULL_MAX_CHARS);
  });

  it("считает свободное место за вычетом истории и резерва", () => {
    expect(ragBudgetChars(8_192, 1_000, 1_024)).toBe(Math.floor((8_192 - 1_000 - 1_024) * RAG_CHARS_PER_TOKEN));
  });

  it("не уходит в минус", () => {
    expect(ragBudgetChars(1_000, 5_000, 1_000)).toBe(0);
  });
});

describe("normalizeParams: ragFull", () => {
  it("по умолчанию выключен", () => {
    expect(AI_DEFAULT_PARAMS.ragFull).toBe(false);
    expect(normalizeParams({}).ragFull).toBe(false);
  });

  it("включается только явным true", () => {
    expect(normalizeParams({ ragFull: true }).ragFull).toBe(true);
    expect(normalizeParams({ ragFull: "true" }).ragFull).toBe(false);
  });

  it("не сбрасывает остальные RAG-параметры", () => {
    const params = normalizeParams({ ragFull: true, ragChunks: 12 });
    expect(params.ragChunks).toBe(12);
  });
});
