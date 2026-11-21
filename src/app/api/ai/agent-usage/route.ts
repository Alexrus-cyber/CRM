import { getAgentUsage, listUsersAgentUsage } from "@/db/repo";
import { canViewAgentUsage } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";

/**
 * Расход токенов Агента и Оператора: `GET /api/ai/agent-usage`.
 *
 * Виден ИСКЛЮЧИТЕЛЬНО главному администратору (`super_admin`).
 * Не входит в месячные лимиты обычного чата с ИИ.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!canViewAgentUsage(me)) {
    return Response.json(
      { error: "Статистика токенов Агента и Оператора видна только главному администратору" },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const rawUserId = Number(url.searchParams.get("userId") ?? 0);
  if (Number.isSafeInteger(rawUserId) && rawUserId > 0) {
    const usage = await getAgentUsage(rawUserId);
    return Response.json({ userId: rawUserId, usage }, { headers: { "Cache-Control": "no-store" } });
  }

  const [myUsage, users] = await Promise.all([getAgentUsage(me.id), listUsersAgentUsage()]);
  const totalsMonth = users.reduce(
    (acc, u) => ({
      agent: acc.agent + u.monthAgent,
      operator: acc.operator + u.monthOperator,
      total: acc.total + u.monthTotal,
    }),
    { agent: 0, operator: 0, total: 0 },
  );
  const totalsAll = users.reduce(
    (acc, u) => ({
      agent: acc.agent + u.allAgent,
      operator: acc.operator + u.allOperator,
      total: acc.total + u.allTotal,
    }),
    { agent: 0, operator: 0, total: 0 },
  );

  return Response.json(
    {
      currentMonth: myUsage.currentMonth,
      mine: myUsage,
      totals: { month: totalsMonth, all: totalsAll },
      users,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
