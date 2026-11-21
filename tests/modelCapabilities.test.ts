import { describe, expect, it } from "vitest";
import {
  buildReasoningOptions,
  extractCapabilitiesFromMetadata,
  inferCapabilitiesFromModelName,
  pickCapabilitiesForModel,
  resolveModelCapabilities,
} from "@/lib/modelCapabilities";

describe("определение возможностей моделей ИИ", () => {
  it("распознаёт reasoning- и vision-модели по имени", () => {
    const r1 = inferCapabilitiesFromModelName("deepseek/deepseek-r1");
    expect(r1.supportsReasoning).toBe(true);
    expect(r1.reasoningModes).toContain("high");
    expect(r1.reasoningModes).toContain("max");

    const gpt4o = inferCapabilitiesFromModelName("gpt-4o-mini");
    expect(gpt4o.supportsVision).toBe(true);
    expect(gpt4o.supportsReasoning).toBe(false);
    expect(gpt4o.reasoningModes).toEqual(["default"]);

    const opus = inferCapabilitiesFromModelName("claude-opus-4-6");
    expect(opus.supportsReasoning).toBe(true);
    expect(opus.reasoningModes).toContain("max");
    expect(opus.supportsThinkingBudget).toBe(true);
  });

  it("читает метаданные OpenRouter / Ollama / LM Studio", () => {
    const caps = extractCapabilitiesFromMetadata("qwen/qwen3.5-plus", {
      context_length: 131072,
      top_provider: { max_completion_tokens: 65536 },
      supported_parameters: ["reasoning", "tools", "temperature"],
      architecture: { input_modalities: ["text", "image"] },
      capabilities: ["thinking", "vision", "tools"],
    });
    expect(caps).not.toBeNull();
    expect(caps!.contextLength).toBe(131072);
    expect(caps!.maxOutputTokens).toBe(65536);
    expect(caps!.supportsReasoning).toBe(true);
    expect(caps!.supportsVision).toBe(true);
    expect(caps!.supportsTools).toBe(true);
    expect(caps!.reasoningModes).toContain("max");
  });

  it("строит доступные режимы раздумий с учётом ролевой политики и возможностей модели", () => {
    const gpt52 = resolveModelCapabilities("gpt-5.2");
    const fullOptions = buildReasoningOptions(gpt52, ["default", "off", "low", "medium", "high", "max", "budget"]);
    expect(fullOptions.map((o) => o.value)).toContain("max");

    const roleLimited = buildReasoningOptions(gpt52, ["default", "off", "low"]);
    expect(roleLimited.map((o) => o.value)).toEqual(["default", "off", "low"]);

    const fallback = pickCapabilitiesForModel({}, "claude-3-7-sonnet");
    expect(fallback.supportsReasoning).toBe(true);
    expect(fallback.supportsVision).toBe(true);
    expect(fallback.supportsThinkingBudget).toBe(true);
  });
});
