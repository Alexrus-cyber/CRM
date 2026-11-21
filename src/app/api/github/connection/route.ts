import { NextResponse } from "next/server";
import {
  deleteGithubConnection,
  getGithubConnectionPublic,
  getGithubConnectionWithSecret,
  updateGithubRepoSelection,
  upsertGithubConnection,
} from "@/db/repo";
import { hasAgentAccess } from "@/lib/aiPolicy";
import { getCurrentUser } from "@/lib/auth";
import {
  GithubApiError,
  fetchGithubUser,
  getGithubRepo,
  listGithubRepos,
} from "@/lib/github";

export const dynamic = "force-dynamic";

function oauthConfigured(): boolean {
  return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me)) {
    return NextResponse.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  const account = await getGithubConnectionPublic(me.id);
  return NextResponse.json(
    {
      connected: Boolean(account),
      account,
      oauthAvailable: oauthConfigured(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me)) {
    return NextResponse.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as {
    token?: string;
    selectedOwner?: string;
    selectedRepo?: string;
    selectedBranch?: string;
  } | null;

  const token = String(body?.token || "").trim();
  if (!token) {
    return NextResponse.json(
      { error: "Укажите персональный токен GitHub (Personal Access Token)" },
      { status: 400 },
    );
  }

  try {
    const profile = await fetchGithubUser(token);
    const repos = await listGithubRepos(token, { perPage: 60 }).catch(() => []);
    let selectedOwner = String(body?.selectedOwner || "").trim();
    let selectedRepo = String(body?.selectedRepo || "").trim();
    let selectedBranch = String(body?.selectedBranch || "").trim();

    if (selectedOwner && selectedRepo && !selectedBranch) {
      const info = await getGithubRepo(token, selectedOwner, selectedRepo).catch(() => null);
      if (info) selectedBranch = info.defaultBranch;
    }

    const account = await upsertGithubConnection({
      userId: me.id,
      githubUserId: profile.githubUserId,
      login: profile.login,
      name: profile.name,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
      token,
      scopes: profile.scopes,
      selectedOwner: selectedOwner || undefined,
      selectedRepo: selectedRepo || undefined,
      selectedBranch: selectedBranch || undefined,
      enabled: true,
    });

    return NextResponse.json({
      connected: true,
      account,
      repos,
      oauthAvailable: oauthConfigured(),
    });
  } catch (err) {
    if (err instanceof GithubApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: (err as Error).message || "Не удалось подключить GitHub-аккаунт" },
      { status: 500 },
    );
  }
}

export async function PATCH(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me)) {
    return NextResponse.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  const conn = await getGithubConnectionWithSecret(me.id);
  if (!conn) {
    return NextResponse.json({ error: "GitHub-аккаунт не привязан" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as {
    selectedOwner?: string;
    selectedRepo?: string;
    selectedBranch?: string;
    enabled?: boolean;
  } | null;

  if (!body) {
    return NextResponse.json({ error: "Некорректный JSON" }, { status: 400 });
  }

  let selectedOwner = body.selectedOwner !== undefined ? String(body.selectedOwner).trim() : undefined;
  let selectedRepo = body.selectedRepo !== undefined ? String(body.selectedRepo).trim() : undefined;
  let selectedBranch = body.selectedBranch !== undefined ? String(body.selectedBranch).trim() : undefined;

  // При выборе репозитория без явной ветки подставляем ветку по умолчанию
  if (selectedOwner && selectedRepo && selectedBranch === undefined) {
    try {
      const info = await getGithubRepo(conn.token, selectedOwner, selectedRepo);
      selectedBranch = info.defaultBranch;
    } catch (err) {
      if (err instanceof GithubApiError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
    }
  }

  const updated = await updateGithubRepoSelection(me.id, {
    selectedOwner,
    selectedRepo,
    selectedBranch,
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : undefined,
  });

  return NextResponse.json({
    connected: Boolean(updated),
    account: updated,
    oauthAvailable: oauthConfigured(),
  });
}

export async function DELETE() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasAgentAccess(me)) {
    return NextResponse.json({ error: "Доступ к Агенту не выдан главным администратором" }, { status: 403 });
  }

  await deleteGithubConnection(me.id);
  return NextResponse.json({
    connected: false,
    account: null,
    oauthAvailable: oauthConfigured(),
  });
}
