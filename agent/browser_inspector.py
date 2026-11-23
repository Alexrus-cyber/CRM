#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Интерактивный браузерный инспектор проектов для ИИ-агента (чистый Python stdlib).

Позволяет Агенту самостоятельно заходить на веб-проект (в том числе из Sandbox или
по любому локальному/внешнему http(s)-адресу), взаимодействовать с интерфейсом и
проверять визуальные баги, анимации, переходы, ошибки консоли и сети:

  * запускает изолированный headless Chromium / Chrome / Edge (отдельный
    временный `--user-data-dir` без доступа к профилю/паролям пользователя);
  * общается с браузером по Chrome DevTools Protocol (CDP) через встроенный
    клиент RFC 6455 WebSocket без сторонних pip-зависимостей;
  * поддерживает живую сессию между шагами агента: `open`, `click`, `hover`,
    `type`, `press`, `scroll`, `resize`, `wait`, `inspect_animations`,
    `evaluate`, `close`;
  * собирает телеметрию анимаций (`document.getAnimations()`, CSS transition/animation,
    застрявшие `opacity: 0` элементы, сдвиги координат между кадрами `t=0` и `t=+400ms`),
    горизонтальный скролл, сломанные картинки, ошибки `console.error` / JS-исключения,
    ошибки сети (>= 400), карту интерактивных кнопок/ссылок и скриншоты для vision-модели.
