# -*- coding: utf-8 -*-
"""Где лежат файлы в исходниках и внутри собранного exe.

В исходниках агенты — это папка `agent/` репозитория. В exe (PyInstaller) они
распакованы в `sys._MEIPASS/agents`. Приложение запускает агента тем же
исполняемым файлом: `CRM Agents.exe --run-agent agents/desktop_operator.py …`,
поэтому Python на машине пользователя не нужен.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Mapping, Tuple


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def is_onefile() -> bool:
    """Однофайловая сборка: runtime распакован во временную папку `_MEIxxxx`."""
    if not is_frozen():
        return False
    meipass = getattr(sys, "_MEIPASS", "")
    if not meipass:
        return False
    try:
        return Path(meipass).resolve().parent != Path(sys.executable).resolve().parent
    except OSError:
        return True


def bundle_root() -> Path:
    """Папка, где лежат вложенные данные (agents/, wheels/)."""
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def agents_dir() -> Path:
    """Папка со скриптами агентов: в exe — `agents/`, в исходниках — `agent/`."""
    root = bundle_root()
    for candidate in (root / "agents", root / "agent"):
        if candidate.is_dir():
            return candidate
    return root / "agents"


def wheels_dir() -> Path:
    return bundle_root() / "wheels"


def assets_dir() -> Path:
    return bundle_root() / "assets"


def launcher_prefix() -> List[str]:
    """Как запустить наш же «интерпретатор» для агента."""
    if is_frozen():
        return [sys.executable]
    return [sys.executable, str(Path(__file__).resolve().parent / "cli.py")]


def run_agent_args(script: Path, args: List[str]) -> List[str]:
    return [*launcher_prefix(), "--run-agent", str(script), *args]


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


# --------------------------------------------------------------------------
# среда запуска агента
# --------------------------------------------------------------------------

def runtime_temp_dir() -> Path:
    """Своя папка для временных файлов: TEMP пользователя может быть недоступен."""
    from launcher import settings as settings_mod

    return settings_mod.config_dir() / "tmp"


def prepare_temp_dir() -> Tuple[Path, str]:
    """Готовит временную папку и проверяет, что в неё можно писать.

    Возвращает (папка, пустая строка при успехе | текст ошибки).
    """
    candidate = runtime_temp_dir()
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        probe = candidate / "write-probe.tmp"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return candidate, ""
    except OSError as error:
        try:
            fallback = Path(tempfile.gettempdir())
            fallback.mkdir(parents=True, exist_ok=True)
            return fallback, f"своя папка недоступна ({error}), использую {fallback}"
        except OSError as inner:
            return candidate, f"нет доступа ни к {candidate}, ни к {fallback}: {inner}"


SAFE_CHILD_ENV_KEYS = (
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TERM",
    "COLORTERM",
    "SHELL",
    "USER",
    "LOGNAME",
    "USERNAME",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
)


def child_env(extra: Mapping[str, str] | None = None, reuse_runtime: bool = True) -> Dict[str, str]:
    """Окружение дочернего процесса агента (строго по allowlist, без утечки секретов хоста)."""
    env: Dict[str, str] = {}
    for key in SAFE_CHILD_ENV_KEYS:
        val = os.environ.get(key)
        if val is not None:
            env[key] = val
    env.update({
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        "PYTHONUNBUFFERED": "1",
    })
    for key, value in (extra or {}).items():
        if value is None:
            continue
        env[str(key)] = str(value)

    temp_dir, _problem = prepare_temp_dir()
    for key in ("TMP", "TEMP", "TMPDIR"):
        env[key] = str(temp_dir)

    meipass = getattr(sys, "_MEIPASS", "")
    if reuse_runtime and is_onefile() and meipass and Path(meipass).is_dir():
        env.setdefault("_PYI_APPLICATION_HOME_DIR", meipass)
        env.setdefault("_PYI_PARENT_PROCESS_LEVEL", "1")
        env.setdefault("_PYI_ARCHIVE_FILE", sys.executable)
    return env


def runtime_info() -> Dict[str, str]:
    """Сводка о среде запуска — для «Проверить окружение» и диагностики."""
    temp_dir, problem = prepare_temp_dir()
    meipass = str(getattr(sys, "_MEIPASS", ""))
    return {
        "режим": "исходники" if not is_frozen() else ("onefile" if is_onefile() else "onedir"),
        "исполняемый файл": sys.executable,
        "_MEIPASS": meipass or "—",
        "_MEIPASS существует": "да" if meipass and Path(meipass).is_dir() else "нет",
        "временная папка агента": str(temp_dir),
        "запись во временную папку": "ок" if not problem else problem,
        "TEMP системы": os.environ.get("TEMP") or os.environ.get("TMP") or "—",
        "_PYI_APPLICATION_HOME_DIR": os.environ.get("_PYI_APPLICATION_HOME_DIR", "—"),
        "_PYI_PARENT_PROCESS_LEVEL": os.environ.get("_PYI_PARENT_PROCESS_LEVEL", "—"),
    }


def open_folder(path: Path) -> None:
    """Открыть папку в системном файловом менеджере (без сторонних библиотек)."""
    import subprocess

    ensure_dir(path)
    if sys.platform.startswith("win"):
        os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])
