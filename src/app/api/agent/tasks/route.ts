import { addAgentEvent, createAgentTask, listAgentTasks } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { AGENT_MAX_STEPS } from "@/lib/genParams";
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
  if (me.role !== "super_admin") return Response.json({ error: "Только главный администратор" }, { status: 403 });

  const tasks = await listAgentTasks(me.id, 12);
  return Response.json({ tasks }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "super_admin") return Response.json({ error: "Только главный администратор" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as
    | {
        prompt?: string;
        maxSteps?: number;
        trustLevel?: string;
        files?: Array<{ name?: string; mime?: string; size?: number; data?: string }>;
      }
    | null;

  const prompt = (body?.prompt ?? "").trim();
  if (!prompt) return Response.json({ error: "Опишите задание для агента" }, { status: 400 });
  if (prompt.length > MAX_PROMPT) return Response.json({ error: "Слишком длинное задание" }, { status: 400 });

  // Файлы задания: их прочитает бот (текст, docx/xlsx, csv…) — они приходят
  // вместе с заданием и лежат в его журнале как вложения.
  const incoming = Array.isArray(body?.files) ? body.files.slice(0, MAX_FILES) : [];
  const files: Array<{ name: string; mime: string; data: string; size: number }> = [];
  for (const item of incoming) {
    const data = String(item?.data ?? "");
    const name = String(item?.name ?? "файл").slice(0, 160);
    const mime = String(item?.mime ?? "application/octet-stream").slice(0, 120);
    if (!data) continue;
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) continue;
    files.push({ name, mime, data, size: bytes.length });
  }

  const maxSteps = Math.min(Math.max(Number(body?.maxSteps ?? 15) || 15, 1), AGENT_MAX_STEPS);
  const trustLevel = normalizeTrustLevel(body?.trustLevel);
  const task = await createAgentTask(me.id, prompt, maxSteps, trustLevel);

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

  return Response.json({ task });
}
