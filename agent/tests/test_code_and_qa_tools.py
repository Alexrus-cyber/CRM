#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Тесты расширенных инструментов анализа кода, GitHub, QA и предохранителей."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

AGENT_DIR = Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import agent  # noqa: E402
import code_tools  # noqa: E402
import github_tools  # noqa: E402
import qa_tools  # noqa: E402


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        env={
            **os.environ,
            "GIT_AUTHOR_NAME": "Tester",
            "GIT_AUTHOR_EMAIL": "tester@example.com",
            "GIT_COMMITTER_NAME": "Tester",
            "GIT_COMMITTER_EMAIL": "tester@example.com",
        },
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


class CodeToolsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.sandbox = Path(self.tmp.name)
        self.proj = self.sandbox / "demo"
        (self.proj / "src" / "app" / "api" / "admin").mkdir(parents=True)
        (self.proj / "src" / "app" / "api" / "health").mkdir(parents=True)
        (self.proj / "src" / "db").mkdir(parents=True)
        (self.proj / "drizzle").mkdir(parents=True)

        (self.proj / "src" / "a.ts").write_text(
            'import { helperFn } from "./b";\n'
            "export function mainEntry(x: number) {\n"
            "  return helperFn(x + 1);\n"
            "}\n",
            encoding="utf-8",
        )
        (self.proj / "src" / "b.ts").write_text(
            'import { mainEntry } from "./a";\n'
            "export function helperFn(n: number) {\n"
            "  return n * 2;\n"
            "}\n"
            "export const unusedRef = mainEntry;\n",
            encoding="utf-8",
        )
        (self.proj / "src" / "worker.py").write_text(
            "class JobRunner:\n"
            "    def run(self, task_id: int) -> int:\n"
            "        return task_id\n",
            encoding="utf-8",
        )
        (self.proj / "src" / "app" / "api" / "admin" / "route.ts").write_text(
            "export async function POST(req: Request) {\n"
            "  const bad = eval('1+1');\n"
            '  const tok = "ghp_1234567890abcdef1234567890abcdef";\n'
            "  return Response.json({ bad, tok });\n"
            "}\n",
            encoding="utf-8",
        )
        (self.proj / "src" / "app" / "api" / "health" / "route.ts").write_text(
            "export async function GET() { return Response.json({ ok: true }); }\n",
            encoding="utf-8",
        )
        (self.proj / "src" / "db" / "schema.ts").write_text(
            'export const users = sqliteTable("users", {\n'
            '  id: integer("id").primaryKey(),\n'
            '  email: text("email").notNull(),\n'
            '  missingCol: text("missing_col"),\n'
            "});\n",
            encoding="utf-8",
        )
        (self.proj / "drizzle" / "0001_init.sql").write_text(
            "CREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  email TEXT NOT NULL\n);\n",
            encoding="utf-8",
        )

        _git(self.proj, "init")
        _git(self.proj, "add", "-A")
        _git(self.proj, "commit", "-m", "initial commit")
        (self.proj / "src" / "b.ts").write_text(
            (self.proj / "src" / "b.ts").read_text(encoding="utf-8") + "// added second commit\n",
            encoding="utf-8",
        )
        _git(self.proj, "add", "src/b.ts")
        _git(self.proj, "commit", "-m", "update b.ts")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_code_search_read_stats_symbols_refs_deps(self) -> None:
        s_out = code_tools.run_code_search(
            {"query": "helperFn", "whole_word": True, "context_lines": 1, "sandbox_project": "demo"},
            sandbox_root=self.sandbox,
            github_ctx=None,
        )
        self.assertIn("src/a.ts", s_out)
        self.assertIn("src/b.ts", s_out)

        batch = code_tools.run_code_read_files(
            {"files": ["src/a.ts", "src/worker.py"], "sandbox_project": "demo"},
            sandbox_root=self.sandbox,
            github_ctx=None,
        )
        self.assertIn("mainEntry", batch)
        self.assertIn("class JobRunner:", batch)

        stats = code_tools.run_code_file_stats(
            {"paths": ["src/a.ts", "src/b.ts"], "sandbox_project": "demo"},
            sandbox_root=self.sandbox,
            github_ctx=None,
        )
        self.assertIn("sha256=", stats)
        self.assertIn("git:", stats)

        syms = code_tools.run_code_symbols(
            {"path": "src", "sandbox_project": "demo"},
            sandbox_root=self.sandbox,
            github_ctx=None,
        )
        self.assertIn("class JobRunner", syms)
        self.assertIn("def JobRunner.run", syms)
        self.assertIn("function mainEntry", syms)

        refs = code_tools.run_code_refs(
            {"symbol": "helperFn", "sandbox_project": "demo"},
            sandbox_root=self.sandbox,
            github_ctx=None,
        )
        self.assertIn("Определения (1):", refs)
        self.assertIn("Импорты (1):", refs)

        deps = code_tools.run_code_deps(
            {"path": "src/a.ts", "sandbox_project": "demo"},
            sandbox_root=self.sandbox,
            github_ctx=None,
        )
        self.assertIn("-> src/b.ts", deps)
        self.assertIn("<- src/b.ts", deps)
        self.assertIn("циклические", deps.lower())

    def test_git_history_and_security_schema_endpoints(self) -> None:
        chg = code_tools.run_git_history(
            {"mode": "changed_since", "base": "HEAD~1", "head": "HEAD", "sandbox_project": "demo"},
            sandbox_root=self.sandbox,
            github_ctx=None,
        )
        self.assertIn("src/b.ts", chg)

        bl = code_tools.run_git_history(
            {"mode": "blame", "path": "src/b.ts", "start_line": 1, "end_line": 3, "sandbox_project": "demo"},
            sandbox_root=self.sandbox,
            github_ctx=None,
        )
        self.assertIn("Tester", bl)

        lgs = code_tools.run_git_history(
            {"mode": "log_search", "query": "second commit", "sandbox_project": "demo"},
            sandbox_root=self.sandbox,
            github_ctx=None,
        )
        self.assertIn("update b.ts", lgs)

        sec = code_tools.run_security_scan_tool(
            {"sandbox_project": "demo"},
            sandbox_root=self.sandbox,
            github_ctx=None,
        )
        self.assertIn("GitHub Token", sec)
        self.assertIn("eval / new Function", sec)

        sch = code_tools.run_schema_inspect_tool(
            {"sandbox_project": "demo"},
            sandbox_root=self.sandbox,
            github_ctx=None,
        )
        self.assertIn("missing_col", sch)

        ep = code_tools.run_endpoint_inventory_tool(
            {"sandbox_project": "demo"},
            sandbox_root=self.sandbox,
            github_ctx=None,
        )
        self.assertIn("/api/admin", ep)
        self.assertIn("NO_AUTH", ep)
        self.assertIn("NO_RATE_LIMIT", ep)

    def test_qa_security_auth_schema_and_plan_and_trust_blocking(self) -> None:
        checks: list = []
        txt, _ = qa_tools.run_qa_tool(
            "qa_security_audit",
            {"sandbox_project": "demo"},
            sandbox_root=self.sandbox,
            trust_level="verified",
            checks_sink=checks,
        )
        self.assertIn("GitHub Token", txt)
        self.assertEqual(checks[-1]["status"], "fail")

        txt_auth, _ = qa_tools.run_qa_tool(
            "qa_auth_matrix_audit",
            {"sandbox_project": "demo", "only_flagged": True},
            sandbox_root=self.sandbox,
            trust_level="verified",
            checks_sink=checks,
        )
        self.assertIn("/api/admin", txt_auth)

        txt_sch, _ = qa_tools.run_qa_tool(
            "qa_schema_audit",
            {"sandbox_project": "demo"},
            sandbox_root=self.sandbox,
            trust_level="verified",
            checks_sink=checks,
        )
        self.assertIn("missing_col", txt_sch)

        state: dict = {}
        plan_out, _ = code_tools.run_code_tool(
            "agent_plan",
            {"action": "set_plan", "steps": ["Check auth", "Fix bugs"]},
            sandbox_root=self.sandbox,
            run_state=state,
        )
        self.assertIn("1. [pending] Check auth", plan_out)
        code_tools.run_code_tool(
            "agent_plan",
            {"action": "update_step", "step_id": 1, "status": "done", "note": "found NO_AUTH"},
            sandbox_root=self.sandbox,
            run_state=state,
        )
        plan_out2, _ = code_tools.run_code_tool(
            "agent_plan",
            {"action": "record_finding", "severity": "P0", "file": "route.ts", "line": 2, "summary": "eval used"},
            sandbox_root=self.sandbox,
            run_state=state,
        )
        self.assertIn("[done] Check auth — found NO_AUTH", plan_out2)
        self.assertIn("[P0] (route.ts:2, verified=True): eval used", plan_out2)

        with self.assertRaises(code_tools.CodeToolError):
            code_tools.run_code_tool(
                "run_typecheck",
                {"sandbox_project": "demo"},
                sandbox_root=self.sandbox,
                trust_level="none",
            )

        with self.assertRaises(code_tools.CodeToolError):
            code_tools.run_code_read_files(
                {"files": ["../../etc/passwd"], "sandbox_project": "demo"},
                sandbox_root=self.sandbox,
                github_ctx=None,
            )


