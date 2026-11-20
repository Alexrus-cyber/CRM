#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CRM Desktop Operator — агент, который управляет рабочим столом.

Сделан на основе «Qwen Screen Operator»: скриншот → модель → действие мышью и
клавиатурой. Отличия для CRM:

  * задания приходят из CRM (вкладка «Оператор» в блоке ИИ) — бот забирает их
    из очереди по токену, а не из отдельного веб-интерфейса;
  * решение принимает сам бот: модель может быть локальной (vLLM/llama.cpp)
    или облачной через API (OpenAI, OpenRouter, Groq, DeepSeek, Together…),
    ключ остаётся на машине пользователя и в CRM не попадает;
  * кроме кликов бот умеет собирать файлы (docx, xlsx, csv, md, html, svg,
    zip…) и сразу отправлять их в чат в браузере;
  * есть режим одной задачи из консоли без CRM: --task "…".

Запуск:
    pip install -r agent/requirements.txt
    python3 agent/desktop_operator.py --watch --token ТОКЕН --provider openrouter \
        --model qwen/qwen2.5-vl-72b-instruct --api-key sk-...

    python3 agent/desktop_operator.py --task "Открой блокнот и напиши план на день"
    python3 agent/desktop_operator.py --self-test        # без экрана и зависимостей

Опасные действия (удаление, покупки, переводы) спрашивают подтверждение;
--yes отключает вопрос, --dry-run только планирует. Аварийная остановка —
резко уведите курсор в левый верхний угол экрана.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import random
import os
import platform
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    import fileforge
except ImportError:  # запуск из другой папки
    fileforge = None  # type: ignore

pyautogui = None
PYAUTOGUI_ERROR: Optional[BaseException] = None
try:
    import pyautogui  # type: ignore
except Exception as exc:  # нет дисплея, не установлен пакет и т.п.
    PYAUTOGUI_ERROR = exc

try:
    from PIL import Image, ImageDraw, ImageFont  # нужны для скриншотов и проверки зрения
except ImportError:
    Image = None
    ImageDraw = None
    ImageFont = None

try:
    import pyperclip  # type: ignore  # кириллица через буфер обмена
except ImportError:
    pyperclip = None

DEFAULT_SERVER = os.environ.get("CRM_SERVER", "http://localhost:3000")
DEFAULT_TOKEN = os.environ.get("CRM_AGENT_TOKEN", "")
DEFAULT_MAX_WIDTH = 1600
MAX_IMAGE_BYTES = 3_000_000
FILES_DIR = Path(__file__).resolve().parent / "files"

# Провайдеры OpenAI-совместимых API: адрес + модель по умолчанию.
PROVIDERS: Dict[str, Dict[str, str]] = {
    "local": {"base_url": "http://127.0.0.1:8000/v1", "model": "Qwen/Qwen3-VL-8B-Instruct",
              "key_env": "OPERATOR_API_KEY"},
    "openai": {"base_url": "https://api.openai.com/v1", "model": "gpt-4o-mini",
               "key_env": "OPENAI_API_KEY"},
    "openrouter": {"base_url": "https://openrouter.ai/api/v1", "model": "qwen/qwen2.5-vl-72b-instruct",
                   "key_env": "OPENROUTER_API_KEY"},
    "groq": {"base_url": "https://api.groq.com/openai/v1", "model": "meta-llama/llama-4-scout-17b-16e-instruct",
             "key_env": "GROQ_API_KEY"},
    "deepseek": {"base_url": "https://api.deepseek.com/v1", "model": "deepseek-flash",
                 "key_env": "DEEPSEEK_API_KEY"},
    "together": {"base_url": "https://api.together.xyz/v1", "model": "Qwen/Qwen2.5-VL-72B-Instruct-Turbo",
                 "key_env": "TOGETHER_API_KEY"},
    "mistral": {"base_url": "https://api.mistral.ai/v1", "model": "pixtral-12b-2409",
                "key_env": "MISTRAL_API_KEY"},
}

SYSTEM_PROMPT = """Ты — умный оператор рабочего стола внутри CRM. Ты видишь скриншот
экрана пользователя и выполняешь задание осознанно, шаг за шагом.

Не выбирай координаты наугад! Сначала разберись, что происходит на картинке,
задай себе уточняющий вопрос «что мне сейчас делать дальше?» и выбери самый
надёжный способ (горячая клавиша, ввод текста, прокрутка, open_url, клик или finish).

Отвечай ТОЛЬКО одним JSON-объектом без пояснений и без markdown:
{
  "observation": "что сейчас реально видно на скриншоте (активное окно, поля, что изменилось)",
  "next_question": "уточняющий вопрос себе: что мне сейчас делать дальше и почему именно это?",
  "self_check": "если прошлый шаг не удался или экран не изменился — что пошло не так (иначе пусто)",
  "thought": "краткий вывод и план этого шага по-русски",
  "action": {"type": "...", ...}
}

Действия:
- {"type":"click","x":ЧИСЛО,"y":ЧИСЛО,"clicks":1,"button":"left"} — клик по координатам кадра;
- {"type":"double_click","x":..,"y":..} / {"type":"right_click","x":..,"y":..};
- {"type":"type","text":"текст","x":..,"y":..,"clear":false} — кликнуть в поле (x,y) и набрать текст;
  clear=true — сначала очистить поле; без x,y текст уйдёт в то окно, что сейчас активно;
- {"type":"paste","text":"текст","x":..,"y":..} — то же самое длинным текстом через буфер обмена;
- {"type":"hotkey","keys":["ctrl","s"]} — сочетание клавиш;
- {"type":"key","key":"enter"} — одна клавиша;
- {"type":"scroll","amount":-3,"x":..,"y":..} — прокрутка (минус — вниз);
- {"type":"drag","fromX":..,"fromY":..,"toX":..,"toY":..};
- {"type":"wait","seconds":1};
- {"type":"open_url","url":"https://…"} — открыть сайт или видео в браузере;
- {"type":"make_file","name":"план.docx","content":"…"} — сделать файл и отдать в чат;
- {"type":"finish","summary":"что сделано"}.

Правила:
- Координаты — в пикселях скриншота, который ты видишь (его размер указан в задании).
- Текущее положение курсора отмечено на скриншоте красным крестиком: если прошлый
  клик промахнулся, по крестику видно, куда именно попал курсор и насколько нужно
  поправить координаты. Перед кликом курсор наводится сам (лишний action move не нужен).
- Один шаг — одно осознанное действие. Если можно сделать надёжнее без хрупких кликов
  (например, open_url вместо клика по иконке браузера, ctrl+l для адресной строки,
  alt+tab для переключения окна, escape от всплывающего меню, enter для отправки) —
  используй это.
- Писать текст можно только в то поле, куда сначала кликнул. Всегда указывай x и y
  в action type/paste (кроме случаев, когда поле гарантированно уже в фокусе).
- Если просят написать в чате или мессенджере: кликни в поле ввода внизу окна чата,
  набери текст, затем action key с "enter" для отправки. Убедись по скриншоту, что
  текст появился в поле ввода, а не в документе, поиске или адресной строке; если
  попал не туда — остановись, разберись что пошло не так и вернись в нужное окно.
- Не открывай блокнот или документ, если просят написать в чате: работай в том окне,
  которое открыто у пользователя.
- Для файлов используй make_file и укажи расширение: docx (документ с заголовками
  через # и списками), xlsx (строки CSV через ; ), csv, md, html, svg, zip, txt, json.
  Содержимое пиши полностью, по-русски.
- Когда задание выполнено — action finish с кратким итогом.
- Не выдумывай, что видишь: если нужного окна нет, открой его или переключись на него.
- Опасные действия (удаление, переводы, покупки) выполняй, только если пользователь
  прямо об этом попросил; иначе сначала спроси через finish и объясни причину.
"""

TEXT_EXTENSIONS = {
    ".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".html", ".htm",
    ".css", ".js", ".ts", ".tsx", ".py", ".sql", ".log", ".ini", ".toml", ".svg",
}
ZIP_TEXT = {
    ".docx": ("word/document.xml",),
    ".xlsx": ("xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"),
    ".pptx": ("ppt/slides/slide1.xml",),
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}


def extract_attachment_text(name: str, data: bytes, limit: int = 4000) -> str:
    """Текст вложения для модели: txt/csv/md читаем, docx/xlsx — из XML, PDF — нет.

    Бот работает без внешних библиотек, поэтому «офисные» форматы разбираем как
    zip с XML — этого достаточно для плана действий.
    """
    lowered = (name or "").lower()
    extension = "." + lowered.rsplit(".", 1)[-1] if "." in lowered else ""
    if extension in IMAGE_EXTENSIONS:
        return "[изображение: содержимое показать не могу, ориентируйся по имени файла]"
    if extension == ".pdf":
        return "[PDF: содержимое не извлекается без сторонних библиотек]"
    if extension in ZIP_TEXT:
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                parts = []
                for entry in ZIP_TEXT[extension]:
                    if entry in archive.namelist():
                        xml = archive.read(entry).decode("utf-8", "replace")
                        parts.append(re.sub(r"<[^>]+>", " ", xml))
                text = re.sub(r"\s+", " ", " ".join(parts)).strip()
                return text[:limit] or "[пустой документ]"
        except (zipfile.BadZipFile, KeyError, OSError):
            return "[не удалось прочитать архив]"
    if extension in TEXT_EXTENSIONS or not extension:
        try:
            return data.decode("utf-8", "replace")[:limit]
        except Exception:  # noqa: BLE001
            return "[не удалось прочитать как текст]"
    try:
        return data.decode("utf-8", "replace")[:limit]
    except Exception:  # noqa: BLE001
        return "[двоичный файл: содержимое недоступно]"


# Заведомо текстовые модели: картинок не понимают, координаты «придумывают».
# У DeepSeek картинки понимает deepseek-flash; deepseek-chat и deepseek-v4-pro — текст.
MAX_STEPS_LIMIT = 500  # столько шагов разрешает и CRM, и интерфейс

VERIFY_PROMPT = """Ты проверяешь результат действия бота на рабочем столе.
Тебе дают цель шага, описание действия, его результат и свежий скриншот.
Посмотри на экран и честно реши, получилось ли задуманное: открылось ли нужное окно,
появился ли текст в нужном месте, сработала ли кнопка.

Ответь ТОЛЬКО одним JSON-объектом без пояснений и без markdown:
{"ok": true, "note": "одна короткая фраза по-русски, что видно на экране", "why": ""}

ok=false — если действие не удалось, открылось не то окно, текст не появился,
попали мимо цели или экран выглядит так же, как до действия (тогда в why кратко
укажи вероятную причину)."""

SELF_REFLECT_PROMPT = """Ты — оператор рабочего стола, который только что столкнулся с неудачей
или застрял на шаге. Остановись, посмотри на актуальный скриншот и разбери,
что именно ты делаешь не так.

Сначала задай себе уточняющий вопрос по ситуации на экране, потом честно
сформулируй причину (почему прежнее действие не сработало) и конкретный новый
способ действий.

Ответь ТОЛЬКО одним JSON-объектом без пояснений и без markdown:
{
  "question": "короткий вопрос себе: почему действие не сработало или что происходит на экране?",
  "diagnosis": "конкретная причина ошибки (например: окно не в фокусе, промах мимо элемента по крестику курсора, всплывающее окно перекрыло цель, нужна прокрутка или горячая клавиша)",
  "next_strategy": "что конкретно сделать по-другому на следующем шаге (иначе чем раньше)"
}"""


def _strip_thinking(text: str) -> str:
    """Убирает <think>...</think> и markdown-блоки кода вокруг JSON."""
    cleaned = re.sub(r"<think>[\s\S]*?</think>", "", str(text or ""), flags=re.IGNORECASE).strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"\s*```$", "", cleaned, flags=re.MULTILINE)
    return cleaned.strip()


