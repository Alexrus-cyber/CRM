import { redirect } from "next/navigation";
import { Sparkles } from "lucide-react";
import { ensureSuperAdmin, getCurrentUser, SUPER_ADMIN_CREDENTIALS } from "@/lib/auth";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");
  try {
    await ensureSuperAdmin();
  } catch {
    // DB may not be migrated yet; login action will retry.
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute -left-40 top-1/3 h-96 w-96 rounded-full bg-[#7c5cff]/25 blur-3xl" />
      <div className="pointer-events-none absolute -right-40 top-10 h-96 w-96 rounded-full bg-[#a78bfa]/20 blur-3xl" />

      <div className="grid w-full max-w-4xl overflow-hidden rounded-3xl border border-border bg-card shadow-2xl lg:grid-cols-2">
        <div className="relative hidden flex-col justify-between bg-gradient-to-br from-[#1a1530] via-[#13111f] to-[#0b0b12] p-10 text-white lg:flex">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#7c5cff] to-[#a78bfa]">
              <Sparkles size={20} />
            </span>
            <div>
              <p className="font-semibold">Nova CRM</p>
              <p className="text-xs text-white/60">Единое пространство команды</p>
            </div>
          </div>
          <div className="space-y-6">
            <h2 className="text-3xl font-semibold leading-tight">
              Задачи, клиенты и команда — <span className="text-[#a78bfa]">в одном месте</span>
            </h2>
            <ul className="space-y-3 text-sm text-white/70">
              <li className="flex gap-2"><span className="text-[#a78bfa]">●</span> Дашборд с аналитикой по статусам, исполнителям и дедлайнам</li>
              <li className="flex gap-2"><span className="text-[#a78bfa]">●</span> База контрагентов с поиском и фильтрами</li>
              <li className="flex gap-2"><span className="text-[#a78bfa]">●</span> Календарь планирования и экспорт в Excel</li>
              <li className="flex gap-2"><span className="text-[#a78bfa]">●</span> Командный чат и система достижений</li>
            </ul>
            <div className="grid grid-cols-3 gap-3">
              {[
                { v: "24/7", l: "доступ" },
                { v: "100%", l: "прозрачность" },
                { v: "∞", l: "задач" },
              ].map((s) => (
                <div key={s.l} className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <p className="text-lg font-semibold">{s.v}</p>
                  <p className="text-[11px] text-white/60">{s.l}</p>
                </div>
              ))}
            </div>
          </div>
          <p className="text-xs text-white/40">© {new Date().getFullYear()} Nova CRM</p>
        </div>

        <div className="p-8 sm:p-10">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#7c5cff] to-[#a78bfa] text-white">
              <Sparkles size={20} />
            </span>
            <p className="font-semibold">Nova CRM</p>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Вход в систему</h1>
          <p className="mt-1 text-sm text-muted">Введите свои учётные данные, чтобы продолжить</p>
          <div className="mt-6">
            <LoginForm />
          </div>
          <div className="mt-6 rounded-xl border border-dashed border-accent/40 bg-accent/5 p-4 text-xs">
            <p className="font-medium">Учётная запись главного администратора</p>
            <p className="mt-1 text-muted">
              Email: <span className="font-mono text-text">{SUPER_ADMIN_CREDENTIALS.email}</span>
            </p>
            <p className="text-muted">
              Пароль: <span className="font-mono text-text">{SUPER_ADMIN_CREDENTIALS.password}</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
