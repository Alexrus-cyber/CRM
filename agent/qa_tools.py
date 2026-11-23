#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
QA-инструменты под-агента Тестировщика (`agent/qa_tools.py`, только стандартная библиотека).

Предоставляет:
  * `qa_static_review` — статический анализ проекта в Sandbox (синтаксис Python AST / JSON,
    битые относительные ссылки HTML/JS/CSS, незакрытые теги, XSS-паттерны, localhost в клиентском коде);
  * `qa_run_tests` — автоопределение и запуск тестов / линтеров / сборки внутри Sandbox;
  * `qa_http_audit` — проверка HTTP-маршрутов и ответов локального или Sandbox-сервера;
  * `qa_browser_audit` — кросс-вьюпортная проверка в браузере (desktop 1440x900 + mobile 375x812);
  * `qa_submit_report` — фиксация структурированного вердикта (critical vs minor + checks_run).
"""

from __future__ import annotations

import ast
import http.server
import ipaddress
import json
import os
import re
import shutil
import socket
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

import browser_inspector
import code_tools
import sandbox as sandbox_mod

QA_TOOLS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "qa_static_review",
            "description": (
                "Статический QA-аудит кода и файлов проекта в Sandbox: синтаксис Python (AST) и JSON, "
                "пустые файлы, битые относительные ссылки на JS/CSS/картинки в HTML, hardcoded localhost в "
                "клиентском коде, опасные XSS-конструкции (innerHTML/eval/document.write), TODO/FIXME. "
                "Безопасен, не запускает shell-команды."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sandbox_project": {
                        "type": "string",
                        "description": "Относительная папка или файл в Sandbox (по умолчанию '.')",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "qa_run_tests",
            "description": (
                "Запустить автотесты, проверку типов, линтер или синтаксическую проверку проекта в Sandbox. "
                "Если command не указан — автоматически определяет стек (package.json, pytest/unittest, Python/JS)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sandbox_project": {
                        "type": "string",
                        "description": "Относительная папка проекта в Sandbox (по умолчанию '.')",
                    },
                    "command": {
                        "type": "string",
                        "description": "Явная команда тестирования (опционально, например 'pytest -q' или 'npm test')",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Таймаут выполнения в секундах (по умолчанию 120)",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "qa_http_audit",
            "description": (
                "Проверить HTTP-эндпоинты и страницы запущенного сервера (или поднять временный статический "
                "сервер для sandbox_project): статус-коды, задержку, Content-Type, ошибки в теле, JSON."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "base_url": {
                        "type": "string",
                        "description": "Базовый URL работающего сервера (например, http://127.0.0.1:4173)",
                    },
                    "sandbox_project": {
                        "type": "string",
                        "description": "Папка статического проекта в Sandbox (если base_url не передан)",
                    },
                    "routes": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Список маршрутов для проверки (по умолчанию ['/'])",
                    },
                    "method": {
                        "type": "string",
                        "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
                        "description": "HTTP-метод запроса (по умолчанию GET)",
                    },
                    "headers": {
                        "type": "object",
                        "description": "Дополнительные HTTP-заголовки (опционально)",
                    },
                    "body": {
                        "type": "string",
                        "description": "Тело запроса (JSON/текст для POST/PUT/PATCH)",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Таймаут одного HTTP-запроса в секундах (по умолчанию 10)",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "qa_security_audit",
            "description": (
                "Комплексный QA-аудит безопасности проекта (Sandbox или GitHub-клон): утечки секретов и ключей, "
                "SAST-паттерны (eval/exec/shell=True/sql.raw/XSS), проверка API-эндпоинтов без auth/rate-limit и "
                "проверка заголовков CSP/proxy."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sandbox_project": {
                        "type": "string",
                        "description": "Папка проекта в Sandbox (если не проверяется GitHub-клон)",
                    },
                    "target": {
                        "type": "string",
                        "enum": ["auto", "sandbox", "github"],
                        "description": "Источник кода (по умолчанию auto)",
                    },
                    "path": {
                        "type": "string",
                        "description": "Подпапка для проверки",
                    },
                    "include_tests": {
                        "type": "boolean",
                        "description": "Включать ли тестовые файлы",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "qa_auth_matrix_audit",
            "description": (
                "Построить и проверить матрицу авторизации и прав по всем API-эндпоинтам (методы, auth, "
                "role-check, rate-limit, Zod-валидация) и выявить маршруты без защиты."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sandbox_project": {"type": "string"},
                    "target": {"type": "string", "enum": ["auto", "sandbox", "github"]},
                    "only_flagged": {
                        "type": "boolean",
                        "description": "Показать только маршруты с предупреждениями",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "qa_schema_audit",
            "description": (
                "QA-аудит схемы БД и SQL-миграций (src/db/schema.ts vs drizzle/*.sql): поиск несоответствий "
                "таблиц/колонок и проблем переносимости SQLite/PostgreSQL."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sandbox_project": {"type": "string"},
                    "target": {"type": "string", "enum": ["auto", "sandbox", "github"]},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "qa_browser_audit",
            "description": (
                "Комплексная автопроверка веб-проекта в реальном браузере на двух экранах (desktop 1440x900 "
                "и mobile 375x812): консоль JS, сетевые 4xx/5xx, горизонтальный скролл, битые картинки, "
                "пустые кнопки/ссылки, застрявшие анимации и скриншоты обоих экранов."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sandbox_project": {
                        "type": "string",
                        "description": "Папка/HTML-файл проекта в Sandbox",
                    },
                    "url": {
                        "type": "string",
                        "description": "URL уже запущенного сайта (если не передан sandbox_project)",
                    },
                    "wait_ms": {
                        "type": "integer",
                        "description": "Пауза для прогрузки/анимаций в мс (по умолчанию 450)",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "qa_submit_report",
            "description": (
                "Обязательный финальный инструмент Тестировщика: отправляет структурированный вердикт "
                "для Агента и базы данных, чётко разделяя критические ошибки (исправляет Агент) и "
                "некритические/мелкие замечания (по которым нужно спросить человека)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "enum": ["passed", "minor_issues", "critical_issues"],
                        "description": "Итоговый статус проверки",
                    },
                    "summary": {
                        "type": "string",
                        "description": "Краткое и понятное итоговое резюме проверки на русском языке",
                    },
                    "critical_issues": {
                        "type": "array",
                        "description": "Критические баги, поломки логики/сборки/безопасности, падающие тесты",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string"},
                                "description": {"type": "string"},
                                "file": {"type": "string"},
                                "line": {"type": "integer"},
                                "fix_hint": {"type": "string"},
                            },
                            "required": ["title", "description"],
                        },
                    },
                    "minor_issues": {
                        "type": "array",
                        "description": "Мелкие/некритические замечания (стили, косметика, мелкий UX/нейминг/TODO)",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string"},
                                "description": {"type": "string"},
                                "file": {"type": "string"},
                                "line": {"type": "integer"},
                                "fix_hint": {"type": "string"},
                            },
                            "required": ["title", "description"],
                        },
                    },
                    "checks_run": {
                        "type": "array",
                        "description": "Список проведённых проверок",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "tool": {"type": "string"},
                                "status": {"type": "string", "enum": ["pass", "fail", "warn"]},
                                "details": {"type": "string"},
                            },
                            "required": ["name", "status", "details"],
                        },
                    },
                },
                "required": ["status", "summary"],
            },
        },
    },
]

QA_TOOL_NAMES = {t["function"]["name"] for t in QA_TOOLS}

SKIP_REVIEW_DIRS = sandbox_mod.TREE_SKIP_DIRS | {"__pycache__", ".venv", "venv"}
STATIC_EXTENSIONS_MAX_BYTES = 512_000
_LOCAL_HTTP_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class QaToolError(Exception):
    """Ошибка QA-инструмента."""


def _is_blocked_metadata_target(url: str) -> Optional[str]:
    parsed = urlparse(str(url or "").strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return "Нужен корректный URL http:// или https://"
    if parsed.username or parsed.password:
        return "Учётные данные в URL запрещены"
    host = (parsed.hostname or "").strip().lower().strip("[]")
    if not host:
        return "Некорректный хост URL"
    if host in ("169.254.169.254", "metadata.google.internal", "metadata.goog") or host.startswith("169.254."):
        return "Доступ к metadata-адресам запрещён"
    try:
        ip_obj = ipaddress.ip_address(host)
        if ip_obj.is_link_local or ip_obj.is_multicast or ip_obj == ipaddress.ip_address("::") or str(ip_obj) == "0.0.0.0":
            return "Запрещённый сетевой адрес"
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
            for info in infos:
                addr = str(info[4][0]).split("%")[0]
                ip_resolved = ipaddress.ip_address(addr)
                if ip_resolved.is_link_local or ip_resolved.is_multicast:
                    return f"Адрес {host} ведёт на запрещённый IP ({addr})"
        except OSError:
            pass
    return None


def _walk_project_files(root: Path, max_files: int = 400) -> List[Path]:
    files: List[Path] = []
    if root.is_file():
        return [root]
    for cur, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_REVIEW_DIRS and not d.startswith("."))
        for name in sorted(names):
            files.append(Path(cur) / name)
            if len(files) >= max_files:
                return files
    return files


def run_qa_static_review(sandbox_root: Path, sandbox_project: str = ".") -> Dict[str, Any]:
    rel = str(sandbox_project or ".").strip() or "."
    target = sandbox_mod.safe_resolve(sandbox_root, rel, allow_root=True)
    if not target.exists():
        raise QaToolError(f"Проект или файл не найден в Sandbox: {rel}")

    files = _walk_project_files(target)
    base_dir = target.parent if target.is_file() else target
    critical: List[Dict[str, Any]] = []
    minor: List[Dict[str, Any]] = []
    checked = 0

    for fp in files:
        checked += 1
        rel_path = fp.relative_to(base_dir).as_posix() if fp != base_dir else fp.name
        try:
            size = fp.stat().st_size
        except OSError:
            continue
        if size == 0 and fp.suffix.lower() in (".html", ".js", ".mjs", ".ts", ".tsx", ".py", ".css", ".json"):
            minor.append(
                {
                    "title": f"Пустой файл {rel_path}",
                    "description": f"Файл {rel_path} имеет размер 0 байт.",
                    "file": rel_path,
                    "severity": "minor",
                }
            )
            continue
        if size > STATIC_EXTENSIONS_MAX_BYTES:
            continue

        suffix = fp.suffix.lower()
        if suffix not in (
            ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
            ".html", ".htm", ".css", ".json", ".svg", ".md",
        ):
            continue

        try:
            text = fp.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        if suffix == ".json":
            try:
                json.loads(text)
            except json.JSONDecodeError as err:
                critical.append(
                    {
                        "title": f"Невалидный JSON: {rel_path}",
                        "description": f"Ошибка разбора JSON на строке {err.lineno}: {err.msg}",
                        "file": rel_path,
                        "line": err.lineno,
                        "severity": "critical",
                    }
                )

        if suffix == ".py":
            try:
                ast.parse(text, filename=rel_path)
            except SyntaxError as err:
                critical.append(
                    {
                        "title": f"Синтаксическая ошибка Python: {rel_path}",
                        "description": f"{err.msg} (строка {err.lineno or 1})",
                        "file": rel_path,
                        "line": err.lineno or 1,
                        "severity": "critical",
                    }
                )

        if suffix in (".html", ".htm"):
            for tag in ("script", "style"):
                opens = len(re.findall(rf"<{tag}\b", text, flags=re.IGNORECASE))
                closes = len(re.findall(rf"</{tag}\s*>", text, flags=re.IGNORECASE))
                if opens > closes:
                    critical.append(
                        {
                            "title": f"Незакрытый тег <{tag}> в {rel_path}",
                            "description": f"Открыто тегов <{tag}>: {opens}, закрыто: {closes}.",
                            "file": rel_path,
                            "severity": "critical",
                        }
                    )
            for match in re.finditer(r"""(?:src|href)\s*=\s*["']([^"'#?]+)(?:[?#][^"']*)?["']""", text, flags=re.IGNORECASE):
                ref = match.group(1).strip()
                if not ref or ref.startswith(("http://", "https://", "data:", "mailto:", "tel:", "//", "javascript:", "/")):
                    continue
                resolved = (fp.parent / ref).resolve()
                try:
                    resolved.relative_to(base_dir.resolve())
                except ValueError:
                    critical.append(
                        {
                            "title": f"Ссылка выходит за пределы проекта: {ref}",
                            "description": f"В {rel_path} атрибут ссылается на путь вне каталога проекта: {ref}.",
                            "file": rel_path,
                            "severity": "critical",
                        }
                    )
                    continue
                if not resolved.exists():
                    critical.append(
                        {
                            "title": f"Битая локальная ссылка: {ref}",
                            "description": f"Файл «{ref}», подключённый в {rel_path}, отсутствует в проекте.",
                            "file": rel_path,
                            "severity": "critical",
                        }
                    )

        if suffix in (".html", ".htm", ".js", ".jsx", ".ts", ".tsx"):
            if re.search(r"""['"`]https?://(?:127\.0\.0\.1|localhost)(?::\d+)?""", text):
                minor.append(
                    {
                        "title": f"Жёстко зашит localhost в {rel_path}",
                        "description": "Клиентский код содержит URL с localhost/127.0.0.1 — лучше использовать относительный URL.",
                        "file": rel_path,
                        "severity": "minor",
                    }
                )
            if re.search(r"\.(?:innerHTML|outerHTML)\s*=|document\.write\s*\(", text):
                minor.append(
                    {
                        "title": f"Потенциальный XSS-паттерн (innerHTML/document.write) в {rel_path}",
                        "description": "Проверьте санитизацию HTML перед вставкой в DOM или замените на textContent.",
                        "file": rel_path,
                        "severity": "minor",
                    }
                )

        todo_hits = re.findall(r"\b(?:TODO|FIXME|XXX)\b.*", text)
        if todo_hits:
            minor.append(
                {
                    "title": f"Незавершённые пометки TODO/FIXME в {rel_path} ({len(todo_hits)})",
                    "description": f"Пример: {todo_hits[0][:140]}",
                    "file": rel_path,
                    "severity": "minor",
                }
            )

    return {
        "project": rel,
        "filesChecked": checked,
        "criticalIssues": critical,
        "minorIssues": minor,
    }


