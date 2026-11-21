import { NextResponse } from "next/server";
import { getGithubConnectionWithSecret } from "@/db/repo";
import { hasAgentAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import { GithubApiError, listGithubRepos } from "@/lib/github";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me)) {
    return NextResponse.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  const conn = await getGithubConnectionWithSecret(me.id);
  if (!conn) {
    return NextResponse.json({ error: "Сначала привяжите свой GitHub-аккаунт" }, { status: 404 });
  }

  const url = new URL(req.url);
  const query = url.searchParams.get("q") || "";

  try {
    const repos = await listGithubRepos(conn.token, { query, perPage: 100 });
    return NextResponse.json({ repos }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof GithubApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: (err as Error).message || "Не удалось загрузить репозитории GitHub" },
      { status: 500 },
    );
  }
}
