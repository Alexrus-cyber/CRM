import { getUser, listAgentTasks } from "@/db/repo";
import { botOwner, readAgentToken } from "@/lib/agentBot";

/**
 * Самопроверка токена бота: `GET /api/agent/bot/whoami`.
 *
 * Нужна, чтобы отличить «CRM не знает такой токен» от «CRM недоступна» и от
 * ошибки модели: бот вызывает этот маршрут флагом `--check`, а вкладка
 * «Оператор» — кнопкой «Проверить связь».
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const ownerId = await botOwner(req);
  if (!ownerId) {
    const token = readAgentToken(req);
    const reason = token ? "Токен не подходит" : "Токен не передан";
    return Response.json(
      {
        ok: false,
        error: reason,
        hint: token
          ? "Создайте токен заново во вкладке «Оператор» и подставьте его целиком — маска вида «…abcdef» не подходит."
          : "Передайте заголовок x-agent-token с токеном из вкладки «Оператор».",
      },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const [owner, tasks] = await Promise.all([getUser(ownerId), listAgentTasks(ownerId, 100)]);
  const counts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const task of tasks) {
    if (task.status in counts) counts[task.status as keyof typeof counts] += 1;
  }

  return Response.json(
    {
      ok: true,
      owner: { id: ownerId, name: owner?.name ?? "", email: owner?.email ?? "", role: owner?.role ?? "" },
      counts,
      tasks: tasks.length,
      serverTime: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
