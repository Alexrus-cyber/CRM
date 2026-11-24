from __future__ import annotations

import base64
import hashlib
import http.server
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from unittest import mock

AGENT_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENT_DIR.parent
for p in (str(REPO_ROOT), str(AGENT_DIR)):
    if p in sys.path:
        sys.path.remove(p)
    sys.path.insert(0, p)

import agent as agent_mod  # noqa: E402
if not hasattr(agent_mod, "run_tool"):
    import importlib.util
    _spec = importlib.util.spec_from_file_location("agent_mod_runtime", AGENT_DIR / "agent.py")
    assert _spec and _spec.loader
    agent_mod = importlib.util.module_from_spec(_spec)
    sys.modules["agent_mod_runtime"] = agent_mod
    _spec.loader.exec_module(agent_mod)
import browser_inspector  # noqa: E402
import code_tools  # noqa: E402
import github_tools  # noqa: E402
import qa_tools  # noqa: E402
import sandbox as sandbox_mod  # noqa: E402


def _ws_encode_frame(payload: bytes, *, opcode: int = 0x1, fin: bool = True) -> bytes:
    b1 = (0x80 if fin else 0x00) | (opcode & 0x0F)
    n = len(payload)
    if n < 126:
        hdr = bytes([b1, n])
    elif n < 65536:
        hdr = bytes([b1, 126]) + struct.pack("!H", n)
    else:
        hdr = bytes([b1, 127]) + struct.pack("!Q", n)
    return hdr + payload


def _ws_read_client_frame(sock: socket.socket) -> Optional[Tuple[int, bytes]]:
    def _recv_exact(n: int) -> bytes:
        buf = bytearray()
        while len(buf) < n:
            chunk = sock.recv(n - len(buf))
            if not chunk:
                return b""
            buf.extend(chunk)
        return bytes(buf)

    hdr = _recv_exact(2)
    if len(hdr) < 2:
        return None
    b1, b2 = hdr[0], hdr[1]
    opcode = b1 & 0x0F
    masked = bool(b2 & 0x80)
    length = b2 & 0x7F
    if length == 126:
        ext = _recv_exact(2)
        if len(ext) < 2:
            return None
        (length,) = struct.unpack("!H", ext)
    elif length == 127:
        ext = _recv_exact(8)
        if len(ext) < 8:
            return None
        (length,) = struct.unpack("!Q", ext)
    mask = _recv_exact(4) if masked else b""
    data = _recv_exact(length) if length > 0 else b""
    if masked and data:
        data = bytes(data[i] ^ mask[i % 4] for i in range(len(data)))
    return opcode, data


