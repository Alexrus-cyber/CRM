#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Агент-Надсмотрщик безопасности (Sandbox Security Overseer).

Отслеживает попытки побега из песочницы (Sandbox) и потенциально опасные действия
Оркестратора, субагентов и Тестировщика — даже если у агентов включён
уровень доверия `full` («Полный доступ»).

При выявлении любого риска Надсмотрщик:
  1. Транслирует свой статус и живые размышления в SSE (`overseer_start`, `overseer_status`,
     `overseer_reasoning`, `overseer_done`).
  2. Обращается исключительно к человеку на сайте через `approval_fn` (`/api/ai/agent/approve`).
  3. Не может быть отключён или обманут инструментами модели (детерминированные правила
     принудительно переводят подозрительные вызовы в `require_human`).
"""

from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import sandbox as sandbox_mod

DEFAULT_OVERSEER_SYSTEM_PROMPT = """Ты — независимый Агент-Надсмотрщик безопасности (Sandbox Guard) в CRM.
Твоя единственная задача — защищать хост-компьютер, секреты CRM и границы песочницы (Sandbox) от побега агентов и опасных действий.

ПРАВИЛА НАДСМОТРЩИКА:
1. Ни Оркестратор, ни субагенты, ни Тестировщик не имеют права сами выдавать себе разрешение на выход из Sandbox или опасные команды — ДАЖЕ если у них выбран уровень доверия `full` («Полный доступ»).
2. Разрешение на потенциально опасное действие может выдать ТОЛЬКО ЧЕЛОВЕК НА САЙТЕ.
3. Бдительно ищи:
   - любые попытки побега из Sandbox (`..`, симлинки `ln -s`, абсолютные пути `/etc`, `/root`, `/home`, `/Users`, `/proc`, `/sys`, `/dev`, `~`, `C:\\Windows`);
   - чтение секретов, токенов, переменных окружения (`env`, `printenv`, `/proc/self/environ`, `.env`, `.ssh`, `.aws`, `.kube`, API-ключи);
   - обфусцированный или динамический запуск (`python -c`, `node -e`, `bash -c`, `eval`, `base64 -d | sh`, `curl | sh`, `wget | sh`);
   - эскалацию привилегий, работу с контейнерами/сокетами (`sudo`, `su`, `chroot`, `docker`, `nsenter`, `mount`, `chmod +s`);
   - сетевую эксфильтрацию (`nc`, `ssh`, `scp`, `curl` с отправкой данных наружу) и разрушительные операции (`rm -rf`, `mkfs`, `dd`, `kill`).
4. Оцени переданный вызов инструмента и ответь СТРОГО одним JSON-объектом без markdown-обёртки:
   {
     "verdict": "allow" | "require_human",
     "riskLevel": "low" | "medium" | "high" | "critical",
     "category": "sandbox_safe" | "sandbox_escape" | "secret_access" | "outside_sandbox" | "destructive" | "network_risk" | "privilege_escalation" | "external_action",
     "title": "Короткий заголовок для человека (до 90 символов)",
     "reason": "Понятное объяснение на русском языке, почему действие безопасно или требует проверки человека",
     "recommendation": "Короткая рекомендация человеку"
   }
