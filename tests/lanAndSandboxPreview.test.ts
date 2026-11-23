import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { resolveRequestOrigin, shouldUseSecureCookie } from "@/lib/auth";
import {
  rewritePreviewCss,
  rewritePreviewHtml,
  rewriteProxyLocation,
} from "@/lib/sandboxPreview";
import { proxy } from "@/proxy";

const prevSecureOverride = process.env.CRM_COOKIE_SECURE;
const prevPublicUrl = process.env.CRM_PUBLIC_URL;

afterEach(() => {
  if (prevSecureOverride === undefined) delete process.env.CRM_COOKIE_SECURE;
  else process.env.CRM_COOKIE_SECURE = prevSecureOverride;

  if (prevPublicUrl === undefined) delete process.env.CRM_PUBLIC_URL;
  else process.env.CRM_PUBLIC_URL = prevPublicUrl;
});

describe("LAN HTTP cookies, origin resolution and proxy CSP", () => {
  it("shouldUseSecureCookie returns false for plain HTTP localhost and LAN requests", async () => {
    delete process.env.CRM_COOKIE_SECURE;
    delete process.env.CRM_PUBLIC_URL;

    const lanHeaders = new Headers({ host: "192.168.1.50:3000", origin: "http://192.168.1.50:3000" });
    expect(await shouldUseSecureCookie(lanHeaders, "http://192.168.1.50:3000/login")).toBe(false);

    const localHeaders = new Headers({ host: "localhost:3000" });
    expect(await shouldUseSecureCookie(localHeaders, "http://localhost:3000/login")).toBe(false);
  });

  it("shouldUseSecureCookie returns true behind HTTPS proxy or explicit override", async () => {
    delete process.env.CRM_COOKIE_SECURE;
    const httpsFwd = new Headers({ host: "crm.local", "x-forwarded-proto": "https" });
    expect(await shouldUseSecureCookie(httpsFwd, "http://127.0.0.1:3000/login")).toBe(true);

    const sslOn = new Headers({ host: "crm.local", "x-forwarded-ssl": "on" });
    expect(await shouldUseSecureCookie(sslOn, "http://127.0.0.1:3000/login")).toBe(true);

    const rfcFwd = new Headers({ forwarded: "for=10.0.0.5;proto=https" });
    expect(await shouldUseSecureCookie(rfcFwd)).toBe(true);

    process.env.CRM_COOKIE_SECURE = "1";
    expect(await shouldUseSecureCookie(new Headers({ host: "localhost:3000" }), "http://localhost:3000")).toBe(true);

    process.env.CRM_COOKIE_SECURE = "0";
    expect(await shouldUseSecureCookie(httpsFwd, "https://crm.example.com")).toBe(false);
  });

  it("resolveRequestOrigin respects forwarded headers and replaces 0.0.0.0 with Host header", () => {
    const reqLan = new Request("http://0.0.0.0:3000/api/agent/token", {
      headers: { host: "192.168.1.42:3000" },
    });
    expect(resolveRequestOrigin(reqLan)).toBe("http://192.168.1.42:3000");

    const reqProxy = new Request("http://127.0.0.1:3000/api/github/oauth/start", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "crm.company.internal",
      },
    });
    expect(resolveRequestOrigin(reqProxy)).toBe("https://crm.company.internal");
  });

  it("proxy skips strict nonce CSP on sandbox preview/proxy while still requiring auth", () => {
    const unauthReq = new NextRequest("http://192.168.1.50:3000/api/ai/agent/sandbox/preview/demo");
    const unauthRes = proxy(unauthReq);
    expect(unauthRes.status).toBe(401);

    const authedPreviewReq = new NextRequest("http://192.168.1.50:3000/api/ai/agent/sandbox/preview/demo", {
      headers: { cookie: "crm_session=tok123" },
    });
    const authedPreviewRes = proxy(authedPreviewReq);
    expect(authedPreviewRes.status).toBe(200);
    expect(authedPreviewRes.headers.get("Content-Security-Policy")).toBeNull();

    const authedProxyReq = new NextRequest("http://192.168.1.50:3000/api/ai/agent/sandbox/proxy/8123", {
      headers: { cookie: "crm_session=tok123" },
    });
    const authedProxyRes = proxy(authedProxyReq);
    expect(authedProxyRes.status).toBe(200);
    expect(authedProxyRes.headers.get("Content-Security-Policy")).toBeNull();

    const loginRes = proxy(new NextRequest("http://192.168.1.50:3000/login"));
    expect(loginRes.headers.get("Content-Security-Policy") ?? "").toContain("'strict-dynamic'");
  });
});

describe("sandbox preview HTML/CSS/Location rewriting", () => {
  it("rewrites root-relative and bare-relative asset URLs without breaking anchors or external links", () => {
    const html = [
      '<link rel="stylesheet" href="/assets/app.css">',
      '<script src="./main.js"></script>',
      '<a href="#features">Features</a>',
      '<a href="https://example.com">Ext</a>',
      '<img src="//cdn.example.com/a.png">',
      '<img src="/images/hero.png">',
    ].join("\n");

    const rewritten = rewritePreviewHtml(html, "/api/ai/agent/sandbox/proxy/8123", true);
    expect(rewritten).toContain('href="/api/ai/agent/sandbox/proxy/8123/assets/app.css"');
    expect(rewritten).toContain('src="/api/ai/agent/sandbox/proxy/8123/main.js"');
    expect(rewritten).toContain('href="#features"');
    expect(rewritten).toContain('href="https://example.com"');
    expect(rewritten).toContain('src="//cdn.example.com/a.png"');
    expect(rewritten).toContain('src="/api/ai/agent/sandbox/proxy/8123/images/hero.png"');

    const css = "body{background:url('/bg.png')} .x{background:url(data:image/png;base64,AAA)}";
    const cssOut = rewritePreviewCss(css, "/api/ai/agent/sandbox/preview/site");
    expect(cssOut).toContain("url('/api/ai/agent/sandbox/preview/site/bg.png')");
    expect(cssOut).toContain("url(data:image/png;base64,AAA)");

    expect(rewriteProxyLocation("/dashboard?ok=1", 8123)).toBe("/api/ai/agent/sandbox/proxy/8123/dashboard?ok=1");
    expect(rewriteProxyLocation("http://127.0.0.1:8123/auth/done", 8123)).toBe(
      "/api/ai/agent/sandbox/proxy/8123/auth/done",
    );
  });
});
