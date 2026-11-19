import { getCurrentUser } from "@/lib/auth";
import { normalizeBaseUrl } from "@/lib/ai";
import { AGENT_MAX_STEPS, normalizeGenParams } from "@/lib/genParams";
import { ROLE_LABELS } from "@/lib/utils";

/**
 * Мост к Python-агенту (`agent/agent.py`).
 *
 * Агент — отдельный процесс: он решает, что делать, вызывает инструменты и
 * отдаёт браузеру действия (открыть сайт, включить видео, скачать файл).
 * Здесь мы только проверяем права (пока это эксперимент для главного админа),
 * добавляем контекст CRM и пробрасываем SSE-поток без буферизации.
 *
 * Адрес задаётся переменной AGENT_URL (по умолчанию http://127.0.0.1:8899).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8899").replace(/\/+$/, "");
const START_HINT =
  "Запустите агента в папке проекта: python3 agent/agent.py (или задайте AGENT_URL, если он на другом хосте)";

/** Агент доступен только главному администратору — пока это эксперимент. */
function allowed(role: string): boolean {
  return role === "super_admin";
}

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!allowed(me.role)) {
    return Response.json({ error: "Агент доступен только главному администратору" }, { status: 403 });
  }

  try {
    const res = await fetch(`${AGENT_URL}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return Response.json({ available: false, endpoint: AGENT_URL, hint: START_HINT });
    }
    const data = (await res.json()) as Record<string, unknown>;
    return Response.json(
      { available: true, endpoint: AGENT_URL, ...data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ available: false, endpoint: AGENT_URL, hint: START_HINT });
  }
}

type IncomingMessage = { role?: string; content?: string };
type IncomingAttachment = { name?: string; text?: string; note?: string; image?: string };

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!allowed(me.role)) {
    return Response.json({ error: "Агент доступен только главному администратору" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | {
        messages?: IncomingMessage[];
        settings?: { baseUrl?: string; apiKey?: string; model?: string };
        params?: unknown;
        maxSteps?: number;
        attachments?: IncomingAttachment[];
      }
    | null;

  const messages = (body?.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 8000) }));
  if (messages.length === 0) {
    return Response.json({ error: "Пустой запрос" }, { status: 400 });
  }

  // Файлы уже распознаны в браузере — агенту нужен только текст и, для
  // картинок, data-URL: тогда vision-модель видит сам снимок.
  const attachments = (body?.attachments ?? [])
    .filter((item) => item && typeof item === "object")
    .slice(0, 5)
    .map((item) => {
      const image = typeof item.image === "string" && item.image.startsWith("data:image/")
        ? item.image.slice(0, 6_000_000)
        : "";
      return {
        name: String(item.name ?? "файл").slice(0, 120),
        note: String(item.note ?? "").slice(0, 120),
        text: String(item.text ?? "").slice(0, 30_000),
        ...(image ? { image } : {}),
      };
    });

  // Раздумья и генерация — те же ручки, что в «Чате с моделью».
  const params = normalizeGenParams(body?.params);
  const maxSteps = Math.min(
    AGENT_MAX_STEPS,
    Math.max(1, Number.isFinite(body?.maxSteps) ? Number(body?.maxSteps) : AGENT_MAX_STEPS),
  );

  const baseUrl = normalizeBaseUrl(body?.settings?.baseUrl ?? "") ?? undefined;
  const payload = {
    messages,
    attachments,
    params,
    maxSteps,
    settings: {
      baseUrl,
      apiKey: (body?.settings?.apiKey ?? "").trim().slice(0, 400),
      model: (body?.settings?.model ?? "").trim().slice(0, 200),
    },
    context: {
      user: me.name,
      roleLabel: ROLE_LABELS[me.role] ?? me.role,
      today: new Date().toISOString().slice(0, 10),
    },
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${AGENT_URL}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(290000),
    });
  } catch {
    return Response.json({ error: `Агент не запущен. ${START_HINT}`, hint: START_HINT }, { status: 503 });
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return Response.json(
      { error: `Агент ответил ошибкой ${upstream.status}${text ? `: ${text.slice(0, 300)}` : ""}` },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
