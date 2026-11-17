import { requireUser } from "@/lib/auth";
import { getCounterparties, getUsers, getVisibleTasks } from "@/lib/data";
import { lastExportAt, listExportedTaskIds } from "@/db/repo";
import { isAdminRole } from "@/lib/utils";
import { PageHeader } from "@/components/ui";
import { TasksClient } from "@/components/TasksClient";
import type { TaskStatus } from "@/db/schema";

export const dynamic = "force-dynamic";

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ assignee?: string; status?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const admin = isAdminRole(user.role);
  const [tasks, users, counterparties] = await Promise.all([
    getVisibleTasks(user),
    getUsers(),
    getCounterparties(),
  ]);
  // Export journal is per person; only administrators can download files.
  const exportedTaskIds = admin ? await listExportedTaskIds(user.id) : [];
  const exportedAt = admin ? await lastExportAt(user.id) : null;

  return (
    <>
      <PageHeader
        title="Задачи"
        subtitle={
          admin
            ? "Все задачи компании. Нажмите на строку, чтобы открыть задачу."
            : "Ваши задачи: где вы исполнитель или автор."
        }
      />
      <TasksClient
        tasks={tasks}
        users={users}
        counterparties={counterparties.map((c) => ({ id: c.id, name: c.name }))}
        me={{ id: user.id, role: user.role }}
        exportState={{ exportedTaskIds, lastExportAt: exportedAt, isAdmin: admin }}
        initialAssignee={sp.assignee ? Number(sp.assignee) : undefined}
        initialStatus={sp.status as TaskStatus | "open" | "overdue" | undefined}
      />
    </>
  );
}
