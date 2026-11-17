"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Building2,
  CheckSquare,
  CalendarDays,
  Users,
  UserCircle,
  LogOut,
  Moon,
  Sun,
  Sparkles,
} from "lucide-react";
import { logoutAction } from "@/app/actions/auth";
import { Avatar } from "./ui";
import { cn, ROLE_LABELS } from "@/lib/utils";
import type { Role } from "@/db/schema";

const NAV = [
  { href: "/dashboard", label: "Дашборд", short: "Дашборд", icon: LayoutDashboard },
  { href: "/tasks", label: "Задачи", short: "Задачи", icon: CheckSquare },
  { href: "/calendar", label: "Календарь", short: "Календарь", icon: CalendarDays },
  { href: "/counterparties", label: "Контрагенты", short: "Клиенты", icon: Building2 },
  { href: "/team", label: "Команда и чат", short: "Команда", icon: Users },
  { href: "/profile", label: "Профиль", short: "Профиль", icon: UserCircle },
];

export function ThemeToggle({ compact }: { compact?: boolean }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted ? resolvedTheme === "dark" : true;
  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? "light" : "dark")}
      className={cn(
        "flex items-center gap-2 rounded-xl border border-border bg-card2 text-xs font-medium text-muted transition hover:text-text",
        compact ? "h-9 w-9 justify-center" : "h-10 w-full px-3",
      )}
      title={dark ? "Светлая тема" : "Тёмная тема"}
    >
      {dark ? <Sun size={16} /> : <Moon size={16} />}
      {!compact && <span>{dark ? "Светлая тема" : "Тёмная тема"}</span>}
    </button>
  );
}

export type SidebarUser = {
  id: number;
  name: string;
  role: Role;
  position: string | null;
  avatarColor: string;
  avatarUrl: string | null;
};

export function Sidebar({ user, dbLabel }: { user: SidebarUser; dbLabel?: string }) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-border bg-sidebar px-4 py-5 lg:flex">
        <Link href="/dashboard" className="mb-8 flex items-center gap-3 px-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#7c5cff] to-[#a78bfa] text-white shadow-[0_8px_24px_-8px_var(--glow)]">
            <Sparkles size={18} />
          </span>
          <div>
            <p className="text-sm font-semibold leading-tight">Nova CRM</p>
            <p className="text-[11px] text-muted">Задачи · Команда · Клиенты</p>
          </div>
        </Link>

        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition",
                  active
                    ? "bg-gradient-to-r from-[#7c5cff]/20 to-transparent text-text ring-1 ring-[#7c5cff]/30"
                    : "text-muted hover:bg-card2 hover:text-text",
                )}
              >
                <Icon size={18} className={cn(active ? "text-accent2" : "text-muted group-hover:text-text")} />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-4 space-y-3">
          {dbLabel && (
            <div className="flex items-center gap-2 rounded-xl border border-border bg-card2/60 px-3 py-2 text-[11px] text-muted" title="Активный движок базы данных (определяется автоматически)">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              База данных: <span className="font-medium text-text">{dbLabel}</span>
            </div>
          )}
          <ThemeToggle />
          <div className="flex items-center gap-3 rounded-xl border border-border bg-card2 p-2.5">
            <Avatar name={user.name} color={user.avatarColor} url={user.avatarUrl} size={36} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-[11px] text-muted">{user.position || ROLE_LABELS[user.role]}</p>
            </div>
            <form action={logoutAction}>
              <button className="rounded-lg p-1.5 text-muted hover:bg-card hover:text-red-500" title="Выйти">
                <LogOut size={16} />
              </button>
            </form>
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex min-w-0 items-center justify-between gap-2 border-b border-border bg-sidebar/90 px-3 py-2.5 backdrop-blur lg:hidden">
        <Link href="/dashboard" className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#7c5cff] to-[#a78bfa] text-white">
            <Sparkles size={16} />
          </span>
          <span className="truncate text-sm font-semibold">Nova CRM</span>
        </Link>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <ThemeToggle compact />
          <form action={logoutAction}>
            <button className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card2 text-muted" title="Выйти">
              <LogOut size={16} />
            </button>
          </form>
          <Link href="/profile">
            <Avatar name={user.name} color={user.avatarColor} url={user.avatarUrl} size={34} />
          </Link>
        </div>
      </header>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 border-t border-border bg-sidebar/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        {NAV.map(({ href, label, short, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              aria-label={label}
              title={label}
              className={cn(
                "flex min-w-0 flex-col items-center gap-0.5 px-0.5 py-1.5 text-[9px] font-medium min-[360px]:text-[10px]",
                active ? "text-accent2" : "text-muted",
              )}
            >
              <Icon size={18} className="shrink-0" />
              <span className="w-full truncate text-center leading-tight">{short}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
