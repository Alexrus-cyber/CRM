# -*- mode: python ; coding: utf-8 -*-
"""Сборка одного exe: интерфейс + агенты + зависимости.

    pyinstaller --noconfirm --clean launcher/launcher.spec

Готовый файл: dist/CRM Agents.exe (Windows) — запускается двойным кликом,
Python и pip на машине пользователя не нужны.
"""

import os
from pathlib import Path

def _find_launcher_dir() -> Path:
    """Папка launcher/: SPECPATH в разных версиях PyInstaller разный."""
    candidates = [
        Path(os.environ.get("CRM_LAUNCHER_SPEC_DIR", "")),
        Path(globals().get("SPECPATH", "")) if globals().get("SPECPATH") else Path("/nonexistent"),
        Path.cwd() / "launcher",
        Path.cwd(),
    ]
    for candidate in candidates:
        if str(candidate) and (candidate / "cli.py").is_file():
            return candidate.resolve()
    raise SystemExit("не найден launcher/cli.py — запустите сборку из корня репозитория")


ROOT = _find_launcher_dir()                     # launcher/
REPO = ROOT.parent                              # корень репозитория

datas = []
agents_src = REPO / "agent"
for name in ("desktop_operator.py", "agent.py", "fileforge.py", "sandbox.py",
             "browser_inspector.py", "github_tools.py", "requirements.txt", "OPERATOR.md", "README.md"):
    candidate = agents_src / name
    if candidate.is_file():
        datas.append((str(candidate), "agents"))

wheels = ROOT / "wheels"
if wheels.is_dir():
    datas.append((str(wheels), "wheels"))

hiddenimports = [
    "launcher.catalog",
    "launcher.commands",
    "launcher.crm_client",
    "launcher.gui",
    "launcher.runner",
    "launcher.settings",
    "launcher.deps",
    "launcher.bundle",
    "tkinter",
    "tkinter.ttk",
    "tkinter.filedialog",
    "tkinter.messagebox",
    "PIL",
    "PIL.Image",
    "PIL.ImageGrab",
    "PIL.ImageTk",
    "PIL.ImageDraw",
    "PIL.ImageFont",
    "pyautogui",
    "pyperclip",
    "pyscreeze",
    "pymsgbox",
    "pytweening",
    "mouseinfo",
    "pygetwindow",
]

a = Analysis(
    [str(ROOT / "cli.py")],
    pathex=[str(REPO)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["pytest", "numpy", "matplotlib", "scipy", "pandas"],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

ONE_DIR = os.environ.get("CRM_LAUNCHER_ONEDIR") == "1"

exe = EXE(
    pyz,
    a.scripts,
    *([] if ONE_DIR else [a.binaries, a.datas]),
    [],
    name="CRM Agents",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=os.environ.get("CRM_LAUNCHER_RUNTIME_TMPDIR") or None,
    console=False,
    disable_windowed_traceback=False,
    icon=str(ROOT / "app.ico") if (ROOT / "app.ico").is_file() else None,
    exclude_binaries=ONE_DIR,
)

if ONE_DIR:
    coll = COLLECT(
        exe,
        a.binaries,
        a.datas,
        strip=False,
        upx=False,
        name="CRM Agents",
    )
