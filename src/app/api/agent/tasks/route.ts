import { createAgentTask, listAgentTasks } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

/** Очередь заданий для бота-оператора рабочего стола. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_PROMPT = 2000;

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "super_admin") return Response.json({ error: "Только главный администратор" }, { status: 403 });

  const tasks = await listAgentTasks(me.id, 12);
  return Response.json({ tasks }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "super_admin") return Response.json({ error: "Только главный администратор" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { prompt?: string; maxSteps?: number } | null;
  const prompt = (body?.prompt ?? "").trim();
  if (!prompt) return Response.json({ error: "Опишите задание для агента" }, { status: 400 });
  if (prompt.length > MAX_PROMPT) return Response.json({ error: "Слишком длинное задание" }, { status: 400 });

  const maxSteps = Math.min(Math.max(Number(body?.maxSteps ?? 15) || 15, 1), 100);
  const task = await createAgentTask(me.id, prompt, maxSteps);
  return Response.json({ task });
}
