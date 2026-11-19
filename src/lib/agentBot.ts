import { findAgentTokenOwner } from "@/db/repo";

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
 * или null.
 */
export async function botOwner(req: Request): Promise<number | null> {
  const token = readAgentToken(req);
  if (!token) return null;
  return findAgentTokenOwner(token);
}
