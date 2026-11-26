# -*- coding: utf-8 -*-
"""Клиент REST API CRM для лаунчера (только стандартная библиотека).

Отвечает за двухэтапный вход:
  1. Проверка доступности сервера CRM (`GET /api/health`);
  2. Авторизация по email и паролю (`POST /api/launcher/login`),
     получение Bearer-сессии, ограничений роли и автотокена Оператора;
  3. Обновление профиля/прав (`GET /api/launcher/profile`) и выход (`POST /api/launcher/logout`).
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, Mapping, Optional, Tuple


class CrmClientError(RuntimeError):
    """Понятная пользователю ошибка связи или доступа CRM."""

    def __init__(self, message: str, *, requires_totp: bool = False) -> None:
        super().__init__(message)
        self.requires_totp = requires_totp


_ORIG_URLOPEN = urllib.request.urlopen


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        raise urllib.error.HTTPError(
            newurl,
            code,
            "HTTP-редиректы на сервере CRM запрещены политикой безопасности",
            headers,
            fp,
        )


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirectHandler)
_NO_REDIRECT_LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirectHandler)


def _is_loopback_host(host: str) -> bool:
    clean = (host or "").strip().lower().strip("[]").rstrip(".")
    return clean in ("localhost", "127.0.0.1", "::1") or clean.endswith(".localhost")


def _is_local_or_lan_host(host: str) -> bool:
    clean = (host or "").strip().lower().strip("[]").rstrip(".")
    if not clean:
        return False
    if _is_loopback_host(clean):
        return True
    if "%" in clean:
        clean = clean.split("%", 1)[0]
    try:
        ip = ipaddress.ip_address(clean)
        if ip.is_unspecified or ip.is_link_local or ip.is_multicast:
            return False
        if ip.is_loopback or ip.is_private:
            return clean != "fd00:ec2::254"
        return isinstance(ip, ipaddress.IPv4Address) and ip in ipaddress.ip_network("100.64.0.0/10")
    except ValueError:
        pass
    if clean in ("host.docker.internal", "gateway.docker.internal"):
        return True
    return clean.endswith((".local", ".lan", ".home", ".home.arpa", ".internal")) or (
        "." not in clean and len(clean) <= 63
    )


def normalize_server_url(raw: str) -> str:
    url = (raw or "").strip().rstrip("/")
    if not url:
        return ""
    if not (url.startswith("http://") or url.startswith("https://")):
        host_part = url.split("/", 1)[0]
        host_only = host_part[1:].split("]", 1)[0] if host_part.startswith("[") else host_part.split(":", 1)[0]
        scheme = "http://" if _is_local_or_lan_host(host_only) else "https://"
        url = scheme + url
    return url.rstrip("/")


def _assert_safe_crm_transport(url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise CrmClientError("Некорректный URL CRM (нужен http:// для локальной сети / localhost или https://)")
    host = parsed.hostname or ""
    if parsed.scheme == "http" and not _is_local_or_lan_host(host) and os.environ.get("CRM_LAUNCHER_ALLOW_HTTP") != "1":
        raise CrmClientError("Для удалённого сервера CRM требуется HTTPS (http:// разрешён только для localhost и локальной сети)")


def _request_json(
    method: str,
    url: str,
    payload: Optional[Mapping[str, Any]] = None,
    bearer_token: str = "",
    timeout: float = 12.0,
) -> Tuple[int, Dict[str, Any]]:
    _assert_safe_crm_transport(url)
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if payload is not None:
        req.add_header("Content-Type", "application/json")
    if bearer_token.strip():
        tok = bearer_token.strip()
        req.add_header("Authorization", f"Bearer {tok}")
        req.add_header("Cookie", f"crm_session={tok}")

    try:
        host = urllib.parse.urlparse(url).hostname or ""
        opener = _NO_REDIRECT_LOCAL_OPENER if _is_local_or_lan_host(host) else _NO_REDIRECT_OPENER
        ctx = (
            opener.open(req, timeout=timeout)
            if urllib.request.urlopen is _ORIG_URLOPEN
            else urllib.request.urlopen(req, timeout=timeout)
        )
        with ctx as resp:
            raw_body = resp.read().decode("utf-8", "replace")
            try:
                parsed = json.loads(raw_body or "{}")
            except json.JSONDecodeError:
                parsed = {}
            return int(getattr(resp, "status", 200) or 200), parsed if isinstance(parsed, dict) else {}
    except urllib.error.HTTPError as exc:
        raw_err = exc.read().decode("utf-8", "replace")
        try:
            err_json = json.loads(raw_err or "{}")
        except json.JSONDecodeError:
            err_json = {}
        msg = ""
        if isinstance(err_json, dict) and err_json.get("error"):
            msg = str(err_json["error"])
        if not msg:
            msg = f"HTTP {exc.code}"
        if exc.code == 401:
            needs_totp = bool(isinstance(err_json, dict) and err_json.get("requiresTotp"))
            raise CrmClientError(
                msg or "Неверный логин/пароль или сессия истекла",
                requires_totp=needs_totp,
            ) from exc
        if exc.code == 403:
            raise CrmClientError(msg or "Доступ к этой функции запрещён") from exc
        if exc.code == 429:
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            hint = f" Повторите через {retry_after} сек." if retry_after else ""
            raise CrmClientError(msg or f"Слишком много попыток.{hint}") from exc
        raise CrmClientError(msg) from exc
    except urllib.error.URLError as exc:
        raise CrmClientError(f"Не удалось подключиться к CRM ({exc.reason})") from exc
    except ValueError as exc:
        raise CrmClientError(f"Некорректный адрес CRM: {exc}") from exc


def check_health(server_url: str, timeout: float = 8.0) -> Tuple[bool, str]:
    """Шаг 1: проверяет, что по указанному URL действительно запущена CRM."""
    clean = normalize_server_url(server_url)
    if not clean:
        return False, "Укажите адрес сервера CRM (например, http://localhost:3000)"
    probe = secrets.token_hex(12)
    expected_ack = hashlib.sha256(f"nova-crm-health:{probe}".encode("utf-8")).hexdigest()
    try:
        status, data = _request_json(
            "GET",
            f"{clean}/api/health?probe={urllib.parse.quote(probe)}",
            timeout=timeout,
        )
    except CrmClientError as exc:
        return False, str(exc)
    if status != 200 or not data.get("ok"):
        return False, "Сервер ответил, но не подтвердил статус CRM (/api/health)"
    if str(data.get("app") or "") != "nova-crm" or str(data.get("probeAck") or "") != expected_ack:
        return False, "Сервер ответил, но не прошёл проверку подлинности ответа (/api/health)"
    return True, f"CRM доступна ({clean})"


def login(
    server_url: str,
    email: str,
    password: str,
    timeout: float = 15.0,
    totp_code: str = "",
) -> Dict[str, Any]:
    """Шаг 2: вход в аккаунт CRM по логину и паролю (+ при необходимости 2FA)."""
    clean = normalize_server_url(server_url)
    if not clean:
        raise CrmClientError("Сначала укажите и проверьте URL CRM")
    clean_email = (email or "").strip()
    if not clean_email or not password:
        raise CrmClientError("Введите email и пароль от аккаунта CRM")
    payload: Dict[str, Any] = {"email": clean_email, "password": password, "serverUrl": clean}
    if totp_code.strip():
        payload["totpCode"] = totp_code.strip()
    _status, data = _request_json(
        "POST",
        f"{clean}/api/launcher/login",
        payload,
        timeout=timeout,
    )
    if not data.get("ok") or not data.get("sessionToken"):
        raise CrmClientError(str(data.get("error") or "Не удалось войти в CRM"))
    return data


def fetch_profile(server_url: str, session_token: str, timeout: float = 12.0) -> Dict[str, Any]:
    """Обновляет профиль, ограничения роли и авто-токен Оператора по сессии."""
    clean = normalize_server_url(server_url)
    if not clean or not session_token.strip():
        raise CrmClientError("Нет активной сессии CRM")
    _status, data = _request_json(
        "GET",
        f"{clean}/api/launcher/profile",
        bearer_token=session_token,
        timeout=timeout,
    )
    if not data.get("ok"):
        raise CrmClientError(str(data.get("error") or "Не удалось загрузить профиль CRM"))
    return data


def logout(server_url: str, session_token: str, timeout: float = 6.0) -> None:
    clean = normalize_server_url(server_url)
    if not clean or not session_token.strip():
        return
    try:
        _request_json("POST", f"{clean}/api/launcher/logout", {}, bearer_token=session_token, timeout=timeout)
    except CrmClientError:
        pass


def profile_limits(profile: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    if not isinstance(profile, Mapping):
        return {}
    limits = profile.get("limits")
    return dict(limits) if isinstance(limits, Mapping) else {}


def profile_user(profile: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    if not isinstance(profile, Mapping):
        return {}
    user = profile.get("user")
    return dict(user) if isinstance(user, Mapping) else {}


def clamp_reasoning(requested: str, allowed: Optional[Iterable[str]]) -> str:
    clean = (requested or "default").strip().lower() or "default"
    allowed_list = [str(item).strip().lower() for item in (allowed or []) if str(item).strip()]
    if not allowed_list:
        return clean
    if clean in allowed_list:
        return clean
    return allowed_list[0] if "default" not in allowed_list else "default"


def clamp_max_steps(requested: Optional[int], limit_max_steps: Optional[int], unlimited: bool) -> Optional[int]:
    if unlimited or limit_max_steps is None or int(limit_max_steps) <= 0:
        return requested
    cap = int(limit_max_steps)
    if requested is None or int(requested) <= 0:
        return cap
    return min(int(requested), cap)


def can_launch_agent(agent_id: str, profile: Optional[Mapping[str, Any]]) -> Tuple[bool, str]:
    """Проверяет, разрешён ли запуск выбранного агента по правам аккаунта CRM."""
    user = profile_user(profile)
    if not user:
        return False, "Запуск возможен только после входа в аккаунт CRM."

    can_agent = bool(user.get("canUseAgent"))
    can_operator = bool(user.get("canUseOperator"))

    if agent_id == "operator":
        if not can_operator:
            return False, "У вашего аккаунта нет доступа к «Оператору». Обратитесь к главному администратору."
        return True, ""

    if agent_id == "chat_agent":
        if not can_agent:
            return False, "У вашего аккаунта нет доступа к «Агенту». Обратитесь к главному администратору."
        return True, ""

    if not (can_agent or can_operator):
        return False, "У вашего аккаунта нет доступа ни к Агенту, ни к Оператору CRM."
    return True, ""


def is_local_model_url(raw_url: str) -> bool:
    """True, если адрес модели указывает на локальный ПК или локальную сеть (LM Studio/Ollama)."""
    clean = (raw_url or "").strip()
    if not clean:
        return False
    try:
        parsed = urllib.parse.urlparse(clean if "://" in clean else f"http://{clean}")
        return _is_local_or_lan_host(parsed.hostname or "")
    except ValueError:
        return False


def open_crm_stream(
    method: str,
    server_url: str,
    path_and_query: str,
    *,
    bearer_token: str = "",
    body: Optional[bytes] = None,
    headers: Optional[Mapping[str, str]] = None,
    timeout: float = 120.0,
):
    """Открывает сырой HTTP-ответ от CRM (для проксирования JSON, SSE и файлов)."""
    base = normalize_server_url(server_url)
    if not base:
        raise CrmClientError("Не указан адрес сервера CRM")
    rel = path_and_query if path_and_query.startswith("/") else f"/{path_and_query}"
    full_url = f"{base}{rel}"
    _assert_safe_crm_transport(full_url)

    req = urllib.request.Request(full_url, data=body, method=method.upper())
    for k, v in (headers or {}).items():
        if k.lower() in ("host", "cookie", "authorization", "content-length", "connection"):
            continue
        req.add_header(k, v)
    if bearer_token.strip():
        tok = bearer_token.strip()
        req.add_header("Authorization", f"Bearer {tok}")
        req.add_header("Cookie", f"crm_session={tok}")

    host = urllib.parse.urlparse(full_url).hostname or ""
    opener = _NO_REDIRECT_LOCAL_OPENER if _is_local_or_lan_host(host) else _NO_REDIRECT_OPENER
    if urllib.request.urlopen is _ORIG_URLOPEN:
        return opener.open(req, timeout=timeout)
    return urllib.request.urlopen(req, timeout=timeout)

