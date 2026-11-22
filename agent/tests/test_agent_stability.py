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
                with mock.patch("sys.stderr", err_buf):
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

        with mock.patch.object(agent_mod, "_safe_model_urlopen", side_effect=fake_urlopen), mock.patch("time.sleep"):
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

            with mock.patch.object(browser_inspector, "_BROWSER_AVAIL_CACHE", (0.0, False)):
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


if __name__ == "__main__":
    unittest.main()
