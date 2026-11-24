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
        sub_names = {t["function"]["name"] for t in agent_mod.tools_for_trust("full", role="subagent")}
        agent_names = {t["function"]["name"] for t in agent_mod.tools_for_trust("full", role="agent")}
        tester_names = {t["function"]["name"] for t in agent_mod.tools_for_trust("full", role="tester")}
        self.assertIn("report_to_orchestrator", sub_names)
        self.assertIn("request_subagent", sub_names)
        self.assertIn("list_tester_reports", sub_names)
        self.assertNotIn("call_subagent", sub_names)
        # browser_inspector и браузер доступны только Тестировщику и Оркестратору, но НЕ субагенту
        self.assertNotIn("browse_project", sub_names)
        self.assertNotIn("qa_browser_audit", sub_names)
        self.assertNotIn("open_website", sub_names)
        self.assertNotIn("play_youtube", sub_names)
        self.assertNotIn("call_tester", sub_names)
        self.assertIn("browse_project", agent_names)
        self.assertIn("browse_project", tester_names)
        self.assertIn("qa_browser_audit", tester_names)
        self.assertIn("call_subagent", agent_names)
        self.assertIn("list_subagents", agent_names)

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

    def test_subagent_fixes_blocked_until_tester_report_then_allowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = agent_mod.sandbox_mod.get_sandbox_root(os.path.join(tmp, "sb"))
            agent_mod.sandbox_mod.mkdir(root, "shop")
            tester_ctx = {"session_reports": [], "recent_reports": []}
            sub_ctx = {
                "base_url": "http://orch.local/v1",
                "api_key": "k",
                "model": "m",
                "subagents": [
                    {"id": 1, "slug": "dev", "name": "Разработчик", "orchestratorCanCall": True},
                    {"id": 2, "slug": "fixer", "name": "Фиксер", "orchestratorCanCall": True},
                ],
                "tester_ctx": tester_ctx,
                "written_projects": set(),
                "subagent_runs_by_project": {},
            }
            tester_ctx["subagent_ctx_ref"] = sub_ctx

            model_calls = []

            def _fake_model(*args, **kwargs):
                model_calls.append(1)
                return {
                    "choices": [{"message": {"content": "Исправление внесено.", "tool_calls": []}}],
                    "usage": {"total_tokens": 10},
                }

            real_model = agent_mod.call_model
            agent_mod.call_model = _fake_model
            try:
                # 1. До отчёта Тестировщика запрос на исправление багов блокируется без вызова модели
                blocked = agent_mod.run_subagent_session(
                    target_ref="fixer",
                    summary="Проект shop собран, но есть ошибка.",
                    task="Исправь баги и почини форму заказа",
                    sandbox_project="shop",
                    caller_kind="orchestrator",
                    trust_level="full",
                    sandbox_root=root,
                    tester_ctx=tester_ctx,
                    subagent_ctx=sub_ctx,
                )
                self.assertIn("ТОЛЬКО ПОСЛЕ", blocked["agentText"])
                self.assertIn("call_tester", blocked["agentText"])
                self.assertEqual(len(model_calls), 0)

                # 2. Первичная разработка (не исправление) разрешена до Тестировщика
                created = agent_mod.run_subagent_session(
                    target_ref="dev",
                    summary="Новый проект интернет-магазина",
                    task="Создай каркас каталога товаров",
                    sandbox_project="shop",
                    caller_kind="orchestrator",
                    trust_level="full",
                    sandbox_root=root,
                    tester_ctx=tester_ctx,
                    subagent_ctx=sub_ctx,
                )
                self.assertIn("Исправление внесено.", created["agentText"])
                self.assertEqual(len(model_calls), 1)

                # 3. После отчёта Тестировщика исправления субагентами разрешаются
                tester_ctx["session_reports"].insert(
                    0,
                    {
                        "runKey": "qa-1",
                        "sandboxProject": "shop",
                        "status": "critical_issues",
                        "criticalIssues": [{"title": "404"}],
                    },
                )
                allowed = agent_mod.run_subagent_session(
                    target_ref="fixer",
                    summary="Отчёт Тестировщика qa-1: ошибка 404 на форме.",
                    task="Исправь баги из отчёта Тестировщика",
                    sandbox_project="shop",
                    caller_kind="orchestrator",
                    trust_level="full",
                    sandbox_root=root,
                    tester_ctx=tester_ctx,
                    subagent_ctx=sub_ctx,
                )
                self.assertIn("Исправление внесено.", allowed["agentText"])
                self.assertEqual(len(model_calls), 2)
            finally:
                agent_mod.call_model = real_model


if __name__ == "__main__":
    unittest.main()
