import { getCurrentUser } from "@/lib/auth";
import { subscribeLiveEvents } from "@/lib/events";

/**
 * SSE-поток живых обновлений: сервер присылает `update`, когда кто-то создал
 * или изменил задачу, контрагента или сотрудника. Клиент (`LiveUpdates`)
 * по этому сигналу делает `router.refresh()` — новые данные появляются без
 * перезагрузки страницы.
 *
 * Поток требует Node.js-рантайма: шина событий — это Set в памяти процесса.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 25000;

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "Требуется авторизация" }, { status: 401 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const stop = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        unsubscribe?.();
        unsubscribe = null;
        try {
          controller.close();
        } catch {
          // поток уже закрыт клиентом
        }
      };

      // `retry` — подсказка браузеру, как быстро переподключаться после обрыва.
      send("retry: 3000\n\n");
      send(": connected\n\n");

      unsubscribe = subscribeLiveEvents((event) => {
        send(`event: update\ndata: ${JSON.stringify(event)}\n\n`);
      });

      // Комментарии-«пинги» не дают прокси и балансировщикам закрыть простой поток.
      heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);

      req.signal.addEventListener("abort", stop);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      // nginx и подобные прокси иначе буферизуют поток.
      "X-Accel-Buffering": "no",
    },
  });
}
