import {
  createAgentConversation,
  listAgentConversations,
  type AgentConversationKind,
} from "@/db/repo";
import { hasAgentAccess, hasOperatorAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import { DEFAULT_PLAN_PROMPT } from "@/lib/operatorPlan";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isKind(value: string | null): value is AgentConversationKind {
  return value === "plan" || value === "agent" || value === "tester" || value === "subagent";
}

function canUseKind(user: { role?: string | null; canUseAgent?: boolean | null; canUseOperator?: boolean | null }, kind: AgentConversationKind): boolean {
  return kind === "plan" ? hasOperatorAccess(user) : hasAgentAccess(user);
}

/** Список отдельных историй планировщика, «Агента», «Тестировщика» или «Субагентов». */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const searchParams = new URL(req.url).searchParams;
  const kind = searchParams.get("kind");
  if (!isKind(kind)) {
    return Response.json({ error: "Укажите тип чата: plan, agent, tester или subagent" }, { status: 400 });
  }
  if (!canUseKind(user, kind)) {
    return Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 });
  }

  const rawSubId = searchParams.get("subagentId");
  const subagentId = rawSubId && Number.isFinite(Number(rawSubId)) && Number(rawSubId) > 0 ? Math.floor(Number(rawSubId)) : null;

  const conversations = await listAgentConversations(user.id, kind, 1000, subagentId);
  return Response.json(
    {
      conversations: conversations.map(({ id, kind, subagentId: sId, title, messagesCount, createdAt, updatedAt }) => ({
        id,
        kind,
        ...(sId ? { subagentId: sId } : {}),
        title,
        messagesCount,
        createdAt,
        updatedAt,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Создать новый чат; системный промпт планировщика или субагента копируется в эту сессию. */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { kind?: string; title?: string; systemPrompt?: string; subagentId?: number }
    | null;
  if (!body || !isKind(body.kind ?? null)) {
    return Response.json({ error: "Укажите тип чата: plan, agent, tester или subagent" }, { status: 400 });
  }

  const kind = body.kind as AgentConversationKind;
  if (!canUseKind(user, kind)) {
    return Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 });
  }
  const subagentId =
    kind === "subagent" && body.subagentId && Number.isFinite(Number(body.subagentId)) && Number(body.subagentId) > 0
      ? Math.floor(Number(body.subagentId))
      : null;
  const title =
    String(body.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120) ||
    (kind === "plan"
      ? "Новый план"
      : kind === "tester"
        ? "Тестирование"
        : kind === "subagent"
          ? "Чат субагента"
          : "Новый чат");
  const systemPrompt =
    kind === "plan"
      ? (typeof body.systemPrompt === "string" ? body.systemPrompt.trim() : "") || DEFAULT_PLAN_PROMPT
      : kind === "subagent" && typeof body.systemPrompt === "string"
        ? body.systemPrompt.trim().slice(0, 16_000)
        : "";
  const conversation = await createAgentConversation(user.id, kind, title, systemPrompt, subagentId);
  return Response.json({ conversation }, { headers: { "Cache-Control": "no-store" } });
}