def _detect_test_commands(project_dir: Path) -> List[Tuple[str, str]]:
    cmds: List[Tuple[str, str]] = []
    pkg_json = project_dir / "package.json"
    if pkg_json.is_file():
        try:
            pkg = json.loads(pkg_json.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pkg = {}
        scripts = pkg.get("scripts") if isinstance(pkg, dict) and isinstance(pkg.get("scripts"), dict) else {}
        if (project_dir / "node_modules").exists():
            for key, label in (("typecheck", "Typecheck"), ("lint", "Lint"), ("test", "Unit tests"), ("build", "Build")):
                val = str(scripts.get(key) or "").strip()
                if val and "no test specified" not in val.lower():
                    cmds.append((label, f"npm run {key}"))

    py_exe = (
        f'"{sys.executable}"'
        if (not getattr(sys, "frozen", False) and sys.executable and Path(sys.executable).is_file())
        else (shutil.which("python") or shutil.which("python3") or ("python" if os.name == "nt" else "python3"))
    )
    py_files = [p for p in _walk_project_files(project_dir, max_files=200) if p.suffix == ".py"]
    has_test_py = any(p.name.startswith("test_") or p.name.endswith("_test.py") for p in py_files)
    if (project_dir / "pytest.ini").exists() or (project_dir / "pyproject.toml").exists() or has_test_py:
        if has_test_py:
            cmds.append(("Python unittest/tests", f"{py_exe} -m unittest discover -s . -v"))
    elif py_files:
        rel_list = " ".join(
            f'"{p.relative_to(project_dir).as_posix()}"'
            for p in py_files[:40]
        )
        cmds.append(("Python compile check", f"{py_exe} -m py_compile {rel_list}"))

    js_files = [
        p
        for p in _walk_project_files(project_dir, max_files=120)
        if p.suffix in (".js", ".mjs", ".cjs")
    ]
    if js_files and not cmds:
        first_js = " && ".join(f'node --check "{p.relative_to(project_dir).as_posix()}"' for p in js_files[:20])
        cmds.append(("Node JS syntax check", first_js))

    return cmds


def _serve_static_temp(directory: Path) -> Tuple[socketserver.TCPServer, threading.Thread, str]:
    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a: Any, **kw: Any) -> None:
            super().__init__(*a, directory=str(directory), **kw)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            pass

    class ReusableServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

        def handle_error(self, request: Any, client_address: Any) -> None:
            _, exc, _ = sys.exc_info()
            if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError)):
                return
            if isinstance(exc, OSError) and getattr(exc, "winerror", None) in (10053, 10054):
                return
            super().handle_error(request, client_address)

    srv = ReusableServer(("127.0.0.1", 0), QuietHandler)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, t, f"http://127.0.0.1:{port}"