class _MockCDPServer:
    """Локальный HTTP (/json/list, /json/new) + RFC-6455 WebSocket CDP-сервер для тестов browse_project."""

    def __init__(self, *, fragmented_screenshot: bool = True, timeout_screenshot: bool = False) -> None:
        self.fragmented_screenshot = fragmented_screenshot
        self.timeout_screenshot = timeout_screenshot
        self.calls: List[str] = []
        self._ws_threads: List[threading.Thread] = []
        self._ws_socks: List[socket.socket] = []

        # Поднимаем отдельный сырой TCP-сервер для WebSocket, а HTTP отдаст адрес ws://
        self._ws_srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._ws_srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._ws_srv.bind(("127.0.0.1", 0))
        self._ws_srv.listen(8)
        self.ws_port = int(self._ws_srv.getsockname()[1])
        self._stop = False

        ws_port = self.ws_port

        class _CDPHttp(http.server.BaseHTTPRequestHandler):
            def do_GET(self_h) -> None:  # noqa: N802
                if self_h.path.startswith("/json/list"):
                    body = json.dumps([
                        {
                            "id": "page-1",
                            "type": "page",
                            "title": "Demo App",
                            "url": "http://127.0.0.1/",
                            "webSocketDebuggerUrl": f"ws://127.0.0.1:{ws_port}/devtools/page/1",
                        }
                    ]).encode("utf-8")
                    self_h.send_response(200)
                    self_h.send_header("Content-Type", "application/json")
                    self_h.send_header("Content-Length", str(len(body)))
                    self_h.end_headers()
                    self_h.wfile.write(body)
                    return
                self_h.send_response(404)
                self_h.end_headers()

            def log_message(self_h, format: str, *args: object) -> None:  # noqa: A002
                return

        self._http = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _CDPHttp)
        self.http_port = int(self._http.server_address[1])
        threading.Thread(target=self._http.serve_forever, daemon=True).start()
        threading.Thread(target=self._accept_ws, daemon=True).start()

    def _accept_ws(self) -> None:
        while not self._stop:
            try:
                self._ws_srv.settimeout(0.2)
                conn, _ = self._ws_srv.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            self._ws_socks.append(conn)
            t = threading.Thread(target=self._serve_ws, args=(conn,), daemon=True)
            self._ws_threads.append(t)
            t.start()

    def _serve_ws(self, conn: socket.socket) -> None:
        try:
            conn.settimeout(5.0)
            hdr = bytearray()
            while b"\r\n\r\n" not in hdr:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                hdr.extend(chunk)
            hdr_txt = hdr.decode("latin1", errors="replace")
            ws_key = ""
            for line in hdr_txt.splitlines():
                if line.lower().startswith("sec-websocket-key:"):
                    ws_key = line.split(":", 1)[1].strip()
            accept = base64.b64encode(
                hashlib.sha1((ws_key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
            ).decode("ascii")
            resp = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
            ).encode("ascii")
            conn.sendall(resp)
            conn.settimeout(20.0)

            while not self._stop:
                frame = _ws_read_client_frame(conn)
                if frame is None:
                    break
                opcode, data = frame
                if opcode == 0x8:
                    break
                if opcode != 0x1:
                    continue
                req = json.loads(data.decode("utf-8"))
                msg_id = req["id"]
                method = req.get("method") or ""
                params = req.get("params") or {}
                self.calls.append(method)

                result: Dict[str, Any] = {}
                if method == "Runtime.evaluate":
                    expr = str(params.get("expression") or "")
                    if expr == "document.readyState":
                        result = {"result": {"value": "complete"}}
                    elif "wantedText" in expr or "scrollIntoView(" in expr:
                        result = {"result": {"value": {"x": 120, "y": 48, "tag": "button", "text": "Отправить"}}}
                    elif "stuckInvisible" in expr or "overflowItems" in expr:
                        result = {
                            "result": {
                                "value": {
                                    "url": "http://127.0.0.1/",
                                    "title": "Demo App",
                                    "viewport": {"width": 1440, "height": 900},
                                    "scroll": {"y": 0, "height": 900},
                                    "reducedMotion": False,
                                    "issues": [],
                                    "webAnimations": [
                                        {
                                            "kind": "CSSAnimation",
                                            "name": "fadeIn",
                                            "target": ".hero",
                                            "playState": "running",
                                            "currentTimeMs": 250,
                                            "durationMs": 500,
                                            "opacity": "1",
                                        }
                                    ],
                                    "cssAnimatedElements": [
                                        {
                                            "selector": ".hero",
                                            "animationName": "fadeIn",
                                            "transition": "",
                                            "animationPlayState": "running",
                                            "opacity": "1",
                                            "rect": {"x": 0, "y": 0, "w": 400, "h": 120},
                                        }
                                    ],
                                    "interactive": [
                                        {
                                            "index": 1,
                                            "tag": "button",
                                            "text": "Отправить",
                                            "selector": "#submit-btn",
                                            "x": 120,
                                            "y": 48,
                                            "disabled": False,
                                        }
                                    ],
                                    "keyframes": ["fadeIn"],
                                    "textSnippet": "Добро пожаловать в демо",
                                }
                            }
                        }
                    else:
                        result = {"result": {"value": {"ok": True}}}
                elif method == "Page.captureScreenshot":
                    if self.timeout_screenshot:
                        # Имитируем зависший screenshot на стороне браузера (клиент дождётся таймаут 6с или отключит)
                        time.sleep(0.05)
                        result = {}
                        # Не отвечаем на первый screenshot в этом тесте
                        continue
                    b64 = base64.b64encode(b"JPEG-DEMO-DATA").decode("ascii")
                    result = {"data": b64}

                reply_bytes = json.dumps({"id": msg_id, "result": result}).encode("utf-8")
                if self.fragmented_screenshot and method == "Page.captureScreenshot" and len(reply_bytes) > 12:
                    mid = len(reply_bytes) // 2
                    conn.sendall(_ws_encode_frame(reply_bytes[:mid], opcode=0x1, fin=False))
                    time.sleep(0.03)
                    conn.sendall(_ws_encode_frame(reply_bytes[mid:], opcode=0x0, fin=True))
                else:
                    conn.sendall(_ws_encode_frame(reply_bytes, opcode=0x1, fin=True))
        except Exception:  # noqa: BLE001
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def close(self) -> None:
        self._stop = True
        try:
            self._http.shutdown()
            self._http.server_close()
        except Exception:  # noqa: BLE001
            pass
        try:
            self._ws_srv.close()
        except OSError:
            pass
        for s in self._ws_socks:
            try:
                s.close()
            except OSError:
                pass


class AllToolsRegistryCoverageTests(unittest.TestCase):
    """Гарантирует, что тест покрывает 100% имён инструментов Агента, Субагентов, Code, QA и GitHub."""

    EXPECTED_ALL_TOOLS = {
        # Base (4)
        "create_file",
        "open_website",
        "play_youtube",
        "formulate_operator_task",
        # Operator & PC (3)
        "inspect_pc_screen",
        "call_operator",
        "pc_command",
        # Sandbox (7)
        "sandbox_mkdir",
        "sandbox_write_file",
        "sandbox_create_project",
        "sandbox_list",
        "sandbox_read_file",
        "run_command",
        "export_from_sandbox",
        # Browser (1)
        "browse_project",
        # Sub-Agent orchestration (4)
        "list_subagents",
        "call_subagent",
        "report_to_orchestrator",
        "request_subagent",
        # QA (7)
        "qa_static_review",
        "qa_run_tests",
        "qa_http_audit",
        "qa_security_audit",
        "qa_auth_matrix_audit",
        "qa_schema_audit",
        "qa_browser_audit",
        # Code (14)
        "code_search",
        "code_read_files",
        "code_file_stats",
        "code_symbols",
        "code_refs",
        "code_deps",
        "git_history",
        "run_typecheck",
        "run_lint_file",
        "run_tests_subset",
        "security_scan",
        "schema_inspect",
        "endpoint_inventory",
        "agent_plan",
        # GitHub (19)
        "github_repo_info",
        "github_list_files",
        "github_read_file",
        "github_read_files",
        "github_file_stat",
        "github_search_code",
        "github_status",
        "github_diff",
        "github_changed_since",
        "github_list_prs",
        "github_get_pr_diff",
        "github_ci_status",
        "github_write_file",
        "github_edit_file",
        "github_delete_file",
        "github_create_branch",
        "github_commit",
        "github_create_pr",
        "github_merge_pr",
    }

    def test_exact_inventory_of_all_59_tools(self) -> None:
        agent_tools = {t["function"]["name"] for t in agent_mod.tools_for_trust("full", has_github=True, role="agent")}
        sub_full_tools = {
            t["function"]["name"]
            for t in agent_mod.tools_for_trust(
                "full", has_github=True, role="subagent", subagent_tool_profile="full"
            )
        }
        actual_all = agent_tools | sub_full_tools
        self.assertEqual(actual_all, self.EXPECTED_ALL_TOOLS)
        self.assertEqual(len(actual_all), 59)


class BaseOperatorSandboxToolsTests(unittest.TestCase):
    def test_base_tools_create_file_open_website_play_youtube_formulate_operator(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            # 1. create_file
            txt, evs = agent_mod.run_tool(
                "create_file",
                {"name": "report.txt", "content": "Привет мир"},
                trust_level="none",
                sandbox_root=root,
            )
            self.assertIn("report.txt", txt)
            self.assertEqual(evs[0]["type"], "file")
            # 2. open_website
            txt, evs = agent_mod.run_tool(
                "open_website",
                {"url": "https://example.org", "label": "Example"},
                trust_level="none",
                sandbox_root=root,
            )
            self.assertEqual(evs[0]["type"], "open_url")
            self.assertEqual(evs[0]["url"], "https://example.org")
            # 3. play_youtube
            txt, evs = agent_mod.run_tool(
                "play_youtube",
                {"query": "lo-fi beats"},
                trust_level="none",
                sandbox_root=root,
            )
            self.assertTrue(evs[0]["autoplay"])
            self.assertIn("youtube.com", evs[0]["url"])
            # 4. formulate_operator_task
            txt, evs = agent_mod.run_tool(
                "formulate_operator_task",
                {"user_goal": "Открыть калькулятор", "mode": "copilot", "max_steps": 15},
                trust_level="none",
                sandbox_root=root,
            )
            self.assertEqual(evs[0]["type"], "operator_plan")
            self.assertEqual(evs[0]["maxSteps"], 15)

    def test_operator_and_pc_tools_always_require_approval_and_execute(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            approvals: list[dict] = []

            def approve(req: dict) -> dict:
                approvals.append(req)
                if req.get("kind") == "capture_screen":
                    return {
                        "approved": True,
                        "taskId": 77,
                        "screenSummary": "Открыт рабочий стол",
                        "screenshot": "data:image/png;base64,iVBORw0KGgo=",
                    }
                if req.get("kind") == "call_operator":
                    return {"approved": True, "taskId": 88, "mode": "copilot", "coachMode": "agent"}
                return {"approved": True}

            # 5. inspect_pc_screen (even at trust=full requires approval)
            txt, evs = agent_mod.run_tool(
                "inspect_pc_screen",
                {"reason": "Посмотреть окно"},
                trust_level="full",
                approval_fn=approve,
                sandbox_root=root,
            )
            self.assertIn("#77", txt)
            self.assertEqual(evs[0]["type"], "operator_screen")
            self.assertTrue(evs[0].get("_image", "").startswith("data:image/"))

            # 6. call_operator
            txt, evs = agent_mod.run_tool(
                "call_operator",
                {"task": "Нажать кнопку", "reason": "Автоматизация"},
                trust_level="full",
                approval_fn=approve,
                sandbox_root=root,
            )
            self.assertIn("#88", txt)
            self.assertEqual(evs[0]["type"], "operator_task")

            # 7. pc_command
            txt, evs = agent_mod.run_tool(
                "pc_command",
                {"command": "echo pc-ok"},
                trust_level="full",
                approval_fn=approve,
                sandbox_root=root,
            )
            self.assertIn("pc-ok", txt)
            self.assertEqual(evs[0]["exitCode"], 0)
            self.assertEqual([a["kind"] for a in approvals], ["capture_screen", "call_operator", "pc_command"])

    def test_all_7_sandbox_tools_and_tree_timeout_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            sb = os.path.join(tmp, "sb")
            export_dir = os.path.join(tmp, "out")
            root = sandbox_mod.get_sandbox_root(sb)

            # 8. sandbox_mkdir
            txt, evs = agent_mod.run_tool("sandbox_mkdir", {"path": "app/assets"}, trust_level="verified", sandbox_root=root)
            self.assertEqual(evs[0]["kind"], "mkdir")
            # 9. sandbox_write_file
            txt, evs = agent_mod.run_tool(
                "sandbox_write_file",
                {"path": "app/readme.md", "content": "# App"},
                trust_level="verified",
                sandbox_root=root,
            )
            self.assertEqual(evs[0]["kind"], "file")
            # 10. sandbox_create_project
            txt, evs = agent_mod.run_tool(
                "sandbox_create_project",
                {
                    "project": "site",
                    "directories": ["css"],
                    "files": [{"path": "index.html", "content": "<!doctype html><h1>Site</h1>"}],
                },
                trust_level="verified",
                sandbox_root=root,
            )
            self.assertEqual(evs[0]["filesCount"], 1)
            # 11. sandbox_list
            txt, _ = agent_mod.run_tool("sandbox_list", {"path": "site"}, trust_level="verified", sandbox_root=root)
            self.assertIn("index.html", txt)
            # 12. sandbox_read_file
            txt, _ = agent_mod.run_tool("sandbox_read_file", {"path": "site/index.html"}, trust_level="verified", sandbox_root=root)
            self.assertIn("<h1>Site</h1>", txt)
            # 13. run_command
            txt, evs = agent_mod.run_tool(
                "run_command",
                {"command": "echo hello-sandbox", "cwd": "site"},
                trust_level="full",
                sandbox_root=root,
            )
            self.assertIn("hello-sandbox", txt)
            # 14. export_from_sandbox
            txt, evs = agent_mod.run_tool(
                "export_from_sandbox",
                {"source": "site", "destination": export_dir, "mode": "copy"},
                trust_level="full",
                sandbox_root=root,
            )
            self.assertTrue(Path(export_dir, "index.html").is_file())
            self.assertEqual(evs[0]["type"], "sandbox_export")

            # Убийство дерева процессов при таймауте (дочерний процесс не оставляет pipe висеть)
            t0 = time.monotonic()
            with self.assertRaises(sandbox_mod.SandboxError) as ctx_err:
                sandbox_mod.run_command(
                    root,
                    f'"{sys.executable}" -c "import time; time.sleep(10)"',
                    rel_cwd=".",
                    timeout=1,
                )
            self.assertIn("таймаут", str(ctx_err.exception).lower())
            self.assertLess(time.monotonic() - t0, 5.0)


class BrowserInspectorAllActionsTests(unittest.TestCase):
    def test_browse_project_all_actions_with_fragmented_ws_and_proxy_env(self) -> None:
        mock_cdp = _MockCDPServer(fragmented_screenshot=True)
        with tempfile.TemporaryDirectory() as tmp:
            root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            sandbox_mod.write_file(root, "web/home.html", "<!doctype html><title>Home</title><h1>Demo</h1>")
            mgr = browser_inspector.BrowserSessionManager(sandbox_root=root)

            # Устанавливаем фальшивый HTTP_PROXY и проверяем, что 127.0.0.1 его игнорирует!
            fake_proc = mock.MagicMock()
            fake_proc.poll.return_value = None
            fake_proc.pid = 999999

            try:
                with (
                    mock.patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:9", "http_proxy": "http://127.0.0.1:9"}),
                    mock.patch.object(browser_inspector, "find_browser_executable", return_value="/usr/bin/chromium"),
                    mock.patch.object(
                        browser_inspector,
                        "_launch_headless_chromium",
                        return_value=(fake_proc, Path(tmp), mock_cdp.http_port),
                    ),
                    mock.patch.object(browser_inspector, "_kill_proc_tree"),
                ):
                    # StaticSandboxServer выбирает единственный web/home.html автоматически
                    srv = browser_inspector.StaticSandboxServer(root, "web")
                    try:
                        self.assertTrue(srv.url.endswith("/home.html"))
                    finally:
                        srv.close()

                    # 15. browse_project: все действия (open, resize, hover, click, type, press, scroll, wait, inspect_animations, evaluate, close)
                    txt, evs = agent_mod.run_tool(
                        "browse_project",
                        {"action": "open", "sandbox_project": "web", "wait_ms": 10},
                        trust_level="verified",
                        sandbox_root=root,
                        browser_manager=mgr,
                    )
                    self.assertIn("Demo App", txt)
                    self.assertTrue(evs[0]["preview"].startswith("data:image/jpeg;base64,"))
                    self.assertTrue(evs[0].get("trace"))
                    self.assertTrue(any("Page.navigate" in step for step in evs[0]["trace"]))

                    for act_args in (
                        {"action": "resize", "viewport": "mobile", "wait_ms": 10},
                        {"action": "hover", "selector": "#submit-btn", "wait_ms": 10},
                        {"action": "click", "selector": "#submit-btn", "wait_ms": 10},
                        {"action": "type", "selector": "#submit-btn", "text": "abc", "clear": True, "wait_ms": 10},
                        {"action": "press", "key": "Enter", "wait_ms": 10},
                        {"action": "scroll", "direction": "bottom", "wait_ms": 10},
                        {"action": "wait", "wait_ms": 10},
                        {"action": "inspect_animations", "wait_ms": 20},
                        {"action": "evaluate", "script": "1 + 1"},
                    ):
                        res_t, _ = agent_mod.run_tool(
                            "browse_project",
                            act_args,
                            trust_level="verified",
                            sandbox_root=root,
                            browser_manager=mgr,
                        )
                        self.assertIn("Demo App", res_t)

                    close_t, _ = agent_mod.run_tool(
                        "browse_project",
                        {"action": "close"},
                        trust_level="verified",
                        sandbox_root=root,
                        browser_manager=mgr,
                    )
                    self.assertIn("закрыта", close_t)
            finally:
                mgr.close_all()
                mock_cdp.close()

    def test_find_browser_executable_handles_permission_error(self) -> None:
        with (
            mock.patch.object(shutil, "which", return_value=None),
            mock.patch.object(browser_inspector, "_safe_is_file", return_value=False),
            mock.patch.object(browser_inspector, "_safe_is_dir", return_value=True),
            mock.patch.object(browser_inspector, "_safe_glob", return_value=[]),
            mock.patch("subprocess.run", side_effect=OSError("no playwright")),
        ):
            self.assertIsNone(browser_inspector.find_browser_executable())

    def test_capture_screenshot_timeout_disables_screenshots_without_failing(self) -> None:
        mock_cdp = _MockCDPServer(timeout_screenshot=True)
        try:
            ws_url = browser_inspector._find_page_ws_url(mock_cdp.http_port)
            cdp = browser_inspector.CDPClient(ws_url)
            sess = browser_inspector.BrowserSession(cdp=cdp)
            with mock.patch.object(cdp, "call", side_effect=browser_inspector.BrowserError("Браузер не ответил на Page.captureScreenshot за 6 с")):
                shot = sess.capture_screenshot()
            self.assertEqual(shot, "")
            self.assertTrue(sess._screenshots_disabled)
            # Повторный вызов мгновенно возвращает "" без CDP-вызова
            self.assertEqual(sess.capture_screenshot(), "")
            sess.close()
        finally:
            mock_cdp.close()


class CodeQaAndTesterToolsTests(unittest.TestCase):
    def test_all_14_code_tools(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=(os.name == "nt")) as tmp:
            root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            proj = root / "proj"
            (proj / "src" / "app" / "api" / "ping").mkdir(parents=True)
            (proj / "src" / "db").mkdir(parents=True)
            (proj / "drizzle").mkdir(parents=True)
            (proj / "node_modules" / "pkg" / "route").mkdir(parents=True)

            # Файл с route в node_modules должен игнорироваться collect_endpoint_inventory!
            (proj / "node_modules" / "pkg" / "route" / "route.ts").write_text(
                "export async function GET() { return null; }\n", encoding="utf-8"
            )
            (proj / "src" / "app" / "api" / "ping" / "route.ts").write_text(
                "export async function GET() { return new Response('ok'); }\n", encoding="utf-8"
            )
            (proj / "src" / "db" / "schema.ts").write_text(
                'export const items = sqliteTable("items", { id: integer("id") });\n', encoding="utf-8"
            )
            (proj / "drizzle" / "0001_init.sql").write_text(
                "CREATE TABLE items (id INTEGER PRIMARY KEY);\n", encoding="utf-8"
            )
            (proj / "app.py").write_text(
                "import helper\n\ndef calc(x: int) -> int:\n    return helper.double(x)\n", encoding="utf-8"
            )
            (proj / "helper.py").write_text("def double(v: int) -> int:\n    return v * 2\n", encoding="utf-8")
            (proj / "test_app.py").write_text(
                "import unittest\nimport app\n\nclass T(unittest.TestCase):\n    def test_calc(self):\n        self.assertEqual(app.calc(3), 6)\n",
                encoding="utf-8",
            )

            # Инициализируем git для git_history
            subprocess.run(["git", "-c", "core.fsmonitor=false", "init"], cwd=proj, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(["git", "-c", "core.fsmonitor=false", "config", "core.fsmonitor", "false"], cwd=proj, check=True)
            subprocess.run(["git", "-c", "core.fsmonitor=false", "config", "gc.auto", "0"], cwd=proj, check=True)
            subprocess.run(["git", "-c", "core.fsmonitor=false", "config", "user.email", "t@example.com"], cwd=proj, check=True)
            subprocess.run(["git", "-c", "core.fsmonitor=false", "config", "user.name", "Test"], cwd=proj, check=True)
            subprocess.run(["git", "-c", "core.fsmonitor=false", "add", "."], cwd=proj, check=True)
            subprocess.run(["git", "-c", "core.fsmonitor=false", "commit", "-m", "init"], cwd=proj, check=True, stdout=subprocess.DEVNULL)

            run_state: Dict[str, Any] = {}
            common = {"sandbox_project": "proj"}

            # 1. code_search
            txt, _ = agent_mod.run_tool("code_search", {**common, "query": "calc"}, trust_level="verified", sandbox_root=root)
            self.assertIn("app.py", txt)
            # 2. code_read_files
            txt, _ = agent_mod.run_tool("code_read_files", {**common, "files": ["app.py", "helper.py"]}, trust_level="verified", sandbox_root=root)
            self.assertIn("def double", txt)
            # 3. code_file_stats
            txt, _ = agent_mod.run_tool("code_file_stats", {**common, "path": "app.py"}, trust_level="verified", sandbox_root=root)
            self.assertIn("Python", txt)
            # 4. code_symbols
            txt, _ = agent_mod.run_tool("code_symbols", {**common, "path": "app.py"}, trust_level="verified", sandbox_root=root)
            self.assertIn("def calc", txt)
            # 5. code_refs
            txt, _ = agent_mod.run_tool("code_refs", {**common, "symbol": "double"}, trust_level="verified", sandbox_root=root)
            self.assertIn("helper.py", txt)
            # 6. code_deps
            txt, _ = agent_mod.run_tool("code_deps", {**common, "path": "app.py"}, trust_level="verified", sandbox_root=root)
            self.assertIn("helper", txt)
            # 7. git_history
            txt, _ = agent_mod.run_tool("git_history", {**common, "mode": "log_search", "grep": "init"}, trust_level="verified", sandbox_root=root)
            self.assertIn("init", txt)
            # 8. run_typecheck
            txt, _ = agent_mod.run_tool("run_typecheck", {**common}, trust_level="verified", sandbox_root=root)
            self.assertIn("py_compile", txt)
            # 9. run_lint_file
            txt, _ = agent_mod.run_tool("run_lint_file", {**common, "path": "app.py"}, trust_level="verified", sandbox_root=root)
            self.assertTrue("py_compile" in txt or "Ruff" in txt)
            # 10. run_tests_subset (вкл. unittest с фильтром -k и невалидный timeout без краша)
            txt, _ = agent_mod.run_tool(
                "run_tests_subset",
                {**common, "runner": "unittest", "paths": ["test_app.py"], "filter": "test_calc", "timeout": "bad"},
                trust_level="verified",
                sandbox_root=root,
            )
            self.assertIn("exit=0", txt)
            # 11. security_scan
            txt, _ = agent_mod.run_tool("security_scan", {**common}, trust_level="verified", sandbox_root=root)
            self.assertIn("Security & Secret Scan", txt)
            # 12. schema_inspect
            txt, _ = agent_mod.run_tool("schema_inspect", {**common}, trust_level="verified", sandbox_root=root)
            self.assertIn("items", txt)
            # 13. endpoint_inventory (не должно содержать route из node_modules!)
            txt, _ = agent_mod.run_tool("endpoint_inventory", {**common}, trust_level="verified", sandbox_root=root)
            self.assertIn("/api/ping", txt)
            self.assertNotIn("node_modules", txt)
            # 14. agent_plan (вкл. некорректный step_id="abc" без ValueError)
            txt, _ = agent_mod.run_tool(
                "agent_plan",
                {"action": "set_plan", "steps": ["Шаг 1", "Шаг 2"]},
                trust_level="verified",
                sandbox_root=root,
                run_state=run_state,
            )
            self.assertIn("Шаг 1", txt)
            txt, _ = agent_mod.run_tool(
                "agent_plan",
                {"action": "update_step", "step_id": "abc"},
                trust_level="verified",
                sandbox_root=root,
                run_state=run_state,
            )
            self.assertIn("Шаг 1", txt)

    def test_all_8_qa_tools_including_batch_approval_and_browser_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            proj = root / "qaapp"
            (proj / "src" / "app" / "api" / "ok").mkdir(parents=True)
            (proj / "src" / "app" / "api" / "ok" / "route.ts").write_text(
                "export async function GET() { const u = getCurrentUser(); return u; }\n", encoding="utf-8"
            )
            (proj / "index.html").write_text("<!doctype html><title>QA</title><h1>OK</h1>", encoding="utf-8")
            (proj / "test_one.py").write_text("assert 1 == 1\n", encoding="utf-8")
            (proj / "package.json").write_text(
                json.dumps({"name": "qaapp", "scripts": {"typecheck": "echo tc", "lint": "echo lnt"}}),
                encoding="utf-8",
            )
            (proj / "node_modules").mkdir()

            qa_state: Dict[str, Any] = {"report": {}, "checks": [], "runKey": "rk123"}
            approvals: list[dict] = []

            def fake_approve(req: dict) -> dict:
                approvals.append(req)
                return {"approved": True}

            # 1. qa_static_review
            txt, _ = agent_mod.run_tool("qa_static_review", {"sandbox_project": "qaapp"}, trust_level="verified", sandbox_root=root, qa_state=qa_state)
            self.assertIn("qaapp", txt)
            # 2. qa_run_tests (2 команды -> пакетное подтверждение 1 раз с testerRunKey!)
            txt, _ = agent_mod.run_tool(
                "qa_run_tests",
                {"sandbox_project": "qaapp"},
                trust_level="verified",
                approval_fn=fake_approve,
                sandbox_root=root,
                qa_state=qa_state,
            )
            self.assertEqual(len(approvals), 1)
            self.assertEqual(approvals[0].get("testerRunKey"), "rk123")
            # 3. qa_http_audit
            txt, _ = agent_mod.run_tool("qa_http_audit", {"sandbox_project": "qaapp", "routes": ["/index.html"]}, trust_level="verified", sandbox_root=root, qa_state=qa_state)
            self.assertIn("OK=1", txt)
            # 4. qa_security_audit
            txt, _ = agent_mod.run_tool("qa_security_audit", {"sandbox_project": "qaapp"}, trust_level="verified", sandbox_root=root, qa_state=qa_state)
            self.assertIn("QA Security Audit", txt)
            # 5. qa_auth_matrix_audit
            txt, _ = agent_mod.run_tool("qa_auth_matrix_audit", {"sandbox_project": "qaapp"}, trust_level="verified", sandbox_root=root, qa_state=qa_state)
            self.assertIn("/api/ok", txt)
            # 6. qa_schema_audit
            txt, _ = agent_mod.run_tool("qa_schema_audit", {"sandbox_project": "qaapp"}, trust_level="verified", sandbox_root=root, qa_state=qa_state)
            self.assertIn("Schema Audit", txt)
            # 7. qa_browser_audit fallback (при отсутствии Chrome не падает, а делает HTTP+статику)
            with mock.patch.object(browser_inspector, "find_browser_executable", return_value=None):
                txt, _ = agent_mod.run_tool("qa_browser_audit", {"sandbox_project": "qaapp"}, trust_level="verified", sandbox_root=root, qa_state=qa_state)
            self.assertIn("fallback", txt.lower())
            # 8. qa_submit_report
            txt, _ = agent_mod.run_tool(
                "qa_submit_report",
                {"status": "passed", "summary": "Всё ок", "critical_issues": [], "minor_issues": []},
                trust_level="verified",
                sandbox_root=root,
                qa_state=qa_state,
            )
            self.assertEqual(qa_state["report"]["status"], "passed")

    def test_removed_tester_tools_rejected_and_qa_works_via_full_subagent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            sandbox_mod.write_file(root, "app/index.html", "<!doctype html><h1>App</h1>")

            for legacy_tool in ("call_tester", "list_tester_reports", "confirm_minor_fixes"):
                with self.assertRaises(agent_mod.AgentError):
                    agent_mod.run_tool(
                        legacy_tool,
                        {"sandbox_project": "app"},
                        trust_level="verified",
                        sandbox_root=root,
                    )

            # Субагент с профилем "full" имеет доступ к QA-инструментам (qa_static_review, qa_browser_audit и т.д.)
            events: list[tuple[str, dict]] = []
            replies = iter(
                [
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "tool_calls": [
                                        {
                                            "id": "t1",
                                            "function": {
                                                "name": "qa_static_review",
                                                "arguments": '{"sandbox_project":"app"}',
                                            },
                                        }
                                    ],
                                }
                            }
                        ],
                        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
                    },
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "tool_calls": [
                                        {
                                            "id": "t2",
                                            "function": {
                                                "name": "report_to_orchestrator",
                                                "arguments": '{"status":"completed","summary":"Статическая проверка пройдена"}',
                                            },
                                        }
                                    ],
                                }
                            }
                        ],
                        "usage": {"prompt_tokens": 12, "completion_tokens": 6, "total_tokens": 18},
                    },
                ]
            )
            sub_ctx = {
                "emit_sse": lambda ev, data: events.append((ev, data)),
                "base_url": "http://127.0.0.1:8888/v1",
                "api_key": "",
                "model": "test-model",
                "params": {},
                "subagents": [
                    {
                        "id": 1,
                        "slug": "qa-engineer",
                        "name": "QA-инженер",
                        "orchestratorCanCall": True,
                        "toolProfile": "full",
                    }
                ],
            }
            with mock.patch.object(agent_mod, "call_model", side_effect=lambda *_a, **_kw: next(replies)):
                txt, _ = agent_mod.run_tool(
                    "call_subagent",
                    {"subagent": "qa-engineer", "sandbox_project": "app", "summary": "Проверка", "task": "Проверь app"},
                    trust_level="verified",
                    sandbox_root=root,
                    subagent_ctx=sub_ctx,
                )
            self.assertIn("Статическая проверка пройдена", txt)
            done_ev = next(d for e, d in events if e == "subagent_done")
            self.assertEqual(done_ev["toolProfile"], "full")


