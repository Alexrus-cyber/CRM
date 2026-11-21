import { addAgentEvent, getAgentTask, syncOperatorTaskToConversation } from "@/db/repo";
import { botOwner } from "@/lib/agentBot";

/**
 * Настольный Оператор отправляет снимок экрана и данные ПК для Агента:
 * `POST /api/agent/bot/<id>/screen`
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_IMAGE_BASE64 = 2_600_000;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await botOwner(req);
  if (!ownerId) return Response.json({ error: "Неверный токен агента" }, { status: 401 });

  const { id } = await ctx.params;
  const task = await getAgentTask(ownerId, Number(id) || 0);
  if (!task) return Response.json({ error: "Задание не найдено" }, { status: 404 });
  if (task.status === "cancelled") {
    return Response.json({ ok: false, cancelled: true, error: "Задание отменено пользователем" }, { status: 409 });
  }

  const body = (await req.json().catch(() => null)) as
    | {
        image?: string;
        summary?: string;
        activeWindow?: string;
        width?: number;
        height?: number;
        screenWidth?: number;
        screenHeight?: number;
      }
    | null;

  const rawImage = String(body?.image ?? "").trim();
  let mime = "image/jpeg";
  let base64Data = "";
  if (rawImage.startsWith("data:image/")) {
    const match = rawImage.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/);
    if (match) {
      mime = match[1];
      base64Data = match[2];
    }
  } else if (/^[A-Za-z0-9+/=]+$/.test(rawImage)) {
    base64Data = rawImage;
  }

  if (base64Data.length > MAX_IMAGE_BASE64) {
    return Response.json({ error: "Снимок экрана слишком большой" }, { status: 400 });
  }

  const summary = String(body?.summary ?? "").trim().slice(0, 8000);
  const meta = {
    type: "inspect_screen",
    activeWindow: String(body?.activeWindow ?? "").slice(0, 300),
    width: Number(body?.width ?? 0) || undefined,
    height: Number(body?.height ?? 0) || undefined,
    screenWidth: Number(body?.screenWidth ?? 0) || undefined,
    screenHeight: Number(body?.screenHeight ?? 0) || undefined,
  };
  const byteSize = base64Data ? Math.floor((base64Data.length * 3) / 4) : 0;

  const eventId = await addAgentEvent({
    taskId: task.id,
    kind: "screen",
    text: summary || (meta.activeWindow ? `Активное окно: ${meta.activeWindow}` : "Снимок экрана ПК"),
    action: JSON.stringify(meta),
    fileName: base64Data ? (mime.includes("png") ? "screen.png" : "screen.jpg") : "",
    fileMime: base64Data ? mime : "",
    fileSize: byteSize,
    fileData: base64Data,
  });
  await syncOperatorTaskToConversation(ownerId, task.id, { onlyIfExisting: true });

  return Response.json({ ok: true, eventId }, { headers: { "Cache-Control": "no-store" } });
}
