import { Trophy } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getAchievementSummaries, getUserById } from "@/lib/data";
import { PageHeader } from "@/components/ui";
import { ProfileForm } from "@/components/ProfileClient";
import { UserAchievementsPanel } from "@/components/Achievements";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const me = await requireUser();
  const [user, summaries] = await Promise.all([getUserById(me.id), getAchievementSummaries()]);
  if (!user) return null;
  const idx = summaries.findIndex((s) => s.user.id === me.id);
  const summary = summaries[idx];

  return (
    <>
      <PageHeader title="Мой профиль" subtitle="Личная информация, аватар, пароль и ваши достижения" />
      <ProfileForm user={user} />
      <div className="mt-8">
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold"><Trophy size={18} className="text-amber-400" /> Достижения</h2>
        {summary && <UserAchievementsPanel summary={summary} rank={idx + 1} total={summaries.length} />}
      </div>
    </>
  );
}
