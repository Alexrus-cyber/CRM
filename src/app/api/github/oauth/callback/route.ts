import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { upsertGithubConnection } from "@/db/repo";
import { hasAgentAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import { decryptSecret, safeEqualText } from "@/lib/crypto";
import { fetchGithubUser } from "@/lib/github";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

type EncryptedOAuthState = {
  userId?: number;
  state?: string;
  codeVerifier?: string;
  redirectUri?: string;
  exp?: number;
};

export async function GET(req: Request) {
  const me = await getCurrentUser();
  const url = new URL(req.url);
  const baseRedirect = `${url.origin}/ai?tab=agent`;

  if (!me || !hasAgentAccess(me)) {
    return NextResponse.redirect(`${baseRedirect}&gh_error=forbidden`);
  }

  const rl = checkApiRateLimit({
    scope: "github_oauth_callback",
    userId: me.id,
    ip: extractClientIp(req.headers),
    maxRequests: 20,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const clientId = process.env.GITHUB_CLIENT_ID || "";
  const clientSecret = process.env.GITHUB_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(`${baseRedirect}&gh_error=oauth_not_configured`);
  }

  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const jar = await cookies();
  const rawCookie = jar.get("crm_gh_oauth_state")?.value || "";
  jar.delete("crm_gh_oauth_state");

  let parsedState: EncryptedOAuthState | null = null;
  if (rawCookie) {
    try {
      const decrypted = decryptSecret(rawCookie);
      if (decrypted) {
        parsedState = JSON.parse(decrypted) as EncryptedOAuthState;
      }
    } catch {
      parsedState = null;
    }
  }

  const savedUserId = Number(parsedState?.userId ?? 0);
  const savedState = String(parsedState?.state ?? "");
  const codeVerifier = String(parsedState?.codeVerifier ?? "");
  const redirectUri = String(parsedState?.redirectUri ?? `${url.origin}/api/github/oauth/callback`);
  const exp = Number(parsedState?.exp ?? 0);

  if (
    !code ||
    !state ||
    !savedState ||
    !codeVerifier ||
    !exp ||
    Date.now() > exp ||
    savedUserId !== me.id ||
    !safeEqualText(savedState, state)
  ) {
    return NextResponse.redirect(`${baseRedirect}&gh_error=invalid_state`);
  }

  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const tokenJson = (await tokenRes.json().catch(() => ({}))) as {
      access_token?: string;
      scope?: string;
      error_description?: string;
    };
    const accessToken = String(tokenJson.access_token || "").trim();
    if (!accessToken) {
      return NextResponse.redirect(`${baseRedirect}&gh_error=token_exchange_failed`);
    }

    const profile = await fetchGithubUser(accessToken);
    await upsertGithubConnection({
      userId: me.id,
      githubUserId: profile.githubUserId,
      login: profile.login,
      name: profile.name,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
      token: accessToken,
      scopes: profile.scopes || tokenJson.scope || "",
      enabled: true,
    });

    return NextResponse.redirect(`${baseRedirect}&gh_connected=1`);
  } catch {
    return NextResponse.redirect(`${baseRedirect}&gh_error=oauth_failed`);
  }
}
