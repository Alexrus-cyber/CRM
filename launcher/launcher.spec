# -*- mode: python ; coding: utf-8 -*-
"""Сборка одного exe: интерфейс + агенты + зависимости.

    pyinstaller --noconfirm --clean launcher/launcher.spec

Готовый файл: dist/CRM Agents.exe (Windows) — запускается двойным кликом,
Python и pip на машине пользователя не нужны.
"""

import ast
import importlib.util
import os
import sys
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


def _collect_agent_stdlib_imports(agents_dir: Path) -> list[str]:
    """Собирает stdlib-модули из agent/*.py для frozen PyInstaller (runpy)."""
    if not agents_dir.is_dir():
        return []
    py_files = sorted(agents_dir.glob("*.py"))
    local_modules = {p.stem for p in py_files}
    stdlib_names = getattr(sys, "stdlib_module_names", None)
    win_only = {"winreg", "msvcrt", "winsound", "_winapi"}
    posix_only = {"fcntl", "termios", "tty", "pty", "pwd", "grp", "resource", "syslog"}
    is_win = sys.platform.startswith("win")
    found: list[str] = []
    seen: set[str] = set()

    def _add(mod_name: str) -> None:
        clean = (mod_name or "").strip()
        if not clean or clean.startswith("_"):
            return
        root = clean.split(".")[0]
        if root in local_modules:
            return
        if stdlib_names is not None and root not in stdlib_names:
            return
        if is_win and root in posix_only:
            return
        if not is_win and root in win_only:
            return
        if clean not in seen:
            seen.add(clean)
            found.append(clean)

    for py_file in py_files:
        try:
            tree = ast.parse(py_file.read_text(encoding="utf-8"), filename=str(py_file))
        except (OSError, SyntaxError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    _add(alias.name)
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                _add(node.module)
                for alias in node.names:
                    if alias.name == "*":
                        continue
                    candidate = f"{node.module}.{alias.name}"
                    try:
                        if importlib.util.find_spec(candidate) is not None:
                            _add(candidate)
                    except (ImportError, ValueError, AttributeError):
                        pass
    return found


ROOT = _find_launcher_dir()                     # launcher/
REPO = ROOT.parent                              # корень репозитория

datas = []
agents_src = REPO / "agent"
_seen_datas: set[str] = set()
_known_agent_files = (
    "desktop_operator.py",
    "agent.py",
    "fileforge.py",
    "sandbox.py",
    "browser_inspector.py",
    "github_tools.py",
    "code_tools.py",
    "qa_tools.py",
    "overseer.py",
    "requirements.txt",
    "OPERATOR.md",
    "README.md",
)
for name in _known_agent_files:
    candidate = agents_src / name
    if candidate.is_file():
        key = str(candidate)
        _seen_datas.add(key)
        datas.append((key, "agents"))
if agents_src.is_dir():
    for py_file in sorted(agents_src.glob("*.py")):
        key = str(py_file)
        if key not in _seen_datas:
            _seen_datas.add(key)
            datas.append((key, "agents"))

wheels = ROOT / "wheels"
if wheels.is_dir():
    datas.append((str(wheels), "wheels"))

ui_src = ROOT / "ui"
if ui_src.is_dir():
    for ui_file in sorted(ui_src.rglob("*")):
        if ui_file.is_file():
            rel_parent = ui_file.relative_to(ui_src).parent
            dest = "ui" if str(rel_parent) == "." else f"ui/{rel_parent.as_posix()}"
            datas.append((str(ui_file), dest))

_webview_hidden: list[str] = []
try:
    from PyInstaller.utils.hooks import collect_submodules  # type: ignore[import-not-found]
    _webview_hidden = collect_submodules("webview")
except ImportError:
    _webview_hidden = []

_base_hiddenimports = [
    "launcher.catalog",
    "launcher.commands",
    "launcher.crm_client",
    "launcher.desktop_window",
    "launcher.file_extract",
    "launcher.gui",
    "launcher.harness_server",
    "launcher.runner",
    "launcher.settings",
    "launcher.deps",
    "launcher.bundle",
    "webview",
    *_webview_hidden,
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
    # Stdlib-модули, нужные встроенным скриптам agent/*.py при запуске через runpy внутри exe
    "ast",
    "atexit",
    "base64",
    "bz2",
    "contextlib",
    "csv",
    "ctypes",
    "ctypes.util",
    "datetime",
    "email",
    "email.mime",
    "email.mime.multipart",
    "email.mime.text",
    "email.parser",
    "email.utils",
    "errno",
    "fnmatch",
    "functools",
    "glob",
    "gzip",
    "hashlib",
    "hmac",
    "html",
    "html.entities",
    "html.parser",
    "http",
    "http.client",
    "http.cookiejar",
    "http.cookies",
    "http.server",
    "importlib",
    "importlib.machinery",
    "importlib.util",
    "inspect",
    "io",
    "ipaddress",
    "json",
    "lzma",
    "mimetypes",
    "os",
    "pathlib",
    "platform",
    "random",
    "re",
    "secrets",
    "shlex",
    "shutil",
    "signal",
    "socket",
    "socketserver",
    "ssl",
    "stat",
    "struct",
    "subprocess",
    "tempfile",
    "threading",
    "time",
    "traceback",
    "typing",
    "urllib",
    "urllib.error",
    "urllib.parse",
    "urllib.request",
    "urllib.response",
    "uuid",
    "webbrowser",
    "xml",
    "xml.etree",
    "xml.etree.ElementTree",
    "xml.parsers",
    "xml.parsers.expat",
    "xml.sax",
    "xml.sax.saxutils",
    "zipfile",
    "zlib",
]
if sys.platform.startswith("win"):
    _base_hiddenimports.extend(["winreg", "ctypes.wintypes", "msvcrt"])

hiddenimports = list(dict.fromkeys([*_base_hiddenimports, *_collect_agent_stdlib_imports(agents_src)]))

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
