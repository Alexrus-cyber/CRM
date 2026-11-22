# -*- coding: utf-8 -*-
"""Настройки приложения: провайдер модели, общие параметры и значения полей.

Хранятся в JSON рядом с пользовательскими данными:
    Windows: %APPDATA%\\CRM Agents\\launcher.json
    Linux/macOS: ~/.config/crm-agents/launcher.json
Переопределяется переменной CRM_LAUNCHER_CONFIG (удобно для переносимой сборки
на флешке: `CRM_LAUNCHER_CONFIG=./settings.json`).
"""

from __future__ import annotations

import base64
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, Mapping

from launcher.catalog import PROVIDER_PRESETS, AgentSpec


def _dpapi_protect(plaintext: str) -> str | None:
    if not sys.platform.startswith("win") or not plaintext:
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class DATA_BLOB(ctypes.Structure):
            _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]

        raw = plaintext.encode("utf-8")
        buf = (ctypes.c_byte * len(raw)).from_buffer_copy(raw)
        in_blob = DATA_BLOB(len(raw), buf)
        out_blob = DATA_BLOB()
        if not ctypes.windll.crypt32.CryptProtectData(  # type: ignore[attr-defined]
            ctypes.byref(in_blob), "NovaCRM", None, None, None, 0x01, ctypes.byref(out_blob)
        ):
            return None
        try:
            protected = ctypes.string_at(out_blob.pbData, out_blob.cbData)
            return "dpapi:" + base64.b64encode(protected).decode("ascii")
        finally:
            ctypes.windll.kernel32.LocalFree(out_blob.pbData)  # type: ignore[attr-defined]
    except Exception:
        return None


def _dpapi_unprotect(stored: str) -> str:
    if not stored.startswith("dpapi:"):
        return stored
    if not sys.platform.startswith("win"):
        return ""
    try:
        import ctypes
        from ctypes import wintypes

        class DATA_BLOB(ctypes.Structure):
            _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]

        raw = base64.b64decode(stored[6:].encode("ascii"))
        buf = (ctypes.c_byte * len(raw)).from_buffer_copy(raw)
        in_blob = DATA_BLOB(len(raw), buf)
        out_blob = DATA_BLOB()
        if not ctypes.windll.crypt32.CryptUnprotectData(  # type: ignore[attr-defined]
            ctypes.byref(in_blob), None, None, None, None, 0x01, ctypes.byref(out_blob)
        ):
            return ""
        try:
            return ctypes.string_at(out_blob.pbData, out_blob.cbData).decode("utf-8", "replace")
        finally:
            ctypes.windll.kernel32.LocalFree(out_blob.pbData)  # type: ignore[attr-defined]
    except Exception:
        return ""


def _protect_secret(value: str) -> str:
    clean = (value or "").strip()
    if not clean:
        return ""
    dpapi = _dpapi_protect(clean)
    return dpapi if dpapi else clean


def _unprotect_secret(value: str) -> str:
    clean = str(value or "")
    if clean.startswith("dpapi:"):
        return _dpapi_unprotect(clean)
    return clean


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
        safe_values: Dict[str, Dict[str, Any]] = {
            agent_id: dict(fields) for agent_id, fields in self.agent_values.items()
        }
        safe_profile = dict(self.crm_profile) if isinstance(self.crm_profile, dict) else {}
        if not self.remember_key:
            for fields in safe_values.values():
                fields.pop("crm_token", None)
            if isinstance(safe_profile.get("operator"), dict):
                op_copy = dict(safe_profile["operator"])
                op_copy.pop("token", None)
                safe_profile["operator"] = op_copy
        elif sys.platform.startswith("win"):
            op_fields = safe_values.get("operator")
            if isinstance(op_fields, dict) and op_fields.get("crm_token"):
                op_fields["crm_token"] = _protect_secret(str(op_fields["crm_token"]))

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
            "agent_values": safe_values,
            "crm_url": self.crm_url,
            "crm_email": self.crm_email,
            "crm_profile": safe_profile,
        }
        # Ключ и токен сессии CRM не пишутся на диск без явного согласия пользователя (remember_key),
        # а на Windows дополнительно шифруются через DPAPI.
        if self.remember_key:
            if self.api_key:
                data["api_key"] = _protect_secret(self.api_key)
            if self.crm_session_token:
                data["crm_session_token"] = _protect_secret(self.crm_session_token)
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
        settings.api_key = _unprotect_secret(str(raw.get("api_key") or ""))
        settings.last_agent = str(raw.get("last_agent") or "operator")
        settings.crm_url = str(raw.get("crm_url") or "http://localhost:3000")
        settings.crm_email = str(raw.get("crm_email") or "")
        settings.crm_session_token = _unprotect_secret(str(raw.get("crm_session_token") or ""))
        raw_profile = raw.get("crm_profile")
        if isinstance(raw_profile, dict):
            settings.crm_profile = dict(raw_profile)
        values = raw.get("agent_values")
        if isinstance(values, dict):
            for agent_id, fields in values.items():
                if isinstance(fields, dict):
                    copied = dict(fields)
                    if "crm_token" in copied and str(copied["crm_token"]).startswith("dpapi:"):
                        copied["crm_token"] = _unprotect_secret(str(copied["crm_token"]))
                    settings.agent_values[str(agent_id)] = copied
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
