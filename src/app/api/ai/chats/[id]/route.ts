import { getCurrentUser } from "@/lib/auth";
import { getAiChat, getAiQuotaOverride, listAiChatMessages } from "@/db/repo";
import { aiPolicyFor } from "@/lib/aiPolicy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/ai/chats/[id]` — сообщения чата и остаток токенов. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const id = Number((await params).id);
  if (!Number.isFinite(id) || id <= 0) return Response.json({ error: "Некорректный чат" }, { status: 400 });

  const chat = await getAiChat(me.id, id);
  if (!chat) return Response.json({ error: "Чат не найден" }, { status: 404 });

  const override = await getAiQuotaOverride(me.id);
  const policy = aiPolicyFor(me.role, override?.monthlyLimit ?? null);

  return Response.json({
    chat: {
      ...chat,
      tokensLeft: Math.max(policy.perChatTokens - chat.tokensTotal, 0),
      tokensLimit: policy.perChatTokens,
    },
    messages: await listAiChatMessages(id),
  });
}
