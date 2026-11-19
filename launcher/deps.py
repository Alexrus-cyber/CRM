# -*- coding: utf-8 -*-
"""Зависимости агентов: проверка и (необязательная) офлайн-установка.

Главный сценарий — всё уже внутри exe: нужные пакеты (Pillow, pyautogui,
pyperclip) замораживаются при сборке. Но если exe собрали без них или
пользователь запускает приложение из исходников, модуль честно скажет, чего не
хватает, и попробует доставить пакеты из папки `wheels/` рядом с exe
(`pip install --no-index --find-links`), не обращаясь в интернет.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

# Что нужно конкретному агенту. Проверяем именно импортируемые имена.
AGENT_DEPENDENCIES: Dict[str, Tuple[Tuple[str, str], ...]] = {
    "operator": (
        ("pyautogui", "pyautogui"),
        ("PIL", "Pillow"),
        ("pyperclip", "pyperclip"),
    ),
}

# Пакеты, которые имеет смысл класть в wheels/ для офлайн-доустановки.
OFFLINE_PACKAGES: Dict[str, str] = {"pyautogui": "pyautogui", "PIL": "Pillow", "pyperclip": "pyperclip"}


@dataclass(frozen=True)
class Dependency:
    module: str
    package: str
    present: bool


def check(agent_id: str) -> List[Dependency]:
    result: List[Dependency] = []
    for module, package in AGENT_DEPENDENCIES.get(agent_id, ()):
        result.append(Dependency(module=module, package=package, present=_present(module)))
    return result


def _present(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError, AttributeError):
        return False


def missing(agent_id: str) -> List[Dependency]:
    return [item for item in check(agent_id) if not item.present]


def report(agent_id: str) -> List[str]:
    items = check(agent_id)
    if not items:
        return [f"{agent_id}: внешних зависимостей нет — только стандартная библиотека."]
    lines = []
    for item in items:
        lines.append(f"{item.package}: {'есть' if item.present else 'НЕТ'}")
    return lines


def install_offline(agent_id: str, wheels: Path, python_exe: str | None = None) -> Tuple[bool, str]:
    """Доставить пакеты из локальной папки wheels (интернет не нужен)."""
    packages: Sequence[str] = [
        OFFLINE_PACKAGES.get(item.package, item.package) for item in missing(agent_id)
    ]
    if not packages:
        return True, "Все зависимости уже на месте."
    if not wheels.is_dir() or not any(wheels.glob("*.whl")):
        return False, f"Папка с колёсами пуста: {wheels}. Пересоберите exe с зависимостями."
    exe = python_exe or sys.executable
    command = [exe, "-m", "pip", "install", "--no-index", "--find-links", str(wheels), *packages]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.SubprocessError) as error:
        return False, f"Не удалось запустить pip: {error}"
    if completed.returncode != 0:
        tail = (completed.stderr or completed.stdout or "").strip().splitlines()[-3:]
        return False, "pip не смог поставить пакеты: " + (" / ".join(tail) or "нет вывода")
    return True, "Поставлено из локальной папки: " + ", ".join(packages)


def interpreter_hint() -> str:
    return (
        "Зависимости замораживаются в exe при сборке: "
        "`pip install -r launcher/requirements.txt && python launcher/build_exe.py`."
    )
