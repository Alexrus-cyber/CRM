"""Тесты субагентов, Оркестратора и безлимитных шагов.

Проверяют:
* построение промпта дерева зависимостей Оркестратора;
* гейтинг вызовов по дереву (orchestratorCanCall / allowedCallees);
* приоритет заблокированного API Оркестратора против разблокированного своего API (unlockApi=True);
* безлимитные шаги для всех ролей (resolve_steps_limit).
"""

import importlib.util
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(AGENT_DIR)
for p in (REPO_ROOT, AGENT_DIR):
    if p not in sys.path:
        sys.path.insert(0, p)

import agent as agent_mod  # noqa: E402

if not hasattr(agent_mod, "run_tool"):
    import importlib.util

    _spec = importlib.util.spec_from_file_location("agent_mod_runtime", os.path.join(AGENT_DIR, "agent.py"))
    assert _spec and _spec.loader
    agent_mod = importlib.util.module_from_spec(_spec)
    sys.modules["agent_mod_runtime"] = agent_mod
    _spec.loader.exec_module(agent_mod)


def _fake_call_model(base_url, api_key, model, *args, **kwargs):
    return {
        "choices": [{"message": {"content": "Итог субагента готов.", "tool_calls": []}}],
        "usage": {"total_tokens": 12},
    }


