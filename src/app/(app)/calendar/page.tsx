import { requireUser } from "@/lib/auth";
import { getCounterparties, getUsers, getVisibleTasks } from "@/lib/data";
import { PageHeader } from "@/components/ui";
import { CalendarClient } from "@/components/CalendarClient";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const user = await requireUser();
  const [tasks, users, counterparties] = await Promise.all([
    getVisibleTasks(user),
    getUsers(),
    getCounterparties(),
  ]);
  return (
    <>
      <PageHeader
        title="Календарь"
        subtitle="Планируйте задачи по дням: создавайте, переносите, закрывайте и удаляйте прямо из календаря"
      />
      <CalendarClient
        tasks={tasks}
        users={users}
        counterparties={counterparties.map((c) => ({ id: c.id, name: c.name }))}
        me={{ id: user.id, role: user.role }}
      />
    </>
  );
}
