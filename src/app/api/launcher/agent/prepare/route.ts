import {
  getAgentOrchestrationConfigSecret,
  getAiUserSettingsSecret,
  getGithubConnectionWithSecret,
  getRagFolder,
  getSubagentWithSecret,
  listActiveSubagentsWithSecrets,
  listRagChunks,
  listSubagentRuns,
  searchRagChunks,
  type AgentSubagentSecret,
} from "@/db/repo";
import { hasAgentAccess, isUnlimitedAiRole } from "@/lib/aiPolicy";
import { getRequestUser } from "@/lib/auth";
import { estimateTokens, normalizeBaseUrl } from "@/lib/ai";
import { AGENT_MAX_STEPS, isUnlimitedStepsRole, normalizeGenParams, resolveStepsForRole } from "@/lib/genParams";
import { buildGithubRagSnapshot } from "@/lib/github";
import { RAG_FULL_MAX_CHARS, formatFullRagContext, formatRagContext, ragBudgetChars } from "@/lib/rag";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";
import { assertSafeAiUrl, isLoopbackHostname } from "@/lib/ssrf";
import { normalizeTrustLevel } from "@/lib/trust";
import { ROLE_LABELS } from "@/lib/utils";

/**
 * Подготовка полного payload для запуска локального `agent/agent.py`
 * внутри настольного Harness-приложения (`.exe`).
 *
 * Сервер CRM не ходит сам к `127.0.0.1` пользователя — он собирает
 * контекст, RAG, GitHub, субагентов, Надсмотрщика и сохранённые в БД
 * настройки/ключи, а локальный Python-бэкенд стримит `/run` на ПК пользователя.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type IncomingMessage = { role?: string; content?: string };
type IncomingAttachment = {
  name?: string;
  text?: string;
  note?: string;
  image?: string;
  sandboxPath?: string;
  fromHistory?: boolean;
};

async function validateClientOrServerAiUrl(rawUrl: string | undefined, allowClientLoopback: boolean): Promise<void> {
  if (!rawUrl) return;
  if (allowClientLoopback) {
    try {
      const parsed = new URL(rawUrl);
      if (isLoopbackHostname(parsed.hostname)) return;
    } catch {
      /* пробросим дальше в assertSafeAiUrl */
    }
  }
  await assertSafeAiUrl(rawUrl);
}