class GithubToolsAndAgentWiringTests(unittest.TestCase):
    def test_gh_api_rejects_non_github_host(self) -> None:
        with self.assertRaises(github_tools.GithubToolError):
            github_tools._gh_api("https://evil.example.com/steal", "ghp_secret")
        with self.assertRaises(github_tools.GithubToolError):
            github_tools._gh_api("http://api.github.com/user", "ghp_secret")

    def test_github_new_read_tools_and_ci(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            sandbox = Path(tmp)
            ctx = {
                "userId": 7,
                "login": "octo",
                "name": "Octo",
                "email": "octo@example.com",
                "token": "ghp_token1234567890",
                "owner": "acme",
                "repo": "crm",
                "branch": "main",
            }
            wdir = github_tools.get_repo_workspace_dir(sandbox, 7, "acme", "crm")
            wdir.mkdir(parents=True)
            (wdir / "app.ts").write_text("export const v = 1;\n", encoding="utf-8")
            _git(wdir, "init")
            _git(wdir, "add", "app.ts")
            _git(wdir, "commit", "-m", "c1")
            (wdir / "app.ts").write_text("export const v = 2;\n", encoding="utf-8")
            _git(wdir, "add", "app.ts")
            _git(wdir, "commit", "-m", "c2")

            with mock.patch.object(github_tools, "ensure_repo_synced", return_value={"workspaceDir": str(wdir), "branch": "main", "relWorkspace": "_github/u7/acme__crm"}):
                files_out, _ = github_tools.run_github_tool(
                    "github_read_files",
                    {"files": ["app.ts"]},
                    github_ctx=ctx,
                    trust_level="none",
                    approval_fn=None,
                    sandbox_root=sandbox,
                )
                self.assertIn("export const v = 2;", files_out)

                stat_out, _ = github_tools.run_github_tool(
                    "github_file_stat",
                    {"path": "app.ts"},
                    github_ctx=ctx,
                    trust_level="none",
                    approval_fn=None,
                    sandbox_root=sandbox,
                )
                self.assertIn("sha256=", stat_out)

                diff_out, _ = github_tools.run_github_tool(
                    "github_changed_since",
                    {"base": "HEAD~1", "head": "HEAD"},
                    github_ctx=ctx,
                    trust_level="none",
                    approval_fn=None,
                    sandbox_root=sandbox,
                )
                self.assertIn("app.ts", diff_out)

            def fake_api(path: str, token: str, **kwargs):  # type: ignore[no-untyped-def]
                if "check-runs" in path:
                    return {"check_runs": [{"name": "CI / node", "status": "completed", "conclusion": "success"}]}
                if "actions/runs" in path:
                    return {"workflow_runs": [{"run_number": 42, "name": "CI", "status": "completed", "conclusion": "success"}]}
                if "/pulls/5/files" in path:
                    return [{"filename": "app.ts", "status": "modified", "additions": 1, "deletions": 1, "patch": "@@ -1 +1 @@"}]
                if "/pulls/5/comments" in path:
                    return []
                if "/pulls/5" in path:
                    return {"title": "Fix v", "state": "open", "head": {"ref": "feat"}, "base": {"ref": "main"}, "additions": 1, "deletions": 1, "changed_files": 1}
                return {}

            with mock.patch.object(github_tools, "_gh_api", side_effect=fake_api):
                ci_out, _ = github_tools.run_github_tool(
                    "github_ci_status",
                    {},
                    github_ctx=ctx,
                    trust_level="none",
                    approval_fn=None,
                    sandbox_root=sandbox,
                )
                self.assertIn("CI / node", ci_out)
                pr_out, _ = github_tools.run_github_tool(
                    "github_get_pr_diff",
                    {"pull_number": 5},
                    github_ctx=ctx,
                    trust_level="none",
                    approval_fn=None,
                    sandbox_root=sandbox,
                )
                self.assertIn("PR #5", pr_out)

    def test_tools_for_trust_includes_new_tools_and_respects_none(self) -> None:
        ag_full = {t["function"]["name"] for t in agent.tools_for_trust("verified", has_github=True, role="agent")}
        ag_none = {t["function"]["name"] for t in agent.tools_for_trust("none", has_github=True, role="agent")}
        ts_full = {t["function"]["name"] for t in agent.tools_for_trust("verified", has_github=True, role="tester")}
        ts_none = {t["function"]["name"] for t in agent.tools_for_trust("none", has_github=True, role="tester")}

        for expected_read in ("code_search", "code_read_files", "code_symbols", "code_refs", "code_deps", "git_history", "security_scan", "schema_inspect", "endpoint_inventory", "agent_plan", "github_ci_status"):
            self.assertIn(expected_read, ag_full)
            self.assertIn(expected_read, ag_none)
            self.assertIn(expected_read, ts_full)
            self.assertIn(expected_read, ts_none)

        for expected_exec in ("run_typecheck", "run_lint_file", "run_tests_subset"):
            self.assertIn(expected_exec, ag_full)
            self.assertIn(expected_exec, ts_full)
            self.assertNotIn(expected_exec, ag_none)
            self.assertNotIn(expected_exec, ts_none)

        for expected_qa in ("qa_security_audit", "qa_auth_matrix_audit", "qa_schema_audit"):
            self.assertIn(expected_qa, ts_full)
            self.assertNotIn(expected_qa, ag_full)

        self.assertEqual(agent.MAX_STEPS_LIMIT, agent.MAX_STEPS)


if __name__ == "__main__":
    unittest.main()
