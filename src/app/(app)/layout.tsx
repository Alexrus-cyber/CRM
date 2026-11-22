import Link from "next/link";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth";
import { getDbInfo } from "@/db/dialect";
import { Sidebar } from "@/components/Sidebar";
import { LiveUpdates } from "@/components/LiveUpdates";
import { MessageToasts } from "@/components/MessageToasts";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const db = await getDbInfo();
  return (
    <div className="min-h-screen">
      {/* Живые обновления: чужая задача появляется без перезагрузки страницы. */}
      <LiveUpdates />
      {/* Всплывающие уведомления о новых сообщениях — в правом нижнем углу. */}
      <MessageToasts userId={user.id} />
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
        <div className="mx-auto min-w-0 max-w-[1400px]">
          {user.mustChangePassword && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              <span>
                Вы вошли по временному паролю. Для безопасности аккаунта необходимо задать новый пароль.
              </span>
              <Link
                href="/profile?forcePasswordChange=1"
                className="rounded-xl bg-amber-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-amber-400"
              >
                Сменить пароль
              </Link>
            </div>
          )}
          {children}
        </div>
      </main>
    </div>
  );
}
