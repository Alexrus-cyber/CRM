# -*- coding: utf-8 -*-
"""Локальный HTTP/SSE-сервер десктопного Harness-приложения CRM.

Объединяет в одном локальном процессе:
  1. Раздачу встроенного Web-UI (`launcher/ui/`) в стиле Nova CRM;
  2. Подключение и проксирование к БД CRM по учётке сайта (`Authorization: Bearer`);
  3. Управление встроенными процессами Агента (`agent/agent.py`) и Оператора
     (`agent/desktop_operator.py`) прямо внутри приложения/.exe;
  4. Двусторонний мост Агента (`/api/launcher/agent/prepare` + локальный `/run` +
     `/api/launcher/agent/events`) и прямое проксирование Sandbox и Approve;
  5. Поддержку локальных моделей ПК (`127.0.0.1` / LAN) даже при работе
     с удалённым сервером CRM.
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import mimetypes
import os
import re
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Tuple

from launcher import APP_NAME, APP_VERSION, bundle, commands, crm_client, deps, file_extract
from launcher import settings as settings_mod
from launcher.catalog import PROVIDER_PRESETS, REASONING_MODES, agent_by_id, load_catalog
from launcher.runner import AgentRun

MAX_LOG_LINES = 2500
HEARTBEAT_INTERVAL_SEC = 10.0

UI_MIME_MAP = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def _find_free_port(preferred: int = 0) -> int:
    if preferred > 0:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.3)
            if sock.connect_ex(("127.0.0.1", preferred)) != 0:
                return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _normalize_ai_base(raw: str) -> str:
    clean = (raw or "").strip().rstrip("/")
    if not clean:
        return ""
    if not (clean.startswith("http://") or clean.startswith("https://")):
        clean = "http://" + clean
    return clean


def _estimate_tokens(text: Any) -> int:
    if not text:
        return 0
    return max(1, (len(str(text)) + 3) // 4)


def _extract_model_capabilities(model_id: str, meta: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    """Определяет возможности модели (vision, reasoning, contextLength) для UI."""
    low = (model_id or "").lower()
    raw_caps: List[str] = []
    ctx_len: Optional[int] = None
    max_out: Optional[int] = None
    supports_vision: Optional[bool] = None
    supports_tools: Optional[bool] = None
    supports_reasoning = False
    efforts: List[str] = []

    if isinstance(meta, Mapping):
        for key in ("context_length", "max_context_length", "max_model_len", "n_ctx"):
            val = meta.get(key)
            if isinstance(val, (int, float)) and val > 0:
                ctx_len = int(val)
                break
        if isinstance(meta.get("top_provider"), Mapping):
            tp = meta["top_provider"]
            if ctx_len is None and isinstance(tp.get("context_length"), (int, float)):
                ctx_len = int(tp["context_length"])
            if isinstance(tp.get("max_completion_tokens"), (int, float)):
                max_out = int(tp["max_completion_tokens"])
        caps = meta.get("capabilities")
        if isinstance(caps, list):
            raw_caps.extend(str(c) for c in caps)
        elif isinstance(caps, Mapping):
            for k, v in caps.items():
                if v:
                    raw_caps.append(str(k))
        sp = meta.get("supported_parameters")
        if isinstance(sp, list):
            for p in sp:
                ps = str(p).lower()
                if ps in ("reasoning", "include_reasoning", "reasoning_effort", "thinking_budget"):
                    supports_reasoning = True
                if ps == "tools":
                    supports_tools = True
        arch = meta.get("architecture")
        if isinstance(arch, Mapping):
            mods = arch.get("input_modalities")
            if isinstance(mods, list) and any(str(m).lower() == "image" for m in mods):
                supports_vision = True
        if str(meta.get("type") or "").lower() == "vlm":
            supports_vision = True

    caps_lower = " ".join(raw_caps).lower()
    if "vision" in caps_lower or "image" in caps_lower or "vlm" in caps_lower:
        supports_vision = True
    if "tool" in caps_lower:
        supports_tools = True
    if "thinking" in caps_lower or "reasoning" in caps_lower:
        supports_reasoning = True

    if supports_vision is None:
        if any(k in low for k in ("-vl", "vl-", "vision", "gpt-4o", "gpt-4.1", "gpt-5", "claude-3", "claude-4", "gemini", "pixtral", "llava", "minicpm-v", "qwen3-vl", "qwen2.5-vl", "qwen3.5")):
            supports_vision = True
    if not supports_reasoning:
        if any(k in low for k in ("qwen3", "qwq", "deepseek-r1", "deepseek-reasoner", "o1", "o3", "o4", "gpt-oss", "thinking", "reason", "claude-3.7", "claude-4", "gemini-2.5", "gemini-3")):
            supports_reasoning = True

    modes = ["default"]
    if supports_reasoning:
        modes.extend(["off", "low", "medium", "high", "max", "budget"])
    else:
        modes.extend(["off", "low", "medium", "high"])

    return {
        "model": model_id,
        "source": "metadata" if meta else "heuristic",
        "supportsReasoning": supports_reasoning,
        "reasoningModes": modes,
        "rawEfforts": efforts,
        "supportsThinkingBudget": supports_reasoning,
        "supportsEnableThinking": "qwen" in low or "unsloth" in low or supports_reasoning,
        "supportsVision": supports_vision,
        "supportsTools": supports_tools if supports_tools is not None else True,
        "contextLength": ctx_len,
        "maxOutputTokens": max_out,
        "rawCapabilities": raw_caps,
        "note": "Локальная инспекция модели" if meta else "По названию модели",
    }


def _http_json_local(method: str, url: str, headers: Optional[Mapping[str, str]] = None, body: Any = None, timeout: float = 8.0) -> Tuple[int, Dict[str, Any]]:
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method.upper())
    req.add_header("Accept", "application/json")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        if v:
            req.add_header(k, v)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            parsed = json.loads(raw or "{}")
            return int(getattr(resp, "status", 200) or 200), parsed if isinstance(parsed, dict) else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(raw or "{}")
        except json.JSONDecodeError:
            parsed = {}
        return int(exc.code), parsed if isinstance(parsed, dict) else {"error": raw[:300]}
    except Exception as exc:
        return 0, {"error": str(exc)}


def _inspect_local_models(base_url: str, api_key: str, target_model: str = "") -> Tuple[int, Dict[str, Any]]:
    base = _normalize_ai_base(base_url)
    if not base:
        return 400, {"error": "Укажите Base URL модели"}
    headers: Dict[str, str] = {}
    if api_key.strip():
        headers["Authorization"] = f"Bearer {api_key.strip()}"

    status, data = _http_json_local("GET", f"{base}/models", headers=headers, timeout=8.0)
    if status == 0:
        return 502, {"error": f"Нет связи с {base}: {data.get('error', 'ошибка сети')}. Проверьте, что локальный сервер модели запущен."}
    if status >= 400:
        return 502, {"error": str(data.get("error") or f"Сервер модели ответил HTTP {status}")}

    raw_items = data.get("data") if isinstance(data.get("data"), list) else (data.get("models") if isinstance(data.get("models"), list) else [])
    meta_by_id: Dict[str, Dict[str, Any]] = {}
    models: List[str] = []
    for item in raw_items:
        if not isinstance(item, Mapping):
            continue
        mid = str(item.get("id") or item.get("model") or item.get("name") or "").strip()
        if not mid or mid in meta_by_id:
            continue
        models.append(mid)
        meta_by_id[mid] = dict(item)
    models.sort()

    # Пробуем LM Studio /api/v0/models или /api/v1/models
    parsed = urllib.parse.urlparse(base)
    origin = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else ""
    if origin:
        for lms_path in ("/api/v0/models", "/api/v1/models"):
            st2, lms = _http_json_local("GET", f"{origin}{lms_path}", headers=headers, timeout=2.0)
            if st2 == 200:
                arr = lms.get("data") if isinstance(lms.get("data"), list) else (lms.get("models") if isinstance(lms.get("models"), list) else [])
                for item in arr:
                    if isinstance(item, Mapping):
                        mid = str(item.get("id") or item.get("key") or "").strip()
                        if mid:
                            merged = dict(meta_by_id.get(mid, {}))
                            merged.update(item)
                            meta_by_id[mid] = merged

    caps_by_model = {mid: _extract_model_capabilities(mid, meta_by_id.get(mid)) for mid in models}
    focus = target_model.strip() or (models[0] if models else "")
    focus_cap = caps_by_model.get(focus) or (_extract_model_capabilities(focus, meta_by_id.get(focus)) if focus else None)
    return 200, {
        "ok": True,
        "models": models,
        "capabilitiesByModel": caps_by_model,
        "capabilities": focus_cap,
    }


def _rewrite_sandbox_preview_html(html_text: str, project_base: str, ht_query: str) -> str:
    base_href = project_base.rstrip("/") + "/"
    extra_tag = f'<base href="{base_href}">'
    if re.search(r"<head\b[^>]*>", html_text, re.IGNORECASE):
        rewritten = re.sub(r"(<head\b[^>]*>)", rf"\1{extra_tag}", html_text, count=1, flags=re.IGNORECASE)
    else:
        rewritten = extra_tag + html_text
    # Добавляем ?ht=... на внутренние ссылки, если они ссылаются на /api/ai/agent/sandbox/preview/
    if ht_query:
        rewritten = rewritten.replace('src="/api/ai/agent/sandbox/', f'src="/api/ai/agent/sandbox/')
    return rewritten


class HarnessServer:
    """Локальный сервер приложения, управляющий CRM-прокси, Агентом и Оператором."""

    def __init__(
        self,
        *,
        settings_path: Optional[Path] = None,
        port: int = 0,
        app_token: Optional[str] = None,
    ) -> None:
        self.settings_path = settings_path or settings_mod.config_path()
        self.settings: settings_mod.LaunchSettings = settings_mod.load(self.settings_path)
        self.catalog = load_catalog(settings_mod.config_dir() / "agents.json")
        self.app_token = app_token or secrets.token_urlsafe(32)
        self.port = port
        self._httpd: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.RLock()

        # Встроенные процессы (Агент и Оператор)
        self._agent_run: Optional[AgentRun] = None
        self._agent_port: int = int(self.settings.values_for(agent_by_id(self.catalog, "chat_agent")).get("port") or 8899) if agent_by_id(self.catalog, "chat_agent") else 8899
        self._agent_http_token: str = ""
        self._agent_logs: List[str] = []

        self._operator_run: Optional[AgentRun] = None
        self._operator_logs: List[str] = []

        # Не-передаваемые в браузер одноразовые nonces для /approve
        self._approval_nonces: Dict[str, str] = {}
        self._pick_folder_cb: Optional[Callable[[], str]] = None

    def set_folder_picker(self, cb: Optional[Callable[[], str]]) -> None:
        self._pick_folder_cb = cb

    @property
    def token(self) -> str:
        return self.app_token

    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def entry_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/?ht={urllib.parse.quote(self.app_token)}"

    def start(self) -> int:
        server = self

        class RequestHandler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            disable_nagle_algorithm = True

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                return

            def _read_body(self, max_bytes: int = 64 * 1024 * 1024) -> bytes:
                raw_len = self.headers.get("Content-Length")
                if not raw_len:
                    return b""
                try:
                    length = int(raw_len)
                except ValueError:
                    return b""
                if length <= 0:
                    return b""
                if length > max_bytes:
                    raise ValueError("Слишком большой запрос")
                return self.rfile.read(length)

            def _send_bytes(self, status: int, content_type: str, data: bytes, extra_headers: Optional[Mapping[str, str]] = None) -> None:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                if extra_headers:
                    for k, v in extra_headers.items():
                        self.send_header(k, v)
                self.end_headers()
                if data and self.command != "HEAD":
                    self.wfile.write(data)

            def _send_json(self, status: int, payload: Any) -> None:
                raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self._send_bytes(status, "application/json; charset=utf-8", raw)

            def _query_params(self) -> Dict[str, List[str]]:
                parsed = urllib.parse.urlparse(self.path)
                return urllib.parse.parse_qs(parsed.query, keep_blank_values=True)

            def _is_authorized_api(self) -> bool:
                origin = (self.headers.get("Origin") or "").strip()
                if origin:
                    allowed_origins = {f"http://127.0.0.1:{server.port}", f"http://localhost:{server.port}"}
                    if origin not in allowed_origins:
                        return False
                hdr_tok = (self.headers.get("X-Harness-Token") or "").strip()
                if hdr_tok and secrets.compare_digest(hdr_tok, server.app_token):
                    return True
                q_tok = (self._query_params().get("ht") or [""])[0].strip()
                if q_tok and secrets.compare_digest(q_tok, server.app_token):
                    return True
                # Разрешаем referer с правильным ht в пути preview для вложенных ассетов (CSS/JS/images)
                ref = (self.headers.get("Referer") or "").strip()
                parsed_path = urllib.parse.urlparse(self.path).path
                if parsed_path.startswith("/api/ai/agent/sandbox/preview/") or parsed_path.startswith("/api/ai/agent/sandbox/proxy/"):
                    if ref.startswith(f"http://127.0.0.1:{server.port}/") or ref.startswith(f"http://localhost:{server.port}/"):
                        return True
                return False

            def do_OPTIONS(self) -> None:  # noqa: N802
                self._send_bytes(204, "text/plain", b"")

            def do_HEAD(self) -> None:  # noqa: N802
                self._dispatch()

            def do_GET(self) -> None:  # noqa: N802
                self._dispatch()

            def do_POST(self) -> None:  # noqa: N802
                self._dispatch()

            def do_PUT(self) -> None:  # noqa: N802
                self._dispatch()

            def do_PATCH(self) -> None:  # noqa: N802
                self._dispatch()

            def do_DELETE(self) -> None:  # noqa: N802
                self._dispatch()

            def _dispatch(self) -> None:
                parsed = urllib.parse.urlparse(self.path)
                path = parsed.path or "/"

                if not path.startswith("/api/"):
                    self._serve_ui(path)
                    return

                if not self._is_authorized_api():
                    self._send_json(403, {"error": "Неверный локальный токен приложения"})
                    return

                try:
                    server.handle_api(self, path, parsed.query)
                except Exception as exc:
                    self._send_json(500, {"error": f"Внутренняя ошибка локального сервера: {exc}"})

            def _serve_ui(self, req_path: str) -> None:
                ui_root = bundle.ui_dir()
                rel = "index.html" if req_path in ("/", "") else req_path.lstrip("/")
                if ".." in Path(rel).parts or rel.startswith("/"):
                    self._send_json(404, {"error": "Not found"})
                    return
                target = (ui_root / rel).resolve()
                try:
                    target.relative_to(ui_root.resolve())
                except ValueError:
                    self._send_json(404, {"error": "Not found"})
                    return
                if not target.is_file():
                    self._send_json(404, {"error": "UI asset not found"})
                    return
                raw = target.read_bytes()
                if target.name == "index.html":
                    text = raw.decode("utf-8", "replace")
                    text = text.replace("{{HARNESS_TOKEN}}", server.app_token)
                    text = text.replace("{{APP_VERSION}}", APP_VERSION)
                    raw = text.encode("utf-8")
                ext = target.suffix.lower()
                mime = UI_MIME_MAP.get(ext) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                self._send_bytes(200, mime, raw)

        bind_port = self.port if self.port > 0 else 0
        self._httpd = ThreadingHTTPServer(("127.0.0.1", bind_port), RequestHandler)
        self._httpd.daemon_threads = True
        self.port = int(self._httpd.server_address[1])
        self._thread = threading.Thread(target=self._httpd.serve_forever, name="crm-harness-http", daemon=True)
        self._thread.start()
        return self.port

    def shutdown(self) -> None:
        self.stop_agent_process()
        self.stop_operator_process()
        if self._httpd is not None:
            try:
                self._httpd.shutdown()
                self._httpd.server_close()
            except OSError:
                pass
            self._httpd = None
        self.save_settings()

    def save_settings(self) -> None:
        try:
            settings_mod.save(self.settings, self.settings_path)
        except OSError:
            pass

    # ------------------------------------------------------------------
    # Управление процессами Агента и Оператора
    # ------------------------------------------------------------------
    def _drain_process_logs(self, run: Optional[AgentRun], target_logs: List[str]) -> None:
        if run is None:
            return
        new_lines = run.poll_lines(limit=1000)
        if new_lines:
            target_logs.extend(new_lines)
            if len(target_logs) > MAX_LOG_LINES:
                del target_logs[: len(target_logs) - MAX_LOG_LINES]

    def is_agent_running(self) -> bool:
        with self._lock:
            self._drain_process_logs(self._agent_run, self._agent_logs)
            return self._agent_run is not None and self._agent_run.is_running()

    def is_operator_running(self) -> bool:
        with self._lock:
            self._drain_process_logs(self._operator_run, self._operator_logs)
            return self._operator_run is not None and self._operator_run.is_running()

    def agent_health(self) -> Dict[str, Any]:
        running = self.is_agent_running()
        port = self._agent_port
        headers: Dict[str, str] = {}
        if self._agent_http_token:
            headers["Authorization"] = f"Bearer {self._agent_http_token}"
        status, data = _http_json_local("GET", f"http://127.0.0.1:{port}/health", headers=headers, timeout=2.5)
        available = status == 200 and bool(data.get("ok", True))
        chat_spec = agent_by_id(self.catalog, "chat_agent")
        vals = self.settings.values_for(chat_spec) if chat_spec else {}
        return {
            "available": available,
            "running": running,
            "port": port,
            "endpoint": f"http://127.0.0.1:{port}",
            "workspace": str(vals.get("workspace") or settings_mod.workspace_dir()),
            **(data if isinstance(data, dict) and status == 200 else {}),
        }

    def start_agent_process(self, options: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        with self._lock:
            if self._agent_run is not None and self._agent_run.is_running():
                return self.agent_health()

            chat_spec = agent_by_id(self.catalog, "chat_agent")
            if chat_spec is None:
                raise RuntimeError("В каталоге не найден встроенный Агент")

            opts = dict(options or {})
            if "port" in opts and opts["port"]:
                try:
                    self.settings.set_value("chat_agent", "port", int(opts["port"]))
                except (TypeError, ValueError):
                    pass
            if "workspace" in opts and opts["workspace"] is not None:
                self.settings.set_value("chat_agent", "workspace", str(opts["workspace"]).strip())
            if "trust_level" in opts and opts["trust_level"]:
                self.settings.set_value("chat_agent", "trust_level", str(opts["trust_level"]).strip())

            vals = self.settings.values_for(chat_spec)
            preferred_port = int(vals.get("port") or 8899)
            actual_port = _find_free_port(preferred_port)
            self._agent_port = actual_port
            self.settings.set_value("chat_agent", "port", actual_port)

            ws_raw = str(vals.get("workspace") or "").strip()
            cwd = Path(ws_raw).expanduser() if ws_raw else settings_mod.workspace_dir()
            cwd.mkdir(parents=True, exist_ok=True)
            self.settings.set_value("chat_agent", "workspace", str(cwd))

            script = commands.script_path(chat_spec, bundle.agents_dir())
            if not script.is_file():
                raise RuntimeError(f"Не найден файл Агента: {script}")

            args = commands.agent_args(chat_spec, self.settings)
            env_vars = commands.agent_env(chat_spec, self.settings)
            env_vars["AGENT_PORT"] = str(actual_port)
            env_vars["AGENT_HOST"] = "127.0.0.1"
            env_vars["AGENT_WORKSPACE"] = str(cwd)

            token = secrets.token_urlsafe(32)
            self._agent_http_token = token
            sec = commands.agent_secrets(chat_spec, self.settings)
            sec["AGENT_HTTP_TOKEN"] = token

            child_env = bundle.child_env(env_vars)
            command = bundle.run_agent_args(script, args)
            self._agent_logs.append(f"[{APP_NAME}] запуск Агента на 127.0.0.1:{actual_port} (папка: {cwd})")
            run = AgentRun(agent_id="chat_agent", command=command, cwd=cwd, env=child_env, secrets=sec)
            run.start()
            self._agent_run = run
            self.save_settings()

        # Ждём до 10 секунд готовности /health
        deadline = time.time() + 10.0
        while time.time() < deadline:
            health = self.agent_health()
            if health.get("available"):
                return health
            if not self.is_agent_running():
                break
            time.sleep(0.2)
        return self.agent_health()

    def stop_agent_process(self) -> Dict[str, Any]:
        with self._lock:
            run = self._agent_run
            if run is not None:
                run.stop(timeout=3.0)
                self._drain_process_logs(run, self._agent_logs)
                self._agent_run = None
            return {"running": False, "available": False, "port": self._agent_port}

    def ensure_agent_running(self) -> Dict[str, Any]:
        health = self.agent_health()
        if health.get("available"):
            return health
        return self.start_agent_process()

    def start_operator_process(self, options: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        with self._lock:
            if self._operator_run is not None and self._operator_run.is_running():
                return {"running": True, "startedAt": self._operator_run.started_at}

            op_spec = agent_by_id(self.catalog, "operator")
            if op_spec is None:
                raise RuntimeError("В каталоге не найден встроенный Оператор")

            opts = dict(options or {})
            for key in ("mode", "task", "crm_token", "crm_server", "max_steps", "delay", "trust_level", "task_mode", "coach_mode", "yes", "dry_run", "text_only", "verify", "repeat_nudge", "self_reflect"):
                if key in opts and opts[key] is not None:
                    self.settings.set_value("operator", key, opts[key])

            # Автоподстановка адреса CRM и токена из активной учётки
            if not str(self.settings.values_for(op_spec).get("crm_server") or "").strip():
                self.settings.set_value("operator", "crm_server", self.settings.crm_url)
            if not str(self.settings.values_for(op_spec).get("crm_token") or "").strip():
                op_prof = self.settings.crm_profile.get("operator") if isinstance(self.settings.crm_profile, dict) else {}
                auto_tok = str((op_prof or {}).get("token") or "").strip()
                if auto_tok:
                    self.settings.set_value("operator", "crm_token", auto_tok)

            for model_key in ("provider", "base_url", "model", "api_key", "temperature", "top_p", "max_tokens", "reasoning"):
                if model_key in opts and opts[model_key] is not None:
                    setattr(self.settings, model_key, opts[model_key])

            warnings = commands.validate(op_spec, self.settings, bundle.agents_dir())
            if warnings:
                raise ValueError("; ".join(warnings))

            script = commands.script_path(op_spec, bundle.agents_dir())
            args = commands.agent_args(op_spec, self.settings)
            env_vars = commands.agent_env(op_spec, self.settings)
            sec = commands.agent_secrets(op_spec, self.settings)
            child_env = bundle.child_env(env_vars)
            cwd = settings_mod.workspace_dir()
            cwd.mkdir(parents=True, exist_ok=True)
            command = bundle.run_agent_args(script, args)

            self._operator_logs.append(f"[{APP_NAME}] запуск Оператора: {commands.describe_command(args, sec)}")
            run = AgentRun(agent_id="operator", command=command, cwd=cwd, env=child_env, secrets=sec)
            run.start()
            self._operator_run = run
            self.save_settings()
            return {"running": True, "startedAt": run.started_at}

    def stop_operator_process(self) -> Dict[str, Any]:
        with self._lock:
            run = self._operator_run
            if run is not None:
                run.stop(timeout=3.0)
                self._drain_process_logs(run, self._operator_logs)
                self._operator_run = None
            return {"running": False}

    # ------------------------------------------------------------------
    # Роутинг локальных API
    # ------------------------------------------------------------------
    def _crm_auth(self) -> Tuple[str, str]:
        return crm_client.normalize_server_url(self.settings.crm_url), (self.settings.crm_session_token or "").strip()

    def _effective_ai_settings(self, req_settings: Optional[Mapping[str, Any]] = None) -> Tuple[str, str, str]:
        req_s = req_settings or {}
        base = str(req_s.get("baseUrl") or "").strip() or self.settings.resolved_base_url()
        key = str(req_s.get("apiKey") or "").strip() or self.settings.api_key.strip()
        model = str(req_s.get("model") or "").strip() or self.settings.resolved_model()
        return _normalize_ai_base(base), key, model

    def _should_use_local_model(self, base_url: str) -> bool:
        crm_url, _ = self._crm_auth()
        return bool(base_url) and crm_client.is_local_model_url(base_url) and not crm_client.is_local_model_url(crm_url)

    def handle_api(self, handler: BaseHTTPRequestHandler, path: str, query: str) -> None:
        method = handler.command.upper()
        full_rel = f"{path}?{query}" if query else path

        # ---- 1. Внутренние маршруты управления приложением /api/app/* ----
        if path == "/api/app/state" and method == "GET":
            self._api_app_state(handler)
            return
        if path == "/api/app/crm/check" and method == "POST":
            self._api_crm_check(handler)
            return
        if path == "/api/app/crm/login" and method == "POST":
            self._api_crm_login(handler)
            return
        if path == "/api/app/crm/refresh" and method == "POST":
            self._api_crm_refresh(handler)
            return
        if path == "/api/app/crm/logout" and method == "POST":
            self._api_crm_logout(handler)
            return
        if path == "/api/app/theme" and method == "POST":
            self._api_theme(handler)
            return
        if path == "/api/app/prefs" and method in ("GET", "POST"):
            self._api_prefs(handler)
            return
        if path == "/api/app/pick-folder" and method == "POST":
            self._api_pick_folder(handler)
            return
        if path == "/api/app/extract-file" and method == "POST":
            self._api_extract_file(handler)
            return
        if path == "/api/app/runtime" and method == "GET":
            self._api_runtime(handler)
            return
        if path == "/api/app/agent/start" and method == "POST":
            body = self._read_json(handler)
            try:
                health = self.start_agent_process(body)
                handler._send_json(200, health)  # type: ignore[attr-defined]
            except Exception as exc:
                handler._send_json(400, {"error": str(exc)})  # type: ignore[attr-defined]
            return
        if path == "/api/app/agent/stop" and method == "POST":
            handler._send_json(200, self.stop_agent_process())  # type: ignore[attr-defined]
            return
        if path == "/api/app/agent/logs" and method == "GET":
            self.is_agent_running()
            handler._send_json(200, {"running": self.is_agent_running(), "lines": list(self._agent_logs[-500:])})  # type: ignore[attr-defined]
            return
        if path == "/api/app/operator/start" and method == "POST":
            body = self._read_json(handler)
            try:
                res = self.start_operator_process(body)
                handler._send_json(200, res)  # type: ignore[attr-defined]
            except Exception as exc:
                handler._send_json(400, {"error": str(exc)})  # type: ignore[attr-defined]
            return
        if path == "/api/app/operator/stop" and method == "POST":
            handler._send_json(200, self.stop_operator_process())  # type: ignore[attr-defined]
            return
        if path == "/api/app/operator/logs" and method == "GET":
            running = self.is_operator_running()
            handler._send_json(200, {"running": running, "lines": list(self._operator_logs[-500:])})  # type: ignore[attr-defined]
            return

        # Требуется активная авторизация CRM для всех остальных маршрутов
        crm_url, crm_token = self._crm_auth()
        if not crm_url or not crm_token:
            handler._send_json(401, {"error": "Сначала войдите в учётку CRM"})  # type: ignore[attr-defined]
            return

        # ---- 2. Локальный Агент и Sandbox ----
        if path == "/api/ai/agent" and method == "GET":
            handler._send_json(200, self.agent_health())  # type: ignore[attr-defined]
            return
        if path == "/api/ai/agent" and method == "POST":
            self._api_agent_run(handler)
            return
        if path == "/api/ai/agent/approve" and method == "POST":
            self._api_agent_approve(handler)
            return
        if path.startswith("/api/ai/agent/sandbox"):
            self._api_agent_sandbox(handler, path, query)
            return

        # ---- 3. Умные ИИ-эндпоинты (локальная модель ПК ИЛИ сервер CRM) ----
        if path == "/api/ai/models" and method == "POST":
            self._api_ai_models(handler, full_rel)
            return
        if path == "/api/ai/chat" and method == "POST":
            self._api_ai_chat(handler, full_rel)
            return
        if path == "/api/agent/plan" and method == "POST":
            self._api_agent_plan(handler, full_rel)
            return
        if path == "/api/ai/agent/summarize" and method == "POST":
            self._api_agent_summarize(handler, full_rel)
            return
        if path == "/api/ai/agent/coach" and method == "POST":
            self._api_agent_coach(handler, full_rel)
            return
        if path == "/api/ai/agent/operator" and method == "POST":
            self._api_agent_operator(handler, full_rel)
            return

        # ---- 4. SSE-поток событий CRM ----
        if path == "/api/events" and method == "GET":
            self._proxy_crm_sse(handler, full_rel)
            return

        # ---- 5. Прямой прокси к БД CRM ----
        self._proxy_crm_request(handler, full_rel)

    def _read_json(self, handler: BaseHTTPRequestHandler) -> Dict[str, Any]:
        try:
            raw = handler._read_body()  # type: ignore[attr-defined]
            parsed = json.loads(raw.decode("utf-8") or "{}")
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}

    def _api_app_state(self, handler: BaseHTTPRequestHandler) -> None:
        crm_url, crm_token = self._crm_auth()
        profile = self.settings.crm_profile if isinstance(self.settings.crm_profile, dict) else {}
        authenticated = bool(crm_token and isinstance(profile.get("user"), dict) and profile["user"].get("id"))
        handler._send_json(  # type: ignore[attr-defined]
            200,
            {
                "ok": True,
                "appVersion": APP_VERSION,
                "authenticated": authenticated,
                "crmUrl": crm_url or self.settings.crm_url,
                "crmEmail": self.settings.crm_email,
                "rememberKey": bool(self.settings.remember_key),
                "theme": self.settings.theme,
                "profile": profile if authenticated else None,
                "presets": PROVIDER_PRESETS,
                "reasoningModes": REASONING_MODES,
                "harnessState": self.settings.harness_state,
                "localSettings": {
                    "provider": self.settings.provider,
                    "baseUrl": self.settings.base_url,
                    "model": self.settings.model,
                    "hasApiKey": bool(self.settings.api_key),
                    "apiKeyMask": settings_mod.mask_secret(self.settings.api_key),
                    "temperature": self.settings.temperature,
                    "topP": self.settings.top_p,
                    "maxTokens": self.settings.max_tokens,
                    "reasoning": self.settings.reasoning,
                    "operatorValues": self.settings.values_for(agent_by_id(self.catalog, "operator"))
                    if agent_by_id(self.catalog, "operator")
                    else {},
                    "agentValues": self.settings.values_for(agent_by_id(self.catalog, "chat_agent"))
                    if agent_by_id(self.catalog, "chat_agent")
                    else {},
                },
                "agentHealth": self.agent_health(),
                "operatorRunning": self.is_operator_running(),
            },
        )

    def _api_crm_check(self, handler: BaseHTTPRequestHandler) -> None:
        body = self._read_json(handler)
        url = str(body.get("serverUrl") or self.settings.crm_url or "")
        ok, msg = crm_client.check_health(url)
        normalized = crm_client.normalize_server_url(url)
        if ok and normalized:
            self.settings.crm_url = normalized
            self.save_settings()
        handler._send_json(200 if ok else 400, {"ok": ok, "message": msg, "serverUrl": normalized})  # type: ignore[attr-defined]

    def _api_crm_login(self, handler: BaseHTTPRequestHandler) -> None:
        body = self._read_json(handler)
        server_url = str(body.get("serverUrl") or self.settings.crm_url or "")
        email = str(body.get("email") or "").strip()
        password = str(body.get("password") or "")
        totp = str(body.get("totpCode") or "").strip()
        remember = bool(body.get("remember", self.settings.remember_key))
        try:
            res = crm_client.login(server_url, email, password, totp_code=totp)
        except crm_client.CrmClientError as exc:
            handler._send_json(  # type: ignore[attr-defined]
                401 if exc.requires_totp else 400,
                {"ok": False, "error": str(exc), "requiresTotp": exc.requires_totp},
            )
            return

        self.settings.crm_url = crm_client.normalize_server_url(server_url)
        self.settings.crm_email = email
        self.settings.remember_key = remember
        self.settings.crm_session_token = str(res.get("sessionToken") or "")
        profile = {k: v for k, v in res.items() if k != "sessionToken"}
        self.settings.crm_profile = profile
        op = profile.get("operator") if isinstance(profile.get("operator"), dict) else {}
        if op:
            if op.get("serverUrl"):
                self.settings.set_value("operator", "crm_server", str(op["serverUrl"]))
            if op.get("token"):
                self.settings.set_value("operator", "crm_token", str(op["token"]))
        self.save_settings()
        handler._send_json(200, {"ok": True, "profile": profile, "crmUrl": self.settings.crm_url})  # type: ignore[attr-defined]

    def _api_crm_refresh(self, handler: BaseHTTPRequestHandler) -> None:
        crm_url, crm_token = self._crm_auth()
        if not crm_url or not crm_token:
            handler._send_json(401, {"error": "Не авторизован"})  # type: ignore[attr-defined]
            return
        try:
            body = self._read_json(handler)
            reissue = bool(body.get("reissue"))
            path = f"{crm_url}/api/launcher/profile" + ("?reissue=1" if reissue else "")
            with crm_client.open_crm_stream("GET", crm_url, "/api/launcher/profile" + ("?reissue=1" if reissue else ""), bearer_token=crm_token, timeout=12.0) as resp:
                profile = json.loads(resp.read().decode("utf-8", "replace") or "{}")
            if not isinstance(profile, dict) or not profile.get("ok"):
                raise crm_client.CrmClientError("Не удалось обновить профиль")
        except crm_client.CrmClientError as exc:
            handler._send_json(401, {"error": str(exc)})  # type: ignore[attr-defined]
            return
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                self.settings.clear_crm_auth()
                self.save_settings()
                handler._send_json(401, {"error": "Сессия CRM истекла"})  # type: ignore[attr-defined]
                return
            handler._send_json(502, {"error": f"Ошибка CRM HTTP {exc.code}"})  # type: ignore[attr-defined]
            return

        self.settings.crm_profile = profile
        op = profile.get("operator") if isinstance(profile.get("operator"), dict) else {}
        if op and op.get("token"):
            self.settings.set_value("operator", "crm_token", str(op["token"]))
        self.save_settings()
        handler._send_json(200, {"ok": True, "profile": profile})  # type: ignore[attr-defined]

    def _api_crm_logout(self, handler: BaseHTTPRequestHandler) -> None:
        crm_url, crm_token = self._crm_auth()
        self.stop_agent_process()
        self.stop_operator_process()
        if crm_url and crm_token:
            crm_client.logout(crm_url, crm_token)
        self.settings.clear_crm_auth()
        self.save_settings()
        handler._send_json(200, {"ok": True})  # type: ignore[attr-defined]

    def _api_theme(self, handler: BaseHTTPRequestHandler) -> None:
        body = self._read_json(handler)
        theme = str(body.get("theme") or "").lower()
        if theme in ("dark", "light"):
            self.settings.theme = theme
            self.save_settings()
        handler._send_json(200, {"ok": True, "theme": self.settings.theme})  # type: ignore[attr-defined]

    def _api_prefs(self, handler: BaseHTTPRequestHandler) -> None:
        if handler.command.upper() == "GET":
            handler._send_json(200, {"harnessState": self.settings.harness_state})  # type: ignore[attr-defined]
            return
        body = self._read_json(handler)
        if isinstance(body.get("harnessState"), dict):
            self.settings.harness_state.update(body["harnessState"])
        if isinstance(body.get("localModel"), dict):
            lm = body["localModel"]
            if "provider" in lm and lm["provider"] is not None:
                self.settings.provider = str(lm["provider"])
            if "baseUrl" in lm and lm["baseUrl"] is not None:
                self.settings.base_url = str(lm["baseUrl"])
            if "model" in lm and lm["model"] is not None:
                self.settings.model = str(lm["model"])
            if "apiKey" in lm and lm["apiKey"] is not None:
                self.settings.api_key = str(lm["apiKey"])
            if "rememberKey" in lm:
                self.settings.remember_key = bool(lm["rememberKey"])
        self.save_settings()
        handler._send_json(200, {"ok": True, "harnessState": self.settings.harness_state})  # type: ignore[attr-defined]

    def _api_pick_folder(self, handler: BaseHTTPRequestHandler) -> None:
        chosen = ""
        if self._pick_folder_cb is not None:
            try:
                chosen = self._pick_folder_cb() or ""
            except Exception:
                chosen = ""
        elif sys.modules.get("tkinter") or os.environ.get("DISPLAY") or sys.platform.startswith("win"):
            try:
                import tkinter as tk  # type: ignore
                from tkinter import filedialog  # type: ignore

                root = tk.Tk()
                root.withdraw()
                try:
                    root.attributes("-topmost", True)
                except Exception:
                    pass
                chosen = filedialog.askdirectory(title="Выберите папку") or ""
                root.destroy()
            except Exception:
                chosen = ""
        handler._send_json(200, {"ok": bool(chosen), "path": chosen})  # type: ignore[attr-defined]

    def _api_extract_file(self, handler: BaseHTTPRequestHandler) -> None:
        body = self._read_json(handler)
        name = str(body.get("name") or "file.txt")
        mime = str(body.get("mime") or "")
        b64 = str(body.get("dataBase64") or "")
        if "," in b64 and b64.startswith("data:"):
            b64 = b64.split(",", 1)[1]
        try:
            raw = base64.b64decode(b64)
        except Exception:
            handler._send_json(400, {"error": "Некорректные данные файла"})  # type: ignore[attr-defined]
            return
        parsed = file_extract.extract_attachment(name, raw, mime)
        handler._send_json(200, parsed)  # type: ignore[attr-defined]

    def _api_runtime(self, handler: BaseHTTPRequestHandler) -> None:
        self.is_agent_running()
        self.is_operator_running()
        handler._send_json(  # type: ignore[attr-defined]
            200,
            {
                "ok": True,
                "runtime": bundle.runtime_info(),
                "configPath": str(self.settings_path),
                "workspace": str(settings_mod.workspace_dir()),
                "deps": {
                    "operator": [
                        {
                            "name": d.package,
                            "module": d.module,
                            "ok": d.present,
                            "hint": f"Модуль {d.module} ({d.package}): {'установлен' if d.present else 'не найден'}",
                        }
                        for d in deps.check("operator")
                    ],
                },
                "agentHealth": self.agent_health(),
                "operatorRunning": self.is_operator_running(),
                "agentLogs": list(self._agent_logs[-300:]),
                "operatorLogs": list(self._operator_logs[-300:]),
            },
        )

    # ------------------------------------------------------------------
    # Прокси к БД CRM
    # ------------------------------------------------------------------
    def _proxy_crm_request(self, handler: BaseHTTPRequestHandler, full_rel: str) -> None:
        crm_url, crm_token = self._crm_auth()
        raw_body = b""
        try:
            raw_body = handler._read_body()  # type: ignore[attr-defined]
        except ValueError as exc:
            handler._send_json(413, {"error": str(exc)})  # type: ignore[attr-defined]
            return

        in_headers: Dict[str, str] = {}
        for k in ("Content-Type", "Accept"):
            v = handler.headers.get(k)
            if v:
                in_headers[k] = v

        try:
            with crm_client.open_crm_stream(
                handler.command,
                crm_url,
                full_rel,
                bearer_token=crm_token,
                body=raw_body if handler.command.upper() not in ("GET", "HEAD") and raw_body else None,
                headers=in_headers,
                timeout=90.0,
            ) as resp:
                ct = resp.headers.get("Content-Type") or "application/json; charset=utf-8"
                data = resp.read()
                extra: Dict[str, str] = {}
                disp = resp.headers.get("Content-Disposition")
                if disp:
                    extra["Content-Disposition"] = disp
                handler._send_bytes(int(getattr(resp, "status", 200) or 200), ct, data, extra)  # type: ignore[attr-defined]
        except urllib.error.HTTPError as exc:
            raw_err = exc.read()
            ct = exc.headers.get("Content-Type") if exc.headers else "application/json; charset=utf-8"
            handler._send_bytes(int(exc.code), ct or "application/json; charset=utf-8", raw_err)  # type: ignore[attr-defined]
        except crm_client.CrmClientError as exc:
            handler._send_json(502, {"error": str(exc)})  # type: ignore[attr-defined]
        except Exception as exc:
            handler._send_json(502, {"error": f"Ошибка связи с CRM: {exc}"})  # type: ignore[attr-defined]

    def _proxy_crm_sse(self, handler: BaseHTTPRequestHandler, full_rel: str) -> None:
        crm_url, crm_token = self._crm_auth()
        try:
            resp = crm_client.open_crm_stream(
                "GET",
                crm_url,
                full_rel,
                bearer_token=crm_token,
                headers={"Accept": "text/event-stream"},
                timeout=3600.0,
            )
        except urllib.error.HTTPError as exc:
            handler._send_json(int(exc.code), {"error": f"SSE ошибка {exc.code}"})  # type: ignore[attr-defined]
            return
        except Exception as exc:
            handler._send_json(502, {"error": str(exc)})  # type: ignore[attr-defined]
            return

        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-store, no-transform")
        handler.send_header("Connection", "close")
        handler.end_headers()
        try:
            with resp:
                while True:
                    line = resp.readline()
                    if not line:
                        break
                    handler.wfile.write(line)
                    handler.wfile.flush()
        except (OSError, BrokenPipeError, ConnectionResetError):
            pass

    # ------------------------------------------------------------------
    # Модели и Чат с моделью (поддержка локальных LLM на ПК)
    # ------------------------------------------------------------------
    def _api_ai_models(self, handler: BaseHTTPRequestHandler, full_rel: str) -> None:
        raw = handler._read_body()  # type: ignore[attr-defined]
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            body = {}
        base_url = _normalize_ai_base(str(body.get("baseUrl") or ""))
        api_key = str(body.get("apiKey") or "")
        model = str(body.get("model") or "")
        if self._should_use_local_model(base_url):
            st, data = _inspect_local_models(base_url, api_key, model)
            handler._send_json(st, data)  # type: ignore[attr-defined]
            return
        # Проксируем на сайт CRM
        crm_url, crm_token = self._crm_auth()
        try:
            with crm_client.open_crm_stream(
                "POST", crm_url, full_rel, bearer_token=crm_token, body=raw,
                headers={"Content-Type": "application/json"}, timeout=20.0,
            ) as resp:
                handler._send_bytes(int(getattr(resp, "status", 200) or 200), "application/json; charset=utf-8", resp.read())  # type: ignore[attr-defined]
        except urllib.error.HTTPError as exc:
            handler._send_bytes(int(exc.code), "application/json; charset=utf-8", exc.read())  # type: ignore[attr-defined]
        except Exception as exc:
            handler._send_json(502, {"error": str(exc)})  # type: ignore[attr-defined]

    def _api_ai_chat(self, handler: BaseHTTPRequestHandler, full_rel: str) -> None:
        raw = handler._read_body()  # type: ignore[attr-defined]
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            handler._send_json(400, {"error": "Некорректный JSON"})  # type: ignore[attr-defined]
            return

        req_settings = body.get("settings") if isinstance(body.get("settings"), Mapping) else {}
        base_url = _normalize_ai_base(str(req_settings.get("baseUrl") or ""))
        if not self._should_use_local_model(base_url):
            # Облачная модель или локальная CRM — стримим прямо через сайт CRM
            crm_url, crm_token = self._crm_auth()
            try:
                resp = crm_client.open_crm_stream(
                    "POST", crm_url, full_rel, bearer_token=crm_token, body=raw,
                    headers={"Content-Type": "application/json", "Accept": "text/event-stream"}, timeout=300.0,
                )
            except urllib.error.HTTPError as exc:
                handler._send_bytes(int(exc.code), "application/json; charset=utf-8", exc.read())  # type: ignore[attr-defined]
                return
            except Exception as exc:
                handler._send_json(502, {"error": str(exc)})  # type: ignore[attr-defined]
                return

            ct = resp.headers.get("Content-Type") or "text/event-stream; charset=utf-8"
            if "text/event-stream" not in ct:
                with resp:
                    handler._send_bytes(int(getattr(resp, "status", 200) or 200), ct, resp.read())  # type: ignore[attr-defined]
                return

            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
            handler.send_header("Cache-Control", "no-store, no-transform")
            handler.send_header("Connection", "close")
            handler.end_headers()
            try:
                with resp:
                    while True:
                        chunk = resp.read1(8192) if hasattr(resp, "read1") else resp.read(4096)
                        if not chunk:
                            break
                        handler.wfile.write(chunk)
                        handler.wfile.flush()
            except (OSError, BrokenPipeError, ConnectionResetError):
                pass
            return

        # Локальная модель на ПК при удалённом сервере CRM:
        # 1) проверяем лимиты и собираем RAG через /api/launcher/chat (prepare)
        crm_url, crm_token = self._crm_auth()
        messages = [m for m in (body.get("messages") or []) if isinstance(m, Mapping)]
        history_tokens = sum(_estimate_tokens(m.get("content")) for m in messages if m.get("role") != "system")
        prep_payload = {
            "action": "prepare",
            "chatId": body.get("chatId") or 0,
            "ragFolderId": body.get("ragFolderId") or 0,
            "ragQuery": body.get("ragQuery") or "",
            "params": body.get("params") or {},
            "historyTokens": history_tokens,
        }
        try:
            with crm_client.open_crm_stream(
                "POST", crm_url, "/api/launcher/chat", bearer_token=crm_token,
                body=json.dumps(prep_payload, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json"}, timeout=30.0,
            ) as resp:
                prep = json.loads(resp.read().decode("utf-8", "replace") or "{}")
        except urllib.error.HTTPError as exc:
            handler._send_bytes(int(exc.code), "application/json; charset=utf-8", exc.read())  # type: ignore[attr-defined]
            return
        except Exception as exc:
            handler._send_json(502, {"error": f"Ошибка подготовки чата в CRM: {exc}"})  # type: ignore[attr-defined]
            return

        chat_info = prep.get("chat") or {}
        chat_id = int(chat_info.get("id") or 0)
        eff_params = prep.get("params") if isinstance(prep.get("params"), dict) else {}
        rag_context = str(body.get("ragContext") or prep.get("ragContext") or "").strip()
        rag_hits = int(prep.get("ragHits") or 0)
        rag_full = prep.get("ragFull")

        model = str(req_settings.get("model") or "").strip()
        api_key = str(req_settings.get("apiKey") or "").strip()
        if not model:
            handler._send_json(400, {"error": "Укажите модель"})  # type: ignore[attr-defined]
            return

        preamble: List[Dict[str, Any]] = []
        sys_txt = str(eff_params.get("system") or "").strip()
        if sys_txt:
            preamble.append({"role": "system", "content": sys_txt})
        if rag_context:
            preamble.append({
                "role": "system",
                "content": f"Контекст из папки, выбранной пользователем (RAG). Опирайся на него, но не выдумывай то, чего в нём нет:\n\n{rag_context}",
            })
        out_messages = preamble + [dict(m) for m in messages if m.get("role") != "system"]
        user_msg_text = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                c = m.get("content")
                if isinstance(c, str):
                    user_msg_text = c
                elif isinstance(c, list):
                    user_msg_text = "\n".join(str(p.get("text") or "") for p in c if isinstance(p, Mapping) and p.get("type") == "text")
                break

        up_body: Dict[str, Any] = {"model": model, "messages": out_messages, "stream": True}
        if eff_params.get("temperature") is not None:
            up_body["temperature"] = eff_params["temperature"]
        if eff_params.get("topP") is not None:
            up_body["top_p"] = eff_params["topP"]
        if eff_params.get("maxTokens") is not None:
            up_body["max_tokens"] = eff_params["maxTokens"]
        if eff_params.get("seed") is not None:
            up_body["seed"] = eff_params["seed"]
        if eff_params.get("streamUsage", True):
            up_body["stream_options"] = {"include_usage": True}
        reasoning_mode = str(eff_params.get("reasoning") or "default")
        if reasoning_mode != "default":
            if reasoning_mode == "off":
                up_body["reasoning_effort"] = "none"
            elif reasoning_mode == "budget":
                if eff_params.get("thinkingBudget"):
                    up_body["thinking_budget"] = eff_params["thinkingBudget"]
                up_body["reasoning_effort"] = "high"
            else:
                up_body["reasoning_effort"] = reasoning_mode
            if eff_params.get("sendThinkingFlag"):
                up_body["chat_template_kwargs"] = {"enable_thinking": reasoning_mode != "off"}

        req = urllib.request.Request(
            f"{base_url}/chat/completions",
            data=json.dumps(up_body, ensure_ascii=False).encode("utf-8"),
            method="POST",
        )
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "text/event-stream")
        if api_key:
            req.add_header("Authorization", f"Bearer {api_key}")

        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            up_resp = opener.open(req, timeout=300.0)
        except urllib.error.HTTPError as exc:
            err_raw = exc.read().decode("utf-8", "replace")
            handler._send_json(502, {"error": f"Ошибка локальной модели ({exc.code}): {err_raw[:400]}"})  # type: ignore[attr-defined]
            return
        except Exception as exc:
            handler._send_json(502, {"error": f"Нет связи с локальной моделью {base_url}: {exc}"})  # type: ignore[attr-defined]
            return

        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-store, no-transform")
        handler.send_header("Connection", "close")
        handler.end_headers()

        def push_sse(obj: Any) -> None:
            line = f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode("utf-8")
            handler.wfile.write(line)
            handler.wfile.flush()

        answer = ""
        thinking = ""
        usage_rep: Optional[Dict[str, int]] = None
        ct = (up_resp.headers.get("Content-Type") or "").lower()
        try:
            with up_resp:
                if "text/event-stream" not in ct:
                    parsed = json.loads(up_resp.read().decode("utf-8", "replace") or "{}")
                    choices = parsed.get("choices") or []
                    msg = choices[0].get("message") if choices and isinstance(choices[0], Mapping) else {}
                    answer = str((msg or {}).get("content") or "")
                    thinking = str((msg or {}).get("reasoning_content") or (msg or {}).get("reasoning") or "")
                    u = parsed.get("usage") if isinstance(parsed.get("usage"), Mapping) else None
                    if u:
                        usage_rep = {
                            "prompt": int(u.get("prompt_tokens") or 0),
                            "completion": int(u.get("completion_tokens") or 0),
                            "total": int(u.get("total_tokens") or 0),
                        }
                    if thinking:
                        push_sse({"reasoning": thinking})
                    if answer:
                        push_sse({"delta": answer})
                else:
                    for raw_line in up_resp:
                        line = raw_line.decode("utf-8", "replace").strip()
                        if not line or line.startswith(":") or not line.startswith("data:"):
                            continue
                        payload_str = line[5:].strip()
                        if payload_str == "[DONE]":
                            continue
                        try:
                            chunk = json.loads(payload_str)
                        except json.JSONDecodeError:
                            continue
                        choices = chunk.get("choices") or []
                        if choices and isinstance(choices[0], Mapping):
                            delta = choices[0].get("delta") or choices[0].get("message") or {}
                            if isinstance(delta, Mapping):
                                rc = delta.get("reasoning_content") or delta.get("reasoning")
                                if rc:
                                    thinking += str(rc)
                                    push_sse({"reasoning": str(rc)})
                                content_piece = delta.get("content")
                                if content_piece:
                                    answer += str(content_piece)
                                    push_sse({"delta": str(content_piece)})
                        u = chunk.get("usage")
                        if isinstance(u, Mapping) and (u.get("prompt_tokens") or u.get("completion_tokens")):
                            usage_rep = {
                                "prompt": int(u.get("prompt_tokens") or 0),
                                "completion": int(u.get("completion_tokens") or 0),
                                "total": int(u.get("total_tokens") or 0),
                            }
                            push_sse({"usage": usage_rep})

            rec_body = {
                "action": "record",
                "chatId": chat_id,
                "userMessage": user_msg_text,
                "answer": answer,
                "thinking": thinking,
                "attachments": body.get("attachments") or [],
                "promptTokens": usage_rep["prompt"] if usage_rep else _estimate_tokens(out_messages),
                "completionTokens": usage_rep["completion"] if usage_rep else _estimate_tokens(answer),
                "totalTokens": usage_rep["total"] if usage_rep else 0,
                "usageReported": bool(usage_rep),
            }
            summary: Dict[str, Any] = {}
            try:
                with crm_client.open_crm_stream(
                    "POST", crm_url, "/api/launcher/chat", bearer_token=crm_token,
                    body=json.dumps(rec_body, ensure_ascii=False).encode("utf-8"),
                    headers={"Content-Type": "application/json"}, timeout=20.0,
                ) as rec_resp:
                    summary = json.loads(rec_resp.read().decode("utf-8", "replace") or "{}")
            except Exception:
                pass
            push_sse({
                "done": True,
                "ragHits": rag_hits,
                "ragFull": rag_full,
                "reasoningDowngraded": bool(prep.get("reasoningDowngraded")),
                "usage": summary.get("usage") or usage_rep or {"prompt": 0, "completion": 0, "total": 0, "estimated": True},
                "chat": summary.get("chat") or chat_info,
                "monthly": summary.get("monthly") or prep.get("monthly"),
            })
        except (OSError, BrokenPipeError, ConnectionResetError):
            pass

    # ------------------------------------------------------------------
    # Мост Агента (/api/ai/agent, /approve, /sandbox*)
    # ------------------------------------------------------------------
    def _sync_agent_event(self, payload: Mapping[str, Any]) -> Dict[str, Any]:
        crm_url, crm_token = self._crm_auth()
        try:
            with crm_client.open_crm_stream(
                "POST",
                crm_url,
                "/api/launcher/agent/events",
                bearer_token=crm_token,
                body=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                timeout=20.0,
            ) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace") or "{}")
                return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _api_agent_run(self, handler: BaseHTTPRequestHandler) -> None:
        raw = handler._read_body()  # type: ignore[attr-defined]
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            handler._send_json(400, {"error": "Некорректный JSON"})  # type: ignore[attr-defined]
            return

        body["allowClientLoopback"] = True
        crm_url, crm_token = self._crm_auth()
        try:
            with crm_client.open_crm_stream(
                "POST",
                crm_url,
                "/api/launcher/agent/prepare",
                bearer_token=crm_token,
                body=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                timeout=45.0,
            ) as prep_resp:
                prep = json.loads(prep_resp.read().decode("utf-8", "replace") or "{}")
        except urllib.error.HTTPError as exc:
            handler._send_bytes(int(exc.code), "application/json; charset=utf-8", exc.read())  # type: ignore[attr-defined]
            return
        except Exception as exc:
            handler._send_json(502, {"error": f"Ошибка подготовки запуска в CRM: {exc}"})  # type: ignore[attr-defined]
            return

        full_payload = prep.get("payload") if isinstance(prep.get("payload"), dict) else {}
        meta = prep.get("meta") if isinstance(prep.get("meta"), dict) else {}
        model_name = str(meta.get("model") or "")
        prompt_est = int(meta.get("promptEst") or 0)
        agent_role = str(meta.get("agentRole") or "agent")
        sandbox_project = str(meta.get("sandboxProject") or "")
        subagent_id = meta.get("subagentId")
        agent_conv_id = meta.get("agentConversationId")
        tester_conv_id = meta.get("testerConversationId")
        subagent_conv_id = meta.get("subagentConversationId")

        health = self.ensure_agent_running()
        if not health.get("available"):
            handler._send_json(503, {"error": "Не удалось запустить встроенный локальный Агент"})  # type: ignore[attr-defined]
            return

        port = self._agent_port
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3600)
        up_headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "Connection": "close",
        }
        if self._agent_http_token:
            up_headers["Authorization"] = f"Bearer {self._agent_http_token}"

        try:
            conn.request("POST", "/run", body=json.dumps(full_payload, ensure_ascii=False).encode("utf-8"), headers=up_headers)
            up_resp = conn.getresponse()
        except Exception as exc:
            conn.close()
            handler._send_json(503, {"error": f"Локальный Агент недоступен: {exc}"})  # type: ignore[attr-defined]
            return

        if up_resp.status != 200:
            err_body = up_resp.read().decode("utf-8", "replace")
            conn.close()
            handler._send_json(502, {"error": f"Агент ответил HTTP {up_resp.status}: {err_body[:300]}"})  # type: ignore[attr-defined]
            return

        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-store, no-transform")
        handler.send_header("Connection", "close")
        handler.end_headers()

        active_subagents: Dict[str, Dict[str, Any]] = {}
        closed_subagents: set[str] = set()
        active_testers: Dict[str, Dict[str, Any]] = {}
        heartbeat_at: Dict[str, float] = {}

        text_latest = ""
        reasoning_latest = ""
        rep_prompt = 0
        rep_comp = 0
        rep_total = 0
        usage_recorded = False

        def touch_open_heartbeats() -> None:
            now = time.monotonic()
            due: List[int] = []
            for rk, mapped in active_subagents.items():
                if rk in closed_subagents:
                    continue
                if now - heartbeat_at.get(rk, 0.0) >= HEARTBEAT_INTERVAL_SEC:
                    heartbeat_at[rk] = now
                    due.append(int(mapped["runId"]))
            if due:
                self._sync_agent_event({"action": "subagent_heartbeat", "runIds": due})

        def handle_frame(frame_text: str) -> str:
            nonlocal text_latest, reasoning_latest, rep_prompt, rep_comp, rep_total, usage_recorded
            lines = re.split(r"\r?\n", frame_text)
            ev_line = next((l for l in lines if l.startswith("event:")), None)
            data_lines = [l[5:].lstrip() for l in lines if l.startswith("data:")]
            if not data_lines:
                touch_open_heartbeats()
                return frame_text + "\n\n"

            ev = ev_line[6:].strip() if ev_line else "message"
            try:
                parsed = json.loads("\n".join(data_lines).strip())
            except json.JSONDecodeError:
                return frame_text + "\n\n"
            if not isinstance(parsed, dict):
                return frame_text + "\n\n"

            if ev == "text" and isinstance(parsed.get("text"), str):
                text_latest = parsed["text"]
            elif ev == "reasoning" and isinstance(parsed.get("text"), str):
                reasoning_latest = parsed["text"]
            elif ev == "approval_required":
                app_id = str(parsed.get("approvalId") or "").strip()
                nonce = str(parsed.pop("nonce", "") or "").strip()
                if app_id and nonce:
                    with self._lock:
                        self._approval_nonces[app_id] = nonce
                rk = str(parsed.get("testerRunKey") or "")
                if rk and rk in active_testers:
                    parsed["testerRunId"] = active_testers[rk]["runId"]
                    parsed["testerConversationId"] = active_testers[rk]["testerConversationId"]
                srk = str(parsed.get("subagentRunKey") or "")
                if srk and srk in active_subagents:
                    parsed["subagentRunId"] = active_subagents[srk]["runId"]
                    parsed["subagentConversationId"] = active_subagents[srk]["subagentConversationId"]
                return f"event: {ev}\ndata: {json.dumps(parsed, ensure_ascii=False)}\n\n"
            elif ev == "subagent_start":
                rk = str(parsed.get("runKey") or "default")
                sid = int(parsed.get("subagentId") or subagent_id or 0)
                if sid > 0:
                    synced = self._sync_agent_event({
                        "action": "subagent_start",
                        "subagentId": sid,
                        "agentConversationId": agent_conv_id,
                        "existingConversationId": subagent_conv_id,
                        "agentRole": agent_role,
                        "forceNewChat": bool(parsed.get("forceNewChat")),
                        "isContinuation": bool(parsed.get("isContinuation")),
                        "callerKind": parsed.get("callerKind") or "orchestrator",
                        "callerSubagentId": parsed.get("callerSubagentId"),
                        "sandboxProject": parsed.get("sandboxProject") or sandbox_project,
                        "summary": parsed.get("summary") or "",
                        "task": parsed.get("task") or "",
                        "model": parsed.get("model") or model_name,
                        "usedCustomApi": bool(parsed.get("usedCustomApi")),
                    })
                    if synced.get("runId"):
                        active_subagents[rk] = {
                            "runId": synced["runId"],
                            "subagentId": synced["subagentId"],
                            "subagentConversationId": synced["subagentConversationId"],
                        }
                        out = {
                            **synced,
                            "runKey": rk,
                            "tier": parsed.get("tier"),
                            "routingMode": parsed.get("routingMode"),
                            "toolProfile": parsed.get("toolProfile"),
                            "isContinuation": bool(parsed.get("isContinuation")),
                            "callerSubagentName": parsed.get("callerSubagentName") or "",
                        }
                        return f"event: subagent_run\ndata: {json.dumps(out, ensure_ascii=False)}\n\n"
                return f"event: subagent_run\ndata: {json.dumps(parsed, ensure_ascii=False)}\n\n"
            elif ev in ("overseer_start", "overseer_status", "overseer_reasoning", "overseer_done"):
                srk = str(parsed.get("subagentRunKey") or "")
                mapped = active_subagents.get(srk)
                if mapped:
                    parsed["subagentRunId"] = mapped["runId"]
                    parsed["subagentId"] = mapped["subagentId"]
                    parsed["subagentConversationId"] = mapped["subagentConversationId"]
                return f"event: {ev}\ndata: {json.dumps(parsed, ensure_ascii=False)}\n\n"
            elif ev in (
                "subagent_status", "subagent_reasoning", "subagent_text", "subagent_action",
                "subagent_handoff", "subagent_chat_rotated", "subagent_handoff_new_chat",
            ):
                rk = str(parsed.get("runKey") or "default")
                mapped = active_subagents.get(rk)
                if mapped:
                    parsed["runId"] = mapped["runId"]
                    parsed["subagentId"] = mapped["subagentId"]
                    parsed["subagentConversationId"] = mapped["subagentConversationId"]
                    touch_open_heartbeats()
                return f"event: {ev}\ndata: {json.dumps(parsed, ensure_ascii=False)}\n\n"
            elif ev == "subagent_done":
                rk = str(parsed.get("runKey") or "default")
                mapped = active_subagents.get(rk)
                u = parsed.get("usage") if isinstance(parsed.get("usage"), Mapping) else {}
                sp = max(0, int(round(float(u.get("prompt") or u.get("prompt_tokens") or parsed.get("promptTokens") or 0))))
                sc = max(0, int(round(float(u.get("completion") or u.get("completion_tokens") or parsed.get("completionTokens") or 0))))
                st_tok = max(0, int(round(float(u.get("total") or u.get("total_tokens") or parsed.get("totalTokens") or 0))))
                if mapped:
                    closed_subagents.add(rk)
                    synced = self._sync_agent_event({
                        "action": "subagent_done",
                        "runId": mapped["runId"],
                        "status": parsed.get("status") or "completed",
                        "outputSummary": parsed.get("outputSummary") or parsed.get("reportSummary") or "",
                        "requestedCalleeSlug": parsed.get("requestedCalleeSlug") or "",
                        "requestedCalleeTask": parsed.get("requestedCalleeTask") or "",
                        "filesTouched": parsed.get("filesTouched") or [],
                        "promptTokens": 0 if agent_role == "subagent" else sp,
                        "completionTokens": 0 if agent_role == "subagent" else sc,
                        "totalTokens": 0 if agent_role == "subagent" else st_tok,
                        "model": parsed.get("model") or model_name,
                        "usedCustomApi": bool(parsed.get("usedCustomApi")),
                        "fullResponse": parsed.get("fullResponse"),
                        "reasoning": parsed.get("reasoning"),
                        "actions": parsed.get("actions"),
                        "files": parsed.get("files"),
                        "error": parsed.get("error"),
                    })
                    if isinstance(synced.get("run"), dict):
                        sr = synced["run"]
                        parsed["runId"] = sr.get("id")
                        parsed["subagentId"] = sr.get("subagentId")
                        parsed["subagentConversationId"] = sr.get("subagentConversationId")
                        parsed["run"] = sr
                return f"event: subagent_done\ndata: {json.dumps(parsed, ensure_ascii=False)}\n\n"
            elif ev == "tester_start":
                rk = str(parsed.get("runKey") or "default")
                synced = self._sync_agent_event({
                    "action": "tester_start",
                    "agentConversationId": agent_conv_id,
                    "testerConversationId": tester_conv_id if agent_role == "tester" else None,
                    "agentRole": agent_role,
                    "title": parsed.get("title"),
                    "sandboxProject": parsed.get("sandboxProject") or sandbox_project,
                    "summary": parsed.get("summary") or "",
                    "model": parsed.get("model") or model_name,
                })
                if synced.get("runId"):
                    active_testers[rk] = {
                        "runId": synced["runId"],
                        "testerConversationId": synced["testerConversationId"],
                    }
                    return f"event: tester_run\ndata: {json.dumps({'runKey': rk, **synced}, ensure_ascii=False)}\n\n"
                return f"event: tester_run\ndata: {json.dumps(parsed, ensure_ascii=False)}\n\n"
            elif ev in ("tester_status", "tester_reasoning", "tester_text", "tester_action"):
                rk = str(parsed.get("runKey") or "default")
                mapped = active_testers.get(rk)
                if mapped:
                    parsed["runId"] = mapped["runId"]
                    parsed["testerConversationId"] = mapped["testerConversationId"]
                return f"event: {ev}\ndata: {json.dumps(parsed, ensure_ascii=False)}\n\n"
            elif ev == "action":
                rk = str(parsed.get("runKey") or parsed.get("testerRunKey") or "")
                if rk in active_testers:
                    parsed.setdefault("runId", active_testers[rk]["runId"])
                    parsed.setdefault("testerConversationId", active_testers[rk]["testerConversationId"])
                srk = str(parsed.get("subagentRunKey") or parsed.get("runKey") or "")
                if srk in active_subagents:
                    parsed.setdefault("runId", active_subagents[srk]["runId"])
                    parsed.setdefault("subagentId", active_subagents[srk]["subagentId"])
                    parsed.setdefault("subagentConversationId", active_subagents[srk]["subagentConversationId"])
                return f"event: action\ndata: {json.dumps(parsed, ensure_ascii=False)}\n\n"
            elif ev == "tester_done":
                rk = str(parsed.get("runKey") or "default")
                mapped = active_testers.get(rk)
                u = parsed.get("usage") if isinstance(parsed.get("usage"), Mapping) else {}
                if mapped:
                    synced = self._sync_agent_event({
                        "action": "tester_done",
                        "runId": mapped["runId"],
                        "status": parsed.get("status") or "passed",
                        "reportSummary": parsed.get("reportSummary") or "",
                        "criticalIssues": parsed.get("criticalIssues"),
                        "minorIssues": parsed.get("minorIssues"),
                        "checksRun": parsed.get("checksRun"),
                        "minorDecision": parsed.get("minorDecision"),
                        "promptTokens": int(u.get("prompt") or u.get("prompt_tokens") or parsed.get("promptTokens") or 0),
                        "completionTokens": int(u.get("completion") or u.get("completion_tokens") or parsed.get("completionTokens") or 0),
                        "totalTokens": int(u.get("total") or u.get("total_tokens") or parsed.get("totalTokens") or 0),
                        "model": parsed.get("model") or model_name,
                        "fullResponse": parsed.get("fullResponse") or "",
                        "reasoning": parsed.get("reasoning") or "",
                        "actions": parsed.get("actions") or [],
                        "files": parsed.get("files") or [],
                        "error": parsed.get("error") or "",
                        "skipUsageRecord": agent_role == "tester" or bool(parsed.get("skipUsageRecord")),
                    })
                    if isinstance(synced.get("run"), dict):
                        tr = synced["run"]
                        parsed["runId"] = tr.get("id")
                        parsed["testerConversationId"] = tr.get("testerConversationId")
                        parsed["run"] = tr
                return f"event: tester_done\ndata: {json.dumps(parsed, ensure_ascii=False)}\n\n"
            elif ev == "tester_decision":
                rk = str(parsed.get("runKey") or "default")
                mapped = active_testers.get(rk)
                if mapped:
                    synced = self._sync_agent_event({
                        "action": "tester_decision",
                        "runId": mapped["runId"],
                        "decision": parsed.get("decision"),
                        "note": parsed.get("note"),
                    })
                    if isinstance(synced.get("run"), dict):
                        tr = synced["run"]
                        parsed["runId"] = tr.get("id")
                        parsed["testerConversationId"] = tr.get("testerConversationId")
                        parsed["run"] = tr
                return f"event: tester_decision\ndata: {json.dumps(parsed, ensure_ascii=False)}\n\n"
            elif ev == "done" and isinstance(parsed.get("usage"), Mapping):
                u = parsed["usage"]
                rep_prompt = max(rep_prompt, int(round(float(u.get("prompt_tokens") or u.get("promptTokens") or u.get("prompt") or 0))))
                rep_comp = max(rep_comp, int(round(float(u.get("completion_tokens") or u.get("completionTokens") or u.get("completion") or 0))))
                rep_total = max(rep_total, int(round(float(u.get("total_tokens") or u.get("totalTokens") or u.get("total") or 0))))
            return frame_text + "\n\n"

        def flush_usage() -> None:
            nonlocal usage_recorded
            if usage_recorded:
                return
            usage_recorded = True
            est_comp = _estimate_tokens(text_latest) + _estimate_tokens(reasoning_latest)
            p = rep_prompt or (0 if rep_total > 0 else prompt_est)
            c = rep_comp or (0 if rep_total > 0 else est_comp)
            t = rep_total or (p + c)
            if t > 0 or p > 0 or c > 0:
                ref_id = (
                    int(tester_conv_id) if agent_role == "tester" and tester_conv_id
                    else (int(subagent_conv_id) if agent_role == "subagent" and subagent_conv_id else 0)
                )
                self._sync_agent_event({
                    "action": "usage",
                    "kind": "agent",
                    "refId": ref_id,
                    "model": model_name,
                    "promptTokens": p,
                    "completionTokens": c,
                    "totalTokens": t,
                })

        buf = ""
        try:
            while True:
                chunk = up_resp.read(4096) if not hasattr(up_resp, "read1") else up_resp.read1(8192)
                if not chunk:
                    break
                buf += chunk.decode("utf-8", "replace")
                while True:
                    m = re.search(r"\r?\n\r?\n", buf)
                    if not m:
                        break
                    frame = buf[: m.start()]
                    buf = buf[m.end() :]
                    if not frame.strip():
                        continue
                    out = handle_frame(frame)
                    handler.wfile.write(out.encode("utf-8"))
                    handler.wfile.flush()
            if buf.strip():
                out = handle_frame(buf.strip())
                handler.wfile.write(out.encode("utf-8"))
                handler.wfile.flush()
        except (OSError, BrokenPipeError, ConnectionResetError):
            pass
        finally:
            conn.close()
            flush_usage()
            open_ids = [
                int(mapped["runId"])
                for rk, mapped in active_subagents.items()
                if rk not in closed_subagents and mapped.get("runId")
            ]
            if open_ids:
                self._sync_agent_event({"action": "finalize_subagent_runs", "runIds": open_ids, "model": model_name})

    def _api_agent_approve(self, handler: BaseHTTPRequestHandler) -> None:
        raw = handler._read_body()  # type: ignore[attr-defined]
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            handler._send_json(400, {"error": "Некорректный JSON"})  # type: ignore[attr-defined]
            return
        app_id = str(body.get("approvalId") or "").strip()
        if not app_id:
            handler._send_json(400, {"error": "Не указан approvalId"})  # type: ignore[attr-defined]
            return
        with self._lock:
            nonce = self._approval_nonces.pop(app_id, "")
        if nonce:
            body["nonce"] = nonce
        prof_user = crm_client.profile_user(self.settings.crm_profile)
        if prof_user.get("id"):
            body["approverUserId"] = prof_user["id"]

        headers = {"Content-Type": "application/json"}
        if self._agent_http_token:
            headers["Authorization"] = f"Bearer {self._agent_http_token}"
        st, data = _http_json_local(
            "POST",
            f"http://127.0.0.1:{self._agent_port}/approve",
            headers=headers,
            body=body,
            timeout=10.0,
        )
        if st == 0:
            handler._send_json(503, {"error": "Локальный Агент недоступен"})  # type: ignore[attr-defined]
            return
        handler._send_json(st, data)  # type: ignore[attr-defined]

    def _api_agent_sandbox(self, handler: BaseHTTPRequestHandler, path: str, query: str) -> None:
        method = handler.command.upper()
        health = self.agent_health()
        if not health.get("available"):
            if path == "/api/ai/agent/sandbox" and method == "GET" and not query:
                handler._send_json(200, {"available": False, "files": [], "projects": [], "processes": []})  # type: ignore[attr-defined]
                return
            handler._send_json(503, {"error": "Локальный Агент не запущен"})  # type: ignore[attr-defined]
            return

        headers: Dict[str, str] = {}
        if self._agent_http_token:
            headers["Authorization"] = f"Bearer {self._agent_http_token}"

        if path == "/api/ai/agent/sandbox" and method == "GET":
            qs = urllib.parse.parse_qs(query)
            if "download" in qs:
                dl = qs["download"][0]
                req = urllib.request.Request(
                    f"http://127.0.0.1:{self._agent_port}/sandbox/download?path={urllib.parse.quote(dl)}",
                    headers=headers,
                )
                try:
                    with urllib.request.urlopen(req, timeout=30.0) as resp:
                        ct = resp.headers.get("Content-Type") or "application/octet-stream"
                        extra = {}
                        if resp.headers.get("Content-Disposition"):
                            extra["Content-Disposition"] = resp.headers["Content-Disposition"]
                        handler._send_bytes(200, ct, resp.read(), extra)  # type: ignore[attr-defined]
                except urllib.error.HTTPError as exc:
                    handler._send_bytes(int(exc.code), "application/json; charset=utf-8", exc.read())  # type: ignore[attr-defined]
                return
            st, data = _http_json_local("GET", f"http://127.0.0.1:{self._agent_port}/sandbox", headers=headers, timeout=12.0)
            handler._send_json(st or 200, data)  # type: ignore[attr-defined]
            return

        if path == "/api/ai/agent/sandbox" and method == "POST":
            body = self._read_json(handler)
            action = str(body.get("action") or "")
            mapping = {
                "export": "/sandbox/export",
                "stop_process": "/sandbox/stop",
                "delete": "/sandbox/delete",
                "write_transcript": "/sandbox/transcript",
            }
            target = mapping.get(action)
            if not target:
                handler._send_json(400, {"error": "Неизвестное действие Sandbox"})  # type: ignore[attr-defined]
                return
            st, data = _http_json_local("POST", f"http://127.0.0.1:{self._agent_port}{target}", headers=headers, body=body, timeout=20.0)
            handler._send_json(st or 503, data)  # type: ignore[attr-defined]
            return

        if path.startswith("/api/ai/agent/sandbox/preview"):
            tail = path[len("/api/ai/agent/sandbox/preview"):]
            up_url = f"http://127.0.0.1:{self._agent_port}/sandbox/preview{tail or '/'}" + (f"?{query}" if query else "")
            req_headers = {**headers, "X-Sandbox-Prefix": "/api/ai/agent/sandbox/preview"}
            req = urllib.request.Request(up_url, headers=req_headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=20.0) as resp:
                    ct = resp.headers.get("Content-Type") or "application/octet-stream"
                    raw_data = resp.read() if method != "HEAD" else b""
                    if method != "HEAD" and "text/html" in ct.lower():
                        parts = [p for p in tail.strip("/").split("/") if p]
                        proj = parts[0] if parts else ""
                        proj_base = f"/api/ai/agent/sandbox/preview/{urllib.parse.quote(proj)}" if proj else "/api/ai/agent/sandbox/preview"
                        raw_data = _rewrite_sandbox_preview_html(raw_data.decode("utf-8", "replace"), proj_base, self.app_token).encode("utf-8")
                    handler._send_bytes(int(getattr(resp, "status", 200) or 200), ct, raw_data)  # type: ignore[attr-defined]
            except urllib.error.HTTPError as exc:
                handler._send_bytes(int(exc.code), "text/plain; charset=utf-8", exc.read())  # type: ignore[attr-defined]
            except Exception as exc:
                handler._send_json(503, {"error": f"Sandbox preview недоступен: {exc}"})  # type: ignore[attr-defined]
            return

        if path.startswith("/api/ai/agent/sandbox/proxy/"):
            rest = path[len("/api/ai/agent/sandbox/proxy/"):]
            port_part, _, sub_tail = rest.partition("/")
            if not port_part.isdigit():
                handler._send_json(400, {"error": "Некорректный порт"})  # type: ignore[attr-defined]
                return
            up_url = f"http://127.0.0.1:{int(port_part)}/{sub_tail}" + (f"?{query}" if query else "")
            req = urllib.request.Request(up_url, method=method)
            try:
                with urllib.request.urlopen(req, timeout=20.0) as resp:
                    ct = resp.headers.get("Content-Type") or "application/octet-stream"
                    handler._send_bytes(int(getattr(resp, "status", 200) or 200), ct, resp.read() if method != "HEAD" else b"")  # type: ignore[attr-defined]
            except Exception as exc:
                handler._send_json(503, {"error": f"Локальный порт {port_part} недоступен: {exc}"})  # type: ignore[attr-defined]
            return

        handler._send_json(404, {"error": "Not found"})  # type: ignore[attr-defined]

    # ------------------------------------------------------------------
    # Plan / Summarize / Coach / Operator formulate (поддержка локальных LLM)
    # ------------------------------------------------------------------
    def _call_local_completion(self, base_url: str, api_key: str, model: str, messages: List[Dict[str, Any]], temperature: float = 0.25, timeout: float = 60.0) -> Tuple[str, Dict[str, int]]:
        payload = {"model": model, "temperature": temperature, "stream": False, "messages": messages}
        st, data = _http_json_local(
            "POST",
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"} if api_key else {},
            body=payload,
            timeout=timeout,
        )
        if st == 0 or st >= 400:
            raise RuntimeError(str(data.get("error") or f"HTTP {st}"))
        choices = data.get("choices") or []
        msg = choices[0].get("message") if choices and isinstance(choices[0], Mapping) else {}
        text = str((msg or {}).get("content") or "").strip()
        u = data.get("usage") if isinstance(data.get("usage"), Mapping) else {}
        prompt_t = int(u.get("prompt_tokens") or _estimate_tokens(messages))
        comp_t = int(u.get("completion_tokens") or _estimate_tokens(text))
        total_t = int(u.get("total_tokens") or (prompt_t + comp_t))
        return text, {"prompt": prompt_t, "completion": comp_t, "total": total_t}

    def _api_agent_plan(self, handler: BaseHTTPRequestHandler, full_rel: str) -> None:
        raw = handler._read_body()  # type: ignore[attr-defined]
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            handler._send_json(400, {"error": "Некорректный JSON"})  # type: ignore[attr-defined]
            return
        s = body.get("settings") if isinstance(body.get("settings"), Mapping) else {}
        base_url = _normalize_ai_base(str(s.get("baseUrl") or ""))
        if not self._should_use_local_model(base_url):
            self._proxy_raw_post(handler, full_rel, raw, timeout=120.0)
            return
        model = str(s.get("model") or "").strip()
        api_key = str(s.get("apiKey") or "").strip()
        if not model:
            handler._send_json(400, {"error": "Укажите модель в «Подключении»"})  # type: ignore[attr-defined]
            return
        sys_prompt = str(body.get("systemPrompt") or "").strip() or (
            "Ты — планировщик действий на компьютере. Помоги пользователю сформулировать чёткий пошаговый план."
        )
        msgs: List[Dict[str, Any]] = [{"role": "system", "content": sys_prompt}]
        for m in (body.get("messages") or [])[-14:]:
            if isinstance(m, Mapping) and m.get("role") in ("user", "assistant"):
                msgs.append({"role": str(m["role"]), "content": str(m.get("content") or "")})
        try:
            reply, usage = self._call_local_completion(base_url, api_key, model, msgs, temperature=0.3, timeout=120.0)
            self._sync_agent_event({
                "action": "usage",
                "kind": "operator",
                "model": model,
                "promptTokens": usage["prompt"],
                "completionTokens": usage["completion"],
                "totalTokens": usage["total"],
            })
            handler._send_json(200, {"reply": reply, "usage": usage})  # type: ignore[attr-defined]
        except Exception as exc:
            handler._send_json(502, {"error": f"Ошибка планировщика: {exc}"})  # type: ignore[attr-defined]

    def _api_agent_summarize(self, handler: BaseHTTPRequestHandler, full_rel: str) -> None:
        raw = handler._read_body()  # type: ignore[attr-defined]
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            handler._send_json(400, {"error": "Некорректный JSON"})  # type: ignore[attr-defined]
            return
        s = body.get("settings") if isinstance(body.get("settings"), Mapping) else {}
        base_url = _normalize_ai_base(str(s.get("baseUrl") or ""))
        if not self._should_use_local_model(base_url):
            self._proxy_raw_post(handler, full_rel, raw, timeout=60.0)
            return
        model = str(s.get("model") or "").strip()
        api_key = str(s.get("apiKey") or "").strip()
        turns = body.get("turns") if isinstance(body.get("turns"), list) else []
        title = str(body.get("title") or "Чат агента")
        dialog = "\n".join(
            f"{i + 1}. {'Пользователь' if t.get('role') == 'user' else 'Агент'}: {str(t.get('content') or '')}"
            for i, t in enumerate(turns)
            if isinstance(t, Mapping)
        )
        fallback = f"# Summary: {title}\n\n" + "\n".join(dialog.splitlines()[-20:])
        if not model:
            handler._send_json(200, {"summary": fallback, "source": "fallback"})  # type: ignore[attr-defined]
            return
        try:
            text, usage = self._call_local_completion(
                base_url,
                api_key,
                model,
                [
                    {"role": "system", "content": "Составь сжатое точное Summary переписки агента по-русски (цель, выполненные файлы/шаги, ограничения, следующие шаги)."},
                    {"role": "user", "content": f"Чат: {title}\n\n{dialog}"},
                ],
                temperature=0.2,
                timeout=60.0,
            )
            self._sync_agent_event({
                "action": "usage",
                "kind": "agent",
                "model": model,
                "promptTokens": usage["prompt"],
                "completionTokens": usage["completion"],
                "totalTokens": usage["total"],
            })
            handler._send_json(200, {"summary": text or fallback, "source": "model" if text else "fallback"})  # type: ignore[attr-defined]
        except Exception:
            handler._send_json(200, {"summary": fallback, "source": "fallback"})  # type: ignore[attr-defined]

    def _api_agent_coach(self, handler: BaseHTTPRequestHandler, full_rel: str) -> None:
        raw = handler._read_body()  # type: ignore[attr-defined]
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            handler._send_json(400, {"error": "Некорректный JSON"})  # type: ignore[attr-defined]
            return
        s = body.get("settings") if isinstance(body.get("settings"), Mapping) else {}
        base_url = _normalize_ai_base(str(s.get("baseUrl") or ""))
        if not self._should_use_local_model(base_url):
            self._proxy_raw_post(handler, full_rel, raw, timeout=60.0)
            return
        task_id = int(body.get("taskId") or 0)
        if not task_id:
            handler._send_json(400, {"error": "Не указан taskId"})  # type: ignore[attr-defined]
            return
        crm_url, crm_token = self._crm_auth()
        try:
            with crm_client.open_crm_stream("GET", crm_url, f"/api/agent/tasks/{task_id}", bearer_token=crm_token, timeout=15.0) as resp:
                task_data = json.loads(resp.read().decode("utf-8", "replace") or "{}")
        except Exception as exc:
            handler._send_json(502, {"error": str(exc)})  # type: ignore[attr-defined]
            return

        task = task_data.get("task") or {}
        events = task_data.get("events") or []
        tail = "\n".join(f"[{e.get('kind')}] {e.get('text') or e.get('action') or ''}" for e in events[-8:] if isinstance(e, Mapping))
        model = str(s.get("model") or "").strip()
        api_key = str(s.get("apiKey") or "").strip()
        user_hint = str(body.get("userHint") or "")
        guidance_op = user_hint.strip() or "Проверь активное окно и продолжи следующий аккуратный шаг к цели."
        advice_user = "Подсказка отправлена Оператору."
        if model:
            try:
                reply, usage = self._call_local_completion(
                    base_url, api_key, model,
                    [
                        {"role": "system", "content": 'Ты — Агент-советчик Оператора. Ответь строго JSON: {"guidanceForOperator":"чёткий следующий шаг для бота","adviceForUser":"пояснение пользователю"}'},
                        {"role": "user", "content": f"Задача: {task.get('prompt', '')}\nШаг: {task.get('steps', 0)}\nИстория:\n{tail}\nПодсказка пользователя: {user_hint}"},
                    ],
                    temperature=0.25, timeout=45.0,
                )
                m = re.search(r"\{[\s\S]*\}", reply)
                if m:
                    parsed = json.loads(m.group(0))
                    guidance_op = str(parsed.get("guidanceForOperator") or guidance_op)
                    advice_user = str(parsed.get("adviceForUser") or advice_user)
                self._sync_agent_event({
                    "action": "usage", "kind": "operator", "refId": task_id, "model": model,
                    "promptTokens": usage["prompt"], "completionTokens": usage["completion"], "totalTokens": usage["total"],
                })
            except Exception:
                pass
        try:
            with crm_client.open_crm_stream(
                "POST", crm_url, f"/api/agent/tasks/{task_id}", bearer_token=crm_token,
                body=json.dumps({"action": "guidance", "author": "agent", "text": guidance_op}).encode("utf-8"),
                headers={"Content-Type": "application/json"}, timeout=15.0,
            ) as gresp:
                saved = json.loads(gresp.read().decode("utf-8", "replace") or "{}")
        except Exception as exc:
            handler._send_json(502, {"error": str(exc)})  # type: ignore[attr-defined]
            return
        handler._send_json(200, {  # type: ignore[attr-defined]
            "ok": True,
            "guidanceForOperator": guidance_op,
            "adviceForUser": advice_user,
            "task": saved.get("task") or task,
            "source": "model",
        })

    def _api_agent_operator(self, handler: BaseHTTPRequestHandler, full_rel: str) -> None:
        raw = handler._read_body()  # type: ignore[attr-defined]
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            handler._send_json(400, {"error": "Некорректный JSON"})  # type: ignore[attr-defined]
            return
        s = body.get("settings") if isinstance(body.get("settings"), Mapping) else {}
        base_url = _normalize_ai_base(str(s.get("baseUrl") or ""))
        if body.get("action") == "formulate" and self._should_use_local_model(base_url):
            goal = str(body.get("goal") or body.get("prompt") or "").strip()
            model = str(s.get("model") or "").strip()
            api_key = str(s.get("apiKey") or "").strip()
            fallback = {
                "prompt": f"Пошагово помоги на экране. Цель: {goal}",
                "taskMode": "copilot",
                "coachMode": "agent",
                "maxSteps": 30,
                "notes": "Базовая формулировка",
                "source": "heuristic",
            }
            if model:
                try:
                    reply, usage = self._call_local_completion(
                        base_url, api_key, model,
                        [
                            {"role": "system", "content": 'Сформулируй задачу для Оператора рабочего стола. Ответь JSON: {"prompt":"...","taskMode":"autonomous|copilot|game","coachMode":"agent|after_step","maxSteps":30,"notes":"..."}'},
                            {"role": "user", "content": goal},
                        ],
                        temperature=0.25, timeout=30.0,
                    )
                    m = re.search(r"\{[\s\S]*\}", reply)
                    if m:
                        parsed = json.loads(m.group(0))
                        fallback.update({
                            "prompt": str(parsed.get("prompt") or fallback["prompt"]),
                            "taskMode": str(parsed.get("taskMode") or "copilot"),
                            "coachMode": str(parsed.get("coachMode") or "agent"),
                            "maxSteps": int(parsed.get("maxSteps") or 30),
                            "notes": str(parsed.get("notes") or ""),
                            "source": "model",
                        })
                    self._sync_agent_event({
                        "action": "usage", "kind": "operator", "model": model,
                        "promptTokens": usage["prompt"], "completionTokens": usage["completion"], "totalTokens": usage["total"],
                    })
                except Exception:
                    pass
            handler._send_json(200, fallback)  # type: ignore[attr-defined]
            return
        self._proxy_raw_post(handler, full_rel, raw, timeout=45.0)

    def _proxy_raw_post(self, handler: BaseHTTPRequestHandler, full_rel: str, raw: bytes, timeout: float = 60.0) -> None:
        crm_url, crm_token = self._crm_auth()
        try:
            with crm_client.open_crm_stream(
                "POST", crm_url, full_rel, bearer_token=crm_token, body=raw,
                headers={"Content-Type": "application/json"}, timeout=timeout,
            ) as resp:
                handler._send_bytes(int(getattr(resp, "status", 200) or 200), resp.headers.get("Content-Type") or "application/json; charset=utf-8", resp.read())  # type: ignore[attr-defined]
        except urllib.error.HTTPError as exc:
            handler._send_bytes(int(exc.code), "application/json; charset=utf-8", exc.read())  # type: ignore[attr-defined]
        except Exception as exc:
            handler._send_json(502, {"error": str(exc)})  # type: ignore[attr-defined]
