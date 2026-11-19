import { findAgentTokenOwner } from "@/db/repo";

/**
 * Проверка бота-оператора: он присылает токен в заголовке `x-agent-token`.
 * Возвращает id пользователя-владельца токена или null.
 */
export async function botOwner(req: Request): Promise<number | null> {
  const token = (req.headers.get("x-agent-token") ?? "").trim();
  if (!token) return null;
  return findAgentTokenOwner(token);
}
