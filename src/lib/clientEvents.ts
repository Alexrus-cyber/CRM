"use client";

/**
 * Общий менеджер SSE-подписки на `/api/events` в пределах одной вкладки.
 *
 * В одном окне одновременно работают `LiveUpdates`, `MessageToasts` и (на /team) `ChatClient`.
 * На локальном HTTP/1.1 браузер ограничивает число одновременных соединений на origin (обычно 6);
 * открытие 2–3 отдельных `EventSource("/api/events")` в каждой вкладке быстро съедает пул
 * и ставит в очередь длинные SSE-стримы и подтверждения `/api/ai/agent`.
 * Общая подписка держит максимум одно соединение `/api/events` на вкладку и закрывает его,
 * когда последний подписчик размонтирован.
 */

export interface AppEventsListener {
  onOpen?: () => void;
  onError?: () => void;
  onUpdate?: (rawData: string) => void;
}

const listeners = new Set<AppEventsListener>();
let sharedSource: EventSource | null = null;

function ensureSource(): EventSource | null {
  if (sharedSource) return sharedSource;
  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    return null;
  }
  const source = new EventSource("/api/events");
  source.onopen = () => {
    for (const listener of Array.from(listeners)) {
      try {
        listener.onOpen?.();
      } catch {
        /* ignore subscriber error */
      }
    }
  };
  source.onerror = () => {
    for (const listener of Array.from(listeners)) {
      try {
        listener.onError?.();
      } catch {
        /* ignore subscriber error */
      }
    }
  };
  source.addEventListener("update", (event) => {
    const raw = typeof (event as MessageEvent<unknown>).data === "string"
      ? (event as MessageEvent<string>).data
      : "";
    if (!raw) return;
    for (const listener of Array.from(listeners)) {
      try {
        listener.onUpdate?.(raw);
      } catch {
        /* ignore subscriber error */
      }
    }
  });
  sharedSource = source;
  return sharedSource;
}

export function subscribeAppEvents(listener: AppEventsListener): () => void {
  listeners.add(listener);
  let source: EventSource | null = null;
  try {
    source = ensureSource();
  } catch {
    source = null;
  }

  if (!source) {
    listener.onError?.();
  } else if (source.readyState === 1) {
    listener.onOpen?.();
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && sharedSource) {
      try {
        sharedSource.close();
      } catch {
        /* ignore */
      }
      sharedSource = null;
    }
  };
}
