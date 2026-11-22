import { z } from "zod";
import { getPasswordHash, getUserTotpSecret, revokeOtherSessions, setUserTotp } from "@/db/repo";
import { getCurrentSessionToken, getRequestUser, verifyPasswordAsync } from "@/lib/auth";
import { buildOtpAuthUri, generateTotpSecret, verifyTotpCode } from "@/lib/totp";
import { readValidatedJson } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const totpActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("setup") }),
  z.object({
    action: z.literal("enable"),
    code: z.string().trim().regex(/^\d{6}$/, "Введите 6-значный код из приложения"),
    currentPassword: z.string().min(1, "Введите текущий пароль"),
  }),
  z.object({
    action: z.literal("disable"),
    code: z.string().trim().regex(/^\d{6}$/, "Введите 6-значный код из приложения"),
    currentPassword: z.string().min(1, "Введите текущий пароль"),
  }),
]);

export async function GET(req: Request) {
  const me = await getRequestUser(req);
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ enabled: me.totpEnabled }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const me = await getRequestUser(req);
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readValidatedJson(req, totpActionSchema, "Некорректный запрос 2FA");
  if (!parsed.ok) return parsed.response;

  if (parsed.data.action === "setup") {
    const secret = generateTotpSecret(20);
    await setUserTotp(me.id, { secret, enabled: false });
    return Response.json(
      {
        ok: true,
        secret,
        otpauthUri: buildOtpAuthUri(me.email, secret),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const storedHash = await getPasswordHash(me.id);
  if (!storedHash || !(await verifyPasswordAsync(parsed.data.currentPassword, storedHash))) {
    return Response.json({ error: "Неверный текущий пароль" }, { status: 403 });
  }

  const current = await getUserTotpSecret(me.id);
  if (!current.secret || !verifyTotpCode(current.secret, parsed.data.code)) {
    return Response.json({ error: "Неверный 6-значный код TOTP" }, { status: 400 });
  }

  if (parsed.data.action === "enable") {
    await setUserTotp(me.id, { enabled: true });
    const sessionToken = await getCurrentSessionToken();
    if (sessionToken) await revokeOtherSessions(me.id, sessionToken);
    return Response.json({ ok: true, enabled: true });
  }

  await setUserTotp(me.id, { secret: "", enabled: false });
  return Response.json({ ok: true, enabled: false });
}
