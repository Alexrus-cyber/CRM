import {
  MAX_ACTIVE_SUBAGENTS,
  MAX_SUBAGENTS_STORED,
  countSubagents,
  createSubagent,
  getAgentConversation,
  getAgentConversationUsage,
  getAgentOrchestrationConfigPublic,
  listAgentConversationMessages,
  listAgentConversations,
  listSubagentRuns,
  listSubagentsPublic,
  updateSubagentsDependencyTree,
  upsertAgentOrchestrationConfig,
  type CreateSubagentInput,
  type DependencyTreeNodeUpdate,
  type OverseerMode,
  type SubagentRoutingMode,
} from "@/db/repo";
import { normalizeBaseUrl } from "@/lib/ai";
import { hasAgentAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";
import { assertSafeAiUrl } from "@/lib/ssrf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Список субагентов пользователя (до 50 в БД, до 10 активных), дерево зависимостей,
 * последние запуски и изолированные чаты выбранного субагента.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(user)) {
    return Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 });
  }

  const sp = new URL(req.url).searchParams;
  const subagentIdRaw = Number(sp.get("subagentId") || 0);
  const subagentId = Number.isSafeInteger(subagentIdRaw) && subagentIdRaw > 0 ? subagentIdRaw : null;
  const conversationIdRaw = Number(sp.get("conversationId") || 0);
  const conversationId =
    Number.isSafeInteger(conversationIdRaw) && conversationIdRaw > 0 ? conversationIdRaw : null;
  const onlyConversation = sp.get("onlyConversation") === "1" && conversationId !== null;

  if (onlyConversation && conversationId) {
    let selectedConversation = null;
    const conv = await getAgentConversation(user.id, conversationId);
    if (conv && conv.kind === "subagent") {
      const [messages, usage] = await Promise.all([
        listAgentConversationMessages(conv.id),
        getAgentConversationUsage(user.id, conv.id),
      ]);
      selectedConversation = {
        conversation: conv,
        messages,
        tokens: usage,
      };
    }
    return Response.json({ selectedConversation }, { headers: { "Cache-Control": "no-store" } });
  }

  const [subagents, counts, runs, conversations, orchestration] = await Promise.all([
    listSubagentsPublic(user.id),
    countSubagents(user.id),
    listSubagentRuns(user.id, { subagentId, limit: 80 }),
    listAgentConversations(user.id, "subagent", 200, subagentId),
    getAgentOrchestrationConfigPublic(user.id),
  ]);

  let selectedConversation = null;
  if (conversationId) {
    const conv = await getAgentConversation(user.id, conversationId);
    if (conv && conv.kind === "subagent") {
      const [messages, usage] = await Promise.all([
        listAgentConversationMessages(conv.id),
        getAgentConversationUsage(user.id, conv.id),
      ]);
      selectedConversation = {
        conversation: conv,
        messages,
        tokens: usage,
      };
    }
  }

  return Response.json(
    {
      subagents,
      runs,
      conversations,
      selectedConversation,
      routingMode: orchestration.routingMode,
      overseer: orchestration.overseer,
      limits: {
        maxStored: MAX_SUBAGENTS_STORED,
        maxActive: MAX_ACTIVE_SUBAGENTS,
        totalCount: counts.total,
        activeCount: counts.active,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Создать нового субагента (до 50 в базе, до 10 активных одновременно). */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(user)) {
    return Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 });
  }

  const rl = checkApiRateLimit({
    scope: "agent_subagents_write",
    userId: user.id,
    ip: extractClientIp(req.headers),
    maxRequests: 40,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const body = (await req.json().catch(() => null)) as CreateSubagentInput | null;
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Некорректные данные субагента" }, { status: 400 });
  }

  const cleanBaseUrl = body.baseUrl ? normalizeBaseUrl(String(body.baseUrl).slice(0, 400)) : "";
  if (cleanBaseUrl) {
    try {
      await assertSafeAiUrl(cleanBaseUrl);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Запрещённый адрес API модели" },
        { status: 400 },
      );
    }
  }

  try {
    const subagent = await createSubagent(user.id, {
      ...body,
      baseUrl: cleanBaseUrl ?? undefined,
    });
    const counts = await countSubagents(user.id);
    return Response.json(
      {
        ok: true,
        subagent,
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
      { error: err instanceof Error ? err.message : "Не удалось создать субагента" },
      { status: 400 },
    );
  }
}

