import { getAgentTask, recordAgentUsage } from "@/db/repo";
import { botOwner } from "@/lib/agentBot";

/**
 * Учёт токенов Настольного Оператора по задаче: `POST /api/agent/bot/<id>/usage`.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await botOwner(req);
  if (!ownerId) return Response.json({ error: "Неверный токен агента" }, { status: 401 });

  const { id } = await ctx.params;
  const taskId = Number(id) || 0;
  if (taskId > 0) {
    const task = await getAgentTask(ownerId, taskId);
    if (!task) return Response.json({ error: "Задание не найдено" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        model?: string;
      }
    | null;

  const prompt = Math.max(0, Math.round(Number(body?.promptTokens ?? body?.prompt_tokens ?? 0) || 0));
  const completion = Math.max(
    0,
    Math.round(Number(body?.completionTokens ?? body?.completion_tokens ?? 0) || 0),
  );
  const total = Math.max(
    prompt + completion,
    Math.round(Number(body?.totalTokens ?? body?.total_tokens ?? 0) || 0),
  );

  if (total > 0 || prompt > 0 || completion > 0) {
    await recordAgentUsage({
      userId: ownerId,
      kind: "operator",
      refId: taskId,
      model: String(body?.model ?? "").slice(0, 160),
      prompt,
      completion,
      total,
    });
  }

  return Response.json({ ok: true });
}
