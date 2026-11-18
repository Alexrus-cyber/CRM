import type { SafeUser } from "./auth";
import {
  listCounterparties as repoListCounterparties,
  listTasks as repoListTasks,
  listUsers as repoListUsers,
  getTask as repoGetTask,
  getUser as repoGetUser,
  messageCountsBySender,
  type CounterpartyRow,
  type TaskRow,
  type UserLite,
} from "@/db/repo";
import {
  achievementPoints,
  computeAchievements,
  emptyStats,
  type AchievementResult,
  type UserStats,
} from "./achievements";
import { dateToStr, isCompanyRole } from "./utils";

export type { CounterpartyRow, TaskRow, UserLite } from "@/db/repo";

export async function getUsers(): Promise<UserLite[]> {
  return repoListUsers();
}

export async function getUserById(id: number): Promise<UserLite | null> {
  return repoGetUser(id);
}

export async function getCounterparties(): Promise<CounterpartyRow[]> {
  return repoListCounterparties();
}

/** Админы и менеджеры видят всё, остальные — только свои задачи. */
export async function getVisibleTasks(user: SafeUser): Promise<TaskRow[]> {
  return repoListTasks(isCompanyRole(user.role) ? null : user.id);
}

export async function getAllTasks(): Promise<TaskRow[]> {
  return repoListTasks(null);
}

export async function getTaskById(id: number): Promise<TaskRow | null> {
  return repoGetTask(id);
}

export function canSeeTask(user: SafeUser, t: { assigneeId: number; authorId: number }) {
  return isCompanyRole(user.role) || t.assigneeId === user.id || t.authorId === user.id;
}

export function isTaskLate(t: TaskRow, today: string): boolean {
  if (t.status === "cancelled") return false;
  if (t.completedAt) return dateToStr(new Date(t.completedAt)) > t.deadline;
  if (t.closedAt) return dateToStr(new Date(t.closedAt)) > t.deadline;
  return t.deadline < today;
}

export function computeStatsFor(
  userId: number,
  allTasks: TaskRow[],
  messagesCount: number,
): UserStats {
  const s = emptyStats();
  s.messages = messagesCount;
  for (const t of allTasks) {
    if (t.authorId === userId) {
      s.created++;
      if (t.status === "closed") s.closedByMe++;
    }
    if (t.assigneeId === userId && (t.status === "done" || t.status === "closed")) {
      s.completed++;
      s.hours += t.hours;
      if (t.priority === "critical") s.criticalDone++;
      const finished = t.completedAt ?? t.closedAt;
      const finishedDay = finished ? dateToStr(new Date(finished)) : t.deadline;
      if (finishedDay <= t.deadline) s.onTime++;
      else s.late++;
    }
  }
  s.hours = Math.round(s.hours * 10) / 10;
  return s;
}

export type UserAchievementSummary = {
  user: UserLite;
  stats: UserStats;
  achievements: AchievementResult[];
  points: number;
  unlockedCount: number;
  best: AchievementResult | null;
};

export async function getAchievementSummaries(
  usersList?: UserLite[],
  allTasks?: TaskRow[],
): Promise<UserAchievementSummary[]> {
  const list = usersList ?? (await getUsers());
  const tasksAll = allTasks ?? (await getAllTasks());
  const msgMap = await messageCountsBySender();
  return list
    .map((u) => {
      const stats = computeStatsFor(u.id, tasksAll, msgMap.get(u.id) ?? 0);
      const achievements = computeAchievements(stats);
      const unlocked = achievements.filter((a) => a.unlocked);
      const best =
        unlocked.length > 0
          ? unlocked.reduce((b, a) => (a.points > b.points ? a : b), unlocked[0])
          : null;
      return {
        user: u,
        stats,
        achievements,
        points: achievementPoints(achievements),
        unlockedCount: unlocked.length,
        best,
      };
    })
    .sort((a, b) => b.points - a.points || b.unlockedCount - a.unlockedCount);
}