class All19GithubToolsTests(unittest.TestCase):
    def test_all_19_github_tools_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            remote_bare = Path(tmp) / "origin.git"
            seed_dir = Path(tmp) / "seed"
            subprocess.run(["git", "init", "--bare", str(remote_bare)], check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["git", "clone", str(remote_bare), str(seed_dir)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(["git", "config", "user.email", "seed@example.com"], cwd=seed_dir, check=True)
            subprocess.run(["git", "config", "user.name", "Seed"], cwd=seed_dir, check=True)
            (seed_dir / "README.md").write_text("# Demo\nhello world\n", encoding="utf-8")
            (seed_dir / "src").mkdir()
            (seed_dir / "src" / "main.py").write_text("def greet():\n    return 'hi'\n", encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=seed_dir, check=True)
            subprocess.run(["git", "commit", "-m", "initial"], cwd=seed_dir, check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["git", "branch", "-M", "main"], cwd=seed_dir, check=True)
            subprocess.run(["git", "push", "-u", "origin", "main"], cwd=seed_dir, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            gh_ctx = {
                "token": "ghp_testtoken_1234567890",
                "owner": "acme",
                "repo": "demo",
                "branch": "main",
                "userId": 1,
                "login": "alex",
                "name": "Alex",
                "email": "alex@example.com",
            }
            wdir = github_tools.get_repo_workspace_dir(root, 1, "acme", "demo")
            subprocess.run(["git", "clone", "-b", "main", str(remote_bare), str(wdir)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(["git", "config", "user.email", "alex@example.com"], cwd=wdir, check=True)
            subprocess.run(["git", "config", "user.name", "Alex"], cwd=wdir, check=True)

            # Второй коммит, чтобы работал changed_since
            (wdir / "src" / "main.py").write_text("def greet():\n    return 'hello'\n", encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=wdir, check=True)
            subprocess.run(["git", "commit", "-m", "update"], cwd=wdir, check=True, stdout=subprocess.DEVNULL)

            def fake_gh_api(path: str, token: str, method: str = "GET", body: Any = None, timeout: int = 20) -> Any:  # noqa: ARG001
                if path.endswith("/repos/acme/demo"):
                    return {"private": False, "description": "Demo", "language": "Python", "default_branch": "main"}
                if "/branches" in path:
                    return [{"name": "main"}]
                if "/commits?" in path:
                    return [{"sha": "abc1234", "commit": {"message": "initial", "author": {"name": "Alex"}}, "author": {"login": "alex"}}]
                if "/check-runs" in path:
                    return {"check_runs": [{"name": "ci", "status": "completed", "conclusion": "success", "html_url": "https://github.com/acme/demo"}]}
                if "/actions/runs" in path:
                    return {"workflow_runs": [{"run_number": 1, "name": "CI", "status": "completed", "conclusion": "success", "html_url": "https://github.com/acme/demo"}]}
                if path.endswith("/pulls/5/files?per_page=50"):
                    return [{"filename": "README.md", "status": "modified", "additions": 1, "deletions": 0, "patch": "@@ -1 +1 @@"}]
                if path.endswith("/pulls/5/comments?per_page=30"):
                    return []
                if path.endswith("/pulls/5"):
                    return {"number": 5, "state": "open", "title": "PR Title", "head": {"ref": "feat"}, "base": {"ref": "main"}, "additions": 1, "deletions": 0, "changed_files": 1, "html_url": "https://github.com/acme/demo/pull/5"}
                if path.endswith("/pulls/5/merge") and method == "PUT":
                    return {"merged": True, "sha": "merged123"}
                if path.endswith("/pulls") and method == "POST":
                    return {"number": 5, "html_url": "https://github.com/acme/demo/pull/5"}
                if "/pulls?" in path:
                    return [{"number": 5, "state": "open", "title": "PR Title", "head": {"ref": "feat"}, "base": {"ref": "main"}, "user": {"login": "alex"}, "html_url": "https://github.com/acme/demo/pull/5"}]
                return {}

            def approve(req: dict) -> dict:  # noqa: ARG001
                return {"approved": True, "approverUserId": 1}

            with (
                mock.patch.object(github_tools, "_gh_api", side_effect=fake_gh_api),
                mock.patch.object(github_tools, "ensure_repo_synced", return_value={"ok": True, "owner": "acme", "repo": "demo", "branch": "main", "workspaceDir": str(wdir), "relWorkspace": "_github/u1/acme__demo"}),
            ):
                # 1. github_repo_info
                txt, _ = agent_mod.run_tool("github_repo_info", {}, trust_level="verified", sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("acme/demo", txt)
                # 2. github_list_files
                txt, _ = agent_mod.run_tool("github_list_files", {}, trust_level="verified", sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("README.md", txt)
                # 3. github_read_file
                txt, _ = agent_mod.run_tool("github_read_file", {"path": "README.md"}, trust_level="verified", sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("hello world", txt)
                # 4. github_read_files
                txt, _ = agent_mod.run_tool("github_read_files", {"files": ["README.md", "src/main.py"]}, trust_level="verified", sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("greet", txt)
                # 5. github_file_stat
                txt, _ = agent_mod.run_tool("github_file_stat", {"path": "README.md"}, trust_level="verified", sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("sha256=", txt)
                # 6. github_search_code
                txt, _ = agent_mod.run_tool("github_search_code", {"query": "greet"}, trust_level="verified", sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("src/main.py", txt)
                # 7. github_changed_since
                txt, _ = agent_mod.run_tool("github_changed_since", {"base": "HEAD~1", "head": "HEAD"}, trust_level="verified", sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("src/main.py", txt)
                # 8. github_ci_status
                txt, _ = agent_mod.run_tool("github_ci_status", {}, trust_level="verified", sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("success", txt)
                # 9. github_list_prs
                txt, _ = agent_mod.run_tool("github_list_prs", {"state": "open"}, trust_level="verified", sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("#5", txt)
                # 10. github_get_pr_diff
                txt, _ = agent_mod.run_tool("github_get_pr_diff", {"pull_number": 5}, trust_level="verified", sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("PR #5", txt)
                # 11. github_create_branch
                txt, _ = agent_mod.run_tool("github_create_branch", {"branch": "feat"}, trust_level="verified", sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("feat", txt)
                # 12. github_write_file
                txt, _ = agent_mod.run_tool("github_write_file", {"path": "temp.txt", "content": "tmp"}, trust_level="verified", sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("temp.txt", txt)
                # 13. github_edit_file
                txt, _ = agent_mod.run_tool("github_edit_file", {"path": "README.md", "old_text": "hello world", "new_text": "hello CRM"}, trust_level="verified", sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("изменён", txt)
                # 14. github_status
                txt, _ = agent_mod.run_tool("github_status", {}, trust_level="verified", sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("README.md", txt)
                # 15. github_diff
                txt, _ = agent_mod.run_tool("github_diff", {}, trust_level="verified", sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("hello CRM", txt)
                # 16. github_delete_file
                txt, _ = agent_mod.run_tool("github_delete_file", {"path": "temp.txt"}, trust_level="verified", sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("удалён", txt)
                # 17. github_commit (push=False чтобы не требовать удалённого https)
                txt, evs = agent_mod.run_tool("github_commit", {"message": "feat: update readme", "push": False}, trust_level="verified", approval_fn=approve, sandbox_root=root, github_ctx=gh_ctx)
                self.assertEqual(evs[0]["type"], "github_commit")
                # 18. github_create_pr
                txt, evs = agent_mod.run_tool("github_create_pr", {"title": "PR Title", "head": "feat", "base": "main"}, trust_level="verified", approval_fn=approve, sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("#5", txt)
                # 19. github_merge_pr
                txt, evs = agent_mod.run_tool("github_merge_pr", {"pull_number": 5}, trust_level="verified", approval_fn=approve, sandbox_root=root, github_ctx=gh_ctx)
                self.assertIn("успешно влит", txt)


class ModelProtocolHardeningTests(unittest.TestCase):
    def test_call_model_stops_immediately_on_finish_reason_with_usage(self) -> None:
        class HangingTailSSE:
            def __init__(self) -> None:
                self._lines = [
                    b'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
                    b'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n',
                ]

            def __enter__(self):
                return self

            def __exit__(self, *_a):
                return False

            def __iter__(self):
                for line in self._lines:
                    yield line
                raise AssertionError("Не должно висеть и ждать [DONE], если уже пришли finish_reason и usage")

        with mock.patch.object(agent_mod, "_safe_model_urlopen", return_value=HangingTailSSE()):
            res = agent_mod.call_model(
                "http://127.0.0.1:8888/v1",
                "",
                "test-model",
                [{"role": "user", "content": "hi"}],
                None,
                on_text=lambda _t: None,
            )
        self.assertEqual(res["choices"][0]["message"]["content"], "Hi")
        self.assertEqual(res["usage"]["total_tokens"], 4)

    def test_call_model_raises_error_when_sse_chunk_contains_error(self) -> None:
        class ErrorSSE:
            def __enter__(self):
                return self

            def __exit__(self, *_a):
                return False

            def __iter__(self):
                yield b'data: {"error":{"message":"Invalid model id","code":"invalid_model"}}\n'

        with mock.patch.object(agent_mod, "_safe_model_urlopen", return_value=ErrorSSE()):
            with self.assertRaises(agent_mod.AgentError) as ctx:
                agent_mod.call_model(
                    "http://127.0.0.1:8888/v1",
                    "",
                    "bad-model",
                    [{"role": "user", "content": "hi"}],
                    None,
                    on_text=lambda _t: None,
                )
        self.assertIn("Invalid model id", str(ctx.exception))

    def test_parse_text_tool_call_handles_nested_braces_and_backticks(self) -> None:
        raw = (
            '```json\n'
            '{"tool": "sandbox_create_project", "args": {"project": "app", "files": ['
            '{"path": "index.html", "content": "<script>function f(){return `{ok}`;}</script>"}'
            ']}}\n'
            '```'
        )
        parsed = agent_mod.parse_text_tool_call(raw)
        self.assertIsNotNone(parsed)
        tool_name, tool_args = parsed  # type: ignore[misc]
        self.assertEqual(tool_name, "sandbox_create_project")
        self.assertEqual(tool_args["project"], "app")
        self.assertIn("{return `{ok}`;}", tool_args["files"][0]["content"])

    def test_safe_model_urlopen_bypasses_proxy_for_localhost(self) -> None:
        class DummyH(http.server.BaseHTTPRequestHandler):
            def do_POST(self_h) -> None:  # noqa: N802
                body = b'{"choices":[{"message":{"content":"local-ok"}}]}'
                self_h.send_response(200)
                self_h.send_header("Content-Type", "application/json")
                self_h.send_header("Content-Length", str(len(body)))
                self_h.end_headers()
                self_h.wfile.write(body)

            def log_message(self_h, format: str, *args: object) -> None:  # noqa: A002
                return

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), DummyH)
        port = int(srv.server_address[1])
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            with mock.patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:9", "http_proxy": "http://127.0.0.1:9"}):
                res = agent_mod.call_model(
                    f"http://127.0.0.1:{port}/v1",
                    "",
                    "local",
                    [{"role": "user", "content": "hi"}],
                    None,
                )
            self.assertEqual(res["choices"][0]["message"]["content"], "local-ok")
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
