"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

/**
 * Значение из localStorage без рассинхрона гидратации.
 *
 * Наивный `useState(() => JSON.parse(localStorage…))` даёт разную разметку на
 * сервере и клиенте: сервер отдаёт значения по умолчанию, клиент — сохранённые,
 * и React ругается «Hydration failed». Здесь снимок хранилища читается через
 * `useSyncExternalStore`: при гидратации React берёт серверный снимок (пустая
 * строка → значения по умолчанию), а после неё сам перерисовывает компонент с
 * сохранёнными настройками.
 *
 * Запись идёт сразу в localStorage и в локальное состояние, поэтому переключение
 * провайдера в интерфейсе не ждёт следующего рендера и переживает перезагрузку.
 */

const noopSubscribe = () => () => {};

function useStoredRaw(key: string) {
  const read = useCallback((): string => {
    try {
      return window.localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  }, [key]);

  const stored = useSyncExternalStore(noopSubscribe, read, () => "");
  const [override, setOverride] = useState<string | null>(null);
  const raw = override ?? stored;

  const write = useCallback(
    (next: string) => {
      try {
        window.localStorage.setItem(key, next);
      } catch {
        /* приватный режим — значение живёт до перезагрузки */
      }
      setOverride(next);
    },
    [key],
  );

  return { raw, read, write };
}

type Setter<T> = (next: T | ((prev: T) => T)) => void;

export function useStoredJson<T>(
  key: string,
  fallback: T,
  decode: (raw: string) => T,
): [T, Setter<T>] {
  const { raw, read, write } = useStoredRaw(key);

  const value = useMemo<T>(() => {
    if (!raw) return fallback;
    try {
      return decode(raw);
    } catch {
      return fallback;
    }
  }, [raw, decode, fallback]);

  const setValue = useCallback<Setter<T>>(
    (next) => {
      const current = read();
      let prev = fallback;
      if (current) {
        try {
          prev = decode(current);
        } catch {
          prev = fallback;
        }
      }
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
      write(JSON.stringify(resolved));
    },
    [read, write, decode, fallback],
  );

  return [value, setValue];
}

export function useStoredNumber(key: string, fallback: number): [number, (next: number) => void] {
  const { raw, write } = useStoredRaw(key);

  const value = useMemo(() => {
    const parsed = Number(raw);
    return raw && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }, [raw, fallback]);

  const setValue = useCallback(
    (next: number) => {
      write(String(next));
    },
    [write],
  );

  return [value, setValue];
}
