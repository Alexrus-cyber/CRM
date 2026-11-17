import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth";
import { getDbInfo } from "@/db/dialect";
import { Sidebar } from "@/components/Sidebar";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const db = await getDbInfo();
  return (
    <div className="min-h-screen">
      <Sidebar
        user={{
          id: user.id,
          name: user.name,
          role: user.role,
          position: user.position,
          avatarColor: user.avatarColor,
          avatarUrl: user.avatarUrl,
        }}
        dbLabel={db.label}
      />
      <main className="min-w-0 max-w-full px-3 pb-[calc(5rem+env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pt-4 lg:ml-64 lg:pb-10 lg:pt-8">
        <div className="mx-auto min-w-0 max-w-[1400px]">{children}</div>
      </main>
    </div>
  );
}
