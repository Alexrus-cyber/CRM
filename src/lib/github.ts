import { decryptSecret, encryptSecret, maskSecret } from "./crypto";

const GITHUB_API = "https://api.github.com";

export function encryptGithubToken(rawToken: string): string {
  return encryptSecret(rawToken);
}

export function decryptGithubToken(stored: string): string {
  return decryptSecret(stored);
}

export function maskGithubToken(token: string): string {
  return maskSecret(token);
}

export class GithubApiError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export interface GithubAccountInfo {
  githubUserId: number;
  login: string;
  name: string;
  email: string;
  avatarUrl: string;
  scopes: string;
}

export interface GithubRepoItem {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string;
  language: string;
  htmlUrl: string;
  updatedAt: string;
  permissions?: {
    admin?: boolean;
    push?: boolean;
    pull?: boolean;
  };
}

export interface GithubBranchItem {
  name: string;
  protected: boolean;
  sha: string;
}

async function ghFetch(
  path: string,
  token: string,
  options?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<{ status: number; headers: Headers; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 12_000);
  try {
    const url = path.startsWith("http") ? path : `${GITHUB_API}${path}`;
    const res = await fetch(url, {
      method: options?.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "CRM-Agent-GitHub",
        ...(options?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text };
    }
    return { status: res.status, headers: res.headers, data };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchGithubUser(token: string): Promise<GithubAccountInfo> {
  const clean = token.trim();
  if (!clean) throw new GithubApiError("Укажите GitHub-токен (Personal Access Token)", 400);

  const { status, headers, data } = await ghFetch("/user", clean);
  if (status === 401) {
    throw new GithubApiError("GitHub отклонил токен (401). Проверьте корректность и срок действия токена.", 401);
  }
  if (status === 403) {
    throw new GithubApiError("Доступ к GitHub ограничен (403). Проверьте права токена или лимит запросов.", 403);
  }
  if (status >= 400 || !data || typeof data !== "object") {
    const msg = (data as { message?: string } | null)?.message || `HTTP ${status}`;
    throw new GithubApiError(`Ошибка GitHub API: ${msg}`, status >= 400 ? status : 502);
  }

  const obj = data as Record<string, unknown>;
  const githubUserId = Number(obj.id || 0);
  const login = String(obj.login || "").trim();
  if (!login) throw new GithubApiError("GitHub не вернул логин пользователя", 502);

  const name = String(obj.name || login).trim();
  let email = String(obj.email || "").trim();
  const avatarUrl = String(obj.avatar_url || "").trim();
  const scopes = String(headers.get("x-oauth-scopes") || "").trim();

  if (!email) {
    try {
      const emailsRes = await ghFetch("/user/emails", clean, { timeoutMs: 6000 });
      if (emailsRes.status === 200 && Array.isArray(emailsRes.data)) {
        const list = emailsRes.data as Array<{ email?: string; primary?: boolean; verified?: boolean }>;
        const primary =
          list.find((e) => e.primary && e.verified && e.email) ||
          list.find((e) => e.verified && e.email) ||
          list.find((e) => e.email);
        if (primary?.email) email = primary.email.trim();
      }
    } catch {
      /* Права user:email могут отсутствовать — используем noreply */
    }
  }
  if (!email) {
    email = githubUserId > 0
      ? `${githubUserId}+${login}@users.noreply.github.com`
      : `${login}@users.noreply.github.com`;
  }

  return { githubUserId, login, name, email, avatarUrl, scopes };
}

export async function listGithubRepos(
  token: string,
  options?: { query?: string; perPage?: number },
): Promise<GithubRepoItem[]> {
  const perPage = Math.min(100, Math.max(10, options?.perPage ?? 80));
  const { status, data } = await ghFetch(
    `/user/repos?sort=updated&per_page=${perPage}&affiliation=owner,collaborator,organization_member`,
    token,
  );
  if (status === 401) {
    throw new GithubApiError("Срок действия GitHub-токена истёк или он отозван", 401);
  }
  if (status >= 400 || !Array.isArray(data)) {
    const msg = (data as { message?: string } | null)?.message || `HTTP ${status}`;
    throw new GithubApiError(`Не удалось получить список репозиториев: ${msg}`, status >= 400 ? status : 502);
  }

  const query = (options?.query || "").trim().toLowerCase();
  const repos: GithubRepoItem[] = data.map((raw) => {
    const r = raw as Record<string, unknown>;
    const ownerObj = (r.owner as Record<string, unknown> | undefined) ?? {};
    const owner = String(ownerObj.login || "");
    const name = String(r.name || "");
    const fullName = String(r.full_name || `${owner}/${name}`);
    const perms = (r.permissions as Record<string, unknown> | undefined) ?? undefined;
    return {
      id: Number(r.id || 0),
      owner,
      name,
      fullName,
      private: Boolean(r.private),
      defaultBranch: String(r.default_branch || "main"),
      description: String(r.description || ""),
      language: String(r.language || ""),
      htmlUrl: String(r.html_url || `https://github.com/${fullName}`),
      updatedAt: String(r.updated_at || ""),
      permissions: perms
        ? {
            admin: Boolean(perms.admin),
            push: Boolean(perms.push),
            pull: Boolean(perms.pull),
          }
        : undefined,
    };
  });

  if (!query) return repos;
  return repos.filter(
    (r) =>
      r.fullName.toLowerCase().includes(query) ||
      r.description.toLowerCase().includes(query) ||
      r.language.toLowerCase().includes(query),
  );
}

export async function getGithubRepo(token: string, owner: string, repo: string): Promise<GithubRepoItem> {
  const { status, data } = await ghFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    token,
  );
  if (status === 404) {
    throw new GithubApiError(`Репозиторий ${owner}/${repo} не найден или недоступен`, 404);
  }
  if (status >= 400 || !data || typeof data !== "object") {
    const msg = (data as { message?: string } | null)?.message || `HTTP ${status}`;
    throw new GithubApiError(`Ошибка чтения репозитория: ${msg}`, status >= 400 ? status : 502);
  }
  const r = data as Record<string, unknown>;
  const ownerObj = (r.owner as Record<string, unknown> | undefined) ?? {};
  const perms = (r.permissions as Record<string, unknown> | undefined) ?? undefined;
  return {
    id: Number(r.id || 0),
    owner: String(ownerObj.login || owner),
    name: String(r.name || repo),
    fullName: String(r.full_name || `${owner}/${repo}`),
    private: Boolean(r.private),
    defaultBranch: String(r.default_branch || "main"),
    description: String(r.description || ""),
    language: String(r.language || ""),
    htmlUrl: String(r.html_url || `https://github.com/${owner}/${repo}`),
    updatedAt: String(r.updated_at || ""),
    permissions: perms
      ? {
          admin: Boolean(perms.admin),
          push: Boolean(perms.push),
          pull: Boolean(perms.pull),
        }
      : undefined,
  };
}

export async function listGithubBranches(
  token: string,
  owner: string,
  repo: string,
): Promise<GithubBranchItem[]> {
  const { status, data } = await ghFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
    token,
  );
  if (status >= 400 || !Array.isArray(data)) {
    const msg = (data as { message?: string } | null)?.message || `HTTP ${status}`;
    throw new GithubApiError(`Не удалось получить ветки: ${msg}`, status >= 400 ? status : 502);
  }
  return data.map((raw) => {
    const b = raw as Record<string, unknown>;
    const commit = (b.commit as Record<string, unknown> | undefined) ?? {};
    return {
      name: String(b.name || ""),
      protected: Boolean(b.protected),
      sha: String(commit.sha || ""),
    };
  });
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  "coverage",
]);

