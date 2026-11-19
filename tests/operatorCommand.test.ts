import { describe, expect, it } from "vitest";
import { buildOperatorCommand } from "@/lib/operatorCommand";

const gen = {
  reasoning: "low" as const,
  thinkingBudget: null,
  sendThinkingFlag: true,
  temperature: 0.3,
  topP: 0.9,
  maxTokens: 700,
  seed: null,
};

describe("команда запуска оператора", () => {
  it("передаёт раздумья и генерацию флагами", () => {
    const cmd = buildOperatorCommand({
      provider: "deepseek",
      token: "crmop_test",
      model: "deepseek-flash",
      apiKey: "sk-test",
      gen,
      verifyActions: true,
    });
    expect(cmd).toContain("--temperature 0.3");
    expect(cmd).toContain("--top-p 0.9");
    expect(cmd).toContain("--max-tokens 700");
    expect(cmd).toContain("--reasoning low");
    expect(cmd).not.toContain("--no-verify-actions");
  });

  it("выключенная проверка действий попадает в команду", () => {
    const cmd = buildOperatorCommand({ provider: "local", gen, verifyActions: false });
    expect(cmd).toContain("--no-verify-actions");
  });

  it("пустые настройки не добавляют лишних флагов", () => {
    const cmd = buildOperatorCommand({ provider: "local" });
    expect(cmd).not.toContain("--temperature");
    expect(cmd).not.toContain("--reasoning");
  });
});
