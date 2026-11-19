import { getAgentTask, listAgentEvents, setAgentTaskStatus } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

/** Карточка задания: шаги журнала и метаданные файлов (без base64). */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "super_admin") return Response.json({ error: "Только главный администратор" }, { status: 403 });

  const { id } = await ctx.params;
  const task = await getAgentTask(me.id, Number(id) || 0);
  if (!task) return Response.json({ error: "Задание не найдено" }, { status: 404 });

  const events = await listAgentEvents(task.id);
  return Response.json({ task, events }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "super_admin") return Response.json({ error: "Только главный администратор" }, { status: 403 });

  const { id } = await ctx.params;
  const task = await getAgentTask(me.id, Number(id) || 0);
  if (!task) return Response.json({ error: "Задание не найдено" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { action?: string } | null;
  if (body?.action === "cancel") {
    await setAgentTaskStatus(task.id, me.id, "cancelled", "Отменено пользователем");
    return Response.json({ ok: true });
  }
  return Response.json({ error: "Неизвестное действие" }, { status: 400 });
}
