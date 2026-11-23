"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { subscribeAppEvents } from "@/lib/clientEvents";

/**
 * Живое обновление интерфейса.
 *
 * Сервер присылает событие по SSE (`/api/events`), когда кто-то создал или
 * изменил задачу, контрагента либо сотрудника. Компонент решает, касается ли
 * это текущей страницы, и делает `router.refresh()` — серверные компоненты
 * перерисовываются, новые данные появляются без перезагрузки.
 *
 * Дополнительно раз в 10 секунд сверяется «отпечаток» данных
 * (`/api/revision`) — страховка на случай, если SSE блокирует прокси.
 */
type Scope = "tasks" | "counterparties" | "users";

/** Какие разделы перерисовывать при изменении сущности. */
const SCOPE_ROUTES: Record<Scope, string[]> = {
  tasks: ["/dashboard", "/tasks", "/calendar", "/team", "/profile"],
  counterparties: ["/counterparties", "/tasks", "/dashboard", "/calendar"],
  users: ["/team", "/tasks", "/dashboard", "/calendar", "/profile"],
};

const POLL_INTERVAL_MS = 10000;
const DEBOUNCE_MS = 400;
/** Не дёргаем перерисовку чаще, чем раз в 2 секунды (импорт пачки строк и т. п.). */
const MIN_GAP_MS = 2000;

/** Касается ли событие текущего раздела (экспорт — для проверок). */
export function matchesPath(pathname: string, scope: string): boolean {
  const routes = SCOPE_ROUTES[scope as Scope];
  if (!routes) return false;
  return routes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

export function LiveUpdates() {
  const router = useRouter();
  const pathname = usePathname();
  const pathRef = useRef(pathname);

  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let interval: number | null = null;
    let lastRefresh = 0;
    let pending = false;
    let revision: string | null = null;

    const refresh = () => {
      timer = null;
      lastRefresh = Date.now();
      pending = false;
      router.refresh();
    };

    const schedule = () => {
      // Скрытая вкладка не тратит CPU: обновимся, когда пользователь вернётся.
      if (document.visibilityState === "hidden") {
        pending = true;
        return;
      }
      if (timer !== null) window.clearTimeout(timer);
      const sinceLast = Date.now() - lastRefresh;
      const delay = sinceLast < MIN_GAP_MS ? MIN_GAP_MS - sinceLast : DEBOUNCE_MS;
      timer = window.setTimeout(refresh, delay);
    };

    const onVisible = () => {
      if (document.visibilityState === "hidden") return;
      if (pending) schedule();
    };
    document.addEventListener("visibilitychange", onVisible);

    const poll = async () => {
      if (disposed || document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/revision", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { rev?: string };
        if (typeof data.rev !== "string") return;
        if (revision === null) {
          revision = data.rev;
          return;
        }
        if (data.rev !== revision) {
          revision = data.rev;
          schedule();
        }
      } catch {
        /* нет сети — попробуем на следующем тике */
      }
    };

    const startFallbackPolling = () => {
      if (interval !== null || disposed) return;
      void poll();
      interval = window.setInterval(poll, POLL_INTERVAL_MS);
    };

    const stopFallbackPolling = () => {
      if (interval !== null) {
        window.clearInterval(interval);
        interval = null;
      }
    };

    // 1. Мгновенный канал: общее серверное событие на вкладку (без лишних HTTP-соединений).
    const unsubscribe = subscribeAppEvents({
      onOpen: () => {
        stopFallbackPolling();
      },
      onError: () => {
        // Если прокси или сеть уронили SSE, включаем резервный опрос.
        startFallbackPolling();
      },
      onUpdate: (raw) => {
        try {
          const data = JSON.parse(raw) as { scope?: string };
          if (data?.scope && matchesPath(pathRef.current, data.scope)) schedule();
        } catch {
          /* некорректный пакет — игнорируем */
        }
      },
    });

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [router]);

  return null;
}