def run_qa_http_audit(
    sandbox_root: Path,
    *,
    base_url: str = "",
    sandbox_project: str = "",
    routes: Optional[List[str]] = None,
    method: str = "GET",
    headers: Optional[Dict[str, Any]] = None,
    body: Optional[str] = None,
    timeout: int = 10,
) -> Dict[str, Any]:
    clean_url = str(base_url or "").strip()
    temp_srv: Optional[socketserver.TCPServer] = None
    if not clean_url:
        rel = str(sandbox_project or ".").strip() or "."
        target = sandbox_mod.safe_resolve(sandbox_root, rel, allow_root=True)
        if not target.exists():
            raise QaToolError(f"Проект в Sandbox не найден: {rel}")
        serve_dir = target.parent if target.is_file() else target
        if target.is_dir() and not (serve_dir / "index.html").is_file():
            for sub_name in ("dist", "build", "public", "out"):
                if (serve_dir / sub_name / "index.html").is_file():
                    serve_dir = serve_dir / sub_name
                    break
        temp_srv, _, clean_url = _serve_static_temp(serve_dir)
        if not routes and target.is_file():
            routes = [f"/{target.name}"]
    else:
        blocked = _is_blocked_metadata_target(clean_url)
        if blocked:
            raise QaToolError(blocked)

    check_routes = [str(r or "/") for r in (routes or ["/"])][:20]
    if not check_routes:
        check_routes = ["/"]
    req_method = str(method or "GET").strip().upper()
    if req_method not in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"):
        req_method = "GET"
    req_data = body.encode("utf-8") if body is not None and req_method in ("POST", "PUT", "PATCH", "DELETE") else None
    req_headers: Dict[str, str] = {}
    if isinstance(headers, dict):
        for k, v in headers.items():
            ks = str(k or "").strip()
            if ks and "\n" not in ks and "\r" not in ks:
                req_headers[ks] = str(v or "")[:1000]
    if req_data is not None and "Content-Type" not in req_headers:
        req_headers["Content-Type"] = "application/json; charset=utf-8"

    req_timeout = max(2, min(30, int(timeout or 10)))
    results: List[Dict[str, Any]] = []
    error_markers = (
        "traceback (most recent call last)",
        "internal server error",
        "application error:",
        "syntaxerror:",
        "sqlite_error",
        "postgres error",
    )

    try:
        for route in check_routes:
            rel_route = route if route.startswith("/") else f"/{route}"
            full_url = urljoin(clean_url.rstrip("/") + "/", rel_route.lstrip("/"))
            blocked = _is_blocked_metadata_target(full_url)
            if blocked:
                results.append({"route": rel_route, "ok": False, "status": 0, "error": blocked, "ms": 0})
                continue
            started = time.monotonic()
            try:
                req = urllib.request.Request(full_url, data=req_data, headers=req_headers, method=req_method)
                open_fn = (
                    _LOCAL_HTTP_OPENER.open
                    if browser_inspector.is_local_url(full_url)
                    else urllib.request.urlopen
                )
                with open_fn(req, timeout=req_timeout) as resp:
                    resp_body = resp.read(64_000).decode("utf-8", "replace")
                    elapsed_ms = int((time.monotonic() - started) * 1000)
                    ctype = str(resp.headers.get("Content-Type") or "")
                    low = resp_body.lower()
                    hit_err = next((m for m in error_markers if m in low), "")
                    sec_headers = {
                        "csp": bool(resp.headers.get("Content-Security-Policy")),
                        "xContentTypeOptions": str(resp.headers.get("X-Content-Type-Options") or ""),
                        "xFrameOptions": str(resp.headers.get("X-Frame-Options") or ""),
                    }
                    ok = 200 <= resp.status < 400 and not hit_err
                    results.append(
                        {
                            "route": rel_route,
                            "url": full_url,
                            "method": req_method,
                            "status": resp.status,
                            "ms": elapsed_ms,
                            "contentType": ctype,
                            "bytes": len(resp_body),
                            "securityHeaders": sec_headers,
                            "errorMarker": hit_err,
                            "ok": ok,
                        }
                    )
            except urllib.error.HTTPError as err:
                elapsed_ms = int((time.monotonic() - started) * 1000)
                results.append(
                    {
                        "route": rel_route,
                        "url": full_url,
                        "method": req_method,
                        "status": err.code,
                        "ms": elapsed_ms,
                        "ok": False,
                        "error": f"HTTP {err.code}",
                    }
                )
            except (urllib.error.URLError, OSError) as err:
                elapsed_ms = int((time.monotonic() - started) * 1000)
                results.append(
                    {
                        "route": rel_route,
                        "url": full_url,
                        "method": req_method,
                        "status": 0,
                        "ms": elapsed_ms,
                        "ok": False,
                        "error": str(err),
                    }
                )
    finally:
        if temp_srv is not None:
            temp_srv.shutdown()
            temp_srv.server_close()

    return {
        "baseUrl": clean_url,
        "results": results,
        "passedCount": sum(1 for r in results if r.get("ok")),
        "failedCount": sum(1 for r in results if not r.get("ok")),
    }


