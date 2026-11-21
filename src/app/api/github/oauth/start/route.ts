import { randomBytes } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { hasAgentAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me)) {
    return NextResponse.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  const clientId = process.env.GITHUB_CLIENT_ID || "";
  const clientSecret = process.env.GITHUB_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) {
    return NextResponse.json(
      {
        error:
          "GitHub OAuth на сервере не настроен (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET). Используйте вход по Personal Access Token.",
      },
      { status: 501 },
    );
  }

  const state = randomBytes(24).toString("hex");
  const jar = await cookies();
  jar.set("crm_gh_oauth_state", `${me.id}:${state}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  const url = new URL(req.url);
  const redirectUri =
    process.env.GITHUB_OAUTH_REDIRECT_URI || `${url.origin}/api/github/oauth/callback`;
  const authUrl = new URL("https://github.com/login/oauth/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "repo read:user user:email");
  authUrl.searchParams.set("state", state);

  return NextResponse.redirect(authUrl.toString());
}
