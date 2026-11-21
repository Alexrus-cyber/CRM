import {
  createAgentConversation,
  listAgentConversations,
  type AgentConversationKind,
} from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { DEFAULT_PLAN_PROMPT } from "@/lib/operatorPlan";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isKind(value: string | null): value is AgentConversationKind {
  return value === "plan" || value === "agent";
}

async function operatorUser() {
  const user = await getCurrentUser();
  if (!user) return { response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.role !== "super_admin") {
    return { response: Response.json({ error: "Только главный администратор" }, { status: 403 }) };
  }
  return { user };
}

/** Список отдельных историй планировщика или вкладки «Агент». */
export async function GET(req: Request) {
  const auth = await operatorUser();
  if (auth.response) return auth.response;

  const kind = new URL(req.url).searchParams.get("kind");
  if (!isKind(kind)) return Response.json({ error: "Укажите тип чата: plan или agent" }, { status: 400 });

  const conversations = await listAgentConversations(auth.user.id, kind, 1000);
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
  const auth = await operatorUser();
  if (auth.response) return auth.response;

  const body = (await req.json().catch(() => null)) as
    | { kind?: string; title?: string; systemPrompt?: string }
    | null;
  if (!body || (body.kind !== "plan" && body.kind !== "agent")) {
    return Response.json({ error: "Укажите тип чата: plan или agent" }, { status: 400 });
  }

  const kind: AgentConversationKind = body.kind;
  const title = String(body.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120) ||
    (kind === "plan" ? "Новый план" : "Новый чат");
  const systemPrompt =
    kind === "plan"
      ? (typeof body.systemPrompt === "string" ? body.systemPrompt.trim() : "") || DEFAULT_PLAN_PROMPT
      : "";
  const conversation = await createAgentConversation(auth.user.id, kind, title, systemPrompt);
  return Response.json({ conversation }, { headers: { "Cache-Control": "no-store" } });
}
