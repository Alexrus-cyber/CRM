import {
  createChatRoom,
  listChatRoomsForUser,
  listGeneralBotIds,
} from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { publishLiveEvent } from "@/lib/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Список групповых и общих чатов пользователя + боты общего чата. */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const [rooms, generalBotIds] = await Promise.all([
    listChatRoomsForUser(me.id),
    listGeneralBotIds(),
  ]);
  return Response.json(
    { rooms, generalBotIds },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Создание группы или общего чата для нескольких человек (доступно всем сотрудникам). */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | {
        name?: string;
        description?: string;
        kind?: string;
        memberIds?: unknown;
        botIds?: unknown;
      }
    | null;

  const name = String(body?.name ?? "").replace(/\s+/g, " ").trim();
  if (!name) return Response.json({ error: "Укажите название чата" }, { status: 400 });

  const kind = body?.kind === "shared" ? "shared" : "group";
  const memberIds = Array.isArray(body?.memberIds)
    ? body!.memberIds.map((n) => Number(n)).filter((n) => Number.isSafeInteger(n) && n > 0)
    : [];
  const botIds = Array.isArray(body?.botIds)
    ? body!.botIds.map((n) => Number(n)).filter((n) => Number.isSafeInteger(n) && n > 0)
    : [];

  const room = await createChatRoom({
    creatorId: me.id,
    name,
    description: typeof body?.description === "string" ? body.description : "",
    kind,
    memberIds,
    botIds,
  });

  publishLiveEvent("chat", me.id);
  return Response.json({ room }, { headers: { "Cache-Control": "no-store" } });
}
