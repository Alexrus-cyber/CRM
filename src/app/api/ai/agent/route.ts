import {
  completeSubagentRun,
  completeTesterRun,
  createSubagentRunWithConversation,
  createTesterRunWithConversation,
  getAgentOrchestrationConfigSecret,
  getAiUserSettingsSecret,
  getGithubConnectionWithSecret,
  getRagFolder,
  getSubagentWithSecret,
  listActiveSubagentsWithSecrets,
  listRagChunks,
  listSubagentRuns,
  listTesterRuns,
  recordAgentUsage,
  searchRagChunks,
  updateTesterMinorDecision,
  type AgentSubagentSecret,
  type SubagentCallerKind,
  type SubagentRunStatus,
  type TesterMinorDecision,
  type TesterRunStatus,
} from "@/db/repo";
import { AGENT_START_HINT, fetchAgent, resolveSafeAgentUrl } from "@/lib/agentConfig";
import { createAgentSseProxyStream } from "@/lib/agentSseProxy";
import { registerAgentApproval } from "@/lib/agentApprovals";
import { hasAgentAccess, isUnlimitedAiRole } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import { estimateTokens, normalizeBaseUrl } from "@/lib/ai";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";
import { assertSafeAiUrl } from "@/lib/ssrf";
import { AGENT_MAX_STEPS, isUnlimitedStepsRole, normalizeGenParams, resolveStepsForRole } from "@/lib/genParams";
import { buildGithubRagSnapshot } from "@/lib/github";
import {
  RAG_FULL_MAX_CHARS,
  formatFullRagContext,
  formatRagContext,
  ragBudgetChars,
} from "@/lib/rag";
import { normalizeTrustLevel } from "@/lib/trust";
import { ROLE_LABELS } from "@/lib/utils";

