import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLoopbackCandidates, fetchAgent, resolveAgentAuthToken, resolveSafeAgentUrl } from "@/lib/agentConfig";

const prevAgentUrl = process.env.AGENT_URL;
const prevAgentToken = process.env.AGENT_HTTP_TOKEN;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (prevAgentUrl === undefined) delete process.env.AGENT_URL;
  else process.env.AGENT_URL = prevAgentUrl;
  if (prevAgentToken === undefined) delete process.env.AGENT_HTTP_TOKEN;
  else process.env.AGENT_HTTP_TOKEN = prevAgentToken;
});

describe("agentConfig loopback resilience", () => {
  it("falls back to default 127.0.0.1:8899 when AGENT_URL is empty or whitespace", () => {
    process.env.AGENT_URL = "";
    expect(resolveSafeAgentUrl()).toBe("http://127.0.0.1:8899");

    process.env.AGENT_URL = "   ";
    expect(resolveSafeAgentUrl()).toBe("http://127.0.0.1:8899");

    expect(() => resolveSafeAgentUrl("")).toThrow();
  });

  it("generates loopback fallback candidates without duplicates", () => {
    const fromLocalhost = agentLoopbackCandidates("http://localhost:8899");
    expect(fromLocalhost[0]).toBe("http://localhost:8899");
    expect(fromLocalhost).toContain("http://127.0.0.1:8899");

    const from127 = agentLoopbackCandidates("http://127.0.0.1:8899");
    expect(from127[0]).toBe("http://127.0.0.1:8899");
    expect(from127).toContain("http://localhost:8899");
  });

  it("fetchAgent retries 127.0.0.1 when localhost fails with ECONNREFUSED", async () => {
    const called: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        called.push(u);
        if (u.startsWith("http://localhost:8899")) {
          throw new Error("connect ECONNREFUSED ::1:8899");
        }
        return new Response(JSON.stringify({ ok: true, tools: ["create_file"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const { endpoint, response } = await fetchAgent("http://localhost:8899", "/health", { cache: "no-store" }, { timeoutMs: 2000 });
    expect(endpoint).toBe("http://127.0.0.1:8899");
    expect(response.ok).toBe(true);
    expect(called).toEqual(["http://localhost:8899/health", "http://127.0.0.1:8899/health"]);
  });

  it("fetchAgent makes only a single request when primary endpoint succeeds", async () => {
    const called: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        called.push(String(input));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const { endpoint, response } = await fetchAgent("http://127.0.0.1:8899", "/health");
    expect(endpoint).toBe("http://127.0.0.1:8899");
    expect(response.status).toBe(200);
    expect(called).toEqual(["http://127.0.0.1:8899/health"]);
  });

  it("fetchAgent attaches AGENT_HTTP_TOKEN Bearer header when set", async () => {
    process.env.AGENT_HTTP_TOKEN = "secret-http-tok";
    const seenAuth: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const hdrs = new Headers(init?.headers);
        seenAuth.push(hdrs.get("authorization") ?? "");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const { response } = await fetchAgent("http://127.0.0.1:8899", "/sandbox");
    expect(response.status).toBe(200);
    expect(seenAuth).toEqual(["Bearer secret-http-tok"]);
  });

  it("resolveAgentAuthToken never reads local token file for non-loopback hosts", () => {
    delete process.env.AGENT_HTTP_TOKEN;
    const tok = resolveAgentAuthToken("http://host.docker.internal:8899");
    expect(tok).toEqual({ token: "", fromFile: false });
  });

  it("fetchAgent refreshes loopback token file once on 401 when agent rotated token", async () => {
    delete process.env.AGENT_HTTP_TOKEN;
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const fakeHome = mkdtempSync(join(tmpdir(), "crm-agent-home-"));
    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      const tokenDir = join(fakeHome, ".crm-agent");
      mkdirSync(tokenDir, { recursive: true });
      const tokenPath = join(tokenDir, "http-token-18899.json");
      writeFileSync(tokenPath, JSON.stringify({ token: "old-tok" }), "utf8");

      const seenAuth: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          const auth = new Headers(init?.headers).get("authorization") ?? "";
          seenAuth.push(auth);
          if (auth === "Bearer old-tok") {
            writeFileSync(tokenPath, JSON.stringify({ token: "new-tok" }), "utf8");
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }),
      );

      const { response } = await fetchAgent("http://127.0.0.1:18899", "/sandbox");
      expect(response.status).toBe(200);
      expect(seenAuth).toEqual(["Bearer old-tok", "Bearer new-tok"]);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
