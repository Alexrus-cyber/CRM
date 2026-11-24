import { cancelSubagentRun, getSubagentRun } from "@/db/repo";
import { hasAgentAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function parseId(params: Promise<{ id: string }>): Promise<number> {
  const id = Number((await params).id);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

/**
 * Остановка запуска субагента пользователем: `running` -> `cancelled`.
 * Нужна, чтобы «зависший» запуск (обрыв SSE/закрытая вкладка) можно было закрыть из UI.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(user)) {
    return Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 });
  }

  const rl = checkApiRateLimit({
    scope: "agent_subagents_runs",
    userId: user.id,
    ip: extractClientIp(req.headers),
    maxRequests: 60,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const id = await parseId(params);
  if (!id) return Response.json({ error: "Некорректный ID запуска" }, { status: 400 });

  const existing = await getSubagentRun(user.id, id);
  if (!existing) return Response.json({ error: "Запуск не найден" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { reason?: string } | null;
  const reason =
    typeof body?.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 500)
      : "Запуск остановлен пользователем";

  const run = await cancelSubagentRun(user.id, id, reason);
  return Response.json(
    { ok: true, run, alreadyFinished: existing.status !== "running" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
