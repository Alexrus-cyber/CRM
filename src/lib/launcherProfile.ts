import {
  createAgentConnection,
  createAgentConnectionToken,
  getAgentUsage,
  getAiQuotaOverride,
  getAiUsage,
  listAgentConnections,
  listAgentTokens,
  reissueAgentConnectionToken,
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
      mustChangePassword: user.mustChangePassword,
      totpEnabled: user.totpEnabled,
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
      tokenHint: operatorTokenHint,
      expiresAt: operatorTokenExpiresAt,
    },
    ...(agentUsage ? { agentUsage } : {}),
  };
}
