import { requireUser } from "@/lib/auth";
import { getCounterparties } from "@/lib/data";
import { canManageData } from "@/lib/utils";
import { PageHeader } from "@/components/ui";
import { CounterpartiesClient } from "@/components/CounterpartiesClient";

export const dynamic = "force-dynamic";

export default async function CounterpartiesPage() {
  const user = await requireUser();
  const items = await getCounterparties();
  return (
    <>
      <PageHeader
        title="Контрагенты"
        subtitle="База клиентов и партнёров: реквизиты, контакты и заметки"
      />
      <CounterpartiesClient items={items} isAdmin={canManageData(user.role)} />
    </>
  );
}
