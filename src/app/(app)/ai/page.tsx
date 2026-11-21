import { Bot, FlaskConical, Gauge, MessagesSquare, MonitorCog, Sparkles, ShieldCheck } from "lucide-react";
import { requireUser } from "@/lib/auth";
import {
  getAgentUsage,
  getAiQuotaOverride,
  getAiUsage,
  listAiChats,
  listUsersAgentUsage,
} from "@/db/repo";
import {
  aiPolicyFor,
  AI_ROLE_POLICY,
  canViewAgentUsage,
  formatStepLimit,
  formatTokenCount,
  hasAgentAccess,
  hasOperatorAccess,
} from "@/lib/aiPolicy";
import { ROLE_LABELS } from "@/lib/utils";
import { Badge, Card, PageHeader } from "@/components/ui";
import { LazyAiChat } from "@/components/LazyAiChat";
import { AgentChat } from "@/components/AgentChat";
import { OperatorPanel } from "@/components/OperatorPanel";
import { AiTabs, type AiTab } from "@/components/AiTabs";
import { AiUsageSummary } from "@/components/AiUsageSummary";
import { AgentUsageCard } from "@/components/AgentUsageCard";

export const dynamic = "force-dynamic";

export default async function AiPage() {
  const user = await requireUser();
  const isSuperAdmin = user.role === "super_admin";
  const agentAllowed = hasAgentAccess(user);
  const operatorAllowed = hasOperatorAccess(user);
  const canSeeAgentUsage = canViewAgentUsage(user);

  const [usage, override, chats, agentUsage, allUsersAgentUsage] = await Promise.all([
    getAiUsage(user.id),
    getAiQuotaOverride(user.id),
    listAiChats(user.id, isSuperAdmin ? 1000 : 200),
    canSeeAgentUsage ? getAgentUsage(user.id) : Promise.resolve(null),
    canSeeAgentUsage ? listUsersAgentUsage() : Promise.resolve([]),
  ]);
  const policy = aiPolicyFor(user.role, override?.monthlyLimit ?? null);

  const tabs: AiTab[] = [
    {
      id: "chat",
      label: "Чат с моделью",
      hint: "Обычный диалог: файлы, картинки, RAG, режимы раздумий",
      icon: <MessagesSquare size={14} />,
      content: <LazyAiChat userName={user.name} unlimited={isSuperAdmin} />,
    },
  ];

  if (agentAllowed) {
    tabs.push({
      id: "agent",
      label: "Агент",
      hint: "Эксперимент: агент создаёт файлы и управляет экраном",
      icon: <Bot size={14} />,
      content: <AgentChat userName={user.name} unlimited={isSuperAdmin} />,
    });
  }

  if (operatorAllowed) {
    tabs.push({
      id: "operator",
      label: "Оператор",
      hint: "Бот, который управляет рабочим столом и возвращает файлы в чат",
      icon: <MonitorCog size={14} />,
      content: <OperatorPanel unlimited={isSuperAdmin} />,
    });
  }

  const companyAgentSummary = agentUsage
    ? {
        currentMonth: agentUsage.currentMonth,
        month: {
          agent: {
            prompt: 0,
            completion: 0,
            total: allUsersAgentUsage.reduce((s, r) => s + r.monthAgent, 0),
            events: 0,
          },
          operator: {
            prompt: 0,
            completion: 0,
            total: allUsersAgentUsage.reduce((s, r) => s + r.monthOperator, 0),
            events: 0,
          },
          total: {
            prompt: 0,
            completion: 0,
            total: allUsersAgentUsage.reduce((s, r) => s + r.monthTotal, 0),
            events: 0,
          },
        },
        all: {
          agent: {
            prompt: 0,
            completion: 0,
            total: allUsersAgentUsage.reduce((s, r) => s + r.allAgent, 0),
            events: 0,
          },
          operator: {
            prompt: 0,
            completion: 0,
            total: allUsersAgentUsage.reduce((s, r) => s + r.allOperator, 0),
            events: 0,
          },
          total: {
            prompt: 0,
            completion: 0,
            total: allUsersAgentUsage.reduce((s, r) => s + r.allTotal, 0),
            events: agentUsage.all.total.events,
          },
        },
      }
    : null;

  tabs.push({
    id: "limits",
    label: "Лимиты и расход",
    hint: "Сколько токенов доступно вашей роли",
    icon: <Gauge size={14} />,
    content: (
      <div className="space-y-3">
        <AiUsageSummary
          used={usage.month.total}
          limit={policy.monthlyTokens}
          total={usage.all.total}
          perChat={policy.perChatTokens}
          chats={chats.length}
          override={override?.monthlyLimit ?? null}
          summary={policy.summary}
        />

        {canSeeAgentUsage && companyAgentSummary && (
          <AgentUsageCard
            usage={companyAgentSummary}
            users={allUsersAgentUsage}
            title="Расход токенов Агента и Оператора"
            subtitle="Виден только главному администратору · токены не ограничены и не входят в квоту чата"
          />
        )}

        {!canSeeAgentUsage && (agentAllowed || operatorAllowed) && (
          <Card
            title="Доступ к Агенту и Оператору"
            subtitle="Выдан главным администратором"
          >
            <p className="text-xs text-muted">
              Открыт доступ:{" "}
              <b className="text-text">
                {[agentAllowed ? "Агент" : "", operatorAllowed ? "Оператор" : ""].filter(Boolean).join(", ")}
              </b>
              . Использование этих инструментов не расходует ваш месячный лимит токенов чата с ИИ.
            </p>
          </Card>
        )}

        <Card
          title={
            <span className="flex items-center gap-1.5">
              <ShieldCheck size={14} className="text-accent2" />
              Правила по ролям
            </span>
          }
          subtitle="Один источник правды для интерфейса и сервера — src/lib/aiPolicy.ts"
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[11px]">
              <thead className="text-muted">
                <tr className="border-b border-border">
                  <th className="py-1.5 pr-2 font-medium">Роль</th>
                  <th className="py-1.5 pr-2 font-medium">На чат</th>
                  <th className="py-1.5 pr-2 font-medium">В месяц</th>
                  <th className="py-1.5 pr-2 font-medium">Шагов</th>
                  <th className="py-1.5 pr-2 font-medium">RAG</th>
                  <th className="py-1.5 font-medium">Раздумья</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(AI_ROLE_POLICY).map((row) => (
                  <tr
                    key={row.role}
                    className={row.role === user.role ? "bg-accent/10 font-medium" : "border-b border-border/60"}
                  >
                    <td className="py-1.5 pr-2">
                      {ROLE_LABELS[row.role]}
                      {row.role === user.role && <span className="ml-1 text-[9px] text-accent2">ваша</span>}
                    </td>
                    <td className="py-1.5 pr-2">{formatTokenCount(row.perChatTokens)}</td>
                    <td className="py-1.5 pr-2">{formatTokenCount(row.monthlyTokens)}</td>
                    <td className="py-1.5 pr-2">{formatStepLimit(row.maxSteps)}</td>
                    <td className="py-1.5 pr-2">{row.rag ? "да" : "нет"}</td>
                    <td className="py-1.5 text-muted">
                      {row.reasoning.length > 2 ? "любые" : row.reasoning.join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-muted">
            Главный администратор может расширить месячный лимит конкретному сотруднику в его карточке —
            вкладка «Команда». Расширение действует на текущий месяц.
          </p>
        </Card>
      </div>
    ),
  });

  return (
    <>
      <PageHeader
        title="Чат с ИИ"
        subtitle={
          agentAllowed || operatorAllowed
            ? "Диалог с моделью, агент с инструментами, оператор рабочего стола и лимиты"
            : "Тестовый harness: модель, тип раздумий, RAG-папка, файлы и картинки"
        }
        action={
          <span className="flex flex-wrap items-center gap-2">
            <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-500">
              <FlaskConical size={12} />
              Тестовый harness
            </Badge>
            {agentAllowed && (
              <Badge className="border-accent/40 bg-accent/10 text-accent2">
                <Sparkles size={12} />
                Агент
              </Badge>
            )}
          </span>
        }
      />
      <AiTabs tabs={tabs} />
    </>
  );
}
