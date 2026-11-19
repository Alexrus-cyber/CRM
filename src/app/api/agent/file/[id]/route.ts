import { getAgentEventFile } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

/** Файл, который вернул агент: скачивание из чата в браузере. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const file = await getAgentEventFile(Number(id) || 0);
  if (!file) return Response.json({ error: "Файл не найден" }, { status: 404 });
  if (file.userId !== me.id && me.role !== "super_admin") {
    return Response.json({ error: "Нет доступа" }, { status: 403 });
  }

  const bytes = Buffer.from(file.data, "base64");
  return new Response(bytes, {
    headers: {
      "Content-Type": file.mime || "application/octet-stream",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=600",
    },
  });
}
