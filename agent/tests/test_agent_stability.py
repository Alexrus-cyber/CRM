from __future__ import annotations

import http.client
import io
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

AGENT_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENT_DIR.parent
for p in (str(AGENT_DIR), str(REPO_ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)

import agent as agent_mod  # noqa: E402
import browser_inspector  # noqa: E402
import code_tools  # noqa: E402
import qa_tools  # noqa: E402
import sandbox as sandbox_mod  # noqa: E402


class FakeWinError10053(OSError):
    def __init__(self, winerror: int = 10053) -> None:
        super().__init__(winerror, "An established connection was aborted by the software in your host machine")
        self.winerror = winerror


class ClientDisconnectAndServerTests(unittest.TestCase):
    def test_is_client_disconnect_detects_winerror_and_broken_pipe(self) -> None:
        self.assertTrue(agent_mod._is_client_disconnect(BrokenPipeError()))
        self.assertTrue(agent_mod._is_client_disconnect(ConnectionAbortedError()))
        self.assertTrue(agent_mod._is_client_disconnect(ConnectionResetError()))
        self.assertTrue(agent_mod._is_client_disconnect(FakeWinError10053(10053)))
        self.assertTrue(agent_mod._is_client_disconnect(FakeWinError10053(10054)))
        self.assertFalse(agent_mod._is_client_disconnect(FileNotFoundError("missing")))

    def test_server_handle_error_suppresses_client_disconnect_traceback(self) -> None:
        srv = agent_mod.Server(("127.0.0.1", 0), agent_mod.Handler)
        try:
            err_buf = io.StringIO()
            with mock.patch("sys.stderr", err_buf):
                try:
                    raise FakeWinError10053(10053)
                except FakeWinError10053:
                    srv.handle_error(None, ("127.0.0.1", 12345))
            self.assertEqual(err_buf.getvalue(), "")
        finally:
            srv.server_close()

    def test_handler_json_and_write_handle_disconnect_gracefully(self) -> None:
        class BrokenWriter:
            def write(self, _data: bytes) -> int:
                raise FakeWinError10053(10053)

            def flush(self) -> None:
                pass

        h = agent_mod.Handler.__new__(agent_mod.Handler)
        h.request_version = "HTTP/1.1"
        h.requestline = "GET /sandbox HTTP/1.1"
        h.client_address = ("127.0.0.1", 12345)
        h.command = "GET"
        h.path = "/sandbox"
        h.headers = {}  # type: ignore[assignment]
        h.wfile = BrokenWriter()  # type: ignore[assignment]
        h._headers_buffer = []

        # _json не должен падать при WinError 10053
        with mock.patch.object(agent_mod, "log"):
            h._json(200, {"ok": True})
            self.assertTrue(getattr(h, "_client_disconnected", False))

            # write при обрыве кидает BrokenPipeError и выставляет _client_disconnected
            h._client_disconnected = False
            with self.assertRaises(BrokenPipeError):
                h.write(b"data: {}\n\n")
            self.assertTrue(h._client_disconnected)

    def test_sse_keepalive_sends_heartbeat_and_stops_cleanly(self) -> None:
        chunks: list[bytes] = []
        lock = threading.Lock()

        class CollectingWriter:
            def write(self, data: bytes) -> int:
                with lock:
                    chunks.append(data)
                return len(data)

            def flush(self) -> None:
                pass

        h = agent_mod.Handler.__new__(agent_mod.Handler)
        h.wfile = CollectingWriter()  # type: ignore[assignment]

        with h._sse_keepalive(interval=0.05):
            time.sleep(0.18)

        with lock:
            joined = b"".join(chunks)
        self.assertIn(b": keepalive\n\n", joined)

    def test_abrupt_socket_close_on_real_server_produces_no_traceback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            sb_root = sandbox_mod.get_sandbox_root(tmp)
            sandbox_mod.write_file(sb_root, "_github/u1/repo/huge.txt", "data")
            sandbox_mod.write_file(sb_root, "demo/index.html", "<h1>hi</h1>")

            prev_sb = agent_mod.SANDBOX_ROOT
            agent_mod.SANDBOX_ROOT = sb_root
            srv = agent_mod.Server(("127.0.0.1", 0), agent_mod.Handler)
            port = srv.server_address[1]
            t = threading.Thread(target=srv.serve_forever, daemon=True)
            t.start()
            err_buf = io.StringIO()
            try:
                with mock.patch("sys.stderr", err_buf), mock.patch.object(agent_mod, "log"):
                    # Отправляем GET /sandbox и мгновенно рвём сокет с RST (SO_LINGER=0)
                    sock = socket.create_connection(("127.0.0.1", port), timeout=2.0)
                    sock.setsockopt(
                        socket.SOL_SOCKET,
                        socket.SO_LINGER,
                        b"\x01\x00\x00\x00\x00\x00\x00\x00",
                    )
                    sock.sendall(b"GET /sandbox HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                    sock.close()
                    time.sleep(0.15)

                    # Обычный GET /sandbox работает и не тащит _github
                    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3.0)
                    conn.request("GET", "/sandbox")
                    resp = conn.getresponse()
                    body = json.loads(resp.read().decode("utf-8"))
                    conn.close()
                    self.assertEqual(resp.status, 200)
                    self.assertFalse(any("_github" in p.get("name", "") for p in body["projects"]))
                    self.assertTrue(any(p.get("name") == "demo" for p in body["projects"]))
                    self.assertNotIn("Traceback", err_buf.getvalue())
            finally:
                agent_mod.SANDBOX_ROOT = prev_sb
                srv.shutdown()
                srv.server_close()


class SandboxTreePerfAndBoundsTests(unittest.TestCase):
    def test_list_tree_non_unlimited_stops_early_and_skips_github(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = sandbox_mod.get_sandbox_root(tmp)
            (root / "_github" / "u1" / "repo").mkdir(parents=True, exist_ok=True)
            (root / "_github" / "u1" / "repo" / "a.txt").write_text("x", encoding="utf-8")

            big_proj = root / "big"
            big_proj.mkdir(parents=True, exist_ok=True)
            for i in range(sandbox_mod.MAX_LIST_ITEMS + 50):
                (big_proj / f"file_{i:04d}.txt").write_text("hi", encoding="utf-8")

            tree = sandbox_mod.list_tree(root, ".", unlimited=False)
            self.assertTrue(tree["truncated"])
            self.assertEqual(len(tree["items"]), sandbox_mod.MAX_LIST_ITEMS)
            self.assertFalse(any(p["name"] == "_github" for p in tree["projects"]))


class CallModelRetryAndAntiLoopTests(unittest.TestCase):
    def test_call_model_retries_transient_errors_and_falls_back_to_non_stream(self) -> None:
        attempts: list[bool] = []

        class FailingStreamResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_a):
                return False

            def __iter__(self):
                raise http.client.IncompleteRead(b"partial")

        class OkJsonResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_a):
                return False

            def read(self) -> bytes:
                return json.dumps(
                    {
                        "choices": [{"message": {"role": "assistant", "content": "Готово!"}}],
                        "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
                    }
                ).encode("utf-8")

        def fake_urlopen(req, timeout=180):  # noqa: ARG001
            payload = json.loads(req.data.decode("utf-8"))
            attempts.append(bool(payload.get("stream")))
            if len(attempts) <= 2:
                return FailingStreamResponse()
            return OkJsonResponse()

        log_messages: list[str] = []
        with (
            mock.patch.object(agent_mod, "_safe_model_urlopen", side_effect=fake_urlopen),
            mock.patch("time.sleep"),
            mock.patch.object(agent_mod, "log", side_effect=log_messages.append),
        ):
            res = agent_mod.call_model(
                "http://127.0.0.1:8888/v1",
                "",
                "test-model",
                [{"role": "user", "content": "hi"}],
                None,
                on_text=lambda _t: None,
            )

        self.assertEqual(attempts, [True, True, False])
        self.assertEqual(res["choices"][0]["message"]["content"], "Готово!")
        self.assertTrue(any("временный сбой модели" in m or "сбой потока модели" in m for m in log_messages))

    def test_call_model_aborts_retry_when_cancelled(self) -> None:
        with self.assertRaises(BrokenPipeError):
            agent_mod.call_model(
                "http://127.0.0.1:8888/v1",
                "",
                "test-model",
                [{"role": "user", "content": "hi"}],
                None,
                cancel_check=lambda: True,
            )

    def test_run_agent_breaks_repeated_tool_call_loop(self) -> None:
        sse_frames: list[str] = []

        class FakeWriter:
            def write(self, data: bytes) -> int:
                sse_frames.append(data.decode("utf-8", "replace"))
                return len(data)

            def flush(self) -> None:
                pass

        h = agent_mod.Handler.__new__(agent_mod.Handler)
        h.wfile = FakeWriter()  # type: ignore[assignment]

        call_count = 0

        def fake_call_model(_base_url, _api_key, _model, _msgs, tools, *_a, **_kw):
            nonlocal call_count
            call_count += 1
            if tools:
                return {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": f"c_{call_count}",
                                        "type": "function",
                                        "function": {
                                            "name": "sandbox_list",
                                            "arguments": json.dumps({"path": "."}),
                                        },
                                    }
                                ],
                            }
                        }
                    ]
                }
            # На 5-м шаге инструменты принудительно отключены анти-лупом -> модель отдаёт финальный ответ
            return {"choices": [{"message": {"role": "assistant", "content": "Итог без зацикливания"}}]}

        with mock.patch.object(agent_mod, "call_model", side_effect=fake_call_model):
            h.run_agent(
                {
                    "messages": [{"role": "user", "content": "проверь"}],
                    "model": "test-model",
                    "baseUrl": "http://127.0.0.1:8888/v1",
                    "maxSteps": 20,
                    "trustLevel": "verified",
                }
            )

        self.assertEqual(call_count, 5)
        joined = "".join(sse_frames)
        self.assertIn("Итог без зацикливания", joined)


