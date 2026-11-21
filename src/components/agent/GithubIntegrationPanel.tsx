"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ExternalLink,
  GitBranch,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  Unlink,
} from "lucide-react";
import { Input } from "@/components/ui";
import { cn } from "@/lib/utils";

export function GithubIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.69-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.05 11.05 0 0 1 5.8 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.07.78 2.15 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

export type GithubAccountPublic = {
  id: number;
  userId: number;
  githubUserId: number;
  login: string;
  name: string;
  email: string;
  avatarUrl: string;
  tokenHint: string;
  scopes: string;
  selectedOwner: string;
  selectedRepo: string;
  selectedBranch: string;
  enabled: boolean;
};

export type GithubRepoItem = {
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
};

export type GithubBranchItem = {
  name: string;
  protected: boolean;
  sha: string;
};

type Props = {
  account: GithubAccountPublic | null;
  oauthAvailable: boolean;
  disabled?: boolean;
  onAccountChange: (account: GithubAccountPublic | null) => void;
  onNotify?: (msg: string) => void;
};

export function GithubIntegrationPanel({
  account,
  oauthAvailable,
  disabled,
  onAccountChange,
  onNotify,
}: Props) {
  const [tokenInput, setTokenInput] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [repos, setRepos] = useState<GithubRepoItem[]>([]);
  const [branches, setBranches] = useState<GithubBranchItem[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [repoFilter, setRepoFilter] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncInfo, setSyncInfo] = useState<{
    fileCount: number;
    sandboxSynced: boolean;
    branch: string;
  } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const loadRepos = useCallback(async () => {
    setLoadingRepos(true);
    setLocalError(null);
    try {
      const res = await fetch("/api/github/repos", { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as {
        repos?: GithubRepoItem[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Не удалось загрузить репозитории");
      setRepos(Array.isArray(data.repos) ? data.repos : []);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Ошибка загрузки репозиториев");
    } finally {
      setLoadingRepos(false);
    }
  }, []);

  useEffect(() => {
    if (!account) return;
    let active = true;
    fetch("/api/github/repos", { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { repos?: GithubRepoItem[]; error?: string };
        if (!active) return;
        if (!res.ok) setLocalError(data.error ?? "Не удалось загрузить репозитории");
        else setRepos(Array.isArray(data.repos) ? data.repos : []);
      })
      .catch(() => {
        if (active) setLocalError("Ошибка загрузки репозиториев");
      });
    return () => {
      active = false;
    };
  }, [account]);

  useEffect(() => {
    const owner = account?.selectedOwner || "";
    const repo = account?.selectedRepo || "";
    if (!owner || !repo) return;
    let active = true;
    fetch(`/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`, {
      cache: "no-store",
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { branches?: GithubBranchItem[] };
        if (active && res.ok && Array.isArray(data.branches)) {
          setBranches(data.branches);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [account?.selectedOwner, account?.selectedRepo]);

  const visibleRepos = useMemo(() => (account ? repos : []), [account, repos]);
  const visibleBranches = useMemo(
    () => (account?.selectedOwner && account?.selectedRepo ? branches : []),
    [account?.selectedOwner, account?.selectedRepo, branches],
  );

  const filteredRepos = useMemo(() => {
    const q = repoFilter.trim().toLowerCase();
    if (!q) return visibleRepos;
    return visibleRepos.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.language.toLowerCase().includes(q),
    );
  }, [visibleRepos, repoFilter]);

  const selectedRepoFullName =
    account?.selectedOwner && account?.selectedRepo
      ? `${account.selectedOwner}/${account.selectedRepo}`
      : "";

  const connectWithToken = async () => {
    const clean = tokenInput.trim();
    if (!clean || connecting) return;
    setConnecting(true);
    setLocalError(null);
    try {
      const res = await fetch("/api/github/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: clean }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        account?: GithubAccountPublic;
        repos?: GithubRepoItem[];
        error?: string;
      };
      if (!res.ok || !data.account) {
        throw new Error(data.error ?? "Не удалось привязать GitHub");
      }
      setTokenInput("");
      if (Array.isArray(data.repos)) setRepos(data.repos);
      onAccountChange(data.account);
      onNotify?.(`GitHub привязан: @${data.account.login}`);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Ошибка привязки GitHub");
    } finally {
      setConnecting(false);
    }
  };

  const disconnectGithub = async () => {
    if (connecting) return;
    setConnecting(true);
    setLocalError(null);
    try {
      const res = await fetch("/api/github/connection", { method: "DELETE" });
      if (!res.ok) throw new Error("Не удалось отвязать GitHub");
      setRepos([]);
      setBranches([]);
      setSyncInfo(null);
      onAccountChange(null);
      onNotify?.("GitHub-аккаунт отвязан.");
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Ошибка отвязки GitHub");
    } finally {
      setConnecting(false);
    }
  };

  const patchSelection = async (patch: {
    selectedOwner?: string;
    selectedRepo?: string;
    selectedBranch?: string;
    enabled?: boolean;
  }) => {
    setLocalError(null);
    try {
      const res = await fetch("/api/github/connection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await res.json().catch(() => ({}))) as {
        account?: GithubAccountPublic;
        error?: string;
      };
      if (!res.ok || !data.account) throw new Error(data.error ?? "Не удалось обновить выбор репозитория");
      onAccountChange(data.account);
      setSyncInfo(null);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Ошибка выбора репозитория");
    }
  };

  const handleRepoSelect = async (fullName: string) => {
    if (!fullName) {
      await patchSelection({ selectedOwner: "", selectedRepo: "", selectedBranch: "" });
      return;
    }
    const [owner, ...rest] = fullName.split("/");
    const repo = rest.join("/");
    const matched = repos.find((r) => r.fullName === fullName);
    await patchSelection({
      selectedOwner: owner,
      selectedRepo: repo,
      selectedBranch: matched?.defaultBranch || "main",
    });
  };

  const syncRepoNow = async () => {
    if (!account?.selectedOwner || !account?.selectedRepo || syncing) return;
    setSyncing(true);
    setLocalError(null);
    try {
      const res = await fetch("/api/github/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: account.selectedOwner,
          repo: account.selectedRepo,
          branch: account.selectedBranch || "main",
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        fileCount?: number;
        sandboxSynced?: boolean;
        branch?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Не удалось синхронизировать репозиторий");
      const info = {
        fileCount: data.fileCount ?? 0,
        sandboxSynced: Boolean(data.sandboxSynced),
        branch: data.branch ?? account.selectedBranch,
      };
      setSyncInfo(info);
      onNotify?.(
        `GitHub-RAG готов: ${account.selectedOwner}/${account.selectedRepo}@${info.branch} (${info.fileCount} файлов${info.sandboxSynced ? ", клон в Sandbox обновлён" : ""}).`,
      );
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Ошибка синхронизации");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-2.5 rounded-2xl border border-border bg-card p-3 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-card2 text-text">
            <GithubIcon size={14} />
          </span>
          <div>
            <p className="font-semibold text-text">Подключение GitHub (GitHub-RAG и разработка)</p>
            <p className="text-[10px] text-muted">
              Анализ кода репозитория, правка файлов и Commit / PR / Merge строго от имени привязавшего аккаунт
            </p>
          </div>
        </div>
        {account && (
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[10px] text-text">
              <input
                type="checkbox"
                checked={account.enabled}
                disabled={disabled}
                onChange={(e) => void patchSelection({ enabled: e.target.checked })}
                className="h-3.5 w-3.5 accent-[#7c5cff]"
              />
              Включить для Агента
            </label>
            <button
              type="button"
              onClick={() => void disconnectGithub()}
              disabled={connecting || disabled}
              className="flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] font-medium text-red-400 hover:bg-red-500/20 disabled:opacity-40"
            >
              <Unlink size={11} /> Отвязать
            </button>
          </div>
        )}
      </div>

      {!account ? (
        <div className="space-y-2 rounded-xl border border-border/70 bg-card2/50 p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <KeyRound size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <Input
                type="password"
                aria-label="GitHub Personal Access Token"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void connectWithToken();
                  }
                }}
                placeholder="Вставьте GitHub Personal Access Token (ghp_… или github_pat_…)"
                className="h-8 pl-7 text-[11px]"
              />
            </div>
            <button
              type="button"
              onClick={() => void connectWithToken()}
              disabled={!tokenInput.trim() || connecting || disabled}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {connecting ? <Loader2 size={12} className="animate-spin" /> : <GithubIcon size={12} />}
              Привязать GitHub
            </button>
            {oauthAvailable && (
              <a
                href="/api/github/oauth/start"
                className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[11px] font-medium text-text hover:border-accent/50"
              >
                <ExternalLink size={12} /> Войти через OAuth
              </a>
            )}
          </div>
          <p className="text-[10px] text-muted">
            Токен шифруется на сервере CRM (AES-256-GCM) и никогда не передаётся в браузер или другим пользователям.
            Рекомендуемые права PAT: <code>repo</code>, <code>read:user</code>, <code>user:email</code>.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-2">
            {account.avatarUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={account.avatarUrl}
                alt={account.login}
                className="h-6 w-6 rounded-full border border-border"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-semibold text-text">@{account.login}</span>
                {account.name && account.name !== account.login && (
                  <span className="text-[10px] text-muted">({account.name})</span>
                )}
                {account.email && <span className="text-[10px] text-muted">· {account.email}</span>}
              </div>
              <p className="text-[10px] text-muted">
                Токен: <span className="font-mono">{account.tokenHint || "****"}</span>
                {account.scopes ? ` · права: ${account.scopes}` : ""}
              </p>
            </div>
            <span className="rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
              <Check size={10} className="mr-1 inline" />
              Commit / PR / Merge от @{account.login}
            </span>
          </div>

          <div className="grid gap-2 sm:grid-cols-12">
            <div className="relative sm:col-span-4">
              <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <Input
                value={repoFilter}
                onChange={(e) => setRepoFilter(e.target.value)}
                placeholder="Фильтр репозиториев…"
                className="h-8 pl-7 text-[11px]"
              />
            </div>

            <div className="flex items-center gap-1.5 sm:col-span-5">
              <select
                aria-label="Выбор GitHub-репозитория"
                value={selectedRepoFullName}
                disabled={disabled || loadingRepos}
                onChange={(e) => void handleRepoSelect(e.target.value)}
                className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
              >
                <option value="">Выберите репозиторий…</option>
                {filteredRepos.map((r) => (
                  <option key={r.id} value={r.fullName}>
                    {r.fullName} {r.private ? "🔒" : "🌐"} {r.language ? `(${r.language})` : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void loadRepos()}
                disabled={loadingRepos}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card2 text-muted hover:text-text"
                title="Обновить список репозиториев"
              >
                {loadingRepos ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              </button>
            </div>

            <div className="flex items-center gap-1.5 sm:col-span-3">
              <GitBranch size={12} className="shrink-0 text-muted" />
              <select
                aria-label="Выбор ветки GitHub"
                value={account.selectedBranch || ""}
                disabled={disabled || !selectedRepoFullName}
                onChange={(e) => void patchSelection({ selectedBranch: e.target.value })}
                className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-card2 px-2 text-[11px] text-text outline-none focus:border-accent"
              >
                {!selectedRepoFullName && <option value="">Ветка…</option>}
                {selectedRepoFullName &&
                  account.selectedBranch &&
                  !visibleBranches.some((b) => b.name === account.selectedBranch) && (
                    <option value={account.selectedBranch}>{account.selectedBranch}</option>
                  )}
                {visibleBranches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                    {b.protected ? " (protected)" : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {selectedRepoFullName && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card2/40 px-2.5 py-2 text-[10px]">
              <div className="min-w-0 flex-1">
                <a
                  href={`https://github.com/${selectedRepoFullName}/tree/${encodeURIComponent(account.selectedBranch || "main")}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-accent2 hover:underline"
                >
                  {selectedRepoFullName}@{account.selectedBranch || "main"} <ExternalLink size={10} />
                </a>
                {syncInfo ? (
                  <span className="ml-2 text-emerald-400">
                    · RAG-индекс: {syncInfo.fileCount} файлов
                    {syncInfo.sandboxSynced ? " · локальный клон в Sandbox готов" : ""}
                  </span>
                ) : (
                  <span className="ml-2 text-muted">
                    · Агент автоматически читает структуру и файлы этого проекта как RAG
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void syncRepoNow()}
                disabled={syncing || disabled}
                className={cn(
                  "flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-[10px] font-medium text-text hover:border-accent/50 disabled:opacity-40",
                )}
              >
                {syncing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                Синхронизировать с Агентом
              </button>
            </div>
          )}
        </div>
      )}

      {localError && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-400">
          {localError}
        </p>
      )}
    </div>
  );
}
