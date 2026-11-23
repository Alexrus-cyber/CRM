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
import importlib.util
import inspect
import ipaddress
import json
import mimetypes
import os
import platform
import re
import secrets
import shutil
import signal
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

    def __init__(self, message: str, *, trace: Optional[List[str]] = None) -> None:
        super().__init__(message)
        self.trace: List[str] = list(trace or [])


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
    except Exception as err:  # noqa: BLE001
        _browser_log(f"Ошибка опроса реестра Windows для поиска браузеров: {err}")
    return found


_BROWSER_LOG_LOCK = threading.Lock()


def _browser_log(msg: str) -> None:
    """Пишет шаг BrowserInspector в stderr (видно в терминале и журнале Лаунчера) без падения на сломанном pipe."""
    line = f"[browser] {time.strftime('%H:%M:%S')} {msg}"
    with _BROWSER_LOG_LOCK:
        stream = getattr(sys, "stderr", None)
        if stream is None:
            return
        try:
            stream.write(line + "\n")
            stream.flush()
        except UnicodeEncodeError:
            try:
                enc = getattr(stream, "encoding", None) or "utf-8"
                stream.write((line + "\n").encode(enc, errors="replace").decode(enc, errors="replace"))
                stream.flush()
            except Exception:  # noqa: BLE001
                pass
        except Exception:  # noqa: BLE001
            pass


def _emit_step(
    on_status: Optional[Any],
    msg: str,
    *,
    trace: Optional[List[str]] = None,
    started_at: Optional[float] = None,
    log_console: bool = True,
) -> None:
    """Фиксирует действие BrowserInspector в консоли, списке шагов и live-статусе интерфейса."""
    text = str(msg or "").strip()
    if not text:
        return
    if trace is not None:
        if started_at is not None:
            elapsed = max(0.0, time.monotonic() - started_at)
            entry = f"[+{elapsed:.2f}s] {text}"
        else:
            entry = text
        if not trace or trace[-1] != entry:
            trace.append(entry)
    if log_console:
        _browser_log(text)
    if on_status is not None:
        try:
            on_status(text)
        except Exception as err:  # noqa: BLE001
            _browser_log(f"Сбой callback on_status: {err}")


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


def find_browser_candidates(*, allow_subprocess: bool = True, limit: int = 8) -> List[str]:
    """Возвращает список установленных Chromium / Chrome / Edge в порядке приоритета."""
    found_list: List[str] = []
    seen_norm: set[str] = set()

    def _add(raw_path: Optional[str]) -> bool:
        if not raw_path:
            return False
        cleaned = str(raw_path).strip().strip('"')
        if not cleaned:
            return False
        p = Path(cleaned)
        if not _safe_is_file(p):
            return False
        try:
            norm = str(p.resolve()).lower()
        except OSError:
            norm = str(p).lower()
        if norm in seen_norm:
            return False
        seen_norm.add(norm)
        found_list.append(str(p))
        return len(found_list) >= max(1, limit)

    for env_key in (
        "AGENT_BROWSER_PATH",
        "CHROME_PATH",
        "CHROME_BIN",
        "CHROMIUM_PATH",
        "EDGE_PATH",
        "PUPPETEER_EXECUTABLE_PATH",
    ):
        if _add(os.environ.get(env_key)):
            return found_list

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
        if _add(found):
            return found_list

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
        if _add(str(path)):
            return found_list

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
                if _add(str(match)):
                    return found_list

    # Изолированный короткий probe пакета playwright без конфликта с asyncio-loop и pipe-зависаний.
    # В frozen exe (PyInstaller) sys.executable не принимает `-c` и запускает второй экземпляр exe.
    if allow_subprocess and not getattr(sys, "frozen", False) and not found_list:
        probe_dir: Optional[Path] = None
        try:
            if importlib.util.find_spec("playwright") is not None:
                probe_dir = Path(tempfile.mkdtemp(prefix="crm-pw-probe-"))
                out_file = probe_dir / "exe.txt"
                probe_kwargs: Dict[str, Any] = {
                    "stdin": subprocess.DEVNULL,
                    "stderr": subprocess.DEVNULL,
                }
                if system == "Windows":
                    probe_kwargs["creationflags"] = (
                        getattr(subprocess, "CREATE_NO_WINDOW", 0)
                        | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                    )
                else:
                    probe_kwargs["start_new_session"] = True
                with open(out_file, "wb") as out_fh:
                    probe_proc = subprocess.Popen(
                        [
                            sys.executable,
                            "-c",
                            "from playwright.sync_api import sync_playwright\nwith sync_playwright() as p: print(p.chromium.executable_path or '')",
                        ],
                        stdout=out_fh,
                        **probe_kwargs,
                    )
                deadline = time.monotonic() + 3.5
                while probe_proc.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.05)
                if probe_proc.poll() is None:
                    _kill_proc_tree(probe_proc)
                elif probe_proc.returncode == 0 and out_file.is_file():
                    raw_out = out_file.read_text(encoding="utf-8", errors="ignore").strip()
                    exe = raw_out.splitlines()[-1].strip() if raw_out else ""
                    _add(exe)
        except Exception as err:  # noqa: BLE001
            _browser_log(f"Ошибка проверки Playwright Chromium: {err}")
        finally:
            if probe_dir is not None:
                shutil.rmtree(probe_dir, ignore_errors=True)

    return found_list


