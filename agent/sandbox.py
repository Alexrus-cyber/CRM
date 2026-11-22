#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Изолированная песочница (Sandbox) для ИИ-агента и десктопного оператора.

Модель не может выйти за пределы корня Sandbox при создании проектов,
записи/чтении файлов, создании папок или запуске bash-команд в проекте:
  * любые `..`, абсолютные пути, UNC-пути, диски Windows (`C:\\`) и симлинки,
    ведущие наружу, блокируются до выполнения;
  * дочерние процессы получают очищенное окружение без API-ключей и токенов CRM
    (`HOME`, `TMPDIR`, `TEMP` направлены внутрь Sandbox);
  * статическая проверка команд отсекает очевидные попытки побега и
    деструктивные системные команды;
  * перенос файлов из Sandbox наружу в папку пользователя выполняется только
    после явного согласия человека через `export_path`.
"""

from __future__ import annotations

import atexit
import io
import os
import platform
import re
import shutil
import signal
import subprocess
import threading
import time
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


DEFAULT_SANDBOX_DIR = Path(__file__).resolve().parent / "sandbox"

# Переменные окружения, которые безопасно оставить дочерним процессам в Sandbox
# (секреты вроде AGENT_API_KEY, OPENAI_API_KEY, CRM_AGENT_TOKEN сюда не попадают).
SAFE_ENV_KEYS = (
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "COMSPEC",
    "WINDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES",
    "ProgramData",
    "SystemDrive",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "SHELL",
    "USERPROFILE",
    "NODE_ENV",
    "PYTHONIOENCODING",
    "PYTHONUTF8",
)

# Очевидные попытки побега из Sandbox или разрушения системы.
ESCAPE_PATTERNS = [
    re.compile(r"(?:^|[\s;|&`(])rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+/(?:\s|$|\*)", re.IGNORECASE),
    re.compile(r"(?:^|[\s;|&`(])(?:mkfs|fdisk|parted|shutdown|reboot|halt|poweroff)\b", re.IGNORECASE),
    re.compile(r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:"),  # fork bomb
    re.compile(
        r"(?:/etc/(?:shadow|sudoers|passwd)|~/\.(?:ssh|aws|gnupg|kube)|/(?:root|home/[^/\s]+)/\.(?:ssh|aws|gnupg)|/proc/self/environ|/var/run/docker\.sock)",
        re.IGNORECASE,
    ),
    re.compile(r"[A-Za-z]:\\Windows\\System32", re.IGNORECASE),
    re.compile(r"(?:^|[\s;|&`(])cd\s+/(?:\s|$|;|&&)", re.IGNORECASE),
    re.compile(r"(?:^|[\s;|&`(])dd\s+if=.*\s+of=/dev/", re.IGNORECASE),
    re.compile(r"(?:curl|wget)\s+[^\n|]*\|\s*(?:ba)?sh\b", re.IGNORECASE),
    re.compile(r"(?:^|[\s;|&`(])(?:sudo|su\s+-|chmod\s+[ugo]*\+s|chown\s+root)\b", re.IGNORECASE),
    re.compile(r"(?:/dev/tcp/|nc(?:at)?\s+[^\n]*-e\s+)", re.IGNORECASE),
]

FORBIDDEN_EXPORT_PREFIXES = (
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/boot",
    "/proc",
    "/sys",
    "/dev",
    "/System",
    "C:\\Windows",
    "C:\\Program Files",
)

FORBIDDEN_EXPORT_HOME_DIRS = {".ssh", ".gnupg", ".aws", ".kube", ".docker", ".git"}

MAX_OUTPUT_CHARS = 18_000
MAX_SANDBOX_FILE_BYTES = 2_000_000
MAX_LIST_ITEMS = 500
TREE_SKIP_DIRS = frozenset({
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
    "coverage",
})


class SandboxError(RuntimeError):
    """Ошибка нарушения границ песочницы или выполнения внутри неё."""


def get_sandbox_root(raw: Optional[str] = None) -> Path:
    base = Path(raw or os.environ.get("AGENT_SANDBOX_DIR") or DEFAULT_SANDBOX_DIR).expanduser()
    resolved = base.resolve(strict=False)
    resolved.mkdir(parents=True, exist_ok=True)
    (resolved / ".tmp").mkdir(parents=True, exist_ok=True)
    return resolved


def _is_within_root(root: Path, candidate: Path) -> bool:
    try:
        return os.path.commonpath([str(root), str(candidate)]) == str(root)
    except ValueError:
        return False


def _is_safe_non_escaping_entry(root_resolved: Path, entry: Path) -> bool:
    """Отсекает симлинки и любые записи, выходящие за границы корня Sandbox."""
    if entry.is_symlink():
        target = entry.resolve(strict=False)
        if not _is_within_root(root_resolved, target):
            return False
    return _is_within_root(root_resolved, entry.resolve(strict=False))


def safe_resolve(root: Path, rel_path: str = ".", *, allow_root: bool = False) -> Path:
    """Преобразует относительный путь в путь строго внутри `root`.

    Отвергает:
      - пустой путь (если `allow_root=False`);
      - нулевые байты, абсолютные пути (`/…`, `\\…`), буквы дисков (`C:…`);
      - сегменты `..`, ведущие наружу;
      - любые существующие симлинки, указывающие за пределы `root`.
    """
    root_resolved = root.resolve(strict=False)
    raw = str(rel_path if rel_path is not None else ".").strip()
    if not raw or raw == ".":
        if allow_root:
            return root_resolved
        raise SandboxError("Путь внутри Sandbox не может быть пустым")

    if "\x00" in raw:
        raise SandboxError("Недопустимый символ в пути")

    normalized = raw.replace("\\", "/")
    if normalized.startswith("/") or normalized.startswith("~"):
        raise SandboxError(f"Запрещён выход за пределы Sandbox (абсолютный путь): {raw}")
    if re.match(r"^[A-Za-z]:", normalized):
        raise SandboxError(f"Запрещён выход за пределы Sandbox (диск): {raw}")

    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    if not parts:
        if allow_root:
            return root_resolved
        raise SandboxError("Укажите путь файла или папки внутри Sandbox")

    current = root_resolved
    for part in parts:
        if part == "..":
            raise SandboxError(f"Запрещён переход «..» за пределы Sandbox: {raw}")
        if any(ch in part for ch in '<>:"|?*'):
            raise SandboxError(f"Недопустимые символы в имени «{part}»")
        current = current / part
        if current.is_symlink():
            target = current.resolve(strict=False)
            if not _is_within_root(root_resolved, target):
                raise SandboxError(f"Запрещена символьная ссылка за пределы Sandbox: {raw}")

    final = current.resolve(strict=False)
    if not _is_within_root(root_resolved, final):
        raise SandboxError(f"Путь выходит за границы Sandbox: {raw}")
    if final == root_resolved and not allow_root:
        raise SandboxError("Нельзя перезаписать корень Sandbox")
    return final


def relative_to_root(root: Path, target: Path) -> str:
    return target.resolve(strict=False).relative_to(root.resolve(strict=False)).as_posix()


def write_file(root: Path, rel_path: str, content: str, *, unlimited: bool = False) -> Dict[str, Any]:
    target = safe_resolve(root, rel_path, allow_root=False)
    data = (content or "").encode("utf-8")
    if not unlimited and len(data) > MAX_SANDBOX_FILE_BYTES:
        raise SandboxError(f"Файл «{rel_path}» превышает лимит {MAX_SANDBOX_FILE_BYTES // 1000} КБ")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return {
        "path": relative_to_root(root, target),
        "size": len(data),
    }


def mkdir(root: Path, rel_path: str) -> Dict[str, Any]:
    target = safe_resolve(root, rel_path, allow_root=False)
    target.mkdir(parents=True, exist_ok=True)
    return {"path": relative_to_root(root, target)}


def read_file(root: Path, rel_path: str, limit: int = 30_000, *, unlimited: bool = False) -> str:
    target = safe_resolve(root, rel_path, allow_root=False)
    if not target.is_file():
        raise SandboxError(f"Файл не найден в Sandbox: {rel_path}")
    text = target.read_text(encoding="utf-8", errors="replace")
    return text if (unlimited or limit <= 0) else text[:limit]


def delete_path(root: Path, rel_path: str) -> bool:
    target = safe_resolve(root, rel_path, allow_root=False)
    if not target.exists():
        return False
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    return True


def list_tree(root: Path, rel_path: str = ".", *, unlimited: bool = False) -> Dict[str, Any]:
    root_resolved = root.resolve(strict=False)
    base = safe_resolve(root_resolved, rel_path, allow_root=True)
    if not base.exists():
        return {"root": str(root_resolved), "items": [], "projects": [], "totalItems": 0, "truncated": False}

    base_rel_parts = set(relative_to_root(root_resolved, base).split("/")) if base != root_resolved else set()
    skip_heavy = not bool(base_rel_parts & TREE_SKIP_DIRS)

    def _walk_entries(start_dir: Path, max_collect: Optional[int] = None) -> Tuple[List[Path], bool]:
        collected: List[Path] = []
        hit_limit = False
        for current, dirs, files in os.walk(start_dir, followlinks=False):
            cur_path = Path(current)
            filtered_dirs: List[str] = []
            for d in sorted(dirs, key=str.lower):
                if d.startswith(".tmp") or (base == root_resolved and not unlimited and cur_path == root_resolved and d == "_github"):
                    continue
                cand = cur_path / d
                if not _is_safe_non_escaping_entry(root_resolved, cand):
                    continue
                if skip_heavy and d in TREE_SKIP_DIRS:
                    collected.append(cand)
                    continue
                filtered_dirs.append(d)
            dirs[:] = filtered_dirs
            for name in sorted(filtered_dirs + files, key=str.lower):
                if name.startswith(".tmp"):
                    continue
                entry = cur_path / name
                if entry in collected:
                    continue
                if _is_safe_non_escaping_entry(root_resolved, entry):
                    collected.append(entry)
                    if max_collect is not None and len(collected) >= max_collect:
                        hit_limit = True
                        break
            if hit_limit:
                break
        collected.sort(key=lambda p: str(p).lower())
        return collected, hit_limit

    items: List[Dict[str, Any]] = []
    projects: List[Dict[str, Any]] = []

    if base == root_resolved:
        for child in sorted(root_resolved.iterdir(), key=lambda p: p.name.lower()):
            if child.name.startswith(".") or child.name == "_github":
                continue
            if child.is_dir():
                file_count = 0
                for _, dnames, fnames in os.walk(child, followlinks=False):
                    dnames[:] = [d for d in dnames if not d.startswith(".tmp") and d not in TREE_SKIP_DIRS]
                    file_count += len(fnames)
                    if not unlimited and file_count >= 2000:
                        break
                projects.append({"name": child.name, "files": file_count})

    if base.is_file():
        entries, walk_truncated = [base], False
    else:
        entries, walk_truncated = _walk_entries(base, max_collect=None if unlimited else (MAX_LIST_ITEMS + 1))

    total_items = 0
    truncated = walk_truncated
    for entry in entries:
        rel = relative_to_root(root_resolved, entry)
        if rel.startswith(".tmp"):
            continue
        total_items += 1
        if not unlimited and len(items) >= MAX_LIST_ITEMS:
            truncated = True
            continue
        try:
            st_size = entry.stat().st_size if entry.is_file() else 0
        except OSError:
            st_size = 0
        items.append({
            "path": rel,
            "type": "dir" if entry.is_dir() else "file",
            "size": st_size,
        })

    return {
        "root": str(root_resolved),
        "items": items,
        "projects": projects,
        "totalItems": total_items,
        "truncated": truncated,
    }


def zip_path(root: Path, rel_path: str) -> Tuple[bytes, str]:
    root_resolved = root.resolve(strict=False)
    target = safe_resolve(root_resolved, rel_path, allow_root=True)
    if not target.exists():
        raise SandboxError(f"Не найдено в Sandbox: {rel_path}")
    buffer = io.BytesIO()
    if target.is_file():
        return target.read_bytes(), target.name
    root_name = target.name if target != root_resolved else "sandbox"
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in sorted(target.rglob("*")):
            if file_path.is_symlink():
                raise SandboxError(f"Запрещена архивация символьной ссылки: {file_path.name}")
            if not _is_safe_non_escaping_entry(root_resolved, file_path):
                raise SandboxError("Обнаружен выход пути за пределы Sandbox")
            if file_path.is_file():
                rel = file_path.relative_to(target).as_posix()
                if rel.startswith(".tmp"):
                    continue
                archive.write(file_path, arcname=f"{root_name}/{rel}")
    return buffer.getvalue(), f"{root_name}.zip"


def export_path(
    root: Path,
    source_rel: str,
    dest_raw: str,
    mode: str = "copy",
) -> Dict[str, Any]:
    """Копирует или переносит файл/папку из Sandbox в указанный пользователем путь."""
    src = safe_resolve(root, source_rel, allow_root=False)
    if not src.exists():
        raise SandboxError(f"Источник не найден в Sandbox: {source_rel}")

    raw_dest = str(dest_raw or "").strip()
    if not raw_dest:
        raise SandboxError("Не указана папка назначения на компьютере")

    dest = Path(raw_dest).expanduser().resolve(strict=False)
    # Запрещаем перенос в корень диска, системные каталоги или в родителя Sandbox целиком.
    if dest == dest.parent or str(dest) in ("/", "\\"):
        raise SandboxError("Нельзя переносить файлы в корень файловой системы")

    dest_str = str(dest)
    for prefix in FORBIDDEN_EXPORT_PREFIXES:
        norm_pref = prefix.rstrip("/\\")
        if dest_str.lower() == norm_pref.lower() or dest_str.lower().startswith((norm_pref + os.sep).lower()):
            raise SandboxError(f"Запрещён экспорт в системную папку: {dest}")
    if any(part in FORBIDDEN_EXPORT_HOME_DIRS for part in dest.parts):
        raise SandboxError(f"Запрещён экспорт в защищённый каталог учётных данных: {dest}")

    root_resolved = root.resolve(strict=False)
    if _is_within_root(dest, root_resolved) and dest != root_resolved:
        raise SandboxError("Папка назначения не может содержать сам Sandbox")

    # Если назначение — существующая папка и переносим файл, кладём внутрь под тем же именем;
    # если переносим папку и dest не заканчивается именем проекта, можно положить внутрь или в dest.
    target = dest / src.name if (src.is_file() and dest.is_dir()) else dest
    copied_files: List[str] = []
    total_bytes = 0

    if src.is_dir():
        target.mkdir(parents=True, exist_ok=True)
        for item in src.rglob("*"):
            if item.is_symlink():
                raise SandboxError(f"Запрещён экспорт символьной ссылки: {item.name}")
            if not _is_safe_non_escaping_entry(root_resolved, item):
                raise SandboxError("Обнаружен выход пути за пределы Sandbox")
            if item.is_file():
                rel = item.relative_to(src)
                if str(rel).startswith(".tmp"):
                    continue
                out_file = target / rel
                out_file.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(item, out_file, follow_symlinks=False)
                copied_files.append(rel.as_posix())
                total_bytes += item.stat().st_size
        if mode == "move":
            shutil.rmtree(src)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target, follow_symlinks=False)
        copied_files.append(src.name)
        total_bytes = target.stat().st_size
        if mode == "move":
            src.unlink()

    return {
        "source": relative_to_root(root, src) if src.exists() else source_rel,
        "destination": str(target),
        "mode": "move" if mode == "move" else "copy",
        "filesCount": len(copied_files),
        "bytes": total_bytes,
        "files": copied_files[:100],
    }


def inspect_command_escape(command: str, root: Path, rel_cwd: str = ".") -> Optional[str]:
    """Возвращает причину блокировки, если команда пытается сбежать из Sandbox."""
    text = (command or "").strip()
    if not text:
        return "Пустая команда"
    for pattern in ESCAPE_PATTERNS:
        if pattern.search(text):
            return "Команда заблокирована защитой Sandbox (попытка доступа к системным путям или выхода за пределы песочницы)"
    # Считаем глубину рабочей папки внутри Sandbox: больше `depth` шагов `../` — выход наружу.
    clean_cwd = "/".join(p for p in str(rel_cwd or ".").replace("\\", "/").split("/") if p not in ("", "."))
    depth = len(clean_cwd.split("/")) if clean_cwd else 0
    for match in re.finditer(r"((?:\.\./|\.\.\\)+)", text):
        ups = match.group(1).count("..")
        if ups > depth:
            return "Команда заблокирована защитой Sandbox (попытка выйти через .. выше корня песочницы)"
    return None


def sanitized_env(root: Path, cwd: Path) -> Dict[str, str]:
    root_resolved = root.resolve(strict=False)
    tmp_dir = root_resolved / ".tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    env: Dict[str, str] = {}
    for key in SAFE_ENV_KEYS:
        if key in os.environ:
            env[key] = os.environ[key]
    env["HOME"] = str(root_resolved)
    env["TMPDIR"] = str(tmp_dir)
    env["TEMP"] = str(tmp_dir)
    env["TMP"] = str(tmp_dir)
    env["PWD"] = str(cwd)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["NO_PROXY"] = "127.0.0.1,localhost,::1"
    env["no_proxy"] = "127.0.0.1,localhost,::1"
    env["CRM_SANDBOX"] = "1"
    env["CRM_SANDBOX_ROOT"] = str(root_resolved)
    return env


def _shell_argv(command: str) -> List[str]:
    if platform.system() == "Windows":
        return ["cmd", "/c", command]
    bash = shutil.which("bash")
    if bash:
        return [bash, "-lc", command]
    return ["/bin/sh", "-c", command]


def _terminate_proc_tree(proc: subprocess.Popen[Any]) -> None:
    try:
        if platform.system() != "Windows":
            pgid = os.getpgid(proc.pid)
            os.killpg(pgid, signal.SIGTERM)
            proc.wait(timeout=3)
        else:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                timeout=4,
                check=False,
            )
    except Exception:  # noqa: BLE001
        try:
            if platform.system() != "Windows":
                pgid = os.getpgid(proc.pid)
                os.killpg(pgid, signal.SIGKILL)
            else:
                proc.kill()
        except Exception:  # noqa: BLE001
            pass


def run_subprocess_with_tree_timeout(
    argv: List[str],
    *,
    cwd: Path,
    env: Optional[Dict[str, str]] = None,
    timeout: int = 60,
) -> Tuple[int, str, bool]:
    """Запускает argv в отдельной группе процессов и при таймауте убивает всё дерево процессов."""
    run_kwargs: Dict[str, Any] = {
        "cwd": str(cwd),
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
    }
    if env is not None:
        run_kwargs["env"] = env
    if platform.system() != "Windows":
        run_kwargs["start_new_session"] = True
    else:
        run_kwargs["creationflags"] = (
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )

    proc = subprocess.Popen(argv, **run_kwargs)
    try:
        stdout_text, _ = proc.communicate(timeout=max(1, int(timeout)))
        return int(proc.returncode or 0), (stdout_text or "").strip(), False
    except subprocess.TimeoutExpired:
        _terminate_proc_tree(proc)
        try:
            stdout_text, _ = proc.communicate(timeout=2)
        except Exception:  # noqa: BLE001
            stdout_text = ""
        try:
            if proc.stdout:
                proc.stdout.close()
        except OSError:
            pass
        return 124, (stdout_text or "").strip(), True


class ProcessManager:
    """Управляет фоновыми процессами (локальными серверами проектов) внутри Sandbox."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._procs: Dict[int, Dict[str, Any]] = {}
        atexit.register(self.stop_all)

    def _terminate_proc(self, proc: subprocess.Popen[str]) -> None:
        _terminate_proc_tree(proc)

    def stop(self, pid: int) -> bool:
        with self._lock:
            info = self._procs.pop(pid, None)
        if not info:
            return False
        self._terminate_proc(info["proc"])
        return True

    def stop_all(self) -> None:
        with self._lock:
            entries = list(self._procs.values())
            self._procs.clear()
        for info in entries:
            self._terminate_proc(info["proc"])

    def start(self, root: Path, command: str, rel_cwd: str = ".") -> Dict[str, Any]:
        issue = inspect_command_escape(command, root, rel_cwd)
        if issue:
            raise SandboxError(issue)
        cwd = safe_resolve(root, rel_cwd, allow_root=True)
        cwd.mkdir(parents=True, exist_ok=True)
        env = sanitized_env(root, cwd)

        kwargs: Dict[str, Any] = {
            "cwd": str(cwd),
            "env": env,
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.STDOUT,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
        }
        if platform.system() != "Windows":
            kwargs["start_new_session"] = True
        else:
            kwargs["creationflags"] = (
                getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                | getattr(subprocess, "CREATE_NO_WINDOW", 0)
            )

        proc = subprocess.Popen(_shell_argv(command), **kwargs)
        lines: List[str] = []

        def reader() -> None:
            if not proc.stdout:
                return
            for line in proc.stdout:
                with self._lock:
                    lines.append(line.rstrip("\r\n"))
                    if len(lines) > 120:
                        del lines[: len(lines) - 120]

        thread = threading.Thread(target=reader, daemon=True)
        thread.start()

        # Ждём до 2.6 с: ловим мгновенный краш или URL поднявшегося сервера (выходим сразу как URL обнаружен).
        deadline = time.monotonic() + 2.6
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                break
            with self._lock:
                cur_out = "\n".join(lines).strip()
            if _detect_local_url("", cur_out):
                break
            time.sleep(0.15)

        with self._lock:
            output = "\n".join(lines).strip()[:MAX_OUTPUT_CHARS]
        url = _detect_local_url(command, output)

        if proc.poll() is not None:
            return {
                "background": False,
                "exitCode": proc.returncode,
                "cwd": relative_to_root(root, cwd) if cwd != root.resolve(strict=False) else ".",
                "output": output or f"Процесс завершился с кодом {proc.returncode}",
                "url": url,
            }

        entry = {
            "pid": proc.pid,
            "proc": proc,
            "command": command[:300],
            "cwd": relative_to_root(root, cwd) if cwd != root.resolve(strict=False) else ".",
            "url": url,
            "lines": lines,
            "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        with self._lock:
            self._procs[proc.pid] = entry

        return {
            "background": True,
            "pid": proc.pid,
            "cwd": entry["cwd"],
            "output": output or f"Фоновый процесс запущен (PID {proc.pid})",
            "url": url,
        }

    def list(self) -> List[Dict[str, Any]]:
        with self._lock:
            dead = [pid for pid, info in self._procs.items() if info["proc"].poll() is not None]
            for pid in dead:
                self._procs.pop(pid, None)
            return [
                {
                    "pid": pid,
                    "command": info["command"],
                    "cwd": info["cwd"],
                    "url": info["url"],
                    "startedAt": info["startedAt"],
                }
                for pid, info in self._procs.items()
            ]


def _detect_local_url(command: str, output: str) -> str:
    match = re.search(r"https?://(?:127\.0\.0\.1|localhost|0\.0\.0\.0):(\d{2,5})", output or "")
    if match:
        return f"http://127.0.0.1:{match.group(1)}"
    # Подсказка из команды: `http.server 8123` или `--port 5173` или `PORT=3001`.
    port_match = re.search(
        r"(?:http\.server\s+|--port[=\s]+|-p\s+|PORT=)(\d{2,5})",
        command or "",
    )
    if port_match:
        return f"http://127.0.0.1:{port_match.group(1)}"
    return ""


def run_command(
    root: Path,
    command: str,
    rel_cwd: str = ".",
    timeout: int = 60,
    background: bool = False,
    process_manager: Optional[ProcessManager] = None,
    *,
    unlimited: bool = False,
) -> Dict[str, Any]:
    """Выполнить bash/shell-команду строго внутри песочницы `root`."""
    if background:
        mgr = process_manager or ProcessManager()
        return mgr.start(root, command, rel_cwd)

    issue = inspect_command_escape(command, root, rel_cwd)
    if issue:
        raise SandboxError(issue)

    cwd = safe_resolve(root, rel_cwd, allow_root=True)
    cwd.mkdir(parents=True, exist_ok=True)
    env = sanitized_env(root, cwd)
    raw_timeout = int(timeout or 60)
    safe_timeout = max(1, raw_timeout if unlimited else min(300, raw_timeout))

    try:
        exit_code, raw_output, timed_out = run_subprocess_with_tree_timeout(
            _shell_argv(command),
            cwd=cwd,
            env=env,
            timeout=safe_timeout,
        )
    except FileNotFoundError as error:
        raise SandboxError(f"Команда оболочки не найдена: {error}") from error

    if timed_out:
        raise SandboxError(
            f"Команда превысила таймаут {safe_timeout} с. Если это сервер — запустите с background=true.\n{raw_output[:2000]}"
        )

    output = raw_output if unlimited else raw_output[:MAX_OUTPUT_CHARS]
    return {
        "background": False,
        "exitCode": exit_code,
        "cwd": relative_to_root(root, cwd) if cwd != root.resolve(strict=False) else ".",
        "output": output or f"(вывод пуст, код возврата {exit_code})",
        "url": _detect_local_url(command, output),
    }


def run_pc_command(command: str, timeout: int = 60, *, unlimited: bool = False) -> Dict[str, Any]:
    """Команда на ПК пользователя (вызывается только при полном доверии или явном разрешении на сайте)."""
    text = (command or "").strip()
    if not text:
        raise SandboxError("Пустая команда")
    raw_timeout = int(timeout or 60)
    safe_timeout = max(1, raw_timeout if unlimited else min(180, raw_timeout))
    try:
        exit_code, raw_output, timed_out = run_subprocess_with_tree_timeout(
            _shell_argv(text),
            cwd=Path.home(),
            env=None,
            timeout=safe_timeout,
        )
    except FileNotFoundError as error:
        raise SandboxError(f"Команда оболочки не найдена: {error}") from error
    if timed_out:
        raise SandboxError(f"Команда на ПК превысила таймаут {safe_timeout} с.\n{raw_output[:2000]}")
    output = raw_output if unlimited else raw_output[:MAX_OUTPUT_CHARS]
    return {
        "exitCode": exit_code,
        "output": output or f"(вывод пуст, код возврата {exit_code})",
    }
