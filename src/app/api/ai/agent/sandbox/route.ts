import { fetchAgent, resolveSafeAgentUrl } from "@/lib/agentConfig";
import { hasAgentAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";

/**
 * Управление изолированной песочницей `agent/sandbox`:
 *  - GET: список файлов, проектов и запущенных процессов; `?download=<path>` — скачать файл или zip проекта
 *  - POST: перенос файлов из Sandbox по согласию пользователя, остановка процесса, удаление, запись стенограммы
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function adminCheck() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me)) {
    return Response.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }
  return null;
}

export async function GET(req: Request) {
  const denied = await adminCheck();
  if (denied) return denied;

  let agentUrl: string;
  try {
    agentUrl = resolveSafeAgentUrl();
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  const download = new URL(req.url).searchParams.get("download");
  if (download) {
    try {
      const { response: upstream } = await fetchAgent(
        agentUrl,
        `/sandbox/download?path=${encodeURIComponent(download)}`,
        { cache: "no-store" },
        { timeoutMs: 30_000, reqSignal: req.signal },
      );
      if (!upstream.ok) {
        const err = (await upstream.json().catch(() => ({}))) as { error?: string };
        return Response.json({ error: err.error ?? "Не удалось скачать из Sandbox" }, { status: upstream.status });
      }
      const headers = new Headers();
      headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/octet-stream");
      const disposition = upstream.headers.get("Content-Disposition");
      if (disposition) headers.set("Content-Disposition", disposition);
      headers.set("Cache-Control", "no-store");
      return new Response(upstream.body, { status: 200, headers });
    } catch {
      return Response.json({ error: "Агент не запущен" }, { status: 503 });
    }
  }

  try {
    const { response: upstream } = await fetchAgent(
      agentUrl,
      "/sandbox",
      { cache: "no-store" },
      { timeoutMs: 12_000, reqSignal: req.signal },
    );
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    return Response.json(data, { status: upstream.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ available: false, files: [], projects: [], processes: [] }, { status: 200 });
  }
}

export async function POST(req: Request) {
  const denied = await adminCheck();
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as
    | {
        action?: string;
        source?: string;
        destination?: string;
        mode?: string;
        pid?: number;
        path?: string;
        fileName?: string;
        content?: string;
      }
    | null;

  const action = String(body?.action ?? "");
  let path = "";
  let payload: Record<string, unknown> = {};

  if (action === "export") {
    path = "/sandbox/export";
    payload = {
      source: String(body?.source ?? ""),
      destination: String(body?.destination ?? ""),
      mode: body?.mode === "move" ? "move" : "copy",
      confirmed: true,
    };
  } else if (action === "stop_process") {
    path = "/sandbox/stop";
    payload = { pid: Number(body?.pid ?? 0) };
  } else if (action === "delete") {
    path = "/sandbox/delete";
    payload = { path: String(body?.path ?? "") };
  } else if (action === "write_transcript") {
    path = "/sandbox/transcript";
    payload = {
      fileName: String(body?.fileName ?? "transcript.md"),
      content: String(body?.content ?? ""),
    };
  } else {
    return Response.json({ error: "Неизвестное действие Sandbox" }, { status: 400 });
  }

  let agentUrl: string;
  try {
    agentUrl = resolveSafeAgentUrl();
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  try {
    const { response: upstream } = await fetchAgent(
      agentUrl,
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
      },
      { timeoutMs: 30_000, reqSignal: req.signal },
    );
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    return Response.json(data, { status: upstream.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Агент не запущен" }, { status: 503 });
  }
}
