import { getCurrentUser } from "@/lib/auth";
import { createAiChat, deleteAiChat, getAiQuotaOverride, listAiChats } from "@/db/repo";
import { aiPolicyFor } from "@/lib/aiPolicy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Список чатов с остатком токенов в каждом — история чатов ИИ. */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const [chats, override] = await Promise.all([listAiChats(me.id, 100), getAiQuotaOverride(me.id)]);
  const policy = aiPolicyFor(me.role, override?.monthlyLimit ?? null);
  return Response.json({
    chats: chats.map((chat) => ({
      ...chat,
      tokensLeft: Math.max(policy.perChatTokens - chat.tokensTotal, 0),
      tokensLimit: policy.perChatTokens,
    })),
    perChatTokens: policy.perChatTokens,
  });
}

/** Новый чат: счётчик токенов начинается с нуля. */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let title = "Новый чат";
  try {
    const body = (await req.json()) as { title?: string };
    if (body.title?.trim()) title = body.title.trim().slice(0, 120);
  } catch {
    /* пустое тело — обычный новый чат */
  }

  const [chat, override] = await Promise.all([createAiChat(me.id, title), getAiQuotaOverride(me.id)]);
  const policy = aiPolicyFor(me.role, override?.monthlyLimit ?? null);
  return Response.json({
    chat: { ...chat, tokensLeft: policy.perChatTokens, tokensLimit: policy.perChatTokens },
  });
}

/** `DELETE /api/ai/chats?id=N` — удалить чат вместе с сообщениями. */
export async function DELETE(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const id = Number(new URL(req.url).searchParams.get("id") ?? 0);
  if (!id) return Response.json({ error: "Не указан чат" }, { status: 400 });
  const ok = await deleteAiChat(me.id, id);
  if (!ok) return Response.json({ error: "Чат не найден" }, { status: 404 });
  return Response.json({ ok: true });
}