def _extract_json_objects(text: str) -> List[Dict[str, Any]]:
    """Находит все корректные JSON-объекты в ответе модели (даже среди текста)."""
    cleaned = _strip_thinking(text)
    decoder = json.JSONDecoder()
    found: List[Dict[str, Any]] = []
    index = 0
    length = len(cleaned)
    while index < length:
        pos = cleaned.find("{", index)
        if pos < 0:
            break
        try:
            obj, end = decoder.raw_decode(cleaned, pos)
            if isinstance(obj, dict):
                found.append(obj)
            index = end
        except json.JSONDecodeError:
            index = pos + 1
    return found


def frame_signature(image: Any) -> Optional[bytes]:
    """Мини-отпечаток 32×18 кадра в оттенках серого — чтобы видеть, изменился ли экран."""
    if image is None:
        return None
    try:
        resample = getattr(getattr(Image, "Resampling", Image), "BILINEAR", 2)
        thumb = image.convert("L").resize((32, 18), resample)
        return bytes(thumb.getdata())
    except Exception:  # noqa: BLE001
        return None


def frames_similar(sig_a: Optional[bytes], sig_b: Optional[bytes], threshold: float = 1.2) -> bool:
    """True, если два кадра визуально почти не отличаются (ср. разница <= threshold)."""
    if not sig_a or not sig_b or len(sig_a) != len(sig_b):
        return False
    diff = sum(abs(a - b) for a, b in zip(sig_a, sig_b)) / float(len(sig_a))
    return diff <= threshold


def format_decision_thought(decision: Dict[str, Any]) -> str:
    """Собирает понятную человеку мысль шага из наблюдения, вопроса и плана."""
    parts: List[str] = []
    seen: List[str] = []
    for label, key in (("Вижу", "observation"), ("Вопрос", "next_question"),
                       ("Разбор", "self_check"), ("План", "thought")):
        value = str(decision.get(key) or "").strip()
        if not value:
            continue
        low = value.lower()
        if any(low == item or low in item for item in seen):
            continue
        seen.append(low)
        parts.append("{}: {}".format(label, value))
    return " | ".join(parts)


def build_self_question(action: Dict[str, Any], reason: str = "") -> str:
    """Формулирует вопрос самой себе, когда действие не дало результата."""
    label = action_label(action)
    why = " ({})".format((reason or "").strip()[:160]) if reason else ""
    return (
        "Почему у меня не получилось «{}»{}? Что я делаю не так — выбрал(а) неверные "
        "координаты (сравни с красным крестиком курсора), окно не в фокусе, мешает диалог/"
        "меню, нужна прокрутка, горячая клавиша или совсем другой способ?"
    ).format(label, why)


def build_reflection_nudge(reflection: Dict[str, str]) -> str:
    """Подсказка на следующий шаг по итогам собственного разбора ошибки."""
    lines = ["САМОРАЗБОР ПОСЛЕ НЕУДАЧИ (опирайся на него при выборе следующего шага):"]
    if reflection.get("question"):
        lines.append("- Вопрос себе: " + reflection["question"])
    if reflection.get("diagnosis"):
        lines.append("- Что я делал(а) не так: " + reflection["diagnosis"])
    if reflection.get("next_strategy"):
        lines.append("- Как действовать иначе: " + reflection["next_strategy"])
    lines.append("Посмотри на свежий скриншот и выполни новый план (не повторяй старую ошибку).")
    return "\n".join(lines)


def build_step_prompt(prompt: str, step_index: int, shot: Optional[Dict[str, Any]],
                      text_only: bool, pending_nudge: str = "",
                      attachments_context: str = "", last_outcome: str = "",
                      screen_unchanged: bool = False) -> str:
    """Собирает запрос шага: к скриншоту всегда приложен уточняющий вопрос."""
    parts = [
        'Задание: "{}"'.format(prompt),
        "Это шаг {}.".format(step_index + 1),
    ]
    if not text_only and shot:
        parts.append(
            "Размер кадра: {width}×{height} px (координаты клика — в этих пикселях).".format(**shot)
        )
    elif text_only:
        parts.append("Работаем без скриншота: координаты считай по текущему экрану.")
    if last_outcome:
        parts.append("Итог прошлого шага: " + last_outcome)
    if screen_unchanged:
        parts.append(
            "Важное наблюдение: экран после предыдущего шага визуально почти не изменился — "
            "подумай, сработало ли прошлое действие, и не повторяй его вслепую."
        )
    if pending_nudge:
        parts.append(pending_nudge)
    parts.append(
        "Уточняющий вопрос по текущему скриншоту: что именно сейчас открыто и происходит "
        "на экране, что мне делать дальше для достижения цели и почему именно этот шаг "
        "сработает надёжнее (не выдавай просто координаты наугад — оцени, нужен ли клик, "
        "клавиша/сочетание, прокрутка, open_url, make_file или finish)?"
    )
    if attachments_context:
        if step_index == 0:
            parts.append("Файлы от пользователя (используй их содержимое):")
            parts.append(attachments_context)
        else:
            parts.append("Вложения задания уже прочитаны на первом шаге.")
    return "\n".join(parts)

# Защита от зацикливания: сколько раз подряд допустимо одно и то же действие.
# Клик/ввод — 2 раза, клавиши и прокрутка — 3 (прокрутка иногда нужна повторно).
REPEAT_LIMITS = {
    "click": 2,
    "double_click": 2,
    "right_click": 2,
    "type": 2,
    "paste": 2,
    "drag": 2,
    "key": 3,
    "hotkey": 3,
    "scroll": 3,
}
# Сколько «лишних» повторов терпим, прежде чем остановить задание.
MAX_REPEAT_EXTRA = 3


def action_signature(action: Dict[str, Any]) -> str:
    """Отпечаток действия: тип + точка + текст/клавиши.

    Нужен, чтобы отличить «повторил то же самое» от «сделал шаг дальше»:
    координаты округляем, длинный текст сравниваем по длине и началу.
    """
    kind = str(action.get("type") or "")

    def number(*keys: str) -> Optional[int]:
        for key in keys:
            value = action.get(key)
            if value is None:
                continue
            try:
                return int(round(float(value)))
            except (TypeError, ValueError):
                continue
        return None

    parts = [kind]
    x, y = number("x"), number("y")
    if x is not None or y is not None:
        parts.append("{}:{}".format(x, y))
    if kind == "drag":
        parts.append("drag:{}:{}:{}:{}".format(number("fromX"), number("fromY"),
                                               number("toX"), number("toY")))
    text = str(action.get("text") or "")
    if text:
        parts.append("{}:{}".format(len(text), text[:60]))
    keys = action.get("keys")
    if isinstance(keys, list):
        parts.append("+".join(str(key).lower() for key in keys))
    if action.get("key"):
        parts.append(str(action.get("key")).lower())
    if action.get("amount") is not None:
        parts.append("amount:{}".format(action.get("amount")))
    return "|".join(parts)


def action_label(action: Dict[str, Any]) -> str:
    """Короткое человеческое описание действия для подсказки."""
    kind = str(action.get("type") or "действие")
    x, y = action.get("x"), action.get("y")
    if kind in ("type", "paste"):
        text = str(action.get("text") or "")
        where = " в ({}, {})".format(x, y) if x is not None and y is not None else ""
        return "ввод «{}»{}".format(text[:40], where)
    if x is not None and y is not None:
        return "{} в ({}, {})".format(kind, x, y)
    if kind in ("key", "hotkey"):
        keys = action.get("keys") or action.get("key") or ""
        return "{} {}".format(kind, keys)
    return kind


def build_repeat_nudge(action: Dict[str, Any], streak: int) -> str:
    """Вспомогательный промпт, когда бот застрял на одном действии.

    Модель видит его перед следующим шагом: прямо сказано, что повторять
    бессмысленно, и дан список других действий вместо бесконечных раздумий.
    """
    head = (
        "ВАЖНО: это {}-й раз подряд одно и то же действие: {}.\n"
        "Экран от него не меняется — повторять бессмысленно, ты застрял.\n"
    ).format(streak, action_label(action))
    return head + (
        "Посмотри на скриншот, найди, что именно мешает, и выбери ДРУГОЕ действие:\n"
        "- нужное окно не в фокусе → hotkey alt+tab;\n"
        "- поверх открыт диалог или меню → key escape;\n"
        "- элемент не виден → scroll -3 (или +3, если нужно вверх);\n"
        "- программа закрыта → открой её (open_url или меню «Пуск»);\n"
        "- текст не появляется → кликни в поле по координатам, затем type с x и y;\n"
        "- цель уже достигнута → finish с коротким итогом.\n"
        "Не повторяй прежние координаты и не рассуждай бесконечно: выбери один "
        "другой шаг и выполни его. Если выполнить нельзя — finish и объясни, что мешает."
    )



def build_failed_nudge(count: int, note: str) -> str:
    """Подсказка, когда проверка не увидела результата: задаёт модели вопрос себе."""
    return (
        "Проверка {} раз подряд не подтвердила результат (последнее: «{}»).\n"
        "Задай себе вопрос: почему выбранное действие не работает и что я делаю не так? "
        "Не повторяй его: посмотри на красный крестик курсора и смени тактику — "
        "например, Esc от диалога, alt+tab к нужному окну, прокрутка к элементу "
        "или другой способ выполнить задачу. Если не получается — finish и объясни, "
        "что именно мешает."
    ).format(count, (note or "")[:120])



TEXT_ONLY_MODELS = (
    "deepseek-chat", "deepseek-reasoner", "deepseek-v4-pro",
    "gpt-3.5", "llama-3.3", "mixtral",
)
VISION_EXAMPLES = "deepseek-flash, gpt-4o-mini, qwen2.5-vl, llama-4-scout, pixtral-12b, Qwen3-VL"

DANGEROUS = re.compile(
    r"удал|удали|снеси|формат|перевод|оплат|купи|покупк|пароль|delete|rm -rf|format|"
    r"payment|transfer|покупка|очист",
    re.IGNORECASE,
)


class AgentError(RuntimeError):
    """Ошибка, текст которой можно показать пользователю."""


class TaskCancelled(AgentError):
    """Задание отменили в CRM: бот сразу останавливается и ничего не досылает."""


