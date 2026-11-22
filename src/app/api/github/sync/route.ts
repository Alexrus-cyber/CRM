import { NextResponse } from "next/server";
import { resolveSafeAgentUrl } from "@/lib/agentConfig";
import { getGithubConnectionWithSecret } from "@/db/repo";
import { hasAgentAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import { GithubApiError, buildGithubRagSnapshot } from "@/lib/github";
import { checkApiRateLimit, extractClientIp, rateLimitErrorResponse } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me)) {
    return NextResponse.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  const rl = checkApiRateLimit({
    scope: "github_sync",
    userId: me.id,
    ip: extractClientIp(req.headers),
    maxRequests: 20,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitErrorResponse(rl);

  const conn = await getGithubConnectionWithSecret(me.id);
  if (!conn) {
    return NextResponse.json({ error: "GitHub-аккаунт не привязан" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as {
    owner?: string;
    repo?: string;
    branch?: string;
    query?: string;
  } | null;

  const owner = String(body?.owner || conn.selectedOwner || "").trim();
  const repo = String(body?.repo || conn.selectedRepo || "").trim();
  const branch = String(body?.branch || conn.selectedBranch || "main").trim();

  if (!owner || !repo) {
    return NextResponse.json({ error: "Выберите репозиторий GitHub для синхронизации" }, { status: 400 });
  }

  try {
    const snapshot = await buildGithubRagSnapshot({
      token: conn.token,
      owner,
      repo,
      branch,
      query: body?.query || "",
    });

    // Если Python-сервер Агента запущен — также прогреваем/синхронизируем локальный клон в Sandbox
    let sandboxSynced = false;
    let sandboxPath = "";
    let sandboxError = "";
    try {
      const agentUrl = resolveSafeAgentUrl();
      const agentRes = await fetch(`${agentUrl}/github/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: me.id,
          login: conn.login,
          name: conn.name,
          email: conn.email,
          token: conn.token,
          owner,
          repo,
          branch,
        }),
        signal: AbortSignal.timeout(25_000),
      });
      if (agentRes.ok) {
        const data = (await agentRes.json().catch(() => ({}))) as {
          ok?: boolean;
          workspaceDir?: string;
          error?: string;
        };
        sandboxSynced = Boolean(data.ok);
        sandboxPath = String(data.workspaceDir || "");
        if (!data.ok && data.error) sandboxError = data.error;
      }
    } catch {
      /* Агент может быть ещё не запущен — API-снимок уже готов */
    }

    return NextResponse.json({
      ok: true,
      owner,
      repo,
      branch,
      fileCount: snapshot.fileCount,
      previewLines: snapshot.contextText.split("\n").slice(0, 40),
      sandboxSynced,
      sandboxPath,
      sandboxError,
    });
  } catch (err) {
    if (err instanceof GithubApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: (err as Error).message || "Не удалось синхронизировать репозиторий" },
      { status: 500 },
    );
  }
}
