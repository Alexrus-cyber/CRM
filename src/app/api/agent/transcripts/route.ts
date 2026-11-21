import { createAgentTranscript, listAgentTranscripts } from "@/db/repo";
import { hasAgentAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import { buildTranscriptFileName } from "@/lib/transcripts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function adminUser() {
  const me = await getCurrentUser();
  if (!me) return { response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!hasAgentAccess(me)) {
    return { response: Response.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 }) };
  }
  return { user: me };
}

/** Список сохранённых переписок (файлов истории агента). */
export async function GET() {
  const auth = await adminUser();
  if (auth.response) return auth.response;

  const transcripts = await listAgentTranscripts(auth.user.id, 500);
  return Response.json({ transcripts }, { headers: { "Cache-Control": "no-store" } });
}

/** Сохранить полный текст переписки и Summary в файл истории. */
export async function POST(req: Request) {
  const auth = await adminUser();
  if (auth.response) return auth.response;

  const body = (await req.json().catch(() => null)) as
    | {
        conversationId?: number;
        title?: string;
        summary?: string;
        fileName?: string;
        content?: string;
      }
    | null;

  const content = String(body?.content ?? "");
  if (!content.trim()) {
    return Response.json({ error: "Пустое содержимое переписки" }, { status: 400 });
  }
  const title = String(body?.title ?? "Переписка агента").trim() || "Переписка агента";
  const fileName =
    String(body?.fileName ?? "")
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
      .trim() || buildTranscriptFileName(title);

  const transcript = await createAgentTranscript({
    userId: auth.user.id,
    conversationId: Number(body?.conversationId ?? 0) || 0,
    title,
    summary: String(body?.summary ?? ""),
    fileName,
    content,
  });

  return Response.json(
    {
      transcript: {
        id: transcript.id,
        conversationId: transcript.conversationId,
        title: transcript.title,
        summary: transcript.summary,
        fileName: transcript.fileName,
        chars: transcript.chars,
        createdAt: transcript.createdAt,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
