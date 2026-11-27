"""Unit/integration тесты настольного Harness-приложения (launcher/harness_server, file_extract, desktop_window)."""

from __future__ import annotations

import base64
import io
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List

from launcher import crm_client, desktop_window, file_extract, harness_server


class FakeServersMixin:
    """Поднимает фейковую локальную LLM (127.0.0.1) и проверяет сквозную работу HarnessServer."""

    @staticmethod
    def start_json_server(routes_handler):
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                return

            def do_GET(self):  # noqa: N802
                self._call()

            def do_POST(self):  # noqa: N802
                self._call()

            def do_PATCH(self):  # noqa: N802
                self._call()

            def do_PUT(self):  # noqa: N802
                self._call()

            def do_DELETE(self):  # noqa: N802
                self._call()

            def _call(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length > 0 else b""
                routes_handler(self, self.command, self.path, body)

        srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        srv.daemon_threads = True
        th = threading.Thread(target=srv.serve_forever, daemon=True)
        th.start()
        return srv, int(srv.server_address[1])


class TestLauncherHarness(unittest.TestCase, FakeServersMixin):
    def test_file_extract_pptx_odt_image_and_truncation(self) -> None:
        pptx_buf = io.BytesIO()
        with zipfile.ZipFile(pptx_buf, "w") as zf:
            zf.writestr(
                "ppt/slides/slide1.xml",
                '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
                'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
                "<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Презентация Q4</a:t></a:r></a:p>"
                "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>",
            )
        res_pptx = file_extract.extract_attachment("deck.pptx", pptx_buf.getvalue())
        self.assertEqual(res_pptx["note"], "PPTX")
        self.assertIn("Презентация Q4", res_pptx["text"])

        odt_buf = io.BytesIO()
        with zipfile.ZipFile(odt_buf, "w") as zf:
            zf.writestr(
                "content.xml",
                '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
                'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">'
                "<office:body><office:text><text:p>Заметка ODT</text:p></office:text></office:body>"
                "</office:document-content>",
            )
        res_odt = file_extract.extract_attachment("note.odt", odt_buf.getvalue())
        self.assertEqual(res_odt["note"], "ODT")
        self.assertIn("Заметка ODT", res_odt["text"])

        png_1x1 = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        res_img = file_extract.extract_attachment("shot.png", png_1x1, "image/png")
        self.assertEqual(res_img["kind"], "image")
        self.assertTrue((res_img["preview"] or "").startswith("data:image/"))

        big_text = ("A" * (file_extract.MAX_TEXT_EXTRACT + 500)).encode("utf-8")
        res_big = file_extract.extract_attachment("big.txt", big_text, "text/plain")
        self.assertTrue(res_big["truncated"])
        self.assertEqual(len(res_big["text"]), file_extract.MAX_TEXT_EXTRACT)

    def test_harness_local_model_routing_and_sse_chat(self) -> None:
        recorded_calls: List[Dict[str, Any]] = []

        def fake_crm_handler(h: BaseHTTPRequestHandler, method: str, path: str, body: bytes) -> None:
            auth = h.headers.get("Authorization") or ""
            payload = json.loads(body.decode("utf-8") or "{}") if body else {}
            recorded_calls.append({"target": "crm", "method": method, "path": path, "auth": auth, "body": payload})
            if path == "/api/launcher/chat" and payload.get("action") == "prepare":
                resp = {
                    "ok": True,
                    "chat": {"id": 42, "title": "Новый чат", "tokensTotal": 0, "tokensLeft": 1000000, "tokensLimit": 1000000},
                    "params": {"temperature": 0.2, "reasoning": "default", "ragFull": False, "ragChunks": 6, "contextLimit": 0},
                    "reasoningDowngraded": False,
                    "ragContext": "Документ: пароль 7788",
                    "ragHits": 1,
                    "ragFull": None,
                    "monthly": {"used": 0, "limit": 5000000, "left": 5000000},
                }
            elif path == "/api/launcher/chat" and payload.get("action") == "record":
                resp = {
                    "ok": True,
                    "usage": {"prompt": 15, "completion": 8, "total": 23, "estimated": False},
                    "chat": {"id": 42, "title": "Привет", "tokensTotal": 23, "tokensLeft": 999977, "tokensLimit": 1000000},
                    "monthly": {"used": 23, "limit": 5000000, "left": 4999977},
                }
            else:
                resp = {"ok": True}
            raw = json.dumps(resp, ensure_ascii=False).encode("utf-8")
            h.send_response(200)
            h.send_header("Content-Type", "application/json; charset=utf-8")
            h.send_header("Content-Length", str(len(raw)))
            h.end_headers()
            h.wfile.write(raw)

        def fake_llm_handler(h: BaseHTTPRequestHandler, method: str, path: str, body: bytes) -> None:
            payload = json.loads(body.decode("utf-8") or "{}") if body else {}
            recorded_calls.append({"target": "llm", "method": method, "path": path, "body": payload})
            if path == "/v1/models":
                raw = json.dumps({"data": [{"id": "qwen3-vl-8b", "context_length": 32768, "capabilities": ["vision", "reasoning"]}]}).encode("utf-8")
                h.send_response(200)
                h.send_header("Content-Type", "application/json")
                h.send_header("Content-Length", str(len(raw)))
                h.end_headers()
                h.wfile.write(raw)
                return
            if path == "/v1/chat/completions":
                sse = (
                    'data: {"choices":[{"delta":{"reasoning_content":"Думаю..."}}]}\n\n'
                    'data: {"choices":[{"delta":{"content":"Ответ локальной модели!"}}],"usage":{"prompt_tokens":15,"completion_tokens":8,"total_tokens":23}}\n\n'
                    "data: [DONE]\n\n"
                ).encode("utf-8")
                h.send_response(200)
                h.send_header("Content-Type", "text/event-stream; charset=utf-8")
                h.send_header("Content-Length", str(len(sse)))
                h.end_headers()
                h.wfile.write(sse)
                return

        crm_srv, crm_port = self.start_json_server(fake_crm_handler)
        llm_srv, llm_port = self.start_json_server(fake_llm_handler)
        orig_is_local = crm_client.is_local_model_url
        with tempfile.TemporaryDirectory() as tmp:
            prev_cfg = os.environ.get("CRM_LAUNCHER_CONFIG")
            os.environ["CRM_LAUNCHER_CONFIG"] = str(Path(tmp) / "settings.json")
            srv = harness_server.HarnessServer(port=0)
            try:
                srv.start()
                srv.settings.crm_url = f"http://127.0.0.1:{crm_port}"
                srv.settings.crm_session_token = "sess-bearer-123"
                # Имитируем удалённый CRM + локальную модель на ПК (чтобы сработала ветка локальной LLM)
                crm_client.is_local_model_url = lambda url: f":{llm_port}" in url  # type: ignore[assignment]

                # 1. Список моделей идёт в локальный LLM
                req_models = urllib.request.Request(
                    f"{srv.base_url()}/api/ai/models",
                    data=json.dumps({"baseUrl": f"http://127.0.0.1:{llm_port}/v1", "model": "qwen3-vl-8b"}).encode("utf-8"),
                    headers={"X-Harness-Token": srv.token, "Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req_models, timeout=5) as resp:
                    models_data = json.loads(resp.read().decode("utf-8"))
                self.assertIn("qwen3-vl-8b", models_data["models"])
                self.assertTrue(models_data["capabilities"]["supportsVision"])
                self.assertTrue(models_data["capabilities"]["supportsReasoning"])

                # 2. Стриминговый чат с локальной моделью: prepare в CRM -> stream LLM -> record в CRM
                req_chat = urllib.request.Request(
                    f"{srv.base_url()}/api/ai/chat",
                    data=json.dumps({
                        "messages": [{"role": "user", "content": "Привет"}],
                        "settings": {"baseUrl": f"http://127.0.0.1:{llm_port}/v1", "model": "qwen3-vl-8b"},
                    }).encode("utf-8"),
                    headers={"X-Harness-Token": srv.token, "Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req_chat, timeout=5) as resp:
                    stream_text = resp.read().decode("utf-8")

                self.assertIn("Думаю...", stream_text)
                self.assertIn("Ответ локальной модели!", stream_text)
                self.assertIn('"done": true', stream_text)
                crm_actions = [c["body"].get("action") for c in recorded_calls if c["target"] == "crm"]
                self.assertEqual(crm_actions, ["prepare", "record"])
                self.assertTrue(all(c["auth"] == "Bearer sess-bearer-123" for c in recorded_calls if c["target"] == "crm"))
            finally:
                crm_client.is_local_model_url = orig_is_local  # type: ignore[assignment]
                srv.shutdown()
                crm_srv.shutdown()
                llm_srv.shutdown()
                if prev_cfg is None:
                    os.environ.pop("CRM_LAUNCHER_CONFIG", None)
                else:
                    os.environ["CRM_LAUNCHER_CONFIG"] = prev_cfg

    def test_desktop_window_headless_ready_callback(self) -> None:
        called = []
        self.assertIn(desktop_window.detect_window_backend(), ("pywebview", "browser_app", "webbrowser"))
        # Проверяем, что pick-folder в harness_server с пользовательским callback работает без GUI
        with tempfile.TemporaryDirectory() as tmp:
            prev_cfg = os.environ.get("CRM_LAUNCHER_CONFIG")
            os.environ["CRM_LAUNCHER_CONFIG"] = str(Path(tmp) / "settings.json")
            srv = harness_server.HarnessServer(port=0)
            srv.set_folder_picker(lambda: "/tmp/chosen-ws")
            try:
                srv.start()
                req = urllib.request.Request(
                    f"{srv.base_url()}/api/app/pick-folder",
                    data=b"{}",
                    headers={"X-Harness-Token": srv.token, "Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                self.assertTrue(data["ok"])
                self.assertEqual(data["path"], "/tmp/chosen-ws")
            finally:
                srv.shutdown()
                if prev_cfg is None:
                    os.environ.pop("CRM_LAUNCHER_CONFIG", None)
                else:
                    os.environ["CRM_LAUNCHER_CONFIG"] = prev_cfg
        self.assertEqual(called, [])

    def test_desktop_window_browser_app_and_pywebview_paths(self) -> None:
        import sys
        import types
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as tmp:
            prev_cfg = os.environ.get("CRM_LAUNCHER_CONFIG")
            os.environ["CRM_LAUNCHER_CONFIG"] = str(Path(tmp) / "settings.json")
            try:
                profile_dir = desktop_window._app_profile_dir()
                self.assertTrue(profile_dir.is_dir())
                self.assertEqual(profile_dir.parent, Path(tmp).resolve())

                # 1. Проверка open_with_browser_app: при ненулевом коде первого браузера пробует следующий
                seen_cmds: List[List[str]] = []

                class FakeProc:
                    def __init__(self, rc: int) -> None:
                        self._rc = rc

                    def wait(self) -> int:
                        return self._rc

                rcs = [1, 0]

                def fake_popen(cmd, **_kwargs):
                    seen_cmds.append(list(cmd))
                    return FakeProc(rcs.pop(0))

                with (
                    patch.object(desktop_window, "_candidate_app_browsers", return_value=["/fake/edge", "/fake/chrome"]),
                    patch.object(desktop_window.subprocess, "Popen", side_effect=fake_popen),
                ):
                    ok = desktop_window.open_with_browser_app("http://127.0.0.1:9999/?ht=tok")
                self.assertTrue(ok)
                self.assertEqual(len(seen_cmds), 2)
                self.assertEqual(seen_cmds[1][0], "/fake/chrome")
                self.assertIn("--app=http://127.0.0.1:9999/?ht=tok", seen_cmds[1])
                self.assertIn(f"--user-data-dir={profile_dir}", seen_cmds[1])

                # 2. Проверка open_with_pywebview без AttributeError и с storage_path внутри config_dir()
                wv_calls: Dict[str, Any] = {}
                fake_wv = types.ModuleType("webview")
                fake_wv.create_window = lambda title, url, **kw: wv_calls.update({"title": title, "url": url, **kw})  # type: ignore[attr-defined]
                fake_wv.start = lambda **kw: wv_calls.update({"start": kw})  # type: ignore[attr-defined]
                prev_wv = sys.modules.get("webview")
                sys.modules["webview"] = fake_wv
                try:
                    self.assertTrue(desktop_window.open_with_pywebview("http://127.0.0.1:9999/?ht=tok"))
                    storage_path = Path(wv_calls["start"]["storage_path"])
                    self.assertTrue(storage_path.is_dir())
                    self.assertEqual(storage_path.parent, Path(tmp).resolve())
                    self.assertEqual(wv_calls["url"], "http://127.0.0.1:9999/?ht=tok")
                finally:
                    if prev_wv is None:
                        sys.modules.pop("webview", None)
                    else:
                        sys.modules["webview"] = prev_wv
            finally:
                if prev_cfg is None:
                    os.environ.pop("CRM_LAUNCHER_CONFIG", None)
                else:
                    os.environ["CRM_LAUNCHER_CONFIG"] = prev_cfg

    def test_harness_start_agent_and_operator_processes(self) -> None:
        from unittest.mock import patch

        launched: List[Dict[str, Any]] = []

        class FakeAgentRun:
            def __init__(self, *, agent_id: str, command, cwd: Path, env, secrets=None) -> None:
                self.agent_id = agent_id
                self.command = list(command)
                self.cwd = cwd
                self.env = dict(env)
                self.secrets = dict(secrets or {})
                self.started_at = 1234.0
                self._running = True
                launched.append({
                    "agent_id": agent_id,
                    "command": self.command,
                    "cwd": self.cwd,
                    "env": self.env,
                    "secrets": self.secrets,
                })

            def start(self) -> None:
                return

            def is_running(self) -> bool:
                return self._running

            def poll_lines(self, limit: int = 1000) -> List[str]:
                return []

            def stop(self, timeout: float = 3.0) -> None:
                self._running = False

        with tempfile.TemporaryDirectory() as tmp:
            prev_cfg = os.environ.get("CRM_LAUNCHER_CONFIG")
            os.environ["CRM_LAUNCHER_CONFIG"] = str(Path(tmp) / "settings.json")
            srv = harness_server.HarnessServer(port=0)
            srv.settings.crm_url = "https://crm.example.com"
            srv.settings.crm_session_token = "sess-ok"
            srv.settings.crm_profile = {
                "user": {"id": 1, "role": "super_admin", "canUseAgent": True, "canUseOperator": True},
                "limits": {"unlimited": True, "maxSteps": None, "reasoning": ["default", "max"]},
                "operator": {"enabled": True, "serverUrl": "https://crm.example.com", "token": "crmop_test_tok"},
            }
            srv.settings.provider = "local"
            srv.settings.base_url = "http://127.0.0.1:1234/v1"
            srv.settings.model = "qwen3-vl-8b"
            try:
                with (
                    patch.object(harness_server, "AgentRun", FakeAgentRun),
                    patch.object(srv, "agent_health", return_value={"available": True, "running": True, "port": 8899}),
                ):
                    ag_res = srv.start_agent_process({"workspace": tmp})
                    self.assertTrue(ag_res["available"])

                    op_res = srv.start_operator_process({"mode": "watch"})
                    self.assertTrue(op_res["running"])

                self.assertEqual(len(launched), 2)
                self.assertEqual(launched[0]["agent_id"], "chat_agent")
                self.assertTrue(any(str(c).endswith("agent.py") for c in launched[0]["command"]))
                self.assertIn("AGENT_HTTP_TOKEN", launched[0]["secrets"])

                self.assertEqual(launched[1]["agent_id"], "operator")
                self.assertTrue(any(str(c).endswith("desktop_operator.py") for c in launched[1]["command"]))
                self.assertEqual(launched[1]["secrets"].get("CRM_AGENT_TOKEN"), "crmop_test_tok")
                self.assertIn("--watch", launched[1]["command"])
            finally:
                srv.shutdown()
                if prev_cfg is None:
                    os.environ.pop("CRM_LAUNCHER_CONFIG", None)
                else:
                    os.environ["CRM_LAUNCHER_CONFIG"] = prev_cfg

    def test_crm_client_sends_cookie_and_bearer_and_fallback_prepare(self) -> None:
        seen_reqs: List[Dict[str, Any]] = []

        def legacy_crm_handler(h: BaseHTTPRequestHandler, method: str, path: str, body: bytes) -> None:
            auth = h.headers.get("Authorization") or ""
            cookie = h.headers.get("Cookie") or ""
            seen_reqs.append({"method": method, "path": path, "auth": auth, "cookie": cookie})
            # Имитируем старый сервер CRM: роуты принимают только Cookie crm_session,
            # а /api/launcher/agent/prepare возвращает 404.
            if path.startswith("/api/launcher/agent/"):
                raw = json.dumps({"error": "Not found"}).encode("utf-8")
                h.send_response(404)
                h.send_header("Content-Type", "application/json")
                h.send_header("Content-Length", str(len(raw)))
                h.end_headers()
                h.wfile.write(raw)
                return
            if "crm_session=tok_legacy_99" not in cookie:
                raw = json.dumps({"error": "Unauthorized"}).encode("utf-8")
                h.send_response(401)
                h.send_header("Content-Type", "application/json")
                h.send_header("Content-Length", str(len(raw)))
                h.end_headers()
                h.wfile.write(raw)
                return
            if path == "/api/ai/settings":
                resp = {"settings": {"baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini"}}
            elif path == "/api/agent/subagents":
                resp = {"subagents": [], "routingMode": "linear", "overseer": {"enabled": False}}
            else:
                resp = {"ok": True}
            raw = json.dumps(resp, ensure_ascii=False).encode("utf-8")
            h.send_response(200)
            h.send_header("Content-Type", "application/json")
            h.send_header("Content-Length", str(len(raw)))
            h.end_headers()
            h.wfile.write(raw)

        crm_srv, crm_port = self.start_json_server(legacy_crm_handler)
        with tempfile.TemporaryDirectory() as tmp:
            prev_cfg = os.environ.get("CRM_LAUNCHER_CONFIG")
            os.environ["CRM_LAUNCHER_CONFIG"] = str(Path(tmp) / "settings.json")
            srv = harness_server.HarnessServer(port=0)
            try:
                srv.start()
                srv.settings.crm_url = f"http://127.0.0.1:{crm_port}"
                srv.settings.crm_session_token = "tok_legacy_99"

                # 1. Прокси к /api/ai/settings работает даже на сервере, требующем Cookie crm_session
                req = urllib.request.Request(
                    f"{srv.base_url()}/api/ai/settings",
                    headers={"X-Harness-Token": srv.token},
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    settings_data = json.loads(resp.read().decode("utf-8"))
                self.assertEqual(settings_data["settings"]["model"], "gpt-4o-mini")

                # 2. Fallback сборки payload при 404 от /api/launcher/agent/prepare
                prep = srv._fallback_prepare_agent({"messages": [{"role": "user", "content": "Привет"}]})
                self.assertEqual(prep["payload"]["settings"]["model"], "gpt-4o-mini")
                self.assertEqual(prep["payload"]["settings"]["baseUrl"], "https://api.openai.com/v1")

                # 3. Fallback отправки usage при 404 от /api/launcher/agent/events -> /api/launcher/usage
                res_ev = srv._sync_agent_event({"action": "usage", "kind": "agent", "model": "gpt-4o-mini", "totalTokens": 10})
                self.assertTrue(res_ev.get("ok"))
                self.assertTrue(any(r["path"] == "/api/launcher/usage" for r in seen_reqs))
                self.assertTrue(all(
                    r["auth"] == "Bearer tok_legacy_99" and "crm_session=tok_legacy_99" in r["cookie"]
                    for r in seen_reqs
                ))
            finally:
                srv.shutdown()
                crm_srv.shutdown()
                if prev_cfg is None:
                    os.environ.pop("CRM_LAUNCHER_CONFIG", None)
                else:
                    os.environ["CRM_LAUNCHER_CONFIG"] = prev_cfg

    def test_missing_route_404_falls_back_to_local_subagents_while_domain_404_passes_through(self) -> None:
        def old_crm_handler(h: BaseHTTPRequestHandler, method: str, path: str, body: bytes) -> None:
            # Имитируем старый сервер CRM: Next.js отдаёт HTML 404 для отсутствующих роутов
            # /api/agent/subagents и /api/agent/conversations, а бизнес-404 для /api/agent/tasks/999 — JSON.
            if path == "/api/agent/tasks/999":
                raw = json.dumps({"error": "Задание не найдено"}, ensure_ascii=False).encode("utf-8")
                h.send_response(404)
                h.send_header("Content-Type", "application/json; charset=utf-8")
                h.send_header("Content-Length", str(len(raw)))
                h.end_headers()
                h.wfile.write(raw)
                return
            if path == "/api/ai/settings":
                raw = json.dumps({"settings": {"baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini"}}).encode("utf-8")
                h.send_response(200)
                h.send_header("Content-Type", "application/json")
                h.send_header("Content-Length", str(len(raw)))
                h.end_headers()
                h.wfile.write(raw)
                return
            html = b"<!DOCTYPE html><html><body>404 This page could not be found.</body></html>"
            h.send_response(404)
            h.send_header("Content-Type", "text/html; charset=utf-8")
            h.send_header("Content-Length", str(len(html)))
            h.end_headers()
            h.wfile.write(html)

        crm_srv, crm_port = self.start_json_server(old_crm_handler)
        with tempfile.TemporaryDirectory() as tmp:
            prev_cfg = os.environ.get("CRM_LAUNCHER_CONFIG")
            os.environ["CRM_LAUNCHER_CONFIG"] = str(Path(tmp) / "settings.json")
            srv = harness_server.HarnessServer(port=0)
            try:
                srv.start()
                srv.settings.crm_url = f"http://127.0.0.1:{crm_port}"
                srv.settings.crm_session_token = "tok_old_crm"

                def call(method: str, path: str, payload: Any = None) -> tuple[int, Dict[str, Any]]:
                    raw = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
                    hdrs = {"X-Harness-Token": srv.token}
                    if raw is not None:
                        hdrs["Content-Type"] = "application/json"
                    req = urllib.request.Request(f"{srv.base_url()}{path}", data=raw, headers=hdrs, method=method)
                    try:
                        with urllib.request.urlopen(req, timeout=5) as resp:
                            return resp.status, json.loads(resp.read().decode("utf-8"))
                    except urllib.error.HTTPError as e:
                        return e.code, json.loads(e.read().decode("utf-8"))

                # 1. GET /api/agent/subagents -> локальный fallback (200)
                st, data = call("GET", "/api/agent/subagents")
                self.assertEqual(st, 200)
                self.assertTrue(data.get("localFallback"))
                self.assertEqual(data.get("subagents"), [])

                # 2. POST /api/agent/subagents -> создаёт локального субагента
                st, created = call("POST", "/api/agent/subagents", {
                    "name": "Кодер",
                    "roleTitle": "Backend",
                    "toolProfile": "restricted",
                    "systemPrompt": "Пиши тесты",
                })
                self.assertEqual(st, 201)
                sub_id = created["subagent"]["id"]

                # 3. PATCH /api/agent/subagents -> включает Надсмотрщика и layered
                st, patched = call("PATCH", "/api/agent/subagents", {
                    "routingMode": "layered",
                    "overseer": {"enabled": True, "mode": "strict"},
                })
                self.assertEqual(st, 200)
                self.assertTrue(patched["overseer"]["enabled"])
                self.assertEqual(patched["routingMode"], "layered")

                # 4. _fallback_prepare_agent подхватывает локальных субагентов и Надсмотрщика
                prep = srv._fallback_prepare_agent({"messages": [{"role": "user", "content": "Тест"}]})
                self.assertEqual(prep["payload"]["routingMode"], "layered")
                self.assertTrue(prep["payload"]["overseer"]["enabled"])
                self.assertEqual(len(prep["payload"]["subagents"]), 1)
                self.assertEqual(prep["payload"]["subagents"][0]["name"], "Кодер")

                # 5. Локальные чаты /api/agent/conversations также работают без 404
                st, c_res = call("POST", "/api/agent/conversations", {"kind": "subagent", "subagentId": sub_id, "title": "Чат"})
                self.assertEqual(st, 201)
                st, c_list = call("GET", "/api/agent/conversations?kind=subagent")
                self.assertEqual(st, 200)
                self.assertEqual(len(c_list["conversations"]), 1)

                # 6. DELETE /api/agent/subagents/{id}
                st, _ = call("DELETE", f"/api/agent/subagents/{sub_id}")
                self.assertEqual(st, 200)

                # 7. Доменная JSON-404 ошибка от CRM не подменяется
                st, dom_err = call("GET", "/api/agent/tasks/999")
                self.assertEqual(st, 404)
                self.assertEqual(dom_err.get("error"), "Задание не найдено")
            finally:
                srv.shutdown()
                crm_srv.shutdown()
                if prev_cfg is None:
                    os.environ.pop("CRM_LAUNCHER_CONFIG", None)
                else:
                    os.environ["CRM_LAUNCHER_CONFIG"] = prev_cfg

    def test_autonomous_sandbox_crud_download_preview_and_transcripts_without_agent(self) -> None:
        def old_crm_handler(h: BaseHTTPRequestHandler, method: str, path: str, body: bytes) -> None:
            html = b"<!DOCTYPE html><html><body>404 This page could not be found.</body></html>"
            h.send_response(404)
            h.send_header("Content-Type", "text/html; charset=utf-8")
            h.send_header("Content-Length", str(len(html)))
            h.end_headers()
            h.wfile.write(html)

        crm_srv, crm_port = self.start_json_server(old_crm_handler)
        with tempfile.TemporaryDirectory() as tmp:
            prev_cfg = os.environ.get("CRM_LAUNCHER_CONFIG")
            os.environ["CRM_LAUNCHER_CONFIG"] = str(Path(tmp) / "settings.json")
            ws_dir = Path(tmp) / "workspace"
            ws_dir.mkdir(parents=True, exist_ok=True)
            srv = harness_server.HarnessServer(port=0)
            srv.settings.set_value("chat_agent", "workspace", str(ws_dir))
            srv.settings.crm_url = f"http://127.0.0.1:{crm_port}"
            srv.settings.crm_session_token = "tok_sb"
            try:
                srv.start()

                # Создаём проект прямо в legacy sandbox чтобы проверить синхронизацию
                legacy_proj = ws_dir / ".crm_agent_sandbox" / "demo_site"
                legacy_proj.mkdir(parents=True, exist_ok=True)
                (legacy_proj / "index.html").write_text("<html><body><a href='/about'>Hello Sandbox</a></body></html>", encoding="utf-8")
                (legacy_proj / "about.txt").write_text("info", encoding="utf-8")

                # 1. GET /api/ai/agent/sandbox работает автономно, даже если Агент не запущен
                req = urllib.request.Request(f"{srv.base_url()}/api/ai/agent/sandbox", headers={"X-Harness-Token": srv.token})
                with urllib.request.urlopen(req, timeout=5) as resp:
                    sb = json.loads(resp.read().decode("utf-8"))
                self.assertFalse(sb.get("agentRunning"))
                self.assertEqual(sb.get("totalProjects"), 1)
                self.assertEqual(sb.get("projectsCount"), 1)
                self.assertEqual(sb["projects"][0]["name"], "demo_site")
                self.assertGreaterEqual(sb.get("totalFiles", 0), 2)

                # 2. Preview: редирект на /demo_site/ без слеша сохраняет ?ht=... и HTML переписывается
                class NoRedirect(urllib.request.HTTPRedirectHandler):
                    def redirect_request(self, req, fp, code, msg, headers, newurl):
                        return None

                opener = urllib.request.build_opener(NoRedirect)
                req_no_slash = urllib.request.Request(
                    f"{srv.base_url()}/api/ai/agent/sandbox/preview/demo_site?ht={urllib.parse.quote(srv.token)}"
                )
                with self.assertRaises(urllib.error.HTTPError) as ctx302:
                    opener.open(req_no_slash, timeout=5)
                self.assertEqual(ctx302.exception.code, 302)
                loc = ctx302.exception.headers.get("Location") or ""
                self.assertIn("/api/ai/agent/sandbox/preview/demo_site/", loc)
                self.assertIn(f"ht={urllib.parse.quote(srv.token)}", loc)

                req_idx = urllib.request.Request(
                    f"{srv.base_url()}/api/ai/agent/sandbox/preview/demo_site/?ht={urllib.parse.quote(srv.token)}"
                )
                with urllib.request.urlopen(req_idx, timeout=5) as resp:
                    html = resp.read().decode("utf-8")
                self.assertIn("Hello Sandbox", html)

                # 3. Скачивание одного файла и ZIP-архива проекта
                req_dl = urllib.request.Request(
                    f"{srv.base_url()}/api/ai/agent/sandbox?download=demo_site/about.txt",
                    headers={"X-Harness-Token": srv.token},
                )
                with urllib.request.urlopen(req_dl, timeout=5) as resp:
                    self.assertEqual(resp.read(), b"info")

                # 4. Локальные стенограммы (/api/agent/transcripts при 404 CRM) и write_transcript в Sandbox
                req_tr = urllib.request.Request(
                    f"{srv.base_url()}/api/agent/transcripts",
                    data=json.dumps({"title": "Сессия 1", "content": "Текст переписки", "fileName": "s1.md"}).encode("utf-8"),
                    headers={"X-Harness-Token": srv.token, "Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req_tr, timeout=5) as resp:
                    tr_res = json.loads(resp.read().decode("utf-8"))
                tid = tr_res["transcript"]["id"]

                with urllib.request.urlopen(
                    urllib.request.Request(f"{srv.base_url()}/api/agent/transcripts/{tid}", headers={"X-Harness-Token": srv.token}),
                    timeout=5,
                ) as resp:
                    self.assertEqual(resp.read().decode("utf-8"), "Текст переписки")

                # 5. Удаление файла из Sandbox работает автономно
                req_del = urllib.request.Request(
                    f"{srv.base_url()}/api/ai/agent/sandbox",
                    data=json.dumps({"action": "delete", "path": "demo_site/about.txt"}).encode("utf-8"),
                    headers={"X-Harness-Token": srv.token, "Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req_del, timeout=5) as resp:
                    del_res = json.loads(resp.read().decode("utf-8"))
                self.assertTrue(del_res.get("ok"))

                # 6. stop_process при остановленном агенте и невалидном pid не падает с 500
                req_stop = urllib.request.Request(
                    f"{srv.base_url()}/api/ai/agent/sandbox",
                    data=json.dumps({"action": "stop_process", "pid": "not-an-int"}).encode("utf-8"),
                    headers={"X-Harness-Token": srv.token, "Content-Type": "application/json"},
                    method="POST",
                )
                with self.assertRaises(urllib.error.HTTPError) as ctx_stop:
                    urllib.request.urlopen(req_stop, timeout=5)
                self.assertEqual(ctx_stop.exception.code, 503)
            finally:
                srv.shutdown()
                crm_srv.shutdown()
                if prev_cfg is None:
                    os.environ.pop("CRM_LAUNCHER_CONFIG", None)
                else:
                    os.environ["CRM_LAUNCHER_CONFIG"] = prev_cfg

    def test_chat_rename_patch_overlay_and_error_protection_with_keepalive(self) -> None:
        import http.client

        chats_db = [{"id": 10, "title": "Старый заголовок", "updatedAt": "2026-01-01T00:00:00Z"}]

        def legacy_crm_handler(h: BaseHTTPRequestHandler, method: str, path: str, body: bytes) -> None:
            if path == "/api/ai/chats" and method == "GET":
                raw = json.dumps({"chats": chats_db}, ensure_ascii=False).encode("utf-8")
                h.send_response(200)
                h.send_header("Content-Type", "application/json")
                h.send_header("Content-Length", str(len(raw)))
                h.end_headers()
                h.wfile.write(raw)
                return
            if path.startswith("/api/ai/chats/") and method == "PATCH":
                # Старый CRM не поддерживает PATCH -> отдаёт 405
                raw = json.dumps({"error": "Method Not Allowed"}).encode("utf-8")
                h.send_response(405)
                h.send_header("Content-Type", "application/json")
                h.send_header("Content-Length", str(len(raw)))
                h.end_headers()
                h.wfile.write(raw)
                return
            if path == "/api/boom-html":
                html = b"<html><body>Internal Server Error</body></html>"
                h.send_response(500)
                h.send_header("Content-Type", "text/html")
                h.send_header("Content-Length", str(len(html)))
                h.end_headers()
                h.wfile.write(html)
                return
            raw = json.dumps({"ok": True}).encode("utf-8")
            h.send_response(200)
            h.send_header("Content-Type", "application/json")
            h.send_header("Content-Length", str(len(raw)))
            h.end_headers()
            h.wfile.write(raw)

        crm_srv, crm_port = self.start_json_server(legacy_crm_handler)
        with tempfile.TemporaryDirectory() as tmp:
            prev_cfg = os.environ.get("CRM_LAUNCHER_CONFIG")
            os.environ["CRM_LAUNCHER_CONFIG"] = str(Path(tmp) / "settings.json")
            srv = harness_server.HarnessServer(port=0)
            srv.settings.crm_url = f"http://127.0.0.1:{crm_port}"
            srv.settings.crm_session_token = "tok_keep"
            srv.settings.crm_profile = {"user": {"id": 7}}
            try:
                srv.start()
                parsed_base = urllib.parse.urlparse(srv.base_url())
                conn = http.client.HTTPConnection(parsed_base.hostname, parsed_base.port, timeout=5)

                # Несколько последовательных запросов по ОДНОМУ Keep-Alive соединению
                conn.request(
                    "PATCH",
                    "/api/ai/chats/10",
                    body=json.dumps({"title": "Мой переименованный чат"}, ensure_ascii=False).encode("utf-8"),
                    headers={"X-Harness-Token": srv.token, "Content-Type": "application/json"},
                )
                r1 = conn.getresponse()
                d1 = json.loads(r1.read().decode("utf-8"))
                self.assertEqual(r1.status, 200)
                self.assertTrue(d1.get("localTitle"))

                # Второй запрос по тому же keep-alive сокету должен вернуть уже новое название
                conn.request("GET", "/api/ai/chats", headers={"X-Harness-Token": srv.token})
                r2 = conn.getresponse()
                d2 = json.loads(r2.read().decode("utf-8"))
                self.assertEqual(r2.status, 200)
                self.assertEqual(d2["chats"][0]["title"], "Мой переименованный чат")

                # Запрос с некорректным телом и последующий запрос на тот же keep-alive не ломают соединение
                conn.request(
                    "POST",
                    "/api/ai/agent/coach",
                    body=b"{not json",
                    headers={"X-Harness-Token": srv.token, "Content-Type": "application/json"},
                )
                r3 = conn.getresponse()
                d3 = json.loads(r3.read().decode("utf-8"))
                self.assertEqual(r3.status, 400)
                self.assertIn("JSON", d3.get("error", ""))

                # HTML-500 проксируется как понятный JSON, а не пустое тело/HTML
                conn.request("GET", "/api/boom-html", headers={"X-Harness-Token": srv.token})
                r4 = conn.getresponse()
                d4 = json.loads(r4.read().decode("utf-8"))
                self.assertEqual(r4.status, 500)
                self.assertIn("HTTP 500", d4.get("error", ""))
                conn.close()
            finally:
                srv.shutdown()
                crm_srv.shutdown()
                if prev_cfg is None:
                    os.environ.pop("CRM_LAUNCHER_CONFIG", None)
                else:
                    os.environ["CRM_LAUNCHER_CONFIG"] = prev_cfg

    def test_agent_run_persists_generated_files_into_sandbox_downloads(self) -> None:
        def fake_agent_handler(h: BaseHTTPRequestHandler, method: str, path: str, body: bytes) -> None:
            if path == "/health":
                raw = json.dumps({"ok": True}).encode("utf-8")
                h.send_response(200)
                h.send_header("Content-Type", "application/json")
                h.send_header("Content-Length", str(len(raw)))
                h.end_headers()
                h.wfile.write(raw)
                return
            if path == "/run":
                payload = json.dumps({
                    "type": "file",
                    "name": "отчёт.txt",
                    "mime": "text/plain",
                    "data": base64.b64encode("Готовый отчёт".encode("utf-8")).decode("ascii"),
                }, ensure_ascii=False)
                sse = (
                    f"event: action\ndata: {payload}\n\n"
                    'event: done\ndata: {"ok": true, "usage": {"prompt": 5, "completion": 5, "total": 10}}\n\n'
                ).encode("utf-8")
                h.send_response(200)
                h.send_header("Content-Type", "text/event-stream; charset=utf-8")
                h.send_header("Content-Length", str(len(sse)))
                h.end_headers()
                h.wfile.write(sse)
                return

        def fake_crm_handler(h: BaseHTTPRequestHandler, method: str, path: str, body: bytes) -> None:
            if path == "/api/launcher/agent/prepare":
                resp = {"ok": True, "payload": {"settings": {"baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini"}, "subagents": [], "routingMode": "linear"}}
            else:
                resp = {"ok": True}
            raw = json.dumps(resp).encode("utf-8")
            h.send_response(200)
            h.send_header("Content-Type", "application/json")
            h.send_header("Content-Length", str(len(raw)))
            h.end_headers()
            h.wfile.write(raw)

        ag_srv, ag_port = self.start_json_server(fake_agent_handler)
        crm_srv, crm_port = self.start_json_server(fake_crm_handler)
        with tempfile.TemporaryDirectory() as tmp:
            prev_cfg = os.environ.get("CRM_LAUNCHER_CONFIG")
            os.environ["CRM_LAUNCHER_CONFIG"] = str(Path(tmp) / "settings.json")
            ws_dir = Path(tmp) / "ws"
            ws_dir.mkdir(parents=True, exist_ok=True)
            srv = harness_server.HarnessServer(port=0)
            srv.settings.workspace = str(ws_dir)
            srv.settings.crm_url = f"http://127.0.0.1:{crm_port}"
            srv.settings.crm_session_token = "tok_ag"
            srv._agent_port = ag_port
            try:
                srv.start()
                req = urllib.request.Request(
                    f"{srv.base_url()}/api/ai/agent",
                    data=json.dumps({"messages": [{"role": "user", "content": "Сделай файл"}]}).encode("utf-8"),
                    headers={"X-Harness-Token": srv.token, "Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    sse_out = resp.read().decode("utf-8")
                self.assertIn('"sandboxPath": "downloads/отчёт.txt"', sse_out)
                saved = srv._sandbox_root() / "downloads" / "отчёт.txt"
                self.assertTrue(saved.is_file())
                self.assertEqual(saved.read_text(encoding="utf-8"), "Готовый отчёт")
            finally:
                srv.shutdown()
                ag_srv.shutdown()
                crm_srv.shutdown()
                if prev_cfg is None:
                    os.environ.pop("CRM_LAUNCHER_CONFIG", None)
                else:
                    os.environ["CRM_LAUNCHER_CONFIG"] = prev_cfg


if __name__ == "__main__":
    unittest.main()
