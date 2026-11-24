import {
  MAX_ACTIVE_SUBAGENTS,
  MAX_SUBAGENTS_STORED,
  countSubagents,
  deleteSubagent,
  getSubagentPublic,
  listAgentConversations,
  listSubagentRuns,
  updateSubagent,
  type UpdateSubagentInput,
} from "@/db/repo";
import { normalizeBaseUrl } from "@/lib/ai";
import { hasAgentAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";
import { assertSafeAiUrl } from "@/lib/ssrf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function parseId(params: Promise<{ id: string }>): Promise<number> {
  const id = Number((await params).id);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(user)) {
    return Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 });
  }

  const id = await parseId(params);
  if (!id) return Response.json({ error: "Некорректный ID субагента" }, { status: 400 });

  const subagent = await getSubagentPublic(user.id, id);
  if (!subagent) return Response.json({ error: "Субагент не найден" }, { status: 404 });

  const [runs, conversations] = await Promise.all([
    listSubagentRuns(user.id, { subagentId: id, limit: 60 }),
    listAgentConversations(user.id, "subagent", 100, id),
  ]);

  return Response.json(
    { subagent, runs, conversations },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(user)) {
    return Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 });
  }

  const id = await parseId(params);
  if (!id) return Response.json({ error: "Некорректный ID субагента" }, { status: 400 });

  const rl = checkApiRateLimit({
    scope: "agent_subagents_write",
    userId: user.id,
    ip: extractClientIp(req.headers),
    maxRequests: 60,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const body = (await req.json().catch(() => null)) as UpdateSubagentInput | null;
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Нет данных для обновления" }, { status: 400 });
  }

  let normalizedBaseUrl: string | null = body.baseUrl ?? null;
  if (body.baseUrl !== undefined) {
    normalizedBaseUrl = body.baseUrl ? (normalizeBaseUrl(String(body.baseUrl).slice(0, 400)) ?? "") : "";
    if (normalizedBaseUrl) {
      try {
        await assertSafeAiUrl(normalizedBaseUrl);
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : "Запрещённый адрес API модели" },
          { status: 400 },
        );
      }
    }
  }

  try {
    const updated = await updateSubagent(user.id, id, {
      ...body,
      ...(normalizedBaseUrl !== null ? { baseUrl: normalizedBaseUrl } : { baseUrl: undefined }),
    });
    if (!updated) return Response.json({ error: "Субагент не найден" }, { status: 404 });
    const counts = await countSubagents(user.id);
    return Response.json(
      {
        ok: true,
        subagent: updated,
        limits: {
          maxStored: MAX_SUBAGENTS_STORED,
          maxActive: MAX_ACTIVE_SUBAGENTS,
          totalCount: counts.total,
          activeCount: counts.active,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Не удалось обновить субагента" },
      { status: 400 },
    );
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(user)) {
    return Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 });
  }

  const id = await parseId(params);
  if (!id) return Response.json({ error: "Некорректный ID субагента" }, { status: 400 });

  const ok = await deleteSubagent(user.id, id);
  if (!ok) return Response.json({ error: "Субагент не найден" }, { status: 404 });
  const counts = await countSubagents(user.id);
  return Response.json({
    ok: true,
    limits: {
      maxStored: MAX_SUBAGENTS_STORED,
      maxActive: MAX_ACTIVE_SUBAGENTS,
      totalCount: counts.total,
      activeCount: counts.active,
    },
  });
}