const SKIP_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".mp3",
  ".lock",
  ".sqlite",
  ".db",
]);

function isUsefulRagFile(filePath: string): boolean {
  const parts = filePath.split("/");
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  const lower = filePath.toLowerCase();
  if (lower.endsWith("package-lock.json") || lower.endsWith("yarn.lock") || lower.endsWith("pnpm-lock.yaml")) {
    return false;
  }
  const dot = lower.lastIndexOf(".");
  if (dot >= 0 && SKIP_EXTS.has(lower.slice(dot))) return false;
  return true;
}

export async function fetchGithubTree(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ files: string[]; truncated: boolean; totalBlobs: number }> {
  const ref = encodeURIComponent(branch || "HEAD");
  const { status, data } = await ghFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${ref}?recursive=1`,
    token,
    { timeoutMs: 12_000 },
  );
  if (status >= 400 || !data || typeof data !== "object") {
    const msg = (data as { message?: string } | null)?.message || `HTTP ${status}`;
    throw new GithubApiError(`Не удалось загрузить дерево файлов (${owner}/${repo}@${branch}): ${msg}`, status >= 400 ? status : 502);
  }
  const obj = data as { tree?: Array<{ path?: string; type?: string; size?: number }>; truncated?: boolean };
  const blobs = (obj.tree || []).filter((item) => item.type === "blob" && item.path);
  const files = blobs.map((b) => String(b.path)).filter(isUsefulRagFile);
  return {
    files,
    truncated: Boolean(obj.truncated),
    totalBlobs: blobs.length,
  };
}

export async function fetchGithubFileText(
  token: string,
  owner: string,
  repo: string,
  filePath: string,
  branch?: string,
  maxChars = 6000,
): Promise<string | null> {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const refQuery = branch ? `?ref=${encodeURIComponent(branch)}` : "";
  const { status, data } = await ghFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}${refQuery}`,
    token,
    { timeoutMs: 8000 },
  );
  if (status >= 400 || !data || typeof data !== "object") return null;
  const obj = data as { content?: string; encoding?: string; size?: number };
  if (obj.encoding !== "base64" || !obj.content) return null;
  const raw = Buffer.from(obj.content.replace(/\n/g, ""), "base64").toString("utf8");
  return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n... [обрезано, всего ${raw.length} симв.]` : raw;
}

/**
 * Быстрый GitHub-RAG снимок для системного контекста Агента:
 * структура проекта + README/манифест + релевантные файлы по запросу.
 */
export async function buildGithubRagSnapshot(params: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  query?: string;
}): Promise<{
  contextText: string;
  fileCount: number;
  matchedFiles: string[];
}> {
  const { token, owner, repo, branch, query } = params;
  const tree = await fetchGithubTree(token, owner, repo, branch);

  const priorityNames = [
    "README.md",
    "readme.md",
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
  ];
  const manifestPaths = priorityNames.filter((name) => tree.files.includes(name)).slice(0, 3);

  const tokens = (query || "")
    .toLowerCase()
    .split(/[^a-zа-яё0-9_.-]+/i)
    .filter((w) => w.length >= 3);

  const scored = tree.files
    .map((filePath) => {
      const lower = filePath.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (lower.includes(t)) score += 3;
      }
      return { filePath, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => x.filePath);

  const filesToPeek = Array.from(new Set([...manifestPaths, ...scored])).slice(0, 5);
  const snippets = await Promise.all(
    filesToPeek.map(async (fp) => ({
      path: fp,
      text: await fetchGithubFileText(token, owner, repo, fp, branch, 2500),
    })),
  );

  const treeSample = tree.files.slice(0, 140);
  const lines: string[] = [
    `Репозиторий: ${owner}/${repo} (ветка: ${branch})`,
    `Индексировано файлов кода/конфигов: ${tree.files.length} (всего объектов: ${tree.totalBlobs})`,
    "",
    "Карта файлов проекта (верхние пути):",
    ...treeSample.map((f) => `- ${f}`),
  ];
  if (tree.files.length > treeSample.length) {
    lines.push(`... и ещё ${tree.files.length - treeSample.length} файлов (используй github_list_files / github_search_code)`);
  }

  for (const s of snippets) {
    if (!s.text) continue;
    lines.push("", `=== ${s.path} ===`, s.text);
  }

  return {
    contextText: lines.join("\n"),
    fileCount: tree.files.length,
    matchedFiles: scored,
  };
}
