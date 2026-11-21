import { getCurrentUser } from "@/lib/auth";
import { aiAuthHeaders, aiEndpoint, normalizeBaseUrl } from "@/lib/ai";
import { buildFallbackSummary, type TranscriptTurn } from "@/lib/transcripts";

/**
 * Генерация Summary переписки агента при приближении к лимиту контекста.
 * Если модель недоступна, аккуратно собирает структурный fallback-конспект,
 * чтобы переписка никогда не потерялась.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "super_admin") {
    return Response.json({ error: "Доступно только главному администратору" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | {
        title?: string;
        turns?: TranscriptTurn[];
        settings?: { baseUrl?: string; apiKey?: string; model?: string };
      }
    | null;

  const title = String(body?.title ?? "Чат агента").slice(0, 240);
  const turns = Array.isArray(body?.turns) ? body.turns : [];
  if (turns.length === 0) {
    return Response.json({ error: "Нет сообщений для Summary" }, { status: 400 });
  }

  const fallback = buildFallbackSummary(turns, title);
  const baseUrl = normalizeBaseUrl(body?.settings?.baseUrl ?? "");
  const model = (body?.settings?.model ?? process.env.AI_MODEL ?? "").trim();
  const apiKey = (body?.settings?.apiKey ?? process.env.AI_API_KEY ?? "").trim();

  if (!baseUrl || !model) {
    return Response.json({ summary: fallback, source: "fallback" }, { headers: { "Cache-Control": "no-store" } });
  }

  const dialog = turns
    .map((t, idx) => {
      const who = t.role === "user" ? "Пользователь" : "Агент";
      const files = t.files?.length ? ` [файлы: ${t.files.map((f) => f.name).join(", ")}]` : "";
      const actions = t.actions?.length
        ? ` [действия: ${t.actions.map((a) => a.label || a.type).join(", ")}]`
        : "";
      return `${idx + 1}. ${who}${files}${actions}: ${String(t.content ?? "")}`;
    })
    .join("\n");

  try {
    const res = await fetch(aiEndpoint(baseUrl, "/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...aiAuthHeaders(apiKey) },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "Ты составляешь сжатое, но точное Summary переписки ИИ-агента с пользователем " +
              "для переноса контекста в новый чат. Пиши по-русски структурированно:\n" +
              "1) Главная цель;\n2) Что уже выполнено и какие файлы/проекты созданы (точные имена/пути);\n" +
              "3) Важные решения и ограничения;\n4) Следующие шаги.\nНе придумывай фактов, которых не было.",
          },
          {
            role: "user",
            content: `Чат: ${title}\n\nПереписка:\n${dialog}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      return Response.json({ summary: fallback, source: "fallback" }, { headers: { "Cache-Control": "no-store" } });
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = String(data.choices?.[0]?.message?.content ?? "").trim();
    if (!text) {
      return Response.json({ summary: fallback, source: "fallback" }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ summary: text, source: "model" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ summary: fallback, source: "fallback" }, { headers: { "Cache-Control": "no-store" } });
  }
}