/** Пакетное сохранение дерева зависимостей «Оркестратор ↔ Субагенты» и активных субагентов. */
export async function PUT(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(user)) {
    return Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 });
  }

  const rl = checkApiRateLimit({
    scope: "agent_subagents_tree",
    userId: user.id,
    ip: extractClientIp(req.headers),
    maxRequests: 40,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const body = (await req.json().catch(() => null)) as
    | {
        nodes?: DependencyTreeNodeUpdate[];
        routingMode?: SubagentRoutingMode;
      }
    | null;
  if (!body || (!Array.isArray(body.nodes) && body.routingMode === undefined)) {
    return Response.json({ error: "Укажите массив узлов дерева nodes или routingMode" }, { status: 400 });
  }

  try {
    const subagents = Array.isArray(body.nodes)
      ? await updateSubagentsDependencyTree(user.id, body.nodes)
      : await listSubagentsPublic(user.id);
    const orchestration =
      body.routingMode !== undefined
        ? await upsertAgentOrchestrationConfig(user.id, { routingMode: body.routingMode })
        : await getAgentOrchestrationConfigPublic(user.id);
    const counts = await countSubagents(user.id);
    return Response.json(
      {
        ok: true,
        subagents,
        routingMode: orchestration.routingMode,
        overseer: orchestration.overseer,
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
      { error: err instanceof Error ? err.message : "Не удалось обновить дерево зависимостей" },
      { status: 400 },
    );
  }
}

/** Сохранение режима маршрутизации (`linear` | `layered`) и конфигурации агента-Надсмотрщика. */
export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(user)) {
    return Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 });
  }

  const rl = checkApiRateLimit({
    scope: "agent_subagents_settings",
    userId: user.id,
    ip: extractClientIp(req.headers),
    maxRequests: 40,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const body = (await req.json().catch(() => null)) as
    | {
        routingMode?: SubagentRoutingMode;
        overseer?: {
          enabled?: boolean;
          mode?: OverseerMode;
          systemPrompt?: string;
          unlockApi?: boolean;
          provider?: string;
          baseUrl?: string;
          model?: string;
          apiKey?: string;
          clearApiKey?: boolean;
        };
      }
    | null;
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Некорректные настройки оркестрации" }, { status: 400 });
  }

  let cleanOverseerUrl: string | undefined;
  if (body.overseer?.baseUrl !== undefined) {
    cleanOverseerUrl = body.overseer.baseUrl
      ? normalizeBaseUrl(String(body.overseer.baseUrl).slice(0, 400)) ?? ""
      : "";
    if (cleanOverseerUrl) {
      try {
        await assertSafeAiUrl(cleanOverseerUrl);
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : "Запрещённый адрес API Надсмотрщика" },
          { status: 400 },
        );
      }
    }
  }

  try {
    const orchestration = await upsertAgentOrchestrationConfig(user.id, {
      ...(body.routingMode !== undefined ? { routingMode: body.routingMode } : {}),
      ...(body.overseer
        ? {
            overseer: {
              ...body.overseer,
              ...(cleanOverseerUrl !== undefined ? { baseUrl: cleanOverseerUrl } : {}),
            },
          }
        : {}),
    });
    return Response.json(
      {
        ok: true,
        routingMode: orchestration.routingMode,
        overseer: orchestration.overseer,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Не удалось сохранить настройки Надсмотрщика" },
      { status: 400 },
    );
  }
}
