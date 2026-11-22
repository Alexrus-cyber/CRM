import {
  getAgentConversation,
  getTesterRun,
  listAgentConversationMessages,
  updateTesterMinorDecision,
} from "@/db/repo";
import { hasAgentAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function parseId(raw: string): number {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

/** Детали прогона Тестировщика и его отдельной QA-переписки. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(user)) {
    return Response.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  const id = parseId((await params).id);
  if (!id) return Response.json({ error: "Некорректный ID прогона" }, { status: 400 });

  const run = await getTesterRun(user.id, id);
  if (!run) return Response.json({ error: "Отчёт тестировщика не найден" }, { status: 404 });

  const [conversation, messages] = await Promise.all([
    getAgentConversation(user.id, run.testerConversationId),
    listAgentConversationMessages(run.testerConversationId),
  ]);

  return Response.json(
    { run, conversation, messages },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Сохранить решение человека по мелким/некритическим замечаниям Тестировщика. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(user)) {
    return Response.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  const id = parseId((await params).id);
  if (!id) return Response.json({ error: "Некорректный ID прогона" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as
    | { decision?: string; note?: string }
    | null;
  const decision = body?.decision;
  if (decision !== "approved" && decision !== "rejected") {
    return Response.json({ error: "Укажите решение: approved или rejected" }, { status: 400 });
  }

  const updated = await updateTesterMinorDecision(
    user.id,
    id,
    decision,
    typeof body?.note === "string" ? body.note.slice(0, 1000) : undefined,
  );
  if (!updated) return Response.json({ error: "Отчёт тестировщика не найден" }, { status: 404 });

  return Response.json({ ok: true, run: updated }, { headers: { "Cache-Control": "no-store" } });
}