def normalize_issue_list(items: Any, default_severity: str) -> List[Dict[str, Any]]:
    if not isinstance(items, list):
        return []
    out: List[Dict[str, Any]] = []
    for raw in items[:100]:
        if isinstance(raw, str):
            text = raw.strip()
            if text:
                out.append({"title": text[:180], "description": text[:2000], "severity": default_severity})
            continue
        if not isinstance(raw, dict):
            continue
        title = str(raw.get("title") or raw.get("name") or raw.get("description") or "").strip()[:240]
        desc = str(raw.get("description") or raw.get("details") or title).strip()[:4000]
        if not title and not desc:
            continue
        item: Dict[str, Any] = {
            "title": title or desc[:180],
            "description": desc or title,
            "severity": default_severity,
        }
        if raw.get("file"):
            item["file"] = str(raw["file"]).strip()[:300]
        if raw.get("line"):
            try:
                line_num = int(raw["line"])
                if line_num > 0:
                    item["line"] = line_num
            except (TypeError, ValueError):
                pass
        if raw.get("fix_hint") or raw.get("fixHint"):
            item["fixHint"] = str(raw.get("fix_hint") or raw.get("fixHint")).strip()[:1500]
        out.append(item)
    return out


def normalize_checks_list(items: Any) -> List[Dict[str, Any]]:
    if not isinstance(items, list):
        return []
    out: List[Dict[str, Any]] = []
    for raw in items[:100]:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or raw.get("check") or "Проверка").strip()[:240]
        status = str(raw.get("status") or "pass").strip().lower()
        if status not in ("pass", "fail", "warn"):
            status = "pass"
        details = str(raw.get("details") or raw.get("output") or "").strip()[:2000]
        entry: Dict[str, Any] = {"name": name, "status": status, "details": details}
        if raw.get("tool"):
            entry["tool"] = str(raw["tool"]).strip()[:120]
        out.append(entry)
    return out