5. ПРИ ЛЮБЫХ СОМНЕНИЯХ ВСЕГДА ставь `"verdict": "require_human"`."""

# Детерминированные сигнатуры побега из Sandbox и опасных операций.
_DANGEROUS_CMD_RULES: List[Tuple[re.Pattern[str], str, str, str]] = [
    (
        re.compile(r"(?:^|[\s/'\"\\])(?:\.\.[\\/])+|(?:^|\s)cd\s+\.\.(?:\s|$|;|&&)", re.IGNORECASE),
        "sandbox_escape",
        "high",
        "Обнаружен переход на уровень выше (`..`), способный вывести команду за пределы Sandbox.",
    ),
    (
        re.compile(
            r"(?:/(?:private/)?etc/|/root(?:/|\s|$)|/home/|/Users/|/var/run/|/proc/|/sys/|/dev/(?:tcp|udp|sd|nvme|mem|kmem)|[A-Za-z]:[\\/]+Windows\b)",
            re.IGNORECASE,
        ),
        "sandbox_escape",
        "critical",
        "Команда обращается к системному или внешнему пути хоста за пределами Sandbox.",
    ),
    (
        re.compile(r"(?:^|[\s;|&`(])(?:ln\s+[^\n]*-s|ln\s+|mklink\b|os\.symlink\b|Path\.symlink_to\b)", re.IGNORECASE),
        "sandbox_escape",
        "high",
        "Создание символической ссылки может использоваться для обхода границ Sandbox.",
    ),
    (
        re.compile(
            r"(?:^|[\s;|&`(])(?:printenv|env\b(?:\s|$|\|)|set\b\s*$|export\s+-p|/proc/self/environ|\$(?:HOME|USERPROFILE|AGENT_API_KEY|OPENAI_API_KEY|DATABASE_URL|CRM_)|%\w*(?:KEY|TOKEN|SECRET|USERPROFILE)%)",
            re.IGNORECASE,
        ),
        "secret_access",
        "high",
        "Запрос переменных окружения или системных секретов хоста.",
    ),
    (
        re.compile(
            r"(?:\.ssh\b|\.gnupg\b|\.aws\b|\.kube\b|\.netrc\b|\.git-credentials\b|id_rsa|id_ed25519|/\.env\b|^\.env\b)",
            re.IGNORECASE,
        ),
        "secret_access",
        "critical",
        "Обращение к приватным ключам, учётным данным или секретам окружения.",
    ),
    (
        re.compile(
            r"(?:^|[\s;|&`(])(?:sudo|doas|su\s+-|chroot|nsenter|unshare|docker|podman|mount|umount|chmod\s+[ugo]*\+s|chown\s+root)\b",
            re.IGNORECASE,
        ),
        "privilege_escalation",
        "critical",
        "Попытка смены привилегий, монтирования или выхода из пространства изоляции.",
    ),
    (
        re.compile(
            r"(?:^|[\s;|&`(])(?:rm\s+-[a-zA-Z]*[rf][a-zA-Z]*|rm\s+--(?:recursive|force|no-preserve-root)|mkfs|fdisk|parted|dd\s+if=|shutdown|reboot|halt|poweroff|killall|pkill|kill\s+-9)\b",
            re.IGNORECASE,
        ),
        "destructive",
        "high",
        "Потенциально разрушительная операция удаления файлов или управления системными процессами.",
    ),
    (
        re.compile(
            r"(?:^|[\s;|&`(])(?:python[23]?\s+-c|node\s+-e|perl\s+-e|ruby\s+-e|bash\s+-c|sh\s+-c|zsh\s+-c|powershell\b|cmd\s+/c|eval\s+|base64\s+(?:-d|--decode)|\|\s*(?:ba|z)?sh\b)",
            re.IGNORECASE,
        ),
        "sandbox_escape",
        "high",
        "Динамическое или закодированное выполнение кода в консоли требует проверки человеком.",
    ),
    (
        re.compile(
            r"(?:^|[\s;|&`(])(?:curl|wget|nc|ncat|socat|ssh|scp|sftp|rsync|telnet|ftp|Invoke-WebRequest)\b",
            re.IGNORECASE,
        ),
        "network_risk",
        "medium",
        "Внешний сетевой вызов или передача данных по сети.",
    ),
    (
        re.compile(r"(?:^|[\s;|&`(])cd\s+(?:/|~|\$HOME)(?:\s|$|;|&&)", re.IGNORECASE),
        "sandbox_escape",
        "critical",
        "Попытка сменить рабочий каталог на корень системы или домашнюю папку вне Sandbox.",
    ),
]

_SENSITIVE_PATH_PATTERNS = re.compile(
    r"(?:^|[\\/])(?:\.\.|~|\.(?:ssh|gnupg|aws|kube|docker|netrc|npmrc|pypirc|git-credentials)|\.env(?:\.|$))",
    re.IGNORECASE,
)

_DANGEROUS_FILE_CONTENT_RULES: List[Tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"(?:/proc/self/environ|/etc/(?:shadow|passwd|sudoers)|os\.symlink\s*\()", re.IGNORECASE),
        "Содержимое файла пытается читать системные секреты или создавать симлинки за пределы Sandbox.",
    ),
    (
        re.compile(r"(?:/dev/tcp/|socket\.connect\s*\(\s*\([\"'][^\"']+[\"']\s*,\s*\d+\s*\).*?subprocess)", re.IGNORECASE | re.DOTALL),
        "Содержимое файла похоже на сетевой бэкдор / reverse shell.",
    ),
    (
        re.compile(r"ctypes\.(?:CDLL|WinDLL|windll|cdll)|subprocess\.(?:Popen|run|call)\s*\(\s*\[?\s*[\"'](?:/bin/sh|/bin/bash|sudo|nsenter|chroot)", re.IGNORECASE),
        "Скрипт использует низкоуровневый доступ или запуск системной оболочки.",
    ),
]

_SIMPLE_SAFE_SANDBOX_CMDS = re.compile(
    r"^(?:echo\s+[^<>|;&`$()]+|pwd|ls(?:\s+[-\w./]+)*|cat\s+[\w./-]+)$",
    re.IGNORECASE,
)


class OverseerBlockedError(RuntimeError):
    """Действие заблокировано Надсмотрщиком или отклонено человеком."""


def _is_local_url(raw_url: str) -> bool:
    u = str(raw_url or "").strip()
    if not u:
        return True
    if u.startswith("/"):
        return True
    try:
        parsed = urlparse(u)
        host = (parsed.hostname or "").lower()
        return host in ("localhost", "127.0.0.1", "::1", "0.0.0.0")
    except ValueError:
        return False


def _has_abs_or_traversal_path(raw_path: str) -> bool:
    p = str(raw_path or "").strip()
    if not p:
        return False
    if p.startswith("/") or p.startswith("\\") or p.startswith("~"):
        return True
    if re.match(r"^[A-Za-z]:[\\/]", p):
        return True
    parts = re.split(r"[\\/]+", p)
    return ".." in parts


def analyze_static_security(
    tool_name: str,
    args: Optional[Dict[str, Any]],
    sandbox_root: Path,
) -> Dict[str, Any]:
    """Детерминированная проверка рисков побега из Sandbox и опасных действий."""
    args = args if isinstance(args, dict) else {}
    t_name = str(tool_name or "").strip()

    def _result(
        *,
        flagged: bool,
        risk_level: str = "low",
        category: str = "sandbox_safe",
        title: str = "",
        reason: str = "",
        needs_ai_review: bool = False,
        target_preview: str = "",
    ) -> Dict[str, Any]:
        return {
            "flagged": flagged,
            "verdict": "require_human" if flagged else "allow",
            "risk_level": risk_level,
            "category": category,
            "title": title,
            "reason": reason,
            "needs_ai_review": needs_ai_review,
            "target_preview": target_preview[:400],
        }

    if t_name in ("run_command", "qa_run_tests"):
        cmd = str(args.get("command") or "").strip()
        cwd = str(args.get("cwd") or args.get("sandbox_project") or ".").strip() or "."
        preview = f"{cmd or '(auto-tests)'} (cwd={cwd})"
        if _has_abs_or_traversal_path(cwd):
            return _result(
                flagged=True,
                risk_level="critical",
                category="sandbox_escape",
                title="Надсмотрщик: попытка указать рабочий каталог вне Sandbox",
                reason=f"Поле cwd («{cwd}») указывает путь за пределы песочницы.",
                needs_ai_review=True,
                target_preview=preview,
            )
        if t_name == "qa_run_tests" and not cmd:
            return _result(
                flagged=False,
                risk_level="low",
                category="sandbox_safe",
                needs_ai_review=False,
                target_preview=preview,
            )
        base_escape = sandbox_mod.inspect_command_escape(cmd, sandbox_root, cwd)
        if base_escape:
            return _result(
                flagged=True,
                risk_level="critical",
                category="sandbox_escape",
                title="Надсмотрщик: обнаружена попытка побега из Sandbox или разрушительная команда",
                reason=base_escape,
                needs_ai_review=True,
                target_preview=preview,
            )
        for pat, cat, level, msg in _DANGEROUS_CMD_RULES:
            if pat.search(cmd):
                return _result(
                    flagged=True,
                    risk_level=level,
                    category=cat,
                    title="Надсмотрщик: опасная команда или риск выхода из Sandbox",
                    reason=msg,
                    needs_ai_review=True,
                    target_preview=preview,
                )
        # Простая безопасная команда вроде `echo hello` внутри Sandbox не требует задержки на LLM,
        # но произвольные сборочные/скриптовые команды в `strict` режиме проверяет ИИ-Надсмотрщик.
        needs_ai = bool(cmd and not _SIMPLE_SAFE_SANDBOX_CMDS.match(cmd))
        return _result(
            flagged=False,
            risk_level="low",
            category="sandbox_safe",
            needs_ai_review=needs_ai,
            target_preview=preview,
        )

    if t_name == "pc_command":
        cmd = str(args.get("command") or "").strip()
        return _result(
            flagged=True,
            risk_level="critical",
            category="outside_sandbox",
            title="Надсмотрщик: запуск команды на ПК вне песочницы Sandbox",
            reason="Команда выполняется напрямую на компьютере пользователя за пределами изолированной песочницы. Разрешить может только человек.",
            needs_ai_review=True,
            target_preview=cmd,
        )

    if t_name == "export_from_sandbox":
        src = str(args.get("source") or "").strip()
        dst = str(args.get("destination") or "").strip()
        mode = "move" if args.get("mode") == "move" else "copy"
        preview = f"{mode}: {src} -> {dst or '(выбор папки)'}"
        if _has_abs_or_traversal_path(src):
            return _result(
                flagged=True,
                risk_level="critical",
                category="sandbox_escape",
                title="Надсмотрщик: путь источника выходит за границы Sandbox",
                reason=f"Источник экспорта «{src}» содержит выход за границы Sandbox.",
                needs_ai_review=True,
                target_preview=preview,
            )
        return _result(
            flagged=True,
            risk_level="high",
            category="outside_sandbox",
            title="Надсмотрщик: перенос файлов из Sandbox на компьютер",
            reason=(
                f"Агент пытается {'перенести' if mode == 'move' else 'скопировать'} файлы из изолированного Sandbox "
                "наружу в файловую систему ПК. Только человек может одобрить вывод данных из песочницы."
            ),
            needs_ai_review=True,
            target_preview=preview,
        )

    if t_name in ("call_operator", "inspect_pc_screen"):
        task_txt = str(args.get("task") or args.get("reason") or "").strip()
        return _result(
            flagged=True,
            risk_level="high",
            category="outside_sandbox",
            title="Надсмотрщик: запрос доступа к экрану / управлению ПК Оператором",
            reason="Действие выходит за пределы Sandbox на рабочий стол компьютера. Требуется подтверждение человека.",
            needs_ai_review=True,
            target_preview=task_txt,
        )

    if t_name == "browse_project":
        url = str(args.get("url") or "").strip()
        action = str(args.get("action") or "").strip().lower()
        sp = str(args.get("sandbox_project") or "").strip()
        if sp and _has_abs_or_traversal_path(sp):
            return _result(
                flagged=True,
                risk_level="high",
                category="sandbox_escape",
                title="Надсмотрщик: путь проекта для браузера выходит за Sandbox",
                reason=f"Недопустимый путь sandbox_project: «{sp}».",
                needs_ai_review=True,
                target_preview=sp,
            )
        if url and not _is_local_url(url):
            return _result(
                flagged=True,
                risk_level="medium",
                category="external_action",
                title="Надсмотрщик: выход браузера на внешний сайт за пределами Sandbox",
                reason=f"Агент пытается открыть внешний URL ({url}). Требуется разрешение человека.",
                needs_ai_review=True,
                target_preview=url,
            )
        if action == "eval":
            js_code = str(args.get("script") or args.get("code") or "")
            if any(tok in js_code.lower() for tok in ("fetch(", "xmlhttprequest", "navigator.sendbeacon", "document.cookie")):
                return _result(
                    flagged=True,
                    risk_level="high",
                    category="network_risk",
                    title="Надсмотрщик: подозрительный JS-скрипт в браузере",
                    reason="Скрипт `eval` обращается к сети или cookie; требуется проверка человека.",
                    needs_ai_review=True,
                    target_preview=js_code[:240],
                )
        return _result(flagged=False, needs_ai_review=False, target_preview=url or sp or action)

    if t_name in ("sandbox_write_file", "sandbox_create_project", "sandbox_read_file", "sandbox_mkdir", "sandbox_list"):
        paths_to_check: List[str] = []
        if args.get("path"):
            paths_to_check.append(str(args["path"]))
        if args.get("project"):
            paths_to_check.append(str(args["project"]))
        contents_to_check: List[Tuple[str, str]] = []
        if t_name == "sandbox_write_file":
            contents_to_check.append((str(args.get("path") or ""), str(args.get("content") or "")))
        elif t_name == "sandbox_create_project":
            for f_item in args.get("files") or []:
                if isinstance(f_item, dict):
                    rel = str(f_item.get("path") or "")
                    paths_to_check.append(rel)
                    contents_to_check.append((rel, str(f_item.get("content") or "")))

        for p_item in paths_to_check:
            if _has_abs_or_traversal_path(p_item):
                return _result(
                    flagged=True,
                    risk_level="critical",
                    category="sandbox_escape",
                    title="Надсмотрщик: попытка доступа к пути за пределами Sandbox",
                    reason=f"Путь «{p_item}» выходит за границы Sandbox.",
                    needs_ai_review=False,
                    target_preview=p_item,
                )
            if _SENSITIVE_PATH_PATTERNS.search(p_item):
                return _result(
                    flagged=True,
                    risk_level="high",
                    category="secret_access",
                    title="Надсмотрщик: обращение к чувствительному файлу конфигурации/секретов",
                    reason=f"Путь «{p_item}» затрагивает чувствительный файл (`.env`/ключи/конфиг). Требуется одобрение человека.",
                    needs_ai_review=True,
                    target_preview=p_item,
                )
        for c_path, c_body in contents_to_check:
            for pat, msg in _DANGEROUS_FILE_CONTENT_RULES:
                if pat.search(c_body):
                    return _result(
                        flagged=True,
                        risk_level="high",
                        category="sandbox_escape",
                        title="Надсмотрщик: обнаружен потенциально опасный код в записываемом файле",
                        reason=f"Файл «{c_path}»: {msg}",
                        needs_ai_review=True,
                        target_preview=c_path,
                    )
        return _result(flagged=False, needs_ai_review=False, target_preview=", ".join(paths_to_check))

    if t_name in ("github_write_file", "github_edit_file", "github_delete_file", "github_commit", "github_create_pr", "github_merge_pr"):
        rel = str(args.get("path") or "").strip()
        if t_name in ("github_delete_file", "github_commit", "github_create_pr", "github_merge_pr"):
            return _result(
                flagged=True,
                risk_level="high" if t_name in ("github_merge_pr", "github_delete_file") else "medium",
                category="external_action",
                title=f"Надсмотрщик: изменение удалённого GitHub-репозитория ({t_name})",
                reason="Операция изменяет репозиторий или историю коммитов на GitHub; разрешить может только человек.",
                needs_ai_review=True,
                target_preview=rel or str(args.get("message") or args.get("title") or t_name),
            )
        if _has_abs_or_traversal_path(rel) or ".github/workflows" in rel.lower() or _SENSITIVE_PATH_PATTERNS.search(rel):
            return _result(
                flagged=True,
                risk_level="high",
                category="external_action",
                title="Надсмотрщик: правка критичного файла репозитория GitHub",
                reason=f"Агент меняет чувствительный файл «{rel}» в GitHub-клоне.",
                needs_ai_review=True,
                target_preview=rel,
            )
        return _result(flagged=False, needs_ai_review=False, target_preview=rel)

    if t_name in ("run_tests_subset", "run_typecheck", "run_lint_file"):
        sp = str(args.get("sandbox_project") or "").strip()
        if sp and _has_abs_or_traversal_path(sp):
            return _result(
                flagged=True,
                risk_level="critical",
                category="sandbox_escape",
                title="Надсмотрщик: выход за пределы Sandbox в параметрах проверки кода",
                reason=f"Недопустимый sandbox_project: «{sp}».",
                needs_ai_review=False,
                target_preview=sp,
            )
        return _result(flagged=False, needs_ai_review=False, target_preview=sp or t_name)

    return _result(flagged=False, needs_ai_review=False, target_preview=t_name)


def _extract_json_verdict(raw_text: str) -> Optional[Dict[str, Any]]:
    text = str(raw_text or "").strip()
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, flags=re.DOTALL | re.IGNORECASE)
    candidate = fenced.group(1) if fenced else text
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(candidate[start : end + 1])
        return parsed if isinstance(parsed, dict) else None
    except (ValueError, TypeError):
        return None


def _build_native_approval_passthrough(
    tool_name: str,
    args: Dict[str, Any],
    overseer_meta: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Для инструментов с собственной специализированной формой подтверждения дополняем её данными Надсмотрщика."""
    if tool_name == "export_from_sandbox":
        return {
            "kind": "sandbox_export",
            "title": overseer_meta.get("title") or "Надсмотрщик: разрешить вывод файлов из Sandbox на ПК?",
            "description": overseer_meta.get("reason") or "Требуется согласие человека на перенос данных из песочницы.",
            "source": str(args.get("source") or ""),
            "destination": str(args.get("destination") or ""),
            "mode": "move" if args.get("mode") == "move" else "copy",
            "overseer": overseer_meta,
        }
    if tool_name == "pc_command":
        return {
            "kind": "pc_command",
            "title": overseer_meta.get("title") or "Надсмотрщик: разрешить команду на ПК вне Sandbox?",
            "description": overseer_meta.get("reason") or "Команда затрагивает компьютер пользователя вне песочницы.",
            "command": str(args.get("command") or ""),
            "cwd": "~",
            "overseer": overseer_meta,
        }
    return None


