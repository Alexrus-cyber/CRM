import {
  createChatRoom,
  listChatRoomsForUser,
  listGeneralBotIds,
} from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { publishLiveEvent } from "@/lib/events";
import { chatRoomCreateSchema, readValidatedJson } from "@/lib/validation";

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

  const parsed = await readValidatedJson(req, chatRoomCreateSchema, "Укажите название чата");
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const name = body.name.replace(/\s+/g, " ").trim();
  const kind = body.kind === "shared" ? "shared" : "group";
  const memberIds = body.memberIds ?? [];
  const botIds = body.botIds ?? [];

  const room = await createChatRoom({
    creatorId: me.id,
    name,
    description: body.description ?? "",
    kind,
    memberIds,
    botIds,
  });

  publishLiveEvent("chat", me.id);
  return Response.json({ room }, { headers: { "Cache-Control": "no-store" } });
}
