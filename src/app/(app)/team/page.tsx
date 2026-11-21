import { requireUser } from "@/lib/auth";
import { getAchievementSummaries, getAllTasks, getUsers } from "@/lib/data";
import { OPEN_STATUSES, FINISHED_STATUSES } from "@/lib/utils";
import { PageHeader } from "@/components/ui";
import { TeamList } from "@/components/TeamClient";
import { LazyChat } from "@/components/LazyChat";

export const dynamic = "force-dynamic";

export default async function TeamPage({ searchParams }: { searchParams: Promise<{ chat?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const [users, allTasks] = await Promise.all([getUsers(), getAllTasks()]);
  const summaries = await getAchievementSummaries(users, allTasks);

  const stats: Record<number, { open: number; done: number; points: number }> = {};
  for (const u of users) {
    stats[u.id] = {
      open: allTasks.filter((t) => t.assigneeId === u.id && OPEN_STATUSES.includes(t.status)).length,
      done: allTasks.filter((t) => t.assigneeId === u.id && FINISHED_STATUSES.includes(t.status)).length,
      points: summaries.find((s) => s.user.id === u.id)?.points ?? 0,
    };
  }

  return (
    <>
      <PageHeader title="Команда и чат" subtitle={`${users.length} участников · общий чат и личные сообщения`} />
      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[400px_minmax(0,1fr)]">
        <div className="min-w-0"><TeamList users={users} me={{ id: user.id, role: user.role }} stats={stats} /></div>
        <div className="min-w-0"><LazyChat users={users} meId={user.id} initialPeer={sp.chat ? Number(sp.chat) || 0 : 0} unlimited={user.role === "super_admin"} /></div>
      </div>
    </>
  );
}
