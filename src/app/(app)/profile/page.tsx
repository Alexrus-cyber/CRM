import { Trophy } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getAchievementSummaries, getUserById } from "@/lib/data";
import { getAiQuotaOverride, getAiUsage, listAiChats } from "@/db/repo";
import { aiPolicyFor } from "@/lib/aiPolicy";
import { PageHeader } from "@/components/ui";
import { AiUsageSummary } from "@/components/AiUsageSummary";
import { ProfileForm } from "@/components/ProfileClient";
import { UserAchievementsPanel } from "@/components/Achievements";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const me = await requireUser();
  const [user, summaries, usage, override, chats] = await Promise.all([
    getUserById(me.id),
    getAchievementSummaries(),
    getAiUsage(me.id),
    getAiQuotaOverride(me.id),
    listAiChats(me.id, 200),
  ]);
  if (!user) return null;
  const policy = aiPolicyFor(me.role, override?.monthlyLimit ?? null);
  const idx = summaries.findIndex((s) => s.user.id === me.id);
  const summary = summaries[idx];

  return (
    <>
      <PageHeader title="Мой профиль" subtitle="Личная информация, аватар, пароль, токены ИИ и ваши достижения" />
      <div className="mb-4">
        <AiUsageSummary
          used={usage.month.total}
          limit={policy.monthlyTokens}
          total={usage.all.total}
          perChat={policy.perChatTokens}
          chats={chats.length}
          override={override?.monthlyLimit ?? null}
          summary={policy.summary}
        />
      </div>
      <ProfileForm user={user} />
      <div className="mt-8">
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold"><Trophy size={18} className="text-amber-400" /> Достижения</h2>
        {summary && <UserAchievementsPanel summary={summary} rank={idx + 1} total={summaries.length} />}
      </div>
    </>
  );
}
