# -*- coding: utf-8 -*-
"""Сборка аргументов и переменных окружения для конкретного агента.

Всё здесь — чистые функции: их удобно проверять без GUI и без запуска агентов
(`python -m launcher --self-test`).
"""

from __future__ import annotations

import os
import shlex
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence

from launcher.catalog import PROVIDER_PRESETS, AgentSpec
from launcher.settings import LaunchSettings

# Переменные, которыми CRM и агенты договариваются о модели.
MODEL_ENV_KEYS = ("AGENT_BASE_URL", "AGENT_MODEL", "AGENT_API_KEY")

# Провайдеры, которым нужен ключ (локальному серверу обычно нет).
NO_KEY_PROVIDERS = ("local",)


def truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in ("1", "true", "yes", "on", "да")


def number(value: Any, kind: type) -> Any:
    """Пустое поле → None (параметр не передаём), иначе число."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        return kind(float(value)) if kind is int else kind(value)
    except (TypeError, ValueError):
        return None


def model_settings(settings: LaunchSettings) -> Dict[str, Any]:
    """Общие параметры модели в нормализованном виде."""
    provider = settings.provider if settings.provider in PROVIDER_PRESETS or settings.provider == "custom" else "local"
    return {
        "provider": provider,
        "base_url": settings.resolved_base_url(),
        "model": settings.resolved_model(),
        "api_key": settings.api_key.strip(),
        "temperature": number(settings.temperature, float),
        "top_p": number(settings.top_p, float),
        "max_tokens": number(settings.max_tokens, int),
        "reasoning": settings.reasoning or "default",
    }


def _add_flag(args: List[str], flag: str, value: Any) -> None:
    text = "" if value is None else str(value).strip()
    if text:
        args.extend([flag, text])


def operator_args(spec: AgentSpec, settings: LaunchSettings) -> List[str]:
    """Аргументы `desktop_operator.py`."""
    values = settings.values_for(spec)
    model = model_settings(settings)

    args: List[str] = ["--provider", model["provider"]]
    # Свой адрес передаём явно: у пресета он всё равно подставится внутри агента.
    preset_url = PROVIDER_PRESETS.get(model["provider"], {}).get("base_url", "")
    if model["provider"] == "custom" or (model["base_url"] and model["base_url"] != preset_url):
        _add_flag(args, "--base-url", model["base_url"])
    _add_flag(args, "--model", model["model"])
    _add_flag(args, "--api-key", model["api_key"])
    if model["temperature"] is not None:
        _add_flag(args, "--temperature", model["temperature"])
    if model["top_p"] is not None:
        _add_flag(args, "--top-p", model["top_p"])
    if model["max_tokens"] is not None:
        _add_flag(args, "--max-tokens", model["max_tokens"])
    if model["reasoning"] and model["reasoning"] != "default":
        _add_flag(args, "--reasoning", model["reasoning"])

    mode = str(values.get("mode") or "watch")
    _add_flag(args, "--server", values.get("crm_server"))
    _add_flag(args, "--token", values.get("crm_token"))
    if mode == "watch":
        args.append("--watch")
    elif mode == "once":
        args.append("--once")
    else:
        _add_flag(args, "--task", values.get("task"))

    steps = number(values.get("max_steps"), int)
    if steps:
        args.extend(["--max-steps", str(steps)])
    delay = number(values.get("delay"), float)
    if delay is not None:
        args.extend(["--delay", str(delay)])

    if truthy(values.get("yes")):
        args.append("--yes")
    trust_level = str(values.get("trust_level") or "").strip().lower()
    if trust_level in ("full", "verified", "none"):
        args.extend(["--trust-level", trust_level])
    if truthy(values.get("dry_run")):
        args.append("--dry-run")
    if truthy(values.get("text_only")):
        args.append("--text-only")
    if not truthy(values.get("verify", True)):
        args.append("--no-verify-actions")
    if not truthy(values.get("repeat_nudge", True)):
        args.append("--no-repeat-nudge")
    if not truthy(values.get("self_reflect", True)):
        args.append("--no-self-reflect")
    return args


def chat_agent_env(spec: AgentSpec, settings: LaunchSettings) -> Dict[str, str]:
    """Переменные `agent.py` — он не принимает аргументы командной строки."""
    values = settings.values_for(spec)
    model = model_settings(settings)
    env: Dict[str, str] = {
        "AGENT_HOST": str(values.get("host") or "127.0.0.1"),
        "AGENT_PORT": str(number(values.get("port"), int) or 8899),
        "AGENT_BASE_URL": model["base_url"],
        "AGENT_MODEL": model["model"],
        "AGENT_API_KEY": model["api_key"],
    }
    steps = number(values.get("max_steps"), int)
    if steps:
        env["AGENT_MAX_STEPS"] = str(steps)
    trust_level = str(values.get("trust_level") or "verified").strip().lower()
    if trust_level in ("full", "verified", "none"):
        env["AGENT_TRUST_LEVEL"] = trust_level
    workspace = str(values.get("workspace") or "").strip()
    if workspace:
        env["AGENT_WORKSPACE"] = workspace
    return env


def custom_env(spec: AgentSpec, settings: LaunchSettings) -> Dict[str, str]:
    values = settings.values_for(spec)
    if not truthy(values.get("pass_model_env", True)):
        return {}
    model = model_settings(settings)
    return {
        "AGENT_BASE_URL": model["base_url"],
        "AGENT_MODEL": model["model"],
        "AGENT_API_KEY": model["api_key"],
    }


def custom_args(spec: AgentSpec, settings: LaunchSettings) -> List[str]:
    values = settings.values_for(spec)
    raw = str(values.get("args") or "").strip()
    if not raw:
        return []
    try:
        return shlex.split(raw, posix=os.name != "nt")
    except ValueError:
        return raw.split()


def agent_args(spec: AgentSpec, settings: LaunchSettings) -> List[str]:
    if spec.id == "operator":
        return operator_args(spec, settings)
    if spec.id == "chat_agent":
        # agent.py настраивается переменными окружения, аргументов нет.
        return []
    if spec.id == "custom":
        return custom_args(spec, settings)
    # Свой агент из agents.json: значения полей уходят как `--key value`.
    values = settings.values_for(spec)
    args: List[str] = []
    for item in spec.fields:
        value = values.get(item.key)
        if item.kind == "bool":
            if truthy(value):
                args.append(f"--{item.key.replace('_', '-')}")
            continue
        if value is None or str(value).strip() == "":
            continue
        args.extend([f"--{item.key.replace('_', '-')}", str(value)])
    return args


def agent_env(spec: AgentSpec, settings: LaunchSettings) -> Dict[str, str]:
    """Дополнительные переменные окружения агента (без системных)."""
    if spec.id == "chat_agent":
        return chat_agent_env(spec, settings)
    if spec.id == "custom":
        return custom_env(spec, settings)
    return {}


def script_path(spec: AgentSpec, settings: LaunchSettings, agents_dir: Path) -> Path | None:
    """Путь к скрипту агента: для своего — выбранный пользователем файл."""
    if spec.id == "custom":
        raw = str(settings.values_for(spec).get("script_path") or "").strip()
        return Path(raw).expanduser() if raw else None
    if not spec.script:
        return None
    return agents_dir / spec.script


def working_dir(spec: AgentSpec, settings: LaunchSettings, agents_dir: Path, fallback: Path) -> Path:
    if spec.id == "custom":
        raw = str(settings.values_for(spec).get("cwd") or "").strip()
        if raw:
            return Path(raw).expanduser()
        script = script_path(spec, settings, agents_dir)
        if script:
            return script.parent
    workspace = str(settings.values_for(spec).get("workspace") or "").strip()
    if workspace:
        return Path(workspace).expanduser()
    return fallback


def validate(spec: AgentSpec, settings: LaunchSettings, agents_dir: Path) -> List[str]:
    """Предупреждения перед запуском (не ошибки: агент может работать и так)."""
    warnings: List[str] = []
    model = model_settings(settings)
    values = settings.values_for(spec)

    if model["max_tokens"] and model["max_tokens"] > 32768:
        warnings.append("max_tokens больше 32768 — большинство серверов такой ответ не отдадут.")

    if "model" in spec.requires:
        if not model["base_url"]:
            warnings.append("Не указан адрес API модели — агент возьмёт значение по умолчанию.")
        if not model["model"]:
            warnings.append("Не выбрана модель: заполните поле «Модель».")
        if model["provider"] not in NO_KEY_PROVIDERS and not model["api_key"]:
            warnings.append(
                f"Для провайдера «{PROVIDER_PRESETS[model['provider']]['label']}» нужен ключ API."
            )

    if spec.id == "operator":
        mode = str(values.get("mode") or "watch")
        if mode != "task" and not str(values.get("crm_token") or "").strip():
            warnings.append("Без токена агента оператор не получит задания из CRM.")
        if mode == "task" and not str(values.get("task") or "").strip():
            warnings.append("Режим «Разовое задание», но само задание не заполнено.")
    if spec.id == "custom":
        script = script_path(spec, settings, agents_dir)
        if script is None:
            warnings.append("Выберите Python-файл агента.")
        elif not script.is_file():
            warnings.append(f"Файл не найден: {script}")
    else:
        target = script_path(spec, settings, agents_dir)
        if target is None or not target.is_file():
            warnings.append(f"В сборке нет скрипта агента ({spec.script}) — пересоберите exe.")
    return warnings


def describe_command(command: Sequence[str], env: Mapping[str, str]) -> str:
    """Человекочитаемая строка для лога: без секретов."""
    shown: List[str] = []
    skip_next = False
    for index, part in enumerate(command):
        if skip_next:
            shown.append("•••")
            skip_next = False
            continue
        if part in ("--api-key", "--token") and index + 1 < len(command):
            shown.append(part)
            skip_next = True
            continue
        shown.append(part if " " not in part else f'"{part}"')
    env_part = " ".join(f"{key}=•••" for key in sorted(env) if "KEY" in key.upper())
    return " ".join(shown) + (f"  [{env_part}]" if env_part else "")
