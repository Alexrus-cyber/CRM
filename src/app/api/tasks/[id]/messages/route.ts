import {
  deleteTaskMessage,
  getTaskAccess,
  getTaskMessageAuthor,
  insertTaskMessage,
  listTaskMessages,
  TASK_MESSAGE_MAX,
} from "@/db/repo";
import { getCurrentUser, type SafeUser } from "@/lib/auth";
import { publishLiveEvent } from "@/lib/events";
import { canManageData } from "@/lib/utils";

/**
 * Быстрая переписка по задаче.
 *
 * Доступ: автор задачи, исполнитель и те, кто управляет рабочими данными
 * (главный админ, админ, менеджер) — ровно те, кто и так видит задачу.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_TEXT = 2000;

async function access(user: SafeUser, taskId: number) {
  const task = await getTaskAccess(taskId);
  if (!task) return { error: "Задача не найдена", status: 404 as const, task: null };
  const allowed = canManageData(user.role) || task.authorId === user.id || task.assigneeId === user.id;
  if (!allowed) return { error: "Нет доступа к задаче", status: 403 as const, task: null };
  return { error: null, status: 200 as const, task };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const taskId = Number(id) || 0;
  const check = await access(me, taskId);
  if (check.error) return Response.json({ error: check.error }, { status: check.status });

  const messages = await listTaskMessages(taskId);
  return Response.json({ messages }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const taskId = Number(id) || 0;
  const check = await access(me, taskId);
  if (check.error) return Response.json({ error: check.error }, { status: check.status });

  const body = (await req.json().catch(() => null)) as { content?: string } | null;
  const content = (body?.content ?? "").trim();
  if (!content) return Response.json({ error: "Пустое сообщение" }, { status: 400 });
  if (content.length > MAX_TEXT) return Response.json({ error: "Слишком длинное сообщение" }, { status: 400 });

  const count = (await listTaskMessages(taskId, TASK_MESSAGE_MAX + 1)).length;
  if (count >= TASK_MESSAGE_MAX) {
    return Response.json(
      { error: `В переписке уже ${TASK_MESSAGE_MAX} сообщений. Удалите лишние, чтобы продолжить.` },
      { status: 400 },
    );
  }

  const messageId = await insertTaskMessage(taskId, me.id, content);
  publishLiveEvent("tasks", me.id);

  return Response.json({
    message: {
      id: messageId,
      taskId,
      authorId: me.id,
      authorName: me.name,
      authorColor: me.avatarColor,
      authorAvatar: me.avatarUrl,
      content,
      createdAt: new Date().toISOString(),
    },
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const taskId = Number(id) || 0;
  const check = await access(me, taskId);
  if (check.error) return Response.json({ error: check.error }, { status: check.status });

  const messageId = Number(new URL(req.url).searchParams.get("messageId") ?? 0) || 0;
  const row = await getTaskMessageAuthor(messageId);
  if (!row || row.taskId !== taskId) {
    return Response.json({ error: "Сообщение не найдено" }, { status: 404 });
  }
  if (row.authorId !== me.id && !canManageData(me.role)) {
    return Response.json({ error: "Можно удалять только свои сообщения" }, { status: 403 });
  }

  await deleteTaskMessage(messageId);
  publishLiveEvent("tasks", me.id);
  return Response.json({ ok: true });
}
