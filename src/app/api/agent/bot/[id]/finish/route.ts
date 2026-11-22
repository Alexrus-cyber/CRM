import { addAgentEvent, getAgentTask, setAgentTaskStatus, syncOperatorTaskToConversation } from "@/db/repo";
import { botOwner } from "@/lib/agentBot";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";
import { z } from "zod";

/** Завершение задания: строго done, failed или cancelled. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const finishStatusSchema = z.enum(["done", "failed", "cancelled"]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await botOwner(req);
  if (!ownerId) return Response.json({ error: "Неверный токен агента" }, { status: 401 });

  const rl = checkApiRateLimit({
    scope: "bot_finish",
    userId: ownerId,
    ip: extractClientIp(req.headers),
    maxRequests: 60,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const { id } = await ctx.params;
  const task = await getAgentTask(ownerId, Number(id) || 0);
  if (!task) return Response.json({ error: "Задание не найдено" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { status?: string; summary?: string } | null;
  let status: "done" | "failed" | "cancelled" = "done";
  if (body?.status !== undefined && body?.status !== null && String(body.status).trim() !== "") {
    const parsed = finishStatusSchema.safeParse(String(body.status).trim());
    if (!parsed.success) {
      return Response.json({ error: "Допустимые статусы завершения: done, failed, cancelled" }, { status: 400 });
    }
    status = parsed.data;
  }

  // Отменённое задание нельзя «завершить» как failed: пользователь уже нажал
  // «Остановить», и бот должен просто выйти, а не переписывать статус.
  if (task.status === "cancelled" && status !== "cancelled") {
    return Response.json(
      { ok: false, cancelled: true, error: "Задание отменено пользователем" },
      { status: 409 },
    );
  }
  const summary = String(body?.summary ?? "").slice(0, 4000);

  await setAgentTaskStatus(task.id, ownerId, status, summary);
  await addAgentEvent({ taskId: task.id, kind: "info", text: summary || `Задание завершено: ${status}` });
  const conversationId = await syncOperatorTaskToConversation(ownerId, task.id, { onlyIfExisting: true });
  return Response.json({ ok: true, conversationId });
}
