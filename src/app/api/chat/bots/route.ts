import { createChatBot, listChatBots } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { publicChatBot } from "@/lib/chatBot";
import { publishLiveEvent } from "@/lib/events";
import { normalizeGenParams } from "@/lib/genParams";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Список ботов-моделей доступен всем авторизованным пользователям (чтобы добавлять
 * настроенного бота в групповые/общие чаты). Секретные настройки (URL, API-ключ,
 * системный промпт) видит и редактирует только Главный администратор.
 */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const isSuperAdmin = me.role === "super_admin";
  const bots = await listChatBots();
  return Response.json(
    {
      bots: bots.map((b) => publicChatBot(b, isSuperAdmin)),
      canConfigure: isSuperAdmin,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Создание и настройка бота доступны ИСКЛЮЧИТЕЛЬНО главному администратору. */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "super_admin") {
    return Response.json(
      { error: "Настраивать и создавать модели (ботов) может только главный администратор" },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => null)) as
    | {
        name?: string;
        position?: string;
        bio?: string;
        avatarColor?: string;
        provider?: string;
        baseUrl?: string;
        apiKey?: string;
        model?: string;
        systemPrompt?: string;
        params?: unknown;
        replyMode?: string;
        isActive?: boolean;
      }
    | null;

  const name = String(body?.name ?? "").trim();
  if (!name) return Response.json({ error: "Укажите имя бота" }, { status: 400 });

  const avatarColor = /^#[0-9a-fA-F]{6}$/.test(String(body?.avatarColor ?? ""))
    ? String(body?.avatarColor)
    : "#06b6d4";
  const params = normalizeGenParams(body?.params, { unlimited: true });

  const created = await createChatBot({
    createdBy: me.id,
    name,
    position: body?.position ?? "ИИ-модель (бот)",
    bio: body?.bio ?? null,
    avatarColor,
    provider: body?.provider ?? "local",
    baseUrl: body?.baseUrl ?? "",
    apiKey: body?.apiKey ?? "",
    model: body?.model ?? "",
    systemPrompt: body?.systemPrompt ?? "",
    paramsJson: JSON.stringify(params),
    replyMode: body?.replyMode === "always" ? "always" : "mention",
    isActive: body?.isActive !== false,
  });

  publishLiveEvent("users", me.id);
  return Response.json(
    { bot: publicChatBot(created, true) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