def configure_stdio() -> None:
    """Переводит stdout/stderr на UTF-8 с errors='replace' (важно для Windows cp1251)."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (OSError, ValueError, AttributeError):
                try:
                    reconfigure(errors="replace")
                except (OSError, ValueError, AttributeError):
                    pass


def _safe_print(text: str) -> None:
    """Печать без падения на UnicodeEncodeError в строгой cp1251-консоли/pipe."""
    try:
        print(text, flush=True)
    except UnicodeEncodeError:
        enc = getattr(sys.stdout, "encoding", None) or "ascii"
        safe = text.encode(enc, errors="replace").decode(enc, errors="replace")
        print(safe, flush=True)


def log(message: str) -> None:
    _safe_print(time.strftime("[%H:%M:%S] ") + str(message))


# Значения, которые остаются в команде, если токен не подставлен.
TOKEN_PLACEHOLDERS = {
    "ваш_токен", "ваш-токен", "токен", "token", "<токен>", "<token>", "tok", "...", "…",
}


def normalize_token(raw: str) -> str:
    """Токен из терминала, буфера обмена или документации: без кавычек и переносов.

    Частая причина отказа — скопированная маска «…abcdef» или токен, который
    при вставке разбился на строки. Пробелы внутри токена недопустимы, поэтому
    убираем их целиком.
    """
    token = (raw or "").strip()
    token = token.strip('"').strip("'").strip()
    token = token.strip("«»").strip()
    return "".join(token.split())


def mask_token(token: str) -> str:
    if not token:
        return "—"
    if len(token) <= 12:
        return "…" + token[-4:] if len(token) > 4 else "…"
    return "{}…{}".format(token[:6], token[-4:])


def token_problem(token: str) -> Optional[str]:
    """Понятная причина, почему токен заведомо не подойдёт."""
    if not token:
        return ("Токен не задан. Создайте его во вкладке «Оператор» → «Подключение» "
                "и передайте: --token crmop_…")
    lowered = token.lower()
    if lowered in TOKEN_PLACEHOLDERS:
        return ("В команде остался плейсхолдер «{}». Подставьте настоящий токен из CRM."
                .format(token))
    if lowered.startswith("…") or lowered.startswith("..."):
        return "Это маска из интерфейса, а не токен. Нужен полный токен, начинающийся с crmop_."
    if "<" in token or ">" in token:
        return ("Похоже, в команде остался плейсхолдер «{}» — вставьте настоящий токен из шага 1."
                .format(token))
    if not token.isascii():
        return ("В токене есть нелатинские символы ({}). Скопируйте токен ещё раз — "
                "он состоит только из латиницы, цифр и подчёркиваний.".format(mask_token(token)))
    return None


def require_pyautogui() -> None:
    if pyautogui is None:
        raise SystemExit(
            "\n[!] Не удалось загрузить pyautogui: {}\n"
            "    Установите зависимости: pip install -r agent/requirements.txt\n"
            "    macOS: разрешите терминалу «Запись экрана» и «Универсальный доступ».\n"
            "    Linux: нужен X11 и пакеты python3-tk, scrot.\n".format(PYAUTOGUI_ERROR)
        )


def enable_dpi_awareness() -> None:
    """Windows: без этого pyautogui путает логические и физические пиксели."""
    if platform.system() != "Windows":
        return
    try:
        import ctypes

        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()
        log("Windows DPI awareness включён")
    except Exception as exc:  # noqa: BLE001
        log("Не удалось включить DPI awareness: {}".format(exc))


def map_point(x: Any, y: Any, image_width: int, image_height: int,
              screen_width: int, screen_height: int) -> Tuple[int, int]:
    """Пересчёт координат из пикселей скриншота в пиксели экрана (DPI/Retina)."""
    try:
        value_x = float(x)
        value_y = float(y)
    except (TypeError, ValueError):
        value_x, value_y = 0.0, 0.0
    if not image_width or not image_height or not screen_width or not screen_height:
        return int(round(value_x)), int(round(value_y))

    # Некоторые модели отвечают долями кадра (0…1) вместо пикселей.
    if 0.0 <= value_x < 1.0 and 0.0 <= value_y < 1.0:
        value_x *= float(image_width)
        value_y *= float(image_height)
    mapped_x = int(round(value_x * (float(screen_width) / float(image_width))))
    mapped_y = int(round(value_y * (float(screen_height) / float(image_height))))
    return (max(0, min(int(screen_width) - 1, mapped_x)),
            max(0, min(int(screen_height) - 1, mapped_y)))


def self_test() -> int:
    """Проверка без экрана и зависимостей: координаты + все форматы файлов."""
    checks: List[bool] = []

    def check(name: str, condition: bool) -> None:
        checks.append(condition)
        print("{} {}".format("OK  " if condition else "FAIL", name))

    check("1920x1080 → 1920x1080 (центр)", map_point(960, 540, 1920, 1080, 1920, 1080) == (960, 540))
    check("1440x810 → 1920x1080 (центр)", map_point(720, 405, 1440, 810, 1920, 1080) == (960, 540))
    check("Retina 2560x1600 → 1280x800", map_point(1000, 500, 2560, 1600, 1280, 800) == (500, 250))
    check("обрезка за границей", map_point(5000, -20, 1920, 1080, 1920, 1080) == (1919, 0))
    check("строковые координаты", map_point("100", "50", 1920, 1080, 1920, 1080) == (100, 50))
    check("доли кадра 0.5,0.5 → центр", map_point(0.5, 0.5, 1920, 1080, 1920, 1080) == (960, 540))
    check("доли кадра 0.25,0.75", map_point(0.25, 0.75, 1600, 900, 1920, 1080) == (480, 810))
    check("доли кадра строками", map_point("0.1", "0.2", 1000, 1000, 1000, 1000) == (100, 200))
    check("единица — это пиксель, а не доля", map_point(1, 1, 1920, 1080, 1920, 1080) == (1, 1))

    if fileforge is None:
        check("fileforge импортируется", False)
    else:
        samples = [
            ("план.txt", "строка"),
            ("данные.csv", "a;b\n1;2"),
            ("документ.md", "# Заголовок\n- пункт"),
            ("отчёт.docx", "# Отчёт\n\n- пункт 1\n- пункт 2"),
            ("таблица.xlsx", "Клиент;Сумма\nООО Ромашка;1000"),
            ("схема.svg", "блок 1\nблок 2"),
            ("страница.html", "<h1>Привет</h1>"),
            ("архив.zip", '{"files":[{"name":"a.txt","content":"1"}]}'),
            ("данные.json", '{"a":1}'),
        ]
        for name, content in samples:
            try:
                data, mime, final = fileforge.build(name, content)
                check("{} → {} ({} Б)".format(name, final, len(data)), len(data) > 0 and bool(mime))
            except Exception as error:  # noqa: BLE001
                check("{} ({} )".format(name, error), False)

    # Вложения: текст читаем сами, без внешних библиотек.
    check("вложение txt читается", "привет" in extract_attachment_text("a.txt", "привет".encode()))
    check("вложение csv читается", "1;2" in extract_attachment_text("a.csv", "a;b\n1;2".encode()))
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", "<w:t>План дня</w:t>")
    check("вложение docx читается", "План дня" in extract_attachment_text("a.docx", buffer.getvalue()))
    check("вложение png помечается",
          "изображение" in extract_attachment_text("a.png", b"\x89PNG"))
    check("вложение pdf помечается", "PDF" in extract_attachment_text("a.pdf", b"%PDF-1.4"))

    # Проверка курсора: клик отменяется, если курсор не там, куда его вели.
    class FakeMouse:
        def __init__(self, drift: int) -> None:
            self.drift = drift
            self.pos = (0, 0)

        def size(self) -> Tuple[int, int]:
            return (1920, 1080)

        def moveTo(self, x: int, y: int, duration: float = 0) -> None:
            self.pos = (x + self.drift, y + self.drift)

        def position(self) -> Tuple[int, int]:
            return self.pos

    probe = Operator(crm="", token="", base_url="http://localhost", model="m", api_key="",
                     dry_run=True, assume_yes=True, max_steps=1, delay=0, poll=1,
                     max_width=1280, text_only=True)
    saved_mouse, saved_require = globals().get("pyautogui"), globals().get("require_pyautogui")
    try:
        globals()["pyautogui"] = FakeMouse(0)
        globals()["require_pyautogui"] = lambda: None
        probe.ensure_cursor(500, 300)
        check("курсор встал в точку", globals()["pyautogui"].position() == (500, 300))
        globals()["pyautogui"] = FakeMouse(10)
        try:
            probe.ensure_cursor(500, 300)
            check("промах курсора отменяет клик", False)
        except AgentError as error:
            check("промах курсора отменяет клик", "отменён" in str(error))
        globals()["pyautogui"] = FakeMouse(0)
        try:
            probe.ensure_cursor(5000, 300)
            check("клик вне экрана отменяется", False)
        except AgentError:
            check("клик вне экрана отменяется", True)
    finally:
        globals()["pyautogui"], globals()["require_pyautogui"] = saved_mouse, saved_require

    # Раздумья и генерация: поля запроса и вердикт проверки.
    gen_payload: Dict[str, Any] = {}
    probe.generation = {"reasoning": "budget", "thinking_budget": 2048,
                        "temperature": 0.4, "top_p": 0.9, "max_tokens": 512,
                        "seed": 7, "send_thinking_flag": True}
    probe.apply_generation(gen_payload)
    check("бюджет раздумий → reasoning_effort=high",
          gen_payload.get("reasoning_effort") == "high"
          and gen_payload.get("thinking_budget") == 2048)
    check("temperature/top_p/max_tokens/seed в запросе",
          gen_payload.get("temperature") == 0.4 and gen_payload.get("top_p") == 0.9
          and gen_payload.get("max_tokens") == 512 and gen_payload.get("seed") == 7)
    check("enable_thinking дублируется",
          (gen_payload.get("chat_template_kwargs") or {}).get("enable_thinking") is True)

    off_payload: Dict[str, Any] = {}
    probe.generation = {"reasoning": "off", "send_thinking_flag": True}
    probe.apply_generation(off_payload)
    check("«без раздумий» → reasoning_effort=none",
          off_payload.get("reasoning_effort") == "none"
          and off_payload["chat_template_kwargs"]["enable_thinking"] is False)

    default_payload: Dict[str, Any] = {"temperature": 0.2}
    probe.generation = {"reasoning": "default"}
    probe.apply_generation(default_payload)
    check("«по умолчанию» ничего не добавляет",
          default_payload.get("reasoning_effort") is None
          and default_payload.get("chat_template_kwargs") is None)

    check("вердикт без JSON → None", probe.parse_verdict("не json") is None)
    verdict = probe.parse_verdict('```json\n{"ok": true, "note": "окно открылось"}\n```')
    check("вердикт из ```-блока читается",
          bool(verdict and verdict["ok"] and verdict["note"] == "окно открылось"))
    false_verdict = probe.parse_verdict('{"ok": false, "note": "не видно"}')
    check("вердикт ok=false читается", bool(false_verdict) and false_verdict["ok"] is False)

    probe.generation = {}

    # Антизацикливание: отпечаток действия и текст подсказки.
    check("отпечаток: числа и строки совпадают",
          action_signature({"type": "click", "x": 300, "y": "200"})
          == action_signature({"type": "click", "x": "300", "y": 200}))
    check("отпечаток: другая точка — другое действие",
          action_signature({"type": "click", "x": 300, "y": 200})
          != action_signature({"type": "click", "x": 300, "y": 260}))
    check("отпечаток: другой текст — другое действие",
          action_signature({"type": "type", "text": "привет"})
          != action_signature({"type": "type", "text": "пока"}))
    repeat_text = build_repeat_nudge({"type": "click", "x": 300, "y": 200}, 3)
    check("подсказка про повтор упоминает счётчик",
          "3" in repeat_text and "alt+tab" in repeat_text and "finish" in repeat_text)
    failed_text = build_failed_nudge(2, "не видно результата")
    check("подсказка после неудачной проверки",
          "2 раз" in failed_text and "не подтвердила" in failed_text)
    check("порог повтора у клика 2, у прокрутки 3",
          REPEAT_LIMITS["click"] == 2 and REPEAT_LIMITS["scroll"] == 3)

    # Уточняющий вопрос на шаге, разбор богатого JSON и саморазбор неудачи.
    step_q = build_step_prompt(
        "Открой настройки", 0, {"width": 1600, "height": 900}, False,
        screen_unchanged=True, last_outcome="⚠️ не сработало",
    )
    check("запрос со скриншотом содержит уточняющий вопрос что делать дальше",
          "что мне делать дальше" in step_q and "Уточняющий вопрос" in step_q
          and "почти не изменился" in step_q)

    rich_decision = probe.parse_decision(
        "<think>осматриваю экран</think>\n"
        '{"observation": "открыт рабочий стол", "next_question": "как открыть браузер?", '
        '"thought": "нажму alt+tab", "action": {"type": "hotkey", "keys": ["alt", "tab"]}}'
    )
    check("parse_decision извлекает observation/next_question и пропускает <think>",
          rich_decision["observation"] == "открыт рабочий стол"
          and rich_decision["next_question"] == "как открыть браузер?"
          and rich_decision["action"]["type"] == "hotkey")
    formatted_thought = format_decision_thought(rich_decision)
    check("format_decision_thought объединяет наблюдение, вопрос и план",
          "Вижу:" in formatted_thought and "Вопрос:" in formatted_thought and "План:" in formatted_thought)

    parsed_refl = probe.parse_reflection(
        '```json\n{"question": "почему мимо?", "diagnosis": "окно свернуто", '
        '"next_strategy": "нажать alt+tab"}\n```',
        "по умолчанию",
    )
    check("parse_reflection читает вопрос, диагноз и новый план",
          parsed_refl["question"] == "почему мимо?"
          and parsed_refl["diagnosis"] == "окно свернуто"
          and parsed_refl["next_strategy"] == "нажать alt+tab")

    check("frames_similar различает похожие и разные отпечатки кадра",
          frames_similar(b"\x10" * 576, b"\x11" * 576)
          and not frames_similar(b"\x10" * 576, b"\x90" * 576))

    # Сквозная симуляция неудачи действия → вопрос себе → саморазбор → смена тактики.
    sim_calls: List[Tuple[str, Any]] = []

    class SimHttp:
        def __init__(self) -> None:
            self.step = 0

        def call(self, method: str, path: str, payload: Optional[dict] = None,
                 timeout: int = 30, headers: Optional[dict] = None) -> Dict[str, Any]:
            sys_content = str(((payload or {}).get("messages") or [{}])[0].get("content") or "")
            user_content = ((payload or {}).get("messages") or [{}])[-1].get("content")
            user_text = (
                " ".join(str(p.get("text") or "") for p in user_content if isinstance(p, dict))
                if isinstance(user_content, list) else str(user_content or "")
            )
            sim_calls.append((sys_content[:120], user_text))
            if "проверяешь результат действия" in sys_content:
                if self.step == 1:
                    return {"choices": [{"message": {"content": json.dumps({
                        "ok": False, "note": "окно не открылось", "why": "клик попал мимо иконки"
                    })}}]}
                return {"choices": [{"message": {"content": json.dumps({
                    "ok": True, "note": "нужное окно открылось", "why": ""
                })}}]}
            if "столкнулся с неудачей" in sys_content:
                return {"choices": [{"message": {"content": json.dumps({
                    "question": "почему клик в (100, 100) не открыл окно?",
                    "diagnosis": "курсор правее иконки",
                    "next_strategy": "использовать hotkey alt+tab"
                })}}]}
            self.step += 1
            if self.step == 1:
                return {"choices": [{"message": {"content": json.dumps({
                    "observation": "вижу рабочий стол",
                    "next_question": "что мне делать дальше?",
                    "thought": "кликну по иконке",
                    "action": {"type": "click", "x": 100, "y": 100}
                })}}]}
            if self.step == 2:
                return {"choices": [{"message": {"content": json.dumps({
                    "observation": "прошлый клик промахнулся",
                    "next_question": "что делать иначе?",
                    "self_check": "перехожу к alt+tab по саморазбору",
                    "thought": "переключусь клавишами",
                    "action": {"type": "hotkey", "keys": ["alt", "tab"]}
                })}}]}
            return {"choices": [{"message": {"content": json.dumps({
                "observation": "окно открыто",
                "next_question": "цель достигнута?",
                "thought": "завершаю",
                "action": {"type": "finish", "summary": "окно открыто"}
            })}}]}

    sim_op = Operator(crm="", token="", base_url="http://127.0.0.1:8000/v1",
                      model="sim-vl", api_key="", dry_run=False, assume_yes=True,
                      max_steps=5, delay=0.0, poll=1.0, max_width=1600, text_only=False,
                      vision_check=False, vision_forced=True, verify_actions=True,
                      repeat_nudge=True, self_reflect=True)
    sim_op.model_http = SimHttp()  # type: ignore[assignment]
    sim_shot_counter = {"n": 0}

    def sim_screenshot() -> Tuple[str, Dict[str, Any]]:
        sim_shot_counter["n"] += 1
        val = 10 if sim_shot_counter["n"] <= 2 else 180
        sim_op._last_frame_sig = bytes([val]) * 576
        shot = {"width": 1600, "height": 900, "screen_width": 1600, "screen_height": 900}
        sim_op.last_shot = shot
        return "data:image/jpeg;base64,AA==", shot

    sim_op.screenshot = sim_screenshot  # type: ignore[method-assign]
    sim_op.execute = lambda act: "ok: {}".format(act.get("type"))  # type: ignore[method-assign]
    sim_ok = sim_op.run(None, "Открой окно", 5)
    refl_prompts = [u for s, u in sim_calls if "столкнулся с неудачей" in s]
    step2_prompts = [u for s, u in sim_calls if "умный оператор" in s and "САМОРАЗБОР" in u]
    check("при неудаче бот задаёт вопрос себе, разбирает ошибку и меняет тактику",
          sim_ok and len(refl_prompts) == 1
          and "Почему у меня не получилось" in refl_prompts[0]
          and len(step2_prompts) == 1
          and "использовать hotkey alt+tab" in step2_prompts[0])

    # Проверка вывода кириллицы и «→» при строгой cp1251-кодировке (Windows pipe).
    orig_stdout = sys.stdout
    buf = io.BytesIO()
    try:
        sys.stdout = io.TextIOWrapper(buf, encoding="cp1251", errors="strict")
        log("Ошибка → тест")
        sys.stdout.flush()
        safe_cp_ok = "Ошибка" in buf.getvalue().decode("cp1251", errors="replace")
    except BaseException:  # noqa: BLE001
        safe_cp_ok = False
    finally:
        sys.stdout = orig_stdout
    check("log не падает на символе «→» при cp1251-потоке", safe_cp_ok)

    buf_utf = io.BytesIO()
    try:
        sys.stdout = io.TextIOWrapper(buf_utf, encoding="cp1251", errors="strict")
        configure_stdio()
        log("Ошибка → тест")
        sys.stdout.flush()
        stdio_utf_ok = "Ошибка → тест" in buf_utf.getvalue().decode("utf-8", errors="strict")
    except BaseException:  # noqa: BLE001
        stdio_utf_ok = False
    finally:
        sys.stdout = orig_stdout
    check("configure_stdio переводит cp1251-поток на UTF-8", stdio_utf_ok)

    passed = sum(1 for item in checks if item)
    print("\n{}/{} проверок пройдено".format(passed, len(checks)))
    return 0 if passed == len(checks) else 1


def type_text(text: str) -> None:
    """Ввод текста; кириллица — через буфер обмена, иначе pyautogui пишет мусор."""
    if not text:
        return
    require_pyautogui()
    plain = all(ord(char) < 128 for char in text) and "\n" not in text
    if plain and len(text) <= 200 or pyperclip is None:
        pyautogui.write(text, interval=0.02)
        return
    # Кириллица, переносы строк и длинный текст: pyautogui.write их теряет.
    pyperclip.copy(text)
    modifier = "command" if platform.system() == "Darwin" else "ctrl"
    pyautogui.hotkey(modifier, "v")
    time.sleep(0.05)


class Http:
    """Минимальный HTTP-клиент без внешних зависимостей."""

    def __init__(self, base: str, token: str = "", kind: str = "CRM", key_hint: str = "") -> None:
        self.base = (base or "").rstrip("/")
        self.token = token
        self.kind = kind
        self.key_hint = key_hint

    def call(self, method: str, path: str, payload: Optional[dict] = None,
             timeout: int = 180, headers: Optional[Dict[str, str]] = None) -> dict:
        url = path if path.startswith("http") else self.base + path
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("Content-Type", "application/json")
        if self.token:
            request.add_header("x-agent-token", self.token)
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read().decode("utf-8", "replace")
        except ValueError as error:
            raise AgentError(
                "Запрос к {} не удался: в токене или адресе недопустимые символы ({}).".format(
                    self.kind, error)
            ) from error
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:400]
            if error.code in (409, 410) and self.kind == "CRM":
                cancelled = "cancelled" in detail.lower()
                try:
                    payload = json.loads(detail or "{}")
                    cancelled = cancelled or bool(payload.get("cancelled"))
                except (json.JSONDecodeError, TypeError, AttributeError):
                    pass
                if cancelled:
                    raise TaskCancelled("Задание отменено в CRM") from error
            if error.code == 401 and self.kind == "модель":
                hint = " или переменную {}".format(self.key_hint) if self.key_hint else ""
                raise AgentError(
                    "Модель отклонила ключ API (401) на {}: проверьте --api-key{} — ключ должен быть "
                    "от выбранного провайдера. Во вкладке «Оператор» → «Подключение» есть поле "
                    "«Ключ API». Это не токен CRM.".format(self.base, hint)
                ) from error
            if error.code == 401:
                raise AgentError(
                    "CRM отклонила токен агента (токен {}, сервер {}). Создайте токен заново "
                    "во вкладке «Оператор» → «Подключение» и подставьте его целиком: "
                    "python3 agent/desktop_operator.py --check --server {} --token crmop_…".format(
                        mask_token(self.token), self.base, self.base)
                ) from error
            if error.code == 404 and path.endswith("/whoami"):
                raise AgentError("В этой CRM нет маршрута /api/agent/bot/whoami — обновите CRM.") from error
            raise AgentError("{} {} {} → HTTP {}: {}".format(self.kind, method, url, error.code, detail)) from error
        except urllib.error.URLError as error:
            raise AgentError("{} недоступна ({}): {}".format(
                "Модель" if self.kind == "модель" else "CRM", url, error.reason)) from error
        try:
            return json.loads(body or "{}")
        except json.JSONDecodeError as error:
            raise AgentError("CRM вернула не JSON") from error


    def download(self, path: str, timeout: int = 60) -> bytes:
        """Скачать двоичный файл (вложение задания) с тем же токеном."""
        url = path if path.startswith("http") else self.base + path
        request = urllib.request.Request(url, method="GET")
        if self.token:
            request.add_header("x-agent-token", self.token)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:200]
            if error.code == 401:
                raise AgentError("CRM отклонила токен агента при скачивании вложения") from error
            raise AgentError("GET {} → HTTP {}: {}".format(path, error.code, detail)) from error
        except urllib.error.URLError as error:
            raise AgentError("CRM недоступна ({}): {}".format(url, error.reason)) from error


class Operator:
    def __init__(self, crm: str, token: str, base_url: str, model: str, api_key: str,
                 dry_run: bool, assume_yes: bool, max_steps: int, delay: float,
                 poll: float, max_width: int, text_only: bool, key_hint: str = "",
                 offset_x: int = 0, offset_y: int = 0, vision_check: bool = True,
                 vision_forced: bool = False, cursor_marker: bool = True,
                 generation: Optional[Dict[str, Any]] = None,
                 verify_actions: bool = True, repeat_nudge: bool = True,
                 self_reflect: bool = True) -> None:
        self.crm = Http(crm, token, kind="CRM")
        self.has_crm = bool(crm and token)
        self.model_http = Http(base_url, kind="модель", key_hint=key_hint)
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.dry_run = dry_run
        self.assume_yes = assume_yes
        self.max_steps_cap = max_steps
        self.delay = delay
        self.poll = max(1.0, poll)
        self.max_width = max(640, min(3840, max_width))
        self.text_only = text_only
        self.offset_x = int(offset_x)
        self.offset_y = int(offset_y)
        self.vision_check = vision_check and not vision_forced
        self.vision_forced = vision_forced
        # --vision: считаем модель зрячей и не переключаем её в текстовый режим.
        self.vision_ok: Optional[bool] = True if vision_forced else None
        self.cursor_marker = cursor_marker
        self.attachments_context = ""
        # Раздумья и генерация: те же поля, что в «Чате с моделью».
        self.generation = generation or {}
        self.verify_actions = verify_actions
        self.self_reflect = self_reflect
        self.attachment_images: List[str] = []
        # Антизацикливание: отпечаток последнего действия, серия повторов и
        # подсказка/саморазбор, которые получит модель на следующем шаге.
        self.repeat_nudge_enabled = repeat_nudge
        self.last_signature = ""
        self.repeat_streak = 0
        self.pending_nudge = ""
        self.failed_checks = 0
        self.map_logged = False
        self.last_shot: Optional[Dict[str, Any]] = None
        self._last_frame_sig: Optional[bytes] = None
        self._last_verify_shot: Optional[str] = None
        self._last_screen_unchanged: bool = False
        self.current_task: Optional[int] = None
        self.history: List[str] = []

    # ------------------------------------------------------------- модель
    def ask_model(self, prompt: str, screenshot: Optional[str],
                  extra_images: Optional[List[str]] = None) -> Dict[str, Any]:
        if not self.model:
            raise AgentError("Не указана модель: --model или --provider")

        parts: List[Dict[str, Any]] = []
        if screenshot and not self.text_only:
            parts.append({"type": "image_url", "image_url": {"url": screenshot}})
        for image in (extra_images or [])[:3]:
            if image.startswith("data:image/"):
                parts.append({"type": "image_url", "image_url": {"url": image}})
        content: Any = prompt if not parts else [{"type": "text", "text": prompt}, *parts]
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            *([] if not self.history else [{"role": "user", "content": "Что уже сделано:\n" + "\n".join(self.history[-8:])}]),
            {"role": "user", "content": content},
        ]
        payload = {"model": self.model, "messages": messages, "temperature": 0.2, "stream": False}
        self.apply_generation(payload)
        # Застряли — добавляем разнообразия: при низкой temperature модель
        # послушно выбирает то же самое действие. Своё значение не трогаем.
        if self.pending_nudge and (self.generation or {}).get("temperature") is None:
            payload["temperature"] = 0.7
        headers = {"Authorization": "Bearer " + self.api_key} if self.api_key else {}
        try:
            data = self.model_http.call("POST", "/chat/completions", payload, timeout=180, headers=headers)
        except AgentError as error:
            # Если зрение ещё не подтверждено, а API ругается на картинку —
            # один раз пробуем текстовый режим. Подтверждённую vision-модель
            # вслепую не переключаем: пусть ошибка будет видна.
            if screenshot and not self.text_only and "image" in str(error).lower() and self.vision_ok is not True:
                log("[!] Модель не приняла скриншот — пробую текстовый режим (проверьте, что модель vision)")
                self.text_only = True
                return self.ask_model(prompt, None)
            raise

        choices = data.get("choices") or []
        if not choices:
            raise AgentError("Модель вернула пустой ответ")
        text = str((choices[0].get("message") or {}).get("content") or "").strip()
        return self.parse_decision(text)

    def apply_generation(self, payload: Dict[str, Any]) -> None:
        """Подмешивает `--temperature`, `--reasoning` и остальные ручки в запрос.

        Передаём только заданное: строгие сборки отвечают 400 на незнакомые поля.
        """
        gen = self.generation if isinstance(self.generation, dict) else {}
        try:
            if gen.get("temperature") is not None:
                payload["temperature"] = max(0.0, min(2.0, float(gen["temperature"])))
            if gen.get("top_p") is not None:
                payload["top_p"] = max(0.0, min(1.0, float(gen["top_p"])))
            if gen.get("max_tokens") is not None:
                payload["max_tokens"] = int(gen["max_tokens"])
            if gen.get("seed") is not None:
                payload["seed"] = int(gen["seed"])
        except (TypeError, ValueError):
            pass

        reasoning = str(gen.get("reasoning") or "default")
        if reasoning not in ("default", "off", "low", "medium", "high", "budget"):
            reasoning = "default"
        if reasoning == "default":
            return
        if reasoning == "off":
            payload["reasoning_effort"] = "none"
        elif reasoning == "budget":
            budget = gen.get("thinking_budget")
            if budget:
                try:
                    payload["thinking_budget"] = int(budget)
                except (TypeError, ValueError):
                    pass
            payload["reasoning_effort"] = "high"
        else:
            payload["reasoning_effort"] = reasoning
        if gen.get("send_thinking_flag", True):
            payload["chat_template_kwargs"] = {"enable_thinking": reasoning != "off"}

    def parse_verdict(self, text: str) -> Optional[Dict[str, Any]]:
        """Достаёт JSON-вердикт проверки из ответа модели (можно в ```-блоке)."""
        objects = _extract_json_objects(text)
        data: Optional[Dict[str, Any]] = None
        for obj in reversed(objects):
            if "ok" in obj or "note" in obj:
                data = obj
                break
        if data is None and objects:
            data = objects[-1]
        if data is None:
            return None
        return {
            "ok": bool(data.get("ok")),
            "note": str(data.get("note") or "").strip()[:200],
            "why": str(data.get("why") or "").strip()[:240],
        }

    def verify_action(self, action: Dict[str, Any], result: str,
                      step_context: str = "", prev_frame_sig: Optional[bytes] = None) -> Optional[Dict[str, Any]]:
        """Скриншот после действия + вопрос модели: получилось ли?

        Ошибка проверки не должна ломать задание: любая проблема возвращает None,
        и бот просто идёт дальше по обычной логике.
        """
        self._last_verify_shot = None
        self._last_screen_unchanged = False
        if not self.verify_actions or self.text_only or not self.model:
            return None
        kind = str(action.get("type") or "")
        if kind in ("wait", "finish", "make_file"):
            return None
        time.sleep(min(1.5, max(0.35, self.delay)))
        try:
            screenshot, _ = self.screenshot()
        except Exception as error:  # noqa: BLE001
            log("[!] проверка: не удалось снять экран ({})".format(error))
            return None
        self._last_verify_shot = screenshot
        unchanged = frames_similar(prev_frame_sig, self._last_frame_sig)
        self._last_screen_unchanged = unchanged

        context_lines = []
        if step_context:
            context_lines.append("Цель шага: " + step_context[:300])
        context_lines.append("Действие: " + json.dumps(action, ensure_ascii=False))
        context_lines.append("Результат: " + result)
        if unchanged:
            context_lines.append("Визуальное сравнение: экран после действия почти не изменился.")
        context_lines.append(
            '\nПосмотри на скриншот: получилось ли? Ответь JSON '
            '{"ok": true|false, "note": "что видно", "why": "причина если false"}'
        )
        payload_text = "\n".join(context_lines)
        messages = [
            {"role": "system", "content": VERIFY_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": payload_text},
                {"type": "image_url", "image_url": {"url": screenshot}},
            ]},
        ]
        payload: Dict[str, Any] = {"model": self.model, "messages": messages,
                                   "temperature": 0, "max_tokens": 240, "stream": False}
        self.apply_generation(payload)
        payload["temperature"] = 0
        headers = {"Authorization": "Bearer " + self.api_key} if self.api_key else {}
        try:
            data = self.model_http.call("POST", "/chat/completions", payload, timeout=120,
                                        headers=headers)
        except TaskCancelled:
            raise
        except AgentError as error:
            log("[!] проверка действия не удалась: {}".format(error))
            return None

        choices = data.get("choices") or []
        if not choices:
            return None
        text = str((choices[0].get("message") or {}).get("content") or "")
        verdict = self.parse_verdict(text)
        if verdict is None:
            log("[!] проверка: модель ответила без JSON — пропускаю")
        return verdict

    @staticmethod
    def parse_reflection(text: str, default_question: str = "") -> Dict[str, str]:
        """Разбирает ответ саморазбора (JSON или обычный текст)."""
        objects = _extract_json_objects(text)
        data: Optional[Dict[str, Any]] = None
        for obj in reversed(objects):
            if any(key in obj for key in ("diagnosis", "next_strategy", "question")):
                data = obj
                break
        if data is None and objects:
            data = objects[-1]
        if data is not None:
            return {
                "question": str(data.get("question") or default_question).strip()[:280],
                "diagnosis": str(data.get("diagnosis") or "").strip()[:400],
                "next_strategy": str(data.get("next_strategy") or "").strip()[:400],
            }
        cleaned = _strip_thinking(text)
        return {
            "question": default_question[:280],
            "diagnosis": cleaned[:400] if cleaned else "Предыдущее действие не дало ожидаемого результата.",
            "next_strategy": "",
        }

    def reflect_on_failure(self, task_prompt: str, action: Dict[str, Any],
                           reason: str, screenshot: Optional[str] = None) -> Dict[str, str]:
        """Когда действие не удалось: бот задаёт вопрос себе и разбирает ошибку.

        Возвращает {"question", "diagnosis", "next_strategy"} и сохраняет
        итог в self.pending_nudge для следующего шага.
        """
        question = build_self_question(action, reason)
        log("  [?] Вопрос себе: " + question)
        self.report("thought", "🤔 Вопрос себе: " + question, action)

        reflection: Dict[str, str] = {
            "question": question,
            "diagnosis": reason,
            "next_strategy": "",
        }
        if self.self_reflect and self.model:
            shot_url = screenshot
            if not shot_url and not self.text_only:
                try:
                    shot_url, _ = self.screenshot()
                except Exception:  # noqa: BLE001
                    shot_url = None

            summary_lines = [
                'Задание: "{}"'.format(task_prompt),
                "Неудачное действие: {}".format(json.dumps(action, ensure_ascii=False)),
                "Что пошло не так: {}".format(reason),
                "Мой вопрос себе: {}".format(question),
            ]
            if self.history:
                summary_lines.append("Последние шаги:\n" + "\n".join(self.history[-6:]))
            prompt_text = "\n".join(summary_lines)
            user_content: Any = (
                [{"type": "text", "text": prompt_text},
                 {"type": "image_url", "image_url": {"url": shot_url}}]
                if (shot_url and not self.text_only) else prompt_text
            )
            payload: Dict[str, Any] = {
                "model": self.model,
                "messages": [
                    {"role": "system", "content": SELF_REFLECT_PROMPT},
                    {"role": "user", "content": user_content},
                ],
                "temperature": 0.3,
                "max_tokens": 360,
                "stream": False,
            }
            self.apply_generation(payload)
            if (self.generation or {}).get("temperature") is None:
                payload["temperature"] = 0.3
            headers = {"Authorization": "Bearer " + self.api_key} if self.api_key else {}
            try:
                data = self.model_http.call("POST", "/chat/completions", payload, timeout=120,
                                            headers=headers)
                choices = data.get("choices") or []
                raw_text = str((choices[0].get("message") or {}).get("content") or "").strip() if choices else ""
                if raw_text:
                    reflection = self.parse_reflection(raw_text, question)
            except TaskCancelled:
                raise
            except AgentError as error:
                log("[!] саморазбор не удался ({}) — использую базовую подсказку".format(error))

        diag_parts = []
        if reflection.get("diagnosis"):
            diag_parts.append("Что не так: " + reflection["diagnosis"])
        if reflection.get("next_strategy"):
            diag_parts.append("Новый план: " + reflection["next_strategy"])
        if diag_parts:
            summary = " | ".join(diag_parts)
            log("  [!] Разбор: " + summary)
            self.report("thought", "💡 " + summary, action)
            self.history.append("разбор неудачи ({}): {}".format(action.get("type"), summary[:200]))

        self.pending_nudge = build_reflection_nudge(reflection)
        return reflection

    def probe_vision(self) -> Optional[bool]:
        """Видит ли модель картинки: просим прочитать число с тестовой плашки.

        Без этого легко принять текстовую модель за оператора: она «отвечает»
        координатами из головы, а бот послушно кликает мимо.
        """
        if self.text_only or not self.vision_check:
            return None
        if Image is None or ImageDraw is None or ImageFont is None:
            log("[i] Pillow не установлен — проверку зрения пропускаю "
                "(pip install -r agent/requirements.txt)")
            return None
        number = str(random.randint(1000, 9999))
        image = Image.new("RGB", (360, 140), "white")
        draw = ImageDraw.Draw(image)
        try:
            font = ImageFont.load_default(size=72)
        except TypeError:  # Pillow старше 10
            font = ImageFont.load_default()
        draw.text((28, 30), number, fill="black", font=font)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
        payload = {
            "model": self.model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "Какое число на картинке? Ответь только цифрами."},
                    {"type": "image_url", "image_url": {"url": url}},
                ],
            }],
            "max_tokens": 64,  # модели с размышлениями успевают «подумать»
            "temperature": 0,
        }
        headers = {"Authorization": "Bearer " + self.api_key} if self.api_key else {}
        try:
            data = self.model_http.call("POST", "/chat/completions", payload, timeout=60, headers=headers)
        except AgentError as error:
            self.vision_ok = False
            log("[!] Не удалось проверить зрение модели: {}".format(error))
            return False
        choices = data.get("choices") or []
        answer = str((choices[0].get("message") or {}).get("content") or "") if choices else ""
        self.vision_ok = number in answer
        return self.vision_ok

    @staticmethod
    def parse_decision(text: str) -> Dict[str, Any]:
        objects = _extract_json_objects(text)
        data: Optional[Dict[str, Any]] = None
        for obj in reversed(objects):
            action = obj.get("action")
            if isinstance(action, dict) and action.get("type"):
                data = obj
                break
        if data is None:
            if not objects:
                cleaned = _strip_thinking(text)
                raise AgentError("Модель ответила без JSON: " + cleaned[:200])
            data = objects[-1]
        action = data.get("action") or {}
        if not isinstance(action, dict) or not action.get("type"):
            raise AgentError("В ответе модели нет action.type")
        return {
            "observation": str(data.get("observation") or "").strip(),
            "next_question": str(data.get("next_question") or data.get("question") or "").strip(),
            "self_check": str(data.get("self_check") or "").strip(),
            "thought": str(data.get("thought") or "").strip(),
            "action": action,
        }

    # ------------------------------------------------------------- экран
    @staticmethod
    def screen_size() -> Dict[str, int]:
        require_pyautogui()
        width, height = pyautogui.size()
        return {"width": int(width), "height": int(height)}

    def screenshot(self) -> Tuple[str, Dict[str, Any]]:
        if Image is None:
            raise SystemExit("Нужен Pillow: pip install -r agent/requirements.txt")
        require_pyautogui()
        image = pyautogui.screenshot()
        screen = self.screen_size()
        raw_width, raw_height = image.size
        if raw_width > self.max_width:
            ratio = self.max_width / float(raw_width)
            image = image.resize((self.max_width, max(1, int(round(raw_height * ratio)))))
        if image.mode != "RGB":
            image = image.convert("RGB")

        # Считаем отпечаток чистого экрана до рисования крестика курсора.
        self._last_frame_sig = frame_signature(image)

        # Красный крестик в точке курсора: модель видит, где он сейчас, и не
        # кликает «наугад» после промаха.
        if self.cursor_marker and pyautogui is not None and ImageDraw is not None:
            try:
                cursor_x, cursor_y = pyautogui.position()
                scale_x = image.size[0] / float(raw_width or image.size[0])
                scale_y = image.size[1] / float(raw_height or image.size[1])
                mark_x = int(cursor_x * scale_x)
                mark_y = int(cursor_y * scale_y)
                if 0 <= mark_x < image.size[0] and 0 <= mark_y < image.size[1]:
                    draw = ImageDraw.Draw(image)
                    draw.line([(mark_x - 16, mark_y), (mark_x + 16, mark_y)], fill=(255, 0, 0), width=2)
                    draw.line([(mark_x, mark_y - 16), (mark_x, mark_y + 16)], fill=(255, 0, 0), width=2)
                    draw.ellipse([(mark_x - 5, mark_y - 5), (mark_x + 5, mark_y + 5)],
                                 outline=(255, 0, 0), width=2)
            except Exception:  # noqa: BLE001 — метка не должна ломать шаг
                pass

        quality = 72
        encoded = ""
        while quality >= 40:
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=quality, optimize=True)
            raw = buffer.getvalue()
            if len(raw) <= MAX_IMAGE_BYTES:
                encoded = base64.b64encode(raw).decode("ascii")
                break
            quality -= 12
        if not encoded:
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=40, optimize=True)
            encoded = base64.b64encode(buffer.getvalue()).decode("ascii")

        shot = {
            "width": int(image.size[0]),
            "height": int(image.size[1]),
            "screen_width": int(screen["width"]),
            "screen_height": int(screen["height"]),
        }
        self.last_shot = shot
        return "data:image/jpeg;base64," + encoded, shot

    def to_screen(self, x: Any, y: Any) -> Tuple[int, int]:
        shot = self.last_shot or {"width": 1920, "height": 1080,
                                  "screen_width": 1920, "screen_height": 1080}
        mapped_x, mapped_y = map_point(x, y, shot["width"], shot["height"],
                                       shot["screen_width"], shot["screen_height"])
        return mapped_x + self.offset_x, mapped_y + self.offset_y

    # ---------------------------------------------------------- действия
    def make_file(self, action: Dict[str, Any]) -> str:
        if fileforge is None:
            raise AgentError("Модуль fileforge.py не найден рядом с оператором")
        name = str(action.get("name") or "файл.txt")
        content = str(action.get("content") or "")
        data, mime, final_name = fileforge.build(name, content, action.get("format"))
        FILES_DIR.mkdir(parents=True, exist_ok=True)
        path = FILES_DIR / final_name
        path.write_bytes(data)
        log("  файл: {} ({} Б) → {}".format(final_name, len(data), path))

        if self.has_crm and self.current_task:
            try:
                result = self.crm.call("POST", "/api/agent/bot/{}/files".format(self.current_task),
                                       {"name": final_name, "mime": mime, "size": len(data),
                                        "data": base64.b64encode(data).decode("ascii")})
                url = str(result.get("url") or "")
                return "файл «{}» создан ({} байт) и отправлен в чат CRM ({})".format(
                    final_name, len(data), url or "ок")
            except TaskCancelled:
                raise
            except AgentError as error:
                return "файл «{}» создан локально ({}), но отправить в CRM не удалось: {}".format(
                    final_name, path, error)
        return "файл «{}» создан локально: {}".format(final_name, path)

    def ensure_cursor(self, x: int, y: int) -> None:
        """Ставим курсор и проверяем, что он действительно там.

        Иногда pyautogui «теряет» точку: масштаб, второй монитор, окно поверх.
        Лучше отменить клик с понятной ошибкой, чем открыть чужое приложение.
        """
        require_pyautogui()
        width, height = pyautogui.size()
        if not (0 <= int(x) < int(width) and 0 <= int(y) < int(height)):
            raise AgentError("точка ({}, {}) вне экрана {}×{} — действие отменено".format(
                x, y, width, height))
        pyautogui.moveTo(x, y, duration=0.18)
        time.sleep(0.12)
        cursor_x, cursor_y = pyautogui.position()
        if abs(cursor_x - x) > 3 or abs(cursor_y - y) > 3:
            pyautogui.moveTo(x, y, duration=0.1)
            time.sleep(0.1)
            cursor_x, cursor_y = pyautogui.position()
        if abs(cursor_x - x) > 3 or abs(cursor_y - y) > 3:
            raise AgentError("курсор встал в ({}, {}) вместо ({}, {}) — клик отменён".format(
                cursor_x, cursor_y, x, y))

    def execute(self, action: Dict[str, Any]) -> str:
        kind = action.get("type")

        if kind == "make_file":
            return self.make_file(action)

        if kind == "open_url":
            url = str(action.get("url") or "")
            if not re.match(r"^https?://", url):
                return "некорректный адрес: " + url
            webbrowser.open(url)
            return "открыт адрес " + url

        require_pyautogui()

        if kind in ("click", "double_click", "right_click"):
            x, y = self.to_screen(action.get("x", 0), action.get("y", 0))
            # Сначала наводим курсор и проверяем, что он там, где нужно: так
            # срабатывают hover-состояния, а промах виден до нажатия.
            self.ensure_cursor(x, y)
            if kind == "click":
                pyautogui.click(x=x, y=y, clicks=int(action.get("clicks") or 1),
                                button=str(action.get("button") or "left"), interval=0.12)
                return "клик в ({}, {})".format(x, y)
            if kind == "double_click":
                pyautogui.doubleClick(x=x, y=y)
                return "двойной клик в ({}, {})".format(x, y)
            pyautogui.rightClick(x=x, y=y)
            return "правый клик в ({}, {})".format(x, y)

        if kind == "move":
            x, y = self.to_screen(action.get("x", 0), action.get("y", 0))
            self.ensure_cursor(x, y)
            return "курсор в ({}, {})".format(x, y)

        if kind in ("type", "paste"):
            clicked = ""
            if action.get("x") is not None and action.get("y") is not None:
                x, y = self.to_screen(action.get("x"), action.get("y"))
                self.ensure_cursor(x, y)
                pyautogui.click(x=x, y=y)
                time.sleep(0.18)
                clicked = " после клика в ({}, {})".format(x, y)
            if action.get("clear"):
                modifier = "command" if platform.system() == "Darwin" else "ctrl"
                pyautogui.hotkey(modifier, "a")
                pyautogui.press("delete")
                time.sleep(0.05)
            text = str(action.get("text") or "")
            type_text(text)
            return "введено {} символов{}".format(len(text), clicked)

        if kind == "hotkey":
            keys = [str(key).lower() for key in (action.get("keys") or []) if str(key).strip()]
            if not keys:
                return "нет клавиш"
            pyautogui.hotkey(*keys)
            return "нажато: " + " + ".join(keys)

        if kind == "key":
            key = str(action.get("key") or "enter").lower()
            pyautogui.press(key)
            return "нажата клавиша " + key

        if kind == "scroll":
            amount = int(action.get("amount") or -3)
            if action.get("x") is not None and action.get("y") is not None:
                x, y = self.to_screen(action.get("x"), action.get("y"))
                self.ensure_cursor(x, y)
            pyautogui.scroll(amount * 120)
            return "прокрутка {}".format("вверх" if amount > 0 else "вниз")

        if kind == "drag":
            from_x, from_y = self.to_screen(action.get("fromX", 0), action.get("fromY", 0))
            to_x, to_y = self.to_screen(action.get("toX", 0), action.get("toY", 0))
            self.ensure_cursor(from_x, from_y)
            pyautogui.dragTo(to_x, to_y, duration=0.5, button="left")
            return "перетаскивание ({}, {}) → ({}, {})".format(from_x, from_y, to_x, to_y)

        if kind == "wait":
            seconds = max(0.1, min(10.0, float(action.get("seconds") or 1)))
            time.sleep(seconds)
            return "пауза {:.1f} с".format(seconds)

        return "неизвестное действие: {}".format(kind)

    # ------------------------------------------------------------- цикл
    def report(self, kind: str, text: str, action: Optional[dict] = None) -> None:
        if not (self.has_crm and self.current_task):
            return
        try:
            self.crm.call("POST", "/api/agent/bot/{}/events".format(self.current_task),
                          {"kind": kind, "text": text,
                           "action": json.dumps(action, ensure_ascii=False) if action else ""})
        except TaskCancelled:
            raise
        except AgentError as error:
            log("[!] не смог отправить шаг в CRM: {}".format(error))

    def load_attachments(self, task_id: Optional[int]) -> str:
        """Скачиваем вложения задания и превращаем их в текст для модели."""
        if not (self.has_crm and task_id):
            return ""
        try:
            info = self.crm.call("GET", "/api/agent/bot/{}".format(task_id), timeout=30)
        except TaskCancelled:
            raise
        except AgentError as error:
            log("[!] не удалось получить вложения задания: {}".format(error))
            return ""
        attachments = info.get("attachments") or []
        if not attachments:
            return ""
        blocks = []
        for item in attachments[:5]:
            name = str(item.get("name") or "файл")
            event_id = int(item.get("id") or 0)
            try:
                data = self.crm.download("/api/agent/bot/attachment/{}".format(event_id))
            except TaskCancelled:
                raise
            except AgentError as error:
                blocks.append("--- {}: не удалось скачать ({}) ---".format(name, error))
                continue
            text = extract_attachment_text(name, data)
            mime = str(item.get("mime") or "")
            is_image = mime.startswith("image/") or name.lower().endswith(
                (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"))
            if is_image and len(self.attachment_images) < 3 and len(data) <= 3_000_000:
                self.attachment_images.append(
                    "data:{};base64,{}".format(mime or "image/png",
                                               base64.b64encode(data).decode("ascii")))
                log("  вложение: {} ({} Б) — картинка, покажу модели".format(name, len(data)))
            else:
                log("  вложение: {} ({} Б, {} симв. текста)".format(name, len(data), len(text)))
            placeholder = "[картинка приложена ниже]" if is_image else text
            blocks.append("--- {} ({} Б) ---\n{}".format(name, len(data), placeholder))
        return "\n\n".join(blocks)

    def task_cancelled(self, task_id: Optional[int]) -> bool:
        """Спрашиваем CRM, не отменили ли задание, — до следующего шага."""
        if not (self.has_crm and task_id):
            return False
        try:
            data = self.crm.call("GET", "/api/agent/bot/{}".format(task_id), timeout=10)
        except TaskCancelled:
            return True
        except AgentError:
            return False
        status = str((data.get("task") or {}).get("status") or "")
        return status == "cancelled"

    def run(self, task_id: Optional[int], prompt: str, max_steps: int) -> bool:
        self.current_task = task_id
        self.history = []
        self.last_signature = ""
        self.repeat_streak = 0
        self.pending_nudge = ""
        self.failed_checks = 0
        self._last_frame_sig = None
        last_outcome = ""
        last_screen_unchanged = False
        log("Задание: {}".format(prompt))
        self.report("info", "Задание принято: " + prompt)

        self.attachments_context = self.load_attachments(task_id)
        if self.attachments_context:
            self.report("info", "Прочитал вложения задания — учту их в шагах")

        for index in range(min(MAX_STEPS_LIMIT, max(1, max_steps))):
            if self.task_cancelled(task_id):
                log("Задание отменено в CRM — останавливаюсь, шаги больше не шлю.")
                return False

            screenshot = None
            shot = None
            if not self.text_only:
                try:
                    screenshot, shot = self.screenshot()
                except SystemExit:
                    raise
                except Exception as error:  # noqa: BLE001
                    log("[!] скриншот не удался: {}".format(error))

            step_prompt = build_step_prompt(
                prompt=prompt,
                step_index=index,
                shot=self.last_shot,
                text_only=self.text_only,
                pending_nudge=self.pending_nudge,
                attachments_context=self.attachments_context,
                last_outcome=last_outcome,
                screen_unchanged=last_screen_unchanged,
            )
            decision = self.ask_model(step_prompt, screenshot,
                                      self.attachment_images if index == 0 else None)
            self.pending_nudge = ""
            action = decision["action"]
            thought_text = format_decision_thought(decision)
            log("Шаг {} | {} {}".format(index + 1, action.get("type"),
                                        "({} симв.)".format(len(str(action.get("content") or "")))
                                        if action.get("type") == "make_file" else ""))
            if thought_text:
                _safe_print("         " + thought_text)
                self.report("thought", thought_text, action)
                self.history.append("шаг {} мысль: {}".format(index + 1, thought_text[:200]))

            if action.get("type") == "finish":
                summary = str(action.get("summary") or "Готово")
                self.report("info", "Итог: " + summary)
                if self.has_crm and task_id:
                    self.crm.call("POST", "/api/agent/bot/{}/finish".format(task_id),
                                  {"status": "done", "summary": summary})
                log("ГОТОВО: " + summary)
                return True

            # --- антизацикливание: одно и то же действие подряд ------------
            signature = action_signature(action)
            kind = str(action.get("type") or "")
            if signature == self.last_signature and signature:
                self.repeat_streak += 1
            else:
                self.repeat_streak = 1
            self.last_signature = signature
            limit = REPEAT_LIMITS.get(kind, 0)

            if self.repeat_nudge_enabled and limit and self.repeat_streak >= limit:
                repeat_nudge = build_repeat_nudge(action, self.repeat_streak)
                if self.repeat_streak == limit:
                    log("  повтор действия {} раз — задаю себе вопрос и меняю тактику".format(
                        self.repeat_streak))
                    self.report("info", "Похоже на зацикливание: разбираю, что идёт не так",
                                action)
                    self.reflect_on_failure(
                        prompt,
                        action,
                        "одно и то же действие повторяется {} раз подряд".format(self.repeat_streak),
                        screenshot=screenshot,
                    )
                    self.pending_nudge = (self.pending_nudge + "\n\n" + repeat_nudge).strip()
                else:
                    self.pending_nudge = repeat_nudge
                    note = "Повтор действия пропущен ({} раз подряд): {}".format(
                        self.repeat_streak, action_label(action))
                    log("  " + note)
                    self.report("info", note, action)
                    self.history.append("шаг {}: {} не выполнен — повтор".format(
                        index + 1, kind))
                    last_outcome = note
                    last_screen_unchanged = True
                    if self.repeat_streak >= limit + MAX_REPEAT_EXTRA:
                        stop = ("Застрял на одном действии {} раз подряд — останавливаюсь, "
                                "чтобы не кликать вслепую. Уточните задание.").format(
                                    self.repeat_streak)
                        log(stop)
                        self.report("error", stop, action)
                        if self.has_crm and task_id:
                            self.crm.call("POST",
                                          "/api/agent/bot/{}/finish".format(task_id),
                                          {"status": "failed", "summary": stop})
                        return False
                    time.sleep(max(0.2, self.delay))
                    continue

            dangerous = bool(DANGEROUS.search(json.dumps(action, ensure_ascii=False)))
            reason = None
            if self.dry_run:
                reason = "dry-run: действие не выполнено"
            elif dangerous and not self.assume_yes:
                log("[!] Потенциально опасное действие: {}".format(json.dumps(action, ensure_ascii=False)))
                try:
                    answer = input("    Выполнить? [y/N]: ").strip().lower()
                except EOFError:
                    answer = "n"
                if answer not in ("y", "yes", "д", "да"):
                    reason = "отклонено пользователем"

            if reason:
                log("  пропуск: " + reason)
                self.report("action", reason, action)
                self.history.append("шаг {}: {} — {}".format(index + 1, action.get("type"), reason))
                last_outcome = reason
                last_screen_unchanged = False
            else:
                prev_frame_sig = self._last_frame_sig
                try:
                    result = self.execute(action)
                    log("  выполнено: " + result)
                    self.report("action", result, action)
                    self.history.append("шаг {}: {} → {}".format(index + 1, action.get("type"), result[:160]))
                    last_outcome = result
                    last_screen_unchanged = False

                    # Проверяем результат по свежему скриншоту: бот не идёт
                    # дальше «наугад», если клик не сработал.
                    verdict = self.verify_action(
                        action,
                        result,
                        step_context=thought_text or prompt,
                        prev_frame_sig=prev_frame_sig,
                    )
                    if verdict is not None:
                        note = verdict["note"] or ("получилось" if verdict["ok"] else "результата не видно")
                        self.report("result", "{} {}".format("✅" if verdict["ok"] else "⚠️",
                                                             note), action)
                        self.history.append("проверка после {}: {} — {}".format(
                            action.get("type"), "ок" if verdict["ok"] else "проблема", note))
                        if verdict["ok"]:
                            self.failed_checks = 0
                            # Экран изменился — это прогресс, счётчик повторов
                            # начинается заново (иначе «следующая страница»
                            # тем же кликом считалась бы зацикливанием).
                            self.repeat_streak = 0
                            self.pending_nudge = ""
                            last_outcome = "✅ " + note
                            last_screen_unchanged = False
                        else:
                            self.failed_checks += 1
                            last_outcome = "⚠️ " + note
                            last_screen_unchanged = self._last_screen_unchanged
                            fail_reason = verdict.get("why") or note
                            if self._last_screen_unchanged and "не изменился" not in fail_reason.lower():
                                fail_reason += " (экран визуально не изменился)"
                            self.reflect_on_failure(
                                prompt,
                                action,
                                fail_reason,
                                screenshot=self._last_verify_shot or screenshot,
                            )
                            if self.failed_checks >= 2:
                                self.report("info", "Результата нет {} раз подряд — меняю тактику".format(
                                    self.failed_checks), action)
                                self.pending_nudge = (
                                    self.pending_nudge + "\n" + build_failed_nudge(self.failed_checks, note)
                                ).strip()
                    elif (
                        self.self_reflect
                        and not self.text_only
                        and prev_frame_sig is not None
                        and kind not in ("wait", "finish", "make_file", "open_url", "move")
                    ):
                        # Если проверка отключена или не ответила JSON — ловим тихий промах по кадру.
                        after_url = self._last_verify_shot
                        if after_url is None:
                            time.sleep(min(0.6, max(0.25, self.delay)))
                            try:
                                after_url, _ = self.screenshot()
                            except Exception:  # noqa: BLE001
                                after_url = None
                        if after_url and frames_similar(prev_frame_sig, self._last_frame_sig):
                            self.failed_checks += 1
                            last_screen_unchanged = True
                            last_outcome = "экран визуально не изменился после {}".format(kind)
                            self.reflect_on_failure(
                                prompt,
                                action,
                                "экран после действия визуально не изменился",
                                screenshot=after_url,
                            )
                        else:
                            self.failed_checks = 0
                except TaskCancelled:
                    raise
                except Exception as error:  # noqa: BLE001
                    log("  ошибка: {}".format(error))
                    self.report("error", str(error)[:400], action)
                    self.history.append("шаг {}: ошибка {}".format(index + 1, error))
                    self.failed_checks += 1
                    last_outcome = "ошибка: " + str(error)[:160]
                    last_screen_unchanged = True
                    self.reflect_on_failure(
                        prompt,
                        action,
                        "ошибка при выполнении: {}".format(error),
                        screenshot=screenshot,
                    )

            time.sleep(max(0.2, self.delay))

        note = "Достигнут предел в {} шагов — задание остановлено".format(max_steps)
        self.report("error", note)
        if self.has_crm and task_id:
            self.crm.call("POST", "/api/agent/bot/{}/finish".format(task_id),
                          {"status": "failed", "summary": note})
        log(note)
        return False

    # ------------------------------------------------------- очередь CRM
    def watch(self, once: bool) -> int:
        if not self.has_crm:
            log("Для очереди нужны --server и --token. Либо запустите с --task \"…\".")
            return 2
        log("Сервер CRM: {}".format(self.crm.base))
        log("Токен: {}".format(mask_token(self.crm.token)))
        try:
            who = self.crm.call("GET", "/api/agent/bot/whoami", timeout=30)
            counts = who.get("counts") or {}
            log("Связь с CRM есть: {} · в очереди {}".format(
                (who.get("owner") or {}).get("email") or "владелец токена",
                counts.get("queued", 0)))
        except AgentError as error:
            log("Ошибка: {}".format(error))
            return 1
        while True:
            try:
                data = self.crm.call("GET", "/api/agent/bot/next", timeout=30)
            except AgentError as error:
                log("Ошибка: {}".format(error))
                if once:
                    return 1
                time.sleep(self.poll)
                continue
            task = data.get("task")
            if not task:
                if once:
                    log("Очередь пуста.")
                    return 0
                log("Жду задание в очереди…")
                time.sleep(self.poll)
                continue
            limit = min(MAX_STEPS_LIMIT, max(1, int(task.get("maxSteps") or 15)))
            if self.max_steps_cap:
                limit = min(limit, self.max_steps_cap)
            try:
                self.run(int(task["id"]), str(task.get("prompt") or ""), limit)
            except TaskCancelled:
                log("Задание #{} отменено в CRM — останавливаюсь.".format(task.get("id")))
                if once:
                    return 0
                continue
            except AgentError as error:
                log("Ошибка: {}".format(error))
                try:
                    self.crm.call("POST", "/api/agent/bot/{}/finish".format(task["id"]),
                                  {"status": "failed", "summary": str(error)[:400]})
                except AgentError:
                    pass
                except TaskCancelled:
                    pass
            if once:
                return 0


def check_token(server: str, raw_token: str) -> int:
    """`--check`: проверить связь с CRM и токен, ничего не выполняя на экране."""
    token = normalize_token(raw_token)
    server = (server or "").rstrip("/")
    log("CRM: {}".format(server or "—"))
    problem = token_problem(token)
    if problem:
        log("[!] " + problem)
        return 2
    log("Токен: {}".format(mask_token(token)))
    if not token.startswith("crmop_"):
        log("[!] Токен обычно начинается с crmop_ — проверьте, что скопирован он целиком")
    try:
        data = Http(server, token, kind="CRM").call("GET", "/api/agent/bot/whoami", timeout=30)
    except AgentError as error:
        log("[!] {}".format(error))
        return 1
    owner = data.get("owner") or {}
    counts = data.get("counts") or {}
    log("Токен принят: {} <{}>".format(owner.get("name") or "—", owner.get("email") or "—"))
    log("Задания: в очереди {queued}, в работе {running}, готово {done}".format(
        queued=counts.get("queued", 0), running=counts.get("running", 0), done=counts.get("done", 0)))
    if not counts.get("queued") and not counts.get("running"):
        log("Очередь пуста — поставьте задание на «Пульте» во вкладке «Оператор».")
    else:
        log("Можно запускать без --check: --once или --watch.")
    return 0


def check_model(base_url: str, model: str, api_key: str, key_hint: str) -> int:
    """Минимальный запрос к модели: ловим именно 401 по ключу, а не в задании."""
    if not model:
        log("[i] Модель не задана — проверку ключа пропускаю.")
        return 0
    headers = {"Authorization": "Bearer " + api_key} if api_key else {}
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
        "temperature": 0,
    }
    try:
        Http(base_url, kind="модель", key_hint=key_hint).call(
            "POST", "/chat/completions", payload, timeout=60, headers=headers)
    except AgentError as error:
        log("[!] {}".format(error))
        return 1
    log("Модель {} ответила: ключ принят.".format(model))
    return 0


def resolve_provider(args: argparse.Namespace) -> Tuple[str, str, str]:
    preset = PROVIDERS.get(args.provider or "local", PROVIDERS["local"])
    base_url = args.base_url or preset["base_url"]
    model = args.model or preset["model"]
    api_key = args.api_key or os.environ.get(preset.get("key_env", ""), "") or os.environ.get("OPERATOR_API_KEY", "")
    return base_url, model, api_key


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="CRM Desktop Operator — агент, который управляет рабочим столом",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Токен создаётся в CRM: /ai → вкладка «Оператор».",
    )
    parser.add_argument("--server", default=DEFAULT_SERVER, help="URL CRM (по умолчанию %(default)s)")
    parser.add_argument("--token", default=DEFAULT_TOKEN, help="токен агента (или CRM_AGENT_TOKEN)")
    parser.add_argument("--provider", default="local",
                        choices=sorted(PROVIDERS) + ["custom"], help="пресет провайдера модели")
    parser.add_argument("--base-url", default="", help="адрес OpenAI-совместимого API")
    parser.add_argument("--model", default="", help="модель (должна уметь смотреть скриншоты)")
    parser.add_argument("--api-key", default="", help="ключ API (можно через переменную окружения)")
    parser.add_argument("--task", default="", help="выполнить задание сразу, без очереди CRM")
    parser.add_argument("--watch", action="store_true", help="ждать задания из очереди CRM")
    parser.add_argument("--once", action="store_true", help="взять одно задание и выйти")
    parser.add_argument("--dry-run", action="store_true", help="только планировать, без действий")
    parser.add_argument("--yes", action="store_true", help="не спрашивать про опасные действия")
    parser.add_argument("--text-only", action="store_true", help="не отправлять скриншоты (без vision)")
    parser.add_argument("--max-steps", type=int, default=0, help="жёсткий предел шагов (0 — из задания)")
    parser.add_argument("--delay", type=float, default=0.8, help="пауза между шагами, сек")
    parser.add_argument("--poll", type=float, default=3.0, help="интервал опроса очереди, сек")
    parser.add_argument("--max-width", type=int, default=DEFAULT_MAX_WIDTH, help="макс. ширина скриншота")
    parser.add_argument("--offset-x", type=int, default=0,
                        help="смещение координат по X, если окно на втором мониторе")
    parser.add_argument("--offset-y", type=int, default=0, help="смещение координат по Y")
    parser.add_argument("--no-vision-check", action="store_true",
                        help="не проверять, видит ли модель картинки")
    parser.add_argument("--no-cursor-marker", action="store_true",
                        help="не рисовать крестик курсора на скриншоте")
    parser.add_argument("--vision", action="store_true",
                        help="модель точно понимает картинки (deepseek-flash и т. п.): проверку пропустить")
    parser.add_argument("--temperature", type=float, default=None,
                        help="temperature генерации (по умолчанию 0.2)")
    parser.add_argument("--top-p", type=float, default=None, help="top_p генерации")
    parser.add_argument("--max-tokens", type=int, default=None,
                        help="предел токенов ответа модели")
    parser.add_argument("--seed", type=int, default=None, help="seed генерации")
    parser.add_argument("--reasoning", default="default",
                        choices=["default", "off", "low", "medium", "high", "budget"],
                        help="режим раздумий модели (reasoning_effort)")
    parser.add_argument("--thinking-budget", type=int, default=None,
                        help="бюджет раздумий в токенах для --reasoning budget")
    parser.add_argument("--no-thinking-flag", action="store_true",
                        help="не дублировать режим в chat_template_kwargs.enable_thinking")
    parser.add_argument("--no-verify-actions", action="store_true",
                        help="не проверять экран после каждого действия")
    parser.add_argument("--no-repeat-nudge", action="store_true",
                        help="не подсказывать модели, когда она зациклилась на действии")
    parser.add_argument("--no-self-reflect", action="store_true",
                        help="не задавать модели самопроверочный вопрос при неудаче действия")
    parser.add_argument("--check", action="store_true",
                        help="проверить связь с CRM и токен (без экрана и модели)")
    parser.add_argument("--self-test", action="store_true", help="проверки без экрана и зависимостей")
    return parser.parse_args()


def main() -> int:
    configure_stdio()
    args = parse_args()
    if args.self_test:
        return self_test()

    args.token = normalize_token(args.token)
    if args.check:
        code = check_token(args.server, args.token)
        if code != 0:
            return code
        base_url, model, api_key = resolve_provider(args)
        preset = PROVIDERS.get(args.provider or "local", {})
        key_hint = preset.get("key_env", "")
        if not args.model and key_hint == "OPERATOR_API_KEY":
            log("[i] Локальная модель: ключ не проверяю (добавьте --model, чтобы проверить и её).")
            return 0
        return check_model(base_url, model, api_key, key_hint)

    base_url, model, api_key = resolve_provider(args)
    enable_dpi_awareness()
    require_pyautogui()

    operator = Operator(
        crm=args.server, token=args.token, base_url=base_url, model=model, api_key=api_key,
        dry_run=args.dry_run, assume_yes=args.yes,
        max_steps=min(MAX_STEPS_LIMIT, max(0, args.max_steps)),
        delay=args.delay, poll=args.poll, max_width=args.max_width, text_only=args.text_only,
        key_hint=PROVIDERS.get(args.provider or "local", {}).get("key_env", ""),
        offset_x=args.offset_x, offset_y=args.offset_y,
        vision_check=not args.no_vision_check, vision_forced=args.vision,
        cursor_marker=not args.no_cursor_marker,
        generation={
            "temperature": args.temperature,
            "top_p": args.top_p,
            "max_tokens": args.max_tokens,
            "seed": args.seed,
            "reasoning": args.reasoning,
            "thinking_budget": args.thinking_budget,
            "send_thinking_flag": not args.no_thinking_flag,
        },
        verify_actions=not args.no_verify_actions,
        repeat_nudge=not args.no_repeat_nudge,
        self_reflect=not args.no_self_reflect,
    )
    operator.current_task = None

    if args.watch or args.once:
        problem = token_problem(args.token)
        if problem:
            log("[!] " + problem)
            return 2
        log("Токен CRM: {}".format(mask_token(args.token)))

    log("Модель: {} @ {}".format(model or "—", base_url))
    key_hint = PROVIDERS.get(args.provider or "local", {}).get("key_env", "")
    if not api_key and "127.0.0.1" not in base_url and "localhost" not in base_url:
        log("[!] Ключ API не задан — облачный провайдер ответит 401. Передайте --api-key sk-… "
            "или переменную {}; поле есть во вкладке «Оператор» → «Подключение».".format(key_hint))
    log("Режим: {}{}".format("DRY-RUN" if args.dry_run else "ИСПОЛНЕНИЕ",
                             " + подтверждения" if not args.yes else ""))
    log("Генерация: раздумья {}, temperature {}, top_p {}, max_tokens {}, проверка "
        "{}, саморазбор {}".format(args.reasoning,
                                   args.temperature if args.temperature is not None else "по умолчанию",
                                   args.top_p if args.top_p is not None else "—",
                                   args.max_tokens if args.max_tokens is not None else "—",
                                   "выкл" if args.no_verify_actions else "вкл",
                                   "выкл" if args.no_self_reflect else "вкл"))
    if not args.text_only:
        lowered = (model or "").lower()
        if args.vision:
            log("[i] --vision: проверку зрения пропускаю, считаю модель vision-моделью.")
        elif any(hint in lowered for hint in TEXT_ONLY_MODELS):
            log("[!] {} — похоже, текстовая модель без зрения: экран она не видит, "
                "координаты придумывает.".format(model))
            log("    Для DeepSeek vision-модель — deepseek-flash. Другие варианты: {}."
                .format(VISION_EXAMPLES))
            log("    Если модель всё же понимает картинки — запустите с --vision, чтобы убрать проверку.")
        else:
            seen = operator.probe_vision()
            if seen is True:
                log("Зрение модели: проверено — картинки читает.")
            elif seen is False:
                log("[!] Модель не прочитала число с тестовой картинки — похоже, изображения она не понимает.")
                log("    Для DeepSeek нужен deepseek-flash (deepseek-chat картинок не принимает).")
                log("    Другие vision-модели: {}.".format(VISION_EXAMPLES))
                log("    Если уверены в модели — запустите с --vision, проверка отключится.")
    if not args.dry_run:
        log("Аварийная остановка: уведите мышь в левый верхний угол экрана.")

    try:
        if args.task:
            return 0 if operator.run(None, args.task, args.max_steps or 15) else 1
        if args.watch or args.once:
            return operator.watch(args.once)
        log("Укажите --task \"…\" для разового задания или --watch для очереди CRM.")
        return 2
    except KeyboardInterrupt:
        log("Остановлено пользователем.")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
