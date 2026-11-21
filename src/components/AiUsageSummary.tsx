import { Gauge } from "lucide-react";
import { Badge, Card } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatTokenCount } from "@/lib/aiPolicy";

/**
 * Карточка расхода токенов ИИ. Серверный компонент: данные приходят из
 * `/api/ai/usage` (в клиенте) или напрямую из репозитория (в профиле и команде).
 */
export function AiUsageSummary({
  used,
  limit,
  total,
  perChat,
  chats,
  override,
  summary,
  className,
}: {
  /** Токенов израсходовано за текущий месяц. */
  used: number;
  /** Месячный лимит роли; null — без ограничения. */
  limit: number | null;
  /** Всего токенов за всё время. */
  total: number;
  /** Лимит на один чат; null — без ограничения. */
  perChat: number | null;
  /** Сколько чатов у аккаунта. */
  chats: number;
  /** Расширение лимита администратором на этот месяц (если есть). */
  override?: number | null;
  summary?: string;
  className?: string;
}) {
  const left = limit === null ? null : Math.max(limit - used, 0);
  const percent = limit === null ? 0 : Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  const exhausted = limit !== null && used >= limit;

  return (
    <Card
      className={className}
      title={
        <span className="flex items-center gap-1.5">
          <Gauge size={14} className="text-emerald-500" />
          Токены ИИ
        </span>
      }
      subtitle="Счётчик по всем чатам аккаунта"
      action={<Badge className="border-border text-muted">{formatTokenCount(used)} за месяц</Badge>}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="rounded-xl border border-border bg-card2/60 px-2 py-1.5">
            <p className="text-muted">Всего за всё время</p>
            <p className="text-sm font-semibold">{formatTokenCount(total)}</p>
          </div>
          <div className="rounded-xl border border-border bg-card2/60 px-2 py-1.5">
            <p className="text-muted">Чатов</p>
            <p className="text-sm font-semibold">{chats}</p>
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
            <span>Месяц</span>
            <span>
              {formatTokenCount(used)} / {formatTokenCount(limit)}
            </span>
          </div>
          {limit !== null ? (
            <>
              <div className="h-1.5 overflow-hidden rounded-full bg-card2">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    exhausted ? "bg-red-500" : percent > 80 ? "bg-amber-500" : "bg-emerald-500",
                  )}
                  style={{ width: `${Math.max(percent, 2)}%` }}
                />
              </div>
              <p className={cn("mt-1 text-[11px]", exhausted ? "text-red-500" : "text-muted")}>
                Осталось: {formatTokenCount(left)}
                {override ? " · лимит расширен администратором" : " · расширить лимит может администратор"}
              </p>
            </>
          ) : (
            <p className="text-[11px] text-muted">Без месячного лимита</p>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5 text-[10px]">
          <Badge className="border-border text-muted">на чат: {formatTokenCount(perChat)}</Badge>
          <Badge className="border-border text-muted">чатов без ограничений</Badge>
        </div>
        {summary && <p className="text-[11px] text-muted">{summary}</p>}
      </div>
    </Card>
  );
}
