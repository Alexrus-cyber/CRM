import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-xl">
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">Ошибка 404</p>
        <h1 className="mt-2 text-2xl font-semibold">Страница не найдена</h1>
        <p className="mt-2 text-sm text-muted">
          Запрошенный раздел не существует или был перемещён.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link
            href="/dashboard"
            className="inline-flex h-10 items-center justify-center rounded-xl bg-accent px-4 text-sm font-medium text-white hover:opacity-90"
          >
            На дашборд
          </Link>
          <Link
            href="/tasks"
            className="inline-flex h-10 items-center justify-center rounded-xl border border-border px-4 text-sm font-medium hover:bg-bg"
          >
            К задачам
          </Link>
        </div>
      </div>
    </div>
  );
}
