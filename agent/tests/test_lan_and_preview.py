from __future__ import annotations

import http.server
import os
import socket
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENT_DIR.parent
for p in (str(AGENT_DIR), str(REPO_ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)

import agent as agent_mod  # noqa: E402
import browser_inspector  # noqa: E402
import sandbox as sandbox_mod  # noqa: E402
from launcher import crm_client  # noqa: E402


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        return None


class LanAndPreviewTests(unittest.TestCase):
    def test_launcher_crm_client_supports_lan_http_and_blocks_public_http(self) -> None:
        self.assertEqual(crm_client.normalize_server_url("192.168.1.50:3000/"), "http://192.168.1.50:3000")
        self.assertEqual(crm_client.normalize_server_url("10.0.0.8:3000"), "http://10.0.0.8:3000")
        self.assertEqual(crm_client.normalize_server_url("crm-box.local:3000"), "http://crm-box.local:3000")
        self.assertEqual(crm_client.normalize_server_url("crm.example.com/"), "https://crm.example.com")

        crm_client._assert_safe_crm_transport("http://192.168.1.50:3000/api/health")
        crm_client._assert_safe_crm_transport("http://crm-box.local:3000/api/health")
        for blocked in (
            "http://crm.example.com/api/health",
            "http://169.254.169.254/latest/meta-data/",
            "http://0.0.0.0:3000/api/health",
        ):
            with self.assertRaises(crm_client.CrmClientError):
                crm_client._assert_safe_crm_transport(blocked)

    def test_cors_allows_lan_only_when_agent_host_is_non_loopback(self) -> None:
        prev_host = os.environ.get("AGENT_HOST")
        prev_crm_url = os.environ.get("CRM_SERVER_URL")
        try:
            os.environ["AGENT_HOST"] = "127.0.0.1"
            self.assertIsNone(agent_mod._allowed_cors_origin("http://192.168.1.50:3000"))

            os.environ["AGENT_HOST"] = "0.0.0.0"
            self.assertEqual(
                agent_mod._allowed_cors_origin("http://192.168.1.50:3000/"),
                "http://192.168.1.50:3000",
            )
            self.assertIsNone(agent_mod._allowed_cors_origin("https://evil.example.com"))

            os.environ["CRM_SERVER_URL"] = "https://crm.internal.corp:8443"
            self.assertEqual(
                agent_mod._allowed_cors_origin("https://crm.internal.corp:8443"),
                "https://crm.internal.corp:8443",
            )
        finally:
            if prev_host is None:
                os.environ.pop("AGENT_HOST", None)
            else:
                os.environ["AGENT_HOST"] = prev_host
            if prev_crm_url is None:
                os.environ.pop("CRM_SERVER_URL", None)
            else:
                os.environ["CRM_SERVER_URL"] = prev_crm_url

    def test_sandbox_process_list_sets_alive_and_detects_ipv6_url(self) -> None:
        url = sandbox_mod._detect_local_url("", "Server listening on http://[::1]:5173/")
        self.assertEqual(url, "http://127.0.0.1:5173")
        self.assertEqual(sandbox_mod.extract_port_from_url(url), 5173)

    def test_browser_inspector_local_url_and_dist_static_server(self) -> None:
        self.assertTrue(browser_inspector.is_local_url("http://192.168.1.50:3000"))
        self.assertTrue(browser_inspector.is_local_url("http://10.20.0.5:8080"))
        self.assertTrue(browser_inspector.is_local_url("http://dev-pc.local:3000"))
        self.assertFalse(browser_inspector.is_local_url("http://169.254.169.254/"))
        self.assertFalse(browser_inspector.is_local_url("https://example.com"))

        with tempfile.TemporaryDirectory() as tmp:
            sb_root = Path(tmp)
            dist = sb_root / "viteapp" / "dist"
            (dist / "assets").mkdir(parents=True)
            (dist / "index.html").write_text("<html><script src='/assets/main.js'></script></html>", encoding="utf-8")
            (dist / "assets" / "main.js").write_text("console.log('ok');", encoding="utf-8")

            srv = browser_inspector.StaticSandboxServer(sb_root, "viteapp")
            try:
                base = srv.url.rsplit("/", 1)[0]
                with urllib.request.urlopen(f"{base}/assets/main.js", timeout=3) as resp:
                    self.assertEqual(resp.status, 200)
                    self.assertIn("console.log('ok')", resp.read().decode("utf-8"))
            finally:
                srv.close()

    def test_websocket_mid_frame_timeout_raises_eof_not_timeout(self) -> None:
        class _HangingSock:
            def recv(self, _n: int) -> bytes:
                raise TimeoutError("timed out")

        ws = browser_inspector._WebSocketClient.__new__(browser_inspector._WebSocketClient)
        ws.closed = False
        ws._sock = _HangingSock()
        ws._buf = bytearray(b"\x81")
        ws._assembled = bytearray()
        ws._assembling_text = False
        ws._write_lock = threading.Lock()

        orig_monotonic = browser_inspector.time.monotonic
        ticks = iter([0.0, 25.0, 26.0])
        browser_inspector.time.monotonic = lambda: next(ticks, 30.0)
        try:
            with self.assertRaises(EOFError):
                ws._read_exact(2, continuation=False)
        finally:
            browser_inspector.time.monotonic = orig_monotonic

    def test_agent_sandbox_preview_and_proxy_endpoints(self) -> None:
        class _DummyAppHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                body = f"proxied:{self.path}".encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args) -> None:  # noqa: A002, ANN002
                pass

        with tempfile.TemporaryDirectory() as tmp:
            sb_root = Path(tmp) / "sandbox"
            sb_root.mkdir()
            (sb_root / "plain").mkdir()
            (sb_root / "plain" / "index.html").write_text("<h1>Hello Sandbox</h1>", encoding="utf-8")
            (sb_root / "vite" / "dist" / "assets").mkdir(parents=True)
            (sb_root / "vite" / "dist" / "index.html").write_text("<h1>Vite Dist</h1>", encoding="utf-8")
            (sb_root / "vite" / "dist" / "assets" / "app.js").write_text("window.OK=1;", encoding="utf-8")
            (sb_root / "rawdir").mkdir()
            (sb_root / "rawdir" / "bad<script>.txt").write_text("hi", encoding="utf-8")

            app_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _DummyAppHandler)
            app_port = app_srv.server_address[1]
            threading.Thread(target=app_srv.serve_forever, daemon=True).start()

            prev_sb = agent_mod.SANDBOX_ROOT
            prev_allowed = agent_mod.PROCESS_MANAGER.allowed_ports
            agent_mod.SANDBOX_ROOT = sb_root
            agent_mod.PROCESS_MANAGER.allowed_ports = lambda: {app_port}  # type: ignore[method-assign]

            agent_srv = agent_mod.Server(("127.0.0.1", 0), agent_mod.Handler)
            agent_port = agent_srv.server_address[1]
            threading.Thread(target=agent_srv.serve_forever, daemon=True).start()

            unauth_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)
            opener.addheaders = [("Authorization", f"Bearer {agent_srv._http_token}")]
            try:
                base = f"http://127.0.0.1:{agent_port}"
                # 0. Без токена доступ к /sandbox/preview закрыт (401)
                with self.assertRaises(urllib.error.HTTPError) as unauth_err:
                    unauth_opener.open(f"{base}/sandbox/preview/plain", timeout=3)
                self.assertEqual(unauth_err.exception.code, 401)

                # 1. Directory with index.html returns 302 to .../index.html
                try:
                    req = urllib.request.Request(
                        f"{base}/sandbox/preview/plain",
                        headers={"X-Sandbox-Prefix": "/api/ai/agent/sandbox/preview"},
                    )
                    resp = opener.open(req, timeout=3)
                    status = resp.status
                    loc = resp.headers.get("Location")
                except urllib.error.HTTPError as err:
                    status = err.code
                    loc = err.headers.get("Location")
                self.assertEqual(status, 302)
                self.assertEqual(loc, "/api/ai/agent/sandbox/preview/plain/index.html")

                # 2. Vite dist fallback serves dist/index.html and dist/assets/app.js
                with opener.open(f"{base}/sandbox/preview/vite/index.html", timeout=3) as r:
                    self.assertEqual(r.status, 200)
                    self.assertIn("Vite Dist", r.read().decode("utf-8"))
                with opener.open(f"{base}/sandbox/preview/vite/assets/app.js", timeout=3) as r:
                    self.assertEqual(r.status, 200)
                    self.assertIn("application/javascript", r.headers.get("Content-Type", ""))
                    self.assertIn("window.OK=1", r.read().decode("utf-8"))

                # 3. Directory without index.html renders escaped file listing
                with opener.open(f"{base}/sandbox/preview/rawdir", timeout=3) as r:
                    html_txt = r.read().decode("utf-8")
                    self.assertIn("bad&lt;script&gt;.txt", html_txt)
                    self.assertNotIn("bad<script>.txt", html_txt)

                # 4. Path traversal rejected
                with self.assertRaises(urllib.error.HTTPError) as ctx_err:
                    opener.open(f"{base}/sandbox/preview/../etc/passwd", timeout=3)
                self.assertEqual(ctx_err.exception.code, 403)

                # 5. Proxy blocks non-Sandbox ports (SSRF guard) and allows active Sandbox port
                with self.assertRaises(urllib.error.HTTPError) as proxy_err:
                    opener.open(f"{base}/sandbox/proxy/5432/", timeout=3)
                self.assertEqual(proxy_err.exception.code, 403)

                with opener.open(f"{base}/sandbox/proxy/{app_port}/hello?x=1", timeout=3) as r:
                    self.assertEqual(r.status, 200)
                    self.assertEqual(r.read().decode("utf-8"), "proxied:/hello?x=1")
            finally:
                agent_srv.shutdown()
                agent_srv.server_close()
                app_srv.shutdown()
                app_srv.server_close()
                agent_mod.SANDBOX_ROOT = prev_sb
                agent_mod.PROCESS_MANAGER.allowed_ports = prev_allowed  # type: ignore[method-assign]


if __name__ == "__main__":
    unittest.main()
