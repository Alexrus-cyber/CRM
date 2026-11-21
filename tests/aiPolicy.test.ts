import { describe, expect, it } from "vitest";
import {
  AI_ROLE_POLICY,
  aiPolicyFor,
  canViewAgentUsage,
  chatTokensLeft,
  formatStepLimit,
  formatTokenCount,
  hasAgentAccess,
  hasOperatorAccess,
  isUnlimitedAiRole,
  roleStepLimit,
} from "@/lib/aiPolicy";
import { AGENT_MAX_STEPS } from "@/lib/genParams";

describe("политика лимитов ИИ по ролям", () => {
  it("у главного админа (super_admin) нет ограничений по токенам, файлам, RAG и шагам и доступен режим max", () => {
    const superPolicy = aiPolicyFor("super_admin");
    expect(isUnlimitedAiRole("super_admin")).toBe(true);
    expect(isUnlimitedAiRole("admin")).toBe(false);
    expect(superPolicy.perChatTokens).toBeNull();
    expect(superPolicy.monthlyTokens).toBeNull();
    expect(superPolicy.maxSteps).toBeNull();
    expect(superPolicy.rag).toBe(true);
    expect(superPolicy.chatsUnlimited).toBe(true);
    expect(superPolicy.reasoning).toContain("max");
    expect(roleStepLimit("super_admin")).toBeNull();
    expect(chatTokensLeft({ tokensTotal: 9_999_999 }, superPolicy)).toBe(Number.POSITIVE_INFINITY);
    expect(formatTokenCount(superPolicy.perChatTokens)).toBe("без лимита");
    expect(formatStepLimit(superPolicy.maxSteps)).toBe("без лимита");
  });

  it("обычный администратор (admin) и остальные роли ограничены пределом 500 шагов и лимитом на чат", () => {
    const nonSuperRoles = ["admin", "developer", "manager", "consultant", "user"] as const;
    for (const role of nonSuperRoles) {
      const policy = AI_ROLE_POLICY[role];
      expect(policy.perChatTokens).toBe(1_000_000);
      expect(policy.maxSteps).toBe(AGENT_MAX_STEPS);
      expect(roleStepLimit(role)).toBe(AGENT_MAX_STEPS);
      expect(formatStepLimit(policy.maxSteps)).toBe(`до ${AGENT_MAX_STEPS}`);
      expect(chatTokensLeft({ tokensTotal: 250_000 }, policy)).toBe(750_000);
    }
    expect(AI_ROLE_POLICY.admin.monthlyTokens).toBeNull();
    expect(AI_ROLE_POLICY.developer.monthlyTokens).toBe(5_000_000);
    expect(AI_ROLE_POLICY.manager.monthlyTokens).toBe(1_500_000);
    expect(AI_ROLE_POLICY.consultant.monthlyTokens).toBe(500_000);
    expect(AI_ROLE_POLICY.user.monthlyTokens).toBe(500_000);
  });

  it("разделяет доступ к Агенту, Оператору и статистике токенов", () => {
    expect(hasAgentAccess({ role: "super_admin", canUseAgent: false })).toBe(true);
    expect(hasOperatorAccess({ role: "super_admin", canUseOperator: false })).toBe(true);
    expect(canViewAgentUsage({ role: "super_admin" })).toBe(true);

    expect(hasAgentAccess({ role: "developer", canUseAgent: false })).toBe(false);
    expect(hasAgentAccess({ role: "developer", canUseAgent: true })).toBe(true);
    expect(hasOperatorAccess({ role: "admin", canUseOperator: false })).toBe(false);
    expect(hasOperatorAccess({ role: "admin", canUseOperator: true })).toBe(true);
    expect(canViewAgentUsage({ role: "admin" })).toBe(false);
    expect(canViewAgentUsage({ role: "developer" })).toBe(false);
  });
});
