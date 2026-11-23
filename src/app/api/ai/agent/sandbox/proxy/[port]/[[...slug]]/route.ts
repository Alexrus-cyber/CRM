import { fetchAgent, resolveSafeAgentUrl } from "@/lib/agentConfig";
import { hasAgentAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import {
  buildPreviewHeaders,
  rewritePreviewCss,
  rewritePreviewHtml,
  rewriteProxyLocation,
} from "@/lib/sandboxPreview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function proxyRequest(
  req: Request,
  ctx: { params: Promise<{ port: string; slug?: string[] }> },
) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me)) {
    return Response.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  const { port: portRaw, slug } = await ctx.params;
  if (!/^\d{1,5}$/.test(portRaw)) {
    return Response.json({ error: "Некорректный порт процесса Sandbox" }, { status: 400 });
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Response.json({ error: "Некорректный порт процесса Sandbox" }, { status: 400 });
  }

  let agentUrl: string;
  try {
    agentUrl = resolveSafeAgentUrl();
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  const segments = (slug ?? []).filter(Boolean);
  const subPath = segments.map((s) => encodeURIComponent(s)).join("/");
  const reqUrl = new URL(req.url);
  const upstreamPath = `/sandbox/proxy/${port}/${subPath}${reqUrl.search}`;

  const fwdHeaders = new Headers();
  for (const key of ["accept", "content-type", "range", "if-none-match", "if-modified-since"]) {
    const val = req.headers.get(key);
    if (val) fwdHeaders.set(key, val);
  }

  const method = req.method.toUpperCase();
  const hasBody = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  const bodyBuf = hasBody ? await req.arrayBuffer().catch(() => null) : null;

  try {
    const { response: upstream } = await fetchAgent(
      agentUrl,
      upstreamPath,
      {
        method,
        headers: fwdHeaders,
        body: bodyBuf && bodyBuf.byteLength > 0 ? bodyBuf : undefined,
        redirect: "manual",
        cache: "no-store",
      },
      { timeoutMs: 25_000, reqSignal: req.signal },
    );

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location");
      if (location) {
        return new Response(null, {
          status: upstream.status,
          headers: {
            Location: rewriteProxyLocation(location, port),
            "Cache-Control": "no-store",
          },
        });
      }
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const lowerCt = contentType.toLowerCase();
    const proxyBase = `/api/ai/agent/sandbox/proxy/${port}`;

    if (method !== "HEAD" && (lowerCt.includes("text/html") || lowerCt.includes("text/css"))) {
      const rawText = await upstream.text();
      const rewritten = lowerCt.includes("text/html")
        ? rewritePreviewHtml(rawText, proxyBase, segments.length === 0)
        : rewritePreviewCss(rawText, proxyBase);
      return new Response(rewritten, {
        status: upstream.status,
        headers: buildPreviewHeaders(upstream.headers, contentType, true),
      });
    }

    return new Response(method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      headers: buildPreviewHeaders(upstream.headers, contentType, false),
    });
  } catch {
    return Response.json({ error: "Агент не запущен или процесс недоступен" }, { status: 503 });
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ port: string; slug?: string[] }> }) {
  return proxyRequest(req, ctx);
}

export async function HEAD(req: Request, ctx: { params: Promise<{ port: string; slug?: string[] }> }) {
  return proxyRequest(req, ctx);
}

export async function POST(req: Request, ctx: { params: Promise<{ port: string; slug?: string[] }> }) {
  return proxyRequest(req, ctx);
}

export async function PUT(req: Request, ctx: { params: Promise<{ port: string; slug?: string[] }> }) {
  return proxyRequest(req, ctx);
}

export async function PATCH(req: Request, ctx: { params: Promise<{ port: string; slug?: string[] }> }) {
  return proxyRequest(req, ctx);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ port: string; slug?: string[] }> }) {
  return proxyRequest(req, ctx);
}
