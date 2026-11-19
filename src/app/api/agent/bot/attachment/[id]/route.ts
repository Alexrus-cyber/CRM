import { getAgentEventFile } from "@/db/repo";
import { botOwner } from "@/lib/agentBot";

/**
 * Скачивание файла задания ботом: `GET /api/agent/bot/attachment/<eventId>`.
 *
 * Вложения прикрепляет пользователь во вкладке «Оператор»; бот читает их
 * до первого шага и учитывает в плане действий.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await botOwner(req);
  if (!ownerId) return Response.json({ error: "Неверный токен агента" }, { status: 401 });

  const { id } = await ctx.params;
  const file = await getAgentEventFile(Number(id) || 0);
  if (!file) return Response.json({ error: "Файл не найден" }, { status: 404 });
  if (file.userId !== ownerId) return Response.json({ error: "Нет доступа" }, { status: 403 });

  const bytes = Buffer.from(file.data, "base64");
  return new Response(bytes, {
    headers: {
      "Content-Type": file.mime || "application/octet-stream",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
