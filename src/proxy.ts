import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "crm_session";

const PUBLIC_API_PREFIXES = [
  "/api/health",
  "/api/launcher/login",
  "/api/launcher/logout",
  "/api/agent/bot/",
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

/**
 * Пограничная проверка наличия cookie/Bearer-сессии до рендера страниц и обработчиков API.
 * Финальная проверка подлинности токена (SHA-256 + revocation + expiry) остаётся на сервере в `auth.ts`.
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/_next") || pathname === "/favicon.ico") {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    if (PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      return NextResponse.next();
    }
    const hasCookie = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
    const hasAuthHeader = Boolean(req.headers.get("authorization")?.trim());
    if (!hasCookie && !hasAuthHeader) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (PROTECTED_PAGE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    const hasCookie = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
    if (!hasCookie) {
      const loginUrl = req.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.search = "";
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
