#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GitHub-интеграция и GitHub-RAG инструменты для ИИ-агента CRM.

Особенности безопасности:
  * Токен GitHub передаётся только server-to-server в памяти запроса
    и никогда не сохраняется в `.git/config`, логах или ошибках.
  * Для каждого пользователя CRM и репозитория выделяется изолированная
    папка внутри Sandbox: `<SANDBOX_ROOT>/_github/u<userId>/<owner>__<repo>`.
  * Операции записи на GitHub (`github_commit`, `github_create_pr`,
    `github_merge_pr`) ВСЕГДА требуют явного подтверждения на сайте от того
    же пользователя CRM, который привязал свой GitHub-аккаунт.
"""

from __future__ import annotations

import base64
import fnmatch
import hashlib
import json
import os
import platform
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

GITHUB_API = "https://api.github.com"

SKIP_DIRS = {
    ".git",
    "node_modules",
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
}

SKIP_EXTS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
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
    ".sqlite",
    ".db",
}


class GithubToolError(RuntimeError):
    pass


def redact_secret(text: str, token: str = "") -> str:
    value = str(text or "")
    if token:
        value = value.replace(token, "***")
        b64 = base64.b64encode(f"x-access-token:{token}".encode("utf-8")).decode("ascii")
        value = value.replace(b64, "***")
    return re.sub(r"(gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})", "***", value)


def _validate_gh_identifier(raw: str, label: str) -> str:
    clean = str(raw or "").strip()
    if not clean or clean in (".", "..") or clean.startswith("-") or not re.fullmatch(r"[A-Za-z0-9._-]+", clean):
        raise GithubToolError(f"Некорректное имя {label}: {clean[:60]}")
    return clean


def _validate_gh_branch(raw: str) -> str:
    clean = str(raw or "").strip()
    if not clean or clean.startswith("-") or ".." in clean or re.search(r"[\s\x00-\x1f~^:?*\\\[\]]", clean):
        raise GithubToolError(f"Некорректное имя ветки: {clean[:60]}")
    return clean


def _validate_gh_rev(raw: str) -> str:
    clean = str(raw or "").strip()
    if not clean or clean.startswith("-") or ".." in clean or not re.fullmatch(r"[A-Za-z0-9._/@~^{}-]{1,120}", clean):
        raise GithubToolError(f"Некорректная git-ссылка: {clean[:60]}")
    return clean


def _slug(raw: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(raw or "").strip()).strip("._")
    return cleaned or "repo"


def get_repo_workspace_dir(sandbox_root: Path, user_id: Any, owner: str, repo: str) -> Path:
    uid = int(user_id or 0)
    folder = f"{_slug(owner)}__{_slug(repo)}"
    root = sandbox_root.resolve()
    target = (root / "_github" / f"u{uid}" / folder).resolve()
    try:
        target.relative_to(root)
    except ValueError as err:
        raise GithubToolError("Недопустимый путь рабочего каталога GitHub") from err
    return target


def _safe_repo_file(repo_dir: Path, rel_path: str) -> Path:
    clean = str(rel_path or "").strip().replace("\\", "/").lstrip("/")
    if not clean or clean in (".", ".."):
        raise GithubToolError("Укажите корректный относительный путь файла в репозитории")
    parts = [p for p in clean.split("/") if p]
    if any(p in ("..", ".git") for p in parts):
        raise GithubToolError("Доступ к служебному каталогу .git или выход за пределы репозитория запрещён")
    root = repo_dir.resolve()
    cur = root
    for part in parts:
        cur = cur / part
        if cur.is_symlink():
            try:
                cur.resolve(strict=False).relative_to(root)
            except ValueError as err:
                raise GithubToolError("Запрещена символьная ссылка за пределы репозитория") from err
    target = cur.resolve(strict=False)
    try:
        target.relative_to(root)
    except ValueError as err:
        raise GithubToolError("Путь выходит за пределы каталога репозитория") from err
    return target


def _gh_api(
    path: str,
    token: str,
    *,
    method: str = "GET",
    body: Optional[Dict[str, Any]] = None,
    timeout: int = 20,
) -> Any:
    url = path if path.startswith("http") else f"{GITHUB_API}{path if path.startswith('/') else '/' + path}"
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or (parsed.hostname or "").lower() != "api.github.com":
        raise GithubToolError("Разрешены только HTTPS-запросы к api.github.com")
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "CRM-Agent-GitHub")
    if data is not None:
        req.add_header("Content-Type", "application/json; charset=utf-8")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", "replace")[:400]
        msg = raw
        try:
            parsed = json.loads(raw)
            msg = str(parsed.get("message") or raw)
        except Exception:
            pass
        raise GithubToolError(redact_secret(f"GitHub API HTTP {err.code}: {msg}", token)) from err
    except urllib.error.URLError as err:
        raise GithubToolError(redact_secret(f"Ошибка сети GitHub API: {err.reason}", token)) from err


def _run_git(
    args: List[str],
    *,
    cwd: Path,
    token: str = "",
    author_name: str = "",
    author_email: str = "",
    use_auth: bool = False,
    timeout: int = 45,
) -> Tuple[int, str, str]:
    cmd: List[str] = ["git", "-c", "protocol.ext.allow=never", "-c", "core.fsmonitor=false", "-c", "credential.helper="]
    if use_auth and token:
        basic = base64.b64encode(f"x-access-token:{token}".encode("utf-8")).decode("ascii")
        cmd.extend(["-c", f"http.https://github.com/.extraheader=AUTHORIZATION: basic {basic}"])
    cmd.extend(args)

    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": str(cwd),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "GIT_TERMINAL_PROMPT": "0",
        "GCM_INTERACTIVE": "never",
    }
    if author_name:
        env["GIT_AUTHOR_NAME"] = author_name
        env["GIT_COMMITTER_NAME"] = author_name
    if author_email:
        env["GIT_AUTHOR_EMAIL"] = author_email
        env["GIT_COMMITTER_EMAIL"] = author_email

    git_kwargs: Dict[str, Any] = {
        "cwd": str(cwd),
        "env": env,
        "stdin": subprocess.DEVNULL,
        "capture_output": True,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "timeout": timeout,
        "check": False,
    }
    if platform.system() == "Windows":
        git_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)

    try:
        proc = subprocess.run(cmd, **git_kwargs)
    except FileNotFoundError as err:
        raise GithubToolError("Команда git не установлена в системе") from err
    except subprocess.TimeoutExpired as err:
        raise GithubToolError(f"Таймаут git ({timeout} с)") from err

    return (
        proc.returncode,
        redact_secret(proc.stdout or "", token),
        redact_secret(proc.stderr or "", token),
    )


def _current_branch(repo_dir: Path, fallback: str = "main") -> str:
    if not (repo_dir / ".git").exists():
        return fallback
    code, out, _ = _run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=repo_dir, timeout=10)
    if code == 0 and out.strip() and out.strip() != "HEAD":
        return out.strip()
    return fallback


def ensure_repo_synced(
    github_ctx: Dict[str, Any],
    *,
    sandbox_root: Path,
    branch_override: str = "",
) -> Dict[str, Any]:
    token = str(github_ctx.get("token") or "").strip()
    owner = _validate_gh_identifier(str(github_ctx.get("owner") or ""), "владельца")
    repo = _validate_gh_identifier(str(github_ctx.get("repo") or ""), "репозитория")
    branch = _validate_gh_branch(str(branch_override or github_ctx.get("branch") or "").strip() or "main")
    user_id = int(github_ctx.get("userId") or 0)
    login = str(github_ctx.get("login") or "").strip()
    name = str(github_ctx.get("name") or login).strip()
    email = str(github_ctx.get("email") or (f"{login}@users.noreply.github.com" if login else "")).strip()

    if not token or not login:
        raise GithubToolError("GitHub-аккаунт не привязан текущим пользователем")
    if not owner or not repo:
        raise GithubToolError("Не выбран репозиторий GitHub в настройках Агента")

    repo_dir = get_repo_workspace_dir(sandbox_root, user_id, owner, repo)
    repo_dir.parent.mkdir(parents=True, exist_ok=True)
    remote_url = f"https://github.com/{owner}/{repo}.git"

    if not (repo_dir / ".git").exists():
        code, _out, err = _run_git(
            ["clone", "--branch", branch, "--single-branch", "--depth", "50", remote_url, str(repo_dir)],
            cwd=repo_dir.parent,
            token=token,
            use_auth=True,
            timeout=60,
        )
        if code != 0:
            # Возможно, запрошена ветка без указания или пустой репо — пробуем обычный clone
            code2, _out2, err2 = _run_git(
                ["clone", "--depth", "50", remote_url, str(repo_dir)],
                cwd=repo_dir.parent,
                token=token,
                use_auth=True,
                timeout=60,
            )
            if code2 != 0:
                raise GithubToolError(f"Не удалось клонировать {owner}/{repo}: {err2 or err}")
            if branch:
                _run_git(["checkout", branch], cwd=repo_dir, timeout=15)
    else:
        # Гарантируем чистый origin URL без токена внутри .git/config
        _run_git(["remote", "set-url", "origin", remote_url], cwd=repo_dir, timeout=10)
        code_st, st_out, _ = _run_git(["status", "--porcelain"], cwd=repo_dir, timeout=10)
        has_local_dirty = code_st == 0 and bool(st_out.strip())
        if not has_local_dirty:
            _run_git(
                ["fetch", "origin", branch],
                cwd=repo_dir,
                token=token,
                use_auth=True,
                timeout=30,
            )
            cur = _current_branch(repo_dir, branch)
            if cur == branch:
                _run_git(["merge", "--ff-only", f"origin/{branch}"], cwd=repo_dir, timeout=15)

    # Записываем только локальные author/committer name/email (без токенов!)
    if name:
        _run_git(["config", "user.name", name], cwd=repo_dir, timeout=10)
    if email:
        _run_git(["config", "user.email", email], cwd=repo_dir, timeout=10)

    active_branch = _current_branch(repo_dir, branch)
    github_ctx["branch"] = active_branch
    return {
        "ok": True,
        "owner": owner,
        "repo": repo,
        "branch": active_branch,
        "workspaceDir": str(repo_dir),
        "relWorkspace": str(repo_dir.relative_to(sandbox_root.resolve())).replace("\\", "/"),
    }


def _require_ctx(github_ctx: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(github_ctx, dict) or not str(github_ctx.get("token") or "").strip():
        raise GithubToolError("GitHub-аккаунт не привязан. Привяжите свой GitHub в блоке «Доверие и RAG» → GitHub.")
    if not str(github_ctx.get("owner") or "").strip() or not str(github_ctx.get("repo") or "").strip():
        raise GithubToolError("Репозиторий GitHub не выбран. Выберите проект и ветку в настройках GitHub Агента.")
    return github_ctx


def _iter_repo_files(repo_dir: Path) -> List[str]:
    result: List[str] = []
    root = repo_dir.resolve()
    for current, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        rel_dir = Path(current).resolve().relative_to(root)
        for fname in sorted(files):
            rel = str(rel_dir / fname).replace("\\", "/") if str(rel_dir) != "." else fname
            result.append(rel)
    return result


def _validate_approver(github_ctx: Dict[str, Any], decision: Dict[str, Any]) -> None:
    owner_uid = int(github_ctx.get("userId") or 0)
    approver_uid = decision.get("approverUserId")
    if owner_uid > 0 and approver_uid is not None and int(approver_uid) != owner_uid:
        raise GithubToolError(
            "Подтверждать Commit, Pull Request и Merge может только пользователь CRM, привязавший этот GitHub-аккаунт."
        )


def run_github_tool(
    name: str,
    args: Dict[str, Any],
    *,
    github_ctx: Optional[Dict[str, Any]],
    trust_level: str,
    approval_fn: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]],
    sandbox_root: Path,
) -> Tuple[str, List[Dict[str, Any]]]:
    args = args or {}
    events: List[Dict[str, Any]] = []
    ctx = _require_ctx(github_ctx)
    token = str(ctx["token"]).strip()
    owner = str(ctx["owner"]).strip()
    repo = str(ctx["repo"]).strip()
    branch = str(ctx.get("branch") or "main").strip() or "main"
    login = str(ctx.get("login") or "").strip()
    author_name = str(ctx.get("name") or login).strip()
    author_email = str(ctx.get("email") or f"{login}@users.noreply.github.com").strip()
    user_id = int(ctx.get("userId") or 0)
    repo_dir = get_repo_workspace_dir(sandbox_root, user_id, owner, repo)

    # Для write-инструментов редактирования (не считая анализа) проверяем trust_level
    if name in ("github_write_file", "github_edit_file", "github_delete_file", "github_create_branch",
                "github_commit", "github_create_pr", "github_merge_pr"):
        if trust_level == "none":
            raise GithubToolError(
                "При уровне доверия «Нет доступа» разрешён только анализ репозитория; изменение файлов, Commit, PR и Merge отключены."
            )

    if name == "github_repo_info":
        repo_meta = _gh_api(f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}", token)
        branches = _gh_api(
            f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/branches?per_page=30",
            token,
        )
        commits = _gh_api(
            f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/commits?sha={urllib.parse.quote(branch)}&per_page=8",
            token,
        )
        branch_names = [b.get("name", "") for b in (branches if isinstance(branches, list) else [])]
        commit_lines = []
        if isinstance(commits, list):
            for c in commits[:8]:
                sha = str(c.get("sha") or "")[:7]
                c_msg = str(((c.get("commit") or {}).get("message") or "")).splitlines()[0][:100]
                who = str(((c.get("author") or {}).get("login") or ((c.get("commit") or {}).get("author") or {}).get("name") or ""))
                commit_lines.append(f"  - {sha} ({who}): {c_msg}")
        local_branch = _current_branch(repo_dir, branch) if (repo_dir / ".git").exists() else branch
        lines = [
            f"Репозиторий: {owner}/{repo} ({'приватный' if repo_meta.get('private') else 'публичный'})",
            f"Описание: {repo_meta.get('description') or '—'}",
            f"Язык: {repo_meta.get('language') or '—'} | Default branch: {repo_meta.get('default_branch')}",
            f"Текущая ветка: {local_branch} | Привязанный аккаунт: @{login} ({author_name} <{author_email}>)",
            f"Ветки ({len(branch_names)}): {', '.join(branch_names[:20])}",
            f"Локальный рабочий каталог в Sandbox: {(repo_dir.relative_to(sandbox_root.resolve()) if (repo_dir / '.git').exists() else 'ещё не клонирован (синхронизируется автоматически)')}",
            "Последние коммиты:",
            *(commit_lines or ["  (нет коммитов)"]),
        ]
        return "\n".join(lines), events

    if name == "github_list_files":
        sub = str(args.get("path") or "").strip().lstrip("/")
        pattern = str(args.get("pattern") or "").strip().lower()
        max_items = max(10, min(500, int(args.get("max_items") or 200)))
        files: List[str] = []
        try:
            sync_info = ensure_repo_synced(ctx, sandbox_root=sandbox_root, branch_override=branch)
            all_files = _iter_repo_files(Path(sync_info["workspaceDir"]))
            files = all_files
        except GithubToolError:
            tree = _gh_api(
                f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/git/trees/{urllib.parse.quote(branch)}?recursive=1",
                token,
            )
            for item in tree.get("tree") or []:
                if item.get("type") == "blob" and item.get("path"):
                    p = str(item["path"])
                    if not any(part in SKIP_DIRS for part in p.split("/")):
                        files.append(p)
        if sub:
            files = [f for f in files if f == sub or f.startswith(sub.rstrip("/") + "/")]
        if pattern:
            files = [f for f in files if pattern in f.lower()]
        shown = files[:max_items]
        out = [f"Файлов в {owner}/{repo}@{branch}: {len(files)} (показано {len(shown)})"]
        out.extend(shown)
        return "\n".join(out), events

    if name == "github_read_file":
        rel_path = str(args.get("path") or "").strip().lstrip("/")
        if not rel_path:
            raise GithubToolError("Укажите path файла")
        offset = max(1, int(args.get("offset") or 1))
        limit = max(1, min(600, int(args.get("limit") or 220)))
        text_content: Optional[str] = None
        if (repo_dir / ".git").exists():
            fp = _safe_repo_file(repo_dir, rel_path)
            if fp.is_file():
                text_content = fp.read_text(encoding="utf-8", errors="replace")
        else:
            try:
                sync_info = ensure_repo_synced(ctx, sandbox_root=sandbox_root, branch_override=branch)
                fp = _safe_repo_file(Path(sync_info["workspaceDir"]), rel_path)
                if fp.is_file():
                    text_content = fp.read_text(encoding="utf-8", errors="replace")
            except GithubToolError:
                pass
        if text_content is None:
            enc_path = "/".join(urllib.parse.quote(p) for p in rel_path.split("/"))
            data = _gh_api(
                f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/contents/{enc_path}?ref={urllib.parse.quote(branch)}",
                token,
            )
            if data.get("encoding") != "base64" or not data.get("content"):
                raise GithubToolError(f"Файл {rel_path} не найден или является бинарным")
            text_content = base64.b64decode(str(data["content"]).replace("\n", "")).decode("utf-8", "replace")
        all_lines = text_content.splitlines()
        start_idx = offset - 1
        sliced = all_lines[start_idx : start_idx + limit]
        numbered = [f"{start_idx + i + 1}: {line}" for i, line in enumerate(sliced)]
        return (
            f"Файл {rel_path} (строки {offset}–{start_idx + len(sliced)} из {len(all_lines)}):\n"
            + "\n".join(numbered)
        ), events

    if name == "github_search_code":
        query = str(args.get("query") or "").strip()
        if not query:
            raise GithubToolError("Укажите query для поиска по коду")
        glob_filter = str(args.get("path_glob") or args.get("glob") or "").strip()
        exclude_glob = str(args.get("exclude_glob") or "").strip()
        use_regex = bool(args.get("regex", True))
        case_sensitive = bool(args.get("case_sensitive", False))
        whole_word = bool(args.get("whole_word", False))
        context_lines = max(0, min(5, int(args.get("context_lines") or 0)))
        files_only = bool(args.get("files_only", False))
        count_only = bool(args.get("count_only", False))
        force_remote = bool(args.get("remote", False))
        max_hits = max(1, min(150, int(args.get("max_hits") or 40)))

        def _match_pat(rel_p: str, pat: str) -> bool:
            p = pat.strip().replace("\\", "/").lstrip("/")
            if not p:
                return True
            if p.startswith(".") and "/" not in p and "*" not in p:
                return rel_p.lower().endswith(p.lower())
            if "*" not in p and "?" not in p:
                return p.lower() in rel_p.lower()
            return fnmatch.fnmatch(rel_p.lower(), p.lower()) or fnmatch.fnmatch(Path(rel_p).name.lower(), p.lower())

        if not force_remote:
            try:
                sync_info = ensure_repo_synced(ctx, sandbox_root=sandbox_root, branch_override=branch)
                wdir = Path(sync_info["workspaceDir"])
                flags = 0 if case_sensitive else re.IGNORECASE
                pat_str = query if use_regex else re.escape(query)
                if whole_word:
                    pat_str = rf"\b(?:{pat_str})\b"
                try:
                    rx = re.compile(pat_str, flags)
                except re.error:
                    rx = re.compile(re.escape(query), flags)
                hits: List[str] = []
                file_counts: Dict[str, int] = {}
                for rel in _iter_repo_files(wdir):
                    if glob_filter and not _match_pat(rel, glob_filter):
                        continue
                    if exclude_glob and _match_pat(rel, exclude_glob):
                        continue
                    if Path(rel).suffix.lower() in SKIP_EXTS:
                        continue
                    fp = wdir / rel
                    try:
                        if fp.stat().st_size > 600_000:
                            continue
                        lines = fp.read_text(encoding="utf-8", errors="replace").splitlines()
                    except OSError:
                        continue
                    fcnt = 0
                    for idx, line in enumerate(lines):
                        if rx.search(line):
                            fcnt += 1
                            if not files_only and not count_only and len(hits) < max_hits:
                                if context_lines == 0:
                                    hits.append(f"{rel}:{idx + 1}: {line.strip()[:220]}")
                                else:
                                    lo = max(0, idx - context_lines)
                                    hi = min(len(lines), idx + context_lines + 1)
                                    block = [f"--- {rel}:{idx + 1} ---"]
                                    for j in range(lo, hi):
                                        mark = ">" if j == idx else " "
                                        block.append(f"{mark} {j + 1}: {lines[j][:220]}")
                                    hits.append("\n".join(block))
                    if fcnt:
                        file_counts[rel] = fcnt
                    if not files_only and not count_only and len(hits) >= max_hits:
                        break
                if files_only or count_only:
                    flines = [f"{p} ({c})" for p, c in list(file_counts.items())[:max_hits]]
                    return (
                        f"Файлы с «{query}» ({len(file_counts)}):\n" + ("\n".join(flines) if flines else "(ничего не найдено)")
                    ), events
                return (
                    f"Совпадений по «{query}»: {sum(file_counts.values())} (в {len(file_counts)} файлах)\n"
                    + ("\n".join(hits) if hits else "(ничего не найдено)")
                ), events
            except GithubToolError:
                pass

        q_encoded = urllib.parse.quote(f"{query} repo:{owner}/{repo}")
        res = _gh_api(f"/search/code?q={q_encoded}&per_page={min(30, max_hits)}", token)
        items = res.get("items") if isinstance(res, dict) else []
        lines = [f"{it.get('path')} (score: {it.get('score', '')})" for it in (items or [])]
        return f"Поиск GitHub API по «{query}»:\n" + ("\n".join(lines) if lines else "(ничего не найдено)"), events

    if name == "github_read_files":
        raw_items = args.get("files") or args.get("paths")
        if not isinstance(raw_items, list) or not raw_items:
            raise GithubToolError("Передайте непустой массив files (до 12 путей или объектов {path, offset, limit})")
        def_offset = max(1, int(args.get("offset") or 1))
        def_limit = max(1, min(400, int(args.get("limit") or 160)))
        wdir = repo_dir
        if not (wdir / ".git").exists():
            sync_info = ensure_repo_synced(ctx, sandbox_root=sandbox_root, branch_override=branch)
            wdir = Path(sync_info["workspaceDir"])
        budget = 60_000
        used = 0
        sections: List[str] = [f"Пакетное чтение {owner}/{repo}@{branch}:"]
        for item in raw_items[:12]:
            if isinstance(item, str):
                rel_p, off, lim = item.strip().lstrip("/"), def_offset, def_limit
            elif isinstance(item, dict):
                rel_p = str(item.get("path") or "").strip().lstrip("/")
                off = max(1, int(item.get("offset") or def_offset))
                lim = max(1, min(400, int(item.get("limit") or def_limit)))
            else:
                continue
            if not rel_p:
                continue
            fp = _safe_repo_file(wdir, rel_p)
            try:
                if not fp.is_file():
                    sections.append(f"\n=== {rel_p} ===\n(файл не найден)")
                    continue
                if fp.suffix.lower() in SKIP_EXTS:
                    sections.append(f"\n=== {rel_p} ===\n(бинарный файл, {fp.stat().st_size} байт)")
                    continue
                all_lns = fp.read_text(encoding="utf-8", errors="replace").splitlines()
                st_idx = off - 1
                sl = all_lns[st_idx : st_idx + lim]
                body_txt = "\n".join(f"{st_idx + i + 1}: {ln}" for i, ln in enumerate(sl))
                if used + len(body_txt) > budget:
                    body_txt = body_txt[: max(500, budget - used)] + "\n... [обрезано по общему бюджету]"
                used += len(body_txt)
                sections.append(f"\n=== {rel_p} (строки {off}–{st_idx + len(sl)} из {len(all_lns)}) ===\n{body_txt}")
                if used >= budget:
                    break
            except OSError as err:
                sections.append(f"\n=== {rel_p} ===\n(ошибка чтения: {err})")
        return "\n".join(sections), events

    if name == "github_file_stat":
        raw_paths = args.get("paths") or ([args.get("path")] if args.get("path") else [])
        if not isinstance(raw_paths, list) or not raw_paths:
            raise GithubToolError("Укажите path или массив paths")
        sync_info = ensure_repo_synced(ctx, sandbox_root=sandbox_root, branch_override=branch)
        wdir = Path(sync_info["workspaceDir"])
        lines = [f"Метаданные файлов {owner}/{repo}@{sync_info['branch']}:"]
        for raw_p in raw_paths[:30]:
            rel_p = str(raw_p or "").strip().lstrip("/")
            if not rel_p:
                continue
            fp = _safe_repo_file(wdir, rel_p)
            if not fp.exists():
                lines.append(f"- {rel_p}: не найден")
                continue
            if fp.is_dir():
                lines.append(f"- {rel_p}/: каталог")
                continue
            raw_bytes = fp.read_bytes()
            sha = hashlib.sha256(raw_bytes).hexdigest()[:12]
            lcnt = 0 if fp.suffix.lower() in SKIP_EXTS else len(raw_bytes.decode("utf-8", "replace").splitlines())
            _, glog, _ = _run_git(["log", "-1", "--format=%h %cs %an | %s", "--", rel_p], cwd=wdir, timeout=10)
            g_str = f" | git: {glog.strip()[:90]}" if glog.strip() else ""
            lines.append(f"- {rel_p}: {len(raw_bytes)} байт, {lcnt} строк, sha256={sha}{g_str}")
        return "\n".join(lines), events

    if name == "github_changed_since":
        sync_info = ensure_repo_synced(ctx, sandbox_root=sandbox_root, branch_override=branch)
        wdir = Path(sync_info["workspaceDir"])
        base_ref = _validate_gh_rev(str(args.get("base") or "HEAD~5").strip())
        head_ref = _validate_gh_rev(str(args.get("head") or "HEAD").strip())
        code, st_out, err = _run_git(["diff", "--name-status", f"{base_ref}..{head_ref}"], cwd=wdir, timeout=15)
        if code != 0:
            raise GithubToolError(err or f"Не удалось сравнить {base_ref}..{head_ref}")
        _, stat_out, _ = _run_git(["diff", "--stat", f"{base_ref}..{head_ref}"], cwd=wdir, timeout=15)
        return (
            f"Изменения {base_ref}..{head_ref} в {owner}/{repo}:\n"
            f"{st_out.strip() or '(нет изменений)'}\n\n{stat_out.strip()}"
        ).strip(), events

    if name == "github_ci_status":
        ref = str(args.get("ref") or "").strip()
        pull_number = int(args.get("pull_number") or 0)
        if pull_number > 0 and not ref:
            pr_data = _gh_api(f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/pulls/{pull_number}", token)
            ref = str(((pr_data.get("head") or {}).get("sha")) or branch)
        target_ref = ref or branch
        checks = _gh_api(
            f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/commits/{urllib.parse.quote(target_ref)}/check-runs?per_page=30",
            token,
        )
        runs = _gh_api(
            f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/actions/runs?branch={urllib.parse.quote(branch)}&per_page=10",
            token,
        )
        lines = [f"Статус CI для {owner}/{repo} (ref={target_ref}):"]
        check_runs = checks.get("check_runs") if isinstance(checks, dict) else []
        if check_runs:
            lines.append("\nCheck runs:")
            for cr in check_runs[:25]:
                lines.append(
                    f"  - {cr.get('name')}: status={cr.get('status')}, conclusion={cr.get('conclusion') or 'pending'} "
                    f"({cr.get('html_url') or ''})"
                )
        wf_runs = runs.get("workflow_runs") if isinstance(runs, dict) else []
        if wf_runs:
            lines.append("\nWorkflow runs:")
            for wr in wf_runs[:10]:
                lines.append(
                    f"  - #{wr.get('run_number')} {wr.get('name')}: status={wr.get('status')}, "
                    f"conclusion={wr.get('conclusion') or 'pending'} ({wr.get('html_url') or ''})"
                )
        if not check_runs and not wf_runs:
            lines.append("(запусков CI / check-runs не найдено)")
        return "\n".join(lines), events

    if name == "github_get_pr_diff":
        pull_number = int(args.get("pull_number") or 0)
        if pull_number <= 0:
            raise GithubToolError("Укажите корректный номер PR (pull_number)")
        pr = _gh_api(f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/pulls/{pull_number}", token)
        files = _gh_api(
            f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/pulls/{pull_number}/files?per_page=50",
            token,
        )
        comments = _gh_api(
            f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/pulls/{pull_number}/comments?per_page=30",
            token,
        )
        lines = [
            f"PR #{pull_number} [{pr.get('state')}]: {pr.get('title')}",
            f"Ветка: {(pr.get('head') or {}).get('ref')} -> {(pr.get('base') or {}).get('ref')} | {pr.get('html_url')}",
            f"Статистика: +{pr.get('additions', 0)} / -{pr.get('deletions', 0)}, файлов: {pr.get('changed_files', 0)}",
            "\nФайлы и патчи:",
        ]
        if isinstance(files, list):
            total_patch_chars = 0
            for f in files[:40]:
                patch = str(f.get("patch") or "")
                lines.append(f"\n--- {f.get('filename')} [{f.get('status')}] (+{f.get('additions')}/-{f.get('deletions')}) ---")
                if patch and total_patch_chars < 14_000:
                    slice_p = patch[:2500]
                    lines.append(slice_p)
                    total_patch_chars += len(slice_p)
        if isinstance(comments, list) and comments:
            lines.append("\nReview-комментарии:")
            for cm in comments[:20]:
                who = (cm.get("user") or {}).get("login", "")
                lines.append(f"  - @{who} ({cm.get('path')}:{cm.get('line') or cm.get('original_line') or '?'}): {str(cm.get('body') or '')[:220]}")
        return "\n".join(lines), events

    if name == "github_status":
        sync_info = ensure_repo_synced(ctx, sandbox_root=sandbox_root, branch_override=branch)
        wdir = Path(sync_info["workspaceDir"])
        code, st, err = _run_git(["status", "--short", "-b"], cwd=wdir, timeout=10)
        if code != 0:
            raise GithubToolError(err or "Не удалось получить git status")
        return f"Рабочий каталог {sync_info['relWorkspace']} ({owner}/{repo}):\n{st.strip() or 'чисто'}", events

    if name == "github_diff":
        sync_info = ensure_repo_synced(ctx, sandbox_root=sandbox_root, branch_override=branch)
        wdir = Path(sync_info["workspaceDir"])
        target_path = str(args.get("path") or "").strip().lstrip("/")
        git_args = ["diff"]
        if args.get("staged"):
            git_args.append("--cached")
        if target_path:
            _safe_repo_file(wdir, target_path)
            git_args.extend(["--", target_path])
        code, diff_out, err = _run_git(git_args, cwd=wdir, timeout=15)
        if code != 0:
            raise GithubToolError(err or "Не удалось получить diff")
        # Также добавим список untracked-файлов
        _, untracked, _ = _run_git(["ls-files", "--others", "--exclude-standard"], cwd=wdir, timeout=10)
        text = diff_out.strip()
        if len(text) > 12_000:
            text = text[:12_000] + "\n... [diff обрезан]"
        parts = []
        if text:
            parts.append(text)
        if untracked.strip():
            parts.append("Новые (untracked) файлы:\n" + untracked.strip())
        return "\n\n".join(parts) if parts else "Локальных изменений в репозитории нет.", events

    if name == "github_list_prs":
        state = str(args.get("state") or "open").strip().lower()
        if state not in ("open", "closed", "all"):
            state = "open"
        prs = _gh_api(
            f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/pulls?state={state}&per_page=20",
            token,
        )
        if not isinstance(prs, list) or not prs:
            return f"Pull Request со статусом '{state}' в {owner}/{repo} нет.", events
        lines = []
        for pr in prs[:20]:
            head_ref = (pr.get("head") or {}).get("ref", "")
            base_ref = (pr.get("base") or {}).get("ref", "")
            user_login = (pr.get("user") or {}).get("login", "")
            lines.append(
                f"#{pr.get('number')} [{pr.get('state')}] {pr.get('title')} "
                f"({head_ref} -> {base_ref}, автор @{user_login}) — {pr.get('html_url')}"
            )
        return "\n".join(lines), events

    if name == "github_write_file":
        rel_path = str(args.get("path") or "").strip().lstrip("/")
        content = str(args.get("content") or "")
        sync_info = ensure_repo_synced(ctx, sandbox_root=sandbox_root, branch_override=branch)
        wdir = Path(sync_info["workspaceDir"])
        fp = _safe_repo_file(wdir, rel_path)
        existed = fp.exists()
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(content, encoding="utf-8")
        events.append(
            {
                "type": "github_edit",
                "owner": owner,
                "repo": repo,
                "branch": sync_info["branch"],
                "path": rel_path,
                "mode": "update" if existed else "create",
                "bytes": len(content.encode("utf-8")),
            }
        )
        return (
            f"Файл «{rel_path}» {'обновлён' if existed else 'создан'} в локальной копии {owner}/{repo} "
            f"(ветка {sync_info['branch']}). Изменения ещё НЕ закоммичены в GitHub — для отправки в репозиторий вызови github_commit."
        ), events

    if name == "github_edit_file":
        rel_path = str(args.get("path") or "").strip().lstrip("/")
        old_text = str(args.get("old_text") or "")
        new_text = str(args.get("new_text") or "")
        if not old_text:
            raise GithubToolError("Укажите непустой old_text для замены")
        sync_info = ensure_repo_synced(ctx, sandbox_root=sandbox_root, branch_override=branch)
        wdir = Path(sync_info["workspaceDir"])
        fp = _safe_repo_file(wdir, rel_path)
        if not fp.is_file():
            raise GithubToolError(f"Файл {rel_path} не найден")
        current = fp.read_text(encoding="utf-8", errors="replace")
        count = current.count(old_text)
        if count == 0:
            raise GithubToolError(f"Фрагмент old_text не найден в {rel_path}")
        if count > 1 and not args.get("replace_all"):
            raise GithubToolError(
                f"Фрагмент old_text встречается {count} раз в {rel_path}. Уточните контекст или передайте replace_all=true."
            )
        updated = current.replace(old_text, new_text) if args.get("replace_all") else current.replace(old_text, new_text, 1)
        fp.write_text(updated, encoding="utf-8")
        events.append(
            {
                "type": "github_edit",
                "owner": owner,
                "repo": repo,
                "branch": sync_info["branch"],
                "path": rel_path,
                "mode": "patch",
                "bytes": len(updated.encode("utf-8")),
            }
        )
        return (
            f"Файл «{rel_path}» изменён в ветке {sync_info['branch']}. "
            f"Для сохранения в GitHub вызови github_commit (потребуется подтверждение пользователя)."
        ), events

    if name == "github_delete_file":
        rel_path = str(args.get("path") or "").strip().lstrip("/")
        sync_info = ensure_repo_synced(ctx, sandbox_root=sandbox_root, branch_override=branch)
        wdir = Path(sync_info["workspaceDir"])
        fp = _safe_repo_file(wdir, rel_path)
        if not fp.exists() or not fp.is_file():
            raise GithubToolError(f"Файл {rel_path} не найден")
        fp.unlink()
        events.append(
            {
                "type": "github_edit",
                "owner": owner,
                "repo": repo,
                "branch": sync_info["branch"],
                "path": rel_path,
                "mode": "delete",
                "bytes": 0,
            }
        )
        return f"Файл «{rel_path}» удалён локально в ветке {sync_info['branch']}.", events

    if name == "github_create_branch":
        new_branch = _validate_gh_branch(str(args.get("branch") or ""))
        if not re.match(r"^[A-Za-z0-9._/-]+$", new_branch):
            raise GithubToolError("Укажите корректное имя новой ветки")
        from_branch = _validate_gh_branch(str(args.get("from_branch") or branch).strip() or branch)
        sync_info = ensure_repo_synced(ctx, sandbox_root=sandbox_root, branch_override=from_branch)
        wdir = Path(sync_info["workspaceDir"])
        code, _, err = _run_git(["checkout", "-b", new_branch], cwd=wdir, timeout=15)
        if code != 0:
            code2, _, err2 = _run_git(["checkout", new_branch], cwd=wdir, timeout=15)
            if code2 != 0:
                raise GithubToolError(f"Не удалось переключиться/создать ветку {new_branch}: {err2 or err}")
        ctx["branch"] = new_branch
        return f"Создана и активирована рабочая ветка «{new_branch}» (от {from_branch}).", events

    # ------------------------------------------------------------------
    # Критические GitHub-действия с ОБЯЗАТЕЛЬНЫМ подтверждением владельца
    # ------------------------------------------------------------------
    if approval_fn is None:
        raise GithubToolError("Действия Commit / Pull Request / Merge требуют подтверждения пользователя на сайте.")

    if name == "github_commit":
        sync_info = ensure_repo_synced(ctx, sandbox_root=sandbox_root, branch_override=branch)
        wdir = Path(sync_info["workspaceDir"])
        cur_branch = sync_info["branch"]
        target_branch = str(args.get("branch") or cur_branch).strip() or cur_branch
        message = str(args.get("message") or "").strip()
        if not message:
            raise GithubToolError("Укажите сообщение коммита (message)")
        push_remote = bool(args.get("push", True))
        req_files = args.get("files") if isinstance(args.get("files"), list) else []

        _, st_short, _ = _run_git(["status", "--short"], cwd=wdir, timeout=10)
        changed_lines = [ln for ln in st_short.splitlines() if ln.strip()]
        if not changed_lines:
            return "Нет незакоммиченных изменений в рабочем каталоге.", events

        _, diff_stat, _ = _run_git(["diff", "--stat"], cwd=wdir, timeout=10)
        _, diff_body, _ = _run_git(["diff"], cwd=wdir, timeout=10)
        preview = "\n".join(
            [p for p in [st_short.strip(), diff_stat.strip(), diff_body.strip()[:2500]] if p]
        )[:3500]

        decision = approval_fn(
            {
                "kind": "github_commit",
                "title": f"Разрешить Commit {'и Push ' if push_remote else ''}от имени @{login}",
                "command": f"git commit -m \"{message}\"" + (f" && git push origin {target_branch}" if push_remote else ""),
                "reason": f"Изменение репозитория {owner}/{repo} от лица привязавшего аккаунт @{login}",
                "github": {
                    "login": login,
                    "authorName": author_name,
                    "authorEmail": author_email,
                    "owner": owner,
                    "repo": repo,
                    "branch": target_branch,
                    "message": message,
                    "push": push_remote,
                    "files": changed_lines[:30],
                    "diffPreview": preview,
                },
            }
        )
        _validate_approver(ctx, decision)
        if not decision.get("approved"):
            why = str(decision.get("note") or "").strip()
            return f"Пользователь отклонил Commit/Push.{f' Причина: {why}' if why else ''}", events

        final_msg = str(decision.get("commitMessage") or message).strip() or message
        final_branch = _validate_gh_branch(str(decision.get("branch") or target_branch).strip() or target_branch)
        if final_branch != cur_branch:
            c_sw, _, e_sw = _run_git(["checkout", "-B", final_branch], cwd=wdir, timeout=15)
            if c_sw != 0:
                raise GithubToolError(f"Не удалось переключиться на ветку {final_branch}: {e_sw}")
            ctx["branch"] = final_branch

        if req_files:
            safe_paths = [str(_safe_repo_file(wdir, str(f)).relative_to(wdir)).replace("\\", "/") for f in req_files]
            c_add, _, e_add = _run_git(["add", "--", *safe_paths], cwd=wdir, timeout=15)
        else:
            c_add, _, e_add = _run_git(["add", "-A"], cwd=wdir, timeout=15)
        if c_add != 0:
            raise GithubToolError(f"Ошибка git add: {e_add}")

        c_cm, out_cm, err_cm = _run_git(
            ["commit", "-m", final_msg],
            cwd=wdir,
            token=token,
            author_name=author_name,
            author_email=author_email,
            timeout=20,
        )
        if c_cm != 0:
            raise GithubToolError(f"Ошибка git commit: {err_cm or out_cm}")

        _, sha_out, _ = _run_git(["rev-parse", "HEAD"], cwd=wdir, timeout=10)
        commit_sha = sha_out.strip()

        pushed = False
        if push_remote:
            c_push, out_p, err_p = _run_git(
                ["push", "-u", "origin", final_branch],
                cwd=wdir,
                token=token,
                use_auth=True,
                timeout=45,
            )
            if c_push != 0:
                raise GithubToolError(f"Коммит {commit_sha[:7]} создан локально, но git push не удался: {err_p or out_p}")
            pushed = True

        commit_url = f"https://github.com/{owner}/{repo}/commit/{commit_sha}" if commit_sha else f"https://github.com/{owner}/{repo}"
        events.append(
            {
                "type": "github_commit",
                "owner": owner,
                "repo": repo,
                "branch": final_branch,
                "sha": commit_sha,
                "message": final_msg,
                "pushed": pushed,
                "authorLogin": login,
                "url": commit_url,
            }
        )
        return (
            f"Коммит {commit_sha[:7]} {'и Push в origin/' + final_branch + ' ' if pushed else ''}выполнен от имени @{login} ({author_name} <{author_email}>).\n"
            f"Сообщение: {final_msg}\nСсылка: {commit_url}"
        ), events

    if name == "github_create_pr":
        title = str(args.get("title") or "").strip()
        body = str(args.get("body") or "").strip()
        head = str(args.get("head") or branch).strip() or branch
        base = str(args.get("base") or "").strip()
        draft = bool(args.get("draft", False))
        if not title:
            raise GithubToolError("Укажите заголовок Pull Request (title)")
        if not base:
            repo_meta = _gh_api(f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}", token)
            base = str(repo_meta.get("default_branch") or "main")
        if head == base:
            raise GithubToolError(
                f"Ветка-источник ({head}) совпадает с целевой ({base}). Создайте отдельную ветку через github_create_branch и сделайте commit+push."
            )

        decision = approval_fn(
            {
                "kind": "github_pr",
                "title": f"Разрешить Pull Request от имени @{login}",
                "command": f"POST /repos/{owner}/{repo}/pulls ({head} → {base}): {title}",
                "reason": f"Открытие Pull Request в {owner}/{repo} от лица привязавшего аккаунт @{login}",
                "github": {
                    "login": login,
                    "owner": owner,
                    "repo": repo,
                    "head": head,
                    "base": base,
                    "prTitle": title,
                    "prBody": body,
                    "draft": draft,
                },
            }
        )
        _validate_approver(ctx, decision)
        if not decision.get("approved"):
            why = str(decision.get("note") or "").strip()
            return f"Пользователь отклонил создание Pull Request.{f' Причина: {why}' if why else ''}", events

        final_title = str(decision.get("prTitle") or title).strip() or title
        final_body = str(decision.get("prBody") if decision.get("prBody") is not None else body)
        pr = _gh_api(
            f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/pulls",
            token,
            method="POST",
            body={
                "title": final_title,
                "body": final_body,
                "head": head,
                "base": base,
                "draft": draft,
            },
        )
        pr_num = pr.get("number")
        pr_url = str(pr.get("html_url") or "")
        events.append(
            {
                "type": "github_pr",
                "owner": owner,
                "repo": repo,
                "number": pr_num,
                "title": final_title,
                "head": head,
                "base": base,
                "authorLogin": login,
                "url": pr_url,
            }
        )
        return (
            f"Pull Request #{pr_num} создан от имени @{login}: «{final_title}» ({head} -> {base}).\nСсылка: {pr_url}"
        ), events

    if name == "github_merge_pr":
        pull_number = int(args.get("pull_number") or 0)
        if pull_number <= 0:
            raise GithubToolError("Укажите корректный номер Pull Request (pull_number)")
        merge_method = str(args.get("merge_method") or "merge").strip().lower()
        if merge_method not in ("merge", "squash", "rebase"):
            merge_method = "merge"
        commit_title = str(args.get("commit_title") or "").strip()

        pr = _gh_api(
            f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/pulls/{pull_number}",
            token,
        )
        pr_title = str(pr.get("title") or f"PR #{pull_number}")
        head_ref = str((pr.get("head") or {}).get("ref") or "")
        base_ref = str((pr.get("base") or {}).get("ref") or "")
        pr_state = str(pr.get("state") or "")
        pr_url = str(pr.get("html_url") or "")
        if pr_state != "open":
            raise GithubToolError(f"Pull Request #{pull_number} уже имеет статус '{pr_state}' и не может быть смержен.")

        decision = approval_fn(
            {
                "kind": "github_merge",
                "title": f"Разрешить Merge PR #{pull_number} от имени @{login}",
                "command": f"Merge PR #{pull_number} ({head_ref} → {base_ref}, метод: {merge_method})",
                "reason": f"Слияние Pull Request #{pull_number} в {owner}/{repo} от лица привязавшего аккаунт @{login}",
                "github": {
                    "login": login,
                    "owner": owner,
                    "repo": repo,
                    "pullNumber": pull_number,
                    "prTitle": pr_title,
                    "head": head_ref,
                    "base": base_ref,
                    "mergeMethod": merge_method,
                    "mergeableState": str(pr.get("mergeable_state") or ""),
                    "url": pr_url,
                },
            }
        )
        _validate_approver(ctx, decision)
        if not decision.get("approved"):
            why = str(decision.get("note") or "").strip()
            return f"Пользователь отклонил Merge PR #{pull_number}.{f' Причина: {why}' if why else ''}", events

        final_method = str(decision.get("mergeMethod") or merge_method).strip().lower()
        if final_method not in ("merge", "squash", "rebase"):
            final_method = "merge"
        merge_payload: Dict[str, Any] = {"merge_method": final_method}
        if commit_title:
            merge_payload["commit_title"] = commit_title

        res = _gh_api(
            f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/pulls/{pull_number}/merge",
            token,
            method="PUT",
            body=merge_payload,
        )
        merged_sha = str(res.get("sha") or "")
        events.append(
            {
                "type": "github_merge",
                "owner": owner,
                "repo": repo,
                "number": pull_number,
                "title": pr_title,
                "method": final_method,
                "sha": merged_sha,
                "authorLogin": login,
                "url": pr_url,
            }
        )
        return (
            f"Pull Request #{pull_number} («{pr_title}») успешно влит в {base_ref} ({final_method}) от имени @{login}.\n"
            f"Commit SHA: {merged_sha}\nСсылка: {pr_url}"
        ), events

    raise GithubToolError(f"Неизвестный GitHub-инструмент: {name}")


def _fn(name: str, description: str, properties: Dict[str, Any], required: Optional[List[str]] = None) -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required or [],
            },
        },
    }


GITHUB_READ_TOOLS: List[Dict[str, Any]] = [
    _fn(
        "github_repo_info",
        "Показать информацию о привязанном GitHub-репозитории, ветках, последних коммитах и локальной копии.",
        {},
    ),
    _fn(
        "github_list_files",
        "Список файлов в выбранном GitHub-репозитории (подходит для навигации по структуре проекта и RAG-анализа).",
        {
            "path": {"type": "string", "description": "Подпапка внутри репозитория (необязательно)"},
            "pattern": {"type": "string", "description": "Фильтр по части имени файла"},
            "max_items": {"type": "integer", "description": "Максимум путей (по умолчанию 200)"},
        },
    ),
    _fn(
        "github_read_file",
        "Прочитать содержимое файла из привязанного GitHub-репозитория с номерами строк.",
        {
            "path": {"type": "string", "description": "Относительный путь файла в репозитории"},
            "offset": {"type": "integer", "description": "С какой строки начать (с 1)"},
            "limit": {"type": "integer", "description": "Сколько строк прочитать (по умолчанию 220)"},
        },
        ["path"],
    ),
    _fn(
        "github_read_files",
        "Прочитать до 12 файлов из GitHub-репозитория одним пакетным вызовом (экономит шаги).",
        {
            "files": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Массив путей файлов (или объектов {path, offset, limit})",
            },
            "offset": {"type": "integer", "description": "Начальная строка (по умолчанию 1)"},
            "limit": {"type": "integer", "description": "Строк на файл (по умолчанию 160)"},
        },
        ["files"],
    ),
    _fn(
        "github_file_stat",
        "Получить размер, число строк, SHA-256 и последний коммит git для указанных файлов репозитория.",
        {
            "paths": {"type": "array", "items": {"type": "string"}, "description": "Список путей файлов"},
            "path": {"type": "string", "description": "Один путь файла"},
        },
    ),
    _fn(
        "github_search_code",
        "Мощный поиск по коду привязанного GitHub-репозитория (regex, whole_word, case_sensitive, context_lines, path_glob, exclude_glob, files_only/count_only).",
        {
            "query": {"type": "string", "description": "Строка или regex для поиска"},
            "glob": {"type": "string", "description": "Фильтр по пути/расширению, например '*.tsx' или 'src/api'"},
            "path_glob": {"type": "string", "description": "Синоним glob (шаблон пути)"},
            "exclude_glob": {"type": "string", "description": "Исключить файлы по шаблону"},
            "regex": {"type": "boolean", "description": "Трактовать как regex (по умолчанию true)"},
            "case_sensitive": {"type": "boolean", "description": "Учитывать регистр"},
            "whole_word": {"type": "boolean", "description": "Только целые слова"},
            "context_lines": {"type": "integer", "description": "Сколько строк контекста до/после (0–5)"},
            "files_only": {"type": "boolean", "description": "Только список файлов и количество совпадений"},
            "count_only": {"type": "boolean", "description": "Только сводка счётчиков по файлам"},
            "remote": {"type": "boolean", "description": "Искать через удалённый GitHub Code Search API"},
            "max_hits": {"type": "integer", "description": "Максимум совпадений (по умолчанию 40)"},
        },
        ["query"],
    ),
    _fn(
        "github_changed_since",
        "Список изменённых файлов и diff-статистика между двумя коммитами или ветками (base..head).",
        {
            "base": {"type": "string", "description": "Базовый ref (напр. HEAD~5 или origin/main)"},
            "head": {"type": "string", "description": "Целевой ref (по умолчанию HEAD)"},
        },
    ),
    _fn(
        "github_ci_status",
        "Проверить статус CI (Check Runs и GitHub Actions workflows) для ветки, коммита или PR.",
        {
            "ref": {"type": "string", "description": "SHA или ветка (по умолчанию текущая ветка)"},
            "pull_number": {"type": "integer", "description": "Номер PR для проверки его head SHA"},
        },
    ),
    _fn(
        "github_get_pr_diff",
        "Получить детальный diff файлов, статистику и review-комментарии конкретного Pull Request.",
        {
            "pull_number": {"type": "integer", "description": "Номер Pull Request"},
        },
        ["pull_number"],
    ),
    _fn(
        "github_status",
        "Показать git status и текущую ветку локальной рабочей копии репозитория.",
        {},
    ),
    _fn(
        "github_diff",
        "Показать unified diff локальных изменений и список новых файлов перед коммитом.",
        {
            "path": {"type": "string", "description": "Конкретный файл (необязательно)"},
            "staged": {"type": "boolean", "description": "Показать только staged diff"},
        },
    ),
    _fn(
        "github_list_prs",
        "Получить список Pull Request в выбранном репозитории GitHub.",
        {
            "state": {"type": "string", "enum": ["open", "closed", "all"], "description": "Статус PR (по умолчанию open)"},
        },
    ),
]

GITHUB_WRITE_TOOLS: List[Dict[str, Any]] = [
    _fn(
        "github_write_file",
        "Создать новый или перезаписать существующий файл в локальной рабочей копии GitHub-репозитория.",
        {
            "path": {"type": "string", "description": "Относительный путь файла в репозитории"},
            "content": {"type": "string", "description": "Полное содержимое файла"},
        },
        ["path", "content"],
    ),
    _fn(
        "github_edit_file",
        "Точечно заменить фрагмент кода в файле GitHub-репозитория (по точному совпадению old_text -> new_text).",
        {
            "path": {"type": "string", "description": "Относительный путь файла"},
            "old_text": {"type": "string", "description": "Точный фрагмент текста для замены"},
            "new_text": {"type": "string", "description": "Новый текст"},
            "replace_all": {"type": "boolean", "description": "Заменить все вхождения"},
        },
        ["path", "old_text", "new_text"],
    ),
    _fn(
        "github_delete_file",
        "Удалить файл из локальной рабочей копии GitHub-репозитория.",
        {
            "path": {"type": "string", "description": "Относительный путь файла"},
        },
        ["path"],
    ),
    _fn(
        "github_create_branch",
        "Создать и активировать новую ветку Git для правок и последующего Pull Request.",
        {
            "branch": {"type": "string", "description": "Имя новой ветки (например feat/fix-bug)"},
            "from_branch": {"type": "string", "description": "Базовая ветка (необязательно)"},
        },
        ["branch"],
    ),
    _fn(
        "github_commit",
        "Сделать git commit (и по умолчанию push) от лица пользователя, привязавшего GitHub. ВСЕГДА спрашивает подтверждение на сайте!",
        {
            "message": {"type": "string", "description": "Текст commit message"},
            "branch": {"type": "string", "description": "Целевая ветка для push (по умолчанию текущая)"},
            "files": {"type": "array", "items": {"type": "string"}, "description": "Конкретные файлы или пусто для всех изменённых"},
            "push": {"type": "boolean", "description": "Отправить коммит на GitHub (origin), по умолчанию true"},
        },
        ["message"],
    ),
    _fn(
        "github_create_pr",
        "Открыть Pull Request в привязанном репозитории строго от имени пользователя, привязавшего GitHub. ВСЕГДА спрашивает подтверждение на сайте!",
        {
            "title": {"type": "string", "description": "Заголовок Pull Request"},
            "body": {"type": "string", "description": "Описание Pull Request (Markdown)"},
            "head": {"type": "string", "description": "Исходная ветка с изменениями"},
            "base": {"type": "string", "description": "Целевая ветка (по умолчанию default branch, например main)"},
            "draft": {"type": "boolean", "description": "Создать как Draft PR"},
        },
        ["title"],
    ),
    _fn(
        "github_merge_pr",
        "Выполнить Merge существующего Pull Request строго от имени пользователя, привязавшего GitHub. ВСЕГДА спрашивает подтверждение на сайте!",
        {
            "pull_number": {"type": "integer", "description": "Номер Pull Request"},
            "merge_method": {"type": "string", "enum": ["merge", "squash", "rebase"], "description": "Способ слияния"},
            "commit_title": {"type": "string", "description": "Заголовок merge-коммита (необязательно)"},
        },
        ["pull_number"],
    ),
]

ALL_GITHUB_TOOL_NAMES = {
    t["function"]["name"] for t in (GITHUB_READ_TOOLS + GITHUB_WRITE_TOOLS)
}
