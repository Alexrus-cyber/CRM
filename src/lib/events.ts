/**
 * Шина событий «что-то изменилось» для живого обновления интерфейса.
 *
 * Server actions после записи в БД публикуют событие, а SSE-поток
 * (`/api/events`) раздаёт его открытым вкладкам. Шина живёт в памяти процесса,
 * поэтому:
 *   • работает в том же процессе, что и server actions (`next start`, `next dev`);
 *   • при нескольких инстансах событие увидят только клиенты того инстанса,
 *     который принял изменение (в DATABASES.md описано, что SQLite-режим и так
 *     рассчитан на один процесс);
 *   • клиент дополнительно подстраховывается опросом `/api/revision`.
 *
 * Хранилище на `globalThis`, чтобы dev-перезагрузки и разные модульные
 * бандлы (SSR, route handlers, actions) использовали один и тот же набор
 * подписчиков.
 */

export type LiveScope = "tasks" | "counterparties" | "users" | "chat";

/**
 * Данные нового сообщения чата — из них клиент собирает всплывающее
 * уведомление. Для личных сообщений событие уходит только получателю
 * (фильтр в `/api/events`), общий чат видят все.
 */
export type ChatEventPayload = {
  messageId: number;
  senderId: number;
  senderName: string;
  senderColor: string;
  recipientId: number | null;
  roomId?: number | null;
  roomName?: string | null;
  isSharedRoom?: boolean;
  memberIds?: number[];
  preview: string;
};

export type LiveEvent = {
  scope: LiveScope;
  /** Кто изменил данные — клиенту это не обязательно, но удобно для отладки. */
  actorId?: number;
  at: number;
  /** Заполняется только для `scope: "chat"`. */
  chat?: ChatEventPayload;
};

type Listener = (event: LiveEvent) => void;

const globalForEvents = globalThis as typeof globalThis & {
  __crmLiveListeners?: Set<Listener>;
};

function listeners(): Set<Listener> {
  if (!globalForEvents.__crmLiveListeners) globalForEvents.__crmLiveListeners = new Set<Listener>();
  return globalForEvents.__crmLiveListeners;
}

function emit(event: LiveEvent): void {
  for (const listener of listeners()) {
    try {
      listener(event);
    } catch {
      // Оборванное соединение не должно ломать саму операцию записи.
    }
  }
}

/** Сообщить всем открытым вкладкам, что сущность изменилась. */
export function publishLiveEvent(scope: LiveScope, actorId?: number): void {
  emit({ scope, actorId, at: Date.now() });
}

/** Новое сообщение в чате — повод показать уведомление получателю. */
export function publishChatMessage(payload: ChatEventPayload): void {
  emit({ scope: "chat", actorId: payload.senderId, at: Date.now(), chat: payload });
}

/** Подписка для SSE-потока. Возвращает функцию отписки. */
export function subscribeLiveEvents(listener: Listener): () => void {
  const set = listeners();
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

export function liveListenerCount(): number {
  return listeners().size;
}