class SubagentOrchestratorTests(unittest.TestCase):
    def test_build_orchestrator_prompt_mentions_subagents(self):
        prompt = agent_mod.build_orchestrator_subagents_prompt(
            [
                {"slug": "qa", "name": "QA", "orchestratorCanCall": True, "description": "тестирование"},
                {"slug": "dev", "name": "Dev", "orchestratorCanCall": False, "parentSubagentId": None, "description": "код"},
            ],
            [],
        )
        self.assertIn("qa", prompt)
        self.assertIn("dev", prompt)
        self.assertIn("Оркестратор", prompt)

    def test_build_orchestrator_prompt_empty(self):
        self.assertEqual(agent_mod.build_orchestrator_subagents_prompt([], []), "")

    def test_callee_allowed_semantics(self):
        caller = {"slug": "a", "name": "A", "orchestratorCanCall": True, "allowedCallees": ["b"]}
        target_b = {"slug": "b", "name": "B", "orchestratorCanCall": False, "parentSubagentId": None}
        target_x = {"slug": "x", "name": "X", "orchestratorCanCall": False, "parentSubagentId": None}
        self.assertTrue(agent_mod._is_callee_allowed(caller, target_b))
        self.assertFalse(agent_mod._is_callee_allowed(caller, target_x))
        self.assertTrue(agent_mod._is_callee_allowed({"slug": "a", "allowedCallees": ["*"]}, target_x))
        self.assertFalse(agent_mod._is_callee_allowed({"slug": "a", "allowedCallees": []}, target_x))
        self.assertFalse(agent_mod._is_callee_allowed({"slug": "a", "id": 1}, {"slug": "b", "id": 1}))

    def test_tools_for_trust_subagent_excludes_orchestrator_only_tools(self):
        sub_restricted = {
            t["function"]["name"]
            for t in agent_mod.tools_for_trust("full", role="subagent", subagent_tool_profile="restricted")
        }
        sub_full = {
            t["function"]["name"]
            for t in agent_mod.tools_for_trust("full", role="subagent", subagent_tool_profile="full")
        }
        agent_names = {t["function"]["name"] for t in agent_mod.tools_for_trust("full", role="agent")}
        self.assertIn("report_to_orchestrator", sub_restricted)
        self.assertIn("request_subagent", sub_restricted)
        self.assertNotIn("call_subagent", sub_restricted)
        self.assertNotIn("list_tester_reports", sub_restricted)
        # Профиль restricted запрещает браузер и внешние сайты, но оставляет файлы/код/команды
        self.assertNotIn("browse_project", sub_restricted)
        self.assertNotIn("qa_browser_audit", sub_restricted)
        self.assertNotIn("open_website", sub_restricted)
        self.assertNotIn("play_youtube", sub_restricted)
        self.assertNotIn("call_tester", sub_restricted)
        # Профиль full открывает субагенту браузер и QA-аудит, сохраняя защиту от call_subagent
        self.assertIn("browse_project", sub_full)
        self.assertIn("qa_browser_audit", sub_full)
        self.assertIn("open_website", sub_full)
        self.assertIn("report_to_orchestrator", sub_full)
        self.assertNotIn("qa_submit_report", sub_full)
        self.assertNotIn("call_subagent", sub_full)
        self.assertNotIn("call_tester", sub_full)
        # Оркестратор имеет call_subagent и list_subagents, но не имеет удалённых инструментов Тестировщика
        self.assertIn("browse_project", agent_names)
        self.assertIn("call_subagent", agent_names)
        self.assertIn("list_subagents", agent_names)
        self.assertNotIn("call_tester", agent_names)
        self.assertNotIn("list_tester_reports", agent_names)
        self.assertNotIn("confirm_minor_fixes", agent_names)

    def test_run_subagent_gates_orchestrator_call_when_locked(self):
        result = agent_mod.run_subagent_session(
            target_ref="x",
            summary="задача",
            task="сделай",
            caller_kind="orchestrator",
            trust_level="verified",
            subagent_ctx={
                "base_url": "http://orch.local/v1",
                "api_key": "orch-key",
                "model": "orch-model",
                "subagents": [
                    {"id": 1, "slug": "x", "name": "X", "orchestratorCanCall": False, "parentSubagentId": None},
                ],
            },
        )
        self.assertIsInstance(result, dict)
        self.assertIn("не вызывается Оркестратором", str(result.get("agentText") or ""))

    def test_run_subagent_prefers_orchestrator_api_when_locked(self):
        captured = {}

        def _cap(base_url, api_key, model, *a, **k):
            captured["base_url"] = str(base_url)
            captured["api_key"] = str(api_key)
            captured["model"] = str(model)
            return _fake_call_model(base_url, api_key, model, *a, **k)

        real = agent_mod.call_model
        agent_mod.call_model = _cap
        try:
            agent_mod.run_subagent_session(
                target_ref="x",
                summary="задача",
                task="сделай",
                caller_kind="orchestrator",
                trust_level="verified",
                subagent_ctx={
                    "base_url": "http://orch.local/v1",
                    "api_key": "orch-key",
                    "model": "orch-model",
                    "subagents": [
                        {"id": 1, "slug": "x", "name": "X", "orchestratorCanCall": True, "unlockApi": False},
                    ],
                },
            )
        finally:
            agent_mod.call_model = real
        self.assertEqual(captured["base_url"], "http://orch.local/v1")
        self.assertEqual(captured["api_key"], "orch-key")
        self.assertEqual(captured["model"], "orch-model")

    def test_run_subagent_uses_custom_api_when_unlocked(self):
        captured = {}

        def _cap(base_url, api_key, model, *a, **k):
            captured["base_url"] = str(base_url)
            captured["api_key"] = str(api_key)
            captured["model"] = str(model)
            return _fake_call_model(base_url, api_key, model, *a, **k)

        real = agent_mod.call_model
        agent_mod.call_model = _cap
        try:
            agent_mod.run_subagent_session(
                target_ref="x",
                summary="задача",
                task="сделай",
                caller_kind="orchestrator",
                trust_level="verified",
                subagent_ctx={
                    "base_url": "http://orch.local/v1",
                    "api_key": "orch-key",
                    "model": "orch-model",
                    "subagents": [
                        {
                            "id": 1,
                            "slug": "x",
                            "name": "X",
                            "orchestratorCanCall": True,
                            "unlockApi": True,
                            "customApi": {
                                "unlocked": True,
                                "baseUrl": "http://custom.local/v1",
                                "model": "custom-model",
                                "apiKey": "custom-key",
                                "reasoningMode": "high",
                            },
                        },
                    ],
                },
            )
        finally:
            agent_mod.call_model = real
        self.assertEqual(captured["base_url"], "http://custom.local/v1")
        self.assertEqual(captured["api_key"], "custom-key")
        self.assertEqual(captured["model"], "custom-model")

    def test_resolve_steps_limit_unlimited_for_all_roles(self):
        # 0 / None / пусто = без лимита для всех ролей
        self.assertEqual(agent_mod.resolve_steps_limit(0, False), 0)
        self.assertEqual(agent_mod.resolve_steps_limit(None, False), 0)
        self.assertEqual(agent_mod.resolve_steps_limit(0, True), 0)
        # положительное число без потолка
        self.assertEqual(agent_mod.resolve_steps_limit(1500, False), 1500)
        self.assertEqual(agent_mod.resolve_steps_limit(1500, True), 1500)
        self.assertEqual(agent_mod.resolve_steps_limit(25, False), 25)


