#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Расширенные инструменты анализа кода, верификации, безопасности, архитектуры
и планирования для ИИ-агента и под-агента Тестировщика (`agent/code_tools.py`).

Все инструменты работают строго в изолированных границах:
  * либо внутри проекта в Sandbox (`sandbox_root` / `sandbox_project`),
  * либо внутри изолированной копии подключённого GitHub-репозитория (`github_ctx`).

Никаких произвольных shell-строк при запуске проверок — используется прямой
запуск `argv` (`shell=False`) с очищенным окружением из `sandbox.sanitized_env`.
"""

from __future__ import annotations

import ast
import fnmatch
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import github_tools
import sandbox as sandbox_mod

SKIP_DIRS = frozenset({
    ".git",
    "node_modules",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".turbo",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "dist",
    "build",
    "out",
    "target",
    "coverage",
    ".tmp",
})

BINARY_EXTS = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
    ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".mp4", ".mp3", ".wav", ".ogg", ".webm",
    ".sqlite", ".sqlite3", ".db", ".pyc", ".so", ".dll", ".exe",
})

LANG_BY_EXT = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript React",
    ".js": "JavaScript",
    ".jsx": "JavaScript React",
    ".mjs": "JavaScript ESM",
    ".cjs": "JavaScript CJS",
    ".py": "Python",
    ".sql": "SQL",
    ".json": "JSON",
    ".md": "Markdown",
    ".css": "CSS",
    ".scss": "SCSS",
    ".html": "HTML",
    ".htm": "HTML",
    ".yml": "YAML",
    ".yaml": "YAML",
    ".sh": "Shell",
}


class CodeToolError(RuntimeError):
    """Ошибка выполнения инструмента анализа или верификации кода."""


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


def _resolve_target_root(
    args: Dict[str, Any],
    *,
    sandbox_root: Path,
    github_ctx: Optional[Dict[str, Any]],
) -> Tuple[Path, str]:
    """Определяет корневой каталог проекта: Sandbox или локальный клон GitHub."""
    target = str(args.get("target") or "auto").strip().lower()
    sandbox_project = str(args.get("sandbox_project") or "").strip()

    def _github_dir() -> Optional[Path]:
        if not isinstance(github_ctx, dict):
            return None
        owner = str(github_ctx.get("owner") or "").strip()
        repo = str(github_ctx.get("repo") or "").strip()
        token = str(github_ctx.get("token") or "").strip()
        login = str(github_ctx.get("login") or "").strip()
        if not owner or not repo:
            return None
        # Если в контексте есть токен и логин — синхронизируем, если локального клона ещё нет.
        wdir = github_tools.get_repo_workspace_dir(sandbox_root, github_ctx.get("userId") or 0, owner, repo)
        if (wdir / ".git").exists():
            return wdir
        if token and login:
            info = github_tools.ensure_repo_synced(
                github_ctx,
                sandbox_root=sandbox_root,
                branch_override=str(github_ctx.get("branch") or ""),
            )
            return Path(info["workspaceDir"])
        if wdir.exists():
            return wdir
        return None

    if target == "github":
        gh = _github_dir()
        if gh is None:
            raise CodeToolError("GitHub-репозиторий не подключён или не выбран.")
        return gh, "github"

    if target == "sandbox":
        rel = sandbox_project or "."
        base = sandbox_mod.safe_resolve(sandbox_root, rel, allow_root=True)
        if not base.exists():
            raise CodeToolError(f"Проект не найден в Sandbox: {rel}")
        return (base.parent if base.is_file() else base), f"sandbox:{rel}"

    # target == "auto"
    if sandbox_project and sandbox_project != ".":
        base = sandbox_mod.safe_resolve(sandbox_root, sandbox_project, allow_root=True)
        if base.exists():
            return (base.parent if base.is_file() else base), f"sandbox:{sandbox_project}"

    gh = _github_dir()
    if gh is not None:
        return gh, "github"

    rel = sandbox_project or "."
    base = sandbox_mod.safe_resolve(sandbox_root, rel, allow_root=True)
    if not base.exists():
        raise CodeToolError(f"Каталог не найден в Sandbox: {rel}")
    return (base.parent if base.is_file() else base), f"sandbox:{rel}"


def _safe_file(root: Path, rel_path: str, *, allow_dir: bool = False) -> Path:
    clean = str(rel_path or "").strip().replace("\\", "/").lstrip("/")
    if not clean or clean == ".":
        if allow_dir:
            return root.resolve()
        raise CodeToolError("Укажите относительный путь файла")
    if "\x00" in clean:
        raise CodeToolError("Недопустимый символ в пути")
    if re.match(r"^[A-Za-z]:", clean) or clean.startswith("~"):
        raise CodeToolError(f"Недопустимый путь: {rel_path}")
    parts = [p for p in clean.split("/") if p not in ("", ".")]
    root_res = root.resolve()
    cur = root_res
    for part in parts:
        if part in ("..", ".git"):
            raise CodeToolError(f"Доступ за пределы проекта или в .git запрещён: {rel_path}")
        cur = cur / part
        if cur.is_symlink():
            resolved = cur.resolve(strict=False)
            try:
                resolved.relative_to(root_res)
            except ValueError as err:
                raise CodeToolError(f"Запрещена симлинка за пределы проекта: {rel_path}") from err
    final = cur.resolve(strict=False)
    try:
        final.relative_to(root_res)
    except ValueError as err:
        raise CodeToolError(f"Путь выходит за пределы проекта: {rel_path}") from err
    return final


def _match_glob(rel_path: str, pattern: str) -> bool:
    if not pattern:
        return True
    norm = rel_path.replace("\\", "/")
    pat = pattern.strip().replace("\\", "/").lstrip("/")
    if pat.startswith(".") and "/" not in pat and "*" not in pat:
        return norm.lower().endswith(pat.lower())
    if "*" not in pat and "?" not in pat:
        return pat.lower() in norm.lower()
    if fnmatch.fnmatch(norm.lower(), pat.lower()):
        return True
    if "/" not in pat and fnmatch.fnmatch(Path(norm).name.lower(), pat.lower()):
        return True
    if pat.startswith("**/") and fnmatch.fnmatch(norm.lower(), pat[3:].lower()):
        return True
    return False


def _iter_files(
    root: Path,
    *,
    subdir: str = "",
    path_glob: str = "",
    exclude_glob: str = "",
    include_binary: bool = False,
    max_files: int = 2500,
) -> List[Path]:
    root_res = root.resolve()
    start = _safe_file(root_res, subdir, allow_dir=True) if subdir else root_res
    if start.is_file():
        return [start]
    if not start.exists():
        return []
    found: List[Path] = []
    for cur, dirs, files in os.walk(start, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith(".tmp"))
        for fname in sorted(files):
            fp = Path(cur) / fname
            if fp.is_symlink():
                try:
                    fp.resolve(strict=False).relative_to(root_res)
                except ValueError:
                    continue
            rel = fp.relative_to(root_res).as_posix()
            if not include_binary and fp.suffix.lower() in BINARY_EXTS:
                continue
            if path_glob and not _match_glob(rel, path_glob):
                continue
            if exclude_glob and _match_glob(rel, exclude_glob):
                continue
            found.append(fp)
            if len(found) >= max_files:
                return found
    return found


def _run_argv(
    argv: List[str],
    *,
    cwd: Path,
    sandbox_root: Path,
    timeout: int = 120,
) -> Tuple[int, str]:
    env = sandbox_mod.sanitized_env(sandbox_root, cwd)
    kwargs: Dict[str, Any] = {
        "cwd": str(cwd),
        "env": env,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "timeout": max(5, min(300, int(timeout or 120))),
        "check": False,
    }
    if platform.system() == "Windows":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.run(argv, **kwargs)
        return proc.returncode, (proc.stdout or "").strip()
    except FileNotFoundError:
        return 127, f"Команда не найдена: {argv[0]}"
    except subprocess.TimeoutExpired as err:
        partial = (err.stdout or "") if isinstance(err.stdout, str) else ""
        return 124, f"Таймаут ({timeout} с).\n{partial[:3000]}"


# ---------------------------------------------------------------------------
# 1. code_search
# ---------------------------------------------------------------------------

def run_code_search(
    args: Dict[str, Any],
    *,
    sandbox_root: Path,
    github_ctx: Optional[Dict[str, Any]],
) -> str:
    query = str(args.get("query") or "").strip()
    if not query:
        raise CodeToolError("Укажите непустой query для поиска")
    root, scope_label = _resolve_target_root(args, sandbox_root=sandbox_root, github_ctx=github_ctx)
    use_regex = bool(args.get("regex", True))
    case_sensitive = bool(args.get("case_sensitive", False))
    whole_word = bool(args.get("whole_word", False))
    context_lines = max(0, min(5, int(args.get("context_lines") or 0)))
    path_glob = str(args.get("path_glob") or args.get("glob") or "").strip()
    exclude_glob = str(args.get("exclude_glob") or "").strip()
    files_only = bool(args.get("files_only", False))
    count_only = bool(args.get("count_only", False))
    max_hits = max(1, min(150, int(args.get("max_hits") or 50)))
    subdir = str(args.get("path") or "").strip()

    flags = 0 if case_sensitive else re.IGNORECASE
    pattern_str = query if use_regex else re.escape(query)
    if whole_word:
        pattern_str = rf"\b(?:{pattern_str})\b"
    try:
        rx = re.compile(pattern_str, flags)
    except re.error:
        rx = re.compile(re.escape(query), flags)

    files = _iter_files(root, subdir=subdir, path_glob=path_glob, exclude_glob=exclude_glob)
    hits: List[str] = []
    matched_files: Dict[str, int] = {}
    scanned = 0
    total_matches = 0

    for fp in files:
        try:
            if fp.stat().st_size > 750_000:
                continue
            text = fp.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        scanned += 1
        rel = fp.relative_to(root.resolve()).as_posix()
        lines = text.splitlines()
        file_hits = 0
        for idx, line in enumerate(lines):
            if rx.search(line):
                file_hits += 1
                total_matches += 1
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
        if file_hits:
            matched_files[rel] = file_hits
        if not count_only and not files_only and len(hits) >= max_hits:
            break

    header = f"Поиск ({scope_label}) по «{query}»: совпадений={total_matches}, файлов={len(matched_files)}, просмотрено={scanned}"
    if count_only or files_only:
        summary_lines = [f"{path} ({cnt})" for path, cnt in list(matched_files.items())[:max_hits]]
        return header + "\n" + ("\n".join(summary_lines) if summary_lines else "(ничего не найдено)")
    return header + "\n" + ("\n".join(hits) if hits else "(ничего не найдено)")


# ---------------------------------------------------------------------------
# 2. code_read_files (batch read)
# ---------------------------------------------------------------------------

def run_code_read_files(
    args: Dict[str, Any],
    *,
    sandbox_root: Path,
    github_ctx: Optional[Dict[str, Any]],
) -> str:
    raw_items = args.get("files") or args.get("paths")
    if not isinstance(raw_items, list) or not raw_items:
        raise CodeToolError("Передайте непустой массив files (до 12 путей или объектов {path, offset, limit})")
    root, scope_label = _resolve_target_root(args, sandbox_root=sandbox_root, github_ctx=github_ctx)
    default_offset = max(1, int(args.get("offset") or 1))
    default_limit = max(1, min(400, int(args.get("limit") or 160)))
    total_char_budget = 60_000
    used_chars = 0
    sections: List[str] = [f"Пакетное чтение ({scope_label}):"]

    for item in raw_items[:12]:
        if isinstance(item, str):
            rel = item.strip()
            offset, limit = default_offset, default_limit
        elif isinstance(item, dict):
            rel = str(item.get("path") or "").strip()
            offset = max(1, int(item.get("offset") or default_offset))
            limit = max(1, min(400, int(item.get("limit") or default_limit)))
        else:
            continue
        if not rel:
            continue
        fp = _safe_file(root, rel)
        try:
            if not fp.is_file():
                sections.append(f"\n=== {rel} ===\n(файл не найден)")
                continue
            if fp.suffix.lower() in BINARY_EXTS:
                sections.append(f"\n=== {rel} ===\n(бинарный файл, {fp.stat().st_size} байт)")
                continue
            lines = fp.read_text(encoding="utf-8", errors="replace").splitlines()
            start = offset - 1
            sliced = lines[start : start + limit]
            numbered = [f"{start + i + 1}: {ln}" for i, ln in enumerate(sliced)]
            chunk = "\n".join(numbered)
            if used_chars + len(chunk) > total_char_budget:
                remaining = max(500, total_char_budget - used_chars)
                chunk = chunk[:remaining] + "\n... [обрезано по общему бюджету пакета]"
            used_chars += len(chunk)
            sections.append(
                f"\n=== {rel} (строки {offset}–{start + len(sliced)} из {len(lines)}) ===\n{chunk}"
            )
            if used_chars >= total_char_budget:
                break
        except OSError as err:
            sections.append(f"\n=== {rel} ===\n(ошибка чтения: {err})")

    return "\n".join(sections)


# ---------------------------------------------------------------------------
# 3. code_file_stats
# ---------------------------------------------------------------------------

def run_code_file_stats(
    args: Dict[str, Any],
    *,
    sandbox_root: Path,
    github_ctx: Optional[Dict[str, Any]],
) -> str:
    raw_paths = args.get("paths") or ([args.get("path")] if args.get("path") else [])
    if not isinstance(raw_paths, list) or not raw_paths:
        raise CodeToolError("Укажите path или массив paths")
    root, scope_label = _resolve_target_root(args, sandbox_root=sandbox_root, github_ctx=github_ctx)
    has_git = (root.resolve() / ".git").exists()
    out: List[str] = [f"Метаданные файлов ({scope_label}):"]

    for raw_p in raw_paths[:30]:
        rel = str(raw_p or "").strip()
        if not rel:
            continue
        try:
            fp = _safe_file(root, rel)
            if not fp.exists():
                out.append(f"- {rel}: не найден")
                continue
            if fp.is_dir():
                count = sum(1 for _ in _iter_files(root, subdir=rel, max_files=2000))
                out.append(f"- {rel}/: каталог (файлов до лимита: {count})")
                continue
            st = fp.stat()
            raw_bytes = fp.read_bytes()
            sha = hashlib.sha256(raw_bytes).hexdigest()[:12]
            is_bin = fp.suffix.lower() in BINARY_EXTS or b"\x00" in raw_bytes[:2048]
            lines_cnt = 0 if is_bin else len(raw_bytes.decode("utf-8", "replace").splitlines())
            lang = LANG_BY_EXT.get(fp.suffix.lower(), fp.suffix.lower() or "text")
            git_info = ""
            if has_git:
                code, g_out = _run_argv(
                    ["git", "log", "-1", "--format=%h %cs %an | %s", "--", fp.relative_to(root.resolve()).as_posix()],
                    cwd=root.resolve(),
                    sandbox_root=sandbox_root,
                    timeout=10,
                )
                if code == 0 and g_out:
                    git_info = f" | git: {g_out.splitlines()[0][:100]}"
            out.append(
                f"- {rel}: {st.st_size} байт, {lines_cnt} строк, {lang}, sha256={sha}{git_info}"
            )
        except CodeToolError as err:
            out.append(f"- {rel}: ошибка ({err})")

    return "\n".join(out)


# ---------------------------------------------------------------------------
# 4. code_symbols (AST для Python + структурный индекс TS/JS)
# ---------------------------------------------------------------------------

_TS_SYMBOL_PATTERNS: List[Tuple[str, re.Pattern[str]]] = [
    ("route", re.compile(r"^\s*export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b")),
    ("function", re.compile(r"^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)")),
    ("class", re.compile(r"^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)")),
    ("interface", re.compile(r"^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)")),
    ("type", re.compile(r"^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=")),
    ("enum", re.compile(r"^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)")),
    ("const", re.compile(r"^\s*export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=")),
]


def _extract_python_symbols(text: str, rel: str) -> List[str]:
    try:
        tree = ast.parse(text, filename=rel)
    except SyntaxError as err:
        return [f"  [SyntaxError line {err.lineno}]: {err.msg}"]
    items: List[str] = []

    def visit(node: ast.AST, prefix: str = "") -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.ClassDef):
                end_ln = getattr(child, "end_lineno", child.lineno)
                items.append(f"  L{child.lineno}-{end_ln} class {prefix}{child.name}")
                visit(child, prefix=f"{child.name}.")
            elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                kind = "async def" if isinstance(child, ast.AsyncFunctionDef) else "def"
                arg_names = [a.arg for a in child.args.args[:6]]
                sig = ", ".join(arg_names) + (", ..." if len(child.args.args) > 6 else "")
                end_ln = getattr(child, "end_lineno", child.lineno)
                items.append(f"  L{child.lineno}-{end_ln} {kind} {prefix}{child.name}({sig})")

    visit(tree)
    return items


def _extract_ts_symbols(text: str) -> List[str]:
    items: List[str] = []
    for idx, line in enumerate(text.splitlines(), start=1):
        for kind, rx in _TS_SYMBOL_PATTERNS:
            m = rx.match(line)
            if m:
                items.append(f"  L{idx} {kind} {m.group(1)}")
                break
    return items


def run_code_symbols(
    args: Dict[str, Any],
    *,
    sandbox_root: Path,
    github_ctx: Optional[Dict[str, Any]],
) -> str:
    rel_target = str(args.get("path") or ".").strip()
    kind_filter = str(args.get("kind") or "").strip().lower()
    name_filter = str(args.get("query") or "").strip().lower()
    max_items = max(10, min(300, int(args.get("max_items") or 120)))
    root, scope_label = _resolve_target_root(args, sandbox_root=sandbox_root, github_ctx=github_ctx)

    target = _safe_file(root, rel_target, allow_dir=True)
    files = [target] if target.is_file() else _iter_files(
        root,
        subdir="" if rel_target in ("", ".") else rel_target,
        max_files=300,
    )

    out: List[str] = [f"Символы кода ({scope_label}, путь={rel_target}):"]
    total = 0
    for fp in files:
        if fp.suffix.lower() not in (".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"):
            continue
        try:
            if fp.stat().st_size > 400_000:
                continue
            text = fp.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel = fp.relative_to(root.resolve()).as_posix()
        syms = _extract_python_symbols(text, rel) if fp.suffix.lower() == ".py" else _extract_ts_symbols(text)
        if kind_filter:
            syms = [s for s in syms if f" {kind_filter} " in s.lower()]
        if name_filter:
            syms = [s for s in syms if name_filter in s.lower()]
        if syms:
            out.append(f"\n[{rel}]")
            for sym in syms:
                out.append(sym)
                total += 1
                if total >= max_items:
                    out.append("... [достигнут лимит символов]")
                    return "\n".join(out)
    if total == 0:
        out.append("(символы не найдены)")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# 5. code_refs (определения, импорты и места вызова символа)
# ---------------------------------------------------------------------------

def run_code_refs(
    args: Dict[str, Any],
    *,
    sandbox_root: Path,
    github_ctx: Optional[Dict[str, Any]],
) -> str:
    symbol = str(args.get("symbol") or "").strip()
    if not symbol:
        raise CodeToolError("Укажите symbol (имя функции/класса/типа/переменной)")
    path_glob = str(args.get("path_glob") or "").strip()
    max_hits = max(10, min(150, int(args.get("max_hits") or 60)))
    root, scope_label = _resolve_target_root(args, sandbox_root=sandbox_root, github_ctx=github_ctx)

    word_rx = re.compile(rf"\b{re.escape(symbol)}\b")
    def_rx = re.compile(
        rf"\b(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|def|interface|type|enum|const|let|var)\s+{re.escape(symbol)}\b"
    )
    import_rx = re.compile(rf"(?:import|from\s+[\w./@_-]+\s+import)\b.*\b{re.escape(symbol)}\b")

    definitions: List[str] = []
    imports: List[str] = []
    usages: List[str] = []

    for fp in _iter_files(root, path_glob=path_glob):
        if fp.suffix.lower() not in (".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"):
            continue
        try:
            if fp.stat().st_size > 500_000:
                continue
            lines = fp.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        rel = fp.relative_to(root.resolve()).as_posix()
        for idx, ln in enumerate(lines, start=1):
            if not word_rx.search(ln):
                continue
            entry = f"{rel}:{idx}: {ln.strip()[:180]}"
            if def_rx.search(ln):
                definitions.append(entry)
            elif import_rx.search(ln):
                imports.append(entry)
            elif len(usages) < max_hits:
                usages.append(entry)

    out = [
        f"Ссылки и граф вызовов для «{symbol}» ({scope_label}):",
        f"\nОпределения ({len(definitions)}):",
        *(definitions[:25] or ["  (не найдены)"]),
        f"\nИмпорты ({len(imports)}):",
        *(imports[:25] or ["  (не найдены)"]),
        f"\nИспользования ({len(usages)}):",
        *(usages[:max_hits] or ["  (не найдены)"]),
    ]
    return "\n".join(out)


# ---------------------------------------------------------------------------
# 6. code_deps (граф импортов для файла)
# ---------------------------------------------------------------------------

_JS_IMPORT_RX = re.compile(
    r"""(?:import\s+[^;]*?\s+from\s+|import\s*\(|require\s*\(|export\s+[^;]*?\s+from\s+)["']([^"']+)["']"""
)


def _extract_file_imports(fp: Path, root_res: Path) -> List[str]:
    try:
        text = fp.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    deps: List[str] = []
    if fp.suffix.lower() == ".py":
        try:
            tree = ast.parse(text)
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        deps.append(alias.name)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    dots = "." * (node.level or 0)
                    deps.append(f"{dots}{node.module}")
        except SyntaxError:
            pass
    else:
        for m in _JS_IMPORT_RX.finditer(text):
            spec = m.group(1).strip()
            resolved_spec = spec
            if spec.startswith("@/"):
                cand = root_res / "src" / spec[2:]
                resolved_spec = _resolve_ts_candidate(cand, root_res) or spec
            elif spec.startswith("."):
                cand = (fp.parent / spec).resolve(strict=False)
                resolved_spec = _resolve_ts_candidate(cand, root_res) or spec
            deps.append(resolved_spec)
    return sorted(set(deps))


def _resolve_ts_candidate(cand: Path, root_res: Path) -> Optional[str]:
    for suffix in ("", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"):
        p = Path(str(cand) + suffix)
        if p.is_file():
            try:
                return p.resolve().relative_to(root_res).as_posix()
            except ValueError:
                return None
    return None


def run_code_deps(
    args: Dict[str, Any],
    *,
    sandbox_root: Path,
    github_ctx: Optional[Dict[str, Any]],
) -> str:
    rel_path = str(args.get("path") or "").strip()
    if not rel_path:
        raise CodeToolError("Укажите path файла для анализа зависимостей")
    root, scope_label = _resolve_target_root(args, sandbox_root=sandbox_root, github_ctx=github_ctx)
    root_res = root.resolve()
    target = _safe_file(root_res, rel_path)
    if not target.is_file():
        raise CodeToolError(f"Файл не найден: {rel_path}")
    target_rel = target.relative_to(root_res).as_posix()

    direct_imports = _extract_file_imports(target, root_res)
    imported_by: List[str] = []
    target_stem = target_rel.rsplit(".", 1)[0]
    target_name = target.stem

    for fp in _iter_files(root_res, max_files=1500):
        if fp == target or fp.suffix.lower() not in (".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"):
            continue
        deps = _extract_file_imports(fp, root_res)
        if target_rel in deps or target_stem in deps or (target.suffix == ".py" and any(d.endswith(target_name) for d in deps)):
            imported_by.append(fp.relative_to(root_res).as_posix())

    cycles = sorted(set(direct_imports) & set(imported_by))
    out = [
        f"Зависимости файла {target_rel} ({scope_label}):",
        f"\nИмпортирует ({len(direct_imports)}):",
        *(f"  -> {d}" for d in direct_imports[:80]),
        f"\nИспользуется в ({len(imported_by)}):",
        *(f"  <- {d}" for d in imported_by[:80]),
    ]
    if not direct_imports:
        out.insert(3, "  (нет)")
    if not imported_by:
        out.append("  (никем не импортируется в просканированных файлах)")
    if cycles:
        out.append(f"\nВозможные взаимные (циклические) импорты ({len(cycles)}): {', '.join(cycles)}")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# 7. git_history (changed_since / blame / log_search)
# ---------------------------------------------------------------------------

_SAFE_GIT_REF_RX = re.compile(r"^[A-Za-z0-9._/@~^{}-]{1,120}$")


def _validate_ref(raw: str) -> str:
    val = str(raw or "").strip()
    if not val or val.startswith("-") or not _SAFE_GIT_REF_RX.match(val):
        raise CodeToolError(f"Некорректная git-ссылка: {raw}")
    return val


def run_git_history(
    args: Dict[str, Any],
    *,
    sandbox_root: Path,
    github_ctx: Optional[Dict[str, Any]],
) -> str:
    mode = str(args.get("mode") or "changed_since").strip().lower()
    root, scope_label = _resolve_target_root(args, sandbox_root=sandbox_root, github_ctx=github_ctx)
    root_res = root.resolve()
    if not (root_res / ".git").exists():
        raise CodeToolError(f"Каталог {scope_label} не является git-репозиторием.")

    if mode == "changed_since":
        base = str(args.get("base") or "").strip()
        head = str(args.get("head") or "HEAD").strip() or "HEAD"
        since = str(args.get("since") or "").strip()
        if base:
            b_ref = _validate_ref(base)
            h_ref = _validate_ref(head)
            code, out = _run_argv(
                ["git", "diff", "--name-status", f"{b_ref}..{h_ref}"],
                cwd=root_res,
                sandbox_root=sandbox_root,
                timeout=20,
            )
            _, stat = _run_argv(
                ["git", "diff", "--stat", f"{b_ref}..{h_ref}"],
                cwd=root_res,
                sandbox_root=sandbox_root,
                timeout=20,
            )
            if code != 0:
                raise CodeToolError(out or "Ошибка git diff")
            return f"Изменения {b_ref}..{h_ref} ({scope_label}):\n{out or '(нет)'}\n\n{stat}".strip()
        if since:
            if not re.fullmatch(r"[A-Za-z0-9 .:_T+-]{1,64}", since) or since.startswith("-"):
                raise CodeToolError("Некорректный формат параметра since")
            code, out = _run_argv(
                ["git", "log", f"--since={since}", "--oneline", "--name-status", "-n", "40"],
                cwd=root_res,
                sandbox_root=sandbox_root,
                timeout=20,
            )
            if code != 0:
                raise CodeToolError(out or "Ошибка git log")
            return f"Коммиты начиная с «{since}» ({scope_label}):\n{out or '(нет коммитов)'}"
        # По умолчанию последние 5 коммитов
        code, out = _run_argv(
            ["git", "log", "-n", "8", "--oneline", "--stat"],
            cwd=root_res,
            sandbox_root=sandbox_root,
            timeout=20,
        )
        return f"Недавняя история ({scope_label}):\n{out or '(пусто)'}"

    if mode == "blame":
        rel = str(args.get("path") or "").strip()
        fp = _safe_file(root_res, rel)
        if not fp.is_file():
            raise CodeToolError(f"Файл не найден: {rel}")
        start_line = max(1, int(args.get("start_line") or 1))
        end_line = max(start_line, min(start_line + 120, int(args.get("end_line") or (start_line + 60))))
        rel_posix = fp.relative_to(root_res).as_posix()
        code, out = _run_argv(
            ["git", "blame", "-L", f"{start_line},{end_line}", "--date=short", "--", rel_posix],
            cwd=root_res,
            sandbox_root=sandbox_root,
            timeout=20,
        )
        if code != 0:
            raise CodeToolError(out or "Ошибка git blame")
        return f"git blame {rel_posix} ({start_line}..{end_line}):\n{out}"

    if mode == "log_search":
        query = str(args.get("query") or "").strip()
        grep_msg = str(args.get("grep") or "").strip()
        author = str(args.get("author") or "").strip()
        rel_path = str(args.get("path") or "").strip()
        max_commits = max(1, min(50, int(args.get("max_commits") or 20)))
        argv = ["git", "log", f"-n{max_commits}", "--date=short", "--format=%h %ad %an | %s"]
        if query:
            if query.startswith("-"):
                raise CodeToolError("query не может начинаться с '-'")
            argv.extend(["-S", query])
        if grep_msg:
            if grep_msg.startswith("-"):
                raise CodeToolError("grep не может начинаться с '-'")
            argv.extend(["--grep", grep_msg, "-i"])
        if author:
            if author.startswith("-"):
                raise CodeToolError("author не может начинаться с '-'")
            argv.extend(["--author", author])
        if rel_path:
            fp = _safe_file(root_res, rel_path, allow_dir=True)
            argv.extend(["--", fp.relative_to(root_res).as_posix()])
        code, out = _run_argv(argv, cwd=root_res, sandbox_root=sandbox_root, timeout=25)
        if code != 0:
            raise CodeToolError(out or "Ошибка git log")
        return f"Поиск по git log ({scope_label}):\n{out or '(совпадений не найдено)'}"

    raise CodeToolError(f"Неизвестный режим git_history: {mode}")


# ---------------------------------------------------------------------------
# 8. Точечные проверки: run_typecheck / run_lint_file / run_tests_subset
# ---------------------------------------------------------------------------

def _pick_tool_bin(root: Path, name: str) -> Optional[List[str]]:
    if platform.system() == "Windows":
        for ext in (".cmd", ".exe", ".bat", ""):
            local_bin = root / "node_modules" / ".bin" / f"{name}{ext}"
            if local_bin.is_file():
                return ["cmd", "/c", str(local_bin)] if ext in (".cmd", ".bat") else [str(local_bin)]
        npx = shutil.which("npx")
        if npx:
            if npx.lower().endswith((".cmd", ".bat")):
                return ["cmd", "/c", npx, "--no-install", name]
            return [npx, "--no-install", name]
        return None
    local_bin = root / "node_modules" / ".bin" / name
    if local_bin.is_file():
        return [str(local_bin)]
    npx = shutil.which("npx")
    if npx:
        return [npx, "--no-install", name]
    return None


def _pick_python_bin() -> Optional[List[str]]:
    if not getattr(sys, "frozen", False) and sys.executable and Path(sys.executable).is_file():
        return [sys.executable]
    py = shutil.which("python") or shutil.which("python3")
    return [py] if py else None


def run_typecheck_tool(
    args: Dict[str, Any],
    *,
    sandbox_root: Path,
    github_ctx: Optional[Dict[str, Any]],
) -> str:
    root, scope_label = _resolve_target_root(args, sandbox_root=sandbox_root, github_ctx=github_ctx)
    root_res = root.resolve()
    timeout = max(10, min(300, int(args.get("timeout") or 120)))
    outputs: List[str] = []

    if (root_res / "tsconfig.json").is_file():
        tsc = _pick_tool_bin(root_res, "tsc")
        if tsc:
            code, out = _run_argv([*tsc, "--noEmit", "--pretty", "false"], cwd=root_res, sandbox_root=sandbox_root, timeout=timeout)
            err_lines = [ln for ln in out.splitlines() if "error TS" in ln]
            outputs.append(
                f"[TypeScript tsc --noEmit] exit={code}, ошибок={len(err_lines)}\n"
                + ("\n".join(err_lines[:60]) if err_lines else (out[:3000] or "Ошибок типов нет."))
            )
        else:
            outputs.append("[TypeScript] tsc не установлен (нет node_modules/.bin/tsc)")

    py_files = _iter_files(root_res, path_glob="*.py", max_files=200)
    if py_files:
        mypy = shutil.which("mypy")
        if mypy:
            code, out = _run_argv([mypy, "--ignore-missing-imports", "."], cwd=root_res, sandbox_root=sandbox_root, timeout=timeout)
            outputs.append(f"[Python mypy] exit={code}\n{out[:3000]}")
        else:
            py_bin = _pick_python_bin()
            if py_bin:
                rel_list = [fp.relative_to(root_res).as_posix() for fp in py_files[:60]]
                code, out = _run_argv([*py_bin, "-m", "py_compile", *rel_list], cwd=root_res, sandbox_root=sandbox_root, timeout=60)
                outputs.append(f"[Python py_compile ({len(rel_list)} файлов)] exit={code}\n{out or 'Синтаксических ошибок нет.'}")
            else:
                outputs.append("[Python] интерпретатор python не найден в PATH")

    if not outputs:
        return f"В проекте ({scope_label}) не обнаружен tsconfig.json или Python-файлы для typecheck."
    return f"Проверка типов ({scope_label}):\n\n" + "\n\n".join(outputs)


def run_lint_file_tool(
    args: Dict[str, Any],
    *,
    sandbox_root: Path,
    github_ctx: Optional[Dict[str, Any]],
) -> str:
    raw_paths = args.get("paths") or ([args.get("path")] if args.get("path") else [])
    if not isinstance(raw_paths, list) or not raw_paths:
        raise CodeToolError("Укажите path или массив paths файлов для линтинга")
    root, scope_label = _resolve_target_root(args, sandbox_root=sandbox_root, github_ctx=github_ctx)
    root_res = root.resolve()

    js_targets: List[str] = []
    py_targets: List[str] = []
    for raw in raw_paths[:30]:
        fp = _safe_file(root_res, str(raw), allow_dir=True)
        if not fp.exists():
            continue
        rel = fp.relative_to(root_res).as_posix()
        if fp.suffix.lower() == ".py":
            py_targets.append(rel)
        elif fp.suffix.lower() in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs") or fp.is_dir():
            js_targets.append(rel)

    parts: List[str] = []
    if js_targets:
        eslint = _pick_tool_bin(root_res, "eslint")
        if eslint:
            code, out = _run_argv([*eslint, *js_targets], cwd=root_res, sandbox_root=sandbox_root, timeout=90)
            parts.append(f"[ESLint {' '.join(js_targets)}] exit={code}\n{out[:4000] or 'Замечаний нет.'}")
        else:
            parts.append("[ESLint] eslint не установлен в проекте")

    if py_targets:
        ruff = shutil.which("ruff")
        if ruff:
            code, out = _run_argv([ruff, "check", *py_targets], cwd=root_res, sandbox_root=sandbox_root, timeout=60)
            parts.append(f"[Ruff {' '.join(py_targets)}] exit={code}\n{out[:4000] or 'Замечаний нет.'}")
        else:
            py_bin = _pick_python_bin()
            if py_bin:
                code, out = _run_argv([*py_bin, "-m", "py_compile", *py_targets], cwd=root_res, sandbox_root=sandbox_root, timeout=30)
                parts.append(f"[py_compile {' '.join(py_targets)}] exit={code}\n{out or 'Синтаксис ок.'}")
            else:
                parts.append("[Python] интерпретатор python не найден в PATH")

    if not parts:
        return f"Не найдено подходящих JS/TS/Python файлов для линта в {scope_label}."
    return f"Точечный lint ({scope_label}):\n\n" + "\n\n".join(parts)


def run_tests_subset_tool(
    args: Dict[str, Any],
    *,
    sandbox_root: Path,
    github_ctx: Optional[Dict[str, Any]],
) -> str:
    raw_paths = args.get("paths") or ([args.get("path")] if args.get("path") else [])
    name_filter = str(args.get("filter") or "").strip()
    if name_filter.startswith("-"):
        raise CodeToolError("Фильтр тестов не может начинаться с '-'")
    runner = str(args.get("runner") or "auto").strip().lower()
    timeout = max(10, min(300, int(args.get("timeout") or 120)))
    root, scope_label = _resolve_target_root(args, sandbox_root=sandbox_root, github_ctx=github_ctx)
    root_res = root.resolve()

    safe_rels: List[str] = []
    for p in (raw_paths if isinstance(raw_paths, list) else [])[:20]:
        s = str(p or "").strip()
        if not s:
            continue
        fp = _safe_file(root_res, s, allow_dir=True)
        if fp.exists():
            safe_rels.append(fp.relative_to(root_res).as_posix())

    if runner == "auto":
        if any(p.endswith(".py") for p in safe_rels) or (not safe_rels and not (root_res / "package.json").is_file()):
            runner = "python"
        else:
            runner = "vitest"

    if runner in ("vitest", "node"):
        vitest = _pick_tool_bin(root_res, "vitest")
        if vitest:
            argv = [*vitest, "run", *safe_rels]
            if name_filter:
                argv.extend(["-t", name_filter])
            code, out = _run_argv(argv, cwd=root_res, sandbox_root=sandbox_root, timeout=timeout)
            return f"[Vitest ({scope_label})] exit={code}\n{out[-6000:]}"
        npm = shutil.which("npm")
        if npm and (root_res / "package.json").is_file():
            npm_cmd = ["cmd", "/c", npm] if (platform.system() == "Windows" and npm.lower().endswith((".cmd", ".bat"))) else [npm]
            code, out = _run_argv([*npm_cmd, "test", "--", *safe_rels], cwd=root_res, sandbox_root=sandbox_root, timeout=timeout)
            return f"[npm test ({scope_label})] exit={code}\n{out[-6000:]}"
        raise CodeToolError("Не найден vitest/npm для запуска JS/TS-тестов")

    if runner in ("pytest", "unittest", "python"):
        pytest_bin = shutil.which("pytest") if runner != "unittest" else None
        if pytest_bin:
            argv = [pytest_bin, "-q", *safe_rels]
            if name_filter:
                argv.extend(["-k", name_filter])
            code, out = _run_argv(argv, cwd=root_res, sandbox_root=sandbox_root, timeout=timeout)
            return f"[Pytest ({scope_label})] exit={code}\n{out[-6000:]}"
        py_bin = _pick_python_bin()
        if not py_bin:
            raise CodeToolError("Интерпретатор python не найден для запуска тестов")
        if safe_rels:
            argv = [*py_bin, "-m", "unittest", *safe_rels]
        else:
            test_dir = "agent/tests" if (root_res / "agent" / "tests").is_dir() else "."
            argv = [*py_bin, "-m", "unittest", "discover", "-s", test_dir, "-v"]
        code, out = _run_argv(argv, cwd=root_res, sandbox_root=sandbox_root, timeout=timeout)
        return f"[Python unittest ({scope_label})] exit={code}\n{out[-6000:]}"

    raise CodeToolError(f"Неподдерживаемый runner: {runner}")


# ---------------------------------------------------------------------------
# 9. security_scan (secret_leak_scan + sast_scan)
# ---------------------------------------------------------------------------

SECRET_PATTERNS: List[Tuple[str, re.Pattern[str]]] = [
    ("Private Key PEM", re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----")),
    ("GitHub Token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}\b")),
    ("AWS Access Key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("OpenAI / Anthropic Key", re.compile(r"\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b")),
    ("Slack Token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{16,}\b")),
    ("Hardcoded Secret Assignment", re.compile(
        r"""(?:secret|api_?key|jwt_?secret|private_?key|db_?password)\s*[:=]\s*["']([A-Za-z0-9+/=._-]{16,})["']""",
        re.IGNORECASE,
    )),
]

