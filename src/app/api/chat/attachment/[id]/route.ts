import { getMessageAttachment } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

/**
 * Отдача вложения. Доступ: автор, адресат или участник общего чата.
 * Картинки отдаём inline (показываются в сообщении), остальное — на скачивание.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const file = await getMessageAttachment(Number(id) || 0);
  if (!file) return Response.json({ error: "Файл не найден" }, { status: 404 });

  const isGeneral = file.recipientId === null;
  const allowed = isGeneral || file.senderId === me.id || file.recipientId === me.id;
  if (!allowed) return Response.json({ error: "Нет доступа" }, { status: 403 });

  const bytes = Buffer.from(file.data, "base64");
  const inline = INLINE_IMAGE_TYPES.has(file.mime);
  return new Response(bytes, {
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
