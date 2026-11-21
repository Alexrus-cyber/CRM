import { addRagChunks, getRagFolder } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Сколько текста принимаем за один запрос: остальное догружается следующими. */
const MAX_BATCH_CHARS = 4_000_000;
const MAX_BATCH_ITEMS = 400;

/**
 * `POST /api/ai/rag/chunks` — догрузить файлы в папку:
 * `{ folderId, items: [{ path, chunks: string[] }] }`.
 * Ограничение только на размер одной порции — папка может быть любого размера.
 */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const unlimited = me.role === "super_admin";
  let folderId = 0;
  let items: Array<{ path: string; chunks: string[] }> = [];
  try {
    const body = (await req.json()) as { folderId?: number; items?: unknown };
    folderId = Number(body.folderId ?? 0) || 0;
    if (Array.isArray(body.items)) {
      const valid = body.items.filter((item): item is { path: string; chunks: string[] } => {
        const candidate = item as { path?: unknown; chunks?: unknown };
        return typeof candidate?.path === "string" && Array.isArray(candidate.chunks);
      });
      items = (unlimited ? valid : valid.slice(0, MAX_BATCH_ITEMS)).map((item) => ({
        path: item.path.slice(0, 1000),
        chunks: item.chunks.filter((chunk): chunk is string => typeof chunk === "string"),
      }));
    }
  } catch {
    return Response.json({ error: "Некорректный запрос" }, { status: 400 });
  }

  if (!folderId) return Response.json({ error: "Не указана папка" }, { status: 400 });
  const folder = await getRagFolder(me.id, folderId);
  if (!folder) return Response.json({ error: "Папка не найдена" }, { status: 404 });
  if (items.length === 0) return Response.json({ error: "Нет файлов для загрузки" }, { status: 400 });

  const totalChars = items.reduce((sum, item) => sum + item.chunks.reduce((inner, chunk) => inner + chunk.length, 0), 0);
  if (!unlimited && totalChars > MAX_BATCH_CHARS) {
    return Response.json(
      { error: `Слишком большая порция (${Math.round(totalChars / 1024)} КБ) — загружайте частями меньше 4 МБ текста.` },
      { status: 413 },
    );
  }

  const result = await addRagChunks(folderId, items);
  const updated = await getRagFolder(me.id, folderId);
  return Response.json({ ok: true, added: result.chunks, folder: updated });
}
