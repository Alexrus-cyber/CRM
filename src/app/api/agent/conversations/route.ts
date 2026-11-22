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
  return value === "plan" || value === "agent" || value === "tester";
}

function canUseKind(user: { role?: string | null; canUseAgent?: boolean | null; canUseOperator?: boolean | null }, kind: AgentConversationKind): boolean {
  return kind === "plan" ? hasOperatorAccess(user) : hasAgentAccess(user);
}

/** Список отдельных историй планировщика, «Агента» или «Тестировщика». */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const kind = new URL(req.url).searchParams.get("kind");
  if (!isKind(kind)) return Response.json({ error: "Укажите тип чата: plan, agent или tester" }, { status: 400 });
  if (!canUseKind(user, kind)) {
    return Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 });
  }

  const conversations = await listAgentConversations(user.id, kind, 1000);
  return Response.json(
    {
      conversations: conversations.map(({ id, kind, title, messagesCount, createdAt, updatedAt }) => ({
        id,
        kind,
        title,
        messagesCount,
        createdAt,
        updatedAt,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Создать новый чат; системный промпт планировщика копируется в эту сессию. */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { kind?: string; title?: string; systemPrompt?: string }
    | null;
  if (!body || (body.kind !== "plan" && body.kind !== "agent" && body.kind !== "tester")) {
    return Response.json({ error: "Укажите тип чата: plan, agent или tester" }, { status: 400 });
  }

  const kind: AgentConversationKind = body.kind;
  if (!canUseKind(user, kind)) {
    return Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 });
  }
  const title =
    String(body.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120) ||
    (kind === "plan" ? "Новый план" : kind === "tester" ? "Тестирование" : "Новый чат");
  const systemPrompt =
    kind === "plan"
      ? (typeof body.systemPrompt === "string" ? body.systemPrompt.trim() : "") || DEFAULT_PLAN_PROMPT
      : "";
  const conversation = await createAgentConversation(user.id, kind, title, systemPrompt);
  return Response.json({ conversation }, { headers: { "Cache-Control": "no-store" } });
}
