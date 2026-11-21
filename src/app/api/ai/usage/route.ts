import { getCurrentUser } from "@/lib/auth";
import { getAiQuotaOverride, getAiUsage, listAiChats } from "@/db/repo";
import { aiPolicyFor } from "@/lib/aiPolicy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/ai/usage` — счётчики токенов аккаунта и лимиты роли. */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const [usage, override, chats] = await Promise.all([
    getAiUsage(me.id),
    getAiQuotaOverride(me.id),
    listAiChats(me.id, 200),
  ]);
  const policy = aiPolicyFor(me.role, override?.monthlyLimit ?? null);
  const monthlyLimit = policy.monthlyTokens;
  const monthlyLeft = monthlyLimit === null ? null : Math.max(monthlyLimit - usage.month.total, 0);

  return Response.json({
    role: me.role,
    policy: {
      role: policy.role,
      perChatTokens: policy.perChatTokens,
      monthlyTokens: monthlyLimit,
      maxSteps: policy.maxSteps,
      rag: policy.rag,
      reasoning: policy.reasoning,
      summary: policy.summary,
      chatsUnlimited: policy.chatsUnlimited,
    },
    month: usage.month,
    monthKey: override?.month ?? undefined,
    override: override?.monthlyLimit ?? null,
    totals: usage.all,
    monthly: { used: usage.month.total, limit: monthlyLimit, left: monthlyLeft },
    chats: { count: chats.length },
  });
}
