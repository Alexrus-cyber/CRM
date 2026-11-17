import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Mail, MessageCircle, Phone, Shield, Trophy, Briefcase, CalendarDays } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getAchievementSummaries, getAllTasks, getUserById, getUsers } from "@/lib/data";
import { formatDate, dateToStr, isAdminRole, OPEN_STATUSES, ROLE_LABELS, roleBadgeClass, todayStr } from "@/lib/utils";
import { Avatar, Badge, Button, Card, StatusBadge } from "@/components/ui";
import { UserAchievementsPanel } from "@/components/Achievements";
import { UserAdminControls } from "@/components/ProfileClient";

export const dynamic = "force-dynamic";

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  const { id } = await params;
  const userId = Number(id);
  if (!Number.isFinite(userId)) notFound();
  const [user, users, allTasks] = await Promise.all([getUserById(userId), getUsers(), getAllTasks()]);
  if (!user) notFound();
  const summaries = await getAchievementSummaries(users, allTasks);
  const idx = summaries.findIndex((s) => s.user.id === userId);
  const summary = summaries[idx];
  const today = todayStr();

  // Non-admins only see tasks they share with this user
  const visible = allTasks.filter((t) => isAdminRole(me.role) || t.assigneeId === me.id || t.authorId === me.id);
  const userOpen = visible.filter((t) => t.assigneeId === userId && OPEN_STATUSES.includes(t.status)).sort((a, b) => a.deadline.localeCompare(b.deadline));

  return (
    <>
      <Link href="/team" className="mb-4 inline-flex items-center gap-1 text-xs text-muted hover:text-text"><ArrowLeft size={14} /> Команда</Link>
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card p-5 sm:p-6">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-r from-[#7c5cff]/30 via-[#a78bfa]/20 to-transparent" />
        <div className="relative flex flex-wrap items-end gap-4">
          <Avatar name={user.name} color={user.avatarColor} url={user.avatarUrl} size={96} className="text-2xl ring-4 ring-card" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{user.name}</h1>
              <Badge className={roleBadgeClass(user.role)}><Shield size={10} /> {ROLE_LABELS[user.role]}</Badge>
            </div>
            <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted"><Briefcase size={14} /> {user.position || "Должность не указана"}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              <a href={`mailto:${user.email}`} className="flex items-center gap-1 hover:text-text"><Mail size={12} /> {user.email}</a>
              {user.phone && <a href={`tel:${user.phone}`} className="flex items-center gap-1 hover:text-text"><Phone size={12} /> {user.phone}</a>}
              <span className="flex items-center gap-1"><CalendarDays size={12} /> в команде с {formatDate(dateToStr(new Date(user.createdAt)))}</span>
            </div>
          </div>
          <div className="flex gap-2">
            {user.id !== me.id && (
              <Link href={`/team?chat=${user.id}`}><Button variant="secondary" size="sm"><MessageCircle size={14} /> Написать</Button></Link>
            )}
            {user.id === me.id && <Link href="/profile"><Button variant="secondary" size="sm">Редактировать профиль</Button></Link>}
          </div>
        </div>
        {user.bio && <p className="relative mt-4 max-w-3xl text-sm text-muted">{user.bio}</p>}
      </div>

      <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Trophy size={18} className="text-amber-400" /> Достижения</h2>
          {summary && <UserAchievementsPanel summary={summary} rank={idx + 1} total={summaries.length} />}
        </div>
        <div className="space-y-4">
          <UserAdminControls target={user} me={{ id: me.id, role: me.role }} />
          <Card title={`Открытые задачи (${userOpen.length})`} subtitle="Текущая загрузка сотрудника" action={<Link href={`/tasks?assignee=${user.id}`} className="text-xs font-medium text-accent2 hover:underline">Все →</Link>}>
            {userOpen.length === 0 ? <p className="py-6 text-center text-xs text-muted">Нет открытых задач</p> : (
              <ul className="divide-y divide-border/50">
                {userOpen.slice(0, 10).map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 py-2">
                    <div className="min-w-0"><p className="truncate text-sm font-medium">{t.title}</p><p className="text-[11px] text-muted">{t.counterpartyName ?? "—"} · {t.hours} ч</p></div>
                    <div className="text-right"><StatusBadge status={t.status} /><p className={`mt-1 text-[11px] ${t.deadline < today ? "text-red-500" : "text-muted"}`}>{formatDate(t.deadline)}</p></div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
