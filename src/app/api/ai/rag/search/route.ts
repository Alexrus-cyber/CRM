import { getRagFolder, searchRagChunks } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `POST /api/ai/rag/search` — `{ folderId, query, limit }` → найденные фрагменты. */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const rl = checkApiRateLimit({
    scope: "rag_search",
    userId: me.id,
    ip: extractClientIp(req.headers),
    maxRequests: 120,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  let folderId = 0;
  let query = "";
  let limit = 6;
  try {
    const body = (await req.json()) as { folderId?: number; query?: string; limit?: number };
    folderId = Number(body.folderId ?? 0) || 0;
    query = (body.query ?? "").toString().slice(0, 2000);
    limit = Math.min(Math.max(Number(body.limit ?? 6) || 6, 1), 30);
  } catch {
    return Response.json({ error: "Некорректный запрос" }, { status: 400 });
  }

  if (!folderId) return Response.json({ error: "Не указана папка" }, { status: 400 });
  const folder = await getRagFolder(me.id, folderId);
  if (!folder) return Response.json({ error: "Папка не найдена" }, { status: 404 });
  if (!query.trim()) return Response.json({ hits: [] });

  const hits = await searchRagChunks(folderId, query, limit);
  return Response.json({ hits, folder });
}
