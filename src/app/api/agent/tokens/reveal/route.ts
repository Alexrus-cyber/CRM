import { revealAgentToken } from "@/db/repo";
import { hasOperatorAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";

/**
 * `POST /api/agent/tokens/reveal` — `{ id }` → полный токен.
 *
 * Нужен кнопке «Показать»: в списке токен всегда маскируется, полное значение
 * приходит только по явному запросу и только владельцу.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasOperatorAccess(me)) return Response.json({ error: "Доступ к Оператору не выдан главным администратором" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { id?: number } | null;
  const id = Number(body?.id ?? 0) || 0;
  if (!id) return Response.json({ error: "Не указан токен" }, { status: 400 });

  const token = await revealAgentToken(me.id, id);
  if (!token) return Response.json({ error: "Токен не найден" }, { status: 404 });
  return Response.json({ token }, { headers: { "Cache-Control": "no-store" } });
}