"""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import mimetypes
import os
import platform
import re
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

_LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import sandbox as sandbox_mod  # noqa: E402


VIEWPORT_PRESETS: Dict[str, Tuple[int, int]] = {
    "desktop": (1440, 900),
    "laptop": (1280, 800),
    "tablet": (768, 1024),
    "mobile": (390, 844),
}


class BrowserError(RuntimeError):
    """Ошибка запуска или интерактивного осмотра проекта в браузере."""


def is_local_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(str(url or "").strip())
    host = (parsed.hostname or "").strip().lower().strip("[]").rstrip(".")
    if not host:
        return False
    if host in ("127.0.0.1", "localhost", "::1", "0.0.0.0") or host.endswith(".localhost"):
        return True
    if "%" in host:
        host = host.split("%", 1)[0]
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_unspecified or ip.is_link_local or ip.is_multicast:
            return False
        if ip.is_loopback or ip.is_private:
            return host != "fd00:ec2::254"
        return isinstance(ip, ipaddress.IPv4Address) and ip in ipaddress.ip_network("100.64.0.0/10")
    except ValueError:
        pass
    if host in ("host.docker.internal", "gateway.docker.internal"):
        return True
    return (
        host.endswith((".local", ".lan", ".home", ".home.arpa", ".internal"))
        or ("." not in host and len(host) <= 63)
    )


def validate_browser_url(raw_url: str) -> str:
    url = str(raw_url or "").strip()
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise BrowserError("Разрешены только адреса http:// или https://")
    if parsed.username or parsed.password:
        raise BrowserError("Учётные данные в URL запрещены")
    host = (parsed.hostname or "").strip().lower().strip("[]")
    if host in (
        "169.254.169.254",
        "metadata.google.internal",
        "metadata.goog",
        "metadata.azure.internal",
        "metadata.aws.internal",
        "instance-data",
    ) or host.startswith("169.254.") or host.startswith("fe80:"):
        raise BrowserError("Запрещён доступ к служебным metadata-адресам")
    return url


def normalize_viewport(
    preset: Any = None,
    width: Any = None,
    height: Any = None,
    default_w: int = 1440,
    default_h: int = 900,
) -> Tuple[int, int]:
    key = str(preset or "").strip().lower()
    if key in VIEWPORT_PRESETS and not width and not height:
        return VIEWPORT_PRESETS[key]
    try:
        w = int(width) if width is not None and width != "" else default_w
    except (TypeError, ValueError):
        w = default_w
    try:
        h = int(height) if height is not None and height != "" else default_h
    except (TypeError, ValueError):
        h = default_h
    return max(320, min(2560, w)), max(320, min(2000, h))


def _safe_is_file(path: Path) -> bool:
    try:
        return path.is_file()
    except OSError:
        return False


def _safe_is_dir(path: Path) -> bool:
    try:
        return path.is_dir()
    except OSError:
        return False


def _safe_glob(root: Path, pattern: str) -> List[Path]:
    try:
        return sorted(root.glob(pattern), reverse=True)
    except OSError:
        return []


def _windows_registry_browsers() -> List[Path]:
    if platform.system() != "Windows":
        return []
    found: List[Path] = []
    try:
        import winreg  # type: ignore  # noqa: PLC0415

        for root_hive in (getattr(winreg, "HKEY_CURRENT_USER", None), getattr(winreg, "HKEY_LOCAL_MACHINE", None)):
            if root_hive is None:
                continue
            for exe_name in ("chrome.exe", "msedge.exe", "chromium.exe", "brave.exe"):
                for sub_key in (
                    rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe_name}",
                    rf"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\{exe_name}",
                ):
                    try:
                        with winreg.OpenKey(root_hive, sub_key) as key:
                            val, _ = winreg.QueryValueEx(key, "")
                            if val:
                                found.append(Path(str(val).strip().strip('"')))
                    except OSError:
                        continue
    except Exception:  # noqa: BLE001
        pass
    return found


_BROWSER_AVAIL_LOCK = threading.Lock()
_BROWSER_AVAIL_CACHE: Tuple[float, bool] = (0.0, False)


def cached_browser_available(ttl_seconds: float = 60.0) -> bool:
    """Быстрая кешированная проверка наличия браузера для `/health` без запуска subprocess."""
    now = time.monotonic()
    with _BROWSER_AVAIL_LOCK:
        cached_at, cached_val = _BROWSER_AVAIL_CACHE
        if cached_at > 0.0 and (now - cached_at) < max(1.0, float(ttl_seconds)):
            return cached_val
    available = bool(find_browser_executable(allow_subprocess=False))
    with _BROWSER_AVAIL_LOCK:
        globals()["_BROWSER_AVAIL_CACHE"] = (time.monotonic(), available)
    return available


def find_browser_executable(*, allow_subprocess: bool = True) -> Optional[str]:
    """Ищет установленный Chromium / Chrome / Edge (включая реестр Windows и кеш Playwright)."""
    for env_key in (
        "AGENT_BROWSER_PATH",
        "CHROME_PATH",
        "CHROME_BIN",
        "CHROMIUM_PATH",
        "EDGE_PATH",
        "PUPPETEER_EXECUTABLE_PATH",
    ):
        raw = str(os.environ.get(env_key) or "").strip().strip('"')
        if raw and _safe_is_file(Path(raw)):
            return str(Path(raw))

    names = [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
        "microsoft-edge-stable",
        "msedge",
        "brave-browser",
        "chrome",
    ]
    for name in names:
        try:
            found = shutil.which(name)
        except OSError:
            found = None
        if found and _safe_is_file(Path(found)):
            return found

    system = platform.system()
    candidates: List[Path] = []
    if system == "Windows":
        candidates.extend(_windows_registry_browsers())
        for base in (
            os.environ.get("PROGRAMW6432", ""),
            os.environ.get("PROGRAMFILES", r"C:\Program Files"),
            os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"),
            os.environ.get("LOCALAPPDATA", ""),
        ):
            if not base:
                continue
            b = Path(base)
            candidates.extend([
                b / "Google" / "Chrome" / "Application" / "chrome.exe",
                b / "Google" / "Chrome SxS" / "Application" / "chrome.exe",
                b / "Microsoft" / "Edge" / "Application" / "msedge.exe",
                b / "Chromium" / "Application" / "chrome.exe",
                b / "BraveSoftware" / "Brave-Browser" / "Application" / "brave.exe",
            ])
    elif system == "Darwin":
        candidates.extend([
            Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
            Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
            Path("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
        ])
    else:
        candidates.extend([
            Path("/usr/bin/google-chrome"),
            Path("/usr/bin/google-chrome-stable"),
            Path("/usr/bin/chromium"),
            Path("/usr/bin/chromium-browser"),
            Path("/snap/bin/chromium"),
            Path("/usr/bin/microsoft-edge"),
        ])

    for path in candidates:
        if _safe_is_file(path):
            return str(path)

    # Кеш Playwright (chromium-* / chromium_headless_shell-*)
    pw_roots: List[Path] = []
    custom_pw = str(os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or "").strip()
    if custom_pw and custom_pw != "0":
        pw_roots.append(Path(custom_pw))
    try:
        pw_roots.append(Path.home() / ".cache" / "ms-playwright")
    except Exception:  # noqa: BLE001
        pass
    pw_roots.extend([
        Path("/root/.cache/ms-playwright"),
        Path("/ms-playwright"),
    ])
    local_app = os.environ.get("LOCALAPPDATA")
    if local_app:
        pw_roots.append(Path(local_app) / "ms-playwright")

    seen_roots: set[str] = set()
    for pw_root in pw_roots:
        key_r = str(pw_root)
        if key_r in seen_roots:
            continue
        seen_roots.add(key_r)
        if not _safe_is_dir(pw_root):
            continue
        for pattern in (
            "chromium-*/chrome-linux/chrome",
            "chromium-*/chrome-linux64/chrome",
            "chromium_headless_shell-*/chrome-linux/headless_shell",
            "chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell",
            "chromium-*/chrome-win/chrome.exe",
            "chromium-*/chrome-win64/chrome.exe",
            "chromium_headless_shell-*/chrome-win64/chrome-headless-shell.exe",
            "chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
            "chromium-*/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
        ):
            for match in _safe_glob(pw_root, pattern):
                if _safe_is_file(match):
                    return str(match)

    # Изолированный короткий probe пакета playwright без конфликта с asyncio-loop текущего потока.
    # В frozen exe (PyInstaller) sys.executable не принимает `-c` и запускает второй экземпляр exe.
    if allow_subprocess and not getattr(sys, "frozen", False):
        try:
            probe_kwargs: Dict[str, Any] = {
                "stdin": subprocess.DEVNULL,
                "stdout": subprocess.PIPE,
                "stderr": subprocess.DEVNULL,
                "text": True,
                "timeout": 4,
            }
            if system == "Windows":
                probe_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            probe = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "from playwright.sync_api import sync_playwright\nwith sync_playwright() as p: print(p.chromium.executable_path or '')",
                ],
                **probe_kwargs,
            )
            exe = (probe.stdout or "").strip().splitlines()[-1] if probe.returncode == 0 and (probe.stdout or "").strip() else ""
            if exe and _safe_is_file(Path(exe)):
                return exe
        except Exception:  # noqa: BLE001
            pass

    return None


# --------------------------------------------------------------------------
# Мини-сервер для статических проектов прямо в Sandbox
# --------------------------------------------------------------------------


class _SandboxRequestHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return

    def setup(self) -> None:
        super().setup()
        try:
            self.connection.settimeout(10.0)
        except OSError:
            pass

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class _StaticThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    block_on_close = False

    def handle_error(self, request: Any, client_address: Any) -> None:
        exc = sys.exc_info()[1] if "sys" in globals() else None
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError)):
            return
        winerr = getattr(exc, "winerror", None)
        if winerr in (10053, 10054):
            return
        super().handle_error(request, client_address)


class StaticSandboxServer:
    """Поднимает локальный HTTP-сервер только для выбранной папки внутри Sandbox."""

    def __init__(self, sandbox_root: Path, project_rel: str) -> None:
        resolved = sandbox_mod.safe_resolve(sandbox_root, project_rel, allow_root=False)
        if resolved.is_file():
            serve_dir = resolved.parent
            default_file = "/" + resolved.name
        elif resolved.is_dir():
            serve_dir = resolved
            default_file = "/"
            if not (serve_dir / "index.html").is_file():
                for sub_name in ("dist", "build", "public", "out"):
                    sub_dir = resolved / sub_name
                    if (sub_dir / "index.html").is_file():
                        # Отдаём собранный бандл от его корня, чтобы /assets/... и /favicon.ico резолвились корректно.
                        serve_dir = sub_dir
                        default_file = "/index.html"
                        break
                else:
                    html_files = sorted(p.name for p in serve_dir.glob("*.html") if p.is_file())
                    if len(html_files) == 1:
                        default_file = "/" + html_files[0]
        else:
            raise BrowserError(f"Проект или файл не найден в Sandbox: {project_rel}")

        mimetypes.add_type("application/javascript", ".js")
        mimetypes.add_type("application/javascript", ".mjs")
        mimetypes.add_type("text/css", ".css")
        mimetypes.add_type("image/svg+xml", ".svg")

        handler = partial(_SandboxRequestHandler, directory=str(serve_dir))
        self.httpd = _StaticThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = int(self.httpd.server_address[1])
        self.url = f"http://127.0.0.1:{self.port}{default_file}"
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        try:
            if self._thread.is_alive():
                self.httpd.shutdown()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.httpd.server_close()
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------------
# Встроенный RFC 6455 WebSocket + CDP-клиент
# --------------------------------------------------------------------------


class _WebSocketClient:
    """Минималистичный WebSocket-клиент поверх socket (только стандартная библиотека)."""

    def __init__(self, ws_url: str, timeout: float = 15.0) -> None:
        parsed = urllib.parse.urlparse(ws_url)
        if parsed.scheme != "ws" or not parsed.hostname or not parsed.port:
            raise BrowserError(f"Некорректный WebSocket-адрес CDP: {ws_url}")
        self._sock = socket.create_connection((parsed.hostname, parsed.port), timeout=timeout)
        try:
            self._sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        self._sock.settimeout(timeout)
        self._write_lock = threading.Lock()
        self._buf = bytearray()
        self._assembled = bytearray()
        self._assembling_text = False
        self.closed = False

        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        host_hdr = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host_hdr}:{parsed.port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        ).encode("ascii")
        self._sock.sendall(req)

        raw_hdr = bytearray()
        while b"\r\n\r\n" not in raw_hdr:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise BrowserError("Соединение CDP закрыто во время рукопожатия")
            raw_hdr.extend(chunk)
            if len(raw_hdr) > 65536:
                raise BrowserError("Слишком длинный заголовок ответа CDP")

        sep = raw_hdr.index(b"\r\n\r\n")
        header_text = raw_hdr[:sep].decode("latin1", errors="replace")
        if "101" not in header_text.splitlines()[0]:
            raise BrowserError(f"CDP отклонил WebSocket: {header_text.splitlines()[0]}")
        expected_accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        ).decode("ascii")
        if expected_accept not in header_text:
            raise BrowserError("Неверная подпись Sec-WebSocket-Accept от CDP")

        leftover = bytes(raw_hdr[sep + 4 :])
        if leftover:
            self._buf.extend(leftover)
        # Периодический timeout чтения позволяет reader-потоку проверять закрытие сокета.
        self._sock.settimeout(10.0)

    def _read_exact(self, n: int, *, continuation: bool = False) -> bytes:
        mid_frame = bool(continuation or self._buf or n > 2)
        deadline = time.monotonic() + (20.0 if mid_frame else 10.0)
        while len(self._buf) < n:
            if self.closed:
                raise EOFError("WebSocket closed")
            try:
                chunk = self._sock.recv(max(4096, n - len(self._buf)))
            except TimeoutError:
                if self.closed:
                    raise EOFError("WebSocket closed") from None
                if mid_frame:
                    if time.monotonic() < deadline:
                        continue
                    raise EOFError("WebSocket frame timeout") from None
                raise
            if not chunk:
                raise EOFError("WebSocket closed")
            self._buf.extend(chunk)
        out = bytes(self._buf[:n])
        del self._buf[:n]
        return out

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        if self.closed:
            raise BrowserError("Соединение с браузером закрыто")
        mask_key = secrets.token_bytes(4)
        length = len(payload)
        header = bytearray([0x80 | (opcode & 0x0F)])
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        header.extend(mask_key)
        masked = bytes(payload[i] ^ mask_key[i % 4] for i in range(length))
        with self._write_lock:
            self._sock.sendall(bytes(header) + masked)

    def recv_text(self) -> Optional[str]:
        while True:
            in_progress = self._assembling_text or bool(self._assembled)
            b1, b2 = self._read_exact(2, continuation=in_progress)
            fin = bool(b1 & 0x80)
            opcode = b1 & 0x0F
            masked = bool(b2 & 0x80)
            length = b2 & 0x7F
            if length == 126:
                (length,) = struct.unpack("!H", self._read_exact(2, continuation=True))
            elif length == 127:
                (length,) = struct.unpack("!Q", self._read_exact(8, continuation=True))
            mask = self._read_exact(4, continuation=True) if masked else b""
            data = self._read_exact(length, continuation=True) if length > 0 else b""
            if masked and data:
                data = bytes(data[i] ^ mask[i % 4] for i in range(len(data)))

            if opcode == 0x8:  # close
                self._assembled.clear()
                self._assembling_text = False
                self.closed = True
                return None
            if opcode == 0x9:  # ping -> pong
                try:
                    self._send_frame(0xA, data)
                except Exception:  # noqa: BLE001
                    pass
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode in (0x1, 0x2):
                self._assembled = bytearray(data)
                self._assembling_text = opcode == 0x1
                if fin:
                    out = self._assembled.decode("utf-8", errors="replace") if self._assembling_text else ""
                    self._assembled.clear()
                    self._assembling_text = False
                    return out
            elif opcode == 0x0:
                self._assembled.extend(data)
                if fin:
                    out = self._assembled.decode("utf-8", errors="replace") if self._assembling_text else ""
                    self._assembled.clear()
                    self._assembling_text = False
                    return out

    def close(self) -> None:
        was_closed = self.closed
        self.closed = True
        if not was_closed:
            try:
                self._sock.settimeout(0.5)
                mask_key = secrets.token_bytes(4)
                with self._write_lock:
                    self._sock.sendall(bytes([0x88, 0x80]) + mask_key)
            except Exception:  # noqa: BLE001
                pass
        try:
            self._sock.shutdown(socket.SHUT_RDWR)
        except Exception:  # noqa: BLE001
            pass
        try:
            self._sock.close()
        except Exception:  # noqa: BLE001
            pass


class CDPClient:
    """Асинхронная обёртка над CDP-сессией вкладки браузера."""

    def __init__(self, ws_url: str) -> None:
        self._ws = _WebSocketClient(ws_url)
        self._lock = threading.Lock()
        self._next_id = 1
        self._pending: Dict[int, Dict[str, Any]] = {}
        self.console_messages: List[Dict[str, str]] = []
        self.page_errors: List[str] = []
        self.failed_requests: List[Dict[str, Any]] = []
        self._requests_url: Dict[str, str] = {}
        self._thread = threading.Thread(target=self._reader_loop, daemon=True)
        self._thread.start()

    def _wake_pending(self) -> None:
        with self._lock:
            for slot in self._pending.values():
                slot["event"].set()

    def _reader_loop(self) -> None:
        try:
            while not self._ws.closed:
                try:
                    raw = self._ws.recv_text()
                except TimeoutError:
                    continue
                except Exception:  # noqa: BLE001
                    break
                if raw is None:
                    break
                if not raw:
                    continue
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                msg_id = msg.get("id")
                if isinstance(msg_id, int):
                    with self._lock:
                        slot = self._pending.get(msg_id)
                        if slot is not None:
                            slot["msg"] = msg
                            slot["event"].set()
                    continue

                method = str(msg.get("method") or "")
                params = msg.get("params") or {}
                self._handle_event(method, params)
        finally:
            self._ws.closed = True
            self._wake_pending()

        self._ws.closed = True
        with self._lock:
            for slot in self._pending.values():
                slot["event"].set()

    def _dismiss_dialog_async(self) -> None:
        def _run() -> None:
            try:
                self.call("Page.handleJavaScriptDialog", {"accept": True}, timeout=3.0)
            except Exception:  # noqa: BLE001
                pass

        threading.Thread(target=_run, daemon=True).start()

    def _handle_event(self, method: str, params: Dict[str, Any]) -> None:
        if method == "Page.javascriptDialogOpening":
            dialog_type = str(params.get("type") or "alert")
            dialog_msg = str(params.get("message") or "").strip()[:200]
            with self._lock:
                self.console_messages.append({
                    "level": "warning",
                    "text": f"[JS {dialog_type}] {dialog_msg or '(диалог автоматически закрыт)'}",
                })
                if len(self.console_messages) > 40:
                    del self.console_messages[: len(self.console_messages) - 40]
            self._dismiss_dialog_async()
            return

        if method == "Runtime.consoleAPICalled":
            level = str(params.get("type") or "log")
            if level in ("error", "warning", "assert"):
                args = params.get("args") or []
                parts: List[str] = []
                for arg in args[:6]:
                    if isinstance(arg, dict):
                        val = arg.get("value")
                        if val is not None:
                            parts.append(str(val))
                        elif arg.get("description"):
                            parts.append(str(arg["description"]))
                text = " ".join(parts).strip()[:400]
                if text:
                    with self._lock:
                        self.console_messages.append({"level": level, "text": text})
                        if len(self.console_messages) > 40:
                            del self.console_messages[: len(self.console_messages) - 40]

        elif method == "Runtime.exceptionThrown":
            details = params.get("exceptionDetails") or {}
            exc = details.get("exception") or {}
            desc = str(exc.get("description") or details.get("text") or "Uncaught JS error").strip()[:400]
            with self._lock:
                self.page_errors.append(desc)
                if len(self.page_errors) > 30:
                    del self.page_errors[: len(self.page_errors) - 30]

        elif method == "Network.requestWillBeSent":
            req_id = str(params.get("requestId") or "")
            url = str((params.get("request") or {}).get("url") or "")
            if req_id and url:
                with self._lock:
                    self._requests_url[req_id] = url
                    if len(self._requests_url) > 400:
                        oldest = next(iter(self._requests_url))
                        self._requests_url.pop(oldest, None)

        elif method == "Network.responseReceived":
            resp = params.get("response") or {}
            status = int(resp.get("status") or 0)
            url = str(resp.get("url") or "")
            if status >= 400 and url and not url.endswith("/favicon.ico"):
                with self._lock:
                    self.failed_requests.append({"url": url[:240], "status": status, "type": str(params.get("type") or "")})
                    if len(self.failed_requests) > 40:
                        del self.failed_requests[: len(self.failed_requests) - 40]

        elif method == "Network.loadingFailed":
            req_id = str(params.get("requestId") or "")
            err_text = str(params.get("errorText") or "failed")
            if err_text == "net::ERR_ABORTED":
                return
            with self._lock:
                url = self._requests_url.get(req_id, "")
                if url and not url.endswith("/favicon.ico"):
                    self.failed_requests.append({"url": url[:240], "status": 0, "error": err_text[:120]})
                    if len(self.failed_requests) > 40:
                        del self.failed_requests[: len(self.failed_requests) - 40]

    def clear_telemetry(self) -> None:
        with self._lock:
            self.console_messages.clear()
            self.page_errors.clear()
            self.failed_requests.clear()

    def snapshot_telemetry(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "consoleMessages": list(self.console_messages),
                "pageErrors": list(self.page_errors),
                "failedRequests": list(self.failed_requests),
            }

    def call(self, method: str, params: Optional[Dict[str, Any]] = None, timeout: float = 20.0) -> Dict[str, Any]:
        with self._lock:
            msg_id = self._next_id
            self._next_id += 1
            ev = threading.Event()
            self._pending[msg_id] = {"event": ev, "msg": None}

        payload = json.dumps({"id": msg_id, "method": method, "params": params or {}}, ensure_ascii=False)
        try:
            self._ws.send_text(payload)
        except Exception as error:
            with self._lock:
                self._pending.pop(msg_id, None)
            raise BrowserError(f"Ошибка отправки команды браузеру ({method}): {error}") from error

        if not ev.wait(timeout):
            with self._lock:
                self._pending.pop(msg_id, None)
            raise BrowserError(f"Браузер не ответил на {method} за {int(timeout)} с")

        with self._lock:
            slot = self._pending.pop(msg_id, None)
        msg = (slot or {}).get("msg")
        if not msg:
            raise BrowserError(f"Соединение с браузером оборвалось на {method}")
        if msg.get("error"):
            err = msg["error"]
            raise BrowserError(f"CDP {method}: {err.get('message') or err}")
        return msg.get("result") or {}

    def evaluate(self, expression: str, *, await_promise: bool = True, timeout: float = 15.0) -> Any:
        res = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": await_promise,
            },
            timeout=timeout,
        )
        exc = res.get("exceptionDetails")
        if exc:
            msg = str((exc.get("exception") or {}).get("description") or exc.get("text") or "JS evaluation error")
            raise BrowserError(msg[:400])
        return (res.get("result") or {}).get("value")

    def close(self) -> None:
        self._ws.close()
        self._wake_pending()


# --------------------------------------------------------------------------
# JS-скрипты диагностики DOM, layout и анимаций
# --------------------------------------------------------------------------

AUDIT_JS = r"""
(() => {
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  const docEl = document.documentElement;
  const body = document.body;
  const scrollWidth = docEl ? docEl.scrollWidth : 0;
  const scrollHeight = docEl ? docEl.scrollHeight : 0;

  function makeSelector(el) {
    if (!el || !el.tagName) return "";
    const tag = el.tagName.toLowerCase();
    if (el.id) return "#" + CSS.escape(el.id);
    const dt = el.getAttribute("data-testid");
    if (dt) return `${tag}[data-testid="${CSS.escape(dt)}"]`;
    const aria = el.getAttribute("aria-label");
    if (aria && aria.length <= 40) return `${tag}[aria-label="${aria.replace(/"/g, '\\"')}"]`;
    const cls = typeof el.className === "string"
      ? el.className.trim().split(/\s+/).filter((c) => c && !c.includes(":") && !c.includes("[")).slice(0, 2)
      : [];
    let base = tag + (cls.length ? "." + cls.map((c) => CSS.escape(c)).join(".") : "");
    const parent = el.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((ch) => ch.tagName === el.tagName);
      if (same.length > 1) {
        const idx = same.indexOf(el) + 1;
        base += `:nth-of-type(${idx})`;
      }
    }
    return base.slice(0, 90);
  }

  function cleanText(el) {
    return String(el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 70);
  }

  function isVisibleStyle(st) {
    return st && st.display !== "none" && st.visibility !== "hidden";
  }

  const issues = [];
  const overflowItems = [];
  const stuckInvisible = [];
  const brokenImages = [];
  const clippedElements = [];
  const animatedNodes = [];
  const interactive = [];

  if (scrollWidth > vw + 2) {
    issues.push({
      kind: "horizontal_overflow",
      severity: "warning",
      message: `Горизонтальное переполнение: ширина контента ${scrollWidth}px при окне ${vw}px`,
    });
  }

  const SKIP_TAGS = new Set(["HTML", "HEAD", "META", "LINK", "STYLE", "SCRIPT", "TITLE", "NOSCRIPT", "TEMPLATE", "BR"]);
  const all = Array.from(document.querySelectorAll("*")).slice(0, 1200);
  for (const el of all) {
    if (!el || SKIP_TAGS.has(el.tagName)) continue;
    let st;
    try { st = getComputedStyle(el); } catch { continue; }
    if (st.display === "none") continue;
    const rect = el.getBoundingClientRect();
    const sel = makeSelector(el);

    if (rect.width > 0 && rect.height > 0 && rect.right > vw + 4 && overflowItems.length < 6) {
      overflowItems.push({ selector: sel, right: Math.round(rect.right), width: Math.round(rect.width) });
    }

    const inViewport = rect.width >= 24 && rect.height >= 24 && rect.bottom > 0 && rect.top < vh;
    const hasContent = (el.textContent || "").trim().length > 0 || el.querySelector("img,svg,canvas,video,button,input");
    if (inViewport && hasContent && parseFloat(st.opacity) === 0 && el !== body && el !== docEl && stuckInvisible.length < 8) {
      stuckInvisible.push({
        selector: sel,
        text: cleanText(el),
        animationName: st.animationName,
        transition: st.transitionProperty !== "all" || st.transitionDuration !== "0s" ? `${st.transitionProperty} ${st.transitionDuration}` : "",
      });
    }

    if (el.tagName === "IMG") {
      const img = el;
      if (img.complete && img.naturalWidth === 0 && brokenImages.length < 8) {
        brokenImages.push({ src: String(img.getAttribute("src") || "").slice(0, 120), alt: String(img.getAttribute("alt") || "").slice(0, 50) });
      }
    }

    if (
      rect.width > 20 &&
      rect.height > 10 &&
      (st.overflowX === "hidden" || st.overflowX === "clip") &&
      el.scrollWidth > el.clientWidth + 8 &&
      clippedElements.length < 5
    ) {
      clippedElements.push({ selector: sel, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
    }

    const hasAnim = st.animationName && st.animationName !== "none";
    const hasTrans = st.transitionDuration && st.transitionDuration !== "0s";
    if ((hasAnim || hasTrans) && animatedNodes.length < 30) {
      animatedNodes.push({
        selector: sel,
        text: cleanText(el).slice(0, 35),
        animationName: hasAnim ? st.animationName : "",
        animationDuration: hasAnim ? st.animationDuration : "",
        animationPlayState: hasAnim ? st.animationPlayState : "",
        transition: hasTrans ? `${st.transitionProperty} (${st.transitionDuration})` : "",
        opacity: st.opacity,
        transform: st.transform !== "none" ? st.transform : "",
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      });
    }
  }

  if (overflowItems.length) {
    issues.push({
      kind: "overflow_elements",
      severity: "warning",
      message: "Элементы выходят за правый край экрана: " + overflowItems.map((i) => `${i.selector} (right=${i.right}px)`).join(", "),
    });
  }
  if (stuckInvisible.length) {
    issues.push({
      kind: "stuck_opacity_zero",
      severity: "error",
      message: `Найдены видимые в окне блоки с opacity: 0 (${stuckInvisible.length} шт. — возможно не сработала анимация появления): ` +
        stuckInvisible.map((i) => i.selector).join(", "),
    });
  }
  if (brokenImages.length) {
    issues.push({
      kind: "broken_images",
      severity: "error",
      message: "Битые изображения: " + brokenImages.map((i) => i.src || i.alt || "<img>").join(", "),
    });
  }
  if (clippedElements.length) {
    issues.push({
      kind: "clipped_content",
      severity: "info",
      message: "Обрезанный по ширине контент внутри overflow:hidden: " + clippedElements.map((c) => `${c.selector} (${c.scrollWidth}>${c.clientWidth})`).join(", "),
    });
  }

  const webAnims = (typeof document.getAnimations === "function" ? document.getAnimations() : []).slice(0, 40).map((a) => {
    const eff = a.effect;
    const timing = eff && typeof eff.getTiming === "function" ? eff.getTiming() : {};
    const target = eff && eff.target ? eff.target : null;
    const st = target ? getComputedStyle(target) : null;
    const rect = target ? target.getBoundingClientRect() : null;
    return {
      kind: a.animationName ? "css-animation" : (a.transitionProperty ? "css-transition" : "web-animation"),
      name: a.animationName || a.transitionProperty || a.id || "animation",
      playState: a.playState,
      currentTimeMs: typeof a.currentTime === "number" ? Math.round(a.currentTime) : null,
      durationMs: typeof timing.duration === "number" ? Math.round(timing.duration) : timing.duration,
      iterations: timing.iterations === Infinity ? "infinite" : timing.iterations,
      target: target ? makeSelector(target) : "",
      opacity: st ? st.opacity : undefined,
      transform: st && st.transform !== "none" ? st.transform : undefined,
      rect: rect ? { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) } : undefined,
    };
  });

  const pausedAnims = webAnims.filter((a) => a.playState === "paused");
  if (pausedAnims.length) {
    issues.push({
      kind: "paused_animations",
      severity: "warning",
      message: `Анимации на паузе (${pausedAnims.length}): ` + pausedAnims.map((a) => `${a.name} (${a.target})`).join(", "),
    });
  }

  const interactiveCandidates = Array.from(
    document.querySelectorAll("a[href], button, input, select, textarea, summary, [role='button'], [role='tab'], [onclick]")
  );
  for (const el of interactiveCandidates) {
    if (interactive.length >= 35) break;
    const st = getComputedStyle(el);
    if (!isVisibleStyle(st)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (rect.bottom < -50 || rect.top > vh + 120) continue;
    interactive.push({
      index: interactive.length + 1,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || undefined,
      role: el.getAttribute("role") || undefined,
      text: cleanText(el) || String(el.getAttribute("href") || "").slice(0, 40),
      selector: makeSelector(el),
      disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    });
  }

  const reducedMotion = Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const keyframesFound = [];
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (rule.type === CSSRule.KEYFRAMES_RULE && keyframesFound.length < 25) {
          keyframesFound.push(rule.name);
        }
      }
    }
  } catch {}

  return {
    url: location.href,
    title: document.title || "",
    viewport: { width: vw, height: vh },
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY), width: scrollWidth, height: scrollHeight },
    textSnippet: (body ? (body.innerText || "") : "").replace(/\s+/g, " ").trim().slice(0, 700),
    reducedMotion,
    keyframes: keyframesFound,
    webAnimations: webAnims,
    cssAnimatedElements: animatedNodes,
    stuckInvisible,
    brokenImages,
    overflowItems,
    issues,
    interactive,
  };
})()
"""


def _js_locate_element(selector: str = "", text: str = "") -> str:
    sel_json = json.dumps(str(selector or ""), ensure_ascii=False)
    txt_json = json.dumps(str(text or ""), ensure_ascii=False)
    return f"""