SAST_PATTERNS: List[Tuple[str, str, re.Pattern[str], Tuple[str, ...]]] = [
    ("critical", "eval / new Function", re.compile(r"\b(?:eval|Function)\s*\("), (".ts", ".tsx", ".js", ".jsx", ".mjs", ".py")),
    ("high", "child_process.exec (риск shell-инъекции)", re.compile(r"\bchild_process\.(?:exec|execSync)\s*\(|\bexecSync\s*\("), (".ts", ".tsx", ".js", ".jsx", ".mjs")),
    ("high", "subprocess с shell=True", re.compile(r"\bsubprocess\.(?:run|Popen|call)\([^)]*shell\s*=\s*True"), (".py",)),
    ("high", "sql.raw() (проверить параметризацию)", re.compile(r"\bsql\.raw\s*\("), (".ts", ".tsx", ".js", ".mjs")),
    ("high", "pickle.loads / yaml.load без SafeLoader", re.compile(r"\bpickle\.loads\s*\(|\byaml\.load\s*\([^)]*\)"), (".py",)),
    ("medium", "DOM XSS (innerHTML/outerHTML/dangerouslySetInnerHTML)", re.compile(r"\.(?:innerHTML|outerHTML)\s*=|\bdangerouslySetInnerHTML\b|document\.write\s*\("), (".ts", ".tsx", ".js", ".jsx", ".html")),
    ("medium", "Отключена проверка TLS", re.compile(r"rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*[\"']0[\"']|verify\s*=\s*False"), (".ts", ".tsx", ".js", ".py")),
]


