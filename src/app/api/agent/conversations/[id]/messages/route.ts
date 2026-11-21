import { getAgentConversation, insertAgentConversationMessage } from "@/db/repo";
import { hasAgentAccess, hasOperatorAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_CONTENT = 50_000;
const MAX_REASONING = 50_000;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(2_147_483_647, Math.round(number))) : 0;
}

/** Файлы намеренно хранятся только как имена и размеры — без base64-содержимого. */
function cleanFileMetadata(value: unknown): Array<{ name: string; mime: string; size: number }> {
  if (!Array.isArray(value)) return [];
  return value.filter(isDict).map((item) => ({
    name: String(item.name ?? "файл").slice(0, 240),
    mime: String(item.mime ?? "application/octet-stream").slice(0, 160),
    size: boundedNumber(item.size),
  }));
}

function cleanAttachments(value: unknown): Array<{ name: string; size: number; mime?: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter(isDict).map((item) => ({
    name: String(item.name ?? "файл").slice(0, 240),
    size: boundedNumber(item.size),
    ...(typeof item.mime === "string" ? { mime: item.mime.slice(0, 160) } : {}),
  }));
}

function cleanActions(value: unknown): Array<{ type: "open_url"; url: string; label: string; autoplay: boolean }> {
  if (!Array.isArray(value)) return [];
  const actions: Array<{ type: "open_url"; url: string; label: string; autoplay: boolean }> = [];
  for (const item of value) {
    if (!isDict(item) || item.type !== "open_url") continue;
    const rawUrl = String(item.url ?? "").slice(0, 2_048);
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      actions.push({
        type: "open_url",
        url: url.toString(),
        label: String(item.label ?? url.toString()).slice(0, 300),
        autoplay: Boolean(item.autoplay),
      });
    } catch {
      // Не сохраняем некорректную или небезопасную ссылку.
    }
  }
  return actions;
}

async function operatorUser() {
  const user = await getCurrentUser();
  if (!user) return { response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!hasAgentAccess(user) && !hasOperatorAccess(user)) {
    return { response: Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 }) };
  }
  return { user };
}

/** Сохранить завершённое сообщение в истории конкретного чата. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await operatorUser();
  if (auth.response) return auth.response;

  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return Response.json({ error: "Некорректный чат" }, { status: 400 });
  }
  const conversation = await getAgentConversation(auth.user.id, id);
  if (!conversation) return Response.json({ error: "Чат не найден" }, { status: 404 });
  if (conversation.kind === "agent" ? !hasAgentAccess(auth.user) : !hasOperatorAccess(auth.user)) {
    return Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | {
        role?: string;
        content?: string;
        reasoning?: string;
        attachments?: unknown;
        actions?: unknown;
        files?: unknown;
        error?: string;
      }
    | null;
  if (!body || (body.role !== "user" && body.role !== "assistant") || typeof body.content !== "string") {
    return Response.json({ error: "Некорректное сообщение" }, { status: 400 });
  }

  const message = await insertAgentConversationMessage({
    userId: auth.user.id,
    conversationId: id,
    role: body.role,
    content: body.content,
    reasoning: String(body.reasoning ?? ""),
    attachments: JSON.stringify(cleanAttachments(body.attachments)),
    actions: JSON.stringify(cleanActions(body.actions)),
    files: JSON.stringify(cleanFileMetadata(body.files)),
    error: String(body.error ?? "").slice(0, 10_000),
  });
  if (!message) return Response.json({ error: "Чат не найден" }, { status: 404 });
  return Response.json({ message }, { headers: { "Cache-Control": "no-store" } });
}
