import { randomBytes } from "node:crypto";
import { getAgentToken, saveAgentToken } from "@/db/repo";
import { hasOperatorAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";

/**
 * Устаревший одиночный токен бота (`/api/agent/token`).
 *
 * Оставлен для совместимости: интерфейс больше его не использует — в CRM есть
 * подключения (`/api/agent/connections`) и список токенов на каждое
 * (`/api/agent/tokens`). Старые токены из `agent_tokens` при миграции
 * переносятся в подключение «Основной CRM», поэтому боты продолжают работать.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasOperatorAccess(me)) return Response.json({ error: "Доступ к Оператору не выдан главным администратором" }, { status: 403 });

  const token = await getAgentToken(me.id);
  return Response.json(
    { exists: Boolean(token), hint: token ? `…${token.slice(-6)}` : null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasOperatorAccess(me)) return Response.json({ error: "Доступ к Оператору не выдан главным администратором" }, { status: 403 });

  const token = `crmop_${randomBytes(24).toString("hex")}`;
  await saveAgentToken(me.id, token);
  return Response.json({ token });
}
