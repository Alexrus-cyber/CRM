import {
  createAiChat,
  getAiChat,
  getAiQuotaOverride,
  getAiUsage,
  getRagFolder,
  insertAiChatMessage,
  listRagChunks,
  recordAiUsage,
  renameAiChat,
  searchRagChunks,
  type AiChatRow,
} from "@/db/repo";
import { estimateTokens, normalizeParams, type AiParams } from "@/lib/ai";
import { aiPolicyFor, formatTokenCount, reasoningAllowed, type AiRolePolicy } from "@/lib/aiPolicy";
import { getRequestUser } from "@/lib/auth";
import { RAG_FULL_MAX_CHARS, formatFullRagContext, formatRagContext, ragBudgetChars, type FullRagContext } from "@/lib/rag";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";

/**
 * Мост «Чат с моделью» для настольного Harness-приложения (`.exe`),
 * когда пользователь обращается к локальной модели (`127.0.0.1` / LAN) на своём ПК,
 * до которой удалённый сервер CRM не может достучаться напрямую:
 *   - `action: "prepare"` — проверяет лимиты роли/чата, открывает/создаёт чат,
 *     собирает RAG-контекст и возвращает политику;
 *   - `action: "record"` — сохраняет сообщения и учитывает токены в БД CRM.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_RAG_CONTEXT_CHARS = 12_000;
const RAG_FULL_RESERVE_TOKENS = 1_024;

export async function POST(req: Request) {
  const me = await getRequestUser(req);
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const rl = checkApiRateLimit({
    scope: "launcher_chat",
    userId: me.id,
    ip: extractClientIp(req.headers),
    maxRequests: 90,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = String(body?.action ?? "");
  const unlimited = me.role === "super_admin";

  const override = await getAiQuotaOverride(me.id);
  const policy: AiRolePolicy = aiPolicyFor(me.role, override?.monthlyLimit ?? null);
  const perChatLimit = policy.perChatTokens !== null && policy.perChatTokens > 0 ? policy.perChatTokens : null;

  if (action === "prepare") {
    let params: AiParams = normalizeParams(body?.params, { unlimited });
    let reasoningDowngraded = false;
    if (!reasoningAllowed(policy, params.reasoning)) {
      reasoningDowngraded = true;
      params = {
        ...params,
        reasoning: policy.reasoning.includes("low") ? "low" : policy.reasoning[0],
        thinkingBudget: null,
      };
    }

    const ragFolderId = Number(body?.ragFolderId ?? 0) || 0;
    if (ragFolderId > 0 && !policy.rag) {
      return Response.json(
        { error: `RAG-папка недоступна для роли «${me.role}». Модель ответит без документов.` },
        { status: 403 },
      );
    }

    let chatId = Number(body?.chatId ?? 0) || 0;
    let chat: AiChatRow | null = null;
    if (chatId > 0) {
      chat = await getAiChat(me.id, chatId);
      if (!chat) return Response.json({ error: "Чат не найден" }, { status: 404 });
      if (policy.perChatTokens !== null && policy.perChatTokens > 0 && chat.tokensTotal >= policy.perChatTokens) {
        return Response.json(
          {
            error:
              `В этом чате закончился лимит токенов (${formatTokenCount(chat.tokensTotal)} из ` +
              `${formatTokenCount(policy.perChatTokens)}). Нажмите «Новый чат» — счётчик обнулится.`,
          },
          { status: 403 },
        );
      }
    } else {
      chat = await createAiChat(me.id);
      chatId = chat.id;
    }

    const monthUsage = await getAiUsage(me.id);
    if (policy.monthlyTokens !== null && monthUsage.month.total >= policy.monthlyTokens) {
      return Response.json(
        {
          error:
            `Месячный лимит токенов исчерпан (${formatTokenCount(monthUsage.month.total)} из ` +
            `${formatTokenCount(policy.monthlyTokens)}). Расширить лимит на этот месяц может администратор.`,
        },
        { status: 403 },
      );
    }

    const ragQuery = String(body?.ragQuery ?? "").trim();
    const usedTokensEst = Math.max(0, Math.floor(Number(body?.historyTokens ?? 0) || 0));
    let ragContext = "";
    let ragHits = 0;
    let ragFull: (FullRagContext & { total: number; budgetChars: number; contextLimit: number }) | null = null;

    if (ragFolderId > 0 && (params.ragFull || params.ragChunks > 0)) {
      const folder = await getRagFolder(me.id, ragFolderId);
      if (folder) {
        if (params.ragFull) {
          const chunks = await listRagChunks(ragFolderId);
          if (chunks.length > 0) {
            const relevant = ragQuery ? await searchRagChunks(ragFolderId, ragQuery, chunks.length) : [];
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
            const completionReserve =
              params.contextLimit > 0
                ? Math.min(
                    params.maxTokens ?? RAG_FULL_RESERVE_TOKENS,
                    Math.max(1_024, Math.floor(params.contextLimit * 0.75)),
                  )
                : Math.min(params.maxTokens ?? RAG_FULL_RESERVE_TOKENS, 32_768);
            const safetyTokens =
              params.contextLimit > 0 ? Math.max(1_024, Math.floor(params.contextLimit * 0.08)) : 1_024;
            const budgetChars =
              params.contextLimit > 0
                ? ragBudgetChars(params.contextLimit, usedTokensEst, completionReserve + safetyTokens, unlimited)
                : RAG_FULL_MAX_CHARS;
            const packed = formatFullRagContext(ordered, budgetChars);
            if (packed.used > 0) {
              ragContext = packed.text;
              ragHits = packed.used;
              ragFull = { ...packed, total: ordered.length, budgetChars, contextLimit: params.contextLimit };
            }
          }
        } else if (ragQuery) {
          const hits = await searchRagChunks(ragFolderId, ragQuery, params.ragChunks);
          if (hits.length > 0) {
            const maxChars = unlimited
              ? Math.min(RAG_FULL_MAX_CHARS, Math.max(24_000, params.ragChunks * 2_400))
              : MAX_RAG_CONTEXT_CHARS;
            ragContext = formatRagContext(hits, maxChars);
            ragHits = hits.length;
          }
        }
      }
    }

    return Response.json(
      {
        ok: true,
        chat: {
          ...chat,
          tokensLeft: perChatLimit === null ? null : Math.max(perChatLimit - chat.tokensTotal, 0),
          tokensLimit: perChatLimit,
        },
        params,
        reasoningDowngraded,
        ragContext,
        ragHits,
        ragFull,
        monthly: {
          used: monthUsage.month.total,
          limit: policy.monthlyTokens,
          left: policy.monthlyTokens === null ? null : Math.max(policy.monthlyTokens - monthUsage.month.total, 0),
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (action === "record") {
    const chatId = Number(body?.chatId ?? 0) || 0;
    if (!chatId) return Response.json({ error: "Не указан chatId" }, { status: 400 });
    const chat = await getAiChat(me.id, chatId);
    if (!chat) return Response.json({ error: "Чат не найден" }, { status: 404 });

    const userMessage = String(body?.userMessage ?? "");
    const answer = String(body?.answer ?? "");
    const thinking = String(body?.thinking ?? "");
    let attachmentsJson = "[]";
    if (Array.isArray(body?.attachments)) {
      const items = unlimited ? body.attachments : body.attachments.slice(0, 8);
      const serialized = JSON.stringify(
        items.map((item) => {
          const meta = (item ?? {}) as { name?: unknown; kind?: unknown; size?: unknown; note?: unknown };
          return {
            name: String(meta.name ?? "").slice(0, 200),
            kind: String(meta.kind ?? "text").slice(0, 20),
            size: Number(meta.size ?? 0) || 0,
            note: String(meta.note ?? "").slice(0, 200),
          };
        }),
      );
      attachmentsJson = unlimited ? serialized : serialized.slice(0, 4000);
    }

    const rawPrompt = Math.max(0, Math.round(Number(body?.promptTokens ?? 0) || 0));
    const rawCompletion = Math.max(0, Math.round(Number(body?.completionTokens ?? 0) || 0));
    const prompt = rawPrompt > 0 ? rawPrompt : estimateTokens(userMessage);
    const completion = rawCompletion > 0 ? rawCompletion : estimateTokens(answer);
    const total = Math.max(prompt + completion, Math.round(Number(body?.totalTokens ?? 0) || 0));

    if (userMessage.trim() || attachmentsJson !== "[]") {
      await insertAiChatMessage({ chatId, role: "user", content: userMessage, attachments: attachmentsJson });
    }
    if (answer.trim()) {
      await insertAiChatMessage({
        chatId,
        role: "assistant",
        content: answer,
        reasoning: thinking,
        tokens: total,
        promptTokens: prompt,
        completionTokens: completion,
      });
    }
    if (chat.title === "Новый чат" && userMessage.trim()) {
      await renameAiChat(me.id, chatId, userMessage.trim().slice(0, 60));
    }
    const fresh = await recordAiUsage({ userId: me.id, chatId, prompt, completion });
    return Response.json(
      {
        ok: true,
        usage: { prompt, completion, total, estimated: !body?.usageReported },
        chat: fresh.chat
          ? {
              ...fresh.chat,
              tokensLeft: perChatLimit === null ? null : Math.max(perChatLimit - fresh.chat.tokensTotal, 0),
              tokensLimit: perChatLimit,
            }
          : null,
        monthly: {
          used: fresh.month.total,
          limit: policy.monthlyTokens,
          left: policy.monthlyTokens === null ? null : Math.max(policy.monthlyTokens - fresh.month.total, 0),
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json({ error: "Укажите action: prepare или record" }, { status: 400 });
}
