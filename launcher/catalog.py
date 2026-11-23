# -*- coding: utf-8 -*-
"""Каталог агентов, которых умеет запускать приложение.

Агент описывается декларативно: где лежит скрипт, какие поля показать в форме,
что ему нужно (экран/модель/CRM) и как собрать аргументы/переменные окружения.
Чтобы добавить своего агента, достаточно дописать `AgentSpec` в `DEFAULT_AGENTS`
(или положить его описание в `agents.json` рядом с exe — см. `load_catalog`).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, Tuple


# Провайдеры OpenAI-совместимых API: адрес и модель по умолчанию.
# Те же пресеты, что у оператора (`agent/desktop_operator.py`), чтобы в exe и
# в CRM-интерфейсе были одинаковые значения.
PROVIDER_PRESETS: Dict[str, Dict[str, str]] = {
    "local": {"label": "Локальный сервер", "base_url": "http://127.0.0.1:8000/v1",
              "model": "Qwen/Qwen3-VL-8B-Instruct"},
    "openai": {"label": "OpenAI", "base_url": "https://api.openai.com/v1", "model": "gpt-4o-mini"},
    "openrouter": {"label": "OpenRouter", "base_url": "https://openrouter.ai/api/v1",
                   "model": "qwen/qwen2.5-vl-72b-instruct"},
    "groq": {"label": "Groq", "base_url": "https://api.groq.com/openai/v1",
             "model": "meta-llama/llama-4-scout-17b-16e-instruct"},
    "deepseek": {"label": "DeepSeek", "base_url": "https://api.deepseek.com/v1", "model": "deepseek-flash"},
    "together": {"label": "Together", "base_url": "https://api.together.xyz/v1",
                 "model": "Qwen/Qwen2.5-VL-72B-Instruct-Turbo"},
    "mistral": {"label": "Mistral", "base_url": "https://api.mistral.ai/v1", "model": "pixtral-12b-2409"},
}

REASONING_MODES: Tuple[Tuple[str, str], ...] = (
    ("default", "По умолчанию"),
    ("off", "Без раздумий"),
    ("low", "Коротко"),
    ("medium", "Средне"),
    ("high", "Глубоко"),
    ("max", "Максимум"),
)

TRUST_LEVELS: Tuple[Tuple[str, str], ...] = (
    ("verified", "Полный доступ, но с проверкой данных"),
    ("full", "Дать полный доступ"),
    ("none", "Нет доступа к компьютеру"),
)

TASK_MODES: Tuple[Tuple[str, str], ...] = (
    ("autonomous", "Автопилот (обычная задача)"),
    ("copilot", "Помощник на ПК (пошагово)"),
    ("game", "Игра / управление персонажем"),
)

COACH_MODES: Tuple[Tuple[str, str], ...] = (
    ("after_step", "Подсказывать после каждого шага"),
    ("agent", "Агент подсказывает после каждого шага"),
    ("off", "Без подсказок после шага"),
)


@dataclass(frozen=True)
class Field:
    """Поле формы агента. GUI рисует его по `kind`, сборщик команд читает по `key`."""

    key: str
    label: str
    kind: str = "text"  # text | secret | bool | int | float | choice | file | folder
    default: Any = ""
    choices: Tuple[Tuple[str, str], ...] = ()
    hint: str = ""
    placeholder: str = ""


@dataclass(frozen=True)
class AgentSpec:
    id: str
    title: str
    subtitle: str
    description: str
    # Имя файла в папке агентов; пусто — скрипт выбирает пользователь.
    script: str = ""
    fields: Tuple[Field, ...] = ()
    requires: Tuple[str, ...] = ()  # screen | model | crm | python
    docs: str = ""
    # Шаблон адреса, который открывается после запуска (`{port}` подставляется).
    open_url: str = ""
    color: str = "#7c5cff"

    def field_defaults(self) -> Dict[str, Any]:
        return {item.key: item.default for item in self.fields}

    def field(self, key: str) -> Field | None:
        for item in self.fields:
            if item.key == key:
                return item
        return None


OPERATOR = AgentSpec(
    id="operator",
    title="Оператор рабочего стола",
    subtitle="кликает, печатает, делает файлы",
    description=(
        "Бот смотрит на экран, выполняет задания из CRM или разовую команду: "
        "клики, ввод текста, горячие клавиши, сборка файлов. После каждого действия "
        "проверяет результат по свежему скриншоту и не повторяет одно и то же действие."
    ),
    script="desktop_operator.py",
    requires=("screen", "model", "crm"),
    docs="agent/OPERATOR.md",
    color="#7c5cff",
    fields=(
        Field("mode", "Режим работы", "choice", "watch", choices=(
            ("watch", "Слушать очередь CRM"),
            ("once", "Взять одно задание из CRM"),
            ("task", "Разовое задание (без CRM)"),
        )),
        Field("task", "Разовое задание", "text", "", placeholder="Открой блокнот и запиши «привет»"),
        Field("crm_server", "Адрес CRM", "text", "http://localhost:3000"),
        Field("crm_token", "Токен агента", "secret", "",
              hint="Берётся в CRM: «Оператор» → «Токен агента»."),
        Field("max_steps", "Предел шагов (0 — из задания)", "int", 0),
        Field("delay", "Пауза между шагами, сек", "float", 0.8),
        Field("trust_level", "Уровень доверия ИИ", "choice", "verified", choices=TRUST_LEVELS,
              hint="При проверке данных опасные действия, команды и экспорт просят согласие на сайте."),
        Field("task_mode", "Стиль работы Оператора", "choice", "autonomous", choices=TASK_MODES,
              hint="В игровом режиме доступны удержание клавиш (WASD/Shift/Space), поворот камеры и серии."),
        Field("coach_mode", "Помощь после каждого действия", "choice", "after_step", choices=COACH_MODES),
        Field("yes", "Не спрашивать в консоли (--yes)", "bool", False),
        Field("dry_run", "Dry-run: только планировать", "bool", False),
        Field("text_only", "Без скриншотов (модель без vision)", "bool", False),
        Field("verify", "Проверять экран после каждого действия", "bool", True),
        Field("repeat_nudge", "Подсказывать при зацикливании", "bool", True),
        Field("self_reflect", "Разбирать неудачи (вопрос себе)", "bool", True),
    ),
)

CHAT_AGENT = AgentSpec(
    id="chat_agent",
    title="Агент с инструментами",
    subtitle="файлы, сайты, видео",
    description=(
        "Агент для вкладки «Агент» на странице /ai: разговаривает с моделью и умеет "
        "создавать файлы (docx, xlsx, csv, md, zip…), открывать сайты и включать видео. "
        "Поднимает локальный сервер и ждёт запросы CRM."
    ),
    script="agent.py",
    requires=("model",),
    docs="agent/README.md",
    open_url="http://127.0.0.1:{port}/",
    color="#22a06b",
    fields=(
        Field("host", "Адрес прослушивания", "text", "127.0.0.1",
              hint="127.0.0.1 — только этот ПК; 0.0.0.0 — доступ из локальной сети (LAN / Docker)"),
        Field("port", "Порт", "int", 8899),
        Field("max_steps", "Предел шагов на задачу", "int", 500),
        Field("trust_level", "Уровень доверия ИИ", "choice", "verified", choices=TRUST_LEVELS),
        Field("workspace", "Папка для файлов агента", "folder", ""),
        Field("open_browser", "Открыть адрес после запуска", "bool", True),
    ),
)

CUSTOM = AgentSpec(
    id="custom",
    title="Свой агент",
    subtitle="любой ваш .py",
    description=(
        "Запуск собственного скрипта: укажите файл и аргументы. Модель передаётся "
        "переменными AGENT_BASE_URL / AGENT_MODEL / AGENT_API_KEY, если скрипт их читает. "
        "Для своих скриптов нужен Python на машине (в exe он есть только для "
        "встроенных агентов)."
    ),
    requires=("python",),
    color="#d98c00",
    fields=(
        Field("script_path", "Python-файл агента", "file", "", hint="Например, D:\\bots\\my_agent.py"),
        Field("args", "Аргументы", "text", "", hint="Через пробелы, кавычки работают"),
        Field("cwd", "Рабочая папка", "folder", "", hint="Пусто — папка скрипта"),
        Field("pass_model_env", "Передать модель через AGENT_* переменные", "bool", True),
    ),
)

DEFAULT_AGENTS: Tuple[AgentSpec, ...] = (OPERATOR, CHAT_AGENT, CUSTOM)


def load_catalog(extra_path: Path | None = None) -> Tuple[AgentSpec, ...]:
    """Встроенные агенты + необязательный `agents.json` рядом с приложением.

    Формат файла:
        {"agents": [{"id": "...", "title": "...", "script": "my_agent.py",
                     "fields": [{"key": "arg", "label": "Аргумент", "kind": "text"}]}]}
    """
    agents = list(DEFAULT_AGENTS)
    if extra_path is None or not extra_path.is_file():
        return tuple(agents)

    try:
        data = json.loads(extra_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return tuple(agents)

    known = {spec.id for spec in agents}
    for item in data.get("agents", []) if isinstance(data, dict) else []:
        if not isinstance(item, dict):
            continue
        agent_id = str(item.get("id") or "").strip()
        title = str(item.get("title") or "").strip()
        if not agent_id or not title or agent_id in known:
            continue
        fields = tuple(
            Field(
                key=str(raw.get("key") or ""),
                label=str(raw.get("label") or raw.get("key") or ""),
                kind=str(raw.get("kind") or "text"),
                default=raw.get("default", ""),
                choices=tuple(
                    (str(choice[0]), str(choice[1]))
                    for choice in raw.get("choices", [])
                    if isinstance(choice, (list, tuple)) and len(choice) == 2
                ),
                hint=str(raw.get("hint") or ""),
            )
            for raw in item.get("fields", [])
            if isinstance(raw, dict) and raw.get("key")
        )
        agents.append(AgentSpec(
            id=agent_id,
            title=title,
            subtitle=str(item.get("subtitle") or "свой агент"),
            description=str(item.get("description") or ""),
            script=str(item.get("script") or ""),
            fields=fields,
            requires=tuple(str(value) for value in item.get("requires", [])),
            docs=str(item.get("docs") or ""),
            open_url=str(item.get("open_url") or ""),
            color=str(item.get("color") or "#7c5cff"),
        ))
        known.add(agent_id)
    return tuple(agents)


def agent_by_id(agents: Iterable[AgentSpec], agent_id: str) -> AgentSpec | None:
    for spec in agents:
        if spec.id == agent_id:
            return spec
    return None
