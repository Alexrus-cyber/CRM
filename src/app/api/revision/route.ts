import { getLiveRevision } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

/**
 * «Отпечаток» состояния данных для страховочного опроса на клиенте.
 * Если SSE недоступен (прокси буферизует поток, сеть моргнула), `LiveUpdates`
 * сравнивает отпечаток раз в 10 секунд и обновляет страницу при изменении.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "Требуется авторизация" }, { status: 401 });
  }
  const rev = await getLiveRevision();
  return Response.json({ rev }, { headers: { "Cache-Control": "no-store" } });
}
