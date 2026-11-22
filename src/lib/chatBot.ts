import {
  getAiQuotaOverride,
  getAiUsage,
  getChatBot,
  getChatRoomForUser,
  getUser,
  insertMessage,
  listMessages,
  recordAiUsage,
  touchChatRoom,
  type ChatBotRow,
} from "@/db/repo";
import { aiAuthHeaders, aiEndpoint, estimateTokens, normalizeBaseUrl } from "@/lib/ai";
import { aiPolicyFor, formatTokenCount } from "@/lib/aiPolicy";
import { publishChatMessage } from "@/lib/events";
import { applyGenParams, normalizeGenParams, type GenParams } from "@/lib/genParams";
import { safeAiFetch } from "@/lib/ssrf";

export type PublicChatBot = {
  userId: number;
  name: string;
  position: string | null;
  bio: string | null;
  avatarColor: string;
  avatarUrl: string | null;
  model: string;
  replyMode: "mention" | "always";
  isActive: boolean;
  provider?: string;
  baseUrl?: string;
  hasApiKey?: boolean;
  apiKeyHint?: string;
  systemPrompt?: string;
  params?: GenParams;
  createdAt: string;
  updatedAt: string;
};

function safeParseParams(raw: string): Partial<GenParams> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Partial<GenParams>) : {};
  } catch {
    return {};
  }
}

export function publicChatBot(bot: ChatBotRow, includeSecretConfig: boolean): PublicChatBot {
  const base: PublicChatBot = {
    userId: bot.userId,
    name: bot.name,
    position: bot.position,
    bio: bot.bio,
    avatarColor: bot.avatarColor,
    avatarUrl: bot.avatarUrl,
    model: bot.model,
    replyMode: bot.replyMode,
    isActive: bot.isActive,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
  };
  if (!includeSecretConfig) return base;
  return {
    ...base,
    provider: bot.provider,
    baseUrl: bot.baseUrl,
    hasApiKey: Boolean(bot.apiKey),
    apiKeyHint: bot.apiKey ? `…${bot.apiKey.slice(-4)}` : "",
    systemPrompt: bot.systemPrompt,
    params: normalizeGenParams(safeParseParams(bot.paramsJson), { unlimited: true }),
  };
}

/**
 * Выбор ботов, которым нужно ответить на сообщение:
 *   - в ЛС (`isDm`) — конкретный бот;
 *   - при явном `triggerBotId` — только выбранный бот;
 *   - в группе / общем чате: срабатывают боты с явным `@упоминанием`, плюс не более
 *     ОДНОГО бота в режиме `always` (чтобы несколько авто-ботов не зациклились и
 *     не сжигали квоту шквалом параллельных ответов).
 */
export function findTriggeredBots(
  bots: ChatBotRow[],
  content: string,
  opts: { isDm?: boolean; triggerBotId?: number } = {},
): number[] {
  const active = bots.filter((b) => b.isActive);
  if (active.length === 0) return [];
  if (opts.isDm) return active.map((b) => b.userId);
  if (opts.triggerBotId && opts.triggerBotId > 0) {
    const chosen = active.find((b) => b.userId === opts.triggerBotId);
    return chosen ? [chosen.userId] : [];
  }
  const lower = content.toLowerCase();
  const ids: number[] = [];
  let alwaysAutoCount = 0;
  for (const bot of active) {
    const nameNeedle = `@${bot.name.trim().toLowerCase()}`;
    const mentioned =
      (bot.name.trim() && lower.includes(nameNeedle)) ||
      lower.includes("@бот") ||
      lower.includes("@модель");
    if (mentioned) {
      ids.push(bot.userId);
      continue;
    }
    if (bot.replyMode === "always" && alwaysAutoCount < 1) {
      ids.push(bot.userId);
      alwaysAutoCount += 1;
    }
  }
  return ids;
}

