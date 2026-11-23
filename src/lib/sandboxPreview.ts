/**
 * Хелперы предпросмотра проектов Sandbox и прокси локальных процессов Агента
 * (работают и локально, и при открытии CRM из локальной сети LAN).
 */

export const SANDBOX_PREVIEW_CSP = [
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: http: https:",
  "img-src * data: blob:",
  "font-src * data: blob:",
  "connect-src *",
  "frame-ancestors 'self'",
  "object-src 'none'",
].join("; ");

export function rewritePreviewCss(css: string, basePrefix: string): string {
  const cleanBase = basePrefix.replace(/\/+$/, "");
  return css.replace(
    /url\(\s*(["']?)\/(?!\/|api\/ai\/agent\/sandbox\/)([^)"']*)\1\s*\)/gi,
    (_m, q: string, rest: string) => `url(${q}${cleanBase}/${rest}${q})`,
  );
}

export function rewritePreviewHtml(
  html: string,
  basePrefix: string,
  rewriteBareRelative = false,
): string {
  const cleanBase = basePrefix.replace(/\/+$/, "");
  let out = html.replace(
    /\b(href|src|action|poster)\s*=\s*(["'])\/(?!\/|api\/ai\/agent\/sandbox\/)([^"']*)\2/gi,
    (_m, attr: string, q: string, rest: string) => `${attr}=${q}${cleanBase}/${rest}${q}`,
  );
  out = out.replace(
    /url\(\s*(["']?)\/(?!\/|api\/ai\/agent\/sandbox\/)([^)"']*)\1\s*\)/gi,
    (_m, q: string, rest: string) => `url(${q}${cleanBase}/${rest}${q})`,
  );
  if (rewriteBareRelative) {
    out = out.replace(
      /\b(href|src|action|poster)\s*=\s*(["'])(?!(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/))(?:\.\/)?([^"']*)\2/gi,
      (_m, attr: string, q: string, rest: string) => `${attr}=${q}${cleanBase}/${rest}${q}`,
    );
  }
  return out;
}

export function rewriteProxyLocation(location: string, port: number): string {
  const clean = location.trim();
  const base = `/api/ai/agent/sandbox/proxy/${port}`;
  if (clean.startsWith(base)) return clean;
  if (clean.startsWith("/")) {
    return clean.startsWith("//") ? clean : `${base}${clean}`;
  }
  try {
    const parsed = new URL(clean);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const locPort = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    if (
      (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0") &&
      locPort === port
    ) {
      return `${base}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // Относительный или нестандартный Location — оставляем как есть.
  }
  return clean;
}

export function buildPreviewHeaders(upstreamHeaders: Headers, contentType: string, isHtmlOrCss: boolean): Headers {
  const headers = new Headers();
  headers.set("Content-Type", contentType || "application/octet-stream");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", SANDBOX_PREVIEW_CSP);
  if (!isHtmlOrCss) {
    const acceptRanges = upstreamHeaders.get("accept-ranges");
    if (acceptRanges) headers.set("Accept-Ranges", acceptRanges);
    const contentRange = upstreamHeaders.get("content-range");
    if (contentRange) headers.set("Content-Range", contentRange);
  }
  return headers;
}
