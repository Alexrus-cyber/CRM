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
from pathlib import Path
from typing import List


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


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
