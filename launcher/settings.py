# -*- coding: utf-8 -*-
"""Настройки приложения: провайдер модели, общие параметры и значения полей.

Хранятся в JSON рядом с пользовательскими данными:
    Windows: %APPDATA%\\CRM Agents\\launcher.json
    Linux/macOS: ~/.config/crm-agents/launcher.json
Переопределяется переменной CRM_LAUNCHER_CONFIG (удобно для переносимой сборки
на флешке: `CRM_LAUNCHER_CONFIG=./settings.json`).
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, Mapping

from launcher.catalog import PROVIDER_PRESETS, AgentSpec


def config_dir() -> Path:
    override = os.environ.get("CRM_LAUNCHER_CONFIG")
    if override:
        return Path(override).expanduser().resolve().parent
    if sys.platform.startswith("win"):
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "CRM Agents"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "CRM Agents"
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "crm-agents"


def config_path() -> Path:
    override = os.environ.get("CRM_LAUNCHER_CONFIG")
    if override:
        return Path(override).expanduser().resolve()
    return config_dir() / "launcher.json"


def workspace_dir() -> Path:
    return config_dir() / "workspace"


def mask_secret(value: str) -> str:
    """Ключ в отчётах и подсказках: показываем только хвост."""
    text = (value or "").strip()
    if not text:
        return "—"
    if len(text) <= 8:
        return "•" * len(text)
    return f"{text[:4]}…{text[-4:]}"


@dataclass
class LaunchSettings:
    """Общие настройки модели + значения полей для каждого агента."""

    provider: str = "local"
    base_url: str = ""
    model: str = ""
    api_key: str = ""
    temperature: float | None = None
    top_p: float | None = None
    max_tokens: int | None = None
    reasoning: str = "default"
    remember_key: bool = False
    last_agent: str = "operator"
    agent_values: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    crm_url: str = "http://localhost:3000"
    crm_email: str = ""
    crm_session_token: str = ""
    crm_profile: Dict[str, Any] = field(default_factory=dict)

    def clear_crm_auth(self) -> None:
        self.crm_session_token = ""
        self.crm_profile = {}

    # ---- значения полей -------------------------------------------------
    def values_for(self, spec: AgentSpec) -> Dict[str, Any]:
        defaults = spec.field_defaults()
        stored = self.agent_values.get(spec.id, {})
        defaults.update({key: value for key, value in stored.items() if key in defaults})
        return defaults

    def set_value(self, agent_id: str, key: str, value: Any) -> None:
        self.agent_values.setdefault(agent_id, {})[key] = value

    def replace_values(self, agent_id: str, values: Mapping[str, Any]) -> None:
        self.agent_values[agent_id] = dict(values)

    # ---- провайдер ------------------------------------------------------
    def apply_preset(self, provider: str, keep_model: bool = False) -> None:
        preset = PROVIDER_PRESETS.get(provider)
        self.provider = provider if provider in PROVIDER_PRESETS else "local"
        if not preset:
            return
        self.base_url = preset["base_url"]
        if not keep_model or not self.model:
            self.model = preset["model"]

    def resolved_base_url(self) -> str:
        if self.base_url.strip():
            return self.base_url.strip()
        preset = PROVIDER_PRESETS.get(self.provider)
        return preset["base_url"] if preset else ""

    def resolved_model(self) -> str:
        if self.model.strip():
            return self.model.strip()
        preset = PROVIDER_PRESETS.get(self.provider)
        return preset["model"] if preset else ""

    # ---- сериализация ---------------------------------------------------
    def to_dict(self) -> Dict[str, Any]:
        data: Dict[str, Any] = {
            "provider": self.provider,
            "base_url": self.base_url,
            "model": self.model,
            "temperature": self.temperature,
            "top_p": self.top_p,
            "max_tokens": self.max_tokens,
            "reasoning": self.reasoning,
            "remember_key": bool(self.remember_key),
            "last_agent": self.last_agent,
            "agent_values": self.agent_values,
            "crm_url": self.crm_url,
            "crm_email": self.crm_email,
            "crm_session_token": self.crm_session_token,
            "crm_profile": self.crm_profile,
        }
        # Ключ не пишем на диск, пока пользователь не попросил.
        if self.remember_key and self.api_key:
            data["api_key"] = self.api_key
        return data

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "LaunchSettings":
        settings = cls()
        settings.provider = str(raw.get("provider") or "local")
        settings.base_url = str(raw.get("base_url") or "")
        settings.model = str(raw.get("model") or "")
        settings.temperature = _as_float(raw.get("temperature"))
        settings.top_p = _as_float(raw.get("top_p"))
        settings.max_tokens = _as_int(raw.get("max_tokens"))
        settings.reasoning = str(raw.get("reasoning") or "default")
        settings.remember_key = bool(raw.get("remember_key"))
        settings.api_key = str(raw.get("api_key") or "")
        settings.last_agent = str(raw.get("last_agent") or "operator")
        settings.crm_url = str(raw.get("crm_url") or "http://localhost:3000")
        settings.crm_email = str(raw.get("crm_email") or "")
        settings.crm_session_token = str(raw.get("crm_session_token") or "")
        raw_profile = raw.get("crm_profile")
        if isinstance(raw_profile, dict):
            settings.crm_profile = dict(raw_profile)
        values = raw.get("agent_values")
        if isinstance(values, dict):
            for agent_id, fields in values.items():
                if isinstance(fields, dict):
                    settings.agent_values[str(agent_id)] = dict(fields)
        return settings

    def describe(self) -> str:
        """Одна строка для статусной панели: без секретов."""
        return (
            f"{PROVIDER_PRESETS.get(self.provider, {}).get('label', self.provider)} · "
            f"{self.resolved_model() or 'модель не выбрана'} · "
            f"ключ {mask_secret(self.api_key)}"
        )


def _as_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def load(path: Path | None = None) -> LaunchSettings:
    target = path or config_path()
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return LaunchSettings()
    if not isinstance(raw, dict):
        return LaunchSettings()
    return LaunchSettings.from_dict(raw)


def save(settings: LaunchSettings, path: Path | None = None) -> Path:
    target = path or config_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(settings.to_dict(), ensure_ascii=False, indent=2)
    target.write_text(payload, encoding="utf-8")
    # На Unix ключ не должен читать кто попало.
    try:
        os.chmod(target, 0o600)
    except OSError:
        pass
    return target


def known_agent_ids(agents: Iterable[AgentSpec]) -> list[str]:
    return [spec.id for spec in agents]