class BrowserInspectorStabilityTests(unittest.TestCase):
    def test_cdp_reader_survives_timeout_and_auto_dismisses_js_dialog(self) -> None:
        cdp = browser_inspector.CDPClient.__new__(browser_inspector.CDPClient)
        cdp._lock = threading.Lock()
        cdp._pending = {}
        cdp._next_id = 1
        cdp.console_messages = []
        cdp.page_errors = []
        cdp.failed_requests = []
        cdp._requests_url = {}
        cdp._ws = mock.MagicMock()
        cdp._ws.closed = False

        frames: list[object] = [
            TimeoutError("read timed out"),
            json.dumps(
                {
                    "method": "Page.javascriptDialogOpening",
                    "params": {"message": "Alert text", "type": "alert"},
                }
            ),
            None,
        ]

        def fake_recv():
            val = frames.pop(0)
            if isinstance(val, BaseException):
                raise val
            return val

        cdp._ws.recv_text.side_effect = fake_recv
        with mock.patch.object(cdp, "call") as call_mock:
            cdp._reader_loop()
            time.sleep(0.08)
            call_mock.assert_called_once_with(
                "Page.handleJavaScriptDialog",
                {"accept": True},
                timeout=3.0,
            )
        self.assertTrue(any("[JS alert] Alert text" in m.get("text", "") for m in cdp.console_messages))

    def test_session_manager_recreates_dead_session_and_validates_navigate(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            mgr = browser_inspector.BrowserSessionManager(sandbox_root=Path(tmp))
            dead_session = mock.MagicMock()
            dead_session.is_alive.return_value = False
            dead_session.approved_external_origins = {"https://example.com"}
            mgr._sessions["s1"] = dead_session

            fresh_session = mock.MagicMock()
            fresh_session.is_alive.return_value = True
            fresh_session.approved_external_origins = set()
            fresh_session.width = 1440
            fresh_session.height = 900
            with mock.patch.object(browser_inspector.BrowserSession, "launch", return_value=fresh_session):
                got = mgr.get_or_create("s1", 1440, 900)
                self.assertIs(got, fresh_session)
                dead_session.close.assert_called_once()
                self.assertIn("https://example.com", fresh_session.approved_external_origins)

            with self.assertRaises(browser_inspector.BrowserError):
                browser_inspector.execute_browse_action(
                    mgr,
                    {"action": "navigate", "session_id": "s1"},
                    trust_level="full",
                )

    def test_execute_browse_action_early_validation_never_launches_browser(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            mgr = browser_inspector.BrowserSessionManager(sandbox_root=Path(tmp))
            with mock.patch.object(
                browser_inspector.BrowserSession,
                "launch",
                side_effect=AssertionError("Браузер не должен запускаться до валидации аргументов"),
            ):
                for bad_args in (
                    {"action": "open"},
                    {"action": "click", "selector": "#btn"},
                    {"action": "unknown_action", "url": "http://127.0.0.1:3000"},
                    {"action": "open", "sandbox_project": "missing_folder"},
                    {"action": "evaluate", "url": "http://127.0.0.1:3000"},
                ):
                    with self.assertRaises(browser_inspector.BrowserError):
                        browser_inspector.execute_browse_action(mgr, bad_args, trust_level="full")

    def test_cdp_client_call_fails_fast_when_reader_thread_dead(self) -> None:
        cdp = browser_inspector.CDPClient.__new__(browser_inspector.CDPClient)
        cdp._lock = threading.Lock()
        cdp._pending = {}
        cdp._next_id = 1
        cdp._ws = mock.MagicMock()
        cdp._ws.closed = False
        dead_thread = threading.Thread(target=lambda: None)
        dead_thread.start()
        dead_thread.join(timeout=1.0)
        cdp._thread = dead_thread

        t0 = time.monotonic()
        with self.assertRaises(browser_inspector.BrowserError):
            cdp.call("Page.enable", timeout=15.0)
        self.assertLess(time.monotonic() - t0, 1.0)

    def test_find_page_ws_url_normalizes_localhost_and_recovers_after_empty_list(self) -> None:
        from http.server import BaseHTTPRequestHandler, HTTPServer

        state = {"list_calls": 0, "created": False}

        class MockCdpHttp(BaseHTTPRequestHandler):
            def log_message(self, fmt: str, *args: object) -> None:
                return

            def do_GET(self) -> None:
                if self.path == "/json/list":
                    state["list_calls"] += 1
                    payload = (
                        [{"type": "page", "webSocketDebuggerUrl": f"ws://localhost:{self.server.server_port}/devtools/page/p1"}]
                        if state["created"]
                        else []
                    )
                    body = json.dumps(payload).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_response(404)
                self.end_headers()

            def do_PUT(self) -> None:
                if self.path.startswith("/json/new"):
                    state["created"] = True
                    body = json.dumps(
                        {"type": "page", "webSocketDebuggerUrl": f"ws://localhost:{self.server.server_port}/devtools/page/p1"}
                    ).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_response(404)
                self.end_headers()

        srv = HTTPServer(("127.0.0.1", 0), MockCdpHttp)
        th = threading.Thread(target=srv.serve_forever, daemon=True)
        th.start()
        try:
            ws_url = browser_inspector._find_page_ws_url(srv.server_port)
            self.assertEqual(ws_url, f"ws://127.0.0.1:{srv.server_port}/devtools/page/p1")
        finally:
            srv.shutdown()
            srv.server_close()
            th.join(timeout=2)

    @staticmethod
    def _make_fake_browser_wrapper(tmp_dir: Path, name: str, script_path: Path) -> Path:
        if os.name == "nt":
            exe = tmp_dir / f"{name}.cmd"
            exe.write_text(f'@echo off\r\n"{sys.executable}" "{script_path}" %*\r\n', encoding="utf-8")
            return exe
        exe = tmp_dir / f"{name}.sh"
        exe.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script_path}" "$@"\n', encoding="utf-8")
        exe.chmod(0o755)
        return exe

    @staticmethod
    def _is_pid_alive(pid: int) -> bool:
        if os.name == "nt":
            import ctypes
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            handle = kernel32.OpenProcess(0x100000 | 0x0400, False, pid)
            if not handle:
                return False
            try:
                wait_res = kernel32.WaitForSingleObject(handle, 0)
                return wait_res != 0
            finally:
                kernel32.CloseHandle(handle)
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def test_launch_headless_chromium_and_kill_proc_tree_no_pipe_deadlock(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            pid_file = tmp_path / "grandchild.pid"
            fake_py = tmp_path / "fake_browser.py"
            fake_py.write_text(
                "\n".join(
                    [
                        "import subprocess, sys, time",
                        f"gc = subprocess.Popen([{sys.executable!r}, '-c', 'import time; time.sleep(30)'])",
                        f"with open({str(pid_file)!r}, 'w', encoding='utf-8') as fh:",
                        "    fh.write(str(gc.pid))",
                        "sys.stderr.write('DevTools listening on ws://127.0.0.1:45555/devtools/browser/test\\n')",
                        "sys.stderr.flush()",
                        "time.sleep(30)",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            fake_exe = self._make_fake_browser_wrapper(tmp_path, "fake-chromium", fake_py)

            t0 = time.monotonic()
            proc, user_data, port = browser_inspector._launch_headless_chromium(str(fake_exe), 1280, 720)
            try:
                self.assertEqual(port, 45555)
                self.assertLess(time.monotonic() - t0, 3.0)
                for _ in range(50):
                    if pid_file.is_file() and pid_file.read_text(encoding="utf-8").strip().isdigit():
                        break
                    time.sleep(0.05)
                gc_pid = int(pid_file.read_text(encoding="utf-8").strip())

                t_kill = time.monotonic()
                browser_inspector._kill_proc_tree(proc)
                elapsed_kill = time.monotonic() - t_kill
                self.assertLess(elapsed_kill, 3.0)

                time.sleep(0.15)
                self.assertFalse(
                    self._is_pid_alive(gc_pid),
                    "Дочерний процесс-внук (grandchild) не должен оставаться в живых после _kill_proc_tree",
                )
            finally:
                browser_inspector._kill_proc_tree(proc)
                import shutil as _sh
                _sh.rmtree(user_data, ignore_errors=True)

    def test_execute_browse_action_emits_status_and_cancels_during_launch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            slow_py = tmp_path / "slow_browser.py"
            slow_py.write_text("import time\ntime.sleep(30)\n", encoding="utf-8")
            fake_exe = self._make_fake_browser_wrapper(tmp_path, "slow-chromium", slow_py)
            mgr = browser_inspector.BrowserSessionManager(sandbox_root=tmp_path)
            statuses: list[str] = []
            cancel_flag = {"stop": False}

            def trigger_cancel() -> None:
                time.sleep(0.25)
                cancel_flag["stop"] = True

            threading.Thread(target=trigger_cancel, daemon=True).start()
            t0 = time.monotonic()
            with mock.patch.object(browser_inspector, "find_browser_executable", return_value=str(fake_exe)):
                with self.assertRaises(browser_inspector.BrowserError) as ctx_err:
                    browser_inspector.execute_browse_action(
                        mgr,
                        {"action": "open", "url": "http://127.0.0.1:8123"},
                        trust_level="full",
                        on_status=statuses.append,
                        cancel_check=lambda: cancel_flag["stop"],
                    )
            self.assertIn("отменён", str(ctx_err.exception).lower())
            self.assertLess(time.monotonic() - t0, 3.0)
            self.assertTrue(any("Запускаю headless-браузер" in s for s in statuses))

    def test_find_browser_executable_playwright_probe_does_not_hang(self) -> None:
        import importlib.util as _iu
        import shutil as _sh

        orig_popen = browser_inspector.subprocess.Popen

        def slow_popen(cmd, **kwargs):
            if isinstance(cmd, list) and "-c" in cmd:
                return orig_popen(
                    [sys.executable, "-c", "import subprocess, sys, time; subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)']); time.sleep(30)"],
                    **kwargs,
                )
            return orig_popen(cmd, **kwargs)

        t0 = time.monotonic()
        with (
            mock.patch.object(_sh, "which", return_value=None),
            mock.patch.object(browser_inspector, "_safe_is_file", return_value=False),
            mock.patch.object(browser_inspector, "_safe_is_dir", return_value=False),
            mock.patch.object(browser_inspector, "_safe_glob", return_value=[]),
            mock.patch.object(_iu, "find_spec", return_value=object()),
            mock.patch.object(browser_inspector.subprocess, "Popen", side_effect=slow_popen),
        ):
            res = browser_inspector.find_browser_executable(allow_subprocess=True)
        self.assertIsNone(res)
        self.assertLess(time.monotonic() - t0, 5.5)

    def test_audit_degrades_gracefully_when_js_thread_times_out(self) -> None:
        fake_cdp = mock.MagicMock()
        fake_cdp._ws = mock.MagicMock()
        fake_cdp._ws.closed = False
        fake_cdp._thread = None
        fake_cdp.evaluate.side_effect = browser_inspector.BrowserError("Браузер не ответил на Runtime.evaluate за 8 с")
        fake_cdp.snapshot_telemetry.return_value = {
            "consoleMessages": [{"level": "error", "text": "Uncaught RangeError"}],
            "pageErrors": ["RangeError: boom"],
            "failedRequests": [],
        }

        sess = browser_inspector.BrowserSession(cdp=fake_cdp, width=1280, height=720)
        sess.current_url = "http://127.0.0.1:3000/"
        result = sess.audit()

        self.assertEqual(fake_cdp.evaluate.call_count, 1)
        self.assertEqual(result["telemetry"]["pageErrors"], ["RangeError: boom"])
        issues = result["dom"]["issues"]
        self.assertTrue(any(i.get("kind") == "js_main_thread_blocked" for i in issues))

    def test_navigate_aborts_immediately_when_cdp_dies(self) -> None:
        fake_cdp = mock.MagicMock()
        fake_cdp._ws = mock.MagicMock()
        fake_cdp._ws.closed = False
        fake_cdp._thread = None
        fake_cdp.call.return_value = {"frameId": "f1"}

        def die_on_eval(*_a, **_kw):
            fake_cdp._ws.closed = True
            raise browser_inspector.BrowserError("Соединение с браузером оборвалось")

        fake_cdp.evaluate.side_effect = die_on_eval
        sess = browser_inspector.BrowserSession(cdp=fake_cdp, width=1280, height=720)

        t0 = time.monotonic()
        with self.assertRaises(browser_inspector.BrowserError):
            sess.navigate("http://127.0.0.1:3000/", wait_ms=0)
        self.assertLess(time.monotonic() - t0, 0.5)

    def test_capture_screenshot_falls_back_to_from_surface_false_and_emits_granular_statuses(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            mgr = browser_inspector.BrowserSessionManager(sandbox_root=Path(tmp))
            fake_cdp = mock.MagicMock()
            fake_cdp._ws = mock.MagicMock()
            fake_cdp._ws.closed = False
            fake_cdp._thread = None

            def fake_call(method, params=None, **_kw):
                if method == "Page.captureScreenshot":
                    if params and params.get("fromSurface") is True:
                        raise browser_inspector.BrowserError("Браузер не ответил на Page.captureScreenshot за 4 с")
                    return {"data": "ZmFrZWpwZWc="}
                return {}

            fake_cdp.call.side_effect = fake_call
            fake_cdp.evaluate.return_value = "complete"
            fake_cdp.snapshot_telemetry.return_value = {
                "consoleMessages": [],
                "pageErrors": [],
                "failedRequests": [],
            }

            sess = browser_inspector.BrowserSession(cdp=fake_cdp, width=1440, height=900)
            mgr._sessions["default"] = sess
            statuses: list[str] = []

            with mock.patch.object(sess, "audit", return_value={"dom": {"url": "http://127.0.0.1:3000/", "issues": []}, "telemetry": {"consoleMessages": [], "pageErrors": [], "failedRequests": []}}):
                report, events = browser_inspector.execute_browse_action(
                    mgr,
                    {"action": "open", "url": "http://127.0.0.1:3000/"},
                    trust_level="full",
                    on_status=statuses.append,
                )

            self.assertIn("Открыта страница http://127.0.0.1:3000/", report)
            self.assertEqual(events[0]["preview"], "data:image/jpeg;base64,ZmFrZWpwZWc=")
            self.assertIn("Собираю DOM-метрики, анимации и ошибки консоли…", statuses)
            self.assertIn("Делаю скриншот страницы…", statuses)
            self.assertIn("Формирую отчёт по результатам осмотра…", statuses)

    def test_websocket_close_does_not_block_on_stuck_writer_lock(self) -> None:
        ws = browser_inspector._WebSocketClient.__new__(browser_inspector._WebSocketClient)
        ws._sock = mock.MagicMock()
        ws._write_lock = threading.Lock()
        ws._buf = bytearray()
        ws._assembled = bytearray()
        ws._assembling_text = False
        ws.closed = False
        ws._write_lock.acquire()

        t0 = time.monotonic()
        try:
            ws.close()
        finally:
            ws._write_lock.release()
        self.assertLess(time.monotonic() - t0, 0.8)
        self.assertTrue(ws.closed)
        ws._sock.shutdown.assert_called_once()
        ws._sock.close.assert_called_once()

    def test_launch_flags_include_win_occlusion_and_no_proxy_by_default(self) -> None:
        captured_cmds: list[list[str]] = []

        class FakeProc:
            pid = 12345
            returncode = None
            def poll(self): return None
            def terminate(self): pass
            def kill(self): pass
            def wait(self, timeout=None): return 0

        def fake_popen(cmd, **kwargs):
            captured_cmds.append(list(cmd))
            for arg in cmd:
                if arg.startswith("--user-data-dir="):
                    ud = Path(arg.split("=", 1)[1])
                    (ud / "DevToolsActivePort").write_text("45678\n/devtools/browser/abc\n", encoding="utf-8")
            return FakeProc()

        with (
            mock.patch.dict(os.environ, {}, clear=True),
            mock.patch.object(browser_inspector.platform, "system", return_value="Windows"),
            mock.patch.object(browser_inspector.subprocess, "Popen", side_effect=fake_popen),
        ):
            proc, user_data, port = browser_inspector._launch_headless_chromium("C:\\chrome.exe", 1280, 720)
        import shutil as _sh
        _sh.rmtree(user_data, ignore_errors=True)

        self.assertEqual(port, 45678)
        cmd0 = captured_cmds[0]
        self.assertIn("--no-proxy-server", cmd0)
        self.assertIn("--disable-renderer-accessibility", cmd0)
        self.assertNotIn("--disable-gpu", cmd0)
        features_arg = next(a for a in cmd0 if a.startswith("--disable-features="))
        self.assertIn("CalculateNativeWinOcclusion", features_arg)

    def test_run_agent_emits_browse_project_live_status_events(self) -> None:
        sse_frames: list[str] = []

        class CollectingWriter:
            def write(self, data: bytes) -> int:
                sse_frames.append(data.decode("utf-8", errors="replace"))
                return len(data)

            def flush(self) -> None:
                pass

        h = agent_mod.Handler.__new__(agent_mod.Handler)
        h.wfile = CollectingWriter()  # type: ignore[assignment]
        h._client_disconnected = False

        calls = {"n": 0}

        def fake_call_model(*_args, **_kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                return {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "call_b1",
                                        "type": "function",
                                        "function": {
                                            "name": "browse_project",
                                            "arguments": json.dumps({"action": "open", "url": "http://127.0.0.1:8123"}),
                                        },
                                    }
                                ],
                            }
                        }
                    ]
                }
            return {"choices": [{"message": {"role": "assistant", "content": "Готово, страница проверена."}}]}

        def fake_execute_browse(mgr, args, *, trust_level="verified", approval_fn=None, on_status=None, cancel_check=None):
            if on_status:
                on_status("Запускаю headless-браузер…")
                on_status("Открываю страницу http://127.0.0.1:8123…")
            self.assertTrue(callable(cancel_check))
            return "Интерактивный осмотр проекта (open): OK", [
                {"type": "browser_inspect", "action": "open", "url": "http://127.0.0.1:8123", "summary": "ok"}
            ]

        with (
            mock.patch.object(agent_mod, "call_model", side_effect=fake_call_model),
            mock.patch.object(browser_inspector, "execute_browse_action", side_effect=fake_execute_browse),
        ):
            h.run_agent(
                {
                    "messages": [{"role": "user", "content": "проверь сайт"}],
                    "model": "test-model",
                    "baseUrl": "http://127.0.0.1:8888/v1",
                    "trustLevel": "verified",
                }
            )

        joined = "".join(sse_frames)
        self.assertIn("Запускаю headless-браузер…", joined)
        self.assertIn("Открываю страницу http://127.0.0.1:8123…", joined)
        self.assertIn("Готово, страница проверена.", joined)
        self.assertIn('"source": "browser_inspector"', joined)

    def test_run_agent_emits_browser_inspect_error_card_with_trace_on_failure(self) -> None:
        sse_frames: list[str] = []

        class CollectingWriter:
            def write(self, data: bytes) -> int:
                sse_frames.append(data.decode("utf-8", errors="replace"))
                return len(data)

            def flush(self) -> None:
                pass

        h = agent_mod.Handler.__new__(agent_mod.Handler)
        h.wfile = CollectingWriter()  # type: ignore[assignment]
        h._client_disconnected = False

        calls = {"n": 0}

        def fake_call_model(*_args, **_kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                return {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "call_b_err",
                                        "type": "function",
                                        "function": {
                                            "name": "browse_project",
                                            "arguments": json.dumps({"action": "open", "url": "http://127.0.0.1:8123"}),
                                        },
                                    }
                                ],
                            }
                        }
                    ]
                }
            return {"choices": [{"message": {"role": "assistant", "content": "Браузер упал при старте."}}]}

        def failing_browse(_mgr, _args, **_kw):
            raise browser_inspector.BrowserError(
                "Не удалось запустить Chromium (код 2147483651)",
                trace=["[+0.01s] Ищу браузер…", "[+0.12s] Попытка 1/3 упала"],
            )

        with (
            mock.patch.object(agent_mod, "call_model", side_effect=fake_call_model),
            mock.patch.object(browser_inspector, "execute_browse_action", side_effect=failing_browse),
        ):
            h.run_agent(
                {
                    "messages": [{"role": "user", "content": "проверь сайт"}],
                    "model": "test-model",
                    "baseUrl": "http://127.0.0.1:8888/v1",
                    "trustLevel": "verified",
                }
            )

        joined = "".join(sse_frames)
        self.assertIn('"type": "browser_inspect"', joined)
        self.assertIn("Не удалось запустить Chromium", joined)
        self.assertIn("[+0.12s] Попытка 1/3 упала", joined)

    def test_launch_windows_retries_swiftshader_then_no_sandbox_and_reads_debug_log(self) -> None:
        captured_cmds: list[list[str]] = []

        class DeadProc:
            pid = 222
            returncode = 1
            def poll(self): return 1
            def terminate(self): pass
            def kill(self): pass
            def wait(self, timeout=None): return 1

        class AliveProc:
            pid = 333
            returncode = None
            def poll(self): return None
            def terminate(self): pass
            def kill(self): pass
            def wait(self, timeout=None): return 0

        def fake_popen(cmd, **kwargs):
            captured_cmds.append(list(cmd))
            attempt = len(captured_cmds)
            ud = Path(next(a for a in cmd if a.startswith("--user-data-dir=")).split("=", 1)[1])
            if attempt in (1, 2):
                (ud / "chrome_debug.log").write_text(f"[ERR] attempt {attempt} gpu crash\n", encoding="utf-8")
                return DeadProc()
            (ud / "DevToolsActivePort").write_text("49123\n/devtools/browser/xyz\n", encoding="utf-8")
            return AliveProc()

        trace_lines: list[str] = []
        with (
            mock.patch.dict(os.environ, {}, clear=True),
            mock.patch.object(browser_inspector.platform, "system", return_value="Windows"),
            mock.patch.object(browser_inspector.subprocess, "Popen", side_effect=fake_popen),
        ):
            proc, user_data, port = browser_inspector._launch_headless_chromium(
                "C:\\msedge.exe", 1280, 720, trace=trace_lines, started_at=0.0
            )
        import shutil as _sh
        _sh.rmtree(user_data, ignore_errors=True)

        self.assertEqual(port, 49123)
        self.assertEqual(len(captured_cmds), 3)
        self.assertNotIn("--disable-gpu", captured_cmds[0])
        self.assertIn("--disable-gpu", captured_cmds[1])
        self.assertIn("--use-angle=swiftshader", captured_cmds[1])
        self.assertIn("--no-sandbox", captured_cmds[2])
        self.assertIn("--disable-gpu-sandbox", captured_cmds[2])
        self.assertTrue(any("Попытка 1 завершилась с ошибкой" in line for line in trace_lines))

        # Если упали все попытки, chrome_debug.log попадает в сообщение BrowserError.
        def always_dead(cmd, **kwargs):
            ud = Path(next(a for a in cmd if a.startswith("--user-data-dir=")).split("=", 1)[1])
            (ud / "chrome_debug.log").write_text("FATAL: gpu_process_host failed on Windows\n", encoding="utf-8")
            return DeadProc()

        with (
            mock.patch.dict(os.environ, {}, clear=True),
            mock.patch.object(browser_inspector.platform, "system", return_value="Windows"),
            mock.patch.object(browser_inspector.subprocess, "Popen", side_effect=always_dead),
        ):
            with self.assertRaises(browser_inspector.BrowserError) as ctx:
                browser_inspector._launch_headless_chromium("C:\\chrome.exe", 1280, 720)
        self.assertIn("gpu_process_host failed on Windows", str(ctx.exception))

    def test_browser_session_launch_falls_back_to_next_browser_and_network_enable(self) -> None:
        launched_exes: list[str] = []
        cdp_calls: list[str] = []

        class DummyProc:
            pid = 555
            def poll(self): return None
            def terminate(self): pass
            def kill(self): pass
            def wait(self, timeout=None): return 0

        class FakeCDP:
            def __init__(self, ws_url: str) -> None:
                self.ws_url = ws_url
                self._ws = mock.Mock(closed=False)
                self._thread = mock.Mock()
                self._thread.is_alive.return_value = True

            def call(self, method: str, params=None, timeout=10.0, cancel_check=None):
                cdp_calls.append(f"{self.ws_url}:{method}:{bool(params)}")
                if "broken" in self.ws_url and method == "Page.enable":
                    raise browser_inspector.BrowserError("Page.enable hung")
                if method == "Network.enable" and params:
                    raise browser_inspector.BrowserError("Invalid parameters")
                return {}

            def close(self) -> None:
                self._ws.closed = True

        def fake_launch(exe, _w, _h, **_kw):
            launched_exes.append(exe)
            ud = Path(tempfile.mkdtemp(prefix="bi_test_"))
            return DummyProc(), ud, (1111 if "chrome" in exe else 2222)

        def fake_find_ws(port, **_kw):
            return "ws://127.0.0.1:1111/broken" if port == 1111 else "ws://127.0.0.1:2222/good"

        with (
            mock.patch.object(browser_inspector, "find_browser_executable", return_value="C:\\chrome.exe"),
            mock.patch.object(
                browser_inspector,
                "find_browser_candidates",
                return_value=["C:\\chrome.exe", "C:\\msedge.exe"],
            ),
            mock.patch.object(browser_inspector, "_launch_headless_chromium", side_effect=fake_launch),
            mock.patch.object(browser_inspector, "_find_page_ws_url", side_effect=fake_find_ws),
            mock.patch.object(browser_inspector, "CDPClient", side_effect=FakeCDP),
            mock.patch.object(browser_inspector.platform, "system", return_value="Linux"),
        ):
            sess = browser_inspector.BrowserSession.launch(1280, 800)
            sess.close()

        self.assertEqual(launched_exes, ["C:\\chrome.exe", "C:\\msedge.exe"])
        self.assertIn("ws://127.0.0.1:2222/good:Network.enable:True", cdp_calls)
        self.assertIn("ws://127.0.0.1:2222/good:Network.enable:False", cdp_calls)


