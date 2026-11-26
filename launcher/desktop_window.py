# -*- coding: utf-8 -*-
"""Открытие локального веб-интерфейса CRM в отдельном окне приложения.

Стратегии по убыванию приоритета:
1. Нативное окно WebView2 / WebKit через `pywebview` (`webview.create_window`).
2. Отдельное окно браузера без адресной строки (`msedge --app=...` / `chrome --app=...`)
   с выделенным профилем, чтобы закрытие окна корректно завершало приложение.
3. Системный браузер по умолчанию (`webbrowser.open`).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from typing import Callable, List, Optional

from launcher import APP_NAME, settings as settings_mod


def _app_profile_dir() -> Path:
    base = settings_mod.default_path().parent / "browser_profile"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _candidate_app_browsers() -> List[str]:
    found: List[str] = []
    if sys.platform.startswith("win"):
        pf = os.environ.get("ProgramFiles", r"C:\Program Files")
        pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
        local = os.environ.get("LocalAppData", "")
        candidates = [
            Path(pf86) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
            Path(pf) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
            Path(pf) / "Google" / "Chrome" / "Application" / "chrome.exe",
            Path(pf86) / "Google" / "Chrome" / "Application" / "chrome.exe",
            Path(local) / "Google" / "Chrome" / "Application" / "chrome.exe" if local else Path("/nonexistent"),
            Path(local) / "Yandex" / "YandexBrowser" / "Application" / "browser.exe" if local else Path("/nonexistent"),
        ]
        for p in candidates:
            if p.is_file():
                found.append(str(p))
    else:
        for name in ("microsoft-edge", "google-chrome", "chromium", "chromium-browser"):
            path = shutil.which(name)
            if path:
                found.append(path)
    return found


def open_with_pywebview(url: str, title: str = "CRM ИИ и Агенты") -> bool:
    """Пытается открыть URL в нативном окне pywebview. Возвращает False, если недоступно."""
    try:
        import webview  # type: ignore[import-not-found]
    except ImportError:
        return False

    try:
        storage_dir = str(settings_mod.default_path().parent / "webview_storage")
        Path(storage_dir).mkdir(parents=True, exist_ok=True)
        webview.create_window(
            title,
            url,
            width=1380,
            height=880,
            min_size=(1000, 660),
            text_select=True,
        )
        webview.start(private_mode=False, storage_path=storage_dir)
        return True
    except BaseException as exc:  # noqa: BLE001 — fallback на Edge/Chrome
        print(f"[{APP_NAME}] pywebview недоступен ({exc}), переключаюсь на app-окно браузера", file=sys.stderr)
        return False


def open_with_browser_app(url: str) -> bool:
    """Открывает URL в Edge/Chrome с `--app=...` (без адресной строки) и ждёт закрытия."""
    browsers = _candidate_app_browsers()
    if not browsers:
        return False
    profile = _app_profile_dir()
    for exe in browsers:
        cmd = [
            exe,
            f"--app={url}",
            f"--user-data-dir={profile}",
            "--window-size=1380,880",
            "--no-first-run",
            "--no-default-browser-check",
        ]
        try:
            proc = subprocess.Popen(cmd)
            proc.wait()
            return True
        except OSError:
            continue
    return False


def detect_window_backend() -> str:
    """Возвращает название доступного способа открытия окна (для диагностики и тестов)."""
    try:
        import webview  # type: ignore[import-not-found]  # noqa: F401
        return "pywebview"
    except ImportError:
        pass
    if _candidate_app_browsers():
        return "browser_app"
    return "webbrowser"


def open_desktop_window(
    url: str,
    *,
    headless: bool = False,
    on_ready: Optional[Callable[[str], None]] = None,
) -> int:
    """Запускает настольное окно и блокируется до его закрытия."""
    if headless:
        print(f"[{APP_NAME}] локальный интерфейс доступен по адресу:\n{url}", flush=True)
        if on_ready:
            on_ready(url)
        try:
            while True:
                time.sleep(1.0)
        except KeyboardInterrupt:
            return 0

    if on_ready:
        on_ready(url)

    if open_with_pywebview(url):
        return 0

    if open_with_browser_app(url):
        return 0

    print(f"[{APP_NAME}] открываю интерфейс в системном браузере: {url}", flush=True)
    webbrowser.open(url)
    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        return 0