def guard_tool_execution(
    *,
    tool_name: str,
    args: Optional[Dict[str, Any]],
    sandbox_root: Path,
    trust_level: str,
    approval_fn: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]],
    overseer_ctx: Optional[Dict[str, Any]] = None,
    caller_info: Optional[Dict[str, Any]] = None,
    call_model_fn: Optional[Callable[..., Dict[str, Any]]] = None,
    emit_sse: Optional[Callable[[str, Dict[str, Any]], None]] = None,
    default_model_cfg: Optional[Dict[str, Any]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """
    Выполняет проверку безопасности через Надсмотрщика ПЕРЕД запуском инструмента.
    Возвращает словарь `{ "humanApproved": bool, "decision": dict | None, "overseerMeta": dict | None }`.
    Если действие запрещено или не получило одобрения человека — выбрасывает `OverseerBlockedError`.
    """
    args_dict = args if isinstance(args, dict) else {}
    ctx = overseer_ctx if isinstance(overseer_ctx, dict) else None
    static = analyze_static_security(tool_name, args_dict, sandbox_root)

    # Определяем, активен ли Надсмотрщик:
    # - при переданном overseer_ctx ориентируемся на enabled (по умолчанию True);
    # - даже если overseer_ctx не передан (например, прямой unit-вызов run_tool),
    #   критические сигнатуры побега/опасных команд (flagged=True) для не-экспортных/не-native
    #   инструментов всё равно перехватываются!
    ctx_enabled = bool(ctx.get("enabled", True)) if ctx is not None else False
    # Критические системные правила (побег из Sandbox / опасные команды) не могут быть выключены.
    is_hard_sandbox_threat = bool(
        static["flagged"]
        and (
            static["category"] in ("sandbox_escape", "secret_access", "privilege_escalation", "destructive")
            or tool_name in ("pc_command",)
        )
    )
    should_run = False
    if is_hard_sandbox_threat:
        should_run = True
    elif ctx_enabled:
        should_run = bool(static["flagged"] or static["needs_ai_review"])

    if not should_run:
        return {"humanApproved": False, "decision": None, "overseerMeta": None}

    caller = caller_info if isinstance(caller_info, dict) else {}
    target_agent = str(caller.get("agentName") or "Оркестратор")
    target_kind = str(caller.get("agentKind") or "orchestrator")
    subagent_run_key = str(caller.get("subagentRunKey") or "")

    mode = str((ctx or {}).get("mode") or "strict").strip().lower()
    if mode not in ("strict", "rules_only"):
        mode = "strict"

    cfg_base = str((ctx or {}).get("base_url") or (default_model_cfg or {}).get("base_url") or "").strip()
    cfg_key = str((ctx or {}).get("api_key") or (default_model_cfg or {}).get("api_key") or "")
    cfg_model = str((ctx or {}).get("model") or (default_model_cfg or {}).get("model") or "").strip()
    cfg_params = dict((default_model_cfg or {}).get("params") or {})
    custom_prompt = str((ctx or {}).get("systemPrompt") or "").strip()

    check_id = uuid.uuid4().hex[:10]

    def _emit(ev_name: str, payload: Dict[str, Any]) -> None:
        if callable(emit_sse):
            out = {**payload, "checkId": check_id}
            if subagent_run_key:
                out.setdefault("subagentRunKey", subagent_run_key)
            emit_sse(ev_name, out)

    _emit(
        "overseer_start",
        {
            "tool": tool_name,
            "targetAgent": target_agent,
            "targetAgentKind": target_kind,
            "category": static["category"],
            "riskLevel": static["risk_level"],
            "targetPreview": static["target_preview"],
            "model": cfg_model or "rules-engine",
            "mode": mode,
        },
    )
    _emit(
        "overseer_status",
        {
            "text": f"Надсмотрщик проверяет {tool_name} ({target_agent})…",
            "actor": "overseer",
            "source": "overseer",
            "tool": tool_name,
        },
    )

    final_verdict = static["verdict"]  # "allow" или "require_human"
    final_risk = static["risk_level"]
    final_category = static["category"]
    final_title = static["title"] or f"Надсмотрщик: проверка действия `{tool_name}`"
    final_reason = static["reason"] or "Действие проверено правилами Надсмотрщика."
    final_rec = "Разрешите действие только если вы полностью доверяете команде и её цели."
    overseer_reasoning = ""

    use_llm = (
        ctx_enabled
        and mode == "strict"
        and callable(call_model_fn)
        and bool(cfg_base and cfg_model)
        and (static["needs_ai_review"] or static["flagged"])
    )

    if use_llm:
        sys_prompt = DEFAULT_OVERSEER_SYSTEM_PROMPT
        if custom_prompt:
            sys_prompt += f"\n\nДОПОЛНИТЕЛЬНЫЕ ПРАВИЛА ПОЛЬЗОВАТЕЛЯ ДЛЯ НАДСМОТРЩИКА:\n{custom_prompt}"

        safe_args_preview = json.dumps(args_dict, ensure_ascii=False)[:3000]
        user_msg = (
            f"ЗАПРОС НА ВЫПОЛНЕНИЕ ИНСТРУМЕНТА:\n"
            f"- Инициатор: {target_agent} (роль: {target_kind})\n"
            f"- Текущий уровень доверия агентов: {trust_level}\n"
            f"- Инструмент: {tool_name}\n"
            f"- Корень Sandbox: {sandbox_root}\n"
            f"- Аргументы: {safe_args_preview}\n"
            f"- Предварительный статический анализ: flagged={static['flagged']}, "
            f"category={static['category']}, risk={static['risk_level']}, note={static['reason'] or 'нет'}\n\n"
            f"Оцени риск побега из Sandbox, утечки секретов или опасных последствий и верни JSON-вердикт."
        )

        ov_params = {**cfg_params, "temperature": 0.1, "maxTokens": 900}
        if not ov_params.get("reasoning") or ov_params.get("reasoning") == "off":
            ov_params["reasoning"] = "medium"

        def _on_ov_reasoning(piece: str) -> None:
            nonlocal overseer_reasoning
            overseer_reasoning = piece.strip()
            if overseer_reasoning:
                _emit("overseer_reasoning", {"text": overseer_reasoning, "tool": tool_name})

        try:
            resp = call_model_fn(
                cfg_base,
                cfg_key,
                cfg_model,
                [
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": user_msg},
                ],
                None,
                ov_params,
                on_reasoning=_on_ov_reasoning,
                on_status=lambda s: _emit(
                    "overseer_status",
                    {"text": f"Надсмотрщик: {s}", "actor": "overseer", "source": "overseer", "tool": tool_name},
                ),
                cancel_check=cancel_check,
            )
            msg = ((resp.get("choices") or [{}])[0].get("message") or {})
            raw_r = str(msg.get("reasoning_content") or msg.get("reasoning") or "").strip()
            raw_c = str(msg.get("content") or "").strip()
            if raw_r:
                overseer_reasoning = raw_r
                _emit("overseer_reasoning", {"text": overseer_reasoning, "tool": tool_name})
            parsed = _extract_json_verdict(raw_c)
            if parsed:
                ai_verdict = str(parsed.get("verdict") or "").strip().lower()
                ai_risk = str(parsed.get("riskLevel") or "").strip().lower()
                ai_cat = str(parsed.get("category") or "").strip()
                ai_title = str(parsed.get("title") or "").strip()
                ai_reason = str(parsed.get("reason") or "").strip()
                ai_rec = str(parsed.get("recommendation") or "").strip()
                # Инвариант: ИИ-Надсмотрщик может УСИЛИТЬ тревогу, но НЕ МОЖЕТ отменить детерминированный флаг побега!
                if static["flagged"]:
                    final_verdict = "require_human"
                elif ai_verdict in ("require_human", "block", "deny"):
                    final_verdict = "require_human"
                elif ai_verdict == "allow":
                    final_verdict = "allow"
                else:
                    final_verdict = "require_human"
                if ai_risk in ("low", "medium", "high", "critical"):
                    if not static["flagged"] or ai_risk in ("high", "critical"):
                        final_risk = ai_risk
                if ai_cat and not static["flagged"]:
                    final_category = ai_cat
                if ai_title:
                    final_title = ai_title[:120]
                if ai_reason:
                    final_reason = ai_reason[:1200]
                if ai_rec:
                    final_rec = ai_rec[:400]
            else:
                # Fail-closed при нечитаемом ответе Надсмотрщика.
                final_verdict = "require_human"
                if not static["reason"]:
                    final_reason = "Надсмотрщик не смог автоматически подтвердить безопасность команды — требуется решение человека."
        except BrokenPipeError:
            raise
        except Exception as err:  # noqa: BLE001
            # Fail-closed: при сбое модели Надсмотрщика действие передаётся человеку (если есть риск).
            if static["flagged"] or tool_name in ("run_command", "pc_command", "export_from_sandbox", "call_operator", "inspect_pc_screen"):
                final_verdict = "require_human"
                if not static["reason"]:
                    final_reason = f"Проверка моделью Надсмотрщика не завершилась ({err}); требуется подтверждение человека."
    elif static["flagged"] and not overseer_reasoning:
        overseer_reasoning = (
            f"Анализ правил Надсмотрщика для {tool_name} ({target_agent}): "
            f"категория={final_category}, уровень риска={final_risk}. {final_reason}"
        )
        _emit("overseer_reasoning", {"text": overseer_reasoning, "tool": tool_name})

    overseer_meta = {
        "checkId": check_id,
        "verdict": final_verdict,
        "riskLevel": final_risk,
        "category": final_category,
        "title": final_title,
        "reason": final_reason,
        "recommendation": final_rec,
        "requestedBy": target_agent,
        "requestedByKind": target_kind,
        "tool": tool_name,
        "targetPreview": static["target_preview"],
        "model": cfg_model or "rules-engine",
        "reasoning": overseer_reasoning,
        "trustBypassBlocked": trust_level == "full" and final_verdict == "require_human",
    }

    _emit(
        "overseer_done",
        {
            "tool": tool_name,
            "targetAgent": target_agent,
            "targetAgentKind": target_kind,
            "verdict": final_verdict,
            "riskLevel": final_risk,
            "category": final_category,
            "title": final_title,
            "reason": final_reason,
            "recommendation": final_rec,
            "targetPreview": static["target_preview"],
            "model": cfg_model or "rules-engine",
            "reasoning": overseer_reasoning,
        },
    )

    if final_verdict != "allow":
        # Инструменты, которые безусловно сами открывают специализированное окно подтверждения
        # (команда на ПК, скриншот браузера, редактор задачи Оператора, diff коммита GitHub), получают
        # overseerMeta через обёртку approval_fn в run_tool, чтобы не запрашивать человека дважды.
        if tool_name in ("pc_command", "call_operator", "inspect_pc_screen", "github_commit", "github_create_pr", "github_merge_pr"):
            return {"humanApproved": False, "decision": None, "overseerMeta": overseer_meta, "attachToNativeApproval": True}

        if approval_fn is None:
            raise OverseerBlockedError(
                f"Надсмотрщик заблокировал действие `{tool_name}` ({final_reason}). "
                "Разрешение на такие запросы может выдать только человек на сайте, даже при полном доступе."
            )

        _emit(
            "overseer_status",
            {
                "text": f"Надсмотрщик ждёт решения человека по запросу «{tool_name}»…",
                "actor": "approval",
                "source": "overseer",
                "tool": tool_name,
            },
        )

        native_req = _build_native_approval_passthrough(tool_name, args_dict, overseer_meta)
        req_payload: Dict[str, Any] = native_req or {
            "kind": "overseer_approval",
            "title": final_title,
            "description": final_reason,
            "command": str(args_dict.get("command") or static["target_preview"] or ""),
            "cwd": str(args_dict.get("cwd") or args_dict.get("sandbox_project") or "."),
            "url": str(args_dict.get("url") or ""),
            "source": str(args_dict.get("source") or args_dict.get("path") or ""),
            "destination": str(args_dict.get("destination") or ""),
            "overseer": overseer_meta,
        }
        if subagent_run_key:
            req_payload["subagentRunKey"] = subagent_run_key

        decision = approval_fn(req_payload)
        if not isinstance(decision, dict) or not decision.get("approved"):
            note = str((decision or {}).get("note") or "").strip()
            raise OverseerBlockedError(
                f"Надсмотрщик и человек отклонили действие `{tool_name}` ({final_reason})"
                + (f". Комментарий: {note}" if note else ".")
            )
        return {"humanApproved": True, "decision": decision, "overseerMeta": overseer_meta}

    return {"humanApproved": False, "decision": None, "overseerMeta": overseer_meta}
