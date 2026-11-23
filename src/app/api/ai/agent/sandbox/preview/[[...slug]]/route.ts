import { fetchAgent, resolveSafeAgentUrl } from "@/lib/agentConfig";
import { hasAgentAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import { buildPreviewHeaders, rewritePreviewCss, rewritePreviewHtml } from "@/lib/sandboxPreview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function servePreview(
  req: Request,
  ctx: { params: Promise<{ slug?: string[] }> },
  isHead: boolean,
) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me)) {
    return Response.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  let agentUrl: string;
  try {
    agentUrl = resolveSafeAgentUrl();
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  const { slug } = await ctx.params;
  const segments = (slug ?? []).filter(Boolean);
  const encodedPath = segments.map((s) => encodeURIComponent(s)).join("/");
  const reqUrl = new URL(req.url);
  const hasTrailingSlash = reqUrl.pathname.endsWith("/") && segments.length > 0;
  const upstreamPath = `/sandbox/preview${encodedPath ? `/${encodedPath}` : "/"}${hasTrailingSlash ? "/" : ""}${reqUrl.search}`;

  try {
    const { response: upstream } = await fetchAgent(
      agentUrl,
      upstreamPath,
      {
        method: isHead ? "HEAD" : "GET",
        headers: {
          "X-Sandbox-Prefix": "/api/ai/agent/sandbox/preview",
        },
        redirect: "manual",
        cache: "no-store",
      },
      { timeoutMs: 20_000, reqSignal: req.signal },
    );

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location");
      if (location) {
        return new Response(null, {
          status: upstream.status,
          headers: {
            Location: location,
            "Cache-Control": "no-store",
          },
        });
      }
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const lowerCt = contentType.toLowerCase();

    if (!isHead && segments.length >= 1 && (lowerCt.includes("text/html") || lowerCt.includes("text/css"))) {
      const projectBase = `/api/ai/agent/sandbox/preview/${encodeURIComponent(segments[0]!)}`;
      const rawText = await upstream.text();
      const rewritten = lowerCt.includes("text/html")
        ? rewritePreviewHtml(rawText, projectBase, segments.length === 1 && !hasTrailingSlash)
        : rewritePreviewCss(rawText, projectBase);
      return new Response(rewritten, {
        status: upstream.status,
        headers: buildPreviewHeaders(upstream.headers, contentType, true),
      });
    }

    return new Response(isHead ? null : upstream.body, {
      status: upstream.status,
      headers: buildPreviewHeaders(upstream.headers, contentType, false),
    });
  } catch {
    return Response.json({ error: "Агент не запущен или не отвечает" }, { status: 503 });
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ slug?: string[] }> }) {
  return servePreview(req, ctx, false);
}

export async function HEAD(req: Request, ctx: { params: Promise<{ slug?: string[] }> }) {
  return servePreview(req, ctx, true);
}