export async function runChatBotReply(input: {
  botUserId: number;
  requesterId: number;
  peerId: number;
  roomId: number | null;
}): Promise<{ ok: true; messageId: number } | { ok: false; error: string }> {
  const bot = await getChatBot(input.botUserId);
  if (!bot) return { ok: false, error: "Бот не найден" };
  if (!bot.isActive) return { ok: false, error: "Бот сейчас выключен" };

  // Проверяем месячную квоту ИИ запрашивающего сотрудника (P1).
  const requester = await getUser(input.requesterId);
  if (requester) {
    const override = await getAiQuotaOverride(requester.id);
    const policy = aiPolicyFor(requester.role, override?.monthlyLimit ?? null);
    const monthUsage = await getAiUsage(requester.id);
    if (policy.monthlyTokens !== null && monthUsage.month.total >= policy.monthlyTokens) {
      return {
        ok: false,
        error: `Месячный лимит токенов исчерпан (${formatTokenCount(monthUsage.month.total)} из ${formatTokenCount(policy.monthlyTokens)}).`,
      };
    }
  }

  const baseUrl = normalizeBaseUrl(bot.baseUrl || process.env.AI_BASE_URL || "");
  const model = (bot.model || process.env.AI_MODEL || "").trim();
  const apiKey = (bot.apiKey || process.env.AI_API_KEY || "").trim();

  if (!baseUrl || !model) {
    return {
      ok: false,
      error: "Главный администратор ещё не настроил Base URL и модель для этого бота.",
    };
  }

  const room = input.roomId ? await getChatRoomForUser(input.requesterId, input.roomId) : null;
  if (input.roomId && !room) {
    return { ok: false, error: "Нет доступа к этому чату" };
  }

  const historyPeer = input.roomId ? 0 : input.peerId;
  const { messages: recent } = await listMessages(
    input.requesterId,
    historyPeer,
    0,
    24,
    input.roomId ?? 0,
  );

  const scopeHint = room
    ? `Ты участвуешь в командном чате «${room.name}» (${room.kind === "shared" ? "общий чат" : "группа"}). Участники: ${room.members.map((m) => m.name).join(", ")}.`
    : input.peerId === 0
      ? "Ты участвуешь в общем командном чате CRM."
      : "Ты общаешься в личной переписке с сотрудником CRM.";

  const systemParts = [
    bot.systemPrompt.trim() ||
      "Ты — полезный ИИ-помощник и участник командного чата в корпоративной CRM. Отвечай чётко, по делу и на русском языке, если не попросили иначе.",
    `Твоё имя в чате: ${bot.name}. ${scopeHint}`,
  ];

  const llmMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemParts.join("\n\n") },
  ];

  for (const msg of recent) {
    const text = msg.content.trim() || (msg.attachment ? `[Файл: ${msg.attachment.name}]` : "");
    if (!text) continue;
    if (msg.senderId === bot.userId) {
      llmMessages.push({ role: "assistant", content: text });
    } else if (input.roomId || input.peerId === 0) {
      llmMessages.push({ role: "user", content: `[${msg.senderName}]: ${text}` });
    } else {
      llmMessages.push({ role: "user", content: text });
    }
  }

  const params = normalizeGenParams(safeParseParams(bot.paramsJson), { unlimited: true });
  const buildBody = (withParams: boolean) => {
    const payload: Record<string, unknown> = {
      model,
      messages: llmMessages,
      temperature: 0.4,
      stream: false,
    };
    if (withParams) {
      applyGenParams(payload, params, { unlimited: true });
    }
    return payload;
  };

  let res: Response;
  try {
    res = await safeAiFetch(aiEndpoint(baseUrl, "/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...aiAuthHeaders(apiKey) },
      body: JSON.stringify(buildBody(true)),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok && (res.status === 400 || res.status === 422)) {
      res = await safeAiFetch(aiEndpoint(baseUrl, "/chat/completions"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...aiAuthHeaders(apiKey) },
        body: JSON.stringify(buildBody(false)),
        signal: AbortSignal.timeout(45_000),
      });
    }
  } catch (err) {
    return {
      ok: false,
      error: `Не удалось подключиться к модели бота: ${err instanceof Error ? err.message : "ошибка сети"}`,
    };
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return {
      ok: false,
      error: `Модель бота ответила ошибкой HTTP ${res.status}${errText ? `: ${errText.slice(0, 200)}` : ""}`,
    };
  }

  const data = (await res.json().catch(() => null)) as
    | {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      }
    | null;
  const reply = String(data?.choices?.[0]?.message?.content ?? "").trim();
  if (!reply) {
    return { ok: false, error: "Модель бота вернула пустой ответ" };
  }

  const promptEst = llmMessages.reduce((s, m) => s + estimateTokens(m.content) + 4, 4);
  const compEst = estimateTokens(reply);
  const promptTokens = Number(data?.usage?.prompt_tokens ?? 0) || promptEst;
  const completionTokens = Number(data?.usage?.completion_tokens ?? 0) || compEst;
  await recordAiUsage({
    userId: input.requesterId,
    chatId: 0,
    prompt: promptTokens,
    completion: completionTokens,
  }).catch(() => undefined);

  const recipientId = input.roomId ? null : input.peerId === 0 ? null : input.requesterId;
  const messageId = await insertMessage(bot.userId, recipientId, reply, input.roomId);
  if (input.roomId) {
    await touchChatRoom(input.roomId);
  }

  publishChatMessage({
    messageId,
    senderId: bot.userId,
    senderName: bot.name,
    senderColor: bot.avatarColor,
    recipientId,
    roomId: input.roomId,
    roomName: room?.name ?? null,
    isSharedRoom: room ? room.kind === "shared" : false,
    memberIds: room ? room.members.map((m) => m.userId) : undefined,
    preview: reply.slice(0, 160),
  });

  return { ok: true, messageId };
}
