import Link from "next/link";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  ListTodo,
  Lock,
  ShieldCheck,
  Trophy,
  UserRound,
} from "lucide-react";
import { requireUser } from "@/lib/auth";
import {
  getAchievementSummaries,
  getCounterparties,
  getUsers,
  getVisibleTasks,
  isTaskLate,
  type TaskRow,
} from "@/lib/data";
import {
  cn,
  diffDays,
  FINISHED_STATUSES,
  formatDate,
  formatHours,
  isAdminRole,
  OPEN_STATUSES,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  STATUS_ORDER,
  todayStr,
} from "@/lib/utils";
import { Avatar, Badge, Card, PageHeader, StatCard } from "@/components/ui";
import { DashboardFilters, PeopleBars, SimpleBars, StatusDonut, type PersonBar } from "@/components/DashboardCharts";
import { Leaderboard, MyAchievementsCard } from "@/components/Achievements";
import { TodayTimeline } from "@/components/TodayTimeline";
import { RecentTasks } from "@/components/RecentTasks";
import { formatTimeLabel, isOverdueByDay, needsAcceptance } from "@/lib/taskTime";

export const dynamic = "force-dynamic";

type SP = { from?: string; to?: string; assignee?: string; author?: string; counterparty?: string; priority?: string };

const pluralDays = (n: number) => {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return "дней";
  if (last > 1 && last < 5) return "дня";
  return "день";
};

