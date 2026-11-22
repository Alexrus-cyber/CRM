import { findUserAuthByEmail, getUser } from "@/db/repo";
import { createLauncherSession, ensureSuperAdmin, verifyPassword } from "@/lib/auth";
import { buildLauncherProfile } from "@/lib/launcherProfile";
import {
  checkLoginRateLimit,
  clearLoginFailures,
  extractClientIp,
  recordLoginFailure,
} from "@/lib/rateLimit";
import { launcherLoginSchema, readValidatedJson } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  await ensureSuperAdmin();

  const parsed = await readValidatedJson(req, launcherLoginSchema, "Введите email и пароль");
  if (!parsed.ok) return parsed.response;

  const email = parsed.data.email.trim().toLowerCase();
  const password = parsed.data.password;
  const ip = extractClientIp(req.headers);
  const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 300);

  const limit = checkLoginRateLimit(ip, email);
  if (!limit.allowed) {
    return Response.json(
      { ok: false, error: `Слишком много попыток входа. Повторите через ${limit.retryAfterSec} сек.` },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSec), "Cache-Control": "no-store" },
      },
    );
  }

  const authRow = await findUserAuthByEmail(email);
  if (!authRow || !verifyPassword(password, authRow.passwordHash)) {
    recordLoginFailure(ip, email);
    return Response.json({ ok: false, error: "Неверный email или пароль" }, { status: 401 });
  }

  const user = await getUser(authRow.id);
  if (!user || user.isBot) {
    return Response.json({ ok: false, error: "Аккаунт недоступен" }, { status: 403 });
  }

  clearLoginFailures(ip, email);

  const origin =
    typeof parsed.data.serverUrl === "string" && /^https?:\/\//i.test(parsed.data.serverUrl.trim())
      ? parsed.data.serverUrl.trim().replace(/\/+$/, "")
      : new URL(req.url).origin;

  const [session, profile] = await Promise.all([
    createLauncherSession(user.id, { label: "Десктоп-лаунчер", userAgent, ip }),
    buildLauncherProfile(user, origin),
  ]);

  return Response.json(
    {
      ...profile,
      sessionToken: session.token,
      expiresAt: session.expiresAt,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
