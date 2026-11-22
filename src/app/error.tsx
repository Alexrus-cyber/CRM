"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app-error]", error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-red-500/30 bg-card p-8 text-center shadow-xl">
        <p className="text-xs font-semibold uppercase tracking-widest text-red-400">Сбой приложения</p>
        <h1 className="mt-2 text-2xl font-semibold">Что-то пошло не так</h1>
        <p className="mt-2 text-sm text-muted">
          Попробуйте обновить экран или вернуться на дашборд.
        </p>
        {error.digest && (
          <p className="mt-3 font-mono text-[11px] text-muted">Код ошибки: {error.digest}</p>
        )}
        <div className="mt-6 flex justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-10 items-center justify-center rounded-xl bg-accent px-4 text-sm font-medium text-white hover:opacity-90"
          >
            Повторить
          </button>
          <Link
            href="/dashboard"
            className="inline-flex h-10 items-center justify-center rounded-xl border border-border px-4 text-sm font-medium hover:bg-bg"
          >
            На дашборд
          </Link>
        </div>
      </div>
    </div>
  );
}
