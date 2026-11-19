import { getCurrentUser } from "@/lib/auth";
import { normalizeBaseUrl } from "@/lib/ai";
import { applyGenParams, normalizeGenParams } from "@/lib/genParams";

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
const REQUEST_TIMEOUT = 120_000;

const PLAN_PROMPT = `Ты — планировщик заданий для бота, который управляет рабочим столом
пользователя. Твоя работа — превратить просьбу в точный план действий, который
бот сможет выполнить по скриншоту: открыть нужное окно, кликнуть в конкретное
поле, набрать текст, нажать клавишу.

Как отвечать:
- по-русски, кратко и по делу;
- если в просьбе не хватает данных (в каком чате писать, какой файл открыть,
  что именно отправить) — задай 1–3 коротких вопроса и ничего не планируй;
- когда данных достаточно — выдай ПЛАН нумерованным списком, по одному
  действию на строку: «1. Открыть …, 2. Кликнуть в поле …, 3. Ввести …,
  4. Нажать Enter». Указывай, что должно быть на экране и как проверить успех;
- в конце добавь строку «Готово, когда: …» — по какому признаку считать
  задание выполненным;
- не выдумывай приложения и кнопки, которых нет в просьбе; не предлагай
  удалять, оплачивать или отправлять что-то без прямого указания;
- если задача и так ясная, всё равно перепиши её точнее — бот не понимает
  намёков и работает только по шагам.

Твой ответ пользователь прочитает и, если согласен, перенесёт в чат с
действиями — он станет заданием бота. Не рассказывай про свои возможности,
не извиняйся, не добавляй вступлений вроде «Конечно!».`;

type IncomingFile = { name?: string; text?: string; note?: string };

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "super_admin") {
    return Response.json({ error: "Только главный администратор" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | {
        messages?: Array<{ role?: string; content?: string }>;
        files?: IncomingFile[];
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
  const model = (body?.settings?.model ?? "").trim().slice(0, 200);
  if (!model) {
    return Response.json({ error: "Укажите модель в «Подключении»" }, { status: 400 });
  }
  const apiKey = (body?.settings?.apiKey ?? "").trim().slice(0, 400);

  const messages = (body?.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role as "user" | "assistant", content: String(m.content).slice(0, MAX_CHARS) }));
  if (messages.length === 0) return Response.json({ error: "Пустой запрос" }, { status: 400 });

  // Файлы уже распознаны в браузере: сюда приходит текст (или пометка, что
  // формат бинарный). Приклеиваем их к последнему сообщению пользователя.
  const files = (body?.files ?? []).slice(0, 5);
  if (files.length > 0) {
    const last = [...messages].reverse().find((m) => m.role === "user");
    if (last) {
      const blocks = files.map((file) => {
        const name = String(file.name ?? "файл").slice(0, 160);
        const text = String(file.text ?? "").slice(0, 4000);
        const note = String(file.note ?? "").slice(0, 200);
        return text
          ? `--- ${name}${note ? ` (${note})` : ""} ---\n${text}`
          : `--- ${name}: содержимое не читается (${note || "бинарный формат"}) ---`;
      });
      last.content = `${last.content}\n\nФайлы от пользователя:\n${blocks.join("\n\n")}`.slice(0, MAX_CHARS * 2);
    }
  }

  const payload: Record<string, unknown> = {
    model,
    messages: [{ role: "system", content: PLAN_PROMPT }, ...messages],
    temperature: 0.3,
    max_tokens: 1200,
    stream: false,
  };
  // Настройки «Раздумья и генерация» с вкладки «Оператор»: значения из
  // интерфейса важнее дефолтов, иначе планировщик думает иначе, чем бот.
  applyGenParams(payload, normalizeGenParams(body?.settings?.params));

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
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
    };
    const message = data.choices?.[0]?.message ?? {};
    const reply = String(message.content ?? "").trim();
    const reasoning = String(message.reasoning_content ?? message.reasoning ?? "").trim();
    if (!reply) return Response.json({ error: "Модель вернула пустой ответ" }, { status: 502 });
    return Response.json({ reply, ...(reasoning ? { reasoning } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "нет связи";
    return Response.json({ error: `Не удалось связаться с моделью: ${message}` }, { status: 502 });
  }
}
