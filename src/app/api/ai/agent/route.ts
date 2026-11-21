import { getRagFolder, listRagChunks, searchRagChunks } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { estimateTokens, normalizeBaseUrl } from "@/lib/ai";
import { AGENT_MAX_STEPS, isUnlimitedStepsRole, normalizeGenParams, resolveStepsForRole } from "@/lib/genParams";
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

export const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8899").replace(/\/+$/, "");
const START_HINT =
  "Запустите агента в папке проекта: python3 agent/agent.py (или задайте AGENT_URL, если он на другом хосте)";

function allowed(role: string): boolean {
  return role === "super_admin";
}

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!allowed(me.role)) {
    return Response.json({ error: "Агент доступен только главному администратору" }, { status: 403 });
  }

  try {
    const res = await fetch(`${AGENT_URL}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return Response.json({ available: false, endpoint: AGENT_URL, hint: START_HINT });
    }
    const data = (await res.json()) as Record<string, unknown>;
    return Response.json(
      { available: true, endpoint: AGENT_URL, ...data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ available: false, endpoint: AGENT_URL, hint: START_HINT });
  }
}

type IncomingMessage = { role?: string; content?: string };
type IncomingAttachment = { name?: string; text?: string; note?: string; image?: string };

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!allowed(me.role)) {
    return Response.json({ error: "Агент доступен только главному администратору" }, { status: 403 });
  }

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

  const baseUrl = normalizeBaseUrl(body?.settings?.baseUrl ?? "") ?? undefined;
  const payload = {
    messages,
    attachments,
    params,
    ...(systemPrompt ? { systemPrompt } : {}),
    maxSteps,
    unlimited: unlimitedSteps,
    trustLevel,
    ...(runId ? { runId } : {}),
    settings: {
      baseUrl,
      apiKey: (body?.settings?.apiKey ?? "").trim().slice(0, 400),
      model: (body?.settings?.model ?? "").trim().slice(0, 200),
    },
    context: {
      user: me.name,
      roleLabel: ROLE_LABELS[me.role] ?? me.role,
      today: new Date().toISOString().slice(0, 10),
      ...(ragContext ? { ragContext, ragMeta } : {}),
    },
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${AGENT_URL}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(900_000),
    });
  } catch {
    return Response.json({ error: `Агент не запущен. ${START_HINT}`, hint: START_HINT }, { status: 503 });
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return Response.json(
      { error: `Агент ответил ошибкой ${upstream.status}${text ? `: ${text.slice(0, 300)}` : ""}` },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
