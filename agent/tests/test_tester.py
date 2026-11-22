from __future__ import annotations

import http.server
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

AGENT_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENT_DIR.parent
for p in (str(AGENT_DIR), str(REPO_ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)

import agent as agent_mod  # noqa: E402
import qa_tools  # noqa: E402
import sandbox as sandbox_mod  # noqa: E402


class _MiniHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            body = b'{"status":"ok"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = (
            b"<!doctype html><html><head><title>QA Test App</title></head>"
            b"<body><h1>Hello QA</h1><script src='/app.js'></script></body></html>"
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return


class QaToolsTests(unittest.TestCase):
    def test_qa_static_review_detects_syntax_errors_and_healthy_project(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            sandbox_mod.write_file(root, "bad_app/main.py", "def broken(:\n    pass\n")
            sandbox_mod.write_file(root, "bad_app/bad.json", "{bad json")

            bad = qa_tools.run_qa_static_review(root, "bad_app")
            self.assertGreater(len(bad["criticalIssues"]), 0)

            sandbox_mod.write_file(root, "good_app/main.py", "def add(a: int, b: int) -> int:\n    return a + b\n")
            sandbox_mod.write_file(root, "good_app/index.html", "<!doctype html><title>App</title><h1>Hi</h1>")
            good = qa_tools.run_qa_static_review(root, "good_app")
            self.assertEqual(len(good["criticalIssues"]), 0)

    def test_qa_http_audit_blocks_metadata_ssrf_and_checks_local_server(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            for bad_url in (
                "http://169.254.169.254/latest/meta-data/",
                "http://metadata.google.internal/",
                "file:///etc/passwd",
            ):
                with self.assertRaises(qa_tools.QaToolError):
                    qa_tools.run_qa_http_audit(root, base_url=bad_url)

            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _MiniHandler)
            port = server.server_address[1]
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                res = qa_tools.run_qa_http_audit(root, base_url=f"http://127.0.0.1:{port}/", routes=["/", "/health"])
                self.assertEqual(res["failedCount"], 0)
                self.assertEqual(len(res["results"]), 2)
                self.assertTrue(res["results"][0]["ok"])
                self.assertEqual(res["results"][0]["status"], 200)
            finally:
                server.shutdown()
                server.server_close()

    def test_qa_run_tests_and_submit_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            sandbox_mod.write_file(root, "proj/test_math.py", "assert 2 + 2 == 4\n")

            txt, events = qa_tools.run_qa_tool(
                "qa_run_tests",
                {"sandbox_project": "proj", "command": "python3 test_math.py"},
                sandbox_root=root,
                trust_level="full",
                approval_fn=None,
            )
            self.assertIn("код 0", txt)
            self.assertEqual(events[0]["exitCode"], 0)

            report_sink: dict = {}
            out_txt, out_evs = qa_tools.run_qa_tool(
                "qa_submit_report",
                {
                    "status": "minor_issues",
                    "summary": "Есть мелкое замечание по тексту",
                    "critical_issues": [],
                    "minor_issues": [{"title": "Опечатка в кнопке", "file": "index.html", "line": 8}],
                    "checks_run": [{"name": "test_math", "status": "pass", "details": "OK"}],
                },
                sandbox_root=root,
                trust_level="full",
                report_sink=report_sink,
            )
            self.assertIn("minor_issues", out_txt)
            self.assertEqual(report_sink["status"], "minor_issues")
            self.assertEqual(len(report_sink["minorIssues"]), 1)
            self.assertEqual(out_evs[0]["type"], "qa_check")


class TesterAgentOrchestrationTests(unittest.TestCase):
    def test_tool_separation_between_agent_and_tester_roles(self) -> None:
        agent_tool_names = {t["function"]["name"] for t in agent_mod.tools_for_trust("full", role="agent")}
        tester_tool_names = {t["function"]["name"] for t in agent_mod.tools_for_trust("full", role="tester")}

        self.assertIn("call_tester", agent_tool_names)
        self.assertIn("confirm_minor_fixes", agent_tool_names)
        self.assertIn("list_tester_reports", agent_tool_names)
        self.assertNotIn("qa_static_review", agent_tool_names)
        self.assertNotIn("qa_submit_report", agent_tool_names)

        self.assertIn("qa_static_review", tester_tool_names)
        self.assertIn("qa_run_tests", tester_tool_names)
        self.assertIn("qa_http_audit", tester_tool_names)
        self.assertIn("qa_browser_audit", tester_tool_names)
        self.assertIn("qa_submit_report", tester_tool_names)
        self.assertNotIn("call_tester", tester_tool_names)
        self.assertNotIn("confirm_minor_fixes", tester_tool_names)

    def test_call_tester_and_confirm_minor_fixes_orchestration(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            sandbox_mod.write_file(root, "demo/index.html", "<!doctype html><title>Demo</title><h1>Hi</h1>")
            events: list[tuple[str, dict]] = []
            approval_requests: list[dict] = []

            def fake_approval(req: dict) -> dict:
                approval_requests.append(req)
                if req.get("kind") == "tester_minor_fixes":
                    return {"approved": True, "note": "Можно добавить favicon"}
                return {"approved": True}

            fake_replies = iter(
                [
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "reasoning_content": "Проверяю структуру проекта demo",
                                    "tool_calls": [
                                        {
                                            "id": "tc1",
                                            "function": {
                                                "name": "qa_static_review",
                                                "arguments": '{"sandbox_project":"demo"}',
                                            },
                                        }
                                    ],
                                }
                            }
                        ],
                        "usage": {"prompt_tokens": 60, "completion_tokens": 25, "total_tokens": 85},
                    },
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "reasoning_content": "Отправляю отчёт с мелким замечанием",
                                    "tool_calls": [
                                        {
                                            "id": "tc2",
                                            "function": {
                                                "name": "qa_submit_report",
                                                "arguments": (
                                                    '{"status":"minor_issues",'
                                                    '"summary":"Мелкое замечание по favicon",'
                                                    '"critical_issues":[],'
                                                    '"minor_issues":[{"title":"Нет favicon","file":"index.html"}],'
                                                    '"checks_run":[{"name":"qa_static_review","status":"pass","details":"OK"}]}'
                                                ),
                                            },
                                        }
                                    ],
                                }
                            }
                        ],
                        "usage": {"prompt_tokens": 80, "completion_tokens": 30, "total_tokens": 110},
                    },
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": "Проверка завершена: критики нет, есть 1 мелкое замечание.",
                                    "reasoning_content": "",
                                    "tool_calls": [],
                                }
                            }
                        ],
                        "usage": {"prompt_tokens": 40, "completion_tokens": 20, "total_tokens": 60},
                    },
                ]
            )

            with mock.patch.object(agent_mod, "call_model", side_effect=lambda *a, **kw: next(fake_replies)):
                tester_ctx = {
                    "emit_sse": lambda ev, data: events.append((ev, data)),
                    "base_url": "http://127.0.0.1:8888/v1",
                    "api_key": "",
                    "model": "o3-mini",
                    "params": {},
                    "recent_reports": [],
                }
                result_text, result_events = agent_mod.run_tool(
                    "call_tester",
                    {"sandbox_project": "demo", "summary": "Собран сайт demo"},
                    trust_level="verified",
                    sandbox_root=root,
                    approval_fn=fake_approval,
                    tester_ctx=tester_ctx,
                )

            self.assertIn("minor_issues", result_text)
            self.assertIn("токены нового QA-чата=255", result_text)
            self.assertTrue(any(ev == "tester_start" for ev, _ in events))
            done_ev = next(data for ev, data in events if ev == "tester_done")
            self.assertEqual(done_ev["usage"]["total"], 255)
            # tester_done уходит ДО approval_fn с minorDecision="pending" (чтобы прогон закрылся в БД),
            # а решение человека приходит следующим событием tester_decision.
            self.assertEqual(done_ev["minorDecision"], "pending")
            dec_ev = next(data for ev, data in events if ev == "tester_decision")
            self.assertEqual(dec_ev["decision"], "approved")
            self.assertEqual(len(tester_ctx["recent_reports"]), 1)
            self.assertEqual(tester_ctx["recent_reports"][0]["minorDecision"], "approved")
            self.assertEqual(result_events[0]["type"], "tester_report")
            self.assertEqual(approval_requests[0]["kind"], "tester_minor_fixes")

            # Агент также умеет вызывать confirm_minor_fixes отдельно после исправления критики
            approval_requests.clear()
            dec_text, dec_events = agent_mod.run_tool(
                "confirm_minor_fixes",
                {
                    "tester_run_key": done_ev["runKey"],
                    "summary": "Поправить отступ кнопки?",
                    "minor_issues": ["Отступ на кнопке (index.html)"],
                },
                trust_level="verified",
                sandbox_root=root,
                approval_fn=lambda req: (approval_requests.append(req) or {"approved": False, "note": "не надо"}),
                tester_ctx=tester_ctx,
            )
            self.assertEqual(approval_requests[0]["kind"], "tester_minor_fixes")
            self.assertIn("ОТКЛОНИЛ", dec_text)
            self.assertFalse(dec_events[0]["approved"])
            self.assertTrue(any(ev == "tester_decision" for ev, _ in events))


if __name__ == "__main__":
    unittest.main()
