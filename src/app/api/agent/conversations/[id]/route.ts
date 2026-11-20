import {
  deleteAgentConversation,
  getAgentConversation,
  listAgentConversationMessages,
  updateAgentConversation,
} from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function operatorUser() {
  const user = await getCurrentUser();
  if (!user) return { response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.role !== "super_admin") {
    return { response: Response.json({ error: "Только главный администратор" }, { status: 403 }) };
  }
  return { user };
}

async function conversationId(params: Promise<{ id: string }>): Promise<number> {
  const id = Number((await params).id);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

/** Переписка и индивидуальный системный промпт план-чата. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await operatorUser();
  if (auth.response) return auth.response;

  const id = await conversationId(params);
  if (!id) return Response.json({ error: "Некорректный чат" }, { status: 400 });
  const conversation = await getAgentConversation(auth.user.id, id);
  if (!conversation) return Response.json({ error: "Чат не найден" }, { status: 404 });

  return Response.json(
    { conversation, messages: await listAgentConversationMessages(id) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await operatorUser();
  if (auth.response) return auth.response;

  const id = await conversationId(params);
  if (!id) return Response.json({ error: "Некорректный чат" }, { status: 400 });
  const current = await getAgentConversation(auth.user.id, id);
  if (!current) return Response.json({ error: "Чат не найден" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { title?: string; systemPrompt?: string } | null;
  if (!body || (body.title === undefined && body.systemPrompt === undefined)) {
    return Response.json({ error: "Нет изменений для сохранения" }, { status: 400 });
  }
  if (body.title !== undefined && !String(body.title).trim()) {
    return Response.json({ error: "Название чата не может быть пустым" }, { status: 400 });
  }
  if (body.systemPrompt !== undefined && typeof body.systemPrompt !== "string") {
    return Response.json({ error: "Системный промпт должен быть строкой" }, { status: 400 });
  }
  if (body.systemPrompt !== undefined && current.kind !== "plan") {
    return Response.json({ error: "Системный промпт настраивается только для чата-планировщика" }, { status: 400 });
  }
  if (body.systemPrompt !== undefined && body.systemPrompt.length > 12_000) {
    return Response.json({ error: "Системный промпт слишком длинный (максимум 12 000 символов)" }, { status: 400 });
  }

  const conversation = await updateAgentConversation(auth.user.id, id, {
    ...(body.title !== undefined ? { title: String(body.title).replace(/\s+/g, " ").trim() } : {}),
    ...(body.systemPrompt !== undefined ? { systemPrompt: body.systemPrompt } : {}),
  });
  if (!conversation) return Response.json({ error: "Чат не найден" }, { status: 404 });
  return Response.json({ conversation }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await operatorUser();
  if (auth.response) return auth.response;

  const id = await conversationId(params);
  if (!id) return Response.json({ error: "Некорректный чат" }, { status: 400 });
  const deleted = await deleteAgentConversation(auth.user.id, id);
  if (!deleted) return Response.json({ error: "Чат не найден" }, { status: 404 });
  return Response.json({ ok: true });
}