def find_browser_executable(*, allow_subprocess: bool = True) -> Optional[str]:
    """Ищет первый подходящий Chromium / Chrome / Edge (включая реестр Windows и кеш Playwright)."""
    found = find_browser_candidates(allow_subprocess=allow_subprocess, limit=1)
    return found[0] if found else None


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
        self.is_directory_listing = False
        self.has_package_json = False
        if resolved.is_file():
            serve_dir = resolved.parent
            default_file = "/" + resolved.name
        elif resolved.is_dir():
            serve_dir = resolved
            default_file = "/"
            self.has_package_json = (resolved / "package.json").is_file()
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
                    elif not html_files:
                        self.is_directory_listing = True
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
        self._write_lock = threading.Lock()
        self._buf = bytearray()
        self._assembled = bytearray()
        self._assembling_text = False
        self.closed = False

        try:
            try:
                self._sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
            self._sock.settimeout(timeout)

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
            # Периодический timeout чтения позволяет reader-потоку быстро реагировать на закрытие сокета.
            self._sock.settimeout(2.0)
        except Exception:
            self.closed = True
            try:
                self._sock.close()
            except OSError:
                pass
            raise

    def _read_exact(self, n: int, *, continuation: bool = False) -> bytes:
        if n <= 0:
            return b""
        mid_frame = bool(continuation or self._buf or n > 2)
        deadline = time.monotonic() + (20.0 if mid_frame else 2.0)
        while len(self._buf) < n:
            if self.closed:
                raise EOFError("WebSocket closed")
            try:
                chunk = self._sock.recv(max(4096, n - len(self._buf)))
            except (TimeoutError, socket.timeout):
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
        if length:
            repeated = mask_key * ((length // 4) + 1)
            masked = bytes(a ^ b for a, b in zip(payload, repeated))
        else:
            masked = b""
        with self._write_lock:
            if self.closed:
                raise BrowserError("Соединение с браузером закрыто")
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
                repeated = mask * ((len(data) // 4) + 1)
                data = bytes(a ^ b for a, b in zip(data, repeated))

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
            acquired = self._write_lock.acquire(timeout=0.25)
            try:
                self._sock.settimeout(0.35)
                mask_key = secrets.token_bytes(4)
                self._sock.sendall(bytes([0x88, 0x80]) + mask_key)
            except Exception:  # noqa: BLE001
                pass
            finally:
                if acquired:
                    self._write_lock.release()
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
                except (TimeoutError, socket.timeout):
                    continue
                except Exception as err:  # noqa: BLE001
                    if not self._ws.closed:
                        _browser_log(f"CDP reader loop завершён ({type(err).__name__}: {err})")
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

    def _dismiss_dialog_async(self) -> None:
        def _run() -> None:
            try:
                self.call("Page.handleJavaScriptDialog", {"accept": True}, timeout=3.0)
            except Exception as err:  # noqa: BLE001
                _browser_log(f"Не удалось автоматически закрыть JS-диалог: {err}")

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

    def call(
        self,
        method: str,
        params: Optional[Dict[str, Any]] = None,
        timeout: float = 20.0,
        *,
        cancel_check: Optional[Any] = None,
    ) -> Dict[str, Any]:
        with self._lock:
            th = getattr(self, "_thread", None)
            if self._ws.closed or (th is not None and not th.is_alive()):
                raise BrowserError(f"Соединение с браузером закрыто перед {method}")
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

        deadline = time.monotonic() + max(0.1, float(timeout))
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                with self._lock:
                    self._pending.pop(msg_id, None)
                raise BrowserError(f"Браузер не ответил на {method} за {int(timeout)} с")
            step_wait = min(0.25, remaining) if cancel_check is not None else remaining
            if ev.wait(step_wait):
                break
            if cancel_check and cancel_check():
                with self._lock:
                    self._pending.pop(msg_id, None)
                raise BrowserError("Осмотр в браузере отменён пользователем")

        with self._lock:
            slot = self._pending.pop(msg_id, None)
        msg = (slot or {}).get("msg")
        if not msg:
            raise BrowserError(f"Соединение с браузером оборвалось на {method}")
        if msg.get("error"):
            err = msg["error"]
            raise BrowserError(f"CDP {method}: {err.get('message') or err}")
        return msg.get("result") or {}

    def evaluate(
        self,
        expression: str,
        *,
        await_promise: bool = True,
        timeout: float = 15.0,
        cancel_check: Optional[Any] = None,
    ) -> Any:
        res = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": await_promise,
            },
            timeout=timeout,
            cancel_check=cancel_check,
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
  const tStart = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
  const overBudget = () => Boolean(tStart && (performance.now() - tStart) > 900);
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  const docEl = document.documentElement;
  const body = document.body;
  const scrollWidth = docEl ? docEl.scrollWidth : 0;
  const scrollHeight = docEl ? docEl.scrollHeight : 0;
  const esc = (s) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/([^\w-])/g, "\\$1"));

  function makeSelector(el) {
    if (!el || !el.tagName) return "";
    const tag = el.tagName.toLowerCase();
    if (el.id) return "#" + esc(el.id);
    const dt = el.getAttribute("data-testid");
    if (dt) return `${tag}[data-testid="${esc(dt)}"]`;
    const aria = el.getAttribute("aria-label");
    if (aria && aria.length <= 40) return `${tag}[aria-label="${aria.replace(/"/g, '\\"')}"]`;
    const cls = typeof el.className === "string"
      ? el.className.trim().split(/\s+/).filter((c) => c && !c.includes(":") && !c.includes("[")).slice(0, 2)
      : [];
    let base = tag + (cls.length ? "." + cls.map((c) => esc(c)).join(".") : "");
    const parent = el.parentElement;
    if (parent && parent.children && parent.children.length <= 60) {
      let sameCount = 0;
      let myIdx = 0;
      for (let i = 0; i < parent.children.length; i++) {
        const ch = parent.children[i];
        if (ch.tagName === el.tagName) {
          sameCount += 1;
          if (ch === el) myIdx = sameCount;
        }
      }
      if (sameCount > 1 && myIdx > 0) base += `:nth-of-type(${myIdx})`;
    }
    return base.slice(0, 90);
  }

  function cleanText(el) {
    if (!el) return "";
    const raw = (el.childElementCount <= 8 ? el.textContent : "")
      || el.getAttribute("aria-label")
      || el.getAttribute("placeholder")
      || el.getAttribute("title")
      || "";
    return String(raw).replace(/\s+/g, " ").trim().slice(0, 70);
  }

  function hasDirectOrSmallContent(el) {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
    }
    if (el.childElementCount <= 12 && (el.textContent || "").trim().length > 0) return true;
    return Boolean(el.querySelector && el.querySelector("img,svg,canvas,video,button,input"));
  }

  function extractSnippet(root, limit) {
    if (!root) return "";
    const parts = [];
    let total = 0;
    try {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      let steps = 0;
      while ((node = tw.nextNode()) && total < limit && steps < 1500) {
        steps += 1;
        const p = node.parentElement;
        if (p) {
          const tn = p.tagName;
          if (tn === "SCRIPT" || tn === "STYLE" || tn === "NOSCRIPT" || tn === "TEMPLATE") continue;
        }
        const txt = String(node.nodeValue || "").replace(/\s+/g, " ").trim();
        if (!txt) continue;
        parts.push(txt);
        total += txt.length + 1;
      }
    } catch {}
    return parts.join(" ").slice(0, limit);
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
  const walkRoot = body || docEl;
  if (walkRoot) {
    try {
      const walker = document.createTreeWalker(walkRoot, NodeFilter.SHOW_ELEMENT);
      let el = walker.currentNode;
      let scanned = 0;
      while (el && scanned < 800) {
        if ((scanned & 63) === 63 && overBudget()) break;
        scanned += 1;
        if (!SKIP_TAGS.has(el.tagName)) {
          let st = null;
          try { st = getComputedStyle(el); } catch {}
          if (st && st.display !== "none") {
            const rect = el.getBoundingClientRect();
            const sel = makeSelector(el);

            if (rect.width > 0 && rect.height > 0 && rect.right > vw + 4 && overflowItems.length < 6) {
              overflowItems.push({ selector: sel, right: Math.round(rect.right), width: Math.round(rect.width) });
            }

            const inViewport = rect.width >= 24 && rect.height >= 24 && rect.bottom > 0 && rect.top < vh;
            if (inViewport && parseFloat(st.opacity) === 0 && el !== body && el !== docEl && stuckInvisible.length < 8) {
              if (hasDirectOrSmallContent(el)) {
                stuckInvisible.push({
                  selector: sel,
                  text: cleanText(el),
                  animationName: st.animationName,
                  transition: st.transitionProperty !== "all" || st.transitionDuration !== "0s" ? `${st.transitionProperty} ${st.transitionDuration}` : "",
                });
              }
            }

            if (el.tagName === "IMG") {
              if (el.complete && el.naturalWidth === 0 && brokenImages.length < 8) {
                brokenImages.push({ src: String(el.getAttribute("src") || "").slice(0, 120), alt: String(el.getAttribute("alt") || "").slice(0, 50) });
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
        }
        el = walker.nextNode();
      }
    } catch {}
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

  let webAnims = [];
  try {
    webAnims = (typeof document.getAnimations === "function" ? document.getAnimations() : []).slice(0, 40).map((a) => {
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
  } catch {}

  const pausedAnims = webAnims.filter((a) => a.playState === "paused");
  if (pausedAnims.length) {
    issues.push({
      kind: "paused_animations",
      severity: "warning",
      message: `Анимации на паузе (${pausedAnims.length}): ` + pausedAnims.map((a) => `${a.name} (${a.target})`).join(", "),
    });
  }

  try {
    const interactiveCandidates = document.querySelectorAll(
      "a[href], button, input, select, textarea, summary, [role='button'], [role='tab'], [onclick]"
    );
    const candLen = Math.min(interactiveCandidates.length, 300);
    for (let i = 0; i < candLen; i++) {
      if (interactive.length >= 35 || ((i & 31) === 31 && overBudget())) break;
      const el = interactiveCandidates[i];
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
  } catch {}

  const reducedMotion = Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const keyframesFound = [];
  const keyframesSeen = new Set();
  try {
    const sheets = document.styleSheets;
    let totalRules = 0;
    for (let s = 0; s < sheets.length && s < 25; s++) {
      if (overBudget() || totalRules >= 3000 || keyframesFound.length >= 25) break;
      let rules;
      try { rules = sheets[s].cssRules; } catch { continue; }
      if (!rules) continue;
      const maxR = Math.min(rules.length, 1200);
      for (let r = 0; r < maxR && totalRules < 3000; r++) {
        totalRules += 1;
        if ((totalRules & 127) === 127 && overBudget()) break;
        const rule = rules[r];
        if (rule && rule.type === CSSRule.KEYFRAMES_RULE && rule.name && !keyframesSeen.has(rule.name)) {
          keyframesSeen.add(rule.name);
          keyframesFound.push(rule.name);
          if (keyframesFound.length >= 25) break;
        }
      }
    }
  } catch {}

  return {
    url: location.href,
    title: document.title || "",
    viewport: { width: vw, height: vh },
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY), width: scrollWidth, height: scrollHeight },
    textSnippet: extractSnippet(body || docEl, 700),
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
      const pool = document.querySelectorAll("button, a, [role='button'], [role='tab'], summary, label, input");
      for (let i = 0; i < pool.length && i < 400; i++) {{
        const n = pool[i];
        const t = (n.textContent || n.getAttribute("aria-label") || "").trim().toLowerCase();
        if (t.includes(q)) {{ el = n; break; }}
      }}
      if (!el && document.body) {{
        const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let node = tw.currentNode;
        let seen = 0;
        while (node && seen < 600) {{
          seen += 1;
          if (node.childElementCount <= 6) {{
            const t = (node.textContent || node.getAttribute("aria-label") || "").trim().toLowerCase();
            if (t.includes(q)) {{ el = node; break; }}
          }}
          node = tw.nextNode();
        }}
      }}
    }} else {{
      try {{ el = document.querySelector(selector); }} catch (e) {{ return {{ error: "Некорректный CSS-селектор: " + selector }}; }}
    }}
  }}
  if (!el && wantedText) {{
    const pool = document.querySelectorAll("button, a, [role='button'], [role='tab'], summary, input, textarea, select, label, div, span");
    for (let i = 0; i < pool.length && i < 500; i++) {{
      const n = pool[i];
      if (n.childElementCount > 12) continue;
      const st = getComputedStyle(n);
      if (st.display === "none" || st.visibility === "hidden") continue;
      const r = n.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const t = (n.textContent || n.getAttribute("aria-label") || n.getAttribute("placeholder") || "").replace(/\\s+/g, " ").trim().toLowerCase();
      if (t === wantedText || t.includes(wantedText)) {{ el = n; break; }}
    }}
  }}
  if (!el) return {{ error: "Элемент не найден на странице" }};
  el.scrollIntoView({{ block: "center", inline: "center", behavior: "instant" }});
  const rect = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  return {{
    ok: true,
    tag: el.tagName.toLowerCase(),
    text: String(el.textContent || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 80),
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
                try:
                    proc.wait(timeout=1.5)
                except Exception:  # noqa: BLE001
                    pass
            else:
                pg_killed = False
                try:
                    pgid = os.getpgid(proc.pid)
                    if pgid and pgid != os.getpgrp():
                        os.killpg(pgid, signal.SIGTERM)
                        pg_killed = True
                except Exception:  # noqa: BLE001
                    pg_killed = False
                if not pg_killed:
                    proc.terminate()
                try:
                    proc.wait(timeout=1.5)
                except subprocess.TimeoutExpired:
                    if pg_killed:
                        try:
                            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                        except Exception:  # noqa: BLE001
                            proc.kill()
                    else:
                        proc.kill()
                    try:
                        proc.wait(timeout=1.0)
                    except Exception:  # noqa: BLE001
                        pass
    except Exception:  # noqa: BLE001
        pass


def _linux_userns_restricted() -> bool:
    if platform.system() != "Linux":
        return False
    try:
        p = Path("/proc/sys/kernel/unprivileged_userns_clone")
        if p.is_file() and p.read_text(encoding="utf-8", errors="ignore").strip() == "0":
            return True
    except OSError:
        pass
    try:
        aa = Path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
        if aa.is_file() and aa.read_text(encoding="utf-8", errors="ignore").strip() == "1":
            return True
    except OSError:
        pass
    return False


def _read_stderr_log_lines(log_path: Path) -> List[str]:
    try:
        if not log_path.is_file():
            return []
        raw = log_path.read_text(encoding="utf-8", errors="replace")
        return [ln.strip() for ln in raw.splitlines() if ln.strip()][-40:]
    except OSError:
        return []


def _extract_ws_endpoint_from_lines(lines: List[str]) -> Tuple[str, int]:
    for line in lines:
        m = re.search(r"DevTools listening on ws://(\[[^\]]+\]|[^:]+):(\d+)/", line)
        if m:
            host = m.group(1)
            port = int(m.group(2))
            if host.lower() == "localhost":
                host = "127.0.0.1"
            if port > 0:
                return host, port
    return "", 0


def _extract_ws_port_from_lines(lines: List[str]) -> int:
    _host, port = _extract_ws_endpoint_from_lines(lines)
    return port


def _read_browser_diag_tail(user_data: Path) -> List[str]:
    lines: List[str] = []
    for name in ("browser-stderr.log", "chrome_debug.log"):
        lines.extend(_read_stderr_log_lines(user_data / name))
    return lines[-8:]


def _has_env_proxy() -> bool:
    return any(
        bool(os.environ.get(var))
        for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")
    )


def _launch_headless_chromium(
    executable: str,
    width: int,
    height: int,
    *,
    cancel_check: Optional[Any] = None,
    on_status: Optional[Any] = None,
    trace: Optional[List[str]] = None,
    started_at: Optional[float] = None,
    force_disable_gpu: Optional[bool] = None,
) -> Tuple[subprocess.Popen[Any], Path, int]:
    """Запускает headless Chromium без блокировки pipe; при сбое пробует `--headless`, SwiftShader и `--no-sandbox`."""
    is_windows = platform.system() == "Windows"
    exe_name = Path(executable).name
    is_headless_shell = "headless" in exe_name.lower()
    is_root = not is_windows and hasattr(os, "geteuid") and os.geteuid() == 0
    needs_no_sandbox = is_root or _linux_userns_restricted()

    # На Windows `--headless=new` + `--disable-gpu` без SwiftShader часто вешает Viz / `Page.captureScreenshot`,
    # поэтому на Windows сначала пробуем нативный ANGLE/D3D11 (без `--disable-gpu`), затем SwiftShader, затем `--no-sandbox`.
    if is_headless_shell:
        if is_windows:
            base_attempts = [
                ("--headless", 9.0, needs_no_sandbox, False),
                ("--headless", 9.0, True, True),
            ]
        else:
            base_attempts = [
                ("--headless", 9.0, needs_no_sandbox, True),
            ]
    elif is_windows:
        base_attempts = [
            ("--headless=new", 12.0, needs_no_sandbox, False),
            ("--headless=new", 10.0, needs_no_sandbox, True),
            ("--headless", 9.0, True, True),
        ]
    else:
        base_attempts = [
            ("--headless=new", 9.0, needs_no_sandbox, True),
            ("--headless", 7.0, needs_no_sandbox, True),
        ]
    if not is_windows and not needs_no_sandbox:
        # Fallback для контейнеров / Linux без user namespaces / AppArmor.
        base_attempts.append(("--headless" if is_headless_shell else "--headless=new", 8.5, True, True))

    if force_disable_gpu is not None:
        filtered = [a for a in base_attempts if a[3] is force_disable_gpu]
        if filtered:
            base_attempts = filtered

    last_error: Optional[Exception] = None
    skip_non_nosandbox = False
    proxy_flag = (
        "--proxy-bypass-list=<-loopback>;10.0.0.0/8;172.16.0.0/12;192.168.0.0/16;*.local"
        if _has_env_proxy()
        else "--no-proxy-server"
    )

    total_attempts = len(base_attempts)
    for idx, (headless_flag, startup_timeout, use_no_sandbox, disable_gpu) in enumerate(base_attempts, 1):
        if skip_non_nosandbox and not use_no_sandbox:
            continue
        if cancel_check and cancel_check():
            raise BrowserError("Осмотр в браузере отменён пользователем")

        gpu_label = "SwiftShader" if disable_gpu else "D3D11/ANGLE"
        sb_label = "no-sandbox" if use_no_sandbox else "sandbox"
        _emit_step(
            on_status,
            f"Запускаю {exe_name} (попытка {idx}/{total_attempts}: {headless_flag}, {gpu_label}, {sb_label})…",
            trace=trace,
            started_at=started_at,
        )

        user_data = Path(tempfile.mkdtemp(prefix="crm-browser-"))
        stderr_log = user_data / "browser-stderr.log"
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
            "--no-service-autorun",
            "--noerrdialogs",
            "--password-store=basic",
            "--use-mock-keychain",
            proxy_flag,
            "--no-pings",
            "--metrics-recording-only",
            "--enable-automation",
            "--disable-background-mode",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-translate",
            "--disable-extensions",
            "--disable-component-update",
            "--disable-default-apps",
            "--disable-popup-blocking",
            "--disable-client-side-phishing-detection",
            "--disable-domain-reliability",
            "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,PaintHolding,AutoDeElevate,HttpsUpgrades,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,BackForwardCache",
            "--disable-hang-monitor",
            "--disable-renderer-accessibility",
            "--disable-ipc-flooding-protection",
            "--disable-dev-shm-usage",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
            "--mute-audio",
        ]
        if disable_gpu:
            cmd.extend(["--disable-gpu", "--disable-gpu-sandbox"])
            if is_windows:
                cmd.extend(["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            else:
                cmd.append("--enable-unsafe-swiftshader")
        else:
            cmd.append("--enable-unsafe-swiftshader")
        if use_no_sandbox:
            cmd.extend(["--no-sandbox", "--disable-setuid-sandbox"])
        cmd.append("about:blank")

        popen_kwargs: Dict[str, Any] = {
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
        }
        if is_windows:
            popen_kwargs["creationflags"] = (
                getattr(subprocess, "CREATE_NO_WINDOW", 0)
                | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            )
        else:
            popen_kwargs["start_new_session"] = True

        # Пишем stderr в файл, а не в PIPE — исключаем deadlock close() при выживших дочерних процессах.
        try:
            with open(stderr_log, "wb") as err_fh:
                proc = subprocess.Popen(cmd, stderr=err_fh, **popen_kwargs)
        except OSError as err:
            shutil.rmtree(user_data, ignore_errors=True)
            last_error = BrowserError(f"Не удалось запустить {executable}: {err}")
            _emit_step(on_status, f"Ошибка старта {exe_name}: {err}", trace=trace, started_at=started_at)
            continue

        launch_t0 = time.monotonic()
        last_beat = launch_t0
        _emit_step(
            on_status,
            f"Процесс {exe_name} запущен (PID={proc.pid}), жду CDP-порт…",
            trace=trace,
            started_at=started_at,
        )

        deadline = launch_t0 + startup_timeout
        port_file = user_data / "DevToolsActivePort"
        crashed = False
        while time.monotonic() < deadline:
            if cancel_check and cancel_check():
                _emit_step(on_status, f"Отмена: останавливаю PID={proc.pid}…", trace=trace, started_at=started_at)
                _kill_proc_tree(proc)
                shutil.rmtree(user_data, ignore_errors=True)
                raise BrowserError("Осмотр в браузере отменён пользователем")
            if proc.poll() is not None:
                diag_lines = _read_browser_diag_tail(user_data)
                err_tail = " | ".join(diag_lines[-5:])
                lower_tail = err_tail.lower()
                if not use_no_sandbox and any(
                    tok in lower_tail for tok in ("sandbox", "zygote", "namespace", "userns", "suid", "trapped")
                ):
                    skip_non_nosandbox = True
                _kill_proc_tree(proc)
                shutil.rmtree(user_data, ignore_errors=True)
                msg_err = f"Браузер сразу завершился (код {proc.returncode}): {err_tail or 'нет вывода в логе'}"
                last_error = BrowserError(msg_err)
                _emit_step(on_status, f"Попытка {idx} завершилась с ошибкой: {msg_err[:180]}", trace=trace, started_at=started_at)
                crashed = True
                break
            stderr_lines = _read_stderr_log_lines(stderr_log)
            if not stderr_lines and (user_data / "chrome_debug.log").is_file():
                stderr_lines = _read_stderr_log_lines(user_data / "chrome_debug.log")
            ws_host, stderr_port = _extract_ws_endpoint_from_lines(stderr_lines)
            if stderr_port > 0:
                if ws_host:
                    try:
                        (user_data / ".cdp_host").write_text(ws_host, encoding="utf-8")
                    except OSError:
                        pass
                _emit_step(
                    on_status,
                    f"CDP-порт {stderr_port} открыт ({ws_host or '127.0.0.1'}, {time.monotonic() - launch_t0:.2f} с)",
                    trace=trace,
                    started_at=started_at,
                )
                return proc, user_data, stderr_port
            if port_file.is_file():
                try:
                    lines = port_file.read_text(encoding="utf-8", errors="ignore").splitlines()
                    first_line = lines[0].strip() if lines else ""
                    if first_line.isdigit() and int(first_line) > 0:
                        detected_port = int(first_line)
                        _emit_step(
                            on_status,
                            f"CDP-порт {detected_port} получен из DevToolsActivePort ({time.monotonic() - launch_t0:.2f} с)",
                            trace=trace,
                            started_at=started_at,
                        )
                        return proc, user_data, detected_port
                except (IndexError, OSError):
                    pass
            now_t = time.monotonic()
            if now_t - last_beat >= 2.0:
                last_beat = now_t
                _emit_step(
                    on_status,
                    f"Жду инициализации CDP-порта {exe_name} ({now_t - launch_t0:.1f} с, PID={proc.pid})…",
                    trace=trace,
                    started_at=started_at,
                )
            time.sleep(0.08)

        if not crashed:
            diag_tail = " | ".join(_read_browser_diag_tail(user_data)[-4:])
            _kill_proc_tree(proc)
            shutil.rmtree(user_data, ignore_errors=True)
            timeout_msg = f"Таймаут запуска headless-браузера CDP за {startup_timeout:.0f} с" + (
                f" ({diag_tail})" if diag_tail else ""
            )
            last_error = BrowserError(timeout_msg)
            _emit_step(on_status, f"Попытка {idx}: {timeout_msg[:180]}", trace=trace, started_at=started_at)

    if last_error is not None:
        raise last_error
    raise BrowserError("Таймаут запуска headless-браузера CDP")


def _normalize_ws_host(ws_url: str, connected_host: str) -> str:
    try:
        parsed = urllib.parse.urlparse(ws_url)
        if (parsed.hostname or "").lower() == "localhost" and connected_host in ("127.0.0.1", "[::1]"):
            host_clean = connected_host.strip("[]")
            netloc = f"[{host_clean}]:{parsed.port}" if ":" in host_clean else f"{host_clean}:{parsed.port}"
            return urllib.parse.urlunparse(parsed._replace(netloc=netloc))
    except Exception:  # noqa: BLE001
        pass
    return ws_url


def _ordered_cdp_hosts(user_data_dir: Optional[Path]) -> Tuple[str, ...]:
    if user_data_dir:
        try:
            hint_file = user_data_dir / ".cdp_host"
            if hint_file.is_file():
                hinted = hint_file.read_text(encoding="utf-8", errors="ignore").strip()
                if hinted == "[::1]":
                    return ("[::1]", "127.0.0.1")
                if hinted == "127.0.0.1":
                    return ("127.0.0.1", "[::1]")
        except OSError:
            pass
    return ("127.0.0.1", "[::1]")


def _find_page_ws_url(
    port: int,
    user_data_dir: Optional[Path] = None,
    *,
    cancel_check: Optional[Any] = None,
    on_status: Optional[Any] = None,
    trace: Optional[List[str]] = None,
    started_at: Optional[float] = None,
) -> str:
    deadline = time.monotonic() + 6.5
    last_err = ""
    last_create_attempt = 0.0
    hosts = _ordered_cdp_hosts(user_data_dir)
    logged_probe = False
    while time.monotonic() < deadline:
        if cancel_check and cancel_check():
            raise BrowserError("Осмотр в браузере отменён пользователем")
        for host in hosts:
            if cancel_check and cancel_check():
                raise BrowserError("Осмотр в браузере отменён пользователем")
            try:
                if not logged_probe:
                    logged_probe = True
                    _emit_step(
                        on_status,
                        f"Запрашиваю список вкладок CDP: http://{host}:{port}/json/list…",
                        trace=trace,
                        started_at=started_at,
                    )
                with _LOCAL_OPENER.open(f"http://{host}:{port}/json/list", timeout=0.8) as resp:
                    targets = json.loads(resp.read().decode("utf-8"))
                for item in targets:
                    if item.get("type") == "page" and item.get("webSocketDebuggerUrl"):
                        ws = _normalize_ws_host(str(item["webSocketDebuggerUrl"]), host)
                        _emit_step(on_status, f"Найдена вкладка CDP: {ws}", trace=trace, started_at=started_at)
                        return ws
                now = time.monotonic()
                if now - last_create_attempt >= 0.5:
                    last_create_attempt = now
                    _emit_step(
                        on_status,
                        f"Открытых вкладок нет — создаю новую вкладку CDP ({host}:{port})…",
                        trace=trace,
                        started_at=started_at,
                    )
                    for method in ("PUT", "GET"):
                        try:
                            req = urllib.request.Request(
                                f"http://{host}:{port}/json/new?about:blank",
                                method=method,
                            )
                            with _LOCAL_OPENER.open(req, timeout=0.9) as new_resp:
                                created = json.loads(new_resp.read().decode("utf-8"))
                            if isinstance(created, dict) and created.get("webSocketDebuggerUrl"):
                                ws = _normalize_ws_host(str(created["webSocketDebuggerUrl"]), host)
                                _emit_step(on_status, f"Создана вкладка CDP: {ws}", trace=trace, started_at=started_at)
                                return ws
                        except Exception:  # noqa: BLE001
                            continue
                    # Fallback через browser WebSocket (`Target.createTarget`) для сборок без `/json/new`.
                    try:
                        browser_ws = ""
                        try:
                            with _LOCAL_OPENER.open(f"http://{host}:{port}/json/version", timeout=0.8) as v_resp:
                                v_info = json.loads(v_resp.read().decode("utf-8"))
                            browser_ws = str(v_info.get("webSocketDebuggerUrl") or "")
                        except Exception:  # noqa: BLE001
                            if user_data_dir and (user_data_dir / "DevToolsActivePort").is_file():
                                lines = (user_data_dir / "DevToolsActivePort").read_text(encoding="utf-8", errors="ignore").splitlines()
                                if len(lines) >= 2 and lines[1].strip():
                                    browser_ws = f"ws://{host}:{port}{lines[1].strip()}"
                        if browser_ws:
                            _emit_step(
                                on_status,
                                f"Создаю вкладку через Target.createTarget ({browser_ws})…",
                                trace=trace,
                                started_at=started_at,
                            )
                            b_cdp = CDPClient(_normalize_ws_host(browser_ws, host))
                            try:
                                res = b_cdp.call(
                                    "Target.createTarget",
                                    {"url": "about:blank"},
                                    timeout=2.5,
                                    cancel_check=cancel_check,
                                )
                                target_id = str(res.get("targetId") or "")
                                if target_id:
                                    ws = f"ws://{host}:{port}/devtools/page/{target_id}"
                                    _emit_step(on_status, f"Создана вкладка Target.createTarget: {ws}", trace=trace, started_at=started_at)
                                    return ws
                            finally:
                                b_cdp.close()
                    except Exception as err:  # noqa: BLE001
                        _browser_log(f"Fallback Target.createTarget не удался: {err}")
            except Exception as error:  # noqa: BLE001
                last_err = str(error)
        time.sleep(0.08)
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


def _check_cancelled(cancel_check: Optional[Any]) -> None:
    if cancel_check and cancel_check():
        raise BrowserError("Осмотр в браузере отменён пользователем")


def _sleep_interruptible(seconds: float, cancel_check: Optional[Any] = None) -> None:
    if seconds <= 0:
        _check_cancelled(cancel_check)
        return
    if cancel_check is None:
        time.sleep(seconds)
        return
    deadline = time.monotonic() + seconds
    while True:
        _check_cancelled(cancel_check)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(0.1, remaining))


class BrowserSession:
    """Одна интерактивная вкладка Chromium/Chrome с историей телеметрии и скриншотами."""

    def __init__(
        self,
        *,
        cdp: Optional[CDPClient] = None,
        proc: Optional[subprocess.Popen[Any]] = None,
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
        self._screenshots_disabled_at = 0.0
        self._last_screenshot_bytes = 0
        self._last_screenshot_suspicious = False

    @classmethod
    def launch(
        cls,
        width: int = 1440,
        height: int = 900,
        *,
        on_status: Optional[Any] = None,
        cancel_check: Optional[Any] = None,
        trace: Optional[List[str]] = None,
        started_at: Optional[float] = None,
    ) -> "BrowserSession":
        t0 = started_at if started_at is not None else time.monotonic()
        _check_cancelled(cancel_check)
        _emit_step(on_status, "Ищу браузер Chromium / Chrome / Edge…", trace=trace, started_at=t0)
        exe = find_browser_executable()
        if not exe:
            _emit_step(on_status, "Браузер Chromium / Chrome / Edge не найден", trace=trace, started_at=t0)
            raise BrowserError(
                "На машине не найден браузер Chromium / Chrome / Edge для интерактивного осмотра проекта. "
                "Установите Chrome/Edge или Playwright Chromium (npx playwright install chromium) "
                "либо задайте переменную окружения AGENT_BROWSER_PATH."
            )
        _emit_step(on_status, f"Найден браузер: {exe}", trace=trace, started_at=t0)

        # Список запасных установленных браузеров на случай, если основной заблокирован политикой/GPU.
        exe_candidates: List[str] = [exe]
        if (
            getattr(find_browser_executable, "_mock_name", None) is None
            or getattr(find_browser_candidates, "_mock_name", None) is not None
        ):
            for alt in find_browser_candidates(allow_subprocess=False, limit=4):
                if alt not in exe_candidates:
                    exe_candidates.append(alt)

        try:
            launch_sig = inspect.signature(_launch_headless_chromium)
            launch_params = launch_sig.parameters
            launch_accepts_varkw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in launch_params.values())
        except (TypeError, ValueError):
            launch_params = {}  # type: ignore[assignment]
            launch_accepts_varkw = False

        try:
            ws_sig = inspect.signature(_find_page_ws_url)
            ws_params = ws_sig.parameters
            ws_accepts_varkw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in ws_params.values())
        except (TypeError, ValueError):
            ws_params = {}  # type: ignore[assignment]
            ws_accepts_varkw = False

        def _call_launch_helper(target_exe: str, force_disable_gpu: Optional[bool] = None) -> Tuple[subprocess.Popen[Any], Path, int]:
            kw: Dict[str, Any] = {}
            if cancel_check is not None and (launch_accepts_varkw or "cancel_check" in launch_params):
                kw["cancel_check"] = cancel_check
            if on_status is not None and (launch_accepts_varkw or "on_status" in launch_params):
                kw["on_status"] = on_status
            if trace is not None and (launch_accepts_varkw or "trace" in launch_params):
                kw["trace"] = trace
            if launch_accepts_varkw or "started_at" in launch_params:
                kw["started_at"] = t0
            if force_disable_gpu is not None and (launch_accepts_varkw or "force_disable_gpu" in launch_params):
                kw["force_disable_gpu"] = force_disable_gpu
            return _launch_headless_chromium(target_exe, width, height, **kw)

        def _call_find_ws(port_num: int, user_dir: Path) -> str:
            kw: Dict[str, Any] = {"user_data_dir": user_dir}
            if cancel_check is not None and (ws_accepts_varkw or "cancel_check" in ws_params):
                kw["cancel_check"] = cancel_check
            if on_status is not None and (ws_accepts_varkw or "on_status" in ws_params):
                kw["on_status"] = on_status
            if trace is not None and (ws_accepts_varkw or "trace" in ws_params):
                kw["trace"] = trace
            if ws_accepts_varkw or "started_at" in ws_params:
                kw["started_at"] = t0
            return _find_page_ws_url(port_num, **kw)

        is_mocked_launch = getattr(_launch_headless_chromium, "_mock_name", None) is not None
        last_error: Optional[Exception] = None

        for exe_idx, candidate_exe in enumerate(exe_candidates):
            if exe_idx > 0:
                _emit_step(
                    on_status,
                    f"Основной браузер не запустился — пробую запасной: {candidate_exe}…",
                    trace=trace,
                    started_at=t0,
                )
            gpu_modes: List[Optional[bool]] = (
                [None, True]
                if (platform.system() == "Windows" and not is_mocked_launch)
                else [None]
            )
            for mode_idx, gpu_mode in enumerate(gpu_modes):
                if mode_idx > 0:
                    _emit_step(
                        on_status,
                        f"Повтор запуска {Path(candidate_exe).name} с принудительным SwiftShader…",
                        trace=trace,
                        started_at=t0,
                    )
                _check_cancelled(cancel_check)
                _emit_step(on_status, "Запускаю headless-браузер…", trace=trace, started_at=t0)
                try:
                    proc, user_data, port = _call_launch_helper(candidate_exe, force_disable_gpu=gpu_mode)
                except BrowserError as err:
                    _check_cancelled(cancel_check)
                    last_error = err
                    if gpu_mode is None and mode_idx + 1 < len(gpu_modes) and "swiftshader" not in str(err).lower():
                        _emit_step(
                            on_status,
                            f"Запуск {Path(candidate_exe).name} не удался ({err}) — пробую принудительный SwiftShader…",
                            trace=trace,
                            started_at=t0,
                        )
                        continue
                    break

                cdp: Optional[CDPClient] = None
                try:
                    _check_cancelled(cancel_check)
                    _emit_step(
                        on_status,
                        f"Подключаюсь к браузеру по CDP (порт {port})…",
                        trace=trace,
                        started_at=t0,
                    )
                    ws_url = _call_find_ws(port, user_data)
                    ws_t0 = time.monotonic()
                    _emit_step(
                        on_status,
                        f"Устанавливаю WebSocket CDP соединение ({ws_url})…",
                        trace=trace,
                        started_at=t0,
                    )
                    cdp = CDPClient(ws_url)
                    _emit_step(
                        on_status,
                        f"WebSocket CDP подключён ({(time.monotonic() - ws_t0) * 1000:.0f} мс), активирую домены…",
                        trace=trace,
                        started_at=t0,
                    )
                    cdp.call("Page.enable", timeout=10.0, cancel_check=cancel_check)
                    cdp.call("Runtime.enable", timeout=10.0, cancel_check=cancel_check)
                    try:
                        cdp.call(
                            "Network.enable",
                            {"maxTotalBufferSize": 1048576, "maxResourceBufferSize": 524288},
                            timeout=10.0,
                            cancel_check=cancel_check,
                        )
                    except BrowserError as net_err:
                        _check_cancelled(cancel_check)
                        if "invalid" in str(net_err).lower() or "parameter" in str(net_err).lower():
                            cdp.call("Network.enable", timeout=10.0, cancel_check=cancel_check)
                        else:
                            raise
                    cdp.call(
                        "Emulation.setDeviceMetricsOverride",
                        {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": width <= 500},
                        timeout=10.0,
                        cancel_check=cancel_check,
                    )
                    _emit_step(
                        on_status,
                        f"Домены CDP и viewport {width}×{height} готовы",
                        trace=trace,
                        started_at=t0,
                    )
                    return cls(cdp=cdp, proc=proc, user_data_dir=user_data, width=width, height=height)
                except Exception as err:
                    if cdp is not None:
                        try:
                            cdp.close()
                        except Exception:  # noqa: BLE001
                            pass
                    _kill_proc_tree(proc)
                    shutil.rmtree(user_data, ignore_errors=True)
                    _check_cancelled(cancel_check)
                    last_error = err
                    _emit_step(
                        on_status,
                        f"Сбой инициализации CDP: {err}",
                        trace=trace,
                        started_at=t0,
                    )

        if last_error is not None:
            raise last_error
        raise BrowserError("Не удалось запустить headless-браузер CDP")

    def is_alive(self) -> bool:
        if self.cdp is None or self.cdp._ws.closed:
            return False
        th = getattr(self.cdp, "_thread", None)
        if th is not None and not th.is_alive():
            return False
        if self.proc is not None and self.proc.poll() is not None:
            return False
        return True

    def ensure_cdp(self) -> CDPClient:
        if not self.cdp or self.cdp._ws.closed:
            raise BrowserError("Браузерная сессия не запущена или соединение оборвалось")
        th = getattr(self.cdp, "_thread", None)
        if th is not None and not th.is_alive():
            raise BrowserError("Поток чтения браузера CDP завершился неожиданно")
        if self.proc is not None and self.proc.poll() is not None:
            raise BrowserError("Процесс браузера завершился неожиданно")
        return self.cdp

    def set_viewport(
        self,
        width: int,
        height: int,
        *,
        cancel_check: Optional[Any] = None,
        on_status: Optional[Any] = None,
        trace: Optional[List[str]] = None,
        started_at: Optional[float] = None,
    ) -> None:
        self.width = width
        self.height = height
        cdp = self.ensure_cdp()
        _emit_step(
            on_status,
            f"Устанавливаю viewport {width}×{height}…",
            trace=trace,
            started_at=started_at,
        )
        if cancel_check is not None:
            cdp.call(
                "Emulation.setDeviceMetricsOverride",
                {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": width <= 500},
                timeout=10.0,
                cancel_check=cancel_check,
            )
        else:
            cdp.call(
                "Emulation.setDeviceMetricsOverride",
                {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": width <= 500},
                timeout=10.0,
            )

    def navigate(
        self,
        url: str,
        wait_ms: int = 450,
        *,
        on_status: Optional[Any] = None,
        cancel_check: Optional[Any] = None,
        trace: Optional[List[str]] = None,
        started_at: Optional[float] = None,
    ) -> None:
        _check_cancelled(cancel_check)
        # Новый URL может нормально рендериться даже если на предыдущей странице captureScreenshot зависал.
        self._screenshots_disabled = False
        self._screenshots_disabled_at = 0.0
        self._last_screenshot_bytes = 0
        self._last_screenshot_suspicious = False
        _emit_step(on_status, f"Открываю страницу {url}…", trace=trace, started_at=started_at)
        cdp = self.ensure_cdp()
        cdp.clear_telemetry()
        nav_res = (
            cdp.call("Page.navigate", {"url": url}, timeout=10.0, cancel_check=cancel_check)
            if cancel_check is not None
            else cdp.call("Page.navigate", {"url": url}, timeout=10.0)
        )
        if nav_res.get("errorText"):
            raise BrowserError(f"Браузер не смог открыть {url}: {nav_res['errorText']}")
        _emit_step(on_status, "Page.navigate выполнен, жду готовности DOM…", trace=trace, started_at=started_at)
        start = time.monotonic()
        last_beat = start
        deadline = start + 8.0
        interactive_since: Optional[float] = None
        consecutive_eval_timeouts = 0
        final_state = "unknown"
        while time.monotonic() < deadline:
            _check_cancelled(cancel_check)
            remaining = max(0.5, deadline - time.monotonic())
            try:
                state = cdp.evaluate(
                    "document.readyState",
                    await_promise=False,
                    timeout=min(2.0, remaining),
                    cancel_check=cancel_check,
                )
                consecutive_eval_timeouts = 0
                final_state = str(state or "unknown")
                if state == "complete":
                    break
                if state == "interactive":
                    if interactive_since is None:
                        interactive_since = time.monotonic()
                        _emit_step(
                            on_status,
                            "DOM загружен (readyState=interactive), дожидаюсь ресурсов…",
                            trace=trace,
                            started_at=started_at,
                        )
                    # Если DOM уже готов > 2.0с (например, завис внешний шрифт/аналитика), продолжаем.
                    elif time.monotonic() - interactive_since >= 2.0:
                        _emit_step(
                            on_status,
                            "DOM готов >2 с при зависшем внешнем ресурсе — перехожу к аудиту",
                            trace=trace,
                            started_at=started_at,
                        )
                        break
                elif time.monotonic() - start >= 4.5:
                    # Если заблокирован внешний скрипт в <head>, но DOM уже присутствует — не ждём полный таймаут.
                    has_dom = cdp.evaluate(
                        "Boolean(document.body && document.body.children && document.body.children.length > 0)",
                        await_promise=False,
                        timeout=1.5,
                        cancel_check=cancel_check,
                    )
                    if has_dom:
                        with cdp._lock:
                            cdp.console_messages.append({
                                "level": "warning",
                                "text": "Внешний ресурс задерживает readyState=loading (>4.5с); аудит выполнен по текущему DOM.",
                            })
                        _emit_step(
                            on_status,
                            "Внешний ресурс держит readyState=loading (>4.5 с), но DOM готов — продолжаю",
                            trace=trace,
                            started_at=started_at,
                        )
                        break
                now_t = time.monotonic()
                if now_t - last_beat >= 1.5:
                    last_beat = now_t
                    _emit_step(
                        on_status,
                        f"Загрузка страницы (readyState={final_state}, {now_t - start:.1f} с)…",
                        trace=trace,
                        started_at=started_at,
                    )
            except BrowserError as err:
                _check_cancelled(cancel_check)
                # Если браузер или CDP-соединение умерло — не крутим цикл ожидания до deadline.
                self.ensure_cdp()
                err_low = str(err).lower()
                if "не ответил" in err_low or "timeout" in err_low:
                    consecutive_eval_timeouts += 1
                    _emit_step(
                        on_status,
                        f"Ожидание document.readyState не ответило ({consecutive_eval_timeouts}/2)…",
                        trace=trace,
                        started_at=started_at,
                    )
                    if consecutive_eval_timeouts >= 2 and time.monotonic() - start >= 3.0:
                        break
            _sleep_interruptible(0.15, cancel_check)
        _emit_step(
            on_status,
            f"Страница готова (readyState={final_state}, {time.monotonic() - start:.2f} с)",
            trace=trace,
            started_at=started_at,
        )
        if wait_ms > 0:
            clamped_wait = min(wait_ms, 5000)
            _emit_step(
                on_status,
                f"Выдерживаю паузу {clamped_wait} мс для анимаций/гидрации…",
                trace=trace,
                started_at=started_at,
            )
            _sleep_interruptible(clamped_wait / 1000.0, cancel_check)
        self.current_url = url

    _SCREENSHOT_COOLDOWN_SEC = 45.0

    def capture_screenshot(
        self,
        *,
        cancel_check: Optional[Any] = None,
        on_status: Optional[Any] = None,
        trace: Optional[List[str]] = None,
        started_at: Optional[float] = None,
    ) -> str:
        _check_cancelled(cancel_check)
        if self._screenshots_disabled:
            disabled_at = float(getattr(self, "_screenshots_disabled_at", 0.0) or 0.0)
            if disabled_at and (time.monotonic() - disabled_at) >= self._SCREENSHOT_COOLDOWN_SEC:
                self._screenshots_disabled = False
                self._screenshots_disabled_at = 0.0
                _emit_step(
                    on_status,
                    "Сбрасываю блокировку скриншотов после паузы — пробую снова…",
                    trace=trace,
                    started_at=started_at,
                )
            else:
                _emit_step(
                    on_status,
                    "Скриншоты отключены для этой сессии (предыдущий вызов Page.captureScreenshot завис)",
                    trace=trace,
                    started_at=started_at,
                )
                return ""
        self._last_screenshot_bytes = 0
        self._last_screenshot_suspicious = False
        attempts: List[Tuple[Dict[str, Any], float, str]] = [
            ({"format": "jpeg", "quality": 76, "fromSurface": True, "optimizeForSpeed": True}, 4.5, "fromSurface=True"),
            ({"format": "jpeg", "quality": 76, "fromSurface": False}, 3.0, "fromSurface=False"),
        ]
        fallback_tiny: Optional[Tuple[str, int]] = None

        def _finish_shot(b64_data: str, shot_elapsed_ms: float) -> str:
            raw_len = (len(b64_data) * 3) // 4
            size_lbl = f"{raw_len} Б" if raw_len < 1024 else f"{max(1, raw_len // 1024)} КБ"
            is_real_img = b64_data.startswith(("/9j/", "iVBOR"))
            suspicious = bool(is_real_img and 0 < raw_len < 2048)
            self._last_screenshot_bytes = raw_len
            self._last_screenshot_suspicious = suspicious
            suffix = " (предупреждение: пустой/слишком маленький кадр)" if suspicious else ""
            _emit_step(
                on_status,
                f"Скриншот получен ({size_lbl} за {shot_elapsed_ms:.0f} мс){suffix}",
                trace=trace,
                started_at=started_at,
            )
            return f"data:image/jpeg;base64,{b64_data}"

        try:
            cdp = self.ensure_cdp()
            for idx, (params, shot_timeout, label) in enumerate(attempts):
                shot_t0 = time.monotonic()
                _emit_step(
                    on_status,
                    f"Выполняю Page.captureScreenshot ({label}, таймаут {shot_timeout:.1f} с)…",
                    trace=trace,
                    started_at=started_at,
                )
                try:
                    if cancel_check is not None:
                        res = cdp.call("Page.captureScreenshot", params, timeout=shot_timeout, cancel_check=cancel_check)
                    else:
                        res = cdp.call("Page.captureScreenshot", params, timeout=shot_timeout)
                    b64 = str(res.get("data") or "")
                    if b64:
                        raw_len = (len(b64) * 3) // 4
                        is_real_img = b64.startswith(("/9j/", "iVBOR"))
                        if idx == 0 and is_real_img and 0 < raw_len < 2048 and self.is_alive():
                            fallback_tiny = (b64, raw_len)
                            _emit_step(
                                on_status,
                                f"Скриншот ({raw_len} Б) подозрительно мал — проверяю fallback fromSurface=False…",
                                trace=trace,
                                started_at=started_at,
                            )
                            continue
                        if fallback_tiny is not None and raw_len <= fallback_tiny[1]:
                            return _finish_shot(fallback_tiny[0], (time.monotonic() - shot_t0) * 1000.0)
                        return _finish_shot(b64, (time.monotonic() - shot_t0) * 1000.0)
                    if fallback_tiny is not None:
                        return _finish_shot(fallback_tiny[0], (time.monotonic() - shot_t0) * 1000.0)
                    _emit_step(
                        on_status,
                        f"Page.captureScreenshot ({label}) вернул пустые данные",
                        trace=trace,
                        started_at=started_at,
                    )
                    return ""
                except BrowserError as err:
                    _check_cancelled(cancel_check)
                    msg = str(err).lower()
                    if idx == 0 and ("invalid" in msg or "parameter" in msg):
                        # Старые сборки Chromium/Edge не принимают optimizeForSpeed.
                        _emit_step(
                            on_status,
                            "Повтор Page.captureScreenshot без optimizeForSpeed…",
                            trace=trace,
                            started_at=started_at,
                        )
                        try:
                            fallback_params = {"format": "jpeg", "quality": 76, "fromSurface": True}
                            res = (
                                cdp.call("Page.captureScreenshot", fallback_params, timeout=4.0, cancel_check=cancel_check)
                                if cancel_check is not None
                                else cdp.call("Page.captureScreenshot", fallback_params, timeout=4.0)
                            )
                            b64 = str(res.get("data") or "")
                            if b64:
                                return _finish_shot(b64, (time.monotonic() - shot_t0) * 1000.0)
                            return ""
                        except BrowserError:
                            _check_cancelled(cancel_check)
                    _emit_step(
                        on_status,
                        f"Page.captureScreenshot ({label}) не удался: {err}",
                        trace=trace,
                        started_at=started_at,
                    )
                    if idx == 0 and self.is_alive():
                        continue
                    if fallback_tiny is not None:
                        return _finish_shot(fallback_tiny[0], (time.monotonic() - shot_t0) * 1000.0)
                    raise
        except BrowserError as err:
            _check_cancelled(cancel_check)
            # Не тормозим последующие шаги в этой сессии, если captureScreenshot заблокирован/таймаутится.
            self._screenshots_disabled = True
            self._screenshots_disabled_at = time.monotonic()
            _emit_step(
                on_status,
                f"Скриншот пропущен ({err}) — продолжаю без изображения",
                trace=trace,
                started_at=started_at,
            )
            return ""
        return ""

    def audit(
        self,
        *,
        cancel_check: Optional[Any] = None,
        on_status: Optional[Any] = None,
        trace: Optional[List[str]] = None,
        started_at: Optional[float] = None,
    ) -> Dict[str, Any]:
        _check_cancelled(cancel_check)
        cdp = self.ensure_cdp()
        dom_audit: Dict[str, Any] = {}
        audit_t0 = time.monotonic()
        _emit_step(on_status, "Запускаю Runtime.evaluate(AUDIT_JS)…", trace=trace, started_at=started_at)
        for attempt in range(2):
            try:
                if cancel_check is not None:
                    dom_audit = cdp.evaluate(AUDIT_JS, await_promise=False, timeout=8.0, cancel_check=cancel_check) or {}
                else:
                    dom_audit = cdp.evaluate(AUDIT_JS, await_promise=False, timeout=8.0) or {}
                break
            except BrowserError as err:
                _check_cancelled(cancel_check)
                self.ensure_cdp()
                msg = str(err).lower()
                if attempt == 0 and ("context" in msg or "destroyed" in msg or "navigation" in msg):
                    _emit_step(
                        on_status,
                        "Контекст страницы обновился (навигация) — повторяю DOM-аудит…",
                        trace=trace,
                        started_at=started_at,
                    )
                    _sleep_interruptible(0.35, cancel_check)
                    continue
                if "не ответил" in msg or "timeout" in msg:
                    # Страница могла повесить свой главный JS-поток (например, бесконечный цикл);
                    # возвращаем телеметрию и явную диагностику вместо зависания/ретраев инструмента.
                    _emit_step(
                        on_status,
                        "JS-поток страницы не ответил на DOM-аудит за 8 с — сохраняю телеметрию без падения",
                        trace=trace,
                        started_at=started_at,
                    )
                    dom_audit = {
                        "url": self.current_url,
                        "title": "",
                        "viewport": {"width": self.width, "height": self.height},
                        "scroll": {"x": 0, "y": 0, "width": self.width, "height": self.height},
                        "textSnippet": "",
                        "issues": [
                            {
                                "kind": "js_main_thread_blocked",
                                "severity": "error",
                                "message": (
                                    "JS-поток страницы не ответил на DOM-аудит за 8 с "
                                    "(возможен бесконечный цикл, тяжёлый синхронный рендер или зависший скрипт)."
                                ),
                            }
                        ],
                        "interactive": [],
                    }
                    break
                raise
        telemetry = cdp.snapshot_telemetry()
        _emit_step(
            on_status,
            (
                f"DOM-аудит завершён ({(time.monotonic() - audit_t0) * 1000:.0f} мс: "
                f"интерактивных={len(dom_audit.get('interactive') or [])}, "
                f"проблем={len(dom_audit.get('issues') or [])}, "
                f"ошибок JS={len(telemetry.get('pageErrors') or [])}, "
                f"сеть={len(telemetry.get('failedRequests') or [])})"
            ),
            trace=trace,
            started_at=started_at,
        )
        return {
            "dom": dom_audit,
            "telemetry": telemetry,
        }

    def close(self) -> None:
        if self.proc is not None or self.cdp is not None:
            _browser_log(f"Закрываю сессию браузера (PID={getattr(self.proc, 'pid', None)})")
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

    MAX_SESSIONS = 4

    def __init__(self, sandbox_root: Path = sandbox_mod.get_sandbox_root()) -> None:
        self.sandbox_root = sandbox_root
        self._lock = threading.Lock()
        self._sessions: Dict[str, BrowserSession] = {}
        self._last_used: Dict[str, float] = {}

    def get_or_create(
        self,
        session_id: str,
        width: int,
        height: int,
        *,
        on_status: Optional[Any] = None,
        cancel_check: Optional[Any] = None,
        trace: Optional[List[str]] = None,
        started_at: Optional[float] = None,
    ) -> BrowserSession:
        _check_cancelled(cancel_check)
        stale: Optional[BrowserSession] = None
        evicted: List[Tuple[str, BrowserSession]] = []
        preserved_origins: set[str] = set()
        now = time.monotonic()
        with self._lock:
            session = self._sessions.get(session_id)
            if session is not None:
                if session.is_alive():
                    self._last_used[session_id] = now
                    _emit_step(
                        on_status,
                        f"Переиспользую активную сессию «{session_id}» ({session.current_url or 'about:blank'})",
                        trace=trace,
                        started_at=started_at,
                    )
                    return session
                stale = self._sessions.pop(session_id, None)
                self._last_used.pop(session_id, None)
                preserved_origins = set(session.approved_external_origins)
            # Ограничиваем число одновременных процессов браузера: сначала вычищаем мёртвые, затем старейшую.
            dead_ids = [sid for sid, sess in self._sessions.items() if not sess.is_alive()]
            for sid in dead_ids:
                dead_sess = self._sessions.pop(sid, None)
                self._last_used.pop(sid, None)
                if dead_sess is not None:
                    evicted.append((sid, dead_sess))
            while len(self._sessions) >= self.MAX_SESSIONS:
                # По возможности не закрываем основную сессию "default" раньше вспомогательных.
                candidates = [sid for sid in self._sessions if sid != "default"] or list(self._sessions)
                oldest_id = min(candidates, key=lambda sid: self._last_used.get(sid, 0.0))
                old_sess = self._sessions.pop(oldest_id, None)
                self._last_used.pop(oldest_id, None)
                if old_sess is not None:
                    evicted.append((oldest_id, old_sess))
        if stale is not None:
            _emit_step(on_status, f"Предыдущая сессия «{session_id}» завершилась — перезапускаю…", trace=trace, started_at=started_at)
            stale.close()
        for old_sid, old_sess in evicted:
            _emit_step(on_status, f"Закрываю вытесненную браузерную сессию «{old_sid}»…", trace=trace, started_at=started_at)
            old_sess.close()
        try:
            sig = inspect.signature(BrowserSession.launch)
            params = sig.parameters
            accepts_varkw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values())
        except (TypeError, ValueError):
            params = {}  # type: ignore[assignment]
            accepts_varkw = False
        launch_kw: Dict[str, Any] = {"width": width, "height": height}
        if on_status is not None and (accepts_varkw or "on_status" in params):
            launch_kw["on_status"] = on_status
        if cancel_check is not None and (accepts_varkw or "cancel_check" in params):
            launch_kw["cancel_check"] = cancel_check
        if trace is not None and (accepts_varkw or "trace" in params):
            launch_kw["trace"] = trace
        if started_at is not None and (accepts_varkw or "started_at" in params):
            launch_kw["started_at"] = started_at
        created = BrowserSession.launch(**launch_kw)
        if preserved_origins:
            created.approved_external_origins.update(preserved_origins)
        with self._lock:
            self._sessions[session_id] = created
            self._last_used[session_id] = time.monotonic()
        return created

    def get_existing(self, session_id: str) -> Optional[BrowserSession]:
        with self._lock:
            return self._sessions.get(session_id)

    def close_session(self, session_id: str) -> bool:
        with self._lock:
            session = self._sessions.pop(session_id, None)
            self._last_used.pop(session_id, None)
        if not session:
            return False
        session.close()
        return True

    def close_all(self) -> None:
        with self._lock:
            items = list(self._sessions.values())
            self._sessions.clear()
            self._last_used.clear()
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
    on_status: Optional[Any] = None,
    cancel_check: Optional[Any] = None,
) -> Tuple[str, List[Dict[str, Any]]]:
    """Точка входа инструмента `browse_project`."""
    _check_cancelled(cancel_check)
    started_at = time.monotonic()
    trace_log: List[str] = []

    def emit_status(msg: str) -> None:
        _emit_step(on_status, msg, trace=trace_log, started_at=started_at, log_console=True)

    def forward_child_status(msg: str) -> None:
        # Вложенные методы уже печатают шаг в stderr внутри своего _emit_step;
        # здесь фиксируем его в trace_log и передаём в UI без повторного stderr.
        _emit_step(on_status, msg, trace=trace_log, started_at=started_at, log_console=False)

    raw_action = str(args.get("action") or "").strip().lower()
    if not raw_action:
        raw_action = "open" if (args.get("url") or args.get("sandbox_project")) else "inspect_animations"
    if raw_action == "goto":
        raw_action = "open"

    session_id = str(args.get("session_id") or "default").strip()[:40] or "default"
    events: List[Dict[str, Any]] = []
    emit_status(f"Старт действия «{raw_action}» (сессия «{session_id}»)")

    try:
        if raw_action == "close":
            emit_status(f"Закрываю сессию «{session_id}»…")
            closed = manager.close_session(session_id)
            emit_status(
                f"Сессия «{session_id}» закрыта" if closed else f"Сессия «{session_id}» уже не активна"
            )
            return (
                f"Браузерная сессия «{session_id}» закрыта."
                if closed
                else f"Активной браузерной сессии «{session_id}» не было.",
                events,
            )

        known_actions = (
            "open",
            "resize",
            "click",
            "hover",
            "type",
            "press",
            "scroll",
            "wait",
            "inspect_animations",
            "evaluate",
        )
        if raw_action not in known_actions:
            raise BrowserError(
                f"Неизвестное действие '{raw_action}'. Доступно: open, click, hover, type, press, scroll, resize, wait, inspect_animations, evaluate, close"
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

        # Быстрая валидация до запуска headless-браузера, чтобы не тратить 5-10 с впустую.
        if raw_action == "open" and not target_url and not sandbox_project:
            raise BrowserError("Для action='open' укажите url (например http://127.0.0.1:8123) или sandbox_project")
        if raw_action != "open" and not target_url and not sandbox_project:
            if not existing or not existing.is_alive() or not existing.current_url:
                raise BrowserError("Сначала откройте проект: browse_project(action='open', url='...' или sandbox_project='...')")
        if raw_action == "evaluate" and not str(args.get("script") or "").strip():
            raise BrowserError("Для action='evaluate' укажите script")

        if sandbox_project and not target_url:
            resolved_sb = sandbox_mod.safe_resolve(manager.sandbox_root, sandbox_project, allow_root=False)
            if not resolved_sb.exists():
                raise BrowserError(f"Проект или файл не найден в Sandbox: {sandbox_project}")

        # Проверка внешнего адреса при уровне доверия verified (localhost и Sandbox открываются сразу).
        if target_url:
            target_url = validate_browser_url(target_url)
            if not is_local_url(target_url) and trust_level == "verified":
                parsed = urllib.parse.urlparse(target_url)
                origin = f"{parsed.scheme}://{parsed.netloc}"
                if not existing or origin not in existing.approved_external_origins:
                    if approval_fn is None:
                        raise BrowserError("Для открытия внешнего сайта в режиме проверки требуется разрешение пользователя")
                    emit_status(f"Жду разрешения пользователя для входа на {parsed.netloc}…")
                    decision = approval_fn(
                        {
                            "kind": "browser_inspect",
                            "title": f"Разрешить Агенту зайти на внешний сайт {parsed.netloc}?",
                            "description": f"Агент хочет открыть {target_url} в изолированном браузере и проверить вёрстку/анимации.",
                            "url": target_url,
                        }
                    )
                    if not decision.get("approved"):
                        emit_status(f"Пользователь отклонил открытие внешнего сайта {parsed.netloc}")
                        return f"Пользователь отклонил открытие внешнего сайта {target_url}.", events
                    if existing:
                        existing.approved_external_origins.add(origin)

        _check_cancelled(cancel_check)
        try:
            gm_sig = inspect.signature(manager.get_or_create)
            gm_params = gm_sig.parameters
            gm_varkw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in gm_params.values())
        except (TypeError, ValueError):
            gm_params = {}  # type: ignore[assignment]
            gm_varkw = False

        gm_kw: Dict[str, Any] = {}
        if gm_varkw or "on_status" in gm_params:
            gm_kw["on_status"] = forward_child_status
        if cancel_check is not None and (gm_varkw or "cancel_check" in gm_params):
            gm_kw["cancel_check"] = cancel_check
        if gm_varkw or "trace" in gm_params:
            # Передаём локальный список только если не используется forward_child_status (он уже пишет в trace_log).
            gm_kw["trace"] = None
        if gm_varkw or "started_at" in gm_params:
            gm_kw["started_at"] = started_at
        session = manager.get_or_create(session_id, width, height, **gm_kw)

        if target_url and not is_local_url(target_url):
            parsed = urllib.parse.urlparse(target_url)
            session.approved_external_origins.add(f"{parsed.scheme}://{parsed.netloc}")

        sandbox_note = ""
        if sandbox_project and not target_url:
            srv = session.static_servers.get(sandbox_project)
            if srv is None:
                emit_status(f"Поднимаю локальный HTTP-сервер для Sandbox «{sandbox_project}»…")
                srv = StaticSandboxServer(manager.sandbox_root, sandbox_project)
                session.static_servers[sandbox_project] = srv
                emit_status(f"Локальный сервер Sandbox слушает {srv.url}")
            target_url = srv.url
            if getattr(srv, "is_directory_listing", False):
                if getattr(srv, "has_package_json", False):
                    sandbox_note = (
                        " (внимание: в папке есть package.json, но нет index.html/dist/build — "
                        "показан список файлов; для React/Next.js/Vite запустите сборку или dev-сервер и передайте url)"
                    )
                else:
                    sandbox_note = " (внимание: в корне не найден index.html — открыт список файлов)"

        def _call_cdp(cdp_client: CDPClient, method: str, params: Optional[Dict[str, Any]] = None, *, timeout: float = 20.0) -> Dict[str, Any]:
            if cancel_check is not None:
                return cdp_client.call(method, params, timeout=timeout, cancel_check=cancel_check)
            return cdp_client.call(method, params, timeout=timeout)

        def _eval_cdp(
            cdp_client: CDPClient,
            expr: str,
            *,
            await_promise: bool = True,
            timeout: float = 15.0,
        ) -> Any:
            if cancel_check is not None:
                return cdp_client.evaluate(expr, await_promise=await_promise, timeout=timeout, cancel_check=cancel_check)
            return cdp_client.evaluate(expr, await_promise=await_promise, timeout=timeout)

        def _set_vp(w: int, h: int) -> None:
            try:
                vp_sig = inspect.signature(session.set_viewport)
                vp_params = vp_sig.parameters
                vp_varkw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in vp_params.values())
            except (TypeError, ValueError):
                vp_params = {}  # type: ignore[assignment]
                vp_varkw = False
            vp_kw: Dict[str, Any] = {}
            if cancel_check is not None and (vp_varkw or "cancel_check" in vp_params):
                vp_kw["cancel_check"] = cancel_check
            if vp_varkw or "on_status" in vp_params:
                vp_kw["on_status"] = forward_child_status
            if vp_varkw or "started_at" in vp_params:
                vp_kw["started_at"] = started_at
            session.set_viewport(w, h, **vp_kw)

        def _navigate_session(url_to_open: str, wait_time_ms: int) -> None:
            try:
                nav_sig = inspect.signature(session.navigate)
                nav_params = nav_sig.parameters
                nav_varkw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in nav_params.values())
            except (TypeError, ValueError):
                nav_params = {}  # type: ignore[assignment]
                nav_varkw = False
            nav_kw: Dict[str, Any] = {"wait_ms": wait_time_ms}
            if nav_varkw or "on_status" in nav_params:
                nav_kw["on_status"] = forward_child_status
            if cancel_check is not None and (nav_varkw or "cancel_check" in nav_params):
                nav_kw["cancel_check"] = cancel_check
            if nav_varkw or "started_at" in nav_params:
                nav_kw["started_at"] = started_at
            session.navigate(url_to_open, **nav_kw)

        def _audit_session(status_text: str = "Собираю DOM-метрики, анимации и ошибки консоли…") -> Dict[str, Any]:
            emit_status(status_text)
            try:
                au_sig = inspect.signature(session.audit)
                au_params = au_sig.parameters
                au_varkw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in au_params.values())
            except (TypeError, ValueError):
                au_params = {}  # type: ignore[assignment]
                au_varkw = False
            au_kw: Dict[str, Any] = {}
            if cancel_check is not None and (au_varkw or "cancel_check" in au_params):
                au_kw["cancel_check"] = cancel_check
            if au_varkw or "on_status" in au_params:
                au_kw["on_status"] = forward_child_status
            if au_varkw or "started_at" in au_params:
                au_kw["started_at"] = started_at
            return session.audit(**au_kw)

        def _capture_shot() -> str:
            emit_status("Делаю скриншот страницы…")
            try:
                sh_sig = inspect.signature(session.capture_screenshot)
                sh_params = sh_sig.parameters
                sh_varkw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sh_params.values())
            except (TypeError, ValueError):
                sh_params = {}  # type: ignore[assignment]
                sh_varkw = False
            sh_kw: Dict[str, Any] = {}
            if cancel_check is not None and (sh_varkw or "cancel_check" in sh_params):
                sh_kw["cancel_check"] = cancel_check
            if sh_varkw or "on_status" in sh_params:
                sh_kw["on_status"] = forward_child_status
            if sh_varkw or "started_at" in sh_params:
                sh_kw["started_at"] = started_at
            return session.capture_screenshot(**sh_kw)

        if raw_action == "open":
            if not target_url:
                raise BrowserError("Для action='open' укажите url (например http://127.0.0.1:8123) или sandbox_project")
            if (width, height) != (session.width, session.height):
                _set_vp(width, height)
            _navigate_session(target_url, wait_ms)
            audit_data = _audit_session()
            shot = _capture_shot() if args.get("capture_screenshot", True) else ""
            emit_status("Формирую отчёт по результатам осмотра…")
            report, meta = format_inspection_report(
                "open",
                audit_data,
                action_note=f"Открыта страница {target_url}{sandbox_note}",
            )
            emit_status(f"Осмотр «open» завершён за {time.monotonic() - started_at:.2f} с ({meta.get('summary') or 'ок'})")
            if bool(args.get("close_after")):
                manager.close_session(session_id)
                emit_status(f"Сессия «{session_id}» закрыта после шага «open»")
            events.append({
                "type": "browser_inspect",
                "action": "open",
                **meta,
                "trace": list(trace_log),
                **({"_images": [shot], "preview": shot} if shot else {}),
            })
            return report, events

        # Для остальных действий страница уже должна быть открыта (или передали url/sandbox_project сразу).
        if not session.current_url:
            if target_url:
                _navigate_session(target_url, 300)
            else:
                raise BrowserError("Сначала откройте проект: browse_project(action='open', url='...' или sandbox_project='...')")

        cdp = session.ensure_cdp()
        action_note = ""
        delta_actions = ("click", "hover", "scroll", "wait", "inspect_animations", "resize")
        before_audit = (
            _audit_session("Фиксирую состояние страницы перед действием…")
            if raw_action in delta_actions
            else {}
        )
        delta: Optional[Dict[str, Any]] = None
        extra_shots: List[str] = []
        eval_result: Any = None

        if raw_action == "resize":
            emit_status(f"Меняю размер окна браузера на {width}×{height}…")
            _set_vp(width, height)
            _sleep_interruptible(min(wait_ms, 1500) / 1000.0, cancel_check)
            action_note = f"Размер окна изменён на {width}×{height}"

        elif raw_action in ("click", "hover"):
            emit_status(f"Выполняю «{raw_action}» в браузере…")
            selector = str(args.get("selector") or "").strip()
            text_q = str(args.get("text") or "").strip()
            if args.get("x") is not None and args.get("y") is not None:
                try:
                    tx, ty = int(args["x"]), int(args["y"])
                except (TypeError, ValueError) as err:
                    raise BrowserError("Координаты x и y должны быть числами") from err
                target_desc = f"({tx}, {ty})"
            else:
                emit_status(f"Ищу элемент на странице (selector={selector or '—'}, text={text_q or '—'})…")
                loc = _eval_cdp(cdp, _js_locate_element(selector, text_q), await_promise=False) or {}
                if not isinstance(loc, dict) or loc.get("error"):
                    raise BrowserError(str((loc or {}).get("error") if isinstance(loc, dict) else "Элемент не найден"))
                if "x" not in loc or "y" not in loc:
                    raise BrowserError("Не удалось определить координаты элемента на странице")
                tx, ty = int(loc["x"]), int(loc["y"])
                target_desc = f"<{loc.get('tag')}> «{loc.get('text') or selector or text_q}» в ({tx}, {ty})"

            emit_status(f"Отправляю событие мыши ({raw_action}) в {target_desc}…")
            _call_cdp(cdp, "Input.dispatchMouseEvent", {"type": "mouseMoved", "x": tx, "y": ty, "button": "none"})
            if raw_action == "click":
                _call_cdp(cdp, "Input.dispatchMouseEvent", {"type": "mousePressed", "x": tx, "y": ty, "button": "left", "clickCount": 1})
                _call_cdp(cdp, "Input.dispatchMouseEvent", {"type": "mouseReleased", "x": tx, "y": ty, "button": "left", "clickCount": 1})
                action_note = f"Клик по {target_desc}"
            else:
                action_note = f"Наведение курсора на {target_desc}"
            if wait_ms > 0:
                _sleep_interruptible(wait_ms / 1000.0, cancel_check)

        elif raw_action == "type":
            emit_status("Ввожу текст в элемент страницы…")
            selector = str(args.get("selector") or "").strip()
            text_val = str(args.get("text") or "")
            if selector:
                emit_status(f"Ищу поле ввода ({selector})…")
                loc = _eval_cdp(cdp, _js_locate_element(selector, ""), await_promise=False) or {}
                if not isinstance(loc, dict) or loc.get("error"):
                    raise BrowserError(str((loc or {}).get("error") if isinstance(loc, dict) else "Элемент не найден"))
                if "x" not in loc or "y" not in loc:
                    raise BrowserError("Не удалось определить координаты элемента ввода на странице")
                tx, ty = int(loc["x"]), int(loc["y"])
                _call_cdp(cdp, "Input.dispatchMouseEvent", {"type": "mouseMoved", "x": tx, "y": ty, "button": "none"})
                _call_cdp(cdp, "Input.dispatchMouseEvent", {"type": "mousePressed", "x": tx, "y": ty, "button": "left", "clickCount": 1})
                _call_cdp(cdp, "Input.dispatchMouseEvent", {"type": "mouseReleased", "x": tx, "y": ty, "button": "left", "clickCount": 1})
                if args.get("clear"):
                    _eval_cdp(
                        cdp,
                        f"(() => {{ const el = document.querySelector({json.dumps(selector)}); if (el && 'value' in el) el.value = ''; }})()",
                        await_promise=False,
                    )
            emit_status(f"Вставляю текст ({len(text_val)} симв.)…")
            _call_cdp(cdp, "Input.insertText", {"text": text_val})
            if wait_ms > 0:
                _sleep_interruptible(min(wait_ms, 1500) / 1000.0, cancel_check)
            action_note = f"Введён текст «{text_val[:50]}»"

        elif raw_action == "press":
            key_raw = str(args.get("text") or args.get("key") or "Enter").strip()
            emit_status(f"Нажимаю клавишу {key_raw}…")
            mapped = KEY_MAP.get(key_raw.lower(), (key_raw, key_raw, 0))
            key_val, code_val, vk = mapped
            _call_cdp(cdp, "Input.dispatchKeyEvent", {"type": "keyDown", "key": key_val, "code": code_val, "windowsVirtualKeyCode": vk})
            _call_cdp(cdp, "Input.dispatchKeyEvent", {"type": "keyUp", "key": key_val, "code": code_val, "windowsVirtualKeyCode": vk})
            if wait_ms > 0:
                _sleep_interruptible(min(wait_ms, 1500) / 1000.0, cancel_check)
            action_note = f"Нажата клавиша {key_val}"

        elif raw_action == "scroll":
            emit_status("Прокручиваю страницу…")
            selector = str(args.get("selector") or "").strip()
            direction = str(args.get("direction") or "down").strip().lower()
            if selector:
                loc = _eval_cdp(cdp, _js_locate_element(selector, ""), await_promise=False) or {}
                if loc.get("error"):
                    raise BrowserError(str(loc["error"]))
                action_note = f"Прокрутка к {selector}"
            elif args.get("scroll_y") is not None:
                try:
                    sy = int(args["scroll_y"])
                except (TypeError, ValueError) as err:
                    raise BrowserError("scroll_y должен быть числом") from err
                _eval_cdp(cdp, f"window.scrollTo({{ top: {sy}, behavior: 'smooth' }})", await_promise=False)
                action_note = f"Прокрутка к y={sy}px"
            else:
                if direction == "top":
                    _eval_cdp(cdp, "window.scrollTo({ top: 0, behavior: 'smooth' })", await_promise=False)
                elif direction == "bottom":
                    _eval_cdp(cdp, "window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })", await_promise=False)
                elif direction == "up":
                    _eval_cdp(cdp, f"window.scrollBy({{ top: -{max(200, int(session.height * 0.75))}, behavior: 'smooth' }})", await_promise=False)
                else:
                    _eval_cdp(cdp, f"window.scrollBy({{ top: {max(200, int(session.height * 0.75))}, behavior: 'smooth' }})", await_promise=False)
                action_note = f"Прокрутка ({direction})"
            _sleep_interruptible(max(0.4, min(wait_ms, 3000) / 1000.0), cancel_check)

        elif raw_action == "wait":
            wait_sec = max(0.2, min(wait_ms or 800, 5000) / 1000.0)
            emit_status(f"Жду {wait_sec:.1f} с для стабилизации анимаций/загрузки…")
            _sleep_interruptible(wait_sec, cancel_check)
            action_note = f"Ожидание {wait_ms}мс для проверки анимаций/загрузки"

        elif raw_action == "inspect_animations":
            emit_status("Замеряю динамику анимаций и переходов…")
            if args.get("capture_screenshot", True):
                shot0 = _capture_shot()
                if shot0:
                    extra_shots.append(shot0)
            sample_ms = max(250, min(wait_ms or 600, 3000))
            emit_status(f"Выдерживаю интервал замера анимаций ({sample_ms} мс)…")
            _sleep_interruptible(sample_ms / 1000.0, cancel_check)
            action_note = f"Замер анимаций и переходов (интервал {sample_ms}мс)"

        elif raw_action == "evaluate":
            emit_status("Выполняю инспектирующий JS-скрипт на странице…")
            script = str(args.get("script") or "").strip()
            if not script:
                raise BrowserError("Для action='evaluate' укажите script")
            await_promise = bool(args.get("await_promise", True))
            eval_result = _eval_cdp(cdp, script[:8000], await_promise=await_promise, timeout=8.0)
            action_note = "Выполнен инспектирующий скрипт"

        audit_data = _audit_session()
        if raw_action in ("click", "hover", "scroll", "wait", "inspect_animations", "resize"):
            delta = compare_animation_snapshots(before_audit.get("dom") or {}, audit_data.get("dom") or {})

        if args.get("capture_screenshot", True):
            shot1 = _capture_shot()
            if shot1:
                extra_shots.append(shot1)

        emit_status("Формирую отчёт по результатам осмотра…")
        report, meta = format_inspection_report(
            raw_action,
            audit_data,
            delta=delta,
            eval_result=eval_result,
            action_note=action_note,
        )
        emit_status(f"Осмотр «{raw_action}» завершён за {time.monotonic() - started_at:.2f} с ({meta.get('summary') or 'ок'})")
        if bool(args.get("close_after")):
            manager.close_session(session_id)
            emit_status(f"Сессия «{session_id}» закрыта после шага «{raw_action}»")
        preview = extra_shots[-1] if extra_shots else ""
        ev_payload: Dict[str, Any] = {
            "type": "browser_inspect",
            "action": raw_action,
            **meta,
            "trace": list(trace_log),
            **({"_images": extra_shots[:2], "preview": preview} if extra_shots else {}),
        }
        if extra_shots and getattr(session, "_last_screenshot_suspicious", False):
            ev_payload["blankScreenshot"] = True
        events.append(ev_payload)
        return report, events
    except Exception as err:
        emit_status(f"Ошибка на шаге «{raw_action}»: {err}")
        if isinstance(err, BrowserError):
            if not getattr(err, "trace", None):
                err.trace = list(trace_log)
            raise
        raise BrowserError(str(err), trace=trace_log) from err


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
