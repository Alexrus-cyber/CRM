import { addAgentEvent, getAgentTask, syncOperatorTaskToConversation } from "@/db/repo";
import { botOwner } from "@/lib/agentBot";

/**
 * Файл, который агент сделал на машине пользователя, — сразу в чат в браузере:
 * он попадает в журнал задания и появляется карточкой на странице ИИ.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 3 * 1024 * 1024;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await botOwner(req);
  if (!ownerId) return Response.json({ error: "Неверный токен агента" }, { status: 401 });

  const { id } = await ctx.params;
  const task = await getAgentTask(ownerId, Number(id) || 0);
  if (!task) return Response.json({ error: "Задание не найдено" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as
    | { name?: string; mime?: string; size?: number; data?: string }
    | null;

  const name = String(body?.name ?? "файл").slice(0, 120);
  const mime = String(body?.mime ?? "application/octet-stream").slice(0, 120);
  const data = String(body?.data ?? "");
  const size = Number(body?.size ?? 0) || Math.floor((data.length * 3) / 4);
  if (!data) return Response.json({ error: "Пустой файл" }, { status: 400 });
  if (size > MAX_BYTES) return Response.json({ error: "Файл больше 3 МБ" }, { status: 413 });

  const eventId = await addAgentEvent({
    taskId: task.id,
    kind: "file",
    text: name,
    fileName: name,
    fileMime: mime,
    fileSize: size,
    fileData: data,
  });
  await syncOperatorTaskToConversation(ownerId, task.id);

  return Response.json({ ok: true, eventId, url: `/api/agent/file/${eventId}` });
}
