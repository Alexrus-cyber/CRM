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


if __name__ == "__main__":
    unittest.main()