class SubagentLayeredRoutingTests(unittest.TestCase):
    def _layered_tree(self):
        return [
            {
                "id": 1,
                "slug": "arch",
                "name": "Архитектор",
                "roleTitle": "Верхний уровень",
                "parentSubagentId": None,
                "orchestratorCanCall": True,
                "allowedCallees": ["*"],
            },
            {
                "id": 2,
                "slug": "backend",
                "name": "Бэкенд",
                "roleTitle": "Средний слой",
                "parentSubagentId": 1,
                "orchestratorCanCall": False,
                "allowedCallees": ["*"],
            },
            {
                "id": 3,
                "slug": "frontend",
                "name": "Фронтенд",
                "roleTitle": "Слой UI",
                "parentSubagentId": 2,
                "orchestratorCanCall": False,
                "allowedCallees": ["*"],
            },
            {
                "id": 4,
                "slug": "css-leaf",
                "name": "Стили",
                "roleTitle": "Нижний слой",
                "parentSubagentId": 3,
                "orchestratorCanCall": False,
                "allowedCallees": [],
            },
        ]

    def test_hierarchy_and_prompt_in_layered_mode(self):
        subs = self._layered_tree()
        hier = agent_mod._compute_subagent_hierarchy(subs)
        self.assertEqual(agent_mod._subagent_tier(hier, subs[0]), 1)
        self.assertEqual(agent_mod._subagent_tier(hier, subs[1]), 2)
        self.assertEqual(agent_mod._subagent_tier(hier, subs[2]), 3)
        self.assertEqual(agent_mod._subagent_tier(hier, subs[3]), 4)

        prompt = agent_mod.build_orchestrator_subagents_prompt(subs, [], routing_mode="layered")
        self.assertIn("ПО УРОВНЯМ", prompt)
        self.assertIn("Уровень 1", prompt)
        self.assertIn("Уровень 4", prompt)
        self.assertIn("escalate_to_upper_tier", prompt)

        leaf_sys = agent_mod._build_subagent_system_prompt(
            subagent=subs[3],
            all_subagents=subs,
            trust_level="verified",
            sandbox_root=agent_mod.SANDBOX_ROOT,
            sandbox_project="demo",
            routing_mode="layered",
            hierarchy=hier,
        )
        self.assertIn("Уровень дерева: 4", leaf_sys)
        self.assertIn("escalate_to_upper_tier", leaf_sys)
        self.assertIn("`arch`", leaf_sys)

    def test_layered_escalation_blocked_in_linear_mode(self):
        subs = self._layered_tree()
        res = agent_mod.run_layered_escalation(
            caller_subagent=subs[3],
            target_ref="1",
            mode="advice",
            summary="Проблема со схемой",
            request="Нужен совет",
            subagent_ctx={"routing_mode": "linear", "subagents": subs},
        )
        self.assertIn("По уровням", res["agentText"])

    def test_layered_escalation_advice_calls_only_upper_tier(self):
        subs = self._layered_tree()
        called_models = []
        emitted = []

        def _fake_model(base_url, api_key, model, messages, *args, **kwargs):
            sys_txt = messages[0]["content"]
            called_models.append(sys_txt)
            return {
                "choices": [{"message": {"content": "Совет от Уровня 1 готов.", "tool_calls": []}}],
                "usage": {"total_tokens": 15},
            }

        real = agent_mod.call_model
        agent_mod.call_model = _fake_model
        try:
            res = agent_mod.run_layered_escalation(
                caller_subagent=subs[3],
                target_ref="1",
                mode="advice",
                summary="Нужна рекомендация по API",
                request="Как лучше разбить эндпоинты?",
                subagent_ctx={
                    "routing_mode": "layered",
                    "subagents": subs,
                    "base_url": "http://orch.local/v1",
                    "api_key": "k",
                    "model": "m",
                    "emit_sse": lambda ev, d: emitted.append((ev, d)),
                },
            )
        finally:
            agent_mod.call_model = real

        self.assertEqual(len(called_models), 1)
        self.assertIn("Архитектор", called_models[0])
        self.assertIn("Уровень 1", res["agentText"])
        self.assertTrue(any(ev == "subagent_start" for ev, _ in emitted))

    def test_layered_escalation_fix_and_cascade_runs_intermediate_tiers(self):
        subs = self._layered_tree()
        visited_slugs = []

        def _fake_session(**kwargs):
            tref = kwargs["target_ref"]
            visited_slugs.append(tref)
            return {
                "agentText": f"Исправлено в {tref}",
                "agentEvents": [],
                "done": {
                    "outputSummary": f"Обновлено {tref}",
                    "filesTouched": ["api.ts"],
                },
                "report": {
                    "summary": f"Обновлено {tref}",
                    "cascadeDownstream": True if tref == "arch" else False,
                },
            }

        real_session = agent_mod.run_subagent_session
        agent_mod.run_subagent_session = _fake_session
        try:
            res = agent_mod.run_layered_escalation(
                caller_subagent=subs[3],  # css-leaf (tier 4)
                target_ref="1",           # arch (tier 1)
                mode="fix_and_cascade",
                summary="Контракт изменился",
                request="Нужно обновить схему и прокинуть вниз",
                cascade_down=True,
                subagent_ctx={
                    "routing_mode": "layered",
                    "subagents": subs,
                },
            )
        finally:
            agent_mod.run_subagent_session = real_session

        # Ожидаем последовательный вызов: Уровень 1 (arch) -> Уровень 2 (backend) -> Уровень 3 (frontend)
        self.assertEqual(visited_slugs, ["arch", "backend", "frontend"])
        self.assertIn("backend", res["agentText"])
        self.assertIn("frontend", res["agentText"])


