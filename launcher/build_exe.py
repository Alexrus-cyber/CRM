# -*- coding: utf-8 -*-
"""Сборка одного exe: ставит зависимости и запускает PyInstaller.

    python launcher/build_exe.py                # Windows → dist/CRM Agents.exe
    python launcher/build_exe.py --no-install    # зависимости уже стоят
    python launcher/build_exe.py --wheels        # ещё и офлайн-колёса в сборку

Сборка делается на той ОС, для которой нужен exe: PyInstaller не кросс-компилирует.
Запускать из корня репозитория.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
SPEC = ROOT / "launcher.spec"
REQUIREMENTS = ROOT / "requirements.txt"


def run(command: list[str]) -> None:
    print("+", " ".join(command))
    subprocess.run(command, check=True, cwd=REPO)


def build_parser() -> argparse.ArgumentParser:
    """Флаги сборки (вынесены отдельно, чтобы проверять их в self-test)."""
    parser = argparse.ArgumentParser(description="Собрать CRM Agents")
    parser.add_argument("--no-install", action="store_true", help="не ставить зависимости")
    parser.add_argument("--wheels", action="store_true",
                        help="скачать колёса в launcher/wheels для офлайн-доустановки")
    parser.add_argument("--onefile", action="store_true",
                        help="один файл (по умолчанию папка: агенты запускаются без пересборки runtime)")
    parser.add_argument("--tmpdir", default="", metavar="ПАПКА",
                        help="куда распаковывать runtime однофайловой сборки (по умолчанию — TEMP)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if not SPEC.is_file():
        print(f"не найден {SPEC}", file=sys.stderr)
        return 2
    if not (REPO / "agent" / "desktop_operator.py").is_file():
        print("не найден agent/desktop_operator.py — запускайте из корня репозитория", file=sys.stderr)
        return 2

    if not args.no_install:
        run([sys.executable, "-m", "pip", "install", "--upgrade", "pip"])
        run([sys.executable, "-m", "pip", "install", "-r", str(REQUIREMENTS)])
        run([sys.executable, "-m", "pip", "install", "pyinstaller>=6.6"])

    if args.wheels:
        wheels = ROOT / "wheels"
        wheels.mkdir(exist_ok=True)
        packages = [
            line.strip() for line in REQUIREMENTS.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.startswith("#")
        ]
        run([sys.executable, "-m", "pip", "download", "-d", str(wheels), *packages])

    onefile = bool(args.onefile)
    mode = "одним файлом" if onefile else "папкой"
    print(f"\nсборка ({mode}) — это может занять несколько минут…")
    # --onefile/--onedir нельзя передавать вместе с .spec: режим задаём переменной.
    os.environ["CRM_LAUNCHER_ONEDIR"] = "0" if onefile else "1"
    if args.tmpdir:
        os.environ["CRM_LAUNCHER_RUNTIME_TMPDIR"] = os.path.abspath(args.tmpdir)
        print(f"runtime будет распаковываться в {args.tmpdir}")
    try:
        run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", str(SPEC)])
    except subprocess.CalledProcessError as error:
        print(f"PyInstaller завершился с ошибкой (код {error.returncode}). "
              "Частая причина — не установлены зависимости: "
              "уберите --no-install или поставьте launcher/requirements.txt.", file=sys.stderr)
        return error.returncode or 1

    dist = REPO / "dist"
    candidates = [
        dist / "CRM Agents" / "CRM Agents.exe",
        dist / "CRM Agents" / "CRM Agents",
        dist / "CRM Agents.exe",
        dist / "CRM Agents",
    ]
    found = next((path for path in candidates if path.exists()), None)
    if found is None:
        print("сборка завершилась, но файл не найден — смотрите вывод PyInstaller", file=sys.stderr)
        return 1

    size_mb = found.stat().st_size / (1024 * 1024)
    print(f"\nготово: {found}  ({size_mb:.1f} МБ)")
    if sys.platform.startswith("win"):
        print("Запуск: двойной клик по exe. Python и pip на машине не нужны.")
        if onefile:
            print(
                "Внимание: однофайловая сборка запускает агентов повторным запуском себя же "
                "и распаковывает runtime. Если Windows не даёт писать в TEMP, будет ошибка "
                "«Could not create temporary directory!». Надёжнее: без --onefile или с --tmpdir."
            )
    if shutil.which("codesign") and sys.platform == "darwin":
        print("macOS: подпишите сборку (codesign), иначе Gatekeeper будет ругаться.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