function TaskLine({ t, today }: { t: TaskRow; today: string }) {
  const late = t.deadline < today;
  const d = Math.abs(diffDays(today, t.deadline));
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-xl px-1.5 py-2 hover:bg-card2/70 sm:gap-3 sm:px-2">
      <Avatar name={t.assigneeName} color={t.assigneeColor} url={t.assigneeAvatar} size={28} className="sm:hidden" />
      <Avatar name={t.assigneeName} color={t.assigneeColor} url={t.assigneeAvatar} size={30} className="hidden sm:flex" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium leading-snug sm:text-sm">{t.title}</p>
        <p className="truncate text-[10px] text-muted sm:text-[11px]">
          {t.assigneeName}
          {t.counterpartyName ? ` · ${t.counterpartyName}` : ""}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className={cn("whitespace-nowrap text-[11px] font-medium tabular-nums sm:text-xs", late ? "text-red-500" : d <= 1 ? "text-amber-500" : "")}>
          {formatDate(t.deadline)}
          {t.deadlineTime ? <span className="ml-1 font-normal text-muted">{formatTimeLabel(t.deadlineTime)}</span> : null}
        </p>
        <p className="whitespace-nowrap text-[9px] text-muted sm:text-[10px]">
          {late ? `просрочено ${d} ${pluralDays(d)}` : d === 0 ? "сегодня" : d === 1 ? "завтра" : `через ${d} ${pluralDays(d)}`}
        </p>
      </div>
    </li>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const admin = isAdminRole(user.role);
  const today = todayStr();

  const [allVisible, users, counterparties] = await Promise.all([getVisibleTasks(user), getUsers(), getCounterparties()]);

  /**
   * Access scope:
   *  - administrator (admin / super_admin) → вся статистика компании;
   *  - сотрудник → только задачи, где он исполнитель.
   * Задачи, которые сотрудник поставил коллегам, в статистику не попадают:
   * для них есть отдельный счётчик «поставлено вами».
   */
  const scoped = admin ? allVisible : allVisible.filter((t) => t.assigneeId === user.id);

  const tasks = scoped.filter((t) => {
    if (sp.from && t.deadline < sp.from) return false;
    if (sp.to && t.deadline > sp.to) return false;
    if (sp.assignee && t.assigneeId !== Number(sp.assignee)) return false;
    if (sp.author && t.authorId !== Number(sp.author)) return false;
    if (sp.counterparty && t.counterpartyId !== Number(sp.counterparty)) return false;
    if (sp.priority && t.priority !== sp.priority) return false;
    return true;
  });

  const open = tasks.filter((t) => OPEN_STATUSES.includes(t.status));
  const finished = tasks.filter((t) => FINISHED_STATUSES.includes(t.status));
  const overdue = open.filter((t) => isOverdueByDay(t.deadline)).sort((a, b) => a.deadline.localeCompare(b.deadline));
  const upcoming = open.filter((t) => t.deadline >= today).sort((a, b) => a.deadline.localeCompare(b.deadline)).slice(0, 8);
  const openHours = open.reduce((s, t) => s + t.hours, 0);
  const onTimeRate = finished.length
    ? Math.round((finished.filter((t) => !isTaskLate(t, today)).length / finished.length) * 100)
    : null;
  const mustAcceptCount = scoped.filter((t) => t.assigneeId === user.id && needsAcceptance(t)).length;
  const authoredForOthers = allVisible.filter((t) => t.authorId === user.id && t.assigneeId !== user.id).length;

  const statusData = STATUS_ORDER.map((s) => ({ status: s, count: tasks.filter((t) => t.status === s).length }));

  const groupBy = (key: "assigneeId" | "authorId", nameKey: "assigneeName" | "authorName") => {
    const map = new Map<number, PersonBar & { hours: number; overdue: number; late: number }>();
    for (const t of tasks) {
      const id = t[key];
      const e = map.get(id) ?? { name: t[nameKey], open: 0, done: 0, total: 0, hours: 0, overdue: 0, late: 0 };
      e.total++;
      if (OPEN_STATUSES.includes(t.status)) {
        e.open++;
        e.hours += t.hours;
        if (t.deadline < today) e.overdue++;
      } else if (FINISHED_STATUSES.includes(t.status)) e.done++;
      if (isTaskLate(t, today)) e.late++;
      map.set(id, e);
    }
    return [...map.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.total - a.total);
  };
  const byAssignee = groupBy("assigneeId", "assigneeName");
  const byAuthor = groupBy("authorId", "authorName");
  const workload = [...byAssignee].sort((a, b) => b.hours - a.hours);
  const lateLeaders = [...byAssignee].filter((p) => p.late > 0).sort((a, b) => b.late - a.late);

  // Personal charts (employee dashboard).
  const personalPriorityHours = PRIORITY_ORDER.map((p) => ({
    name: PRIORITY_LABELS[p],
    value: Math.round(open.filter((t) => t.priority === p).reduce((s, t) => s + t.hours, 0) * 10) / 10,
  })).filter((p) => p.value > 0);

  const personalByDay = (() => {
    const map = new Map<string, number>();
    for (const t of open) {
      if (t.deadline < today) continue;
      if (diffDays(today, t.deadline) > 13) continue;
      map.set(t.deadline, (map.get(t.deadline) ?? 0) + 1);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, value]) => ({ name: day.slice(8, 10) + "." + day.slice(5, 7), value }));
  })();

  const summaries = await getAchievementSummaries(admin ? users : users.filter((u) => u.id === user.id));
  const mySummary = summaries.find((s) => s.user.id === user.id);

  const hour = Number(new Intl.DateTimeFormat("ru-RU", { hour: "numeric", hour12: false, timeZone: "Europe/Moscow" }).format(new Date()));
  const greeting = hour < 6 ? "Доброй ночи" : hour < 12 ? "Доброе утро" : hour < 18 ? "Добрый день" : "Добрый вечер";
  const scopeLabel = admin ? "Все задачи компании" : "Только ваши задачи";

  // В блок «Последние задачи» отдаём только верхушку списка: клиентская часть
  // рисует её порциями по 6, поэтому сортировать весь массив на клиенте незачем.
  const recentTasks = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);

  return (
    <>
      <PageHeader
        title={`${greeting}, ${user.name.split(" ")[0]}!`}
        subtitle={admin ? "Полная статистика по задачам компании" : "Ваша личная статистика: задачи, сроки и достижения"}
        action={
          <Badge className={admin ? "border-violet-500/40 bg-violet-500/15 text-violet-400" : "border-emerald-500/40 bg-emerald-500/15 text-emerald-500"}>
            {admin ? <ShieldCheck size={12} /> : <Lock size={12} />}
            {scopeLabel}
          </Badge>
        }
      />

      <div className="mb-3 sm:mb-4">
        <TodayTimeline tasks={allVisible} meId={user.id} userName={user.name} />
      </div>

      <DashboardFilters
        values={sp}
        users={admin ? users : []}
        counterparties={(admin
          ? counterparties
          : counterparties.filter((c) => scoped.some((t) => t.counterpartyId === c.id))
        ).map((c) => ({ id: c.id, name: c.name }))}
        showPeople={admin}
      />

      <div className="mt-4 grid min-w-0 grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label={admin ? "Всего задач" : "Мои задачи"} value={tasks.length} icon={<ListTodo size={16} />} hint="за выбранный период" />
        <StatCard label="В работе" value={open.length} icon={<Clock size={16} />} accent="#60a5fa" hint={formatHours(Math.round(openHours * 10) / 10) + " план"} />
        <StatCard
          label="Просрочено"
          value={<span className={overdue.length ? "text-red-500" : ""}>{overdue.length}</span>}
          icon={<AlertTriangle size={16} />}
          accent="#ef4444"
          hint={mustAcceptCount > 0 ? `${mustAcceptCount} обязан взять` : overdue.length ? "требуют внимания" : "всё по плану"}
        />
        <StatCard label="Выполнено" value={finished.length} icon={<CheckCircle2 size={16} />} accent="#34d399" hint={onTimeRate !== null ? `${onTimeRate}% в срок` : "нет завершённых"} />
        <StatCard
          label="Ближайшие 7 дней"
          value={open.filter((t) => t.deadline >= today && diffDays(today, t.deadline) <= 7).length}
          icon={<CalendarClock size={16} />}
          accent="#f59e0b"
          hint={admin ? "дедлайнов" : authoredForOthers ? `вами поставлено: ${authoredForOthers}` : "дедлайнов"}
        />
        <StatCard
          label="Достижения"
          value={mySummary?.unlockedCount ?? 0}
          icon={<Trophy size={16} />}
          accent="#a78bfa"
          hint={`${mySummary?.points ?? 0} очков`}
        />
      </div>

      <div className="mt-3 grid min-w-0 gap-3 sm:mt-4 sm:gap-4 xl:grid-cols-2">
        <Card title="Распределение по статусам" subtitle={admin ? "Доля задач в каждом статусе" : "Ваши задачи по статусам"}>
          <StatusDonut data={statusData} />
        </Card>

        {admin ? (
          <Card title="Задачи по исполнителям" subtitle="Открытые и выполненные задачи">
            <PeopleBars data={byAssignee} />
          </Card>
        ) : (
          <Card title="Мои часы по срочности" subtitle="Плановые часы в открытых задачах">
            <SimpleBars data={personalPriorityHours} name="Часы" unit="ч" color="#7c5cff" />
          </Card>
        )}

        {admin ? (
          <>
            <Card title="Задачи по авторам" subtitle="Кто выставил больше всего задач">
              <SimpleBars data={byAuthor.map((p) => ({ name: p.name, value: p.total }))} name="Поставлено" color="#a78bfa" />
            </Card>
            <Card title="Загрузка по сотрудникам" subtitle="Плановые часы по открытым задачам">
              <SimpleBars data={workload.filter((p) => p.hours > 0).map((p) => ({ name: p.name, value: Math.round(p.hours * 10) / 10 }))} name="Часы" unit="ч" color="#7c5cff" />
              {workload.length > 0 && (
                <div className="mt-3 w-full max-w-full">
                  <table className="w-full table-fixed text-[11px] sm:text-xs">
                    <colgroup>
                      <col />
                      <col className="w-9 sm:w-16" />
                      <col className="w-10 sm:w-16" />
                      <col className="w-11 sm:w-20" />
                      <col className="w-10 sm:w-24" />
                    </colgroup>
                    <thead className="text-muted">
                      <tr className="border-b border-border">
                        <th className="py-1.5 pr-1 text-left font-medium">Сотрудник</th>
                        <th className="py-1.5 pl-1 text-right font-medium">Откр.</th>
                        <th className="py-1.5 pl-1 text-right font-medium">Часы</th>
                        <th className="py-1.5 pl-1 text-right font-medium">Проср.</th>
                        <th className="py-1.5 pl-1 text-right font-medium">Вып.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {workload.map((p) => (
                        <tr key={p.id} className="border-b border-border/50 last:border-0">
                          <td className="min-w-0 py-1.5 pr-1">
                            <Link href={`/team/${p.id}`} className="block min-w-0 hover:text-accent2">
                              <span className="block truncate leading-tight">{p.name}</span>
                            </Link>
                          </td>
                          <td className="py-1.5 pl-1 text-right tabular-nums">{p.open}</td>
                          <td className="py-1.5 pl-1 text-right tabular-nums">{Math.round(p.hours * 10) / 10}</td>
                          <td className={cn("py-1.5 pl-1 text-right tabular-nums", p.overdue > 0 && "text-red-500")}>{p.overdue}</td>
                          <td className="py-1.5 pl-1 text-right tabular-nums text-emerald-500">{p.done}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        ) : (
          <Card title="Мои ближайшие сроки" subtitle="Сколько задач закрыть в ближайшие дни">
            <SimpleBars data={personalByDay} name="Задач" unit="шт" color="#a78bfa" />
          </Card>
        )}

        <Card
          title={
            <span className="flex min-w-0 items-center gap-2">
              <AlertTriangle size={14} className="shrink-0 text-red-500" />
              <span className="truncate">{admin ? "Просроченные задачи" : "Мои просроченные задачи"} ({overdue.length})</span>
            </span>
          }
          subtitle={admin ? "Открытые задачи компании с истёкшим сроком" : "Ваши задачи с истёкшим сроком"}
          action={
            <Link href="/tasks?status=overdue" className="whitespace-nowrap text-xs font-medium text-accent2 hover:underline">
              Все →
            </Link>
          }
        >
          {overdue.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted">Просроченных задач нет 🎉</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {overdue.slice(0, 8).map((t) => (
                <TaskLine key={t.id} t={t} today={today} />
              ))}
            </ul>
          )}
        </Card>

        {admin && (
          <Card title="Кто больше всего просрочил" subtitle="Просроченные сейчас и выполненные с опозданием">
            <SimpleBars data={lateLeaders.map((p) => ({ name: p.name, value: p.late }))} name="Просрочек" color="#ef4444" />
          </Card>
        )}
      </div>

      <div className="mt-3 grid min-w-0 gap-3 sm:mt-4 sm:gap-4 xl:grid-cols-3">
        <Card
          title={admin ? "Ближайшие дедлайны" : "Мои ближайшие дедлайны"}
          subtitle="Что нужно сделать в первую очередь"
          className="min-w-0 xl:col-span-1"
          action={
            <Link href="/calendar" className="whitespace-nowrap text-xs font-medium text-accent2 hover:underline">
              Календарь →
            </Link>
          }
        >
          {upcoming.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted">Нет открытых задач с будущими сроками</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {upcoming.map((t) => (
                <TaskLine key={t.id} t={t} today={today} />
              ))}
            </ul>
          )}
        </Card>

        <Card
          title={admin ? "Последние задачи" : "Мои последние задачи"}
          subtitle={admin ? "Недавно созданные" : "Недавно созданные и назначенные вам"}
          className="xl:col-span-2"
          action={
            <Link href="/tasks" className="whitespace-nowrap text-xs font-medium text-accent2 hover:underline">
              Все задачи →
            </Link>
          }
        >
          {tasks.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted">Задач пока нет</p>
          ) : (
            <RecentTasks tasks={recentTasks} today={today} />
          )}
        </Card>
      </div>

      <Card
        className="mt-3 sm:mt-4"
        title={
          <span className="flex min-w-0 items-center gap-2">
            <Trophy size={14} className="shrink-0 text-amber-400" />
            <span className="truncate">{admin ? "Доска почёта" : "Мои достижения"}</span>
          </span>
        }
        subtitle={admin ? "Лучшие достижения команды" : "Личные награды и прогресс"}
        action={
          <Link href="/profile" className="whitespace-nowrap text-xs font-medium text-accent2 hover:underline">
            {admin ? "Мои достижения →" : "Все достижения →"}
          </Link>
        }
      >
        {admin ? (
          <Leaderboard summaries={summaries} />
        ) : mySummary ? (
          <MyAchievementsCard summary={mySummary} />
        ) : (
          <p className="py-6 text-center text-xs text-muted">
            <UserRound size={16} className="mx-auto mb-1.5" />
            Достижения появятся после первых выполненных задач
          </p>
        )}
      </Card>
    </>
  );
}