def extract_fallback_qa_report(
    final_text: str,
    observed_checks: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Если модель не вызвала qa_submit_report явно, строит аккуратный отчёт из текста и проверок."""
    clean = str(final_text or "").strip()
    low = clean.lower()
    checks = list(observed_checks or [])
    critical: List[Dict[str, Any]] = []
    minor: List[Dict[str, Any]] = []

    has_fail_check = any(c.get("status") == "fail" for c in checks)
    if has_fail_check or any(k in low for k in ("критическ", "syntaxerror", "не работает", "сломан", "падает тест")):
        if not critical and (has_fail_check or "без критических" not in low):
            failed_names = [c["name"] for c in checks if c.get("status") == "fail"]
            critical.append(
                {
                    "title": "Обнаружены проблемы при проверке" + (f" ({', '.join(failed_names[:3])})" if failed_names else ""),
                    "description": clean[:1200] or "Требуется исправление выявленных сбоев.",
                    "severity": "critical",
                }
            )
    if any(k in low for k in ("мелк", "некритич", "косметич", "желательно улучшить", "todo")):
        if not critical:
            minor.append(
                {
                    "title": "Мелкие / некритические замечания тестировщика",
                    "description": clean[:1200],
                    "severity": "minor",
                }
            )

    status = "critical_issues" if critical else "minor_issues" if minor else "passed"
    return {
        "status": status,
        "summary": clean[:1500] or "Проверка завершена.",
        "criticalIssues": critical,
        "minorIssues": minor,
        "checksRun": checks,
    }


def run_qa_tool(
    name: str,
    args: Dict[str, Any],
    *,
    sandbox_root: Path,
    trust_level: str = "verified",
    approval_fn: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None,
    browser_manager: Optional[browser_inspector.BrowserSessionManager] = None,
    github_ctx: Optional[Dict[str, Any]] = None,
    report_sink: Optional[Dict[str, Any]] = None,
    checks_sink: Optional[List[Dict[str, Any]]] = None,
    unlimited: bool = False,
    tester_run_key: str = "",
    on_status: Optional[Callable[[str], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Tuple[str, List[Dict[str, Any]]]:
    """Выполняет один QA-инструмент Тестировщика."""
    args = args or {}
    events: List[Dict[str, Any]] = []
    trust = str(trust_level or "verified").strip().lower()
    if trust == "none":
        raise QaToolError("Уровень доверия «Нет доступа» запрещает QA-проверки в Sandbox.")

    if name == "qa_static_review":
        proj = str(args.get("sandbox_project") or ".").strip() or "."
        try:
            res = run_qa_static_review(sandbox_root, proj)
        except sandbox_mod.SandboxError as err:
            raise QaToolError(str(err)) from err
        crit = res["criticalIssues"]
        mino = res["minorIssues"]
        chk_status = "fail" if crit else ("warn" if mino else "pass")
        chk_detail = f"Проверено файлов: {res['filesChecked']}, критических: {len(crit)}, мелких: {len(mino)}"
        if checks_sink is not None:
            checks_sink.append({"name": f"Статический анализ ({proj})", "tool": "qa_static_review", "status": chk_status, "details": chk_detail})
        events.append(
            {
                "type": "qa_check",
                "tool": "qa_static_review",
                "label": f"Статический анализ {proj}: {chk_detail}",
                "status": chk_status,
                "project": proj,
                "filesChecked": res["filesChecked"],
                "criticalCount": len(crit),
                "minorCount": len(mino),
            }
        )
        lines = [f"Статический анализ проекта «{proj}»: проверено файлов {res['filesChecked']}."]
        if crit:
            lines.append(f"\nКритические проблемы ({len(crit)}):")
            for item in crit[:30]:
                loc = f" [{item.get('file')}]" if item.get("file") else ""
                lines.append(f"- {item['title']}{loc}: {item['description']}")
        if mino:
            lines.append(f"\nМелкие замечания ({len(mino)}):")
            for item in mino[:30]:
                loc = f" [{item.get('file')}]" if item.get("file") else ""
                lines.append(f"- {item['title']}{loc}: {item['description']}")
        if not crit and not mino:
            lines.append("Статических проблем не обнаружено.")
        return "\n".join(lines), events

    if name == "qa_run_tests":
        proj = str(args.get("sandbox_project") or ".").strip() or "."
        custom_cmd = str(args.get("command") or "").strip()
        try:
            timeout_sec = max(10, min(600, int(args.get("timeout") or 120)))
        except (TypeError, ValueError):
            timeout_sec = 120
        try:
            proj_dir = sandbox_mod.safe_resolve(sandbox_root, proj, allow_root=True)
        except sandbox_mod.SandboxError as err:
            raise QaToolError(str(err)) from err
        if not proj_dir.exists():
            raise QaToolError(f"Папка проекта не найдена в Sandbox: {proj}")
        cwd_rel = proj if proj_dir.is_dir() else (proj_dir.parent.relative_to(sandbox_root).as_posix() or ".")
        cwd_path = sandbox_root if cwd_rel == "." else sandbox_root / cwd_rel

        cmds_to_run = [("QA Command", custom_cmd)] if custom_cmd else _detect_test_commands(cwd_path)
        if not cmds_to_run:
            res_static = run_qa_static_review(sandbox_root, proj)
            chk_status = "fail" if res_static["criticalIssues"] else "pass"
            detail = f"Фреймворк автотестов не найден; выполнена базовая проверка файлов ({res_static['filesChecked']} шт.)."
            if checks_sink is not None:
                checks_sink.append({"name": f"Автопроверка ({proj})", "tool": "qa_run_tests", "status": chk_status, "details": detail})
            return detail, events

        outputs: List[str] = []
        for label, cmd in cmds_to_run:
            esc = sandbox_mod.inspect_command_escape(cmd, sandbox_root, cwd_rel)
            if esc:
                raise QaToolError(esc)

        batch_approved = False
        if trust == "verified":
            if approval_fn is None:
                raise QaToolError("Требуется подтверждение пользователя для запуска тестовой команды")
            if len(cmds_to_run) > 1:
                labels_str = ", ".join(lbl for lbl, _ in cmds_to_run)
                combined_cmd = " && ".join(cmd for _, cmd in cmds_to_run)
                req_payload: Dict[str, Any] = {
                    "kind": "bash_command",
                    "title": f"Разрешить Тестировщику выполнить {len(cmds_to_run)} проверок ({labels_str})?",
                    "description": f"Пакетный запуск QA-проверок внутри Sandbox/{cwd_rel}",
                    "command": combined_cmd[:2000],
                    "cwd": cwd_rel,
                }
                if tester_run_key:
                    req_payload["testerRunKey"] = tester_run_key
                decision = approval_fn(req_payload)
                if not decision.get("approved"):
                    msg = f"Пользователь отклонил пакетный запуск QA-проверок ({labels_str})."
                    if checks_sink is not None:
                        checks_sink.append({"name": labels_str, "tool": "qa_run_tests", "status": "warn", "details": msg})
                    return msg, events
                batch_approved = True

        for label, cmd in cmds_to_run:
            if trust == "verified" and not batch_approved:
                req_payload = {
                    "kind": "bash_command",
                    "title": f"Разрешить Тестировщику запустить: {label}?",
                    "description": f"Запуск QA-проверки внутри Sandbox/{cwd_rel}",
                    "command": cmd,
                    "cwd": cwd_rel,
                }
                if tester_run_key:
                    req_payload["testerRunKey"] = tester_run_key
                decision = approval_fn(req_payload)
                if not decision.get("approved"):
                    msg = f"Пользователь отклонил запуск QA-команды «{cmd}»."
                    outputs.append(msg)
                    if checks_sink is not None:
                        checks_sink.append({"name": label, "tool": "qa_run_tests", "status": "warn", "details": msg})
                    continue

            try:
                res = sandbox_mod.run_command(
                    sandbox_root,
                    cmd,
                    rel_cwd=cwd_rel,
                    timeout=timeout_sec,
                    background=False,
                    unlimited=unlimited,
                )
            except sandbox_mod.SandboxError as err:
                raise QaToolError(str(err)) from err

            exit_code = int(res.get("exitCode") or 0)
            out_txt = str(res.get("output") or "")
            status = "pass" if exit_code == 0 else "fail"
            if checks_sink is not None:
                checks_sink.append(
                    {
                        "name": label,
                        "tool": "qa_run_tests",
                        "status": status,
                        "details": f"exit={exit_code}: {out_txt[:400]}",
                    }
                )
            events.append(
                {
                    "type": "command_result",
                    "command": cmd,
                    "cwd": res.get("cwd", "."),
                    "exitCode": exit_code,
                    "output": out_txt if unlimited else out_txt[:4000],
                }
            )
            outputs.append(f"[{label}] код {exit_code}:\n{out_txt[:4000]}")
        return "\n\n".join(outputs), events

    if name == "qa_http_audit":
        try:
            http_timeout = max(2, min(30, int(args.get("timeout") or 10)))
        except (TypeError, ValueError):
            http_timeout = 10
        res = run_qa_http_audit(
            sandbox_root,
            base_url=str(args.get("base_url") or ""),
            sandbox_project=str(args.get("sandbox_project") or ""),
            routes=args.get("routes") if isinstance(args.get("routes"), list) else None,
            method=str(args.get("method") or "GET"),
            headers=args.get("headers") if isinstance(args.get("headers"), dict) else None,
            body=str(args.get("body")) if args.get("body") is not None else None,
            timeout=http_timeout,
        )
        ok_cnt = res["passedCount"]
        fail_cnt = res["failedCount"]
        chk_status = "fail" if fail_cnt > 0 else "pass"
        chk_detail = f"HTTP {res['baseUrl']}: OK={ok_cnt}, ошибок={fail_cnt}"
        if checks_sink is not None:
            checks_sink.append({"name": "HTTP-аудит маршрутов", "tool": "qa_http_audit", "status": chk_status, "details": chk_detail})
        events.append(
            {
                "type": "qa_check",
                "tool": "qa_http_audit",
                "label": chk_detail,
                "status": chk_status,
                "url": res["baseUrl"],
            }
        )
        lines = [chk_detail]
        for row in res["results"]:
            sh = row.get("securityHeaders") or {}
            hdr_note = "" if not sh else f" [csp={sh.get('csp')}, xcto={sh.get('xContentTypeOptions') or '-'}]"
            lines.append(
                f"- {row.get('method', 'GET')} {row['route']}: статус={row.get('status')} ({row.get('ms')} мс){hdr_note} "
                + ("OK" if row.get("ok") else f"ОШИБКА: {row.get('error') or row.get('errorMarker')}")
            )
        return "\n".join(lines), events

    if name == "qa_security_audit":
        try:
            root, scope_label = code_tools._resolve_target_root(args, sandbox_root=sandbox_root, github_ctx=github_ctx)
        except code_tools.CodeToolError as err:
            raise QaToolError(str(err)) from err
        sec = code_tools.scan_security_findings(
            root,
            subdir=str(args.get("path") or ""),
            include_tests=bool(args.get("include_tests", False)),
        )
        ep_items = code_tools.collect_endpoint_inventory(root)
        no_auth = [e for e in ep_items if "NO_AUTH" in e["flags"]]
        no_rl = [e for e in ep_items if "NO_RATE_LIMIT" in e["flags"]]
        check_role = [e for e in ep_items if "CHECK_ROLE" in e["flags"]]
        proxy_warnings: List[str] = []
        proxy_fp = root / "src" / "proxy.ts"
        if proxy_fp.is_file():
            ptxt = proxy_fp.read_text(encoding="utf-8", errors="replace")
            if "strict-dynamic" in ptxt and "requestHeaders.set(\"Content-Security-Policy\"" not in ptxt and "requestHeaders.set('Content-Security-Policy'" not in ptxt:
                proxy_warnings.append("src/proxy.ts: 'strict-dynamic' с nonce без передачи Content-Security-Policy в requestHeaders")

        crit_cnt = len(sec["secrets"]) + len([s for s in sec["sast"] if s["severity"] in ("critical", "high")]) + len(no_auth) + len(proxy_warnings)
        warn_cnt = len([s for s in sec["sast"] if s["severity"] == "medium"]) + len(no_rl) + len(check_role)
        chk_status = "fail" if crit_cnt > 0 else ("warn" if warn_cnt > 0 else "pass")
        chk_detail = f"Файлов={sec['filesScanned']}, секреты={len(sec['secrets'])}, SAST={len(sec['sast'])}, NO_AUTH={len(no_auth)}, NO_RL={len(no_rl)}"
        if checks_sink is not None:
            checks_sink.append({"name": f"Аудит безопасности ({scope_label})", "tool": "qa_security_audit", "status": chk_status, "details": chk_detail})
        events.append({"type": "qa_check", "tool": "qa_security_audit", "label": chk_detail, "status": chk_status})

        lines = [f"QA Security Audit ({scope_label}): {chk_detail}"]
        if proxy_warnings:
            lines.append("\nCSP / Proxy предупреждения:")
            lines.extend(f"  ! {w}" for w in proxy_warnings)
        if sec["secrets"]:
            lines.append("\nСекреты/ключи:")
            lines.extend(f"  - [{s['kind']}] {s['file']}:{s['line']}" for s in sec["secrets"][:25])
        if sec["sast"]:
            lines.append("\nSAST-находки:")
            lines.extend(f"  - [{s['severity']}] {s['kind']} @ {s['file']}:{s['line']}" for s in sec["sast"][:35])
        if no_auth or check_role or no_rl:
            lines.append("\nЭндпоинты с пробелами защиты:")
            for e in (no_auth + check_role + no_rl)[:30]:
                lines.append(f"  - {','.join(e['methods'])} {e['route']} [{', '.join(e['flags'])}]")
        return "\n".join(lines), events

    if name == "qa_auth_matrix_audit":
        try:
            root, scope_label = code_tools._resolve_target_root(args, sandbox_root=sandbox_root, github_ctx=github_ctx)
        except code_tools.CodeToolError as err:
            raise QaToolError(str(err)) from err
        items = code_tools.collect_endpoint_inventory(root)
        only_flagged = bool(args.get("only_flagged", False))
        shown = [e for e in items if e["flags"]] if only_flagged else items
        flagged_cnt = sum(1 for e in items if e["flags"])
        has_no_auth = any("NO_AUTH" in e["flags"] for e in items)
        chk_status = "fail" if has_no_auth else ("warn" if flagged_cnt else "pass")
        chk_detail = f"Эндпоинтов={len(items)}, с флагами={flagged_cnt}"
        if checks_sink is not None:
            checks_sink.append({"name": f"Матрица авторизации API ({scope_label})", "tool": "qa_auth_matrix_audit", "status": chk_status, "details": chk_detail})
        events.append({"type": "qa_check", "tool": "qa_auth_matrix_audit", "label": chk_detail, "status": chk_status})
        out = [f"Auth Matrix ({scope_label}): {chk_detail}"]
        for e in shown[:100]:
            fl = f" [! {', '.join(e['flags'])}]" if e["flags"] else ""
            out.append(f"- {','.join(e['methods'])} {e['route']} | auth={e['auth']} role={e['roleCheck']} rl={e['rateLimit']} val={e['validation']}{fl}")
        return "\n".join(out), events

    if name == "qa_schema_audit":
        try:
            root, scope_label = code_tools._resolve_target_root(args, sandbox_root=sandbox_root, github_ctx=github_ctx)
        except code_tools.CodeToolError as err:
            raise QaToolError(str(err)) from err
        info = code_tools.inspect_schema_and_migrations(root)
        warns = info["warnings"]
        chk_status = "fail" if warns else "pass"
        chk_detail = f"Таблиц schema={len(info['schemaTables'])}, миграций={len(info['migrationFiles'])}, расхождений={len(warns)}"
        if checks_sink is not None:
            checks_sink.append({"name": f"Аудит схемы БД ({scope_label})", "tool": "qa_schema_audit", "status": chk_status, "details": chk_detail})
        events.append({"type": "qa_check", "tool": "qa_schema_audit", "label": chk_detail, "status": chk_status})
        lines = [f"Schema Audit ({scope_label}): {chk_detail}"]
        if warns:
            lines.extend(f"  ! {w}" for w in warns)
        else:
            lines.append("Расхождений между schema.ts и drizzle/*.sql не обнаружено.")
        return "\n".join(lines), events

    if name == "qa_browser_audit":
        owns_mgr = browser_manager is None
        mgr = browser_manager or browser_inspector.BrowserSessionManager(sandbox_root=sandbox_root)
        proj = str(args.get("sandbox_project") or "").strip()
        url = str(args.get("url") or "").strip()
        try:
            wait_ms = max(0, min(15000, int(args.get("wait_ms") or 450)))
        except (TypeError, ValueError):
            wait_ms = 450
        if not proj and not url:
            raise QaToolError("Укажите sandbox_project или url для браузерного QA-аудита")

        summary_lines: List[str] = []
        any_errors = False
        no_browser_reason = ""
        try:
            for vp in ("desktop", "mobile"):
                if cancel_check and cancel_check():
                    raise QaToolError("Браузерный QA-аудит отменён пользователем")
                if on_status:
                    try:
                        on_status(
                            "Запускаю браузерный QA-аудит (desktop)…"
                            if vp == "desktop"
                            else "Проверяю мобильный вид (mobile viewport)…"
                        )
                    except Exception:  # noqa: BLE001
                        pass
                open_args: Dict[str, Any] = {
                    "action": "open" if vp == "desktop" else "resize",
                    "viewport": vp,
                    "wait_ms": wait_ms,
                    "session_id": "qa_audit",
                    "capture_screenshot": True,
                }
                if vp == "desktop":
                    if proj:
                        open_args["sandbox_project"] = proj
                    if url:
                        open_args["url"] = url
                try:
                    txt, evs = browser_inspector.execute_browse_action(
                        mgr,
                        open_args,
                        trust_level=trust,
                        approval_fn=approval_fn,
                        on_status=on_status,
                        cancel_check=cancel_check,
                    )
                except (browser_inspector.BrowserError, sandbox_mod.SandboxError) as err:
                    msg = str(err)
                    if cancel_check and cancel_check():
                        raise QaToolError(msg) from err
                    if vp == "desktop":
                        if "не найден браузер" in msg.lower():
                            no_browser_reason = msg
                            break
                        raise QaToolError(msg) from err
                    summary_lines.append(f"Mobile ({vp}): {msg}")
                    continue
                for ev in evs:
                    if (ev.get("errorsCount") or 0) > 0 or (ev.get("issuesCount") or 0) > 0:
                        any_errors = True
                events.extend(evs)
                summary_lines.append(f"=== Viewport: {vp} ===\n{txt}")
        finally:
            if owns_mgr:
                mgr.close_all()

        if no_browser_reason:
            # Fallback: без установленного Chromium проверяем проект через HTTP + статический анализ, не ломая QA-цикл.
            fallback_parts: List[str] = [f"Локальный headless-браузер недоступен ({no_browser_reason}). Выполнен fallback HTTP + статический аудит:"]
            fb_fail = False
            try:
                http_res = run_qa_http_audit(
                    sandbox_root,
                    base_url=url,
                    sandbox_project=proj,
                    routes=["/"],
                    timeout=8,
                )
                fb_fail = fb_fail or (http_res["failedCount"] > 0)
                fallback_parts.append(
                    f"HTTP-аудит {http_res['baseUrl']}: OK={http_res['passedCount']}, ошибок={http_res['failedCount']}"
                )
            except QaToolError as herr:
                fb_fail = True
                fallback_parts.append(f"HTTP-аудит не удался: {herr}")
            if proj:
                try:
                    st_res = run_qa_static_review(sandbox_root, proj)
                    if st_res["criticalIssues"]:
                        fb_fail = True
                    fallback_parts.append(
                        f"Статика {proj}: файлов={st_res['filesChecked']}, крит.={len(st_res['criticalIssues'])}, мелк.={len(st_res['minorIssues'])}"
                    )
                except QaToolError as serr:
                    fallback_parts.append(f"Статика {proj}: {serr}")
            fb_status = "fail" if fb_fail else "warn"
            if checks_sink is not None:
                checks_sink.append(
                    {
                        "name": "Браузерный аудит (fallback HTTP/статика)",
                        "tool": "qa_browser_audit",
                        "status": fb_status,
                        "details": "; ".join(fallback_parts)[:400],
                    }
                )
            events.append(
                {
                    "type": "qa_check",
                    "tool": "qa_browser_audit",
                    "label": "Браузерный аудит (fallback без Chromium)",
                    "status": fb_status,
                }
            )
            return "\n".join(fallback_parts), events

        chk_status = "fail" if any_errors else "pass"
        if checks_sink is not None:
            checks_sink.append(
                {
                    "name": "Браузерный аудит (desktop + mobile)",
                    "tool": "qa_browser_audit",
                    "status": chk_status,
                    "details": "Найдены ошибки в браузере/анимациях" if any_errors else "Страница открылась без ошибок консоли и сети",
                }
            )
        return "\n\n".join(summary_lines), events

    if name == "qa_submit_report":
        critical = normalize_issue_list(args.get("critical_issues"), "critical")
        minor = normalize_issue_list(args.get("minor_issues"), "minor")
        checks = normalize_checks_list(args.get("checks_run"))
        if not checks and checks_sink:
            checks = list(checks_sink)
        raw_status = str(args.get("status") or "").strip()
        if critical:
            status = "critical_issues"
        elif minor and raw_status in ("", "passed", "minor_issues"):
            status = "minor_issues"
        elif raw_status in ("passed", "minor_issues", "critical_issues"):
            status = raw_status
        else:
            status = "passed"
        summary = str(args.get("summary") or "").strip()[:8000] or "Проверка завершена."

        report = {
            "status": status,
            "summary": summary,
            "criticalIssues": critical,
            "minorIssues": minor,
            "checksRun": checks,
        }
        if report_sink is not None:
            report_sink.clear()
            report_sink.update(report)

        events.append(
            {
                "type": "qa_check",
                "tool": "qa_submit_report",
                "label": f"Вердикт QA: {status} (крит. {len(critical)}, мелк. {len(minor)})",
                "status": "fail" if critical else "warn" if minor else "pass",
            }
        )
        return (
            f"QA-отчёт зафиксирован (статус={status}, критических={len(critical)}, мелких={len(minor)}).",
            events,
        )

    raise QaToolError(f"Неизвестный QA-инструмент: {name}")
