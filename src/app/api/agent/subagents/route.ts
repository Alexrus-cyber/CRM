import {
  MAX_ACTIVE_SUBAGENTS,
  MAX_SUBAGENTS_STORED,
  computeSubagentsTreeVersion,
  countSubagents,
  createSubagent,
  getAgentConversation,
  getAgentConversationUsage,
  getAgentOrchestrationConfigPublic,
  listAgentConversationMessages,
  listAgentConversations,
  listSubagentRuns,
  listSubagentsPublic,
  reapStaleSubagentRuns,
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

  // Реапер: закрываем «осиротевшие» запуски (обрыв SSE/закрытая вкладка), чтобы UI
  // не показывал вечный статус «выполняется» и не терял возможность продолжить задачу.
  await reapStaleSubagentRuns(user.id).catch(() => 0);

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
      orchestratorPos: {
        x: orchestration.orchestratorPosX,
        y: orchestration.orchestratorPosY,
      },
      overseer: orchestration.overseer,
      // Версия семантического состояния дерева — для оптимистичных блокировок при сохранении.
      treeVersion: computeSubagentsTreeVersion(subagents, orchestration),
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

type TreeConflict = {
  id: number;
  name: string;
  field: "isActive" | "parentSubagentId" | "orchestratorCanCall" | "allowedCallees";
  client: unknown;
  current: unknown;
};

/** Что именно клиент пытается изменить не так, как лежит в БД (для понятного 409). */
function collectTreeConflicts(
  subagents: Awaited<ReturnType<typeof listSubagentsPublic>>,
  nodes: DependencyTreeNodeUpdate[],
): TreeConflict[] {
  const byId = new Map(subagents.map((s) => [s.id, s]));
  const out: TreeConflict[] = [];
  for (const node of nodes) {
    const cur = byId.get(Number(node.id));
    if (!cur) continue;
    if (node.isActive !== undefined && Boolean(node.isActive) !== cur.isActive) {
      out.push({ id: cur.id, name: cur.name, field: "isActive", client: Boolean(node.isActive), current: cur.isActive });
    }
    if (node.parentSubagentId !== undefined) {
      const next = node.parentSubagentId === null || node.parentSubagentId === 0 ? null : Number(node.parentSubagentId);
      if (next !== cur.parentSubagentId) {
        out.push({ id: cur.id, name: cur.name, field: "parentSubagentId", client: next, current: cur.parentSubagentId });
      }
    }
    if (node.orchestratorCanCall !== undefined && Boolean(node.orchestratorCanCall) !== cur.orchestratorCanCall) {
      out.push({
        id: cur.id,
        name: cur.name,
        field: "orchestratorCanCall",
        client: Boolean(node.orchestratorCanCall),
        current: cur.orchestratorCanCall,
      });
    }
    if (node.allowedCallees !== undefined) {
      const next = [...node.allowedCallees].map((c) => String(c)).sort().join(",");
      const prev = [...cur.allowedCallees].map((c) => String(c)).sort().join(",");
      if (next !== prev) {
        out.push({ id: cur.id, name: cur.name, field: "allowedCallees", client: next, current: prev });
      }
    }
  }
  return out.slice(0, 20);
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
        orchestratorPos?: { x?: number | null; y?: number | null } | null;
        /** Версия дерева, которую видел клиент (из GET). Несовпадение -> 409 tree_conflict. */
        expectedVersion?: string;
        /** Принудительно перезаписать дерево, даже если версия устарела. */
        force?: boolean;
      }
    | null;
  if (
    !body ||
    (!Array.isArray(body.nodes) && body.routingMode === undefined && body.orchestratorPos === undefined)
  ) {
    return Response.json(
      { error: "Укажите массив узлов дерева nodes, routingMode или orchestratorPos" },
      { status: 400 },
    );
  }

  // Оптимистичная блокировка: две вкладки/два админа больше не затирают дерево молча.
  const [currentSubagents, currentOrch] = await Promise.all([
    listSubagentsPublic(user.id),
    getAgentOrchestrationConfigPublic(user.id),
  ]);
  const currentVersion = computeSubagentsTreeVersion(currentSubagents, currentOrch);
  const expectedVersion = typeof body.expectedVersion === "string" ? body.expectedVersion.trim() : "";
  if (expectedVersion && expectedVersion !== currentVersion && body.force !== true) {
    return Response.json(
      {
        error:
          "Дерево зависимостей было изменено в другой вкладке. Обновите данные или сохраните принудительно.",
        code: "tree_conflict",
        currentVersion,
        expectedVersion,
        conflicts: collectTreeConflicts(currentSubagents, body.nodes ?? []),
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const subagents = Array.isArray(body.nodes)
      ? await updateSubagentsDependencyTree(user.id, body.nodes)
      : await listSubagentsPublic(user.id);
    const shouldUpsertOrch = body.routingMode !== undefined || body.orchestratorPos !== undefined;
    const orchestration = shouldUpsertOrch
      ? await upsertAgentOrchestrationConfig(user.id, {
          ...(body.routingMode !== undefined ? { routingMode: body.routingMode } : {}),
          ...(body.orchestratorPos !== undefined
            ? {
                orchestratorPosX: body.orchestratorPos?.x ?? null,
                orchestratorPosY: body.orchestratorPos?.y ?? null,
              }
            : {}),
        })
      : await getAgentOrchestrationConfigPublic(user.id);
    const counts = await countSubagents(user.id);
    return Response.json(
      {
        ok: true,
        subagents,
        routingMode: orchestration.routingMode,
        orchestratorPos: {
          x: orchestration.orchestratorPosX,
          y: orchestration.orchestratorPosY,
        },
        overseer: orchestration.overseer,
        treeVersion: computeSubagentsTreeVersion(subagents, orchestration),
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
