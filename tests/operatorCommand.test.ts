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

  it("выключенная проверка действий и саморазбор попадают в команду", () => {
    const cmd = buildOperatorCommand({
      provider: "local",
      gen,
      verifyActions: false,
      selfReflect: false,
    });
    expect(cmd).toContain("--no-verify-actions");
    expect(cmd).toContain("--no-self-reflect");
  });

  it("пустые настройки не добавляют лишних флагов", () => {
    const cmd = buildOperatorCommand({ provider: "local" });
    expect(cmd).not.toContain("--temperature");
    expect(cmd).not.toContain("--reasoning");
  });

  it("передаёт уровень доверия флагом --trust-level", () => {
    expect(buildOperatorCommand({ provider: "local", trustLevel: "full" })).toContain("--trust-level full");
    expect(buildOperatorCommand({ provider: "local", trustLevel: "verified" })).toContain("--trust-level verified");
    expect(buildOperatorCommand({ provider: "local", trustLevel: "none" })).toContain("--trust-level none");
  });

  it("передаёт режим работы --task-mode и коучинг --coach только при не-дефолтных значениях", () => {
    const defCmd = buildOperatorCommand({ provider: "local", taskMode: "autonomous", coachMode: "after_step" });
    expect(defCmd).not.toContain("--task-mode");
    expect(defCmd).not.toContain("--coach");

    const gameCmd = buildOperatorCommand({ provider: "local", taskMode: "game", coachMode: "agent" });
    expect(gameCmd).toContain("--task-mode game");
    expect(gameCmd).toContain("--coach agent");

    const copilotOff = buildOperatorCommand({ provider: "local", taskMode: "copilot", coachMode: "off" });
    expect(copilotOff).toContain("--task-mode copilot");
    expect(copilotOff).toContain("--coach off");
  });
});
