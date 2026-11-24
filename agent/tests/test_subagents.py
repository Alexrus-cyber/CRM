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
        self.assertIn("report_to_orchestrator", sub_names)
        self.assertIn("request_subagent", sub_names)
        self.assertNotIn("call_subagent", sub_names)
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


if __name__ == "__main__":
    unittest.main()
