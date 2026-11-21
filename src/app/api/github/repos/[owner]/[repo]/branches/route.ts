import { NextResponse } from "next/server";
import { getGithubConnectionWithSecret } from "@/db/repo";
import { hasAgentAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import { GithubApiError, getGithubRepo, listGithubBranches } from "@/lib/github";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  context: { params: Promise<{ owner: string; repo: string }> },
) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me)) {
    return NextResponse.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  const conn = await getGithubConnectionWithSecret(me.id);
  if (!conn) {
    return NextResponse.json({ error: "GitHub-аккаунт не привязан" }, { status: 404 });
  }

  const { owner, repo } = await context.params;
  if (!owner || !repo) {
    return NextResponse.json({ error: "Укажите owner и repo" }, { status: 400 });
  }

  try {
    const [repoInfo, branches] = await Promise.all([
      getGithubRepo(conn.token, owner, repo),
      listGithubBranches(conn.token, owner, repo),
    ]);
    return NextResponse.json(
      { repo: repoInfo, branches },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof GithubApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: (err as Error).message || "Не удалось получить ветки репозитория" },
      { status: 500 },
    );
  }
}
