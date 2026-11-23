import { getRequestUser, resolveRequestOrigin } from "@/lib/auth";
import { buildLauncherProfile } from "@/lib/launcherProfile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await getRequestUser(req);
  if (!user) {
    return Response.json({ ok: false, error: "Сессия недействительна или истекла" }, { status: 401 });
  }
  const url = new URL(req.url);
  const issueToken = url.searchParams.get("reissue") === "1";
  const profile = await buildLauncherProfile(user, resolveRequestOrigin(req), { issueToken });
  return Response.json(profile, { headers: { "Cache-Control": "no-store" } });
}
