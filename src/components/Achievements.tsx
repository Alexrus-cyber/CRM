import Link from "next/link";
import { Lock, Trophy } from "lucide-react";
import type { AchievementResult } from "@/lib/achievements";
import type { UserAchievementSummary } from "@/lib/data";
import { cn } from "@/lib/utils";
import { Avatar } from "./ui";

const TIER_RING: Record<number, string> = {
  1: "from-sky-400/40 to-sky-500/10",
  2: "from-violet-400/50 to-fuchsia-500/10",
  3: "from-amber-300/60 to-orange-500/10",
};

export function AchievementCard({ a, compact }: { a: AchievementResult; compact?: boolean }) {
  return (
    <div
      className={cn(
        "card-hover relative min-w-0 max-w-full overflow-hidden rounded-2xl border border-border bg-card p-3",
        !a.unlocked && "opacity-70 grayscale",
      )}
    >
      <div className={cn("pointer-events-none absolute inset-0 bg-gradient-to-br opacity-60", TIER_RING[a.tier])} />
      <div className="relative flex items-center gap-3">
        <div className="relative shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={a.image} alt={a.title} className={cn("rounded-xl object-cover shadow-lg", compact ? "h-12 w-12" : "h-16 w-16")} />
          {!a.unlocked && (
            <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-card text-muted ring-1 ring-border">
              <Lock size={10} />
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-semibold">{a.title}</p>
            <span className="shrink-0 rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent2">+{a.points}</span>
          </div>
          <p className="truncate text-[11px] text-muted">{a.description}</p>
          {!compact && (
            <div className="mt-2">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-card2">
                <div className="h-full rounded-full bg-gradient-to-r from-[#7c5cff] to-[#a78bfa]" style={{ width: `${Math.round(a.progress * 100)}%` }} />
              </div>
              <p className="mt-1 text-[10px] text-muted">{Math.min(a.current, a.target)} / {a.target}{a.unlocked ? " · получено" : ""}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function UserAchievementsPanel({ summary, rank, total }: { summary: UserAchievementSummary; rank: number; total: number }) {
  const unlocked = summary.achievements.filter((a) => a.unlocked);
  const locked = summary.achievements.filter((a) => !a.unlocked).sort((a, b) => b.progress - a.progress);
  const s = summary.stats;
  const stats = [
    { l: "Поставлено задач", v: s.created },
    { l: "Выполнено задач", v: s.completed },
    { l: "В срок", v: s.onTime, c: "text-emerald-500" },
    { l: "С опозданием", v: s.late, c: s.late ? "text-red-500" : "" },
    { l: "Часов выполнено", v: s.hours },
    { l: "Сообщений в чате", v: s.messages },
  ];
  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card p-5">
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-gradient-to-br from-[#7c5cff]/30 to-transparent blur-3xl" />
        <div className="relative flex min-w-0 flex-wrap items-center gap-4 sm:gap-6">
          <div>
            <p className="text-xs text-muted">Очки достижений</p>
            <p className="bg-gradient-to-r from-[#7c5cff] to-[#a78bfa] bg-clip-text text-4xl font-bold text-transparent">{summary.points}</p>
          </div>
          <div>
            <p className="text-xs text-muted">Получено</p>
            <p className="text-2xl font-semibold">{unlocked.length} <span className="text-sm font-normal text-muted">из {summary.achievements.length}</span></p>
          </div>
          <div>
            <p className="text-xs text-muted">Место в рейтинге</p>
            <p className="text-2xl font-semibold">#{rank} <span className="text-sm font-normal text-muted">из {total}</span></p>
          </div>
          <div className="grid w-full min-w-0 grid-cols-2 gap-x-4 gap-y-2 text-xs min-[420px]:grid-cols-3 sm:ml-auto sm:w-auto sm:gap-x-6">
            {stats.map((x) => (
              <div key={x.l} className="min-w-0"><p className="truncate text-muted">{x.l}</p><p className={cn("text-sm font-semibold sm:text-base", x.c)}>{x.v}</p></div>
            ))}
          </div>
        </div>
      </div>
      {unlocked.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Полученные ({unlocked.length})</p>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{unlocked.map((a) => <AchievementCard key={a.id} a={a} />)}</div>
        </div>
      )}
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">В процессе ({locked.length})</p>
        {locked.length === 0 ? <p className="text-xs text-muted">Все достижения получены! 🏆</p> : (
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{locked.map((a) => <AchievementCard key={a.id} a={a} />)}</div>
        )}
      </div>
    </div>
  );
}

export function Leaderboard({ summaries }: { summaries: UserAchievementSummary[] }) {
  const top = summaries.filter((s) => s.unlockedCount > 0).slice(0, 4);
  if (top.length === 0) {
    return <p className="py-6 text-center text-xs text-muted">Пока никто не получил достижений. Ставьте и выполняйте задачи!</p>;
  }
  const medal = ["#1", "#2", "#3", "#4"];
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
      {top.map((s, i) => (
        <Link
          key={s.user.id}
          href={`/team/${s.user.id}`}
          className="card-hover group relative min-w-0 max-w-full overflow-hidden rounded-2xl border border-border bg-card p-3 sm:p-4"
        >
          <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-gradient-to-br from-[#7c5cff]/30 to-transparent blur-2xl" />
          <div className="relative flex items-center gap-3">
            <Avatar name={s.user.name} color={s.user.avatarColor} url={s.user.avatarUrl} size={40} />
            <div className="min-w-0 flex-1">
              <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                <span className={cn(
                  "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold tabular-nums",
                  i === 0 ? "bg-amber-400/20 text-amber-400" : i === 1 ? "bg-slate-300/20 text-slate-300" : i === 2 ? "bg-orange-400/20 text-orange-400" : "bg-card2 text-muted",
                )}>{medal[i]}</span>
                <span className="truncate">{s.user.name}</span>
              </p>
              <p className="truncate text-[11px] text-muted">{s.user.position || "—"}</p>
            </div>
          </div>
          {s.best && (
            <div className="relative mt-3 flex items-center gap-3 rounded-xl border border-border bg-card2/70 p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.best.image} alt={s.best.title} className="h-14 w-14 rounded-lg object-cover shadow-md transition group-hover:scale-105" />
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold">{s.best.title}</p>
                <p className="truncate text-[10px] text-muted">{s.best.description}</p>
              </div>
            </div>
          )}
          <div className="relative mt-3 flex items-center justify-between text-xs">
            <span className="flex items-center gap-1 text-muted"><Trophy size={12} /> {s.unlockedCount} достижений</span>
            <span className="font-semibold text-accent2">{s.points} очков</span>
          </div>
        </Link>
      ))}
    </div>
  );
}

/** Personal achievements card used by the employee dashboard (no team data). */
export function MyAchievementsCard({ summary }: { summary: UserAchievementSummary }) {
  const unlocked = summary.achievements.filter((a) => a.unlocked);
  const next = summary.achievements
    .filter((a) => !a.unlocked)
    .sort((a, b) => b.progress - a.progress)
    .slice(0, 2);

  return (
    <div className="grid min-w-0 gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
      <div className="relative overflow-hidden rounded-xl border border-border bg-card2/60 p-3">
        <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-gradient-to-br from-[#7c5cff]/30 to-transparent blur-2xl" />
        <p className="relative text-xs text-muted">Мои очки</p>
        <p className="relative bg-gradient-to-r from-[#7c5cff] to-[#a78bfa] bg-clip-text text-3xl font-bold leading-tight text-transparent">
          {summary.points}
        </p>
        <p className="relative mt-1 text-xs text-muted">
          Получено <b className="text-text">{unlocked.length}</b> из {summary.achievements.length}
        </p>
        <div className="relative mt-2 space-y-0.5 text-[11px] text-muted">
          <p>Выполнено задач: <b className="text-text">{summary.stats.completed}</b></p>
          <p>В срок: <b className="text-emerald-500">{summary.stats.onTime}</b></p>
          <p>Просрочено: <b className={summary.stats.late ? "text-red-500" : "text-text"}>{summary.stats.late}</b></p>
        </div>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-2">
        {unlocked.slice(0, 2).map((a) => <AchievementCard key={a.id} a={a} compact />)}
        {next.map((a) => <AchievementCard key={a.id} a={a} />)}
        {unlocked.length === 0 && next.length === 0 && (
          <p className="py-6 text-center text-xs text-muted md:col-span-2">Пока нет достижений — начните с первой задачи.</p>
        )}
      </div>
    </div>
  );
}
