import { addAgentEvent, getAgentTask, syncOperatorTaskToConversation } from "@/db/repo";
import { botOwner } from "@/lib/agentBot";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";
import { readJsonWithByteLimit } from "@/lib/validation";

/**
 * Файл, который агент сделал на машине пользователя, — сразу в чат в браузере:
 * он попадает в журнал задания (и сохраняется на диске через `storage`),
 * а на странице ИИ появляется карточка для скачивания.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_JSON_BODY_BYTES = 4_600_000;

function sanitizeFileName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return (clean || "файл").slice(0, 120);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await botOwner(req);
  if (!ownerId) return Response.json({ error: "Неверный токен агента" }, { status: 401 });

  const rl = checkApiRateLimit({
    scope: "bot_files",
    userId: ownerId,
    ip: extractClientIp(req.headers),
    maxRequests: 40,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const { id } = await ctx.params;
  const task = await getAgentTask(ownerId, Number(id) || 0);
  if (!task) return Response.json({ error: "Задание не найдено" }, { status: 404 });

  const limited = await readJsonWithByteLimit<{
    name?: string;
    mime?: string;
    data?: string;
  }>(req, MAX_JSON_BODY_BYTES);
  if (!limited.ok) return limited.response;
  const body = limited.data;

  const name = sanitizeFileName(String(body?.name ?? "файл"));
  const mime = String(body?.mime ?? "application/octet-stream").replace(/[\r\n]/g, "").slice(0, 120) || "application/octet-stream";

  let rawData = String(body?.data ?? "").trim();
  const dataUrlMatch = rawData.match(/^data:[^;]+;base64,(.+)$/i);
  if (dataUrlMatch) rawData = dataUrlMatch[1];
  const cleanBase64 = rawData.replace(/\s+/g, "");
  if (!cleanBase64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64)) {
    return Response.json({ error: "Некорректные данные файла" }, { status: 400 });
  }

  const decoded = Buffer.from(cleanBase64, "base64");
  if (!decoded.length) return Response.json({ error: "Пустой файл" }, { status: 400 });
  if (decoded.length > MAX_BYTES) return Response.json({ error: "Файл больше 3 МБ" }, { status: 413 });

  const eventId = await addAgentEvent({
    taskId: task.id,
    kind: "file",
    text: name,
    fileName: name,
    fileMime: mime,
    fileSize: decoded.length,
    fileData: decoded.toString("base64"),
  });
  await syncOperatorTaskToConversation(ownerId, task.id, { onlyIfExisting: true });

  return Response.json({ ok: true, eventId, url: `/api/agent/file/${eventId}` });
}
