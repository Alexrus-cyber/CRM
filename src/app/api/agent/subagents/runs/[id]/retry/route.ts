import { getSubagentRun, retrySubagentRun } from "@/db/repo";
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
 * Повтор задачи субагента: закрывает предыдущий запуск и создаёт новый в том же
 * изолированном чате с тем же контекстом (input_summary). Модель не вызывается —
 * UI получает новый run и может отправить ход заново.
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

  try {
    const created = await retrySubagentRun(user.id, id);
    if (!created) return Response.json({ error: "Запуск не найден" }, { status: 404 });
    return Response.json(
      {
        ok: true,
        run: created.run,
        conversation: created.conversation,
        previousRunId: id,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Не удалось перезапустить задачу" },
      { status: 400 },
    );
  }
}
