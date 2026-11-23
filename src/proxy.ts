import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "crm_session";

const PUBLIC_API_PREFIXES = [
  "/api/health",
  "/api/launcher/login",
  "/api/launcher/logout",
  "/api/auth/confirm-email",
  "/api/agent/bot/",
];

const SANDBOX_PREVIEW_PREFIXES = [
  "/api/ai/agent/sandbox/preview",
  "/api/ai/agent/sandbox/proxy",
];

const PROTECTED_PAGE_PREFIXES = [
  "/dashboard",
  "/tasks",
  "/counterparties",
  "/calendar",
  "/team",
  "/ai",
  "/profile",
];

function buildCsp(nonce: string): string {
  const isProd = process.env.NODE_ENV === "production";
  const scriptSrc = isProd
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`;

  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://api.github.com",
    "frame-src 'self' http://127.0.0.1:* http://localhost:*",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * Пограничная проверка наличия cookie/Bearer-сессии и генерация nonce-CSP.
 * Финальная проверка подлинности токена (SHA-256 + revocation + expiry) остаётся на сервере в `auth.ts`.
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/_next") || pathname === "/favicon.ico") {
    return NextResponse.next();
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce);

  const attachCsp = (res: NextResponse): NextResponse => {
    res.headers.set("Content-Security-Policy", csp);
    return res;
  };

  if (pathname.startsWith("/api/")) {
    if (PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      return attachCsp(NextResponse.next());
    }
    const hasCookie = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
    const hasAuthHeader = Boolean(req.headers.get("authorization")?.trim());
    if (!hasCookie && !hasAuthHeader) {
      return attachCsp(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    }
    // Роуты предпросмотра Sandbox отдают пользовательский HTML/JS со своей изолированной CSP.
    if (SANDBOX_PREVIEW_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      return NextResponse.next();
    }
    return attachCsp(NextResponse.next());
  }

  if (PROTECTED_PAGE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    const hasCookie = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
    if (!hasCookie) {
      const loginUrl = req.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.search = "";
      return attachCsp(NextResponse.redirect(loginUrl));
    }
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  return attachCsp(NextResponse.next({ request: { headers: requestHeaders } }));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
