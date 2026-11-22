import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-ctx-overflow-"));
process.env.SQLITE_PATH = path.join(tempDir, "crm.sqlite");
process.env.DATABASE_URL = "";
process.env.CRM_ALLOW_LOCAL_LLM = "1";

let superUserId = 0;
let ragFolderId = 0;
let db: typeof import("@/db");
let repo: typeof import("@/db/repo");

const mockUser = () => ({
  id: superUserId,
  email: "boss@example.com",
  name: "Главный Админ",
  role: "super_admin" as const,
  canUseAgent: true,
  canUseOperator: true,
  avatarColor: "#3366ff",
  totpEnabled: false,
});

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    getCurrentUser: vi.fn(async () => mockUser()),
  };
});

beforeAll(async () => {
  db = await import("@/db");
  repo = await import("@/db/repo");
  await db.getDb();
  await db.q(sql`
    insert into users (email, password_hash, name, role, can_use_agent, can_use_operator, created_at, updated_at)
    values ('boss@example.com', 'x', 'Главный Админ', 'super_admin', 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `);
  const row = await db.q1<{ id: number }>(sql`select id from users where email = 'boss@example.com'`);
  superUserId = Number(row?.id);

  // Создаём RAG-папку с большим набором фрагментов (около 200 тыс. символов).
  const folder = await repo.createRagFolder(superUserId, "BigDocs");
  ragFolderId = folder.id;
  const bigChunks = Array.from({ length: 120 }, (_, i) => `Раздел ${i}: ${"документация_".repeat(120)}`);
  await repo.addRagChunks(ragFolderId, [{ path: "guide.md", chunks: bigChunks }]);
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Context overflow & max_tokens budget protection", () => {
  it("POST /api/ai/agent reserves maxTokens + overhead when packing ragFull and records Python usage keys", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/run") && init?.body) {
        capturedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('event: text\ndata: {"text":"Готово"}\n\n'));
            controller.enqueue(
              encoder.encode(
                'event: done\ndata: {"steps":1,"files":0,"actions":0,"usage":{"prompt":31200,"completion":450,"total":31650,"model":"qwen-big"}}\n\n',
              ),
            );
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("@/app/api/ai/agent/route");
    const req = new Request("http://127.0.0.1:3000/api/ai/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "127.0.0.1" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Найди ответ в базе" }],
        settings: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen-big" },
        params: { maxTokens: 48_000, reasoning: "high" },
        ragFolderId,
        ragFull: true,
        contextLimit: 65_536,
        modelContextLength: 65_536,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    await res.text();

    expect(capturedBodies.length).toBe(1);
    const sent = capturedBodies[0];
    expect(sent.contextLimit).toBe(65_536);
    expect(sent.modelContextLength).toBe(65_536);

    // При contextLimit=65536 и maxTokens=48000 свободного места под RAG остаётся мало (~6k токенов),
    // поэтому ragContext не должен выходить за пределы безопасного бюджета (и тем более не все 200к символов).
    const ctx = sent.context as { ragContext?: string; ragMeta?: { truncated: boolean } };
    expect((ctx.ragContext ?? "").length).toBeLessThan(25_000);
    expect(ctx.ragMeta?.truncated).toBe(true);

    const usage = await repo.getAgentUsage(superUserId);
    expect(usage.month.agent.prompt).toBe(31_200);
    expect(usage.month.agent.completion).toBe(450);
    expect(usage.month.agent.total).toBe(31_650);
  });

  it("POST /api/ai/chat recovers from 400 context overflow by clamping max_tokens=384000 and retrying", async () => {
    const upstreamPayloads: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        upstreamPayloads.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      if (upstreamPayloads.length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "This model's maximum context length is 1048576 tokens. However, you requested 1200971 tokens (816971 in the messages, 384000 in the completion). Please reduce the length of the messages or completion.",
              type: "invalid_request_error",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Ответ после адаптации"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":30000,"completion_tokens":120,"total_tokens":30120}}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("@/app/api/ai/chat/route");
    const req = new Request("http://127.0.0.1:3000/api/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "127.0.0.1",
        "x-ai-model": "big-1m-model",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Привет, проверь отчёт" }],
        params: { maxTokens: 384_000, contextLimit: 1_048_576 },
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(bodyText).toContain("Ответ после адаптации");

    expect(upstreamPayloads.length).toBe(2);
    expect(upstreamPayloads[0].max_tokens).toBe(384_000);
    expect(typeof upstreamPayloads[1].max_tokens).toBe("number");
    expect(Number(upstreamPayloads[1].max_tokens)).toBeLessThanOrEqual(1_048_576 - 816_971);
  });
});
