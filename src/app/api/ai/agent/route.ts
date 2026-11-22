import {
  getAiUserSettingsSecret,
  getGithubConnectionWithSecret,
  getRagFolder,
  listRagChunks,
  recordAgentUsage,
  searchRagChunks,
} from "@/db/repo";
import { AGENT_START_HINT, resolveSafeAgentUrl } from "@/lib/agentConfig";
import { registerAgentApproval } from "@/lib/agentApprovals";
import { hasAgentAccess } from "@/lib/aiPolicy";
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
 *  - длительный SSE-поток (до 15 мин), чтобы пользователь успевал подтвердить
 *    выполнение bash-команд, действий на ПК и перенос файлов из Sandbox на сайте.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
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
    const res = await fetch(`${agentUrl}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return Response.json({ available: false, endpoint: agentUrl, hint: AGENT_START_HINT });
    }
    const data = (await res.json()) as Record<string, unknown>;
    return Response.json(
      { available: true, endpoint: agentUrl, ...data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ available: false, endpoint: agentUrl, hint: AGENT_START_HINT });
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
        githubEnabled?: boolean;
        githubOwner?: string;
        githubRepo?: string;
        githubBranch?: string;
      }
    | null;

  const unlimitedSteps = isUnlimitedStepsRole(me.role);
  const rawMessages = (body?.messages ?? []).filter(
    (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
  );
  const messages = (unlimitedSteps ? rawMessages : rawMessages.slice(-100)).map((m) => ({
    role: m.role,
    content: unlimitedSteps ? String(m.content) : String(m.content).slice(0, 256_000),
  }));
  if (messages.length === 0) {
    return Response.json({ error: "Пустой запрос" }, { status: 400 });
  }

  const rawAttachments = (body?.attachments ?? []).filter((item) => item && typeof item === "object");
  const attachments = (unlimitedSteps ? rawAttachments : rawAttachments.slice(0, 8)).map((item) => {
    const image =
      typeof item.image === "string" && item.image.startsWith("data:image/")
        ? unlimitedSteps
          ? item.image
          : item.image.slice(0, 6_000_000)
        : "";
    return {
      name: String(item.name ?? "файл").slice(0, 240),
      note: String(item.note ?? "").slice(0, 240),
      text: unlimitedSteps ? String(item.text ?? "") : String(item.text ?? "").slice(0, 120_000),
      ...(image ? { image } : {}),
    };
  });

  // RAG-окружение без искусственных ограничений: вся база или топ-N фрагментов.
  const ragFolderId = Number(body?.ragFolderId ?? 0) || 0;
  const ragFull = Boolean(body?.ragFull);
  const rawRagChunks = Number(body?.ragChunks ?? 8);
  const ragChunks = unlimitedSteps
    ? Math.max(0, Number.isFinite(rawRagChunks) ? Math.floor(rawRagChunks) : 8)
    : Math.max(0, Math.min(500, Number.isFinite(rawRagChunks) ? Math.floor(rawRagChunks) : 8));
  const contextLimit = Math.max(0, Number(body?.contextLimit ?? 0) || 0);

  let ragContext = "";
  let ragMeta: { folderName: string; hits: number; totalChunks: number; ragFull: boolean; truncated: boolean } | null =
    null;

  if (ragFolderId > 0 && (ragFull || ragChunks > 0)) {
    const folder = await getRagFolder(me.id, ragFolderId);
    if (folder) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
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
          const usedTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
          const budgetChars =
            contextLimit > 0
              ? ragBudgetChars(contextLimit, usedTokens, 1024, unlimitedSteps)
              : unlimitedSteps
                ? Number.MAX_SAFE_INTEGER
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
            contextLimit > 0
              ? ragBudgetChars(contextLimit, 0, 1024, unlimitedSteps)
              : unlimitedSteps
                ? Number.MAX_SAFE_INTEGER
                : RAG_FULL_MAX_CHARS;
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

  const params = normalizeGenParams(body?.params, { unlimited: unlimitedSteps });
  const maxSteps = resolveStepsForRole(me.role, body?.maxSteps, unlimitedSteps ? 0 : AGENT_MAX_STEPS);
  const trustLevel = normalizeTrustLevel(body?.trustLevel);
  const runId = typeof body?.runId === "string" && body.runId.trim() ? body.runId.trim().slice(0, 80) : undefined;
  const systemPrompt =
    typeof body?.systemPrompt === "string"
      ? unlimitedSteps
        ? body.systemPrompt.trim()
        : body.systemPrompt.trim().slice(0, 12_000)
      : "";

  const savedSettings = await getAiUserSettingsSecret(me.id).catch(() => ({ baseUrl: "", model: "", apiKey: "" }));
  const baseUrl = normalizeBaseUrl(body?.settings?.baseUrl || savedSettings.baseUrl || "") ?? undefined;
  if (baseUrl) {
    try {
      await assertSafeAiUrl(baseUrl);
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

  const payload = {
    messages,
    attachments,
    params,
    ownerUserId: me.id,
    ...(systemPrompt ? { systemPrompt } : {}),
    maxSteps,
    unlimited: unlimitedSteps,
    trustLevel,
    ...(runId ? { runId } : {}),
    settings: {
      baseUrl,
      apiKey: ((body?.settings?.apiKey ?? "").trim() || savedSettings.apiKey).slice(0, 400),
      model: ((body?.settings?.model ?? "").trim() || savedSettings.model).slice(0, 200),
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

  let upstream: Response;
  try {
    upstream = await fetch(`${agentUrl}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(900_000),
    });
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
  const modelName = payload.settings.model || "";
  const upstreamReader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let sseBuffer = "";
  let textLatest = "";
  let reasoningLatest = "";
  let reportedPrompt = 0;
  let reportedCompletion = 0;
  let reportedTotal = 0;
  let recorded = false;

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
        model: modelName,
        prompt: promptTokens,
        completion: completionTokens,
        total: totalTokens,
      }).catch(() => undefined);
    }
  };

  const processFrame = (frame: string): string => {
    const evLine = frame.split("\n").find((l) => l.startsWith("event:"));
    const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) return `${frame}\n\n`;
    const ev = evLine ? evLine.slice(6).trim() : "message";
    try {
      const parsed = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
      if (ev === "text" && typeof parsed.text === "string") {
        textLatest = parsed.text;
      } else if (ev === "reasoning" && typeof parsed.text === "string") {
        reasoningLatest = parsed.text;
      } else if (ev === "approval_required") {
        const approvalId = typeof parsed.approvalId === "string" ? parsed.approvalId.trim() : "";
        const nonce = typeof parsed.nonce === "string" ? parsed.nonce.trim() : "";
        if (approvalId && nonce) {
          registerAgentApproval(approvalId, me.id, nonce);
        }
        delete parsed.nonce;
        return `event: ${ev}\ndata: ${JSON.stringify(parsed)}\n\n`;
      } else if (ev === "done" && parsed.usage && typeof parsed.usage === "object") {
        const u = parsed.usage as Record<string, unknown>;
        reportedPrompt = Math.max(reportedPrompt, Math.round(Number(u.prompt_tokens ?? u.promptTokens ?? 0) || 0));
        reportedCompletion = Math.max(
          reportedCompletion,
          Math.round(Number(u.completion_tokens ?? u.completionTokens ?? 0) || 0),
        );
        reportedTotal = Math.max(reportedTotal, Math.round(Number(u.total_tokens ?? u.totalTokens ?? 0) || 0));
      }
    } catch {
      /* ignore malformed SSE frame */
    }
    return `${frame}\n\n`;
  };

  const transformChunk = (chunkText: string, controller: ReadableStreamDefaultController<Uint8Array>) => {
    sseBuffer += chunkText;
    let sep = sseBuffer.indexOf("\n\n");
    while (sep !== -1) {
      const frame = sseBuffer.slice(0, sep);
      sseBuffer = sseBuffer.slice(sep + 2);
      sep = sseBuffer.indexOf("\n\n");
      if (frame.trim()) {
        controller.enqueue(encoder.encode(processFrame(frame)));
      }
    }
  };

  const trackedStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await upstreamReader.read();
        if (done) {
          transformChunk(decoder.decode(), controller);
          if (sseBuffer.trim()) {
            controller.enqueue(encoder.encode(processFrame(sseBuffer)));
            sseBuffer = "";
          }
          await flushUsage();
          controller.close();
          return;
        }
        transformChunk(decoder.decode(value, { stream: true }), controller);
      } catch (err) {
        await flushUsage();
        controller.error(err);
      }
    },
    async cancel() {
      await upstreamReader.cancel().catch(() => undefined);
      await flushUsage();
    },
  });

  return new Response(trackedStream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
