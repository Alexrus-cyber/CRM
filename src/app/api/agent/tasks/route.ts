import { addAgentEvent, createAgentTask, listAgentTasks, syncOperatorTaskToConversation } from "@/db/repo";
import { hasAgentAccess, hasOperatorAccess, isUnlimitedAiRole } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import { resolveStepsForRole } from "@/lib/genParams";
import { normalizeCoachMode, normalizeTaskMode, normalizeTaskSource } from "@/lib/operatorModes";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";
import { normalizeTrustLevel } from "@/lib/trust";

/** Очередь заданий для бота-оператора рабочего стола. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_PROMPT = 4000;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me) && !hasOperatorAccess(me)) {
    return Response.json({ error: "Доступ не выдан главным администратором" }, { status: 403 });
  }

  const tasks = await listAgentTasks(me.id, 200);
  return Response.json({ tasks }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const rl = checkApiRateLimit({
    scope: "agent_tasks_create",
    userId: me.id,
    ip: extractClientIp(req.headers),
    maxRequests: 30,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const body = (await req.json().catch(() => null)) as
    | {
        prompt?: string;
        maxSteps?: number;
        trustLevel?: string;
        taskMode?: string;
        mode?: string;
        coachMode?: string;
        source?: string;
        files?: Array<{ name?: string; mime?: string; size?: number; data?: string }>;
      }
    | null;

  const source = normalizeTaskSource(body?.source);
  const allowed = source === "agent" ? hasAgentAccess(me) : hasOperatorAccess(me);
  if (!allowed) {
    return Response.json({ error: "Доступ к Оператору не выдан главным администратором" }, { status: 403 });
  }

  const unlimitedPayload = isUnlimitedAiRole(me.role);
  const prompt = (body?.prompt ?? "").trim();
  if (!prompt) return Response.json({ error: "Опишите задание для агента" }, { status: 400 });
  if (!unlimitedPayload && prompt.length > MAX_PROMPT) {
    return Response.json({ error: "Слишком длинное задание" }, { status: 400 });
  }

  // Файлы задания: их прочитает бот (текст, docx/xlsx, csv…) — для главного админа без ограничений.
  const incoming = Array.isArray(body?.files)
    ? unlimitedPayload
      ? body.files
      : body.files.slice(0, MAX_FILES)
    : [];
  const files: Array<{ name: string; mime: string; data: string; size: number }> = [];
  for (const item of incoming) {
    const data = String(item?.data ?? "");
    const name = String(item?.name ?? "файл").slice(0, 240);
    const mime = String(item?.mime ?? "application/octet-stream").slice(0, 160);
    if (!data) continue;
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length) continue;
    if (!unlimitedPayload && bytes.length > MAX_FILE_BYTES) continue;
    files.push({ name, mime, data, size: bytes.length });
  }

  const maxSteps = resolveStepsForRole(me.role, body?.maxSteps, 0);
  const trustLevel = normalizeTrustLevel(body?.trustLevel);
  const taskMode = normalizeTaskMode(body?.taskMode ?? body?.mode);
  const coachMode = normalizeCoachMode(body?.coachMode);
  const task = await createAgentTask(me.id, prompt, maxSteps, trustLevel, {
    taskMode,
    coachMode,
    source,
  });

  for (const file of files) {
    await addAgentEvent({
      taskId: task.id,
      kind: "attachment",
      text: file.name,
      fileName: file.name,
      fileMime: file.mime,
      fileSize: file.size,
      fileData: file.data,
    });
  }

  const conversationId = await syncOperatorTaskToConversation(me.id, task.id);
  return Response.json({ task, conversationId });
}
