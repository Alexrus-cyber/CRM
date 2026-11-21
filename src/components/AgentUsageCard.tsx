import { Bot, MonitorCog, Sparkles } from "lucide-react";
import { Badge, Card } from "@/components/ui";
import { formatTokenCount } from "@/lib/aiPolicy";
import type { AgentUsageSummaryData, UserAgentUsageRow } from "@/db/repo";
import { ROLE_LABELS } from "@/lib/utils";

/**
 * Сводка расхода токенов за Агента и Оператора.
 * Отображается ИСКЛЮЧИТЕЛЬНО главному администратору (`super_admin`) —
 * не входит в месячные лимиты обычного чата с ИИ.
 */
export function AgentUsageCard({
  usage,
  users,
  title = "Токены Агента и Оператора",
  subtitle = "Отдельный учёт (не тратит лимит обычного чата) · видно только Главному админу",
}: {
  usage: AgentUsageSummaryData;
  users?: UserAgentUsageRow[];
  title?: string;
  subtitle?: string;
}) {
  return (
    <Card
      title={
        <span className="flex items-center gap-1.5">
          <Sparkles size={14} className="text-amber-500" />
          {title}
        </span>
      }
      subtitle={subtitle}
      action={<Badge className="border-amber-500/30 bg-amber-500/10 text-amber-500">{formatTokenCount(usage.month.total.total)} за месяц</Badge>}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-card2/60 px-2.5 py-2">
            <p className="flex items-center gap-1 text-muted">
              <Bot size={12} className="text-amber-500" /> Агент (месяц)
            </p>
            <p className="mt-0.5 text-sm font-semibold">{formatTokenCount(usage.month.agent.total)}</p>
            <p className="text-[10px] text-muted">всего: {formatTokenCount(usage.all.agent.total)}</p>
          </div>
          <div className="rounded-xl border border-border bg-card2/60 px-2.5 py-2">
            <p className="flex items-center gap-1 text-muted">
              <MonitorCog size={12} className="text-cyan-500" /> Оператор (месяц)
            </p>
            <p className="mt-0.5 text-sm font-semibold">{formatTokenCount(usage.month.operator.total)}</p>
            <p className="text-[10px] text-muted">всего: {formatTokenCount(usage.all.operator.total)}</p>
          </div>
          <div className="rounded-xl border border-border bg-card2/60 px-2.5 py-2">
            <p className="text-muted">Итого за всё время</p>
            <p className="mt-0.5 text-sm font-semibold">{formatTokenCount(usage.all.total.total)}</p>
            <p className="text-[10px] text-muted">
              запросов: {usage.all.total.events.toLocaleString("ru-RU")} · без лимита токенов
            </p>
          </div>
        </div>

        {users && users.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[540px] text-left text-[11px]">
              <thead className="bg-card2/70 text-muted">
                <tr className="border-b border-border">
                  <th className="px-2.5 py-1.5 font-medium">Сотрудник</th>
                  <th className="px-2.5 py-1.5 font-medium">Доступ</th>
                  <th className="px-2.5 py-1.5 font-medium">Агент (мес / всего)</th>
                  <th className="px-2.5 py-1.5 font-medium">Оператор (мес / всего)</th>
                  <th className="px-2.5 py-1.5 font-medium">Итого</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.userId} className="border-b border-border/50 last:border-b-0">
                    <td className="px-2.5 py-1.5">
                      <span className="font-medium text-text">{u.name}</span>
                      <span className="ml-1 text-[10px] text-muted">· {ROLE_LABELS[u.role]}</span>
                    </td>
                    <td className="px-2.5 py-1.5 text-[10px]">
                      {u.canUseAgent || u.canUseOperator ? (
                        <span className="text-emerald-500">
                          {[u.canUseAgent ? "Агент" : "", u.canUseOperator ? "Оператор" : ""].filter(Boolean).join(" + ")}
                        </span>
                      ) : (
                        <span className="text-muted">нет</span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5">
                      {formatTokenCount(u.monthAgent)} / {formatTokenCount(u.allAgent)}
                    </td>
                    <td className="px-2.5 py-1.5">
                      {formatTokenCount(u.monthOperator)} / {formatTokenCount(u.allOperator)}
                    </td>
                    <td className="px-2.5 py-1.5 font-semibold">{formatTokenCount(u.allTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
