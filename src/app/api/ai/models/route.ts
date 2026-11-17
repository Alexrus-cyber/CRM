import { getCurrentUser } from "@/lib/auth";
import { AI_DEFAULT_BASE_URL, aiAuthHeaders, aiEndpoint, normalizeBaseUrl } from "@/lib/ai";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TIMEOUT_MS = 10_000;

type ModelsResponse = { data?: Array<{ id?: string }> };

/**
 * `GET /api/ai/models?base=...` — список моделей локального сервера.
 * Нужен кнопке «Проверить подключение»: она же подставляет первую модель,
 * если имя ещё не введено.
 */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const baseUrl =
    normalizeBaseUrl(url.searchParams.get("base") ?? "") ??
    normalizeBaseUrl(process.env.AI_BASE_URL ?? "") ??
    AI_DEFAULT_BASE_URL;
  const apiKey = (req.headers.get("x-ai-key") ?? process.env.AI_API_KEY ?? "").trim();

  let upstream: Response;
  try {
    upstream = await fetch(aiEndpoint(baseUrl, "/models"), {
      headers: { Accept: "application/json", ...aiAuthHeaders(apiKey) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: `Нет связи с ${baseUrl}: ${reason}. Проверьте, что локальный сервер запущен.` },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "");
    return Response.json(
      { error: `Сервер ответил ${upstream.status}: ${body.trim().slice(0, 300) || "без описания"}` },
      { status: 502 },
    );
  }

  const data = (await upstream.json().catch(() => ({}))) as ModelsResponse;
  const models = (data.data ?? [])
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort((a, b) => a.localeCompare(b));

  return Response.json({ baseUrl, models });
}
