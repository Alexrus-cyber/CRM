import { recordAgentUsage } from "@/db/repo";
import { hasOperatorAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import { estimateTokens, normalizeBaseUrl } from "@/lib/ai";
import { applyGenParams, isUnlimitedStepsRole, normalizeGenParams } from "@/lib/genParams";
import { DEFAULT_PLAN_PROMPT } from "@/lib/operatorPlan";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";
import { assertSafeAiUrl, safeAiFetch } from "@/lib/ssrf";

/**
 * Планировщик оператора: `POST /api/agent/plan`.
 *
 * Первый из двух чатов на «Пульте». Пользователь формулирует задачу обычными
 * словами, модель уточняет её и пишет точный план действий (что открыть, куда
 * кликнуть, что набрать). Ключ модели приходит из браузера и нигде не
 * сохраняется — так же, как в остальных чатах блока ИИ.
 *
 * Готовый план пользователь переносит в чат с действиями — оттуда он уходит
 * боту в очередь заданий.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_MESSAGES = 14;
const MAX_CHARS = 6000;
const MAX_SYSTEM_PROMPT_CHARS = 12_000;
const REQUEST_TIMEOUT = 120_000;

type IncomingFile = { name?: string; text?: string; note?: string; image?: string };

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasOperatorAccess(me)) {
    return Response.json({ error: "Доступ к Оператору не выдан главным администратором" }, { status: 403 });
  }

  const rl = checkApiRateLimit({
    scope: "agent_plan",
    userId: me.id,
    ip: extractClientIp(req.headers),
    maxRequests: 40,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const body = (await req.json().catch(() => null)) as
    | {
        messages?: Array<{ role?: string; content?: string }>;
        files?: IncomingFile[];
        systemPrompt?: string;
        settings?: { baseUrl?: string; apiKey?: string; model?: string; params?: unknown };
      }
    | null;

  const baseUrl = normalizeBaseUrl(body?.settings?.baseUrl ?? "");
  if (!baseUrl) {
    return Response.json(
      { error: "Укажите Base URL модели в «Подключении» — без него планировщик не работает" },
      { status: 400 },
    );
  }
  try {
    await assertSafeAiUrl(baseUrl);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Запрещённый адрес модели" },
      { status: 400 },
    );
  }
  const model = (body?.settings?.model ?? "").trim().slice(0, 200);
  if (!model) {
    return Response.json({ error: "Укажите модель в «Подключении»" }, { status: 400 });
  }
  const apiKey = (body?.settings?.apiKey ?? "").trim().slice(0, 400);
  const systemPrompt =
    (typeof body?.systemPrompt === "string" ? body.systemPrompt.trim() : "") ||
    DEFAULT_PLAN_PROMPT;

  const messages: Array<{ role: "user" | "assistant"; content: string | Array<Record<string, unknown>> }> = (
    body?.messages ?? []
  )
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role as "user" | "assistant", content: String(m.content) }));
  if (messages.length === 0) return Response.json({ error: "Пустой запрос" }, { status: 400 });

  // Файлы уже распознаны в браузере: сюда приходит текст или data-URL картинки.
  const files = Array.isArray(body?.files) ? body.files : [];
  if (files.length > 0) {
    const last = [...messages].reverse().find((m) => m.role === "user");
    if (last && typeof last.content === "string") {
      const blocks: string[] = [];
      const images: Array<{ name: string; url: string }> = [];
      for (const file of files) {
        const name = String(file.name ?? "файл").slice(0, 240);
        const text = String(file.text ?? "");
        const note = String(file.note ?? "").slice(0, 240);
        const image =
          typeof file.image === "string" && file.image.startsWith("data:image/")
            ? file.image
            : "";
        if (image) {
          images.push({ name, url: image });
        } else if (text) {
          blocks.push(`--- ${name}${note ? ` (${note})` : ""} ---\n${text}`);
        } else {
          blocks.push(`--- ${name}: содержимое не читается (${note || "бинарный формат"}) ---`);
        }
      }
      const combinedText =
        blocks.length > 0
          ? `${last.content}\n\nФайлы от пользователя:\n${blocks.join("\n\n")}`
          : last.content;
      if (images.length > 0) {
        last.content = [
          { type: "text", text: combinedText },
          ...images.map((img) => ({ type: "image_url", image_url: { url: img.url } })),
        ];
      } else {
        last.content = combinedText;
      }
    }
  }

  const unlimited = isUnlimitedStepsRole(me.role);
  const payload: Record<string, unknown> = {
    model,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    temperature: 0.3,
    stream: false,
  };
  // Настройки «Раздумья и генерация» с вкладки «Оператор»: учитываем роль.
  applyGenParams(payload, normalizeGenParams(body?.settings?.params, { unlimited }), { unlimited });

  try {
    const res = await safeAiFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    const raw = await res.text();
    if (!res.ok) {
      const hint =
        res.status === 401
          ? "Модель отклонила ключ API — проверьте поле «Ключ API» в «Подключении»."
          : res.status === 404
            ? "Модель или Base URL не найдены — проверьте адрес и название модели."
            : "Модель ответила ошибкой.";
      return Response.json({ error: `${hint} HTTP ${res.status}: ${raw.slice(0, 300)}` }, { status: 502 });
    }
    const data = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const message = data.choices?.[0]?.message ?? {};
    const reply = String(message.content ?? "").trim();
    const reasoning = String(message.reasoning_content ?? message.reasoning ?? "").trim();
    if (!reply) return Response.json({ error: "Модель вернула пустой ответ" }, { status: 502 });
    const promptEst = messages.reduce(
      (sum, m) => sum + estimateTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content)),
      estimateTokens(systemPrompt),
    );
    const completionEst = estimateTokens(reply) + estimateTokens(reasoning);
    const promptTokens = Number(data.usage?.prompt_tokens ?? 0) || promptEst;
    const completionTokens = Number(data.usage?.completion_tokens ?? 0) || completionEst;
    const totalTokens = Number(data.usage?.total_tokens ?? 0) || promptTokens + completionTokens;
    await recordAgentUsage({
      userId: me.id,
      kind: "operator",
      model,
      prompt: promptTokens,
      completion: completionTokens,
      total: totalTokens,
    }).catch(() => undefined);
    return Response.json({ reply, ...(reasoning ? { reasoning } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "нет связи";
    return Response.json({ error: `Не удалось связаться с моделью: ${message}` }, { status: 502 });
  }
}
