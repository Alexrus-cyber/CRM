import {
  createAgentConnection,
  createAgentConnectionToken,
  getAgentUsage,
  getAiQuotaOverride,
  getAiUsage,
  listAgentConnections,
  listAgentTokens,
  revealAgentToken,
  type UserLite,
} from "@/db/repo";
import {
  aiPolicyFor,
  canViewAgentUsage,
  hasAgentAccess,
  hasOperatorAccess,
  isUnlimitedAiRole,
} from "@/lib/aiPolicy";
import { ROLE_LABELS } from "@/lib/utils";

export async function buildLauncherProfile(user: UserLite, fallbackOrigin: string) {
  const [override, aiUsage] = await Promise.all([
    getAiQuotaOverride(user.id),
    getAiUsage(user.id),
  ]);
  const policy = aiPolicyFor(user.role, override?.monthlyLimit ?? null);
  const canUseAgent = hasAgentAccess(user);
  const canUseOperator = hasOperatorAccess(user);
  const unlimited = isUnlimitedAiRole(user.role);

  let operatorServerUrl = fallbackOrigin;
  let operatorToken: string | null = null;

  if (canUseOperator) {
    let connections = await listAgentConnections(user.id);
    let conn = connections.find((c) => c.isDefault) ?? connections[0] ?? null;
    if (!conn) {
      conn = await createAgentConnection(user.id, "Основной CRM", fallbackOrigin);
      connections = [conn];
    }
    if (conn.serverUrl) {
      operatorServerUrl = conn.serverUrl;
    }
    const tokens = await listAgentTokens(user.id, conn.id);
    const preferred = tokens.find((t) => t.name === "CRM Launcher") ?? tokens[0] ?? null;
    if (preferred) {
      operatorToken = await revealAgentToken(user.id, preferred.id);
    }
    if (!operatorToken) {
      const created = await createAgentConnectionToken(user.id, conn.id, "CRM Launcher");
      operatorToken = created?.token ?? null;
    }
  }

  const agentUsage = canViewAgentUsage(user) ? await getAgentUsage(user.id) : null;

  return {
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      roleLabel: ROLE_LABELS[user.role] ?? user.role,
      canUseAgent,
      canUseOperator,
    },
    limits: {
      unlimited,
      perChatTokens: policy.perChatTokens,
      monthlyTokens: policy.monthlyTokens,
      monthlyUsed: aiUsage.month.total,
      maxSteps: policy.maxSteps,
      rag: policy.rag,
      reasoning: policy.reasoning,
      summary: policy.summary,
    },
    operator: {
      enabled: canUseOperator,
      serverUrl: operatorServerUrl,
      token: operatorToken,
    },
    ...(agentUsage ? { agentUsage } : {}),
  };
}
