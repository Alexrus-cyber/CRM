import { getCurrentUser } from "@/lib/auth";
import { createRagFolder, deleteRagFolder, listRagFolders } from "@/db/repo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/ai/rag` — папки текущего пользователя. */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const folders = await listRagFolders(me.id);
  return Response.json({ folders });
}

/** `POST /api/ai/rag` — создать папку: `{ name }` → `{ folder }`. */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let name = "";
  try {
    const body = (await req.json()) as { name?: string };
    name = (body.name ?? "").trim().slice(0, 120);
  } catch {
    return Response.json({ error: "Некорректный запрос" }, { status: 400 });
  }
  if (!name) return Response.json({ error: "Укажите имя папки" }, { status: 400 });

  const folder = await createRagFolder(me.id, name);
  return Response.json({ folder });
}

/** `DELETE /api/ai/rag?id=1` — удалить папку вместе с фрагментами. */
export async function DELETE(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const id = Number(new URL(req.url).searchParams.get("id") ?? 0);
  if (!id) return Response.json({ error: "Не указана папка" }, { status: 400 });
  const ok = await deleteRagFolder(me.id, id);
  if (!ok) return Response.json({ error: "Папка не найдена" }, { status: 404 });
  return Response.json({ ok: true });
}
