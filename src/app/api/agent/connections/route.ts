import {
  createAgentConnection,
  deleteAgentConnection,
  listAgentConnections,
  setDefaultAgentConnection,
  updateAgentConnection,
} from "@/db/repo";
import { hasOperatorAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";

/**
 * Подключения бота-оператора: адрес CRM, с которым работает бот.
 *
 * У пользователя их может быть несколько (свой сервер, тестовый, у заказчика),
 * токены живут внутри подключения — см. `/api/agent/tokens`.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_NAME = 60;
const MAX_SERVER = 400;

/** Адрес CRM: только http(s), без хвостового слэша. Пусто — берём текущий сервер. */
function normalizeServerUrl(raw: unknown, fallback: string): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function cleanName(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasOperatorAccess(me)) return Response.json({ error: "Доступ к Оператору не выдан главным администратором" }, { status: 403 });

  const connections = await listAgentConnections(me.id);
  return Response.json({ connections }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasOperatorAccess(me)) return Response.json({ error: "Доступ к Оператору не выдан главным администратором" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { name?: string; serverUrl?: string } | null;
  const name = cleanName(body?.name);
  const fallback = new URL(req.url).origin;
  const serverUrl = normalizeServerUrl(body?.serverUrl, fallback);
  if (!name) return Response.json({ error: "Укажите название подключения" }, { status: 400 });
  if (serverUrl === null) {
    return Response.json({ error: "Адрес CRM должен начинаться с http:// или https://" }, { status: 400 });
  }
  if (serverUrl.length > MAX_SERVER) return Response.json({ error: "Слишком длинный адрес" }, { status: 400 });

  try {
    const connection = await createAgentConnection(me.id, name, serverUrl);
    return Response.json({ connection });
  } catch (error) {
    const message = (error as Error).message ?? "";
    if (/unique|duplicate/i.test(message)) {
      return Response.json({ error: `Подключение «${name}» уже есть` }, { status: 409 });
    }
    throw error;
  }
}

export async function PATCH(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasOperatorAccess(me)) return Response.json({ error: "Доступ к Оператору не выдан главным администратором" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as
    | { id?: number; name?: string; serverUrl?: string; isDefault?: boolean }
    | null;
  const id = Number(body?.id ?? 0) || 0;
  if (!id) return Response.json({ error: "Не указано подключение" }, { status: 400 });

  if (body?.isDefault) {
    const ok = await setDefaultAgentConnection(me.id, id);
    if (!ok) return Response.json({ error: "Подключение не найдено" }, { status: 404 });
  }

  const name = body?.name !== undefined ? cleanName(body.name) : undefined;
  if (name !== undefined && !name) return Response.json({ error: "Название не может быть пустым" }, { status: 400 });
  const serverUrl =
    body?.serverUrl !== undefined ? normalizeServerUrl(body.serverUrl, "") : undefined;
  if (serverUrl === null) {
    return Response.json({ error: "Адрес CRM должен начинаться с http:// или https://" }, { status: 400 });
  }

  if (name !== undefined || serverUrl !== undefined) {
    try {
      const connection = await updateAgentConnection(me.id, id, { name, serverUrl });
      if (!connection) return Response.json({ error: "Подключение не найдено" }, { status: 404 });
      return Response.json({ connection });
    } catch (error) {
      const message = (error as Error).message ?? "";
      if (/unique|duplicate/i.test(message)) {
        return Response.json({ error: "Подключение с таким названием уже есть" }, { status: 409 });
      }
      throw error;
    }
  }

  const connections = await listAgentConnections(me.id);
  return Response.json({ connections });
}

export async function DELETE(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasOperatorAccess(me)) return Response.json({ error: "Доступ к Оператору не выдан главным администратором" }, { status: 403 });

  const id = Number(new URL(req.url).searchParams.get("id") ?? 0) || 0;
  if (!id) return Response.json({ error: "Не указано подключение" }, { status: 400 });

  const ok = await deleteAgentConnection(me.id, id);
  if (!ok) return Response.json({ error: "Подключение не найдено" }, { status: 404 });
  return Response.json({ ok: true });
}
