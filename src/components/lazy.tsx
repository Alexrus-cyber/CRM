"use client";

/**
 * Ленивая подгрузка блоков: списки рендерятся порциями, а тяжёлые виджеты
 * монтируются только когда пользователь до них доскроллил.
 *
 * Зачем: на слабых ПК (и в мобильном Safari) разметка сотен строк за один
 * кадр «подвешивает» страницу. Здесь первая порция маленькая, остальные
 * добавляются в простое (`requestIdleCallback`) внутри `startTransition`,
 * поэтому прокрутка и ввод в поиск не дёргаются.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { BlockSkeleton } from "./skeletons";
import { Button } from "./ui";

type ProgressiveOptions = {
  /** Сколько строк показать сразу (рендерится и на сервере). */
  initial?: number;
  /** Сколько строк добавлять за раз. */
  step?: number;
};

export type ProgressiveList<T> = {
  /** Видимая часть списка — её и рендерим. */
  items: T[];
  shown: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
  showMore: () => void;
  /** Узел-маркер в конце списка: попал в экран → догружаем ещё порцию. */
  sentinelRef: RefObject<HTMLDivElement | null>;
};

/**
 * Показывает список порциями. При смене набора строк (поиск, фильтр,
 * сортировка) снова возвращается к первой порции.
 */
export function useProgressiveList<T>(
  rows: T[],
  { initial = 24, step = 24 }: ProgressiveOptions = {},
): ProgressiveList<T> {
  // Храним вместе набор строк и счётчик догруженных порций: когда набор меняется
  // (поиск, фильтр, сортировка), порция сбрасывается прямо во время рендера —
  // лишний проход через эффект не нужен.
  const [state, setState] = useState<{ rows: T[]; extra: number }>({ rows, extra: 0 });
  if (state.rows !== rows) setState({ rows, extra: 0 });

  const [waiting, setWaiting] = useState(false);
  const [pending, startTransition] = useTransition();
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const total = rows.length;
  const shown = Math.min(initial + state.extra, total);
  const hasMore = shown < total;

  const showMore = useCallback(() => {
    if (shown >= total) return;
    setWaiting(true);
    const append = () => {
      startTransition(() => setState((current) => ({ ...current, extra: current.extra + step })));
      setWaiting(false);
    };
    // Дорисовываем в простое: так длинный список не блокирует основной поток.
    const idle = (window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof idle === "function") idle(append, { timeout: 250 });
    else window.setTimeout(append, 0);
  }, [shown, total, step]);

  // Догрузка при прокрутке: маркер появляется в зоне видимости заранее.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) showMore();
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, showMore]);

  return {
    items: rows.slice(0, shown),
    shown,
    total,
    hasMore,
    loading: waiting || pending,
    showMore,
    sentinelRef,
  };
}

/**
 * Хвост списка: счётчик «показано N из M», кнопка и маркер для автодогрузки.
 * Если строк мало, блок не рисуется вовсе — интерфейс не шумит.
 */
export function LoadMore({
  shown,
  total,
  hasMore,
  loading,
  onShowMore,
  sentinelRef,
  initial = 0,
  unit = "строк",
  className,
}: {
  shown: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
  onShowMore: () => void;
  sentinelRef?: RefObject<HTMLDivElement | null>;
  initial?: number;
  unit?: string;
  className?: string;
}) {
  if (total === 0) return null;
  // Список целиком влез в первую порцию — подпись не нужна.
  if (!hasMore && total <= initial) return null;

  return (
    <div ref={sentinelRef} className={cn("flex flex-col items-center gap-2 pt-1", className)}>
      <p className="text-[11px] text-muted">
        Показано {shown} из {total} {unit}
      </p>
      {hasMore ? (
        <Button variant="secondary" size="sm" onClick={onShowMore} disabled={loading}>
          {loading ? <Loader2 size={14} className="animate-spin" /> : <ChevronDown size={14} />}
          {loading ? "Подгружаем..." : "Показать ещё"}
        </Button>
      ) : (
        <p className="text-[11px] text-muted">Это все {total} {unit}</p>
      )}
    </div>
  );
}

/**
 * Монтирует содержимое только при подходе к экрану.
 * Полезно для тяжёлых клиентских виджетов (чат, графики): пока блок не нужен,
 * его разметка и обработчики не создаются.
 */
export function LazyMount({
  children,
  fallback,
  label = "Загружаем блок...",
  minHeight = 200,
  rootMargin = "320px 0px",
  className,
}: {
  children: ReactNode;
  fallback?: ReactNode;
  label?: string;
  minHeight?: number;
  rootMargin?: string;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      // Очень старые браузеры: просто показываем блок следующим тиком.
      const timer = window.setTimeout(() => setMounted(true), 0);
      return () => window.clearTimeout(timer);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setMounted(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [rootMargin]);

  return (
    <div ref={ref} className={className} style={mounted ? undefined : { minHeight }}>
      {mounted ? children : fallback ?? <BlockSkeleton label={label} />}
    </div>
  );
}
