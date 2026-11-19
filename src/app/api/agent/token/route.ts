import { randomBytes } from "node:crypto";
import { getAgentToken, saveAgentToken } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

/**
 * Токен бота-оператора. Показывать сам токен повторно нельзя — хранится он
 * в базе в открытом виде только для сверки, поэтому в интерфейсе он виден один
 * раз при создании, дальше показываем лишь наличие и маску.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function guard(role: string): boolean {
  return role === "super_admin";
}

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!guard(me.role)) return Response.json({ error: "Только главный администратор" }, { status: 403 });

  const token = await getAgentToken(me.id);
  return Response.json(
    { exists: Boolean(token), hint: token ? `…${token.slice(-6)}` : null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!guard(me.role)) return Response.json({ error: "Только главный администратор" }, { status: 403 });

  const token = `crmop_${randomBytes(24).toString("hex")}`;
  await saveAgentToken(me.id, token);
  return Response.json({ token });
}