(() => {{
  const selector = {sel_json}.trim();
  const wantedText = {txt_json}.trim().toLowerCase();
  let el = null;
  if (selector) {{
    if (selector.startsWith("text=")) {{
      const q = selector.slice(5).trim().toLowerCase();
      const pool = Array.from(document.querySelectorAll("button, a, [role='button'], [role='tab'], summary, label, input, *"));
      el = pool.find((n) => (n.innerText || n.textContent || n.getAttribute("aria-label") || "").trim().toLowerCase().includes(q)) || null;
    }} else {{
      try {{ el = document.querySelector(selector); }} catch (e) {{ return {{ error: "Некорректный CSS-селектор: " + selector }}; }}
    }}
  }}
  if (!el && wantedText) {{
    const pool = Array.from(document.querySelectorAll("button, a, [role='button'], [role='tab'], summary, input, textarea, select, label, div, span"));
    el = pool.find((n) => {{
      const st = getComputedStyle(n);
      if (st.display === "none" || st.visibility === "hidden") return false;
      const r = n.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const t = (n.innerText || n.textContent || n.getAttribute("aria-label") || n.getAttribute("placeholder") || "").replace(/\\s+/g, " ").trim().toLowerCase();
      return t === wantedText || t.includes(wantedText);
    }}) || null;
  }}
  if (!el) return {{ error: "Элемент не найден на странице" }};
  el.scrollIntoView({{ block: "center", inline: "center", behavior: "instant" }});
  const rect = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  return {{
    ok: true,
    tag: el.tagName.toLowerCase(),
    text: String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80),
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
    opacity: st.opacity,
    transform: st.transform,
  }};
}})()
"""


# --------------------------------------------------------------------------
# Живая браузерная сессия
# --------------------------------------------------------------------------


def _kill_proc_tree(proc: Optional[subprocess.Popen[Any]]) -> None:
    if not proc:
        return
    try:
        if proc.poll() is None:
            if platform.system() == "Windows":
                # Убиваем всё дерево процессов Chrome/Edge (renderer/gpu/network),
                # чтобы освободить временный user_data_dir и сокеты сразу.
                try:
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
                    proc.kill()
            else:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
    except Exception:  # noqa: BLE001
        pass
    try:
        if proc.stderr:
            proc.stderr.close()
    except Exception:  # noqa: BLE001
        pass


def _launch_headless_chromium(executable: str, width: int, height: int) -> Tuple[subprocess.Popen[str], Path, int]:
    """Запускает headless Chromium; при сбое пробует классический `--headless` и `--no-sandbox` на Linux."""
    is_headless_shell = "headless" in Path(executable).name.lower()
    is_root = platform.system() != "Windows" and hasattr(os, "geteuid") and os.geteuid() == 0

    if is_headless_shell:
        base_attempts: List[Tuple[str, float, bool]] = [
            ("--headless", 10.0, is_root),
        ]
    else:
        base_attempts = [
            ("--headless=new", 11.0, is_root),
            ("--headless", 8.0, is_root),
        ]
    if platform.system() != "Windows" and not is_root:
        # Fallback для контейнеров / Linux без user namespaces / AppArmor.
        base_attempts.append(("--headless" if is_headless_shell else "--headless=new", 10.0, True))

    last_error: Optional[Exception] = None

    for headless_flag, startup_timeout, use_no_sandbox in base_attempts:
        user_data = Path(tempfile.mkdtemp(prefix="crm-browser-"))
        cmd = [
            executable,
            headless_flag,
            f"--user-data-dir={user_data}",
            "--remote-debugging-port=0",
            "--remote-allow-origins=*",
            f"--window-size={width},{height}",
            "--enable-logging=stderr",
            "--log-level=3",
            "--no-first-run",
            "--no-default-browser-check",
            "--no-proxy-server",
            "--no-pings",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-translate",
            "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider",
            "--disable-hang-monitor",
            "--disable-gpu",
            "--disable-gpu-sandbox",
            "--disable-dev-shm-usage",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
            "--mute-audio",
            "about:blank",
        ]
        if use_no_sandbox:
            cmd.extend(["--no-sandbox", "--disable-setuid-sandbox"])

        popen_kwargs: Dict[str, Any] = {
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.PIPE,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
        }
        if platform.system() == "Windows":
            popen_kwargs["creationflags"] = (
                getattr(subprocess, "CREATE_NO_WINDOW", 0)
                | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            )

        proc = subprocess.Popen(cmd, **popen_kwargs)

        stderr_lines: List[str] = []
        port_holder: Dict[str, int] = {"port": 0}

        def read_stderr(p: subprocess.Popen[str] = proc, lines: List[str] = stderr_lines, holder: Dict[str, int] = port_holder) -> None:
            if not p.stderr:
                return
            try:
                for line in p.stderr:
                    lines.append(line.strip())
                    m = re.search(r"DevTools listening on ws://(?:\[[^\]]+\]|[^:]+):(\d+)/", line)
                    if m and not holder["port"]:
                        holder["port"] = int(m.group(1))
                    if len(lines) > 40:
                        del lines[: len(lines) - 40]
            except Exception:  # noqa: BLE001
                pass

        threading.Thread(target=read_stderr, daemon=True).start()

        deadline = time.monotonic() + startup_timeout
        port_file = user_data / "DevToolsActivePort"
        crashed = False
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                err_tail = " | ".join(stderr_lines[-5:])
                _kill_proc_tree(proc)
                shutil.rmtree(user_data, ignore_errors=True)
                last_error = BrowserError(f"Браузер сразу завершился (код {proc.returncode}): {err_tail}")
                crashed = True
                break
            if port_holder["port"]:
                return proc, user_data, port_holder["port"]
            if port_file.is_file():
                try:
                    first_line = port_file.read_text(encoding="utf-8", errors="ignore").splitlines()[0].strip()
                    if first_line.isdigit():
                        return proc, user_data, int(first_line)
                except (IndexError, OSError):
                    pass
            time.sleep(0.1)

        if not crashed:
            _kill_proc_tree(proc)
            shutil.rmtree(user_data, ignore_errors=True)
            last_error = BrowserError("Таймаут запуска headless-браузера CDP")

    if last_error is not None:
        raise last_error
    raise BrowserError("Таймаут запуска headless-браузера CDP")


def _find_page_ws_url(port: int, user_data_dir: Optional[Path] = None) -> str:
    deadline = time.monotonic() + 7.0
    last_err = ""
    tried_new_tab = False
    hosts = ("127.0.0.1", "[::1]")
    while time.monotonic() < deadline:
        for host in hosts:
            try:
                with _LOCAL_OPENER.open(f"http://{host}:{port}/json/list", timeout=2) as resp:
                    targets = json.loads(resp.read().decode("utf-8"))
                for item in targets:
                    if item.get("type") == "page" and item.get("webSocketDebuggerUrl"):
                        return str(item["webSocketDebuggerUrl"])
                if not tried_new_tab:
                    tried_new_tab = True
                    for method in ("PUT", "GET"):
                        try:
                            req = urllib.request.Request(
                                f"http://{host}:{port}/json/new?about:blank",
                                method=method,
                            )
                            with _LOCAL_OPENER.open(req, timeout=2) as new_resp:
                                created = json.loads(new_resp.read().decode("utf-8"))
                            if isinstance(created, dict) and created.get("webSocketDebuggerUrl"):
                                return str(created["webSocketDebuggerUrl"])
                        except Exception:  # noqa: BLE001
                            continue
                    # Fallback через browser WebSocket (`Target.createTarget`) для сборок без `/json/new`.
                    try:
                        browser_ws = ""
                        try:
                            with _LOCAL_OPENER.open(f"http://{host}:{port}/json/version", timeout=2) as v_resp:
                                v_info = json.loads(v_resp.read().decode("utf-8"))
                            browser_ws = str(v_info.get("webSocketDebuggerUrl") or "")
                        except Exception:  # noqa: BLE001
                            if user_data_dir and (user_data_dir / "DevToolsActivePort").is_file():
                                lines = (user_data_dir / "DevToolsActivePort").read_text(encoding="utf-8", errors="ignore").splitlines()
                                if len(lines) >= 2 and lines[1].strip():
                                    browser_ws = f"ws://{host}:{port}{lines[1].strip()}"
                        if browser_ws:
                            b_cdp = CDPClient(browser_ws)
                            try:
                                res = b_cdp.call("Target.createTarget", {"url": "about:blank"}, timeout=3.0)
                                target_id = str(res.get("targetId") or "")
                                if target_id:
                                    return f"ws://{host}:{port}/devtools/page/{target_id}"
                            finally:
                                b_cdp.close()
                    except Exception:  # noqa: BLE001
                        pass
            except Exception as error:  # noqa: BLE001
                last_err = str(error)
        time.sleep(0.1)
    raise BrowserError(f"Не удалось получить вкладку CDP на порту {port}: {last_err}")


KEY_MAP: Dict[str, Tuple[str, str, int]] = {
    "enter": ("Enter", "Enter", 13),
    "escape": ("Escape", "Escape", 27),
    "esc": ("Escape", "Escape", 27),
    "tab": ("Tab", "Tab", 9),
    "space": (" ", "Space", 32),
    "backspace": ("Backspace", "Backspace", 8),
    "arrowdown": ("ArrowDown", "ArrowDown", 40),
    "arrowup": ("ArrowUp", "ArrowUp", 38),
    "arrowleft": ("ArrowLeft", "ArrowLeft", 37),
    "arrowright": ("ArrowRight", "ArrowRight", 39),
    "home": ("Home", "Home", 36),
    "end": ("End", "End", 35),
    "pagedown": ("PageDown", "PageDown", 34),
    "pageup": ("PageUp", "PageUp", 33),
}


class BrowserSession:
    """Одна интерактивная вкладка Chromium/Chrome с историей телеметрии и скриншотами."""

    def __init__(
        self,
        *,
        cdp: Optional[CDPClient] = None,
        proc: Optional[subprocess.Popen[str]] = None,
        user_data_dir: Optional[Path] = None,
        width: int = 1440,
        height: int = 900,
    ) -> None:
        self.cdp = cdp
        self.proc = proc
        self.user_data_dir = user_data_dir
        self.width = width
        self.height = height
        self.static_servers: Dict[str, StaticSandboxServer] = {}
        self.approved_external_origins: set[str] = set()
        self.current_url = ""
        self._screenshots_disabled = False

    @classmethod
    def launch(cls, width: int = 1440, height: int = 900) -> "BrowserSession":
        exe = find_browser_executable()
        if not exe:
            raise BrowserError(
                "На машине не найден браузер Chromium / Chrome / Edge для интерактивного осмотра проекта. "
                "Установите Chrome/Edge или Playwright Chromium (npx playwright install chromium) "
                "либо задайте переменную окружения AGENT_BROWSER_PATH."
            )
        proc, user_data, port = _launch_headless_chromium(exe, width, height)
        try:
            ws_url = _find_page_ws_url(port, user_data_dir=user_data)
            cdp = CDPClient(ws_url)
            cdp.call("Page.enable", timeout=10.0)
            cdp.call("Runtime.enable", timeout=10.0)
            cdp.call("Network.enable", timeout=10.0)
            cdp.call(
                "Emulation.setDeviceMetricsOverride",
                {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": width <= 500},
                timeout=10.0,
            )
        except Exception:
            _kill_proc_tree(proc)
            shutil.rmtree(user_data, ignore_errors=True)
            raise
        return cls(cdp=cdp, proc=proc, user_data_dir=user_data, width=width, height=height)

    def is_alive(self) -> bool:
        if self.cdp is None or self.cdp._ws.closed:
            return False
        if self.proc is not None and self.proc.poll() is not None:
            return False
        return True

    def ensure_cdp(self) -> CDPClient:
        if not self.cdp or self.cdp._ws.closed:
            raise BrowserError("Браузерная сессия не запущена или соединение оборвалось")
        if self.proc is not None and self.proc.poll() is not None:
            raise BrowserError("Процесс браузера завершился неожиданно")
        return self.cdp

    def set_viewport(self, width: int, height: int) -> None:
        self.width = width
        self.height = height
        self.ensure_cdp().call(
            "Emulation.setDeviceMetricsOverride",
            {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": width <= 500},
            timeout=10.0,
        )

    def navigate(self, url: str, wait_ms: int = 450) -> None:
        cdp = self.ensure_cdp()
        cdp.clear_telemetry()
        nav_res = cdp.call("Page.navigate", {"url": url}, timeout=10.0)
        if nav_res.get("errorText"):
            raise BrowserError(f"Браузер не смог открыть {url}: {nav_res['errorText']}")
        start = time.monotonic()
        deadline = start + 8.0
        interactive_since: Optional[float] = None
        while time.monotonic() < deadline:
            remaining = max(0.5, deadline - time.monotonic())
            try:
                state = cdp.evaluate(
                    "document.readyState",
                    await_promise=False,
                    timeout=min(2.0, remaining),
                )
                if state == "complete":
                    break
                if state == "interactive":
                    if interactive_since is None:
                        interactive_since = time.monotonic()
                    # Если DOM уже готов > 2.0с (например, завис внешний шрифт/аналитика), продолжаем.
                    elif time.monotonic() - interactive_since >= 2.0:
                        break
                elif time.monotonic() - start >= 4.5:
                    # Если заблокирован внешний скрипт в <head>, но DOM уже присутствует — не ждём полный таймаут.
                    has_dom = cdp.evaluate(
                        "Boolean(document.body && document.body.children && document.body.children.length > 0)",
                        await_promise=False,
                        timeout=1.5,
                    )
                    if has_dom:
                        with cdp._lock:
                            cdp.console_messages.append({
                                "level": "warning",
                                "text": "Внешний ресурс задерживает readyState=loading (>4.5с); аудит выполнен по текущему DOM.",
                            })
                        break
            except BrowserError:
                pass
            time.sleep(0.15)
        if wait_ms > 0:
            time.sleep(min(wait_ms, 5000) / 1000.0)
        self.current_url = url

    def capture_screenshot(self) -> str:
        if self._screenshots_disabled:
            return ""
        try:
            res = self.ensure_cdp().call(
                "Page.captureScreenshot",
                {"format": "jpeg", "quality": 76, "fromSurface": True, "optimizeForSpeed": True},
                timeout=6.0,
            )
            b64 = str(res.get("data") or "")
            return f"data:image/jpeg;base64,{b64}" if b64 else ""
        except BrowserError:
            # Не тормозим последующие шаги в этой сессии, если captureScreenshot заблокирован/таймаутится.
            self._screenshots_disabled = True
            return ""

    def audit(self) -> Dict[str, Any]:
        cdp = self.ensure_cdp()
        dom_audit: Dict[str, Any] = {}
        for attempt in range(2):
            try:
                dom_audit = cdp.evaluate(AUDIT_JS, await_promise=False, timeout=12.0) or {}
                break
            except BrowserError as err:
                msg = str(err).lower()
                if attempt == 0 and ("context" in msg or "destroyed" in msg or "navigation" in msg):
                    time.sleep(0.35)
                    continue
                raise
        telemetry = cdp.snapshot_telemetry()
        return {
            "dom": dom_audit,
            "telemetry": telemetry,
        }

    def close(self) -> None:
        if self.cdp:
            try:
                self.cdp.close()
            except Exception:  # noqa: BLE001
                pass
            self.cdp = None
        # Сначала завершаем дерево процессов браузера, чтобы отпустить HTTP keep-alive и lock-файлы.
        _kill_proc_tree(self.proc)
        self.proc = None
        for srv in self.static_servers.values():
            srv.close()
        self.static_servers.clear()
        if self.user_data_dir and self.user_data_dir.exists():
            shutil.rmtree(self.user_data_dir, ignore_errors=True)
            self.user_data_dir = None


class BrowserSessionManager:
    """Держит активные вкладки в рамках одного запуска Агента и гарантированно закрывает их."""

    def __init__(self, sandbox_root: Path = sandbox_mod.get_sandbox_root()) -> None:
        self.sandbox_root = sandbox_root
        self._lock = threading.Lock()
        self._sessions: Dict[str, BrowserSession] = {}

    def get_or_create(self, session_id: str, width: int, height: int) -> BrowserSession:
        stale: Optional[BrowserSession] = None
        preserved_origins: set[str] = set()
        with self._lock:
            session = self._sessions.get(session_id)
            if session is not None:
                if session.is_alive():
                    return session
                stale = self._sessions.pop(session_id, None)
                preserved_origins = set(session.approved_external_origins)
        if stale is not None:
            stale.close()
        created = BrowserSession.launch(width=width, height=height)
        if preserved_origins:
            created.approved_external_origins.update(preserved_origins)
        with self._lock:
            self._sessions[session_id] = created
        return created

    def get_existing(self, session_id: str) -> Optional[BrowserSession]:
        with self._lock:
            return self._sessions.get(session_id)

    def close_session(self, session_id: str) -> bool:
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if not session:
            return False
        session.close()
        return True

    def close_all(self) -> None:
        with self._lock:
            items = list(self._sessions.values())
            self._sessions.clear()
        for session in items:
            session.close()


# --------------------------------------------------------------------------
# Аналитика дельт и форматирование отчёта для Агента
# --------------------------------------------------------------------------


def compare_animation_snapshots(before: Dict[str, Any], after: Dict[str, Any]) -> Dict[str, Any]:
    """Сравнивает два снимка аудита (до/после ожидания или клика), выявляя движение и изменения."""
    b_map = {item.get("selector"): item for item in (before.get("cssAnimatedElements") or []) if item.get("selector")}
    a_map = {item.get("selector"): item for item in (after.get("cssAnimatedElements") or []) if item.get("selector")}

    changed_elements: List[Dict[str, Any]] = []
    for sel, a in a_map.items():
        b = b_map.get(sel)
        if not b:
            changed_elements.append({"selector": sel, "change": "appeared"})
            continue
        diffs: List[str] = []
        if b.get("opacity") != a.get("opacity"):
            diffs.append(f"opacity {b.get('opacity')}→{a.get('opacity')}")
        if b.get("transform") != a.get("transform"):
            diffs.append("transform изменился")
        br, ar = b.get("rect") or {}, a.get("rect") or {}
        dx = int(ar.get("x", 0)) - int(br.get("x", 0))
        dy = int(ar.get("y", 0)) - int(br.get("y", 0))
        if abs(dx) >= 2 or abs(dy) >= 2:
            diffs.append(f"сдвиг ({dx:+d}, {dy:+d})px")
        if diffs:
            changed_elements.append({"selector": sel, "diffs": diffs})

    b_anim_times = {
        (a.get("name"), a.get("target")): a.get("currentTimeMs")
        for a in (before.get("webAnimations") or [])
    }
    progressed: List[str] = []
    stalled: List[str] = []
    for a in (after.get("webAnimations") or []):
        key = (a.get("name"), a.get("target"))
        t0 = b_anim_times.get(key)
        t1 = a.get("currentTimeMs")
        if t0 is not None and t1 is not None:
            if t1 > t0:
                progressed.append(f"{a.get('name')} ({a.get('target')}): {t0}→{t1}ms")
            elif a.get("playState") == "running" and t1 == t0:
                stalled.append(f"{a.get('name')} ({a.get('target')}): замерла на {t1}ms")

    return {
        "changedElements": changed_elements[:12],
        "progressedAnimations": progressed[:12],
        "stalledAnimations": stalled[:12],
    }


def format_inspection_report(
    action: str,
    audit_data: Dict[str, Any],
    *,
    delta: Optional[Dict[str, Any]] = None,
    eval_result: Any = None,
    action_note: str = "",
) -> Tuple[str, Dict[str, Any]]:
    """Формирует понятный отчёт для модели и компактную сводку для события UI."""
    dom = audit_data.get("dom") or {}
    tel = audit_data.get("telemetry") or {}

    url = str(dom.get("url") or "")
    title = str(dom.get("title") or "")
    vp = dom.get("viewport") or {}
    scroll = dom.get("scroll") or {}
    issues = list(dom.get("issues") or [])
    web_anims = list(dom.get("webAnimations") or [])
    css_anims = list(dom.get("cssAnimatedElements") or [])
    interactive = list(dom.get("interactive") or [])
    keyframes = list(dom.get("keyframes") or [])
    console_msgs = list(tel.get("consoleMessages") or [])
    page_errors = list(tel.get("pageErrors") or [])
    failed_reqs = list(tel.get("failedRequests") or [])

    errors_count = len(page_errors) + sum(1 for c in console_msgs if c.get("level") == "error") + len(failed_reqs)
    anims_count = max(len(web_anims), len(css_anims))
    issues_count = len(issues)

    lines: List[str] = [
        f"Интерактивный осмотр проекта ({action}): {url or '—'}" + (f" — «{title}»" if title else ""),
        f"Экран: {vp.get('width', '?')}×{vp.get('height', '?')} · скролл y={scroll.get('y', 0)}/{scroll.get('height', 0)} · reduced-motion: {'да' if dom.get('reducedMotion') else 'нет'}",
    ]
    if action_note:
        lines.append(f"Действие: {action_note}")
    if eval_result is not None:
        lines.append(f"Результат evaluate: {json.dumps(eval_result, ensure_ascii=False)[:1500]}")

    if page_errors:
        lines.append("JS-исключения:\n" + "\n".join(f"  - {e}" for e in page_errors[:6]))
    if console_msgs:
        lines.append("Консоль браузера:\n" + "\n".join(f"  - [{c['level']}] {c['text']}" for c in console_msgs[:8]))
    if failed_reqs:
        lines.append(
            "Ошибки сети:\n"
            + "\n".join(f"  - {r.get('status') or r.get('error')} {r.get('url')}" for r in failed_reqs[:8])
        )
    if issues:
        lines.append("Проблемы вёрстки/видимости:\n" + "\n".join(f"  - [{i.get('severity', 'info')}] {i.get('message')}" for i in issues))
    else:
        lines.append("Проблемы вёрстки/видимости: явных нарушений (переполнение, битые img, opacity:0) не найдено.")

    if web_anims or css_anims or keyframes:
        lines.append(f"Анимации и переходы (активных Web Animations: {len(web_anims)}, CSS-элементов с анимацией/переходом: {len(css_anims)}, @keyframes: {', '.join(keyframes[:10]) or 'нет'}):")
        for a in web_anims[:10]:
            lines.append(
                f"  - {a.get('kind')} `{a.get('name')}` на {a.get('target')}: {a.get('playState')}, "
                f"t={a.get('currentTimeMs')}ms / dur={a.get('durationMs')}ms, opacity={a.get('opacity')}"
                + (f", transform={a.get('transform')}" if a.get("transform") else "")
            )
        for c in css_anims[:10]:
            desc = " ".join(x for x in (c.get("animationName"), c.get("transition")) if x)
            lines.append(
                f"  - CSS `{desc}` на {c.get('selector')}: play={c.get('animationPlayState') or '—'}, "
                f"opacity={c.get('opacity')}, rect={c.get('rect')}"
            )
    else:
        lines.append("Анимации и переходы: ни Web Animations, ни CSS animation/transition на видимых элементах не обнаружены.")

    if delta:
        prog = delta.get("progressedAnimations") or []
        stal = delta.get("stalledAnimations") or []
        chg = delta.get("changedElements") or []
        lines.append(
            f"Динамика анимаций за интервал: двигаются={len(prog)}, замерли={len(stal)}, изменилось элементов={len(chg)}"
        )
        for item in stal[:6]:
            lines.append(f"  - ЗАМЕРЛА: {item}")
        for item in prog[:6]:
            lines.append(f"  - ПРОГРЕСС: {item}")
        for item in chg[:6]:
            lines.append(f"  - ИЗМЕНЕНИЕ {item.get('selector')}: {', '.join(item.get('diffs') or [str(item.get('change'))])}")

    if interactive:
        lines.append(
            "Интерактивные элементы на экране (для click/hover/type):\n"
            + "\n".join(
                f"  {i['index']}. <{i['tag']}> «{i['text']}» selector=`{i['selector']}` ({i['x']},{i['y']})"
                + (" [disabled]" if i.get("disabled") else "")
                for i in interactive[:18]
            )
        )

    if dom.get("textSnippet"):
        lines.append(f"Видимый текст страницы: {dom['textSnippet'][:400]}")

    summary_parts = [
        f"анимаций: {anims_count}",
        f"проблем: {issues_count}",
        f"ошибок: {errors_count}",
    ]
    if delta and delta.get("stalledAnimations"):
        summary_parts.append(f"замерших анимаций: {len(delta['stalledAnimations'])}")
    summary = ", ".join(summary_parts)

    meta = {
        "url": url,
        "title": title,
        "viewport": f"{vp.get('width', '?')}×{vp.get('height', '?')}",
        "animationsCount": anims_count,
        "issuesCount": issues_count,
        "errorsCount": errors_count,
        "summary": summary,
    }
    return "\n".join(lines), meta


def execute_browse_action(
    manager: BrowserSessionManager,
    args: Dict[str, Any],
    *,
    trust_level: str = "verified",
    approval_fn: Optional[Any] = None,
) -> Tuple[str, List[Dict[str, Any]]]:
    """Точка входа инструмента `browse_project`."""
    raw_action = str(args.get("action") or "").strip().lower()
    if not raw_action:
        raw_action = "open" if (args.get("url") or args.get("sandbox_project")) else "inspect_animations"
    if raw_action == "goto":
        raw_action = "open"

    session_id = str(args.get("session_id") or "default").strip()[:40] or "default"
    events: List[Dict[str, Any]] = []

    if raw_action == "close":
        closed = manager.close_session(session_id)
        return (
            f"Браузерная сессия «{session_id}» закрыта."
            if closed
            else f"Активной браузерной сессии «{session_id}» не было.",
            events,
        )

    existing = manager.get_existing(session_id)
    default_w = existing.width if existing else 1440
    default_h = existing.height if existing else 900
    width, height = normalize_viewport(
        args.get("viewport"),
        args.get("width"),
        args.get("height"),
        default_w=default_w,
        default_h=default_h,
    )

    try:
        wait_ms = max(0, min(5000, int(args.get("wait_ms") if args.get("wait_ms") is not None else 450)))
    except (TypeError, ValueError):
        wait_ms = 450

    target_url = str(args.get("url") or "").strip()
    sandbox_project = str(args.get("sandbox_project") or "").strip()

    if target_url and existing and existing.current_url and target_url.startswith(("/", "#")):
        target_url = urllib.parse.urljoin(existing.current_url, target_url)

    # Проверка внешнего адреса при уровне доверия verified (localhost и Sandbox открываются сразу).
    if target_url:
        target_url = validate_browser_url(target_url)
        if not is_local_url(target_url) and trust_level == "verified":
            parsed = urllib.parse.urlparse(target_url)
            origin = f"{parsed.scheme}://{parsed.netloc}"
            if not existing or origin not in existing.approved_external_origins:
                if approval_fn is None:
                    raise BrowserError("Для открытия внешнего сайта в режиме проверки требуется разрешение пользователя")
                decision = approval_fn(
                    {
                        "kind": "browser_inspect",
                        "title": f"Разрешить Агенту зайти на внешний сайт {parsed.netloc}?",
                        "description": f"Агент хочет открыть {target_url} в изолированном браузере и проверить вёрстку/анимации.",
                        "url": target_url,
                    }
                )
                if not decision.get("approved"):
                    return f"Пользователь отклонил открытие внешнего сайта {target_url}.", events
                if existing:
                    existing.approved_external_origins.add(origin)

    session = manager.get_or_create(session_id, width, height)
    if target_url and not is_local_url(target_url):
        parsed = urllib.parse.urlparse(target_url)
        session.approved_external_origins.add(f"{parsed.scheme}://{parsed.netloc}")

    if sandbox_project and not target_url:
        srv = session.static_servers.get(sandbox_project)
        if srv is None:
            srv = StaticSandboxServer(manager.sandbox_root, sandbox_project)
            session.static_servers[sandbox_project] = srv
        target_url = srv.url

    if raw_action == "open":
        if not target_url:
            raise BrowserError("Для action='open' укажите url (например http://127.0.0.1:8123) или sandbox_project")
        if (width, height) != (session.width, session.height):
            session.set_viewport(width, height)
        session.navigate(target_url, wait_ms=wait_ms)
        audit_data = session.audit()
        shot = session.capture_screenshot() if args.get("capture_screenshot", True) else ""
        report, meta = format_inspection_report("open", audit_data, action_note=f"Открыта страница {target_url}")
        events.append({
            "type": "browser_inspect",
            "action": "open",
            **meta,
            **({"_images": [shot], "preview": shot} if shot else {}),
        })
        return report, events

    # Для остальных действий страница уже должна быть открыта (или передали url/sandbox_project сразу).
    if not session.current_url:
        if target_url:
            session.navigate(target_url, wait_ms=300)
        else:
            raise BrowserError("Сначала откройте проект: browse_project(action='open', url='...' или sandbox_project='...')")

    cdp = session.ensure_cdp()
    known_actions = ("resize", "click", "hover", "type", "press", "scroll", "wait", "inspect_animations", "evaluate")
    if raw_action not in known_actions:
        raise BrowserError(
            f"Неизвестное действие '{raw_action}'. Доступно: open, click, hover, type, press, scroll, resize, wait, inspect_animations, evaluate, close"
        )

    action_note = ""
    delta_actions = ("click", "hover", "scroll", "wait", "inspect_animations", "resize")
    before_audit = session.audit() if raw_action in delta_actions else {}
    delta: Optional[Dict[str, Any]] = None
    extra_shots: List[str] = []
    eval_result: Any = None

    if raw_action == "resize":
        session.set_viewport(width, height)
        time.sleep(min(wait_ms, 1500) / 1000.0)
        action_note = f"Размер окна изменён на {width}×{height}"

    elif raw_action in ("click", "hover"):
        selector = str(args.get("selector") or "").strip()
        text_q = str(args.get("text") or "").strip()
        if args.get("x") is not None and args.get("y") is not None:
            try:
                tx, ty = int(args["x"]), int(args["y"])
            except (TypeError, ValueError) as err:
                raise BrowserError("Координаты x и y должны быть числами") from err
            target_desc = f"({tx}, {ty})"
        else:
            loc = cdp.evaluate(_js_locate_element(selector, text_q), await_promise=False) or {}
            if not isinstance(loc, dict) or loc.get("error"):
                raise BrowserError(str((loc or {}).get("error") if isinstance(loc, dict) else "Элемент не найден"))
            if "x" not in loc or "y" not in loc:
                raise BrowserError("Не удалось определить координаты элемента на странице")
            tx, ty = int(loc["x"]), int(loc["y"])
            target_desc = f"<{loc.get('tag')}> «{loc.get('text') or selector or text_q}» в ({tx}, {ty})"

        cdp.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": tx, "y": ty, "button": "none"})
        if raw_action == "click":
            cdp.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": tx, "y": ty, "button": "left", "clickCount": 1})
            cdp.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": tx, "y": ty, "button": "left", "clickCount": 1})
            action_note = f"Клик по {target_desc}"
        else:
            action_note = f"Наведение курсора на {target_desc}"
        if wait_ms > 0:
            time.sleep(wait_ms / 1000.0)

    elif raw_action == "type":
        selector = str(args.get("selector") or "").strip()
        text_val = str(args.get("text") or "")
        if selector:
            loc = cdp.evaluate(_js_locate_element(selector, ""), await_promise=False) or {}
            if not isinstance(loc, dict) or loc.get("error"):
                raise BrowserError(str((loc or {}).get("error") if isinstance(loc, dict) else "Элемент не найден"))
            if "x" not in loc or "y" not in loc:
                raise BrowserError("Не удалось определить координаты элемента ввода на странице")
            tx, ty = int(loc["x"]), int(loc["y"])
            cdp.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": tx, "y": ty, "button": "none"})
            cdp.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": tx, "y": ty, "button": "left", "clickCount": 1})
            cdp.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": tx, "y": ty, "button": "left", "clickCount": 1})
            if args.get("clear"):
                cdp.evaluate(
                    f"(() => {{ const el = document.querySelector({json.dumps(selector)}); if (el && 'value' in el) el.value = ''; }})()",
                    await_promise=False,
                )
        cdp.call("Input.insertText", {"text": text_val})
        if wait_ms > 0:
            time.sleep(min(wait_ms, 1500) / 1000.0)
        action_note = f"Введён текст «{text_val[:50]}»"

    elif raw_action == "press":
        key_raw = str(args.get("text") or args.get("key") or "Enter").strip()
        mapped = KEY_MAP.get(key_raw.lower(), (key_raw, key_raw, 0))
        key_val, code_val, vk = mapped
        cdp.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": key_val, "code": code_val, "windowsVirtualKeyCode": vk})
        cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": key_val, "code": code_val, "windowsVirtualKeyCode": vk})
        if wait_ms > 0:
            time.sleep(min(wait_ms, 1500) / 1000.0)
        action_note = f"Нажата клавиша {key_val}"

    elif raw_action == "scroll":
        selector = str(args.get("selector") or "").strip()
        direction = str(args.get("direction") or "down").strip().lower()
        if selector:
            loc = cdp.evaluate(_js_locate_element(selector, ""), await_promise=False) or {}
            if loc.get("error"):
                raise BrowserError(str(loc["error"]))
            action_note = f"Прокрутка к {selector}"
        elif args.get("scroll_y") is not None:
            try:
                sy = int(args["scroll_y"])
            except (TypeError, ValueError) as err:
                raise BrowserError("scroll_y должен быть числом") from err
            cdp.evaluate(f"window.scrollTo({{ top: {sy}, behavior: 'smooth' }})", await_promise=False)
            action_note = f"Прокрутка к y={sy}px"
        else:
            if direction == "top":
                cdp.evaluate("window.scrollTo({ top: 0, behavior: 'smooth' })", await_promise=False)
            elif direction == "bottom":
                cdp.evaluate("window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })", await_promise=False)
            elif direction == "up":
                cdp.evaluate(f"window.scrollBy({{ top: -{max(200, int(session.height * 0.75))}, behavior: 'smooth' }})", await_promise=False)
            else:
                cdp.evaluate(f"window.scrollBy({{ top: {max(200, int(session.height * 0.75))}, behavior: 'smooth' }})", await_promise=False)
            action_note = f"Прокрутка ({direction})"
        time.sleep(max(0.4, min(wait_ms, 3000) / 1000.0))

    elif raw_action == "wait":
        time.sleep(max(0.2, min(wait_ms or 800, 5000) / 1000.0))
        action_note = f"Ожидание {wait_ms}мс для проверки анимаций/загрузки"

    elif raw_action == "inspect_animations":
        if args.get("capture_screenshot", True):
            shot0 = session.capture_screenshot()
            if shot0:
                extra_shots.append(shot0)
        sample_ms = max(250, min(wait_ms or 600, 3000))
        time.sleep(sample_ms / 1000.0)
        action_note = f"Замер анимаций и переходов (интервал {sample_ms}мс)"

    elif raw_action == "evaluate":
        script = str(args.get("script") or "").strip()
        if not script:
            raise BrowserError("Для action='evaluate' укажите script")
        await_promise = bool(args.get("await_promise", True))
        eval_result = cdp.evaluate(script[:8000], await_promise=await_promise, timeout=8.0)
        action_note = "Выполнен инспектирующий скрипт"

    audit_data = session.audit()
    if raw_action in ("click", "hover", "scroll", "wait", "inspect_animations", "resize"):
        delta = compare_animation_snapshots(before_audit.get("dom") or {}, audit_data.get("dom") or {})

    if args.get("capture_screenshot", True):
        shot1 = session.capture_screenshot()
        if shot1:
            extra_shots.append(shot1)

    report, meta = format_inspection_report(
        raw_action,
        audit_data,
        delta=delta,
        eval_result=eval_result,
        action_note=action_note,
    )
    preview = extra_shots[-1] if extra_shots else ""
    events.append({
        "type": "browser_inspect",
        "action": raw_action,
        **meta,
        **({"_images": extra_shots[:2], "preview": preview} if extra_shots else {}),
    })
    return report, events


# --------------------------------------------------------------------------
# Самопроверка без внешнего интернета и дисплея
# --------------------------------------------------------------------------


def self_test() -> int:
    checks: List[bool] = []

    def check(name: str, condition: bool) -> None:
        checks.append(bool(condition))
        print("{} {}".format("OK  " if condition else "FAIL", name))

    with tempfile.TemporaryDirectory() as tmp:
        sb_root = sandbox_mod.get_sandbox_root(tmp + "/sb")
        sandbox_mod.write_file(sb_root, "anim-demo/index.html", "<h1>Анимация</h1>")

        # 1. Статический сервер Sandbox отдаёт файлы проекта и не выходит за границы.
        srv = StaticSandboxServer(sb_root, "anim-demo")
        try:
            with urllib.request.urlopen(srv.url, timeout=3) as resp:
                html = resp.read().decode("utf-8")
            escaped = False
            try:
                StaticSandboxServer(sb_root, "../outside")
            except sandbox_mod.SandboxError:
                escaped = True
            check("StaticSandboxServer отдаёт проект из Sandbox и блокирует выход наружу", "Анимация" in html and escaped)
        finally:
            srv.close()

        # 2. Сравнение дельт анимаций обнаруживает замершие и активные анимации.
        before = {
            "cssAnimatedElements": [{"selector": ".hero", "opacity": "0", "transform": "none", "rect": {"x": 0, "y": 100, "w": 200, "h": 50}}],
            "webAnimations": [
                {"name": "fadeIn", "target": ".hero", "playState": "running", "currentTimeMs": 100},
                {"name": "pulse", "target": ".btn", "playState": "running", "currentTimeMs": 50},
            ],
        }
        after = {
            "cssAnimatedElements": [{"selector": ".hero", "opacity": "1", "transform": "matrix(1,0,0,1,0,0)", "rect": {"x": 0, "y": 80, "w": 200, "h": 50}}],
            "webAnimations": [
                {"name": "fadeIn", "target": ".hero", "playState": "running", "currentTimeMs": 500},
                {"name": "pulse", "target": ".btn", "playState": "running", "currentTimeMs": 50},
            ],
        }
        delta = compare_animation_snapshots(before, after)
        check(
            "compare_animation_snapshots фиксирует прогресс, замершую анимацию и изменение opacity/rect",
            len(delta["progressedAnimations"]) == 1
            and len(delta["stalledAnimations"]) == 1
            and len(delta["changedElements"]) == 1
            and "opacity 0→1" in delta["changedElements"][0]["diffs"],
        )

        # 3. Проверка RFC 6455 WebSocket + CDPClient против локального mock-сервера CDP.
        ws_ready = threading.Event()
        ws_port_box = {"port": 0}
        received_methods: List[str] = []

        def mock_cdp_server() -> None:
            srv_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            srv_sock.bind(("127.0.0.1", 0))
            srv_sock.listen(2)
            ws_port_box["port"] = srv_sock.getsockname()[1]
            ws_ready.set()
            conn, _ = srv_sock.accept()
            with conn:
                buf = b""
                while b"\r\n\r\n" not in buf:
                    buf += conn.recv(4096)
                hdr = buf.decode("latin1")
                m = re.search(r"Sec-WebSocket-Key:\s*(\S+)", hdr, re.IGNORECASE)
                key = m.group(1) if m else ""
                accept = base64.b64encode(
                    hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
                ).decode("ascii")
                conn.sendall(
                    (
                        "HTTP/1.1 101 Switching Protocols\r\n"
                        "Upgrade: websocket\r\n"
                        "Connection: Upgrade\r\n"
                        f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
                    ).encode("ascii")
                )

                def send_ws(obj: Dict[str, Any]) -> None:
                    raw = json.dumps(obj).encode("utf-8")
                    hdr_out = bytearray([0x81])
                    if len(raw) < 126:
                        hdr_out.append(len(raw))
                    else:
                        hdr_out.append(126)
                        hdr_out.extend(struct.pack("!H", len(raw)))
                    conn.sendall(bytes(hdr_out) + raw)

                rb = bytearray()
                while True:
                    try:
                        while len(rb) < 2:
                            chunk = conn.recv(4096)
                            if not chunk:
                                return
                            rb.extend(chunk)
                        b1, b2 = rb[0], rb[1]
                        del rb[:2]
                        opcode = b1 & 0x0F
                        if opcode == 0x8:
                            return
                        length = b2 & 0x7F
                        if length == 126:
                            while len(rb) < 2:
                                chunk = conn.recv(4096)
                                if not chunk:
                                    return
                                rb.extend(chunk)
                            (length,) = struct.unpack("!H", bytes(rb[:2]))
                            del rb[:2]
                        mask = bytes(rb[:4])
                        del rb[:4]
                        while len(rb) < length:
                            chunk = conn.recv(4096)
                            if not chunk:
                                return
                            rb.extend(chunk)
                        data = bytes(rb[i] ^ mask[i % 4] for i in range(length))
                        del rb[:length]
                    except OSError:
                        return
                    req = json.loads(data.decode("utf-8"))
                    method = str(req.get("method") or "")
                    received_methods.append(method)
                    mid = req["id"]
                    if method == "Page.navigate":
                        send_ws({"id": mid, "result": {"frameId": "f1"}})
                        send_ws({
                            "method": "Runtime.consoleAPICalled",
                            "params": {"type": "error", "args": [{"value": "TypeError: animation target null"}]},
                        })
                        continue
                    if method == "Runtime.evaluate":
                        expr = str((req.get("params") or {}).get("expression") or "")
                        if expr == "document.readyState":
                            send_ws({"id": mid, "result": {"result": {"value": "complete"}}})
                        elif "animations" in expr.lower() or "scrollWidth" in expr:
                            send_ws({
                                "id": mid,
                                "result": {
                                    "result": {
                                        "value": {
                                            "url": "http://127.0.0.1:8123/",
                                            "title": "Demo",
                                            "viewport": {"width": 1440, "height": 900},
                                            "scroll": {"x": 0, "y": 0, "width": 1440, "height": 1800},
                                            "issues": [{"kind": "stuck_opacity_zero", "severity": "error", "message": "Блок .card остался на opacity:0"}],
                                            "webAnimations": [{"kind": "css-animation", "name": "slideUp", "playState": "running", "currentTimeMs": 120, "durationMs": 600, "target": ".hero", "opacity": "1"}],
                                            "cssAnimatedElements": [],
                                            "keyframes": ["slideUp"],
                                            "interactive": [{"index": 1, "tag": "button", "text": "Открыть меню", "selector": "#menu-btn", "x": 100, "y": 40}],
                                            "reducedMotion": False,
                                            "textSnippet": "Привет",
                                        }
                                    }
                                },
                            })
                        else:
                            send_ws({"id": mid, "result": {"result": {"value": {"ok": True, "tag": "button", "text": "Открыть меню", "x": 100, "y": 40}}}})
                    elif method == "Page.captureScreenshot":
                        send_ws({"id": mid, "result": {"data": base64.b64encode(b"FAKEJPEG").decode("ascii")}})
                    else:
                        send_ws({"id": mid, "result": {}})
            srv_sock.close()

        t = threading.Thread(target=mock_cdp_server, daemon=True)
        t.start()
        ws_ready.wait(3)
        cdp = CDPClient(f"ws://127.0.0.1:{ws_port_box['port']}/devtools/page/1")
        try:
            mgr = BrowserSessionManager(sandbox_root=sb_root)
            sess = BrowserSession(cdp=cdp, width=1440, height=900)
            mgr._sessions["default"] = sess
            report, evs = execute_browse_action(
                mgr,
                {"action": "open", "url": "http://127.0.0.1:8123/", "wait_ms": 10},
                trust_level="verified",
            )
            check(
                "browse_project (open + CDP) собирает аудит анимаций, консоль, элементы и скриншот",
                "slideUp" in report
                and "TypeError: animation target null" in report
                and "#menu-btn" in report
                and len(evs) == 1
                and evs[0]["type"] == "browser_inspect"
                and evs[0]["animationsCount"] == 1
                and evs[0]["errorsCount"] == 1
                and evs[0].get("_images") == ["data:image/jpeg;base64,RkFLRUpQRUc="],
            )
            click_rep, click_evs = execute_browse_action(
                mgr,
                {"action": "click", "selector": "#menu-btn", "wait_ms": 10},
                trust_level="verified",
            )
            check(
                "browse_project (click) отправляет Input.dispatchMouseEvent и возвращает обновлённый отчёт",
                "Input.dispatchMouseEvent" in received_methods
                and "Клик по <button> «Открыть меню»" in click_rep
                and len(click_evs) == 1,
            )
            mgr.close_all()
        finally:
            cdp.close()

        # 4. Внешний адрес при verified требует подтверждения пользователя.
        mgr2 = BrowserSessionManager(sandbox_root=sb_root)
        ext_asked: List[Dict[str, Any]] = []
        denied_rep, denied_evs = execute_browse_action(
            mgr2,
            {"action": "open", "url": "https://example.com"},
            trust_level="verified",
            approval_fn=lambda req: (ext_asked.append(req) or {"approved": False}),
        )
        check(
            "внешний URL при trust=verified запрашивает разрешение на сайте перед открытием",
            len(ext_asked) == 1 and ext_asked[0]["kind"] == "browser_inspect" and "отклонил" in denied_rep and denied_evs == [],
        )

    passed = sum(1 for c in checks if c)
    print(f"\n{passed}/{len(checks)} проверок браузерного инспектора пройдено")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    raise SystemExit(self_test())
