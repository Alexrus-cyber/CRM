import { listAgentConversations, listTesterRuns } from "@/db/repo";
import { hasAgentAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Список прогонов Тестировщика и отдельных QA-чатов текущего пользователя. */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(user)) {
    return Response.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  const rawLimit = Number(new URL(req.url).searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.floor(rawLimit))) : 50;

  const [runs, conversations] = await Promise.all([
    listTesterRuns(user.id, limit),
    listAgentConversations(user.id, "tester", 200),
  ]);

  return Response.json(
    { runs, conversations },
    { headers: { "Cache-Control": "no-store" } },
  );
}
