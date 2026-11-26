import {
  createAgentConnection,
  createAgentConnectionToken,
  getAgentUsage,
  getAiQuotaOverride,
  getAiUsage,
  listAgentConnections,
  listAgentTokens,
  listAiChats,
  reissueAgentConnectionToken,
  type UserLite,
} from "@/db/repo";
import {
  AI_ROLE_POLICY,
  aiPolicyFor,
  canViewAgentUsage,
  hasAgentAccess,
  hasOperatorAccess,
  isUnlimitedAiRole,
} from "@/lib/aiPolicy";
import { ROLE_LABELS } from "@/lib/utils";

function isLoopbackOriginUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

export async function buildLauncherProfile(
  user: UserLite,
  fallbackOrigin: string,
  options?: { issueToken?: boolean },
) {
  const isSuperAdmin = user.role === "super_admin";
  const [override, aiUsage, chats] = await Promise.all([
    getAiQuotaOverride(user.id),
    getAiUsage(user.id),
    listAiChats(user.id, isSuperAdmin ? 1000 : 200),
  ]);
  const policy = aiPolicyFor(user.role, override?.monthlyLimit ?? null);
  const canUseAgent = hasAgentAccess(user);
  const canUseOperator = hasOperatorAccess(user);
  const canSeeAgentUsage = canViewAgentUsage(user);
  const unlimited = isUnlimitedAiRole(user.role);

  let operatorServerUrl = fallbackOrigin;
  let operatorToken: string | null = null;
  let operatorTokenHint = "";
  let operatorTokenExpiresAt: string | null = null;

  if (canUseOperator) {
    let connections = await listAgentConnections(user.id);
    let conn = connections.find((c) => c.isDefault) ?? connections[0] ?? null;
    if (!conn) {
      conn = await createAgentConnection(user.id, "Основной CRM", fallbackOrigin);
      connections = [conn];
    }
    if (conn.serverUrl) {
      // Не подменяем LAN/удалённый адрес CRM старым localhost из локальной разработки.
      operatorServerUrl =
        fallbackOrigin && !isLoopbackOriginUrl(fallbackOrigin) && isLoopbackOriginUrl(conn.serverUrl)
          ? fallbackOrigin
          : conn.serverUrl;
    }
    const tokens = await listAgentTokens(user.id, conn.id);
    const preferred = tokens.find((t) => t.name === "CRM Launcher") ?? tokens[0] ?? null;

    if (!preferred) {
      const created = await createAgentConnectionToken(user.id, conn.id, "CRM Launcher");
      operatorToken = created?.token ?? null;
      operatorTokenHint = created?.item.hint ?? "";
      operatorTokenExpiresAt = created?.item.expiresAt ?? null;
    } else if (options?.issueToken || preferred.isExpired) {
      const reissued = await reissueAgentConnectionToken(user.id, preferred.id);
      operatorToken = reissued?.token ?? null;
      operatorTokenHint = reissued?.item.hint ?? preferred.hint;
      operatorTokenExpiresAt = reissued?.item.expiresAt ?? null;
    } else {
      operatorToken = null;
      operatorTokenHint = preferred.hint;
      operatorTokenExpiresAt = preferred.expiresAt ?? null;
    }
  }

  const agentUsage = canSeeAgentUsage ? await getAgentUsage(user.id) : null;

  const rolePolicies = Object.values(AI_ROLE_POLICY).map((row) => ({
    ...row,
    roleLabel: ROLE_LABELS[row.role] ?? row.role,
  }));

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
      canViewAgentUsage: canSeeAgentUsage,
      mustChangePassword: user.mustChangePassword,
      totpEnabled: user.totpEnabled,
    },
    limits: {
      unlimited,
      perChatTokens: policy.perChatTokens,
      monthlyTokens: policy.monthlyTokens,
      monthlyUsed: aiUsage.month.total,
      allUsed: aiUsage.all.total,
      chatsCount: chats.length,
      overrideMonthlyLimit: override?.monthlyLimit ?? null,
      maxSteps: policy.maxSteps,
      rag: policy.rag,
      reasoning: policy.reasoning,
      summary: policy.summary,
    },
    rolePolicies,
    operator: {
      enabled: canUseOperator,
      serverUrl: operatorServerUrl,
      token: operatorToken,
      tokenHint: operatorTokenHint,
      expiresAt: operatorTokenExpiresAt,
    },
    ...(agentUsage ? { agentUsage } : {}),
  };
}