/**
 * Мост к Python-агенту (`agent/agent.py`).
 *
 * Поддерживает:
 *  - неограниченное RAG-окружение (обычный поиск и режим «Вся база»);
 *  - передачу уровня доверия (`full` | `verified` | `none`);
 *  - длительный SSE-поток (до 60 мин с keepalive-событиями), чтобы пользователь успевал
 *    подтвердить выполнение bash-команд, действий на ПК и перенос файлов из Sandbox на сайте.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me)) {
    return Response.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  let agentUrl: string;
  try {
    agentUrl = resolveSafeAgentUrl();
  } catch (err) {
    return Response.json({ available: false, error: (err as Error).message, hint: AGENT_START_HINT }, { status: 400 });
  }

  try {
    const { endpoint, response: res } = await fetchAgent(
      agentUrl,
      "/health",
      { cache: "no-store" },
      { timeoutMs: 6_000, reqSignal: req.signal },
    );
    if (!res.ok) {
      return Response.json(
        {
          available: false,
          endpoint,
          errorReason: `HTTP ${res.status}`,
          hint: `${AGENT_START_HINT} (сервер ${endpoint} ответил HTTP ${res.status})`,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const data = (await res.json()) as Record<string, unknown>;
    const unlimitedSteps = isUnlimitedStepsRole(me.role);
    return Response.json(
      {
        available: true,
        endpoint,
        ...data,
        maxSteps: unlimitedSteps ? null : Math.min(Number(data.maxSteps ?? AGENT_MAX_STEPS) || AGENT_MAX_STEPS, AGENT_MAX_STEPS),
        agentMaxSteps: data.maxSteps ?? AGENT_MAX_STEPS,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err ?? "");
    const isTimeout =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    const hint = isTimeout
      ? `Агент на ${agentUrl} не ответил вовремя (таймаут 6 с). Проверьте окно/логи агента — не завис ли он и не мешает ли прокси.`
      : `${AGENT_START_HINT} (нет ответа от ${agentUrl}${detail ? `: ${detail}` : ""})`;
    return Response.json(
      { available: false, endpoint: agentUrl, errorReason: detail || "unavailable", hint },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}

type IncomingMessage = { role?: string; content?: string };
type IncomingAttachment = { name?: string; text?: string; note?: string; image?: string };

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me)) {
    return Response.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  const rl = checkApiRateLimit({
    scope: "ai_agent",
    userId: me.id,
    ip: extractClientIp(req.headers),
    maxRequests: 30,
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
      }
    | null;

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
    const image =
      typeof item.image === "string" && item.image.startsWith("data:image/")
        ? unlimitedAi
          ? item.image
          : item.image.slice(0, 6_000_000)
        : "";
    return {
      name: String(item.name ?? "файл").slice(0, 240),
      note: String(item.note ?? "").slice(0, 240),
      text: unlimitedAi ? String(item.text ?? "") : String(item.text ?? "").slice(0, 120_000),
      ...(image ? { image } : {}),
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

  // Персональный GitHub-контекст и RAG по выбранному репозиторию текущего пользователя CRM.
  const ghConn = await getGithubConnectionWithSecret(me.id).catch(() => null);
  const useGithub = Boolean(ghConn && (body?.githubEnabled ?? ghConn.enabled));
  const ghOwner = useGithub ? (String(body?.githubOwner || ghConn?.selectedOwner || "").trim()) : "";
  const ghRepo = useGithub ? (String(body?.githubRepo || ghConn?.selectedRepo || "").trim()) : "";
  const ghBranch = useGithub ? (String(body?.githubBranch || ghConn?.selectedBranch || "main").trim() || "main") : "";

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

  // RAG-окружение с учётом реального бюджета: история + системный промпт + инструменты + max_tokens.
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

  // Приоритет заблокированного API Агента (Оркестратора):
  // если у субагента НЕ стоит галочка unlockApi, всегда используется API Оркестратора.
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

  if (effectiveBaseUrl) {
    try {
      await assertSafeAiUrl(effectiveBaseUrl);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Запрещённый адрес модели" },
        { status: 400 },
      );
    }
  }
  let agentUrl: string;
  try {
    agentUrl = resolveSafeAgentUrl();
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  // Загружаем активных субагентов (до 10 активных), режим дерева и настройки Надсмотрщика.
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
          await assertSafeAiUrl(subUrl);
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
        await assertSafeAiUrl(ovUrl);
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

  const payload = {
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
    context: {
      user: me.name,
      roleLabel: ROLE_LABELS[me.role] ?? me.role,
      today: new Date().toISOString().slice(0, 10),
      ...(ragContext ? { ragContext, ragMeta } : {}),
      ...(githubRagContext ? { githubRagContext } : {}),
      ...(githubMeta ? { githubMeta } : {}),
    },
  };

  const modelName = payload.settings.model || "";
  const [recentTesterReports, recentSubagentReports] = await Promise.all([
    agentRole === "agent"
      ? listTesterRuns(me.id, 4)
          .then((rows) =>
            rows.map((r) => ({
              id: r.id,
              testerConversationId: r.testerConversationId,
              sandboxProject: r.sandboxProject,
              status: r.status,
              reportSummary: r.reportSummary.slice(0, 1200),
              criticalIssues: r.criticalIssues.slice(0, 10),
              minorIssues: r.minorIssues.slice(0, 10),
              minorDecision: r.minorDecision,
              totalTokens: r.totalTokens,
              updatedAt: r.updatedAt,
            })),
          )
          .catch(() => [])
      : Promise.resolve([]),
    agentRole === "agent"
      ? listSubagentRuns(me.id, { limit: 10 })
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
      : Promise.resolve([]),
  ]);

  const fullPayload = {
    ...payload,
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
            unlockApi: targetSubagent.unlockApi,
            usedCustomApi: directSubagentUsedCustomApi,
          },
        }
      : {}),
    context: {
      ...payload.context,
      ...(recentTesterReports.length > 0 ? { recentTesterReports } : {}),
      ...(recentSubagentReports.length > 0 ? { recentSubagentReports } : {}),
    },
  };

  let upstream: Response;
  try {
    const runResult = await fetchAgent(
      agentUrl,
      "/run",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fullPayload),
        cache: "no-store",
      },
      { timeoutMs: 3_600_000, reqSignal: req.signal },
    );
    upstream = runResult.response;
  } catch {
    return Response.json({ error: `Агент не запущен. ${AGENT_START_HINT}`, hint: AGENT_START_HINT }, { status: 503 });
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return Response.json(
      { error: `Агент ответил ошибкой ${upstream.status}${text ? `: ${text.slice(0, 300)}` : ""}` },
      { status: 502 },
    );
  }

  const promptEst =
    messages.reduce((sum, m) => sum + estimateTokens(m.content), 0) +
    estimateTokens(systemPrompt) +
    estimateTokens(ragContext) +
    estimateTokens(githubRagContext) +
    attachments.reduce((sum, a) => sum + estimateTokens(a.text), 0);
  const upstreamReader = upstream.body.getReader();
  let textLatest = "";
  let reasoningLatest = "";
  let reportedPrompt = 0;
  let reportedCompletion = 0;
  let reportedTotal = 0;
  let recorded = false;
  const activeTesterRuns = new Map<string, { runId: number; testerConversationId: number }>();
  const activeSubagentRuns = new Map<
    string,
    { runId: number; subagentId: number; subagentConversationId: number }
  >();

  const flushUsage = async () => {
    if (recorded) return;
    recorded = true;
    const estComp = estimateTokens(textLatest) + estimateTokens(reasoningLatest);
    const promptTokens = reportedPrompt || (reportedTotal > 0 ? 0 : promptEst);
    const completionTokens = reportedCompletion || (reportedTotal > 0 ? 0 : estComp);
    const totalTokens = reportedTotal || promptTokens + completionTokens;
    if (totalTokens > 0 || promptTokens > 0 || completionTokens > 0) {
      await recordAgentUsage({
        userId: me.id,
        kind: "agent",
        ...(agentRole === "tester" && testerConversationId
          ? { refId: testerConversationId }
          : agentRole === "subagent" && subagentConversationId
            ? { refId: subagentConversationId }
            : {}),
        model: modelName,
        prompt: promptTokens,
        completion: completionTokens,
        total: totalTokens,
      }).catch(() => undefined);
    }
  };

  const processFrame = async (frame: string): Promise<string> => {
    const lines = frame.split(/\r?\n/);
    const evLine = lines.find((l) => l.startsWith("event:"));
    const dataLines = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) return `${frame}\n\n`;
    const ev = evLine ? evLine.slice(6).trim() : "message";
    try {
      const parsed = JSON.parse(dataLines.join("\n").trim()) as Record<string, unknown>;
      if (ev === "text" && typeof parsed.text === "string") {
        textLatest = parsed.text;
      } else if (ev === "reasoning" && typeof parsed.text === "string") {
        reasoningLatest = parsed.text;
      } else if (ev === "approval_required") {
        const approvalId = typeof parsed.approvalId === "string" ? parsed.approvalId.trim() : "";
        const nonce = typeof parsed.nonce === "string" ? parsed.nonce.trim() : "";
        if (approvalId) {
          registerAgentApproval(approvalId, me.id, nonce);
        }
        delete parsed.nonce;
        const rk = typeof parsed.testerRunKey === "string" ? parsed.testerRunKey : "";
        const mapped = rk ? activeTesterRuns.get(rk) : undefined;
        if (mapped) {
          parsed.testerRunId = mapped.runId;
          parsed.testerConversationId = mapped.testerConversationId;
        }
        const srk = typeof parsed.subagentRunKey === "string" ? parsed.subagentRunKey : "";
        const mappedSub = srk ? activeSubagentRuns.get(srk) : undefined;
        if (mappedSub) {
          parsed.subagentRunId = mappedSub.runId;
          parsed.subagentConversationId = mappedSub.subagentConversationId;
        }
        return `event: ${ev}\ndata: ${JSON.stringify(parsed)}\n\n`;
      } else if (ev === "subagent_start") {
        const runKey = String(parsed.runKey ?? "default");
        const parsedSubId = Number(parsed.subagentId ?? subagentId ?? 0);
        if (parsedSubId > 0) {
          try {
            const rawCaller = String(parsed.callerKind ?? "orchestrator");
            const callerKind: SubagentCallerKind =
              rawCaller === "subagent" || rawCaller === "user" ? rawCaller : "orchestrator";
            const created = await createSubagentRunWithConversation({
              userId: me.id,
              subagentId: parsedSubId,
              agentConversationId,
              existingConversationId:
                agentRole === "subagent" ? subagentConversationId : null,
              skipInitialMessage:
                agentRole === "subagent" && Boolean(subagentConversationId),
              callerKind,
              callerSubagentId:
                Number.isFinite(Number(parsed.callerSubagentId)) && Number(parsed.callerSubagentId) > 0
                  ? Math.floor(Number(parsed.callerSubagentId))
                  : null,
              sandboxProject:
                typeof parsed.sandboxProject === "string"
                  ? parsed.sandboxProject
                  : sandboxProject,
              inputSummary: typeof parsed.summary === "string" ? parsed.summary : "",
              taskPrompt: typeof parsed.task === "string" ? parsed.task : "",
              model: typeof parsed.model === "string" ? parsed.model : modelName,
              usedCustomApi: Boolean(parsed.usedCustomApi),
            });
            activeSubagentRuns.set(runKey, {
              runId: created.run.id,
              subagentId: created.run.subagentId,
              subagentConversationId: created.conversation.id,
            });
            return `event: subagent_run\ndata: ${JSON.stringify({
              runKey,
              runId: created.run.id,
              subagentId: created.run.subagentId,
              subagentSlug: created.run.subagentSlug,
              subagentName: created.run.subagentName,
              subagentColor: created.run.subagentColor,
              subagentConversationId: created.conversation.id,
              tier: typeof parsed.tier === "number" ? parsed.tier : undefined,
              routingMode: typeof parsed.routingMode === "string" ? parsed.routingMode : undefined,
              callerKind: created.run.callerKind,
              callerSubagentName: typeof parsed.callerSubagentName === "string" ? parsed.callerSubagentName : "",
              sandboxProject: created.run.sandboxProject,
              model: created.run.model,
              usedCustomApi: created.run.usedCustomApi,
              run: created.run,
              conversation: created.conversation,
            })}\n\n`;
          } catch {
            return `event: subagent_run\ndata: ${JSON.stringify(parsed)}\n\n`;
          }
        }
        return `event: subagent_run\ndata: ${JSON.stringify(parsed)}\n\n`;
      } else if (
        ev === "overseer_start" ||
        ev === "overseer_status" ||
        ev === "overseer_reasoning" ||
        ev === "overseer_done"
      ) {
        const srk = typeof parsed.subagentRunKey === "string" ? parsed.subagentRunKey : "";
        const mappedSub = srk ? activeSubagentRuns.get(srk) : undefined;
        if (mappedSub) {
          parsed.subagentRunId = mappedSub.runId;
          parsed.subagentId = mappedSub.subagentId;
          parsed.subagentConversationId = mappedSub.subagentConversationId;
        }
        return `event: ${ev}\ndata: ${JSON.stringify(parsed)}\n\n`;
      } else if (
        ev === "subagent_status" ||
        ev === "subagent_reasoning" ||
        ev === "subagent_text" ||
        ev === "subagent_action" ||
        ev === "subagent_handoff"
      ) {
        const runKey = String(parsed.runKey ?? "default");
        const mappedSub = activeSubagentRuns.get(runKey);
        if (mappedSub) {
          parsed.runId = mappedSub.runId;
          parsed.subagentId = mappedSub.subagentId;
          parsed.subagentConversationId = mappedSub.subagentConversationId;
        }
        return `event: ${ev}\ndata: ${JSON.stringify(parsed)}\n\n`;
      } else if (ev === "subagent_done") {
        const runKey = String(parsed.runKey ?? "default");
        const mappedSub = activeSubagentRuns.get(runKey);
        const u = (parsed.usage && typeof parsed.usage === "object" ? parsed.usage : {}) as Record<
          string,
          unknown
        >;
        const sPrompt = Math.max(
          0,
          Math.round(Number(u.prompt ?? u.prompt_tokens ?? parsed.promptTokens ?? 0) || 0),
        );
        const sCompletion = Math.max(
          0,
          Math.round(Number(u.completion ?? u.completion_tokens ?? parsed.completionTokens ?? 0) || 0),
        );
        const sTotal = Math.max(
          0,
          Math.round(Number(u.total ?? u.total_tokens ?? parsed.totalTokens ?? 0) || 0),
        );
        if (mappedSub) {
          const rawStatus = String(parsed.status ?? "completed");
          const safeStatus: SubagentRunStatus =
            rawStatus === "handoff" ||
            rawStatus === "blocked" ||
            rawStatus === "error" ||
            rawStatus === "completed"
              ? rawStatus
              : "completed";
          const savedRun = await completeSubagentRun({
            userId: me.id,
            runId: mappedSub.runId,
            status: safeStatus,
            outputSummary:
              typeof parsed.outputSummary === "string"
                ? parsed.outputSummary
                : typeof parsed.reportSummary === "string"
                  ? parsed.reportSummary
                  : "",
            requestedCalleeSlug:
              typeof parsed.requestedCalleeSlug === "string" ? parsed.requestedCalleeSlug : "",
            requestedCalleeTask:
              typeof parsed.requestedCalleeTask === "string" ? parsed.requestedCalleeTask : "",
            filesTouched: Array.isArray(parsed.filesTouched)
              ? parsed.filesTouched.map((x) => String(x))
              : [],
            promptTokens: agentRole === "subagent" ? 0 : sPrompt,
            completionTokens: agentRole === "subagent" ? 0 : sCompletion,
            totalTokens: agentRole === "subagent" ? 0 : sTotal,
            model: typeof parsed.model === "string" ? parsed.model : modelName,
            usedCustomApi: Boolean(parsed.usedCustomApi),
            assistantContent:
              typeof parsed.fullResponse === "string" ? parsed.fullResponse : undefined,
            assistantReasoning:
              typeof parsed.reasoning === "string" ? parsed.reasoning : undefined,
            assistantActions: Array.isArray(parsed.actions) ? parsed.actions : undefined,
            assistantFiles: Array.isArray(parsed.files) ? parsed.files : undefined,
            assistantError: typeof parsed.error === "string" ? parsed.error : undefined,
          }).catch(() => null);
          if (savedRun) {
            parsed.runId = savedRun.id;
            parsed.subagentId = savedRun.subagentId;
            parsed.subagentConversationId = savedRun.subagentConversationId;
            parsed.run = savedRun;
          }
        }
        return `event: subagent_done\ndata: ${JSON.stringify(parsed)}\n\n`;
      } else if (ev === "tester_start") {
        const runKey = String(parsed.runKey ?? "default");
        try {
          const created = await createTesterRunWithConversation({
            userId: me.id,
            agentConversationId,
            testerConversationId: agentRole === "tester" ? testerConversationId : null,
            title: typeof parsed.title === "string" ? parsed.title : undefined,
            sandboxProject: typeof parsed.sandboxProject === "string" ? parsed.sandboxProject : sandboxProject,
            summary: typeof parsed.summary === "string" ? parsed.summary : "",
            model: typeof parsed.model === "string" ? parsed.model : modelName,
            skipInitialMessage: agentRole === "tester" && Boolean(testerConversationId),
          });
          activeTesterRuns.set(runKey, {
            runId: created.run.id,
            testerConversationId: created.conversation.id,
          });
          return `event: tester_run\ndata: ${JSON.stringify({
            runKey,
            runId: created.run.id,
            testerConversationId: created.conversation.id,
            run: created.run,
            conversation: created.conversation,
          })}\n\n`;
        } catch {
          return `event: tester_run\ndata: ${JSON.stringify(parsed)}\n\n`;
        }
      } else if (
        ev === "tester_status" ||
        ev === "tester_reasoning" ||
        ev === "tester_text" ||
        ev === "tester_action"
      ) {
        const runKey = String(parsed.runKey ?? "default");
        const mapped = activeTesterRuns.get(runKey);
        if (mapped) {
          parsed.runId = mapped.runId;
          parsed.testerConversationId = mapped.testerConversationId;
        }
        return `event: ${ev}\ndata: ${JSON.stringify(parsed)}\n\n`;
      } else if (ev === "action") {
        const rk = typeof parsed.runKey === "string"
          ? parsed.runKey
          : (typeof parsed.testerRunKey === "string" ? parsed.testerRunKey : "");
        const mapped = rk ? activeTesterRuns.get(rk) : undefined;
        if (mapped) {
          if (!parsed.runId) parsed.runId = mapped.runId;
          if (!parsed.testerConversationId) parsed.testerConversationId = mapped.testerConversationId;
        }
        const srk =
          typeof parsed.subagentRunKey === "string"
            ? parsed.subagentRunKey
            : typeof parsed.runKey === "string"
              ? parsed.runKey
              : "";
        const mappedSub = srk ? activeSubagentRuns.get(srk) : undefined;
        if (mappedSub) {
          if (!parsed.runId) parsed.runId = mappedSub.runId;
          if (!parsed.subagentId) parsed.subagentId = mappedSub.subagentId;
          if (!parsed.subagentConversationId) parsed.subagentConversationId = mappedSub.subagentConversationId;
        }
        return `event: action\ndata: ${JSON.stringify(parsed)}\n\n`;
      } else if (ev === "tester_done") {
        const runKey = String(parsed.runKey ?? "default");
        const mapped = activeTesterRuns.get(runKey);
        const u = (parsed.usage && typeof parsed.usage === "object" ? parsed.usage : {}) as Record<string, unknown>;
        const tPrompt = Math.max(
          0,
          Math.round(Number(u.prompt ?? u.prompt_tokens ?? parsed.promptTokens ?? 0) || 0),
        );
        const tCompletion = Math.max(
          0,
          Math.round(Number(u.completion ?? u.completion_tokens ?? parsed.completionTokens ?? 0) || 0),
        );
        const tTotal = Math.max(
          0,
          Math.round(Number(u.total ?? u.total_tokens ?? parsed.totalTokens ?? 0) || 0),
        );
        if (mapped) {
          const rawStatus = String(parsed.status ?? "passed") as TesterRunStatus;
          const rawDecision =
            parsed.minorDecision !== undefined ? (String(parsed.minorDecision) as TesterMinorDecision) : undefined;
          const savedRun = await completeTesterRun(me.id, mapped.runId, {
            status: rawStatus,
            reportSummary: typeof parsed.reportSummary === "string" ? parsed.reportSummary : "",
            criticalIssues: parsed.criticalIssues,
            minorIssues: parsed.minorIssues,
            checksRun: parsed.checksRun,
            minorDecision: rawDecision,
            promptTokens: tPrompt,
            completionTokens: tCompletion,
            totalTokens: tTotal,
            model: typeof parsed.model === "string" ? parsed.model : modelName,
            fullResponse: typeof parsed.fullResponse === "string" ? parsed.fullResponse : "",
            reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
            actions: Array.isArray(parsed.actions) ? parsed.actions : [],
            files: Array.isArray(parsed.files) ? parsed.files : [],
            error: typeof parsed.error === "string" ? parsed.error : "",
            skipUsageRecord: agentRole === "tester" || Boolean(parsed.skipUsageRecord),
          }).catch(() => null);
          if (savedRun) {
            parsed.runId = savedRun.id;
            parsed.testerConversationId = savedRun.testerConversationId;
            parsed.run = savedRun;
          }
        }
        return `event: tester_done\ndata: ${JSON.stringify(parsed)}\n\n`;
      } else if (ev === "tester_decision") {
        const runKey = String(parsed.runKey ?? "default");
        const mapped = activeTesterRuns.get(runKey);
        const decision = parsed.decision === "approved" ? "approved" : parsed.decision === "rejected" ? "rejected" : "pending";
        if (mapped) {
          const updated = await updateTesterMinorDecision(
            me.id,
            mapped.runId,
            decision,
            typeof parsed.note === "string" ? parsed.note : undefined,
          ).catch(() => null);
          if (updated) {
            parsed.runId = updated.id;
            parsed.testerConversationId = updated.testerConversationId;
            parsed.run = updated;
          }
        }
        return `event: tester_decision\ndata: ${JSON.stringify(parsed)}\n\n`;
      } else if (ev === "done" && parsed.usage && typeof parsed.usage === "object") {
        const u = parsed.usage as Record<string, unknown>;
        reportedPrompt = Math.max(
          reportedPrompt,
          Math.round(Number(u.prompt_tokens ?? u.promptTokens ?? u.prompt ?? 0) || 0),
        );
        reportedCompletion = Math.max(
          reportedCompletion,
          Math.round(Number(u.completion_tokens ?? u.completionTokens ?? u.completion ?? 0) || 0),
        );
        reportedTotal = Math.max(
          reportedTotal,
          Math.round(Number(u.total_tokens ?? u.totalTokens ?? u.total ?? 0) || 0),
        );
      }
    } catch {
      /* ignore malformed SSE frame */
    }
    return `${frame}\n\n`;
  };

  const trackedStream = createAgentSseProxyStream({
    upstreamReader,
    processFrame,
    onDone: flushUsage,
    reqSignal: req.signal,
  });

  return new Response(trackedStream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
