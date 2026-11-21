import { recordAgentUsage, type AgentUsageKind } from "@/db/repo";
import { hasAgentAccess, hasOperatorAccess } from "@/lib/aiPolicy";
import { getRequestUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await getRequestUser(req);
  if (!user) {
    return Response.json({ ok: false, error: "Требуется авторизация" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as
    | {
        kind?: string;
        refId?: number;
        model?: string;
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
    | null;

  const kind: AgentUsageKind = body?.kind === "operator" ? "operator" : "agent";
  const allowed = kind === "operator" ? hasOperatorAccess(user) : hasAgentAccess(user);
  if (!allowed) {
    return Response.json({ ok: false, error: "Доступ не выдан главным администратором" }, { status: 403 });
  }

  const prompt = Math.max(0, Math.round(Number(body?.promptTokens ?? body?.prompt_tokens ?? 0) || 0));
  const completion = Math.max(
    0,
    Math.round(Number(body?.completionTokens ?? body?.completion_tokens ?? 0) || 0),
  );
  const total = Math.max(
    prompt + completion,
    Math.round(Number(body?.totalTokens ?? body?.total_tokens ?? 0) || 0),
  );

  if (total > 0 || prompt > 0 || completion > 0) {
    await recordAgentUsage({
      userId: user.id,
      kind,
      refId: Number(body?.refId ?? 0) || 0,
      model: String(body?.model ?? "").slice(0, 160),
      prompt,
      completion,
      total,
    });
  }

  return Response.json({ ok: true });
}
