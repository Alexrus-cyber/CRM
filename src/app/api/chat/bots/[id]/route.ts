import { deleteChatBot, getChatBot, updateChatBot } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { publicChatBot } from "@/lib/chatBot";
import { publishLiveEvent } from "@/lib/events";
import { normalizeGenParams } from "@/lib/genParams";
import { chatBotPatchSchema, readValidatedJson } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "super_admin") {
    return Response.json(
      { error: "Настраивать модели (ботов) может только главный администратор" },
      { status: 403 },
    );
  }

  const botUserId = Number((await params).id) || 0;
  if (!botUserId) return Response.json({ error: "Некорректный ID бота" }, { status: 400 });

  const existing = await getChatBot(botUserId);
  if (!existing) return Response.json({ error: "Бот не найден" }, { status: 404 });

  const parsed = await readValidatedJson(req, chatBotPatchSchema, "Пустой запрос");
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const avatarColor =
    body.avatarColor !== undefined && /^#[0-9a-fA-F]{6}$/.test(body.avatarColor)
      ? body.avatarColor
      : undefined;

  const updated = await updateChatBot(botUserId, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.position !== undefined ? { position: body.position } : {}),
    ...(body.bio !== undefined ? { bio: body.bio } : {}),
    ...(avatarColor ? { avatarColor } : {}),
    ...(body.provider !== undefined ? { provider: body.provider } : {}),
    ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
    ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
    ...(body.clearApiKey ? { clearApiKey: true } : {}),
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.systemPrompt !== undefined ? { systemPrompt: body.systemPrompt } : {}),
    ...(body.params !== undefined
      ? { paramsJson: JSON.stringify(normalizeGenParams(body.params, { unlimited: true })) }
      : {}),
    ...(body.replyMode !== undefined
      ? { replyMode: body.replyMode === "always" ? "always" : "mention" }
      : {}),
    ...(body.isActive !== undefined ? { isActive: Boolean(body.isActive) } : {}),
  });

  if (!updated) return Response.json({ error: "Бот не найден" }, { status: 404 });
  publishLiveEvent("users", me.id);
  return Response.json(
    { bot: publicChatBot(updated, true) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "super_admin") {
    return Response.json(
      { error: "Удалять модели (ботов) может только главный администратор" },
      { status: 403 },
    );
  }

  const botUserId = Number((await params).id) || 0;
  if (!botUserId) return Response.json({ error: "Некорректный ID бота" }, { status: 400 });

  const deleted = await deleteChatBot(botUserId);
  if (!deleted) return Response.json({ error: "Бот не найден" }, { status: 404 });
  publishLiveEvent("users", me.id);
  return Response.json({ ok: true });
}