export async function POST(req: Request) {
  const me = await getRequestUser(req);
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me)) {
    return Response.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  const rl = checkApiRateLimit({
    scope: "launcher_agent_prepare",
    userId: me.id,
    ip: extractClientIp(req.headers),
    maxRequests: 40,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const body = (await req.json().catch(() => null)) as
    | {
        messages?: IncomingMessage[];
        settings?: { baseUrl?: string; apiKey?: string; model?: string };
        params?: unknown;
        systemPrompt?: string;
        maxSteps?: number;
        attachments?: IncomingAttachment[];
        trustLevel?: string;
        runId?: string;
        ragFolderId?: number;
        ragFull?: boolean;
        ragChunks?: number;
        contextLimit?: number;
        modelContextLength?: number | null;
        githubEnabled?: boolean;
        githubOwner?: string;
        githubRepo?: string;
        githubBranch?: string;
        agentRole?: "agent" | "tester" | "subagent";
        subagentId?: number | null;
        agentConversationId?: number | null;
        testerConversationId?: number | null;
        subagentConversationId?: number | null;
        sandboxProject?: string;
        allowClientLoopback?: boolean;
      }
    | null;

  const allowClientLoopback = body?.allowClientLoopback !== false;
  const agentRole =
    body?.agentRole === "tester"
      ? "tester"
      : body?.agentRole === "subagent"
        ? "subagent"
        : "agent";
  const subagentId =
    Number.isFinite(body?.subagentId) && Number(body?.subagentId) > 0
      ? Math.floor(Number(body?.subagentId))
      : null;
  const agentConversationId =
    Number.isFinite(body?.agentConversationId) && Number(body?.agentConversationId) > 0
      ? Math.floor(Number(body?.agentConversationId))
      : null;
  const testerConversationId =
    Number.isFinite(body?.testerConversationId) && Number(body?.testerConversationId) > 0
      ? Math.floor(Number(body?.testerConversationId))
      : null;
  const subagentConversationId =
    Number.isFinite(body?.subagentConversationId) && Number(body?.subagentConversationId) > 0
      ? Math.floor(Number(body?.subagentConversationId))
      : null;
  const sandboxProject =
    typeof body?.sandboxProject === "string" ? body.sandboxProject.trim().slice(0, 300) : "";

  let targetSubagent: AgentSubagentSecret | null = null;
  if (agentRole === "subagent") {
    if (!subagentId) {
      return Response.json({ error: "Укажите subagentId для запуска субагента" }, { status: 400 });
    }
    targetSubagent = await getSubagentWithSecret(me.id, subagentId);
    if (!targetSubagent) {
      return Response.json({ error: "Субагент не найден" }, { status: 404 });
    }
  }

  const unlimitedSteps = isUnlimitedStepsRole(me.role);
  const unlimitedAi = isUnlimitedAiRole(me.role);
  const rawMessages = (body?.messages ?? []).filter(
    (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
  );
  const messages = (unlimitedAi ? rawMessages : rawMessages.slice(-100)).map((m) => ({
    role: m.role,
    content: unlimitedAi ? String(m.content) : String(m.content).slice(0, 256_000),
  }));
  if (messages.length === 0) {
    return Response.json({ error: "Пустой запрос" }, { status: 400 });
  }

  const rawAttachments = (body?.attachments ?? []).filter((item) => item && typeof item === "object");
  const attachments = (unlimitedAi ? rawAttachments : rawAttachments.slice(0, 8)).map((item) => {
    const rawItem = item as IncomingAttachment & { fromHistory?: unknown };
    const image =
      typeof rawItem.image === "string" && rawItem.image.startsWith("data:image/")
        ? unlimitedAi
          ? rawItem.image
          : rawItem.image.slice(0, 6_000_000)
        : "";
    const sandboxPath =
      typeof rawItem.sandboxPath === "string" ? rawItem.sandboxPath.trim().slice(0, 300) : "";
    return {
      name: String(rawItem.name ?? "файл").slice(0, 240),
      note: String(rawItem.note ?? "").slice(0, 240),
      text: unlimitedAi ? String(rawItem.text ?? "") : String(rawItem.text ?? "").slice(0, 120_000),
      ...(image ? { image } : {}),
      ...(sandboxPath ? { sandboxPath } : {}),
      ...(rawItem.fromHistory ? { fromHistory: true } : {}),
    };
  });

  const params = normalizeGenParams(body?.params, { unlimited: unlimitedAi });
  const maxSteps = resolveStepsForRole(me.role, body?.maxSteps, unlimitedSteps ? 0 : AGENT_MAX_STEPS);
  const trustLevel = normalizeTrustLevel(body?.trustLevel);
  const runId = typeof body?.runId === "string" && body.runId.trim() ? body.runId.trim().slice(0, 80) : undefined;
  const systemPrompt =
    typeof body?.systemPrompt === "string"
      ? unlimitedAi
        ? body.systemPrompt.trim()
        : body.systemPrompt.trim().slice(0, 16_000)
      : "";

  const ghConn = await getGithubConnectionWithSecret(me.id).catch(() => null);
  const useGithub = Boolean(ghConn && (body?.githubEnabled ?? ghConn.enabled));
  const ghOwner = useGithub ? String(body?.githubOwner || ghConn?.selectedOwner || "").trim() : "";
  const ghRepo = useGithub ? String(body?.githubRepo || ghConn?.selectedRepo || "").trim() : "";
  const ghBranch = useGithub ? String(body?.githubBranch || ghConn?.selectedBranch || "main").trim() || "main" : "";

  let githubRagContext = "";
  let githubMeta: {
    login: string;
    owner: string;
    repo: string;
    branch: string;
    fileCount: number;
    matchedFiles: string[];
  } | null = null;

  if (useGithub && ghConn && ghOwner && ghRepo) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    try {
      const snap = await buildGithubRagSnapshot({
        token: ghConn.token,
        owner: ghOwner,
        repo: ghRepo,
        branch: ghBranch,
        query: lastUser,
      });
      githubRagContext = snap.contextText;
      githubMeta = {
        login: ghConn.login,
        owner: ghOwner,
        repo: ghRepo,
        branch: ghBranch,
        fileCount: snap.fileCount,
        matchedFiles: snap.matchedFiles,
      };
    } catch {
      githubMeta = {
        login: ghConn.login,
        owner: ghOwner,
        repo: ghRepo,
        branch: ghBranch,
        fileCount: 0,
        matchedFiles: [],
      };
    }
  }

  const ragFolderId = Number(body?.ragFolderId ?? 0) || 0;
  const ragFull = Boolean(body?.ragFull);
  const rawRagChunks = Number(body?.ragChunks ?? 8);
  const ragChunks = unlimitedSteps
    ? Math.max(0, Number.isFinite(rawRagChunks) ? Math.floor(rawRagChunks) : 8)
    : Math.max(0, Math.min(500, Number.isFinite(rawRagChunks) ? Math.floor(rawRagChunks) : 8));
  const contextLimit = Math.max(0, Math.floor(Number(body?.contextLimit ?? 0) || 0));
  const modelContextLength = Math.max(0, Math.floor(Number(body?.modelContextLength ?? 0) || 0));
  const effectiveContextLimit =
    contextLimit > 0
      ? modelContextLength > 0
        ? Math.min(contextLimit, modelContextLength)
        : contextLimit
      : modelContextLength;

  let ragContext = "";
  let ragMeta: { folderName: string; hits: number; totalChunks: number; ragFull: boolean; truncated: boolean } | null =
    null;

  if (ragFolderId > 0 && (ragFull || ragChunks > 0)) {
    const folder = await getRagFolder(me.id, ragFolderId);
    if (folder) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const historyTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
      const overheadTokens =
        6_000 +
        estimateTokens(systemPrompt) +
        estimateTokens(githubRagContext) +
        attachments.reduce((sum, a) => sum + estimateTokens(a.text) + (a.image ? 1500 : 0), 0);
      const requestedCompletion = params.maxTokens ?? 4_096;
      const completionReserve =
        effectiveContextLimit > 0
          ? Math.min(requestedCompletion, Math.max(1_024, Math.floor(effectiveContextLimit * 0.75)))
          : Math.min(requestedCompletion, 32_768);
      const safetyTokens =
        effectiveContextLimit > 0 ? Math.max(2_048, Math.floor(effectiveContextLimit * 0.08)) : 2_048;
      const ragReserveTokens = overheadTokens + completionReserve + safetyTokens;

      if (ragFull) {
        const chunks = await listRagChunks(ragFolderId, unlimitedSteps ? 500_000 : 50_000);
        if (chunks.length > 0) {
          const relevant = lastUser ? await searchRagChunks(ragFolderId, lastUser, chunks.length) : [];
          const seen = new Set<number>();
          const ordered: Array<{ id: number; path: string; text: string; score: number }> = [];
          for (const hit of relevant) {
            if (seen.has(hit.id)) continue;
            seen.add(hit.id);
            ordered.push(hit);
          }
          for (const chunk of chunks) {
            if (seen.has(chunk.id)) continue;
            seen.add(chunk.id);
            ordered.push({ ...chunk, score: 0 });
          }
          const budgetChars =
            effectiveContextLimit > 0
              ? ragBudgetChars(effectiveContextLimit, historyTokens, ragReserveTokens, unlimitedSteps)
              : RAG_FULL_MAX_CHARS;
          const packed = formatFullRagContext(ordered, budgetChars);
          if (packed.used > 0) {
            ragContext = packed.text;
            ragMeta = {
              folderName: folder.name,
              hits: packed.used,
              totalChunks: ordered.length,
              ragFull: true,
              truncated: packed.truncated,
            };
          }
        }
      } else if (lastUser.trim()) {
        const hits = await searchRagChunks(ragFolderId, lastUser, ragChunks);
        if (hits.length > 0) {
          const maxChars =
            effectiveContextLimit > 0
              ? ragBudgetChars(effectiveContextLimit, historyTokens, ragReserveTokens, unlimitedSteps)
              : Math.min(RAG_FULL_MAX_CHARS, Math.max(24_000, ragChunks * 2_400));
          ragContext = formatRagContext(hits, maxChars);
          ragMeta = {
            folderName: folder.name,
            hits: hits.length,
            totalChunks: folder.chunksCount,
            ragFull: false,
            truncated: false,
          };
        }
      }
    }
  }

  const savedSettings = await getAiUserSettingsSecret(me.id).catch(() => ({ baseUrl: "", model: "", apiKey: "" }));
  const orchestratorBaseUrl = normalizeBaseUrl(body?.settings?.baseUrl || savedSettings.baseUrl || "") ?? undefined;
  const orchestratorApiKey = ((body?.settings?.apiKey ?? "").trim() || savedSettings.apiKey).slice(0, 400);
  const orchestratorModel = ((body?.settings?.model ?? "").trim() || savedSettings.model).slice(0, 200);

  let effectiveBaseUrl = orchestratorBaseUrl;
  let effectiveApiKey = orchestratorApiKey;
  let effectiveModel = orchestratorModel;
  let directSubagentUsedCustomApi = false;

  if (agentRole === "subagent" && targetSubagent && targetSubagent.unlockApi) {
    const customUrl = normalizeBaseUrl(targetSubagent.baseUrl || "") || orchestratorBaseUrl;
    effectiveBaseUrl = customUrl ?? undefined;
    effectiveModel = (targetSubagent.model.trim() || orchestratorModel).slice(0, 200);
    effectiveApiKey = (
      targetSubagent.apiKey ||
      (!targetSubagent.baseUrl ? orchestratorApiKey : "")
    ).slice(0, 400);
    directSubagentUsedCustomApi = Boolean(targetSubagent.baseUrl || targetSubagent.model || targetSubagent.apiKey);
  }

  try {
    await validateClientOrServerAiUrl(effectiveBaseUrl, allowClientLoopback);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Запрещённый адрес модели" },
      { status: 400 },
    );
  }

  const [activeSubagentsRaw, orchestrationCfg] = await Promise.all([
    listActiveSubagentsWithSecrets(me.id).catch(() => []),
    getAgentOrchestrationConfigSecret(me.id).catch(() => ({
      routingMode: "linear" as const,
      overseer: {
        enabled: true,
        mode: "strict" as const,
        systemPrompt: "",
        unlockApi: false,
        provider: "custom",
        baseUrl: "",
        model: "",
        hasApiKey: false,
        apiKeyHint: "",
        apiKey: "",
      },
    })),
  ]);

  const subagentsPayload: Array<Record<string, unknown>> = [];
  for (const sub of activeSubagentsRaw) {
    let customApi: Record<string, unknown> = { unlocked: false };
    if (sub.unlockApi) {
      const subUrl = normalizeBaseUrl(sub.baseUrl || "") || orchestratorBaseUrl || "";
      let urlSafe = true;
      if (subUrl) {
        try {
          await validateClientOrServerAiUrl(subUrl, allowClientLoopback);
        } catch {
          urlSafe = false;
        }
      }
      if (urlSafe) {
        customApi = {
          unlocked: true,
          baseUrl: subUrl,
          model: (sub.model.trim() || orchestratorModel).slice(0, 200),
          apiKey: (sub.apiKey || (!sub.baseUrl ? orchestratorApiKey : "")).slice(0, 400),
          reasoningMode: sub.reasoningMode || "default",
        };
      }
    }
    subagentsPayload.push({
      id: sub.id,
      slug: sub.slug,
      name: sub.name,
      roleTitle: sub.roleTitle,
      description: sub.description,
      systemPrompt: sub.systemPrompt,
      color: sub.color,
      parentSubagentId: sub.parentSubagentId,
      orchestratorCanCall: sub.orchestratorCanCall,
      allowedCallees: sub.allowedCallees,
      toolProfile: sub.toolProfile,
      unlockApi: sub.unlockApi,
      customApi,
    });
  }

  let overseerPayload: Record<string, unknown> = {
    enabled: orchestrationCfg.overseer.enabled,
    mode: orchestrationCfg.overseer.mode,
    systemPrompt: orchestrationCfg.overseer.systemPrompt,
    unlockApi: false,
    baseUrl: orchestratorBaseUrl ?? "",
    apiKey: orchestratorApiKey,
    model: orchestratorModel,
  };
  if (orchestrationCfg.overseer.unlockApi) {
    const ovUrl = normalizeBaseUrl(orchestrationCfg.overseer.baseUrl || "") || orchestratorBaseUrl || "";
    let ovUrlSafe = true;
    if (ovUrl) {
      try {
        await validateClientOrServerAiUrl(ovUrl, allowClientLoopback);
      } catch {
        ovUrlSafe = false;
      }
    }
    if (ovUrlSafe) {
      overseerPayload = {
        ...overseerPayload,
        unlockApi: true,
        baseUrl: ovUrl,
        model: (orchestrationCfg.overseer.model.trim() || orchestratorModel).slice(0, 200),
        apiKey: (
          orchestrationCfg.overseer.apiKey ||
          (!orchestrationCfg.overseer.baseUrl ? orchestratorApiKey : "")
        ).slice(0, 400),
      };
    }
  }

  const effectiveSystemPrompt =
    agentRole === "subagent" && targetSubagent
      ? [targetSubagent.systemPrompt, systemPrompt].filter(Boolean).join("\n\n")
      : systemPrompt;

  const recentSubagentReports =
    agentRole === "agent"
      ? await listSubagentRuns(me.id, { limit: 10 })
          .then((rows) =>
            rows.map((r) => ({
              id: r.id,
              subagentId: r.subagentId,
              subagentSlug: r.subagentSlug ?? "",
              subagentName: r.subagentName ?? "",
              subagentConversationId: r.subagentConversationId,
              callerKind: r.callerKind,
              sandboxProject: r.sandboxProject,
              status: r.status,
              outputSummary: r.outputSummary.slice(0, 1200),
              requestedCalleeSlug: r.requestedCalleeSlug,
              requestedCalleeTask: r.requestedCalleeTask,
              filesTouched: r.filesTouched.slice(0, 20),
              totalTokens: r.totalTokens,
              updatedAt: r.updatedAt,
            })),
          )
          .catch(() => [])
      : [];

  const fullPayload = {
    messages,
    attachments,
    params,
    ownerUserId: me.id,
    ...(effectiveSystemPrompt ? { systemPrompt: effectiveSystemPrompt } : {}),
    maxSteps,
    maxRunTokens: unlimitedSteps ? 0 : 2_500_000,
    unlimited: unlimitedSteps,
    trustLevel,
    ...(contextLimit > 0 ? { contextLimit } : {}),
    ...(modelContextLength > 0 ? { modelContextLength } : {}),
    ...(runId ? { runId } : {}),
    settings: {
      baseUrl: effectiveBaseUrl,
      apiKey: effectiveApiKey,
      model: effectiveModel,
    },
    orchestratorSettings: {
      baseUrl: orchestratorBaseUrl,
      apiKey: orchestratorApiKey,
      model: orchestratorModel,
    },
    ...(useGithub && ghConn
      ? {
          github: {
            userId: me.id,
            login: ghConn.login,
            name: ghConn.name,
            email: ghConn.email,
            token: ghConn.token,
            owner: ghOwner,
            repo: ghRepo,
            branch: ghBranch,
          },
        }
      : {}),
    agentRole,
    subagentRoutingMode: orchestrationCfg.routingMode,
    overseer: overseerPayload,
    ...(sandboxProject ? { sandboxProject } : {}),
    ...(subagentsPayload.length > 0 ? { subagents: subagentsPayload } : {}),
    ...(targetSubagent
      ? {
          activeSubagent: {
            id: targetSubagent.id,
            slug: targetSubagent.slug,
            name: targetSubagent.name,
            roleTitle: targetSubagent.roleTitle,
            description: targetSubagent.description,
            systemPrompt: targetSubagent.systemPrompt,
            allowedCallees: targetSubagent.allowedCallees,
            toolProfile: targetSubagent.toolProfile,
            unlockApi: targetSubagent.unlockApi,
            usedCustomApi: directSubagentUsedCustomApi,
          },
        }
      : {}),
    context: {
      user: me.name,
      roleLabel: ROLE_LABELS[me.role] ?? me.role,
      today: new Date().toISOString().slice(0, 10),
      ...(ragContext ? { ragContext, ragMeta } : {}),
      ...(githubRagContext ? { githubRagContext } : {}),
      ...(githubMeta ? { githubMeta } : {}),
      ...(recentSubagentReports.length > 0 ? { recentSubagentReports } : {}),
    },
  };

  const promptEst =
    messages.reduce((sum, m) => sum + estimateTokens(m.content), 0) +
    estimateTokens(systemPrompt) +
    estimateTokens(ragContext) +
    estimateTokens(githubRagContext) +
    attachments.reduce((sum, a) => sum + estimateTokens(a.text), 0);

  return Response.json(
    {
      ok: true,
      payload: fullPayload,
      meta: {
        model: effectiveModel,
        promptEst,
        agentRole,
        sandboxProject,
        subagentId,
        agentConversationId,
        testerConversationId,
        subagentConversationId,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
