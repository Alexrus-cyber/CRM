import { confirmEmailChangeByToken, revokeAllUserSessions } from "@/db/repo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token")?.trim() ?? "";
  const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");

  const result = await confirmEmailChangeByToken(token);
  if (!result.ok) {
    if (wantsJson) {
      return Response.json({ ok: false, error: result.error }, { status: 400 });
    }
    const target = new URL("/profile", url.origin);
    target.searchParams.set("emailError", result.error);
    return Response.redirect(target, 302);
  }

  // После смены email отзываем старые сессии для защиты аккаунта.
  await revokeAllUserSessions(result.userId).catch(() => undefined);

  if (wantsJson) {
    return Response.json({ ok: true, newEmail: result.newEmail });
  }
  const target = new URL("/login", url.origin);
  target.searchParams.set("emailConfirmed", "1");
  return Response.redirect(target, 302);
}
