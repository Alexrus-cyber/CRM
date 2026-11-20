import { deleteAgentTranscript, getAgentTranscript } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function adminUser() {
  const me = await getCurrentUser();
  if (!me) return { response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  if (me.role !== "super_admin") {
    return { response: Response.json({ error: "Доступно только главному администратору" }, { status: 403 }) };
  }
  return { user: me };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await adminUser();
  if (auth.response) return auth.response;

  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return Response.json({ error: "Некорректный ID" }, { status: 400 });
  }
  const transcript = await getAgentTranscript(auth.user.id, id);
  if (!transcript) return Response.json({ error: "Файл переписки не найден" }, { status: 404 });

  const format = new URL(req.url).searchParams.get("format");
  if (format === "json") {
    return Response.json({ transcript }, { headers: { "Cache-Control": "no-store" } });
  }

  const asciiName = transcript.fileName.replace(/[^\x20-\x7e]/g, "_");
  return new Response(transcript.content, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(transcript.fileName)}`,
      "Cache-Control": "no-store",
    },
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await adminUser();
  if (auth.response) return auth.response;

  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return Response.json({ error: "Некорректный ID" }, { status: 400 });
  }
  const ok = await deleteAgentTranscript(auth.user.id, id);
  if (!ok) return Response.json({ error: "Файл переписки не найден" }, { status: 404 });
  return Response.json({ ok: true });
}