class SubagentRestrictionsAndTesterOrderTests(unittest.TestCase):
    def test_subagent_blocked_from_browser_inspector_and_browser_commands(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = agent_mod.sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            sub_caller = {"agentKind": "subagent", "agentName": "Frontend"}
            for blocked_tool in ("browse_project", "qa_browser_audit", "open_website", "play_youtube", "call_tester"):
                with self.assertRaises(agent_mod.AgentError):
                    agent_mod.run_tool(
                        blocked_tool,
                        {"action": "open", "url": "http://127.0.0.1:3000"},
                        trust_level="full",
                        sandbox_root=root,
                        caller_info=sub_caller,
                    )

            with self.assertRaises(agent_mod.AgentError):
                agent_mod.run_tool(
                    "run_command",
                    {"command": "chromium --headless http://127.0.0.1:3000", "cwd": "."},
                    trust_level="full",
                    sandbox_root=root,
                    caller_info=sub_caller,
                )

    def test_subagent_run_command_does_not_emit_open_url_while_main_agent_does(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = agent_mod.sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            fake_run = {
                "background": True,
                "pid": 1234,
                "cwd": "app",
                "output": "listening on http://127.0.0.1:4100",
                "url": "http://127.0.0.1:4100",
                "replacedCount": 1,
            }
            with mock.patch("agent.sandbox_mod.run_command", return_value=fake_run):
                sub_txt, sub_evs = agent_mod.run_tool(
                    "run_command",
                    {"command": "python -m http.server 4100", "cwd": "app", "background": True},
                    trust_level="full",
                    sandbox_root=root,
                    caller_info={"agentKind": "subagent", "agentName": "Backend"},
                    subagent_state={"subagent": {"slug": "backend"}, "runKey": "k1"},
                )
                self.assertIn("предыдущих фоновых процессов этого проекта/порта остановлено: 1", sub_txt)
                self.assertFalse(any(e.get("type") == "open_url" for e in sub_evs))

                orch_txt, orch_evs = agent_mod.run_tool(
                    "run_command",
                    {"command": "python -m http.server 4100", "cwd": "app", "background": True},
                    trust_level="full",
                    sandbox_root=root,
                )
                self.assertIn("PID 1234", orch_txt)
                self.assertTrue(any(e.get("type") == "open_url" for e in orch_evs))

    def test_subagent_fixes_not_blocked_and_shared_files_and_chat_rotation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = agent_mod.sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            agent_mod.sandbox_mod.mkdir(root, "shop")
            events: list[tuple[str, dict]] = []
            sub_ctx = {
                "base_url": "http://orch.local/v1",
                "api_key": "k",
                "model": "m",
                "emit_sse": lambda ev, data: events.append((ev, data)),
                "subagents": [
                    {"id": 1, "slug": "designer", "name": "Дизайнер", "orchestratorCanCall": True, "toolProfile": "restricted"},
                    {"id": 2, "slug": "fixer", "name": "Фиксер", "orchestratorCanCall": True, "toolProfile": "full"},
                ],
                "shared_files": [],
                "handoff_steps": 3,
                "written_projects": set(),
                "subagent_runs_by_project": {},
            }

            # 1. Фиксер НЕ блокируется никаким отчётом встроенного Тестировщика и получает вложения макетов из Sandbox
            agent_mod.sandbox_mod.write_file(root, "_shared_files/design-spec.md", "# Палитра\nPrimary: #10b981\n")
            step_calls = 0

            def _fake_model(base, key, model, messages, *_a, **_kw):
                nonlocal step_calls
                step_calls += 1
                user_text = str(messages[1]["content"]) if len(messages) > 1 else ""
                self.assertIn("_shared_files/design-spec.md", user_text)
                self.assertIn("#10b981", user_text)
                if step_calls <= 3:
                    # 3 шага чтения -> при достижении handoff_steps=3 срабатывает автоперенос в новый чат
                    return {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "tool_calls": [
                                        {
                                            "id": f"s_{step_calls}",
                                            "function": {"name": "sandbox_list", "arguments": '{"path":"shop"}'},
                                        }
                                    ],
                                }
                            }
                        ],
                        "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30},
                    }
                if step_calls == 4:
                    # Вызов для генерации саммари перед ротацией чата
                    return {
                        "choices": [{"message": {"content": "Изучил дизайн #10b981 и структуру shop.", "tool_calls": []}}],
                        "usage": {"prompt_tokens": 15, "completion_tokens": 10, "total_tokens": 25},
                    }
                # Шаг 5 уже в НОВОМ чате субагента
                self.assertIn("ПРОДОЛЖЕНИЕ ЗАДАЧИ В НОВОМ ЧАТЕ", user_text)
                self.assertIn("Изучил дизайн #10b981", user_text)
                return {
                    "choices": [
                        {
                            "message": {
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "s_final",
                                        "function": {
                                            "name": "report_to_orchestrator",
                                            "arguments": '{"status":"completed","summary":"Исправлено по дизайн-макету","files_attached":["_shared_files/design-spec.md"]}',
                                        },
                                    }
                                ],
                            }
                        }
                    ],
                    "usage": {"prompt_tokens": 25, "completion_tokens": 15, "total_tokens": 40},
                }

            real_model = agent_mod.call_model
            agent_mod.call_model = _fake_model
            try:
                res = agent_mod.run_subagent_session(
                    target_ref="fixer",
                    summary="Проект shop готов к правкам по макету",
                    task="Исправь кнопки по дизайн-спеке",
                    sandbox_project="shop",
                    attachments=["_shared_files/design-spec.md"],
                    caller_kind="orchestrator",
                    trust_level="full",
                    sandbox_root=root,
                    subagent_ctx=sub_ctx,
                )
            finally:
                agent_mod.call_model = real_model

            self.assertIn("Исправлено по дизайн-макету", res["agentText"])
            self.assertIn("переходов в новый чат: 1", res["agentText"])
            self.assertTrue(any(ev == "subagent_chat_rotated" for ev, _ in events))
            rot_ev = next(d for ev, d in events if ev == "subagent_chat_rotated")
            self.assertEqual(rot_ev["stepsCompleted"], 3)
            self.assertIn("Изучил дизайн #10b981", rot_ev["summary"])
            starts = [d for ev, d in events if ev == "subagent_start"]
            self.assertEqual(len(starts), 2)
            self.assertTrue(starts[1].get("isContinuation"))
            self.assertEqual(starts[1].get("continuationFromRunKey"), starts[0]["runKey"])
            done_events = [d for ev, d in events if ev == "subagent_done"]
            self.assertEqual(len(done_events), 2)
            self.assertTrue(done_events[0].get("rotatedToNewChat"))
            self.assertEqual(done_events[1]["status"], "completed")
            # Shared files зарегистрированы для передачи между агентами
            self.assertTrue(
                any(
                    isinstance(item, dict) and item.get("sandboxPath") == "_shared_files/design-spec.md"
                    for item in sub_ctx["shared_files"]
                )
            )
            # Проверка: toolProfile="restricted" блокирует browse_project на уровне run_tool
            with self.assertRaises(agent_mod.AgentError):
                agent_mod.run_tool(
                    "browse_project",
                    {"action": "open", "sandbox_project": "shop"},
                    trust_level="full",
                    sandbox_root=root,
                    caller_info={"agentKind": "subagent", "toolProfile": "restricted"},
                )

    def test_direct_subagent_handoff_new_chat_emits_summary_when_steps_reach_threshold(self):
        with tempfile.TemporaryDirectory() as tmp:
            sb_root = agent_mod.sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            agent_mod.sandbox_mod.write_file(sb_root, "app/index.html", "<h1>Hi</h1>")
            prev_sb = agent_mod.SANDBOX_ROOT
            agent_mod.SANDBOX_ROOT = sb_root
            srv = agent_mod.Server(("127.0.0.1", 0), agent_mod.Handler)
            port = srv.server_address[1]
            t = threading.Thread(target=srv.serve_forever, daemon=True)
            t.start()
            import json as _json
            import urllib.request as _req

            call_idx = 0

            def _fake_model(*_a, **_kw):
                nonlocal call_idx
                call_idx += 1
                if call_idx <= 2:
                    return {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "tool_calls": [
                                        {
                                            "id": f"d_{call_idx}",
                                            "function": {"name": "sandbox_list", "arguments": '{"path":"app"}'},
                                        }
                                    ],
                                }
                            }
                        ],
                        "usage": {"total_tokens": 12},
                    }
                if call_idx == 3:
                    return {
                        "choices": [{"message": {"content": "Саммари для нового чата субагента.", "tool_calls": []}}],
                        "usage": {"total_tokens": 8},
                    }
                return {
                    "choices": [{"message": {"content": "Ответ", "tool_calls": []}}],
                    "usage": {"total_tokens": 5},
                }

            orig_threshold = agent_mod.SUBAGENT_HANDOFF_STEPS
            agent_mod.SUBAGENT_HANDOFF_STEPS = 2
            real_model = agent_mod.call_model
            agent_mod.call_model = _fake_model
            try:
                payload = _json.dumps(
                    {
                        "agentRole": "subagent",
                        "subagent": {"id": 9, "slug": "dev", "name": "Dev", "toolProfile": "restricted"},
                        "sandboxProject": "app",
                        "messages": [{"role": "user", "content": "Проверь app"}],
                        "trustLevel": "full",
                        "settings": {"baseUrl": "http://127.0.0.1:9999/v1", "model": "m"},
                    }
                ).encode("utf-8")
                req = _req.Request(
                    f"http://127.0.0.1:{port}/run",
                    data=payload,
                    headers={"Content-Type": "application/json", "Authorization": f"Bearer {srv._http_token}"},
                    method="POST",
                )
                with _req.urlopen(req, timeout=10) as resp:
                    raw = resp.read().decode("utf-8")
                self.assertIn("event: subagent_handoff_new_chat", raw)
                self.assertIn("Саммари для нового чата субагента.", raw)
            finally:
                agent_mod.SUBAGENT_HANDOFF_STEPS = orig_threshold
                agent_mod.call_model = real_model
                agent_mod.SANDBOX_ROOT = prev_sb
                srv.shutdown()
                srv.server_close()


