from __future__ import annotations

import http.server
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
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
                {"sandbox_project": "proj", "command": f'"{sys.executable}" test_math.py'},
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
        sub_restricted_names = {
            t["function"]["name"]
            for t in agent_mod.tools_for_trust("full", role="subagent", subagent_tool_profile="restricted")
        }
        sub_full_names = {
            t["function"]["name"]
            for t in agent_mod.tools_for_trust("full", role="subagent", subagent_tool_profile="full")
        }

        # Встроенный Тестировщик отключён у Оркестратора и у субагентов
        for removed in ("call_tester", "confirm_minor_fixes", "list_tester_reports"):
            self.assertNotIn(removed, agent_tool_names)
            self.assertNotIn(removed, sub_restricted_names)
            self.assertNotIn(removed, sub_full_names)

        self.assertNotIn("qa_static_review", agent_tool_names)
        self.assertNotIn("qa_submit_report", agent_tool_names)
        self.assertIn("call_subagent", agent_tool_names)
        self.assertIn("browse_project", agent_tool_names)

        # Профиль restricted не даёт QA-браузер и browse_project, а full даёт всё, кроме call_subagent
        self.assertNotIn("qa_browser_audit", sub_restricted_names)
        self.assertNotIn("browse_project", sub_restricted_names)
        self.assertIn("qa_static_review", sub_full_names)
        self.assertIn("qa_run_tests", sub_full_names)
        self.assertIn("qa_http_audit", sub_full_names)
        self.assertIn("qa_browser_audit", sub_full_names)
        self.assertIn("report_to_orchestrator", sub_full_names)
        self.assertNotIn("qa_submit_report", sub_full_names)
        self.assertIn("browse_project", sub_full_names)
        self.assertNotIn("call_subagent", sub_full_names)

    def test_call_tester_disabled_and_subagent_qa_flow(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            sandbox_mod.write_file(root, "demo/index.html", "<!doctype html><title>Demo</title><h1>Hi</h1>")
            events: list[tuple[str, dict]] = []

            with self.assertRaises(agent_mod.AgentError) as ctx_err:
                agent_mod.run_tool(
                    "call_tester",
                    {"sandbox_project": "demo", "summary": "Собран сайт demo"},
                    trust_level="verified",
                    sandbox_root=root,
                )
            self.assertIn("удалён", str(ctx_err.exception))

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
                                    "reasoning_content": "Отправляю summary Оркестратору",
                                    "tool_calls": [
                                        {
                                            "id": "tc2",
                                            "function": {
                                                "name": "report_to_orchestrator",
                                                "arguments": '{"status":"completed","summary":"Мелкое замечание по favicon","files_touched":["demo/index.html"]}',
                                            },
                                        }
                                    ],
                                }
                            }
                        ],
                        "usage": {"prompt_tokens": 80, "completion_tokens": 30, "total_tokens": 110},
                    },
                ]
            )
            call_count = 0

            def _fake_call_model(*_a: object, **_kw: object) -> dict:
                nonlocal call_count
                call_count += 1
                return next(fake_replies)

            sub_ctx = {
                "emit_sse": lambda ev, data: events.append((ev, data)),
                "base_url": "http://127.0.0.1:8888/v1",
                "api_key": "",
                "model": "o3-mini",
                "params": {},
                "subagents": [
                    {
                        "id": 11,
                        "slug": "qa-audit",
                        "name": "QA Аудитор",
                        "orchestratorCanCall": True,
                        "toolProfile": "full",
                    }
                ],
            }
            with mock.patch.object(agent_mod, "call_model", side_effect=_fake_call_model):
                result_text, result_events = agent_mod.run_tool(
                    "call_subagent",
                    {"subagent": "qa-audit", "sandbox_project": "demo", "summary": "Собран сайт demo", "task": "Проверь сайт"},
                    trust_level="verified",
                    sandbox_root=root,
                    subagent_ctx=sub_ctx,
                )

            self.assertEqual(call_count, 2)
            self.assertIn("Мелкое замечание по favicon", result_text)
            self.assertIn("токенов: 195", result_text)
            self.assertTrue(any(ev == "subagent_start" for ev, _ in events))
            done_ev = next(data for ev, data in events if ev == "subagent_done")
            self.assertEqual(done_ev["usage"]["total"], 195)
            self.assertEqual(result_events[0]["type"], "subagent_report")

    def test_call_model_completes_after_finish_reason_without_done_or_with_keepalives(self) -> None:
        class _TailHandler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:  # noqa: N802
                ln = int(self.headers.get("Content-Length") or 0)
                if ln > 0:
                    self.rfile.read(ln)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()

                def send_chunk(s: str) -> None:
                    b = s.encode("utf-8")
                    self.wfile.write(f"{len(b):x}\r\n".encode("ascii") + b + b"\r\n")
                    self.wfile.flush()

                send_chunk(
                    "data: "
                    + json.dumps({"choices": [{"delta": {"reasoning_content": "Рассуждение завершено."}}]})
                    + "\n\n"
                )
                send_chunk(
                    "data: "
                    + json.dumps(
                        {
                            "choices": [
                                {
                                    "delta": {
                                        "tool_calls": [
                                            {
                                                "index": 0,
                                                "id": "call_tail",
                                                "type": "function",
                                                "function": {
                                                    "name": "qa_submit_report",
                                                    "arguments": '{"status":"passed","summary":"Всё ок"}',
                                                },
                                            }
                                        ]
                                    },
                                    "finish_reason": "tool_calls",
                                }
                            ]
                        }
                    )
                    + "\n\n"
                )
                if self.path.startswith("/keepalive"):
                    for _ in range(10):
                        time.sleep(0.7)
                        try:
                            send_chunk(": ping\n\n")
                        except OSError:
                            break
                else:
                    time.sleep(4.0)

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                return

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _TailHandler)
        port = srv.server_address[1]
        th = threading.Thread(target=srv.serve_forever, daemon=True)
        th.start()
        try:
            for suffix in ("/silent/v1", "/keepalive/v1"):
                reasons: list[str] = []
                t0 = time.monotonic()
                res = agent_mod.call_model(
                    f"http://127.0.0.1:{port}{suffix}",
                    "",
                    "reasoner-model",
                    [{"role": "user", "content": "Проверь"}],
                    None,
                    {},
                    on_reasoning=reasons.append,
                )
                elapsed = time.monotonic() - t0
                self.assertLess(elapsed, 4.5)
                msg = res["choices"][0]["message"]
                self.assertEqual(msg["reasoning_content"], "Рассуждение завершено.")
                self.assertEqual(msg["tool_calls"][0]["function"]["name"], "qa_submit_report")
                self.assertIn("Рассуждение завершено.", reasons[-1])
        finally:
            srv.shutdown()
            srv.server_close()

    def test_subagent_recovers_text_protocol_orphan_think_and_nudge(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            sandbox_mod.write_file(root, "app/index.html", "<!doctype html><title>App</title><h1>OK</h1>")

            def _make_sub_ctx(events_sink: list) -> dict:
                return {
                    "emit_sse": lambda ev, data: events_sink.append((ev, data)),
                    "base_url": "http://127.0.0.1:8888/v1",
                    "api_key": "",
                    "model": "m",
                    "params": {},
                    "subagents": [
                        {
                            "id": 12,
                            "slug": "qa-sub",
                            "name": "QA Субагент",
                            "orchestratorCanCall": True,
                            "toolProfile": "full",
                        }
                    ],
                }

            # 1) Текстовый режим (use_tools=False после 400 на tools) + сиротский `</think>` + parameters
            events_a: list[tuple[str, dict]] = []
            replies_a = iter(
                [
                    agent_mod.AgentError("HTTP 400: tools parameter unsupported"),
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": (
                                        'Проверил всё, {"tool": "draft"} это черновик.\n</think>\n'
                                        '```json\n{"name": "report_to_orchestrator", "parameters": '
                                        '{"status": "completed", "summary": "Проверено в text-режиме"}}\n```'
                                    ),
                                    "tool_calls": [],
                                }
                            }
                        ],
                        "usage": {"total_tokens": 55},
                    },
                ]
            )

            def _side_a(*_a: object, **_kw: object) -> dict:
                nxt = next(replies_a)
                if isinstance(nxt, Exception):
                    raise nxt
                return nxt

            with mock.patch.object(agent_mod, "call_model", side_effect=_side_a):
                txt_a, _ = agent_mod.run_tool(
                    "call_subagent",
                    {"subagent": "qa-sub", "sandbox_project": "app", "summary": "Проверка text-protocol", "task": "Проверь"},
                    trust_level="full",
                    sandbox_root=root,
                    subagent_ctx=_make_sub_ctx(events_a),
                )
            self.assertIn("Проверено в text-режиме", txt_a)
            done_a = next(d for e, d in events_a if e == "subagent_done")
            self.assertEqual(done_a["status"], "completed")
            self.assertIn("черновик", done_a["reasoning"])

            # 2) Пустой content без tool_calls -> однократное напоминание и передача результата Оркестратору
            events_c: list[tuple[str, dict]] = []
            replies_c = iter(
                [
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "reasoning_content": "Закончил рассуждать и проверяю итоги.",
                                    "tool_calls": [],
                                }
                            }
                        ],
                        "usage": {"total_tokens": 30},
                    },
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "tool_calls": [
                                        {
                                            "id": "tc_nudge",
                                            "function": {
                                                "name": "report_to_orchestrator",
                                                "arguments": '{"status":"completed","summary":"Передано после nudge"}',
                                            },
                                        }
                                    ],
                                }
                            }
                        ],
                        "usage": {"total_tokens": 25},
                    },
                ]
            )
            with mock.patch.object(agent_mod, "call_model", side_effect=lambda *_a, **_kw: next(replies_c)):
                txt_c, _ = agent_mod.run_tool(
                    "call_subagent",
                    {"subagent": "qa-sub", "sandbox_project": "app", "summary": "Проверка nudge", "task": "Проверь"},
                    trust_level="full",
                    sandbox_root=root,
                    subagent_ctx=_make_sub_ctx(events_c),
                )
            self.assertIn("Передано после nudge", txt_c)

    def test_direct_tester_run_handles_reasoning_nudge_and_stops_after_submit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            sb_root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            sandbox_mod.write_file(sb_root, "app/index.html", "<!doctype html><title>App</title><h1>OK</h1>")

            prev_sb = agent_mod.SANDBOX_ROOT
            agent_mod.SANDBOX_ROOT = sb_root
            srv = agent_mod.Server(("127.0.0.1", 0), agent_mod.Handler)
            port = srv.server_address[1]
            t = threading.Thread(target=srv.serve_forever, daemon=True)
            t.start()

            call_count = 0

            def _fake_model(*_a: object, **_kw: object) -> dict:
                nonlocal call_count
                call_count += 1
                if call_count == 1:
                    return {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "reasoning_content": "Анализ завершён, перехожу к отчёту.",
                                    "tool_calls": [],
                                }
                            }
                        ],
                        "usage": {"total_tokens": 40},
                    }
                if call_count == 2:
                    return {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "tool_calls": [
                                        {
                                            "id": "tc_direct_1",
                                            "function": {
                                                "name": "qa_submit_report",
                                                "arguments": '{"status":"passed","summary":"Прямой тест пройден"}',
                                            },
                                        }
                                    ],
                                }
                            }
                        ],
                        "usage": {"total_tokens": 35},
                    }
                raise AssertionError("После qa_submit_report прямой Тестировщик не должен делать лишний вызов")

            try:
                payload = json.dumps(
                    {
                        "agentRole": "tester",
                        "sandboxProject": "app",
                        "messages": [{"role": "user", "content": "Проверь app"}],
                        "trustLevel": "full",
                        "settings": {"baseUrl": "http://127.0.0.1:9999/v1", "model": "reasoner"},
                    }
                ).encode("utf-8")
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}/run",
                    data=payload,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {srv._http_token}",
                    },
                    method="POST",
                )
                with mock.patch.object(agent_mod, "call_model", side_effect=_fake_model):
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        raw_sse = resp.read().decode("utf-8", "replace")
                self.assertEqual(call_count, 2)
                self.assertIn("event: tester_start", raw_sse)
                self.assertIn("event: tester_done", raw_sse)
                self.assertIn("Прямой тест пройден", raw_sse)
                self.assertIn("event: done", raw_sse)
            finally:
                agent_mod.SANDBOX_ROOT = prev_sb
                srv.shutdown()
                srv.server_close()

    def test_subagent_isolates_browser_emits_done_handoff_and_handles_image_limit(self) -> None:
        import browser_inspector

        with tempfile.TemporaryDirectory() as tmp:
            root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            sandbox_mod.write_file(root, "app/index.html", "<!doctype html><h1>App</h1>")

            agent_mgr = browser_inspector.BrowserSessionManager(sandbox_root=root)
            agent_sess = mock.MagicMock()
            agent_sess.is_alive.return_value = True
            agent_mgr._sessions["default"] = agent_sess

            events: list[tuple[str, dict]] = []
            model_calls: list[list[dict]] = []

            def _fake_model(_base, _key, _model, messages, *_a, **_kw):
                model_calls.append(json.loads(json.dumps(messages)))
                idx = len(model_calls)
                if idx == 1:
                    return {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "tool_calls": [
                                        {
                                            "id": "tc_qa_br",
                                            "function": {
                                                "name": "qa_browser_audit",
                                                "arguments": '{"sandbox_project":"app"}',
                                            },
                                        }
                                    ],
                                }
                            }
                        ],
                        "usage": {"total_tokens": 30},
                    }
                if idx == 2:
                    # Имитируем модель, принимающую не более 1 изображения за запрос.
                    raise agent_mod.AgentError("HTTP 400: At most 1 image may be provided in one request")
                return {
                    "choices": [
                        {
                            "message": {
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "tc_submit",
                                        "function": {
                                            "name": "report_to_orchestrator",
                                            "arguments": '{"status":"completed","summary":"Браузерный аудит пройден"}',
                                        },
                                    }
                                ],
                            }
                        }
                    ],
                    "usage": {"total_tokens": 45},
                }

            def _fake_exec(mgr, args, **_kw):
                self.assertIs(mgr, agent_mgr)
                sid = str(args.get("session_id"))
                self.assertNotEqual(sid, "default")
                self.assertTrue(sid.startswith("qa_audit_"))
                if sid not in mgr._sessions:
                    s = mock.MagicMock()
                    s.is_alive.return_value = True
                    mgr._sessions[sid] = s
                act = str(args.get("action"))
                return f"OK {act}", [
                    {
                        "type": "browser_inspect",
                        "action": act,
                        "viewport": "1440×900" if act == "open" else "390×844",
                        "summary": "анимаций: 4, проблем: 0, ошибок: 0",
                        "errorsCount": 0,
                        "issuesCount": 0,
                        "_images": ["data:image/jpeg;base64,IMG"],
                        "preview": "data:image/jpeg;base64,IMG",
                    }
                ]

            sub_ctx = {
                "emit_sse": lambda ev, data: events.append((ev, data)),
                "base_url": "http://127.0.0.1:8888/v1",
                "api_key": "",
                "model": "vlm",
                "params": {},
                "subagents": [
                    {
                        "id": 13,
                        "slug": "qa-vlm",
                        "name": "QA VLM",
                        "orchestratorCanCall": True,
                        "toolProfile": "full",
                    }
                ],
            }
            with (
                mock.patch.object(agent_mod, "call_model", side_effect=_fake_model),
                mock.patch.object(browser_inspector, "execute_browse_action", side_effect=_fake_exec),
            ):
                txt, _ = agent_mod.run_tool(
                    "call_subagent",
                    {"subagent": "qa-vlm", "sandbox_project": "app", "summary": "Проверь UI", "task": "Проверь в браузере"},
                    trust_level="verified",
                    sandbox_root=root,
                    browser_manager=agent_mgr,
                    subagent_ctx=sub_ctx,
                )

            self.assertIn("Браузерный аудит пройден", txt)
            self.assertIn("default", agent_mgr._sessions)
            agent_sess.close.assert_not_called()

            # На 2-м вызове были 2 картинки (desktop + mobile), после ошибки лимита на 3-м осталась ровно 1.
            self.assertEqual(agent_mod._count_message_images(model_calls[1]), 2)
            self.assertEqual(agent_mod._count_message_images(model_calls[2]), 1)

            # Эмитнулся явный subagent_status с done=True, а из subagent_done.actions удалены base64 preview.
            self.assertTrue(
                any(
                    ev == "subagent_status" and d.get("source") == "browser_inspector" and d.get("done") is True
                    for ev, d in events
                )
            )
            done_ev = next(d for ev, d in events if ev == "subagent_done")
            self.assertTrue(done_ev["actions"])
            for act in done_ev["actions"]:
                self.assertNotIn("preview", act)

    def test_subagent_emits_live_actions_and_actors_for_all_tools_including_sandbox_and_code_tools(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            sandbox_mod.write_file(root, "app/index.html", "<!doctype html><h1>Hello QA</h1>")
            sandbox_mod.write_file(root, "app/app.js", "const price = 42;\nconsole.log(price);\n")

            events: list[tuple[str, dict]] = []
            step_idx = 0

            def _fake_model(*_a: object, **kw: object) -> dict:
                nonlocal step_idx
                step_idx += 1
                on_status = kw.get("on_status")
                if callable(on_status):
                    on_status("Модель рассуждает (30 симв., 5 с)…")
                if step_idx <= 7:
                    calls = []
                    for i in range(8):
                        tool_name = ("sandbox_list", "sandbox_read_file", "code_search")[i % 3]
                        if tool_name == "sandbox_list":
                            t_args = {"path": "app"}
                        elif tool_name == "sandbox_read_file":
                            t_args = {"path": "app/app.js"}
                        else:
                            t_args = {"query": "price", "sandbox_project": "app"}
                        calls.append(
                            {
                                "id": f"tc_{step_idx}_{i}",
                                "function": {"name": tool_name, "arguments": json.dumps(t_args)},
                            }
                        )
                    return {
                        "choices": [{"message": {"content": "", "tool_calls": calls}}],
                        "usage": {"total_tokens": 20},
                    }
                return {
                    "choices": [
                        {
                            "message": {
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "tc_submit",
                                        "function": {
                                            "name": "report_to_orchestrator",
                                            "arguments": '{"status":"completed","summary":"Все 56+ чтений проверены"}',
                                        },
                                    }
                                ],
                            }
                        }
                    ],
                    "usage": {"total_tokens": 25},
                }

            sub_ctx = {
                "emit_sse": lambda ev, data: events.append((ev, data)),
                "base_url": "http://127.0.0.1:8888/v1",
                "api_key": "",
                "model": "qwen3",
                "params": {},
                "subagents": [
                    {
                        "id": 14,
                        "slug": "code-sub",
                        "name": "Code Sub",
                        "orchestratorCanCall": True,
                        "toolProfile": "restricted",
                    }
                ],
            }
            with mock.patch.object(agent_mod, "call_model", side_effect=_fake_model):
                txt, _ = agent_mod.run_tool(
                    "call_subagent",
                    {"subagent": "code-sub", "sandbox_project": "app", "summary": "Проверь код и файлы", "task": "Проверь"},
                    trust_level="verified",
                    sandbox_root=root,
                    subagent_ctx=sub_ctx,
                )

            self.assertIn("Все 56+ чтений проверены", txt)
            action_evs = [d["action"] for ev, d in events if ev == "subagent_action"]
            self.assertTrue(
                any(a.get("type") == "subagent_tool" and a.get("status") == "running" and a.get("tool") == "sandbox_list" for a in action_evs)
            )
            self.assertTrue(
                any(a.get("type") == "subagent_tool" and a.get("status") == "ok" and a.get("tool") == "code_search" and isinstance(a.get("durationMs"), int) for a in action_evs)
            )
            statuses = [d for ev, d in events if ev == "subagent_status"]
            self.assertTrue(any(s.get("actor") == "subagent_llm" and s.get("step") == 1 for s in statuses))
            self.assertTrue(any(s.get("actor") == "subagent" and s.get("tool") == "sandbox_read_file" for s in statuses))
            done_ev = next(d for ev, d in events if ev == "subagent_done")
            self.assertEqual(len(done_ev["actions"]), 57)

    def test_direct_tester_emits_tester_tool_actions_and_actor_statuses(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            sb_root = sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            sandbox_mod.write_file(sb_root, "app/index.html", "<!doctype html><h1>Direct QA</h1>")

            prev_sb = agent_mod.SANDBOX_ROOT
            agent_mod.SANDBOX_ROOT = sb_root
            srv = agent_mod.Server(("127.0.0.1", 0), agent_mod.Handler)
            port = srv.server_address[1]
            t = threading.Thread(target=srv.serve_forever, daemon=True)
            t.start()

            step = 0

            def _fake_model(*_a: object, **_kw: object) -> dict:
                nonlocal step
                step += 1
                if step == 1:
                    return {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "tool_calls": [
                                        {
                                            "id": "dc_list",
                                            "function": {"name": "sandbox_list", "arguments": '{"path":"app"}'},
                                        },
                                        {
                                            "id": "dc_read",
                                            "function": {"name": "sandbox_read_file", "arguments": '{"path":"app/index.html"}'},
                                        },
                                    ],
                                }
                            }
                        ],
                        "usage": {"total_tokens": 30},
                    }
                return {
                    "choices": [
                        {
                            "message": {
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "dc_sub",
                                        "function": {
                                            "name": "qa_submit_report",
                                            "arguments": '{"status":"passed","summary":"Прямой прогон ОК"}',
                                        },
                                    }
                                ],
                            }
                        }
                    ],
                    "usage": {"total_tokens": 20},
                }

            try:
                with mock.patch.object(agent_mod, "call_model", side_effect=_fake_model):
                    req = urllib.request.Request(
                        f"http://127.0.0.1:{port}/run",
                        data=json.dumps(
                            {
                                "agentRole": "tester",
                                "sandboxProject": "app",
                                "messages": [{"role": "user", "content": "Проверь index.html"}],
                                "settings": {"baseUrl": "http://127.0.0.1:8888/v1", "model": "m"},
                                "trustLevel": "full",
                            }
                        ).encode("utf-8"),
                        headers={
                            "Content-Type": "application/json",
                            "Authorization": f"Bearer {srv._http_token}",
                        },
                        method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        raw = resp.read().decode("utf-8")
                self.assertIn('"actor": "tester_llm"', raw)
                self.assertIn('"actor": "tester_tool"', raw)
                self.assertIn('"type": "tester_tool"', raw)
                self.assertIn('"status": "running"', raw)
                self.assertIn('"status": "ok"', raw)
                self.assertIn("Чтение файла: app/index.html", raw)
                self.assertIn("event: tester_done", raw)
            finally:
                srv.shutdown()
                srv.server_close()
                agent_mod.SANDBOX_ROOT = prev_sb

    def test_call_model_aborts_infinite_keepalive_stream_by_idle_timeout(self) -> None:
        seen_streams: list[bool] = []
        stop_srv = threading.Event()

        class _KeepaliveStreamFallbackJsonHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length") or "0")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                is_stream = bool(payload.get("stream"))
                seen_streams.append(is_stream)
                if not is_stream:
                    body = json.dumps(
                        {
                            "choices": [
                                {"message": {"role": "assistant", "content": "Ответ без потока"}}
                            ],
                            "usage": {"total_tokens": 12},
                        }
                    ).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return

                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for _ in range(80):
                    try:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                    except OSError:
                        break
                    if stop_srv.wait(0.05):
                        break

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                return

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _KeepaliveStreamFallbackJsonHandler)
        port = srv.server_address[1]
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        prev_timeout = agent_mod.TIMEOUT
        try:
            agent_mod.TIMEOUT = 0.35
            t0 = time.monotonic()
            with mock.patch.object(agent_mod.time, "sleep"):
                res = agent_mod.call_model(
                    f"http://127.0.0.1:{port}/v1",
                    "",
                    "test-model",
                    [{"role": "user", "content": "hi"}],
                    None,
                    {},
                    on_text=lambda _txt: None,
                )
            elapsed = time.monotonic() - t0
            self.assertEqual(seen_streams, [True, False])
            self.assertEqual(res["choices"][0]["message"]["content"], "Ответ без потока")
            # Keepalive-поток должен оборваться около TIMEOUT (~0.35-0.55с), а не ждать все 4с (80 * 0.05с)!
            self.assertLess(elapsed, 2.0)
        finally:
            stop_srv.set()
            agent_mod.TIMEOUT = prev_timeout
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
