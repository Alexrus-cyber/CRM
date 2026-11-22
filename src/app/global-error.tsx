"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ru">
      <body className="flex min-h-screen items-center justify-center bg-[#0b0b12] px-4 py-12 text-white">
        <div className="w-full max-w-md rounded-2xl border border-white/15 bg-[#13111f] p-8 text-center shadow-xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-red-400">Критическая ошибка</p>
          <h1 className="mt-2 text-2xl font-semibold">Не удалось загрузить интерфейс</h1>
          <p className="mt-2 text-sm text-white/60">
            Перезагрузите страницу или повторите запрос позже.
          </p>
          {error.digest && (
            <p className="mt-3 font-mono text-[11px] text-white/50">Код: {error.digest}</p>
          )}
          <button
            type="button"
            onClick={reset}
            className="mt-6 inline-flex h-10 items-center justify-center rounded-xl bg-[#7c5cff] px-4 text-sm font-medium text-white"
          >
            Обновить страницу
          </button>
        </div>
      </body>
    </html>
  );
}