class WindowsCompatibilityAndSpecTests(unittest.TestCase):
    def test_code_tools_windows_cmd_bin_and_python_bin(self) -> None:
        py_bin = code_tools._pick_python_bin()
        self.assertIsNotNone(py_bin)
        assert py_bin is not None
        self.assertTrue(Path(py_bin[0]).exists())

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bin_dir = root / "node_modules" / ".bin"
            bin_dir.mkdir(parents=True)
            tsc_cmd = bin_dir / "tsc.cmd"
            tsc_cmd.write_text("@echo off\r\n", encoding="utf-8")
            with mock.patch("platform.system", return_value="Windows"):
                picked = code_tools._pick_tool_bin(root, "tsc")
                self.assertEqual(picked, ["cmd", "/c", str(tsc_cmd)])

    def test_qa_detect_test_commands_does_not_hardcode_bare_python3_on_windows_style_sys_exe(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            proj = Path(tmp)
            (proj / "test_demo.py").write_text("import unittest\n", encoding="utf-8")
            cmds = qa_tools._detect_test_commands(proj)
            self.assertTrue(cmds)
            self.assertIn(sys.executable, cmds[0][1])

    def test_launcher_spec_includes_code_tools_and_qa_tools(self) -> None:
        spec_text = (REPO_ROOT / "launcher" / "launcher.spec").read_text(encoding="utf-8")
        self.assertIn("code_tools.py", spec_text)
        self.assertIn("qa_tools.py", spec_text)

    def test_health_does_not_spawn_subprocess_and_frozen_skips_playwright_cli(self) -> None:
        import shutil
        import urllib.request

        with (
            mock.patch.object(shutil, "which", return_value=None),
            mock.patch.object(browser_inspector, "_safe_is_file", return_value=False),
            mock.patch.object(browser_inspector, "_safe_is_dir", return_value=False),
            mock.patch.object(browser_inspector, "_safe_glob", return_value=[]),
            mock.patch("subprocess.run", side_effect=AssertionError("subprocess.run must not be called")) as sub_mock,
        ):
            self.assertIsNone(browser_inspector.find_browser_executable(allow_subprocess=False))
            with mock.patch.object(sys, "frozen", True, create=True):
                self.assertIsNone(browser_inspector.find_browser_executable(allow_subprocess=True))

            with (
                mock.patch.object(browser_inspector, "_BROWSER_AVAIL_CACHE", (0.0, False)),
                mock.patch.object(agent_mod, "log"),
            ):
                srv = agent_mod.Server(("127.0.0.1", 0), agent_mod.Handler)
                port = srv.server_address[1]
                th = threading.Thread(target=srv.serve_forever, daemon=True)
                th.start()
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=3.0) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                    self.assertEqual(resp.status, 200)
                    self.assertTrue(data["ok"])
                    self.assertIn("browserAvailable", data)
                finally:
                    srv.shutdown()
                    srv.server_close()
                    th.join(timeout=2)
            sub_mock.assert_not_called()

    def test_desktop_operator_and_crm_client_bypass_proxy_for_loopback(self) -> None:
        import desktop_operator as op_mod
        from launcher import crm_client

        class FakeResp:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self): return b'{"ok":true}'

        with (
            mock.patch.object(op_mod._NO_REDIRECT_LOCAL_OPENER, "open", return_value=FakeResp()) as local_op,
            mock.patch.object(op_mod._NO_REDIRECT_OPENER, "open", side_effect=AssertionError("used proxy opener")),
        ):
            res = op_mod.Http("http://127.0.0.1:3000", token="crmop_123").call("GET", "/api/agent/bot/whoami")
            self.assertTrue(res["ok"])
            local_op.assert_called_once()

        with (
            mock.patch.object(crm_client._NO_REDIRECT_LOCAL_OPENER, "open", return_value=FakeResp()) as local_crm,
            mock.patch.object(crm_client._NO_REDIRECT_OPENER, "open", side_effect=AssertionError("used proxy opener")),
        ):
            status, data = crm_client._request_json("GET", "http://localhost:3000/api/health")
            self.assertEqual(status, 200)
            self.assertTrue(data["ok"])
            local_crm.assert_called_once()

    def test_broken_stdout_does_not_cause_empty_http_response(self) -> None:
        import urllib.request

        class BrokenStdout:
            encoding = "utf-8"
            def write(self, _s: str) -> int:
                raise BrokenPipeError("broken stdout pipe")
            def flush(self) -> None:
                raise BrokenPipeError("broken stdout pipe")

        srv = agent_mod.Server(("127.0.0.1", 0), agent_mod.Handler)
        port = srv.server_address[1]
        th = threading.Thread(target=srv.serve_forever, daemon=True)
        th.start()
        try:
            with mock.patch.object(sys, "stdout", BrokenStdout()):
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=3.0) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
                self.assertEqual(resp.status, 200)
                self.assertTrue(body["ok"])
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/favicon.ico", timeout=3.0) as fav:
                    self.assertEqual(fav.status, 204)
        finally:
            srv.shutdown()
            srv.server_close()
            th.join(timeout=2)

    def test_launcher_bundle_preserves_windows_browser_env_keys(self) -> None:
        from launcher import bundle

        for key in (
            "PROGRAMW6432",
            "SYSTEMDRIVE",
            "PROCESSOR_ARCHITECTURE",
            "PLAYWRIGHT_BROWSERS_PATH",
            "AGENT_BROWSER_PATH",
            "CHROME_PATH",
            "CHROME_BIN",
            "EDGE_PATH",
            "PUPPETEER_EXECUTABLE_PATH",
        ):
            self.assertIn(key, bundle.SAFE_CHILD_ENV_KEYS)

    def test_qa_browser_audit_always_closes_session_when_external_manager_passed(self) -> None:
        import qa_tools
        import sandbox as sandbox_mod

        with tempfile.TemporaryDirectory() as tmp:
            root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            sandbox_mod.write_file(root, "app/index.html", "<!doctype html><h1>Hi</h1>")
            mgr = browser_inspector.BrowserSessionManager(sandbox_root=root)
            preexisting = mock.MagicMock()
            preexisting.is_alive.return_value = True
            mgr._sessions["agent_keep"] = preexisting

            seen_session_ids: list[str] = []
            closed_session_ids: list[str] = []
            statuses: list[str] = []

            def fake_exec(m, args, **_kw):
                sid = str(args.get("session_id"))
                seen_session_ids.append(sid)
                if sid not in m._sessions:
                    sess = mock.MagicMock()
                    sess.is_alive.return_value = True
                    m._sessions[sid] = sess
                act = str(args.get("action"))
                return f"Осмотр ({act}): OK", [
                    {
                        "type": "browser_inspect",
                        "action": act,
                        "viewport": "1440×900" if act == "open" else "390×844",
                        "errorsCount": 0,
                        "issuesCount": 0,
                        "_images": ["data:image/jpeg;base64,AAA"],
                        "preview": "data:image/jpeg;base64,AAA",
                    }
                ]

            orig_close_session = mgr.close_session

            def spy_close_session(sid: str) -> bool:
                closed_session_ids.append(sid)
                return orig_close_session(sid)

            checks_sink: list[dict] = []
            with (
                mock.patch.object(browser_inspector, "execute_browse_action", side_effect=fake_exec),
                mock.patch.object(mgr, "close_session", side_effect=spy_close_session),
            ):
                txt, evs = qa_tools.run_qa_tool(
                    "qa_browser_audit",
                    {"sandbox_project": "app"},
                    trust_level="verified",
                    sandbox_root=root,
                    browser_manager=mgr,
                    checks_sink=checks_sink,
                    on_status=statuses.append,
                )

            self.assertEqual(len(seen_session_ids), 2)
            self.assertEqual(seen_session_ids[0], seen_session_ids[1])
            audit_sid = seen_session_ids[0]
            self.assertIn(audit_sid, closed_session_ids)
            # Сессия самого аудита закрыта, а сторонняя сессия Агента осталась нетронутой.
            self.assertNotIn(audit_sid, mgr._sessions)
            self.assertIn("agent_keep", mgr._sessions)
            self.assertTrue(any("завершён" in s and "передаю отчёт" in s for s in statuses))
            self.assertIn("Viewport: desktop", txt)
            self.assertIn("Viewport: mobile", txt)
            self.assertEqual(len(evs), 2)

    def test_run_agent_emits_browser_done_handoff_and_handles_multimodal_rejection(self) -> None:
        sse_frames: list[str] = []

        class CollectingWriter:
            def write(self, data: bytes) -> int:
                sse_frames.append(data.decode("utf-8", errors="replace"))
                return len(data)

            def flush(self) -> None:
                pass

        h = agent_mod.Handler.__new__(agent_mod.Handler)
        h.wfile = CollectingWriter()  # type: ignore[assignment]
        h._client_disconnected = False

        calls: list[list[dict]] = []

        def fake_call_model(_base_url, _api_key, _model, messages, *_args, **_kwargs):
            calls.append(json.loads(json.dumps(messages)))
            step_idx = len(calls)
            if step_idx == 1:
                return {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "call_b_click",
                                        "type": "function",
                                        "function": {
                                            "name": "browse_project",
                                            "arguments": json.dumps({"action": "click", "text": "Войти"}),
                                        },
                                    }
                                ],
                            }
                        }
                    ]
                }
            if step_idx == 2:
                # Имитируем ошибку не-vision модели с формулировкой без слов image/vision.
                raise agent_mod.AgentError("HTTP 400: content must be a string (mmproj not loaded)")
            return {"choices": [{"message": {"role": "assistant", "content": "Клик проверен, проблем нет."}}]}

        def fake_browse(_mgr, _args, **_kw):
            return "Интерактивный осмотр проекта (click): OK", [
                {
                    "type": "browser_inspect",
                    "action": "click",
                    "url": "http://127.0.0.1:8123",
                    "summary": "анимаций: 20, проблем: 0, ошибок: 0",
                    "_images": ["data:image/jpeg;base64,AAA"],
                    "preview": "data:image/jpeg;base64,AAA",
                }
            ]

        with (
            mock.patch.object(agent_mod, "call_model", side_effect=fake_call_model),
            mock.patch.object(browser_inspector, "execute_browse_action", side_effect=fake_browse),
            mock.patch.object(browser_inspector, "_browser_log") as log_mock,
        ):
            h.run_agent(
                {
                    "messages": [{"role": "user", "content": "проверь клик"}],
                    "model": "text-only-model",
                    "baseUrl": "http://127.0.0.1:8888/v1",
                    "trustLevel": "verified",
                }
            )

        joined = "".join(sse_frames)
        self.assertIn('"done": true', joined)
        self.assertIn("Клик проверен, проблем нет.", joined)
        self.assertTrue(any("передаю отчёт Агенту" in str(c.args[0]) for c in log_mock.call_args_list))
        # На 3-м вызове картинки уже вырезаны после ошибки mmproj/content must be a string.
        self.assertEqual(agent_mod._count_message_images(calls[-1]), 0)

    def test_execute_browse_action_close_after_closes_session_immediately(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            mgr = browser_inspector.BrowserSessionManager(sandbox_root=Path(tmp))
            fake_sess = mock.MagicMock()
            fake_sess.is_alive.return_value = True
            fake_sess.width = 1440
            fake_sess.height = 900
            fake_sess.current_url = "http://127.0.0.1:8123/"
            fake_sess.audit.return_value = {
                "dom": {
                    "url": "http://127.0.0.1:8123/",
                    "title": "Test",
                    "viewport": {"width": 1440, "height": 900},
                    "scroll": {"x": 0, "y": 0, "width": 1440, "height": 900},
                    "issues": [],
                    "webAnimations": [],
                    "cssAnimatedElements": [],
                    "interactive": [],
                    "keyframes": [],
                    "reducedMotion": False,
                },
                "telemetry": {"consoleMessages": [], "pageErrors": [], "failedRequests": []},
            }
            fake_sess.capture_screenshot.return_value = ""
            mgr._sessions["s1"] = fake_sess

            statuses: list[str] = []
            report, _evs = browser_inspector.execute_browse_action(
                mgr,
                {"action": "click", "x": 10, "y": 10, "session_id": "s1", "close_after": True, "wait_ms": 0},
                trust_level="verified",
                on_status=statuses.append,
            )
            self.assertIn("Интерактивный осмотр проекта (click)", report)
            self.assertNotIn("s1", mgr._sessions)
            fake_sess.close.assert_called_once()
            self.assertTrue(any("закрыта после шага «click»" in s for s in statuses))


if __name__ == "__main__":
    unittest.main()
