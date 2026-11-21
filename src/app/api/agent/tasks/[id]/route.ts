import {
  extendAgentTaskSteps,
  findOperatorTaskConversation,
  getAgentTask,
  getLatestAgentScreen,
  listAgentEvents,
  respondAgentTaskApproval,
  setAgentTaskGuidance,
  setAgentTaskStatus,
  syncOperatorTaskToConversation,
} from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

/** Карточка задания: шаги журнала и управление (отмена, подтверждение, расширение шагов). */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "super_admin") return Response.json({ error: "Только главный администратор" }, { status: 403 });

  const { id } = await ctx.params;
  const task = await getAgentTask(me.id, Number(id) || 0);
  if (!task) return Response.json({ error: "Задание не найдено" }, { status: 404 });

  const [events, latestScreen, existingConv] = await Promise.all([
    listAgentEvents(task.id, 10_000),
    getLatestAgentScreen(task.id),
    findOperatorTaskConversation(me.id, task.id),
  ]);
  const conversationId =
    existingConv?.id ??
    (events.length > 0 || task.status !== "queued"
      ? await syncOperatorTaskToConversation(me.id, task.id)
      : null);
  return Response.json(
    { task, events, latestScreen, conversationId },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "super_admin") return Response.json({ error: "Только главный администратор" }, { status: 403 });

  const { id } = await ctx.params;
  const task = await getAgentTask(me.id, Number(id) || 0);
  if (!task) return Response.json({ error: "Задание не найдено" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as
    | {
        action?: string;
        approvalId?: string;
        note?: string;
        addSteps?: number;
        text?: string;
        author?: string;
      }
    | null;

  if (body?.action === "cancel") {
    await setAgentTaskStatus(task.id, me.id, "cancelled", "Отменено пользователем");
    await syncOperatorTaskToConversation(me.id, task.id);
    return Response.json({ ok: true });
  }

  if (body?.action === "approve") {
    const updated = await respondAgentTaskApproval(task.id, me.id, {
      approvalId: typeof body.approvalId === "string" ? body.approvalId : undefined,
      decision: "approved",
      note: typeof body.note === "string" ? body.note : undefined,
    });
    if (!updated) return Response.json({ error: "Задание уже завершено или отменено" }, { status: 409 });
    await syncOperatorTaskToConversation(me.id, task.id);
    return Response.json({ ok: true, task: updated });
  }

  if (body?.action === "reject") {
    const updated = await respondAgentTaskApproval(task.id, me.id, {
      approvalId: typeof body.approvalId === "string" ? body.approvalId : undefined,
      decision: "rejected",
      note: typeof body.note === "string" ? body.note : undefined,
    });
    if (!updated) return Response.json({ error: "Задание уже завершено или отменено" }, { status: 409 });
    await syncOperatorTaskToConversation(me.id, task.id);
    return Response.json({ ok: true, task: updated });
  }

  if (body?.action === "extend_steps") {
    const addSteps = Math.max(1, Number(body.addSteps ?? 15) || 15);
    const updated = await extendAgentTaskSteps(task.id, me.id, addSteps);
    if (!updated) return Response.json({ error: "Нельзя расширить лимит завершённой задачи" }, { status: 409 });
    await syncOperatorTaskToConversation(me.id, task.id);
    return Response.json({ ok: true, task: updated });
  }

  if (body?.action === "guidance") {
    const text = String(body.text ?? "").trim();
    if (!text) return Response.json({ error: "Укажите подсказку для Оператора" }, { status: 400 });
    const author = body.author === "agent" ? "agent" : "user";
    const result = await setAgentTaskGuidance(task.id, me.id, { author, text });
    if (!result) {
      return Response.json({ error: "Задача уже завершена или отменена" }, { status: 409 });
    }
    const conversationId = await syncOperatorTaskToConversation(me.id, task.id);
    return Response.json({ ok: true, task: result.task, guidance: result.guidance, conversationId });
  }

  return Response.json({ error: "Неизвестное действие" }, { status: 400 });
}