class SubagentAuditFixesTests(unittest.TestCase):
    """Регрессии аудита «Агент ↔ Субагенты»: права дерева, адресация, лимиты, статусы."""

    def _tree(self):
        return [
            {
                "id": 1,
                "slug": "arch",
                "name": "Архитектор",
                "parentSubagentId": None,
                "orchestratorCanCall": True,
                "allowedCallees": ["*"],
                "toolProfile": "restricted",
            },
            {
                "id": 2,
                "slug": "backend",
                "name": "Бэкенд",
                "parentSubagentId": 1,
                "orchestratorCanCall": False,
                "allowedCallees": ["*"],
                "toolProfile": "restricted",
            },
            {
                "id": 3,
                "slug": "backend-python",
                "name": "Backend-python",
                "parentSubagentId": 2,
                "orchestratorCanCall": False,
                "allowedCallees": ["*"],
                "toolProfile": "restricted",
            },
            {
                "id": 4,
                "slug": "tester",
                "name": "Тестировщик",
                "parentSubagentId": 3,
                "orchestratorCanCall": False,
                "allowedCallees": [],
                "toolProfile": "restricted",
            },
        ]

    def _worker_ctx(self, emit=None, **extra):
        ctx = {
            "base_url": "http://orch.local/v1",
            "api_key": "k",
            "model": "m",
            "emit_sse": emit or (lambda _ev, _d: None),
            "subagents": [
                {
                    "id": 1,
                    "slug": "worker",
                    "name": "Воркер",
                    "orchestratorCanCall": True,
                    "allowedCallees": ["*"],
                    "toolProfile": "restricted",
                }
            ],
            "shared_files": [],
            "written_projects": set(),
            "subagent_runs_by_project": {},
        }
        ctx.update(extra)
        return ctx

    # ---------------------------------------------------------- P0-3 / P1-5
    def test_is_callee_allowed_is_fail_closed(self):
        target = {"slug": "b", "name": "B"}
        # нет поля allowedCallees -> запрет («нет данных» != «можно всё»)
        self.assertFalse(agent_mod._is_callee_allowed({"slug": "a", "name": "A"}, target))
        # не список -> запрет
        self.assertFalse(agent_mod._is_callee_allowed({"slug": "a", "allowedCallees": "b"}, target))
        self.assertFalse(agent_mod._is_callee_allowed({"slug": "a", "allowedCallees": {"b": 1}}, target))
        self.assertFalse(agent_mod._is_callee_allowed({"slug": "a", "allowedCallees": None}, target))
        # явные списки работают как раньше
        self.assertTrue(agent_mod._is_callee_allowed({"slug": "a", "allowedCallees": ["b"]}, target))
        self.assertTrue(agent_mod._is_callee_allowed({"slug": "a", "allowedCallees": ["*"]}, target))

    def test_fuzzy_search_requires_unique_match(self):
        subs = self._tree()
        # точное совпадение по slug
        self.assertEqual(agent_mod._find_subagent_in_list(subs, "backend")["id"], 2)
        # «back» неоднозначно (backend + backend-python) -> None, но кандидаты видны
        self.assertIsNone(agent_mod._find_subagent_in_list(subs, "back", fuzzy=True))
        self.assertEqual(len(agent_mod._find_subagent_matches(subs, "back")), 2)
        # уникальное нечёткое совпадение работает
        self.assertEqual(agent_mod._find_subagent_in_list(subs, "python", fuzzy=True)["id"], 3)
        # без fuzzy нечёткий поиск запрещён (строгая адресация по умолчанию)
        self.assertIsNone(agent_mod._find_subagent_in_list(subs, "python"))

    def test_ambiguous_target_lists_candidates(self):
        subs = self._tree()
        res = agent_mod.run_subagent_session(
            target_ref="back",
            summary="s",
            caller_kind="orchestrator",
            trust_level="verified",
            subagent_ctx={"subagents": subs},
        )
        self.assertIn("неоднозначна", res["agentText"])
        self.assertIn("backend-python", res["agentText"])
        self.assertEqual(res["agentEvents"], [])

    def test_upper_target_bare_number_is_id_and_tier_needs_prefix(self):
        subs = self._tree()
        hier = agent_mod._compute_subagent_hierarchy(subs)
        caller = subs[3]  # tester, Уровень 4
        # «2» — это точный id (Бэкенд), а не «Уровень 2»
        self.assertEqual(
            agent_mod._find_upper_target_in_hierarchy(
                subs, hier, caller_subagent=caller, target_ref="2"
            )["slug"],
            "backend",
        )
        # tier:2 / уровень 1 — именно номер уровня
        self.assertEqual(
            agent_mod._find_upper_target_in_hierarchy(
                subs, hier, caller_subagent=caller, target_ref="tier:2"
            )["slug"],
            "backend",
        )
        self.assertEqual(
            agent_mod._find_upper_target_in_hierarchy(
                subs, hier, caller_subagent=caller, target_ref="уровень 1"
            )["slug"],
            "arch",
        )
        # нет предка нужного уровня -> None (никакого fallback в чужую ветку)
        lonely = {"id": 99, "slug": "lonely", "name": "Одиночка", "parentSubagentId": None}
        self.assertIsNone(
            agent_mod._find_upper_target_in_hierarchy(
                subs, hier, caller_subagent=lonely, target_ref="tier:2"
            )
        )

    def test_cascade_chain_has_no_foreign_branch_fallback(self):
        subs = self._tree()
        hier = agent_mod._compute_subagent_hierarchy(subs)
        chain = agent_mod._find_cascade_intermediate_chain(
            subs, hier, upper_sub=subs[0], lower_sub=subs[3]
        )
        self.assertEqual([c["slug"] for c in chain], ["backend", "backend-python"])
        # верхний узел из чужой ветки -> каскад не выполняется
        foreign = {"id": 50, "slug": "foreign-arch", "name": "Чужой верх", "parentSubagentId": None}
        self.assertEqual(
            agent_mod._find_cascade_intermediate_chain(
                subs + [foreign], hier, upper_sub=foreign, lower_sub=subs[3]
            ),
            [],
        )

    def test_is_ancestor_of_caller(self):
        subs = self._tree()
        self.assertTrue(
            agent_mod._is_ancestor_of_caller(subs, caller_subagent=subs[0], target=subs[3])
        )
        self.assertTrue(
            agent_mod._is_ancestor_of_caller(subs, caller_subagent=subs[2], target=subs[3])
        )
        self.assertFalse(
            agent_mod._is_ancestor_of_caller(subs, caller_subagent=subs[3], target=subs[0])
        )
        self.assertFalse(
            agent_mod._is_ancestor_of_caller(subs, caller_subagent={"id": 99, "slug": "x"}, target=subs[3])
        )

    def test_subagent_gate_blocks_non_ancestor_of_locked_target(self):
        subs = self._tree()
        outsider = {
            "id": 7,
            "slug": "outsider",
            "name": "Чужак",
            "parentSubagentId": None,
            "orchestratorCanCall": True,
            "allowedCallees": ["*"],
        }
        res = agent_mod.run_subagent_session(
            target_ref="tester",
            summary="s",
            caller_kind="subagent",
            caller_subagent=outsider,
            trust_level="verified",
            subagent_ctx={"subagents": subs + [outsider]},
        )
        self.assertIn("не является его предком", res["agentText"])
        self.assertEqual(res["agentEvents"], [])

    # ---------------------------------------------------------- P0-2a / P0-2b
    def test_subagent_max_steps_caps_total_steps(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = agent_mod.sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            agent_mod.sandbox_mod.mkdir(root, "app")
            events = []
            calls = {"n": 0}

            def _loop_model(*_a, **_kw):
                calls["n"] += 1
                return {
                    "choices": [
                        {
                            "message": {
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": f"c{calls['n']}",
                                        "function": {"name": "sandbox_list", "arguments": '{"path":"app"}'},
                                    }
                                ],
                            }
                        }
                    ]
                }

            real_model = agent_mod.call_model
            agent_mod.call_model = _loop_model
            try:
                with mock.patch.object(agent_mod, "SUBAGENT_MAX_STEPS_TOTAL", 2):
                    res = agent_mod.run_subagent_session(
                        target_ref="worker",
                        summary="s",
                        task="t",
                        sandbox_project="app",
                        caller_kind="orchestrator",
                        trust_level="verified",
                        sandbox_root=root,
                        subagent_ctx=self._worker_ctx(lambda ev, d: events.append((ev, d))),
                    )
            finally:
                agent_mod.call_model = real_model

            # Лимит шагов больше не «бесконечный»: ровно 2 шага и штатное завершение
            self.assertEqual(calls["n"], 2)
            self.assertTrue(any(ev == "subagent_done" for ev, _ in events))
            self.assertIn("выполнил действий: 2", res["done"]["outputSummary"])

    def test_session_deadline_stops_session_and_emits_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = agent_mod.sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            events = []
            sub_ctx = self._worker_ctx(
                lambda ev, d: events.append((ev, d)),
                session_deadline=time.monotonic() - 1,  # дедлайн уже истёк
            )
            res = agent_mod.run_subagent_session(
                target_ref="worker",
                summary="s",
                task="t",
                caller_kind="orchestrator",
                trust_level="verified",
                sandbox_root=root,
                subagent_ctx=sub_ctx,
            )
            self.assertIn("Превышен лимит времени сеанса", res["done"]["error"])
            self.assertEqual(res["done"]["status"], "error")
            emitted = [ev for ev, _ in events]
            self.assertIn("subagent_error", emitted)
            self.assertIn("subagent_done", emitted)

    def test_session_deadline_is_inherited_by_nested_ctx(self):
        # Вложенные вызовы (эскалация) наследуют ТОТ ЖЕ дедлайн, а не создают новый
        subs = self._tree()
        deadline = time.monotonic() + 60
        captured = {}

        def _fake_session(**kwargs):
            captured.update(kwargs)
            return {"agentText": "ok", "agentEvents": [], "done": {}, "report": {}}

        real_session = agent_mod.run_subagent_session
        agent_mod.run_subagent_session = _fake_session
        try:
            res = agent_mod.run_layered_escalation(
                caller_subagent=subs[3],
                target_ref="tier:1",
                mode="advice",
                summary="s",
                request="r",
                subagent_ctx={
                    "routing_mode": "layered",
                    "subagents": subs,
                    "session_deadline": deadline,
                },
            )
        finally:
            agent_mod.run_subagent_session = real_session

        self.assertIn("agentText", res)
        self.assertEqual(captured.get("target_ref"), "arch")
        self.assertEqual(captured["subagent_ctx"].get("session_deadline"), deadline)

    # ---------------------------------------------------------- P0-2c / P1-1
    def test_broken_pipe_on_emit_does_not_lose_subagent_done(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = agent_mod.sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            seen = []

            def _broken_emit(ev, _data):
                seen.append(ev)
                raise BrokenPipeError("client gone")

            real_model = agent_mod.call_model
            agent_mod.call_model = _fake_call_model
            try:
                res = agent_mod.run_subagent_session(
                    target_ref="worker",
                    summary="s",
                    task="t",
                    caller_kind="orchestrator",
                    trust_level="verified",
                    sandbox_root=root,
                    subagent_ctx=self._worker_ctx(_broken_emit),
                )
            finally:
                agent_mod.call_model = real_model

            # Обрыв канала не мешает выполнению и не теряет финальное событие
            self.assertIn("subagent_done", seen)
            self.assertEqual(res["done"]["status"], "completed")

    def test_cancel_check_sets_error_but_still_emits_done(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = agent_mod.sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            events = []
            res = agent_mod.run_subagent_session(
                target_ref="worker",
                summary="s",
                task="t",
                caller_kind="orchestrator",
                trust_level="verified",
                sandbox_root=root,
                subagent_ctx=self._worker_ctx(
                    lambda ev, d: events.append((ev, d)),
                    cancel_check=lambda: True,
                ),
            )
            self.assertEqual(res["done"]["status"], "error")
            self.assertIn("Клиент закрыл соединение", res["done"]["error"])
            emitted = [ev for ev, _ in events]
            self.assertIn("subagent_done", emitted)
            self.assertIn("subagent_error", emitted)

    def test_chat_rotation_marks_status_rotated(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = agent_mod.sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            agent_mod.sandbox_mod.mkdir(root, "app")
            events = []
            calls = {"n": 0}

            def _model(*_a, **_kw):
                calls["n"] += 1
                if calls["n"] == 1:
                    return {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "tool_calls": [
                                        {
                                            "id": "c1",
                                            "function": {"name": "sandbox_list", "arguments": '{"path":"app"}'},
                                        }
                                    ],
                                }
                            }
                        ]
                    }
                if calls["n"] == 2:
                    return {"choices": [{"message": {"content": "Саммари для нового чата.", "tool_calls": []}}]}
                return {
                    "choices": [
                        {
                            "message": {
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "c2",
                                        "function": {
                                            "name": "report_to_orchestrator",
                                            "arguments": '{"status":"completed","summary":"Готово"}',
                                        },
                                    }
                                ],
                            }
                        }
                    ]
                }

            real_model = agent_mod.call_model
            agent_mod.call_model = _model
            try:
                agent_mod.run_subagent_session(
                    target_ref="worker",
                    summary="s",
                    task="t",
                    sandbox_project="app",
                    caller_kind="orchestrator",
                    trust_level="verified",
                    sandbox_root=root,
                    subagent_ctx=self._worker_ctx(
                        lambda ev, d: events.append((ev, d)),
                        handoff_steps=1,
                    ),
                )
            finally:
                agent_mod.call_model = real_model

            done_events = [d for ev, d in events if ev == "subagent_done"]
            self.assertEqual(len(done_events), 2)
            # Ротация — это НЕ передача другому субагенту
            self.assertEqual(done_events[0]["status"], "rotated")
            self.assertTrue(done_events[0]["rotatedToNewChat"])
            self.assertEqual(done_events[0]["requestedCalleeSlug"], "")
            self.assertEqual(done_events[1]["status"], "completed")


if __name__ == "__main__":
    unittest.main()
