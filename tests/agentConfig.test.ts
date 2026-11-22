import { afterEach, describe, expect, it, vi } from "vitest";
import { agentLoopbackCandidates, fetchAgent, resolveSafeAgentUrl } from "@/lib/agentConfig";

const prevAgentUrl = process.env.AGENT_URL;

afterEach(() => {
  vi.unstubAllGlobals();
  if (prevAgentUrl === undefined) delete process.env.AGENT_URL;
  else process.env.AGENT_URL = prevAgentUrl;
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
});
