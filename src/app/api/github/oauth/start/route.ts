import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { hasAgentAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me)) {
    return NextResponse.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  const rl = checkApiRateLimit({
    scope: "github_oauth_start",
    userId: me.id,
    ip: extractClientIp(req.headers),
    maxRequests: 20,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

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

  const url = new URL(req.url);
  const redirectUri =
    process.env.GITHUB_OAUTH_REDIRECT_URI || `${url.origin}/api/github/oauth/callback`;
  const state = randomBytes(24).toString("hex");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  const encryptedState = encryptSecret(
    JSON.stringify({
      userId: me.id,
      state,
      codeVerifier,
      redirectUri,
      exp: Date.now() + 600_000,
    }),
  );

  const jar = await cookies();
  jar.set("crm_gh_oauth_state", encryptedState, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  const allowPrivate = url.searchParams.get("private") === "1" || url.searchParams.get("scope") === "repo";
  const scope =
    process.env.GITHUB_OAUTH_SCOPE?.trim() ||
    (allowPrivate ? "repo read:user user:email" : "public_repo read:user user:email");

  const authUrl = new URL("https://github.com/login/oauth/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return NextResponse.redirect(authUrl.toString());
}
