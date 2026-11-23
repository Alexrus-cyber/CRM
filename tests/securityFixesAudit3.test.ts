import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const authMock = vi.hoisted(() => ({
  currentUser: {
    id: 1,
    email: "admin@crm.local",
    name: "Admin",
    role: "super_admin" as const,
    canUseAgent: true,
    canUseAi: true,
  },
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(async () => authMock.currentUser),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Audit 3 security & confirmation fixes", () => {
  beforeEach(() => {
    process.env.AGENT_URL = "http://127.0.0.1:8899";
  });

  it("sandbox POST export and delete require confirmed=true before forwarding to agent", async () => {
    const fetchSpy = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { POST } = await import("@/app/api/ai/agent/sandbox/route");

    const expUnconfirmed = await POST(
      new Request("http://localhost:3000/api/ai/agent/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "export", source: "app", destination: "/tmp/out" }),
      }),
    );
    expect(expUnconfirmed.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();

    const delUnconfirmed = await POST(
      new Request("http://localhost:3000/api/ai/agent/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", path: "app" }),
      }),
    );
    expect(delUnconfirmed.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();

    const expConfirmed = await POST(
      new Request("http://localhost:3000/api/ai/agent/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "export", source: "app", destination: "/tmp/out", confirmed: true }),
      }),
    );
    expect(expConfirmed.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, firstInit] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(String(firstInit?.body))).toMatchObject({ confirmed: true });

    const delConfirmed = await POST(
      new Request("http://localhost:3000/api/ai/agent/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", path: "app", confirmed: true }),
      }),
    );
    expect(delConfirmed.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchSpy.mock.calls[1]!;
    expect(JSON.parse(String(secondInit?.body))).toMatchObject({ confirmed: true });
  });

  it("docker-compose.yml declares AGENT_HTTP_TOKEN and AgentChat sends confirmed=true on export", () => {
    const compose = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");
    expect(compose).toContain("AGENT_HTTP_TOKEN");

    const chatSrc = readFileSync(join(process.cwd(), "src/components/AgentChat.tsx"), "utf8");
    expect(chatSrc).toContain('action: "export"');
    expect(chatSrc).toContain("confirmed: true");
  });
});
