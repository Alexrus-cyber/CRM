import { findUserAuthByEmail, getUser } from "@/db/repo";
import { createLauncherSession, ensureSuperAdmin, verifyPassword } from "@/lib/auth";
import { buildLauncherProfile } from "@/lib/launcherProfile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  await ensureSuperAdmin();

  const body = (await req.json().catch(() => null)) as
    | { email?: string; password?: string; serverUrl?: string }
    | null;

  const email = String(body?.email ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");

  if (!email || !password) {
    return Response.json({ ok: false, error: "Введите email и пароль" }, { status: 400 });
  }

  const authRow = await findUserAuthByEmail(email);
  if (!authRow || !verifyPassword(password, authRow.passwordHash)) {
    return Response.json({ ok: false, error: "Неверный email или пароль" }, { status: 401 });
  }

  const user = await getUser(authRow.id);
  if (!user || user.isBot) {
    return Response.json({ ok: false, error: "Аккаунт недоступен" }, { status: 403 });
  }

  const origin =
    typeof body?.serverUrl === "string" && /^https?:\/\//i.test(body.serverUrl.trim())
      ? body.serverUrl.trim().replace(/\/+$/, "")
      : new URL(req.url).origin;

  const [session, profile] = await Promise.all([
    createLauncherSession(user.id),
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
