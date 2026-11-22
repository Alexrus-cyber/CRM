import {
  createAgentConnectionToken,
  deleteAgentConnectionToken,
  getAgentConnection,
  listAgentTokens,
  reissueAgentConnectionToken,
} from "@/db/repo";
import { hasOperatorAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";

/**
 * Токены подключения. Их может быть несколько (по одному на машину);
 * полный токен отдаётся единоразово при создании или перевыпуске (`reissue`),
 * после чего в БД хранится только SHA-256 хеш и маска `token_hint` (P0-2).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_NAME = 60;

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasOperatorAccess(me)) {
    return Response.json({ error: "Доступ к Оператору не выдан главным администратором" }, { status: 403 });
  }

  const connectionId = Number(new URL(req.url).searchParams.get("connectionId") ?? 0) || 0;
  if (!connectionId) return Response.json({ error: "Не указано подключение" }, { status: 400 });

  const connection = await getAgentConnection(me.id, connectionId);
  if (!connection) return Response.json({ error: "Подключение не найдено" }, { status: 404 });

  const tokens = await listAgentTokens(me.id, connectionId);
  return Response.json({ tokens, connection }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasOperatorAccess(me)) {
    return Response.json({ error: "Доступ к Оператору не выдан главным администратором" }, { status: 403 });
  }

  const rl = checkApiRateLimit({
    scope: "agent_tokens_write",
    userId: me.id,
    ip: extractClientIp(req.headers),
    maxRequests: 30,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const body = (await req.json().catch(() => null)) as
    | { action?: string; id?: number; connectionId?: number; name?: string }
    | null;

  if (body?.action === "reissue") {
    const id = Number(body.id ?? 0) || 0;
    if (!id) return Response.json({ error: "Не указан токен для перевыпуска" }, { status: 400 });
    const reissued = await reissueAgentConnectionToken(me.id, id);
    if (!reissued) return Response.json({ error: "Токен не найден" }, { status: 404 });
    return Response.json(reissued, { headers: { "Cache-Control": "no-store" } });
  }

  const connectionId = Number(body?.connectionId ?? 0) || 0;
  if (!connectionId) return Response.json({ error: "Не указано подключение" }, { status: 400 });
  const name = String(body?.name ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME) || "Без названия";

  const created = await createAgentConnectionToken(me.id, connectionId, name);
  if (!created) return Response.json({ error: "Подключение не найдено" }, { status: 404 });
  return Response.json(created, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasOperatorAccess(me)) {
    return Response.json({ error: "Доступ к Оператору не выдан главным администратором" }, { status: 403 });
  }

  const id = Number(new URL(req.url).searchParams.get("id") ?? 0) || 0;
  if (!id) return Response.json({ error: "Не указан токен" }, { status: 400 });

  const ok = await deleteAgentConnectionToken(me.id, id);
  if (!ok) return Response.json({ error: "Токен не найден" }, { status: 404 });
  return Response.json({ ok: true });
}
