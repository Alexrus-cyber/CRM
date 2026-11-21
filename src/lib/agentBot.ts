import { findAgentTokenOwner, getUser } from "@/db/repo";
import { hasOperatorAccess } from "@/lib/aiPolicy";

/** Заголовок с токеном: основной и запасной вариант (Bearer). */
const HEADERS = ["x-agent-token", "authorization"] as const;

/**
 * Токен из запроса бота — без пробелов и кавычек: его часто вставляют из
 * терминала или мессенджера, где он обрастает `"`, `'` и переносами строки.
 */
export function readAgentToken(req: Request): string {
  for (const header of HEADERS) {
    const raw = (req.headers.get(header) ?? "").trim();
    if (!raw) continue;
    const token = raw.replace(/^bearer\s+/i, "").replace(/["'\s]/g, "");
    if (token) return token;
  }
  return "";
}

/**
 * Проверка бота-оператора: он присылает токен в заголовке `x-agent-token`
 * (или `Authorization: Bearer`). Возвращает id пользователя-владельца токена
 * только если у владельца выдан доступ к Оператору.
 */
export async function botOwner(req: Request, options?: { touch?: boolean }): Promise<number | null> {
  const token = readAgentToken(req);
  if (!token) return null;
  const ownerId = await findAgentTokenOwner(token, options);
  if (!ownerId) return null;
  const user = await getUser(ownerId);
  if (!hasOperatorAccess(user)) return null;
  return ownerId;
}

/** Возвращает детали отказа для диагностики токена (/api/agent/bot/whoami). */
export async function inspectBotToken(
  req: Request,
  options?: { touch?: boolean },
): Promise<{ status: "ok"; ownerId: number } | { status: "invalid" } | { status: "forbidden"; ownerId: number }> {
  const token = readAgentToken(req);
  if (!token) return { status: "invalid" };
  const ownerId = await findAgentTokenOwner(token, options);
  if (!ownerId) return { status: "invalid" };
  const user = await getUser(ownerId);
  if (!hasOperatorAccess(user)) return { status: "forbidden", ownerId };
  return { status: "ok", ownerId };
}
