import { requireUser } from "@/lib/auth";
import { getCounterparties, getUsers, getVisibleTasks } from "@/lib/data";
import { lastExportAt, listExportedTaskIds } from "@/db/repo";
import { canManageData, isCompanyRole } from "@/lib/utils";
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
  const company = isCompanyRole(user.role);
  // Менеджер управляет рабочими данными как админ, но не пользователями и паролями.
  const canManage = canManageData(user.role);
  const [tasks, users, counterparties] = await Promise.all([
    getVisibleTasks(user),
    getUsers(),
    getCounterparties(),
  ]);
  // Журнал выгрузок персональный: файлы скачивают админы и менеджеры.
  const exportedTaskIds = canManage ? await listExportedTaskIds(user.id) : [];
  const exportedAt = canManage ? await lastExportAt(user.id) : null;

  return (
    <>
      <PageHeader
        title="Задачи"
        subtitle={
          company
            ? "Все задачи компании. Нажмите на строку, чтобы открыть задачу."
            : "Ваши задачи: где вы исполнитель или автор."
        }
      />
      <TasksClient
        tasks={tasks}
        users={users}
        counterparties={counterparties.map((c) => ({ id: c.id, name: c.name }))}
        me={{ id: user.id, role: user.role }}
        exportState={{ exportedTaskIds, lastExportAt: exportedAt, isAdmin: canManage }}
        initialAssignee={sp.assignee ? Number(sp.assignee) : undefined}
        initialStatus={sp.status as TaskStatus | "open" | "overdue" | undefined}
      />
    </>
  );
}
