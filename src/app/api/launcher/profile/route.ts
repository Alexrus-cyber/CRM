import { getRequestUser } from "@/lib/auth";
import { buildLauncherProfile } from "@/lib/launcherProfile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await getRequestUser(req);
  if (!user) {
    return Response.json({ ok: false, error: "Сессия недействительна или истекла" }, { status: 401 });
  }
  const origin = new URL(req.url).origin;
  const profile = await buildLauncherProfile(user, origin);
  return Response.json(profile, { headers: { "Cache-Control": "no-store" } });
}
