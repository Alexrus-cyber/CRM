import { getCurrentUser } from "@/lib/auth";
import { AGENT_URL } from "../route";

/**
 * Подтверждение или отклонение команды / переноса файлов из Sandbox для запущенного Python-агента.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "super_admin") {
    return Response.json({ error: "Агент доступен только главному администратору" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | {
        approvalId?: string;
        approved?: boolean;
        note?: string;
        destination?: string;
        taskId?: number;
        taskPrompt?: string;
        mode?: string;
        coachMode?: string;
        operatorTrustLevel?: string;
        screenshot?: string;
        screenSummary?: string;
      }
    | null;

  const approvalId = String(body?.approvalId ?? "").trim();
  if (!approvalId) {
    return Response.json({ error: "Не указан approvalId" }, { status: 400 });
  }

  const rawScreenshot = typeof body?.screenshot === "string" ? body.screenshot : "";
  const validScreenshot =
    rawScreenshot.startsWith("data:image/") && rawScreenshot.length <= 2_800_000 ? rawScreenshot : "";

  try {
    const upstream = await fetch(`${AGENT_URL}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approvalId,
        approved: Boolean(body?.approved),
        note: typeof body?.note === "string" ? body.note.slice(0, 500) : "",
        destination: typeof body?.destination === "string" ? body.destination.slice(0, 500) : "",
        ...(Number.isFinite(body?.taskId) ? { taskId: Number(body?.taskId) } : {}),
        ...(typeof body?.taskPrompt === "string" ? { taskPrompt: body.taskPrompt.slice(0, 4000) } : {}),
        ...(typeof body?.mode === "string" ? { mode: body.mode.slice(0, 40) } : {}),
        ...(typeof body?.coachMode === "string" ? { coachMode: body.coachMode.slice(0, 40) } : {}),
        ...(typeof body?.operatorTrustLevel === "string"
          ? { operatorTrustLevel: body.operatorTrustLevel.slice(0, 20) }
          : {}),
        ...(validScreenshot ? { screenshot: validScreenshot } : {}),
        ...(typeof body?.screenSummary === "string"
          ? { screenSummary: body.screenSummary.slice(0, 8000) }
          : {}),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    return Response.json(data, { status: upstream.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Агент недоступен" }, { status: 503 });
  }
}
