import {
  createAgentConnection,
  createAgentConnectionToken,
  getAgentToken,
  listAgentConnections,
} from "@/db/repo";
import { hasOperatorAccess } from "@/lib/aiPolicy";
import { getCurrentUser, resolveRequestOrigin } from "@/lib/auth";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";

/**
 * Устаревший одиночный токен бота (`/api/agent/token`).
 *
 * Оставлен для совместимости: полный токен отдаётся ТОЛЬКО при создании (`POST`),
 * `GET` возвращает только маскированную подсказку (`token_hint`, P0-2).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasOperatorAccess(me)) {
    return Response.json({ error: "Доступ к Оператору не выдан главным администратором" }, { status: 403 });
  }

  const hint = await getAgentToken(me.id);
  return Response.json(
    { exists: Boolean(hint), hint },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasOperatorAccess(me)) {
    return Response.json({ error: "Доступ к Оператору не выдан главным администратором" }, { status: 403 });
  }

  const rl = checkApiRateLimit({
    scope: "agent_token_issue",
    userId: me.id,
    ip: extractClientIp(req.headers),
    maxRequests: 20,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const conns = await listAgentConnections(me.id);
  const targetConn =
    conns.find((c) => c.isDefault) ??
    conns[0] ??
    (await createAgentConnection(me.id, "Основной CRM", resolveRequestOrigin(req)));

  const created = await createAgentConnectionToken(me.id, targetConn.id, "Основной токен");
  if (!created) {
    return Response.json({ error: "Не удалось создать токен" }, { status: 500 });
  }
  return Response.json(
    { token: created.token, item: created.item },
    { headers: { "Cache-Control": "no-store" } },
  );
}