def scan_security_findings(
    root: Path,
    *,
    subdir: str = "",
    include_tests: bool = False,
) -> Dict[str, Any]:
    root_res = root.resolve()
    secrets: List[Dict[str, Any]] = []
    sast: List[Dict[str, Any]] = []
    files_scanned = 0

    for fp in _iter_files(root_res, subdir=subdir, max_files=2000):
        rel = fp.relative_to(root_res).as_posix()
        is_test = bool(re.search(r"(?:^|/)(?:tests?|__tests__|fixtures?)/|\.(?:test|spec)\.", rel, re.IGNORECASE))
        if is_test and not include_tests:
            continue
        if fp.suffix.lower() not in (".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".html", ".json", ".yml", ".yaml", ".env", ".sql", ".sh"):
            continue
        try:
            if fp.stat().st_size > 400_000:
                continue
            lines = fp.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        files_scanned += 1
        for idx, line in enumerate(lines, start=1):
            stripped = line.strip()
            if not stripped or stripped.startswith("//") or stripped.startswith("#"):
                continue
            for label, rx in SECRET_PATTERNS:
                m = rx.search(line)
                if m:
                    val = m.group(1) if m.lastindex else m.group(0)
                    low = val.lower()
                    if any(w in low for w in ("example", "placeholder", "dummy", "your-", "changeme", "xxxx")):
                        continue
                    secrets.append({
                        "kind": label,
                        "file": rel,
                        "line": idx,
                        "snippet": stripped[:140],
                    })
                    break
            ext = fp.suffix.lower()
            for sev, label, rx, exts in SAST_PATTERNS:
                if ext not in exts:
                    continue
                if rx.search(line):
                    if label == "eval / new Function" and "re.compile" in line:
                        continue
                    sast.append({
                        "severity": sev,
                        "kind": label,
                        "file": rel,
                        "line": idx,
                        "snippet": stripped[:160],
                    })

    return {
        "filesScanned": files_scanned,
        "secrets": secrets[:60],
        "sast": sast[:100],
    }


def run_security_scan_tool(
    args: Dict[str, Any],
    *,
    sandbox_root: Path,
    github_ctx: Optional[Dict[str, Any]],
) -> str:
    root, scope_label = _resolve_target_root(args, sandbox_root=sandbox_root, github_ctx=github_ctx)
    subdir = str(args.get("path") or "").strip()
    include_tests = bool(args.get("include_tests", False))
    res = scan_security_findings(root, subdir=subdir, include_tests=include_tests)
    lines = [
        f"Security & Secret Scan ({scope_label}), проверено файлов: {res['filesScanned']}",
        f"\nУтечки секретов / ключей ({len(res['secrets'])}):",
        *(
            [f"  - [{s['kind']}] {s['file']}:{s['line']} — {s['snippet']}" for s in res["secrets"]]
            or ["  (подозрительных секретов не найдено)"]
        ),
        f"\nSAST-предупреждения ({len(res['sast'])}):",
        *(
            [f"  - [{s['severity']}] {s['kind']} @ {s['file']}:{s['line']} — {s['snippet']}" for s in res["sast"]]
            or ["  (опасных паттернов не найдено)"]
        ),
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 10. schema_inspect (Drizzle / SQL migrations & SQLite vs Postgres diff)
# ---------------------------------------------------------------------------

def inspect_schema_and_migrations(root: Path) -> Dict[str, Any]:
    root_res = root.resolve()
    schema_tables: Dict[str, List[str]] = {}
    migration_tables: Dict[str, set[str]] = {}
    migration_files: List[str] = []
    warnings: List[str] = []

    schema_ts = root_res / "src" / "db" / "schema.ts"
    if schema_ts.is_file():
        text = schema_ts.read_text(encoding="utf-8", errors="replace")
        for m in re.finditer(r"""export\s+const\s+\w+\s*=\s*(?:sqliteTable|pgTable)\s*\(\s*["']([^"']+)["']\s*,\s*\{([\s\S]*?)\}\s*(?:,|\))""", text):
            t_name = m.group(1)
            body = m.group(2)
            cols = re.findall(r"""^\s*([A-Za-z_]\w*)\s*:\s*\w+\s*\(\s*["']([^"']+)["']""", body, flags=re.MULTILINE)
            schema_tables[t_name] = [db_col for _ts_col, db_col in cols]

    drizzle_dir = root_res / "drizzle"
    if drizzle_dir.is_dir():
        for sql_file in sorted(drizzle_dir.glob("*.sql")):
            migration_files.append(sql_file.name)
            raw = sql_file.read_text(encoding="utf-8", errors="replace")
            for cm in re.finditer(r"create\s+table(?:\s+if\s+not\s+exists)?\s+[`\"']?([A-Za-z_]\w*)[`\"']?\s*\(([\s\S]*?)\)\s*;", raw, flags=re.IGNORECASE):
                t_name = cm.group(1)
                cols = migration_tables.setdefault(t_name, set())
                for line in cm.group(2).splitlines():
                    ln = line.strip().lstrip(",")
                    if not ln or ln.lower().startswith(("primary key", "foreign key", "unique", "constraint", "check", "--")):
                        continue
                    col_m = re.match(r"^[`\"']?([A-Za-z_]\w*)[`\"']?\s+[A-Za-z]+", ln)
                    if col_m:
                        cols.add(col_m.group(1))
            for am in re.finditer(r"alter\s+table\s+[`\"']?([A-Za-z_]\w*)[`\"']?\s+add\s+(?:column\s+)?[`\"']?([A-Za-z_]\w*)[`\"']?", raw, flags=re.IGNORECASE):
                migration_tables.setdefault(am.group(1), set()).add(am.group(2))
            if "autoincrement" in raw.lower() and "serial" not in raw.lower() and "dialect" not in raw.lower():
                # Проверка что в проекте есть разделение диалектов, если файл общий
                pass

    if schema_tables and migration_tables:
        for t_name, cols in schema_tables.items():
            if t_name not in migration_tables:
                warnings.append(f"Таблица «{t_name}» есть в src/db/schema.ts, но отсутствует в drizzle/*.sql")
            else:
                missing_cols = [c for c in cols if c not in migration_tables[t_name]]
                if missing_cols:
                    warnings.append(f"В таблице «{t_name}» колонки {missing_cols} не найдены в drizzle/*.sql")
        for m_name in migration_tables:
            if m_name not in schema_tables:
                warnings.append(f"Таблица «{m_name}» создана в миграциях, но не описана в src/db/schema.ts")

    return {
        "schemaTables": schema_tables,
        "migrationFiles": migration_files,
        "migrationTables": {k: sorted(v) for k, v in migration_tables.items()},
        "warnings": warnings,
    }


def run_schema_inspect_tool(
    args: Dict[str, Any],
    *,
    sandbox_root: Path,
    github_ctx: Optional[Dict[str, Any]],
) -> str:
    root, scope_label = _resolve_target_root(args, sandbox_root=sandbox_root, github_ctx=github_ctx)
    info = inspect_schema_and_migrations(root)
    lines = [
        f"Схема БД и миграции ({scope_label}):",
        f"Файлы миграций ({len(info['migrationFiles'])}): {', '.join(info['migrationFiles']) or 'нет'}",
        f"Таблиц в schema.ts: {len(info['schemaTables'])}, в миграциях: {len(info['migrationTables'])}",
    ]
    if info["schemaTables"]:
        lines.append("\nТаблицы schema.ts:")
        for t_name, cols in info["schemaTables"].items():
            lines.append(f"  - {t_name} ({len(cols)}): {', '.join(cols[:20])}{'...' if len(cols) > 20 else ''}")
    if info["warnings"]:
        lines.append("\nРасхождения / предупреждения:")
        lines.extend(f"  ! {w}" for w in info["warnings"])
    else:
        lines.append("\nРасхождений между schema.ts и drizzle/*.sql не обнаружено.")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 11. endpoint_inventory (API & Auth Matrix)
# ---------------------------------------------------------------------------

def collect_endpoint_inventory(root: Path) -> List[Dict[str, Any]]:
    root_res = root.resolve()
    entries: List[Dict[str, Any]] = []
    api_dir = root_res / "src" / "app" / "api"
    search_root = api_dir if api_dir.is_dir() else root_res

    for fp in sorted(search_root.rglob("route.*")):
        if fp.suffix.lower() not in (".ts", ".tsx", ".js", ".mjs"):
            continue
        rel = fp.relative_to(root_res).as_posix()
        try:
            text = fp.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        methods = re.findall(r"export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b", text)
        if not methods:
            continue
        route_path = "/" + rel.replace("src/app/", "").rsplit("/route.", 1)[0]
        has_auth = bool(re.search(r"\b(?:getCurrentUser|findSessionUser|findAgentTokenOwner|requireAuth|getSession)\b", text))
        has_role = bool(re.search(r"\b(?:isAdminRole|isSuperAdminRole|canManage\w+|canConfigure\w+|canChangeRoles|hasAgentAccess|hasOperatorAccess|me\.role|user\.role)\b", text))
        has_rl = "checkApiRateLimit" in text or "checkLoginRateLimit" in text
        has_val = bool(re.search(r"\b(?:safeParse|readJsonWithByteLimit|Schema|z\.)\b", text))
        flags: List[str] = []
        is_public_known = any(p in route_path for p in ("/api/health", "/api/launcher/login", "/api/launcher/logout", "/api/auth/", "/api/agent/bot/"))
        if not has_auth and not is_public_known:
            flags.append("NO_AUTH")
        if any(m in ("POST", "PUT", "PATCH", "DELETE") for m in methods) and not has_rl:
            flags.append("NO_RATE_LIMIT")
        if any(k in route_path for k in ("/team", "/bots", "/admin", "/settings")) and any(m in ("POST", "PUT", "PATCH", "DELETE") for m in methods) and not has_role and "/ai/settings" not in route_path:
            flags.append("CHECK_ROLE")
        entries.append({
            "route": route_path,
            "file": rel,
            "methods": methods,
            "auth": has_auth,
            "roleCheck": has_role,
            "rateLimit": has_rl,
            "validation": has_val,
            "flags": flags,
        })
    return entries


def run_endpoint_inventory_tool(
    args: Dict[str, Any],
    *,
    sandbox_root: Path,
    github_ctx: Optional[Dict[str, Any]],
) -> str:
    root, scope_label = _resolve_target_root(args, sandbox_root=sandbox_root, github_ctx=github_ctx)
    only_flagged = bool(args.get("only_flagged", False))
    items = collect_endpoint_inventory(root)
    if only_flagged:
        items = [it for it in items if it["flags"]]
    lines = [f"Инвентаризация API-эндпоинтов ({scope_label}, всего={len(items)}):"]
    if not items:
        lines.append("(маршруты src/app/api/**/route.ts не найдены или нет замечаний)")
        return "\n".join(lines)
    for it in items[:120]:
        fl = f" [! {', '.join(it['flags'])}]" if it["flags"] else ""
        lines.append(
            f"- {','.join(it['methods'])} {it['route']} | auth={it['auth']} role={it['roleCheck']} "
            f"rl={it['rateLimit']} val={it['validation']}{fl}"
        )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 12. agent_plan (план шагов + audit_ledger проверенных фактов в сессии)
# ---------------------------------------------------------------------------

def run_agent_plan_tool(args: Dict[str, Any], run_state: Optional[Dict[str, Any]]) -> str:
    state = run_state if isinstance(run_state, dict) else {}
    plan: List[Dict[str, Any]] = state.setdefault("plan", [])
    ledger: List[Dict[str, Any]] = state.setdefault("ledger", [])
    action = str(args.get("action") or "get").strip().lower()

    if action == "set_plan":
        raw_steps = args.get("steps") or []
        plan.clear()
        for idx, st in enumerate(raw_steps[:30], start=1):
            if isinstance(st, str):
                plan.append({"id": idx, "title": st.strip(), "status": "pending", "note": ""})
            elif isinstance(st, dict):
                plan.append({
                    "id": idx,
                    "title": str(st.get("title") or f"Шаг {idx}").strip(),
                    "status": str(st.get("status") or "pending").strip(),
                    "note": str(st.get("note") or "").strip(),
                })
    elif action == "update_step":
        step_id = int(args.get("step_id") or 0)
        status = str(args.get("status") or "done").strip()
        note = str(args.get("note") or "").strip()
        for item in plan:
            if item["id"] == step_id:
                item["status"] = status
                if note:
                    item["note"] = note
                break
    elif action == "record_finding":
        ledger.append({
            "id": len(ledger) + 1,
            "severity": str(args.get("severity") or "info").strip(),
            "file": str(args.get("file") or "").strip(),
            "line": int(args.get("line") or 0),
            "summary": str(args.get("summary") or "").strip(),
            "verified": bool(args.get("verified", True)),
        })

    out = ["Текущий план и реестр проверенных фактов:"]
    out.append(f"Шаги ({len(plan)}):")
    for st in plan:
        note_s = f" — {st['note']}" if st.get("note") else ""
        out.append(f"  {st['id']}. [{st['status']}] {st['title']}{note_s}")
    if not plan:
        out.append("  (план пока не задан)")
    out.append(f"\nРеестр фактов/находок ({len(ledger)}):")
    for f in ledger[-30:]:
        loc = f"{f['file']}:{f['line']}" if f["file"] else "общий"
        out.append(f"  #{f['id']} [{f['severity']}] ({loc}, verified={f['verified']}): {f['summary']}")
    if not ledger:
        out.append("  (записей пока нет)")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Объявления инструментов для LLM
# ---------------------------------------------------------------------------

_TARGET_PROP = {
    "type": "string",
    "enum": ["auto", "sandbox", "github"],
    "description": "Где искать/проверять: auto (Sandbox при sandbox_project или GitHub-клон), sandbox или github",
}
_SANDBOX_PROP = {
    "type": "string",
    "description": "Папка проекта внутри Sandbox (если проверяется Sandbox-проект)",
}

CODE_READ_TOOLS: List[Dict[str, Any]] = [
    _fn(
        "code_search",
        "Универсальный поиск по коду (Sandbox или GitHub-клон): поддержка regex, case_sensitive, whole_word, context_lines, path_glob, exclude_glob, files_only/count_only.",
        {
            "query": {"type": "string", "description": "Строка или регулярное выражение"},
            "target": _TARGET_PROP,
            "sandbox_project": _SANDBOX_PROP,
            "path": {"type": "string", "description": "Подпапка поиска"},
            "path_glob": {"type": "string", "description": "Фильтр файлов, напр. '*.ts' или 'src/app/api/*'"},
            "exclude_glob": {"type": "string", "description": "Исключить файлы по шаблону"},
            "regex": {"type": "boolean", "description": "Трактовать query как regex (по умолчанию true)"},
            "case_sensitive": {"type": "boolean", "description": "Учитывать регистр (по умолчанию false)"},
            "whole_word": {"type": "boolean", "description": "Только целые слова"},
            "context_lines": {"type": "integer", "description": "Сколько строк контекста до/после (0–5)"},
            "files_only": {"type": "boolean", "description": "Вернуть только список файлов и число совпадений"},
            "count_only": {"type": "boolean", "description": "Вернуть только счётчик по файлам"},
            "max_hits": {"type": "integer", "description": "Лимит совпадений (по умолчанию 50)"},
        },
        ["query"],
    ),
    _fn(
        "code_read_files",
        "Прочитать сразу до 12 файлов за один вызов (экономит шаги при аудите). Можно передавать строки путей или объекты {path, offset, limit}.",
        {
            "files": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Список относительных путей файлов (до 12 шт.)",
            },
            "offset": {"type": "integer", "description": "Начальная строка (по умолчанию 1)"},
            "limit": {"type": "integer", "description": "Строк на файл (по умолчанию 160)"},
            "target": _TARGET_PROP,
            "sandbox_project": _SANDBOX_PROP,
        },
        ["files"],
    ),
    _fn(
        "code_file_stats",
        "Быстрые метаданные файлов без чтения контента: размер, число строк, язык, SHA-256 и последний коммит git.",
        {
            "paths": {"type": "array", "items": {"type": "string"}, "description": "Список путей"},
            "path": {"type": "string", "description": "Один путь (если без paths)"},
            "target": _TARGET_PROP,
            "sandbox_project": _SANDBOX_PROP,
        },
    ),
    _fn(
        "code_symbols",
        "Карта символов файла или папки (классы, функции, методы, export type/interface/const, HTTP route handlers) через AST/парсер.",
        {
            "path": {"type": "string", "description": "Файл или папка (по умолчанию '.')"},
            "kind": {"type": "string", "description": "Фильтр типа: route, function, class, interface, type, const"},
            "query": {"type": "string", "description": "Фильтр по части имени символа"},
            "max_items": {"type": "integer", "description": "Максимум символов (по умолчанию 120)"},
            "target": _TARGET_PROP,
            "sandbox_project": _SANDBOX_PROP,
        },
    ),
    _fn(
        "code_refs",
        "Поиск всех определений, импортов и использований (call graph / references) заданного символа по проекту.",
        {
            "symbol": {"type": "string", "description": "Точное имя функции, класса, типа или переменной"},
            "path_glob": {"type": "string", "description": "Фильтр файлов"},
            "max_hits": {"type": "integer", "description": "Максимум использований (по умолчанию 60)"},
            "target": _TARGET_PROP,
            "sandbox_project": _SANDBOX_PROP,
        },
        ["symbol"],
    ),
    _fn(
        "code_deps",
        "Прямые и обратные зависимости (импорты, кто импортирует и взаимные циклы) для заданного файла.",
        {
            "path": {"type": "string", "description": "Относительный путь файла"},
            "target": _TARGET_PROP,
            "sandbox_project": _SANDBOX_PROP,
        },
        ["path"],
    ),
    _fn(
        "git_history",
        "История git в репозитории: changed_since (diff между base..head или с даты), blame (кто менял строки файла), log_search (поиск по коду -S и коммитам).",
        {
            "mode": {"type": "string", "enum": ["changed_since", "blame", "log_search"]},
            "base": {"type": "string", "description": "Базовый ref для changed_since (напр. HEAD~5 или origin/main)"},
            "head": {"type": "string", "description": "Целевой ref (по умолчанию HEAD)"},
            "since": {"type": "string", "description": "Период для log (напр. '3 days ago')"},
            "path": {"type": "string", "description": "Путь файла (обязателен для blame, опционален для log_search)"},
            "start_line": {"type": "integer", "description": "Начальная строка для blame"},
            "end_line": {"type": "integer", "description": "Конечная строка для blame"},
            "query": {"type": "string", "description": "Строка изменения кода (git log -S) для log_search"},
            "grep": {"type": "string", "description": "Текст в сообщении коммита"},
            "author": {"type": "string", "description": "Фильтр по автору"},
            "max_commits": {"type": "integer", "description": "Максимум коммитов"},
            "target": _TARGET_PROP,
            "sandbox_project": _SANDBOX_PROP,
        },
        ["mode"],
    ),
    _fn(
        "security_scan",
        "SAST + Secret Leak Scanner: ищет захардкоженные секреты/токены/ключи и небезопасные паттерны (eval, exec, shell=True, sql.raw, innerHTML, отключение TLS).",
        {
            "path": {"type": "string", "description": "Подпапка для сканирования (по умолчанию весь проект)"},
            "include_tests": {"type": "boolean", "description": "Включать ли папки tests/ (по умолчанию false)"},
            "target": _TARGET_PROP,
            "sandbox_project": _SANDBOX_PROP,
        },
    ),
    _fn(
        "schema_inspect",
        "Инспекция и сравнение схемы БД (src/db/schema.ts) и миграций (drizzle/*.sql), поиск расхождений таблиц/колонок.",
        {
            "target": _TARGET_PROP,
            "sandbox_project": _SANDBOX_PROP,
        },
    ),
    _fn(
        "endpoint_inventory",
        "Инвентаризация всех API-эндпоинтов (src/app/api/**/route.ts): методы, auth, проверка ролей, rateLimit, Zod-валидация и флаги рисков.",
        {
            "only_flagged": {"type": "boolean", "description": "Показать только маршруты с предупреждениями"},
            "target": _TARGET_PROP,
            "sandbox_project": _SANDBOX_PROP,
        },
    ),
    _fn(
        "agent_plan",
        "Структурированный план работы и реестр проверенных фактов (audit ledger) в рамках текущей сессии.",
        {
            "action": {"type": "string", "enum": ["get", "set_plan", "update_step", "record_finding"]},
            "steps": {"type": "array", "items": {"type": "string"}, "description": "Список шагов плана для set_plan"},
            "step_id": {"type": "integer", "description": "Номер шага (с 1) для update_step"},
            "status": {"type": "string", "description": "Статус шага: pending | in_progress | done | skipped"},
            "note": {"type": "string", "description": "Заметка к шагу"},
            "severity": {"type": "string", "description": "Критичность находки (P0/P1/P2/info) для record_finding"},
            "file": {"type": "string", "description": "Файл находки"},
            "line": {"type": "integer", "description": "Строка"},
            "summary": {"type": "string", "description": "Суть проверенного факта"},
            "verified": {"type": "boolean", "description": "Факт проверен в коде/тестах"},
        },
        ["action"],
    ),
]

CODE_EXEC_TOOLS: List[Dict[str, Any]] = [
    _fn(
        "run_typecheck",
        "Быстрый безопасный запуск typecheck (tsc --noEmit и/или mypy/py_compile) без произвольных shell-команд.",
        {
            "target": _TARGET_PROP,
            "sandbox_project": _SANDBOX_PROP,
            "timeout": {"type": "integer", "description": "Таймаут в секундах (по умолчанию 120)"},
        },
    ),
    _fn(
        "run_lint_file",
        "Точечный запуск ESLint/Ruff только для указанных файлов.",
        {
            "paths": {"type": "array", "items": {"type": "string"}, "description": "Список путей файлов"},
            "path": {"type": "string", "description": "Один путь файла"},
            "target": _TARGET_PROP,
            "sandbox_project": _SANDBOX_PROP,
        },
    ),
    _fn(
        "run_tests_subset",
        "Точечный запуск конкретного набора unit-тестов (Vitest или Pytest/unittest) по путям файлов и фильтру имени.",
        {
            "paths": {"type": "array", "items": {"type": "string"}, "description": "Тест-файлы или директории"},
            "path": {"type": "string", "description": "Один тест-файл"},
            "filter": {"type": "string", "description": "Фильтр имён тестов (-t для vitest / -k для pytest)"},
            "runner": {"type": "string", "enum": ["auto", "vitest", "pytest", "unittest", "python"]},
            "timeout": {"type": "integer", "description": "Таймаут в секундах (по умолчанию 120)"},
            "target": _TARGET_PROP,
            "sandbox_project": _SANDBOX_PROP,
        },
    ),
]

CODE_READ_TOOL_NAMES = {t["function"]["name"] for t in CODE_READ_TOOLS}
CODE_EXEC_TOOL_NAMES = {t["function"]["name"] for t in CODE_EXEC_TOOLS}
ALL_CODE_TOOL_NAMES = CODE_READ_TOOL_NAMES | CODE_EXEC_TOOL_NAMES


def run_code_tool(
    name: str,
    args: Dict[str, Any],
    *,
    sandbox_root: Path,
    github_ctx: Optional[Dict[str, Any]] = None,
    trust_level: str = "verified",
    run_state: Optional[Dict[str, Any]] = None,
) -> Tuple[str, List[Dict[str, Any]]]:
    args = args or {}
    events: List[Dict[str, Any]] = []
    if name in CODE_EXEC_TOOL_NAMES and trust_level == "none":
        raise CodeToolError("При уровне доверия «Нет доступа» запуск проверок/тестов отключён; используйте инструменты чтения.")

    dispatch: Dict[str, Any] = {
        "code_search": lambda: run_code_search(args, sandbox_root=sandbox_root, github_ctx=github_ctx),
        "code_read_files": lambda: run_code_read_files(args, sandbox_root=sandbox_root, github_ctx=github_ctx),
        "code_file_stats": lambda: run_code_file_stats(args, sandbox_root=sandbox_root, github_ctx=github_ctx),
        "code_symbols": lambda: run_code_symbols(args, sandbox_root=sandbox_root, github_ctx=github_ctx),
        "code_refs": lambda: run_code_refs(args, sandbox_root=sandbox_root, github_ctx=github_ctx),
        "code_deps": lambda: run_code_deps(args, sandbox_root=sandbox_root, github_ctx=github_ctx),
        "git_history": lambda: run_git_history(args, sandbox_root=sandbox_root, github_ctx=github_ctx),
        "security_scan": lambda: run_security_scan_tool(args, sandbox_root=sandbox_root, github_ctx=github_ctx),
        "schema_inspect": lambda: run_schema_inspect_tool(args, sandbox_root=sandbox_root, github_ctx=github_ctx),
        "endpoint_inventory": lambda: run_endpoint_inventory_tool(args, sandbox_root=sandbox_root, github_ctx=github_ctx),
        "agent_plan": lambda: run_agent_plan_tool(args, run_state),
        "run_typecheck": lambda: run_typecheck_tool(args, sandbox_root=sandbox_root, github_ctx=github_ctx),
        "run_lint_file": lambda: run_lint_file_tool(args, sandbox_root=sandbox_root, github_ctx=github_ctx),
        "run_tests_subset": lambda: run_tests_subset_tool(args, sandbox_root=sandbox_root, github_ctx=github_ctx),
    }
    fn = dispatch.get(name)
    if fn is None:
        raise CodeToolError(f"Неизвестный инструмент анализа кода: {name}")
    return str(fn()), events
