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
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    import fileforge
except ImportError:  # запуск из другой папки
    fileforge = None  # type: ignore
try:
    import sandbox as sandbox_mod
except ImportError:
    sandbox_mod = None  # type: ignore

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
  "next_advice": "что рекомендуется сделать дальше после этого действия (понятно для пользователя и следующего шага)",
  "action": {"type": "...", ...}
}

Действия:
- {"type":"click","x":ЧИСЛО,"y":ЧИСЛО,"clicks":1,"button":"left"} — клик по координатам кадра;
- {"type":"double_click","x":..,"y":..} / {"type":"right_click","x":..,"y":..} / {"type":"middle_click","x":..,"y":..} / {"type":"triple_click","x":..,"y":..};
- {"type":"mouse_down","button":"left|right","x":..,"y":..} / {"type":"mouse_up","button":"left|right"} — зажать/отпустить кнопку мыши (удобно в играх и при перетаскивании);
- {"type":"move_mouse_rel","dx":120,"dy":-20} — сместить мышь относительно текущего положения (поворот камеры/прицела в 3D-играх);
- {"type":"hold_key","key":"w","seconds":0.8} — зажать и удерживать клавишу (бег, движение персонажа, прыжок в игре; до 5 с);
- {"type":"key_down","key":"shift"} / {"type":"key_up","key":"shift"} — зажать или отпустить клавишу между шагами;
- {"type":"sequence","steps":[{"type":"hold_key","key":"w","seconds":0.6},{"type":"key","key":"e"}]} — быстрая серия до 10 действий за один шаг (для игр и быстрых комбо);
- {"type":"type","text":"текст","x":..,"y":..,"clear":false} — кликнуть в поле (x,y) и набрать текст;
  clear=true — сначала очистить поле; без x,y текст уйдёт в то окно, что сейчас активно;
- {"type":"paste","text":"текст","x":..,"y":..} — то же самое длинным текстом через буфер обмена;
- {"type":"switch_language","target":"ru|en|toggle"} — переключить раскладку клавиатуры (если текст не печатается или набирается не на том языке);
- {"type":"select_all_copy","x":..,"y":..} — выделить всё и скопировать в буфер обмена (возвращает текст);
- {"type":"clipboard_get"} / {"type":"clipboard_set","text":"…"} — прочитать или записать буфер обмена;
- {"type":"hotkey","keys":["ctrl","s"]} — сочетание клавиш;
- {"type":"key","key":"enter"} — одна клавиша;
- {"type":"scroll","amount":-3,"x":..,"y":..} — прокрутка (минус — вниз);
- {"type":"drag","fromX":..,"fromY":..,"toX":..,"toY":..};
- {"type":"wait","seconds":1};
- {"type":"open_url","url":"https://…"} — открыть сайт или видео в браузере;
- {"type":"launch_app","app":"notepad"} — открыть программу на ПК (опасное действие: требует подтверждения на сайте);
- {"type":"run_command","command":"…","cwd":"."} — выполнить команду в изолированной песочнице Sandbox (требует подтверждения на сайте);
- {"type":"sandbox_write_file","path":"site/index.html","content":"…"} / {"type":"sandbox_list","path":"."};
- {"type":"export_from_sandbox","source":"…","destination":"…","mode":"copy|move"} — перенести файлы из Sandbox (требует согласия на сайте);
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
- Если нужно ввести русский или английский текст, а ввод не срабатывает или печатается
  не на том языке (неверная раскладка), используй {"type":"switch_language","target":"ru"}
  (или "en") или {"type":"paste",...}.
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
- Если действие потенциально опасно (удаление, оплата, перевод, запуск программ,
  команды, изменение системы, отправка важных данных), обязательно добавь `"dangerous": true`
  в action — сайт сначала спросит подтверждение у человека!
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
MAX_STEPS_LIMIT = 500  # начальный предел в CRM
HARD_MAX_STEPS_LIMIT = 2000  # максимальный потолок при расширении шагов на месте
APPROVAL_WAIT_TIMEOUT = 900  # 15 минут ожидания ответа человека на сайте

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


TASK_MODES = ("autonomous", "copilot", "game", "inspect")
COACH_MODES = ("off", "after_step", "agent")


def normalize_task_mode(raw: Any, default: str = "autonomous") -> str:
    value = str(raw or "").strip().lower()
    return value if value in TASK_MODES else default


def normalize_coach_mode(raw: Any, default: str = "after_step") -> str:
    value = str(raw or "").strip().lower()
    return value if value in COACH_MODES else default


def build_mode_system_addon(task_mode: str, coach_mode: str) -> str:
    lines: List[str] = []
    if task_mode == "game":
        lines.append(
            "АКТИВЕН ИГРОВОЙ РЕЖИМ (game — управление персонажем и помощь в игре):\n"
            "- Для перемещения персонажа используй hold_key (w/a/s/d/space/shift, seconds 0.2..2.0), "
            "key_down/key_up, key (например e/space/1/tab), sequence (комбинации вроде бег+прыжок или подойти+нажать E), "
            "а для поворота камеры в 3D-играх от 3-го лица (например Roblox) зажимай ПКМ: "
            "sequence из mouse_down(right), move_mouse_rel(dx, dy) и mouse_up(right).\n"
            "- На Windows клавиши hold_key/key_down/key отправляются аппаратным DirectInput-сканкодом прямо в активное окно игры: "
            "если окно игры уже на переднем плане, не делай лишних кликов по пустому полю.\n"
            "- Держи фокус в окне игры, читай HUD/мини-карту/здоровье/подсказки на экране.\n"
            "- В поле next_advice всегда пиши конкретный следующий игровой ход."
        )
    elif task_mode == "copilot":
        lines.append(
            "АКТИВЕН РЕЖИМ ПОМОЩНИКА НА ПК (copilot):\n"
            "- Ты помогаешь пользователю выполнять действия на экране шаг за шагом.\n"
            "- После каждого шага в next_advice чётко объясняй, что изменилось и что делать дальше."
        )
    elif task_mode == "inspect":
        lines.append(
            "АКТИВЕН РЕЖИМ СНИМКА ЭКРАНА (inspect):\n"
            "- Оператор делает только снимок экрана ПК без кликов и нажатий клавиш и возвращает изображение и краткое описание Агенту."
        )
    if coach_mode in ("after_step", "agent"):
        lines.append(
            "СОПРОВОЖДЕНИЕ ПОСЛЕ КАЖДОГО ДЕЙСТВИЯ:\n"
            "- Если передано НАСТАВЛЕНИЕ ОТ АГЕНТА ИЛИ ПОЛЬЗОВАТЕЛЯ, обязательно учти его при выборе этого шага.\n"
            "- Заполняй next_advice понятным советом для следующего шага."
        )
    return ("\n\n" + "\n\n".join(lines)) if lines else ""


def build_step_prompt(prompt: str, step_index: int, shot: Optional[Dict[str, Any]],
                      text_only: bool, pending_nudge: str = "",
                      attachments_context: str = "", last_outcome: str = "",
                      screen_unchanged: bool = False,
                      task_mode: str = "autonomous",
                      pending_guidance: str = "") -> str:
    """Собирает запрос шага: к скриншоту всегда приложен уточняющий вопрос."""
    parts = [
        'Задание: "{}"'.format(prompt),
        "Это шаг {} (режим: {}).".format(step_index + 1, task_mode),
    ]
    if not text_only and shot:
        parts.append(
            "Размер кадра: {width}×{height} px (координаты клика — в этих пикселях).".format(**shot)
        )
    elif text_only:
        parts.append("Работаем без скриншота: координаты считай по текущему экрану.")
    if last_outcome:
        parts.append("Итог прошлого шага: " + last_outcome)
    if pending_guidance:
        parts.append(
            "НАСТАВЛЕНИЕ ПОСЛЕ ПРОШЛОГО ДЕЙСТВИЯ (учти при выборе этого шага):\n"
            + pending_guidance
        )
    if screen_unchanged:
        parts.append(
            "Важное наблюдение: экран после предыдущего шага визуально почти не изменился — "
            "подумай, сработало ли прошлое действие, и не повторяй его вслепую."
        )
    if pending_nudge:
        parts.append(pending_nudge)
    if task_mode == "game":
        parts.append(
            "Уточняющий вопрос по игровому экрану: где находится персонаж/цель/интерфейс, "
            "какое движение (hold_key), поворот камеры (move_mouse_rel), серия (sequence) или "
            "клик приблизят к цели, и что порекомендовать на следующий шаг в next_advice?"
        )
    else:
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
# Клик/ввод — 2 раза, клавиши и прокрутка — 3, игровые движения — выше.
REPEAT_LIMITS = {
    "click": 2,
    "double_click": 2,
    "right_click": 2,
    "middle_click": 2,
    "triple_click": 2,
    "type": 2,
    "paste": 2,
    "drag": 2,
    "key": 3,
    "hotkey": 3,
    "scroll": 3,
    "switch_language": 3,
    "hold_key": 6,
    "move_mouse_rel": 6,
    "sequence": 4,
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
    if kind == "switch_language":
        parts.append("lang:{}".format(str(action.get("target") or "toggle")))
    if kind == "run_command":
        parts.append("cmd:{}".format(str(action.get("command") or "")[:80]))
    if kind == "launch_app":
        parts.append("app:{}".format(str(action.get("app") or action.get("path") or "")))
    if kind == "move_mouse_rel":
        parts.append("rel:{}:{}".format(number("dx"), number("dy")))
    if kind == "hold_key":
        parts.append("hold:{}:{}".format(str(action.get("key") or "").lower(), action.get("seconds") or 0.5))
    if kind == "sequence" and isinstance(action.get("steps"), list):
        parts.append("seq:" + ",".join(str(s.get("type") or "") for s in action["steps"][:6] if isinstance(s, dict)))
    keys = action.get("keys")
    if isinstance(keys, list):
        parts.append("+".join(str(key).lower() for key in keys))
    if action.get("key") and kind != "hold_key":
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
    if kind == "hold_key":
        return "удержание {} ({} с)".format(action.get("key") or "w", action.get("seconds") or 0.5)
    if kind == "move_mouse_rel":
        return "поворот мыши ({}, {})".format(action.get("dx") or 0, action.get("dy") or 0)
    if kind == "sequence":
        steps = action.get("steps") or []
        return "серия из {} действий".format(len(steps) if isinstance(steps, list) else 0)
    if x is not None and y is not None:
        return "{} в ({}, {})".format(kind, x, y)
    if kind in ("key", "hotkey", "key_down", "key_up"):
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
    r"payment|transfer|покупка|очист|shutdown|reboot|regedit|powershell|cmd\.exe",
    re.IGNORECASE,
)

ALWAYS_CONFIRM_ACTIONS = {"launch_app", "run_command", "export_from_sandbox"}
DANGEROUS_HOTKEYS = {("alt", "f4"), ("ctrl", "alt", "delete"), ("win", "r"), ("super", "r")}

TRUST_ORDER = {"none": 0, "verified": 1, "full": 2}


def normalize_trust_level(raw: Any, default: str = "verified") -> str:
    value = str(raw or "").strip().lower()
    if value in TRUST_ORDER:
        return value
    return default


def effective_trust_level(cli_trust: str = "", assume_yes: bool = False, task_trust: str = "") -> str:
    """Выбирает действующий уровень доверия: задача CRM и строгий CLI уважаются."""
    cli = normalize_trust_level(cli_trust, "") if cli_trust else ("full" if assume_yes else "")
    task = normalize_trust_level(task_trust, "") if task_trust else ""
    if cli and task:
        # Если на сайте выставлено ограничение ("none" или "verified"), оно имеет приоритет,
        # а если CLI строже — побеждает более строгий вариант.
        return cli if TRUST_ORDER[cli] <= TRUST_ORDER[task] else task
    return task or cli or "verified"


def is_dangerous_action(action: Dict[str, Any]) -> bool:
    """Определяет, нужно ли подтверждение на сайте перед выполнением действия."""
    if not isinstance(action, dict):
        return False
    kind = str(action.get("type") or "").lower()
    if kind == "sequence" and isinstance(action.get("steps"), list):
        for sub in action["steps"][:12]:
            if isinstance(sub, dict) and is_dangerous_action(sub):
                return True
    if kind in ALWAYS_CONFIRM_ACTIONS:
        return True
    if bool(action.get("dangerous") or action.get("requires_confirmation")):
        return True
    if kind == "hotkey":
        keys = tuple(str(k).lower().strip() for k in (action.get("keys") or []) if str(k).strip())
        if keys in DANGEROUS_HOTKEYS:
            return True
    return bool(DANGEROUS.search(json.dumps(action, ensure_ascii=False)))


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

    # Уровни доверия и определение опасных действий.
    check("effective_trust_level: none побеждает full",
          effective_trust_level("full", True, "none") == "none"
          and effective_trust_level("none", False, "full") == "none")
    check("effective_trust_level: verified в задаче не обходится --yes",
          effective_trust_level("", True, "verified") == "verified"
          and effective_trust_level("", False, "") == "verified")
    check("is_dangerous_action помечает launch_app/run_command/alt+f4/dangerous",
          is_dangerous_action({"type": "launch_app", "app": "calc"})
          and is_dangerous_action({"type": "run_command", "command": "ls"})
          and is_dangerous_action({"type": "export_from_sandbox", "source": ".", "destination": "/tmp"})
          and is_dangerous_action({"type": "hotkey", "keys": ["alt", "f4"]})
          and is_dangerous_action({"type": "click", "x": 10, "y": 10, "dangerous": True})
          and not is_dangerous_action({"type": "click", "x": 10, "y": 10}))
    check("action_signature учитывает switch_language",
          action_signature({"type": "switch_language", "target": "ru"})
          != action_signature({"type": "switch_language", "target": "en"}))

    # Симуляция: при доверии 'none' действие блокируется, при 'verified' и лимите шагов —
    # задача продлевается на месте через ответ сайта и доходит до finish.
    none_op = Operator(crm="", token="", base_url="http://127.0.0.1:8000/v1",
                       model="sim-vl", api_key="", dry_run=False, assume_yes=False,
                       max_steps=3, delay=0.0, poll=1.0, max_width=1600, text_only=True,
                       vision_check=False, verify_actions=False, self_reflect=False,
                       trust_level="none")
    none_calls = {"n": 0, "executed": 0}

    class NoneModelHttp:
        def call(self, method: str, path: str, payload: Optional[dict] = None,
                 timeout: int = 30, headers: Optional[dict] = None) -> Dict[str, Any]:
            none_calls["n"] += 1
            if none_calls["n"] == 1:
                return {"choices": [{"message": {"content": json.dumps({
                    "thought": "кликну",
                    "action": {"type": "click", "x": 10, "y": 10}
                })}}]}
            return {"choices": [{"message": {"content": json.dumps({
                "thought": "завершаю",
                "action": {"type": "finish", "summary": "ok"}
            })}}]}

    none_op.model_http = NoneModelHttp()  # type: ignore[assignment]

    def count_exec(act: Dict[str, Any]) -> str:
        none_calls["executed"] += 1
        return "done"

    none_op.execute = count_exec  # type: ignore[method-assign]
    none_ok = none_op.run(None, "Кликни", 3)
    check("уровень доверия none блокирует клики и команды ПК",
          none_ok and none_calls["executed"] == 0)

    # Симуляция продления шагов на месте через CRM approval и подтверждения launch_app.
    ext_state = {"model_step": 0, "approvals": [], "finished": False, "executed": []}

    class ExtCrmHttp:
        def call(self, method: str, path: str, payload: Optional[dict] = None,
                 timeout: int = 30, headers: Optional[dict] = None) -> Dict[str, Any]:
            if path == "/api/agent/bot/77" and method == "GET":
                return {"task": {"id": 77, "status": "running", "maxSteps": 1,
                                 "trustLevel": "verified"}, "attachments": []}
            if path == "/api/agent/bot/77/approval" and method == "POST":
                ext_state["approvals"].append(payload)
                return {"ok": True}
            if path == "/api/agent/bot/77/finish" and method == "POST":
                ext_state["finished"] = (payload or {}).get("status") == "done"
                return {"ok": True}
            return {"ok": True}

    class ExtModelHttp:
        def call(self, method: str, path: str, payload: Optional[dict] = None,
                 timeout: int = 30, headers: Optional[dict] = None) -> Dict[str, Any]:
            ext_state["model_step"] += 1
            if ext_state["model_step"] == 1:
                return {"choices": [{"message": {"content": json.dumps({
                    "thought": "открываю",
                    "action": {"type": "launch_app", "app": "calc"}
                })}}]}
            return {"choices": [{"message": {"content": json.dumps({
                "thought": "готово",
                "action": {"type": "finish", "summary": "сделано после продления"}
            })}}]}

    ext_op = Operator(crm="http://127.0.0.1:3000", token="crmop_" + "a" * 32,
                      base_url="http://127.0.0.1:8000/v1", model="sim-vl", api_key="",
                      dry_run=False, assume_yes=False, max_steps=1, delay=0.0, poll=1.0,
                      max_width=1600, text_only=True, vision_check=False,
                      verify_actions=False, self_reflect=False, trust_level="verified")
    ext_op.crm = ExtCrmHttp()  # type: ignore[assignment]
    ext_op.model_http = ExtModelHttp()  # type: ignore[assignment]
    ext_op.execute = lambda act: (ext_state["executed"].append(act.get("type")), "launched")[1]  # type: ignore[method-assign]

    def fake_site_approval(task_id: Optional[int], kind: str, title: str,
                           description: str, action: Optional[Dict[str, Any]] = None,
                           extra_steps: int = 0) -> Dict[str, Any]:
        ext_state["approvals"].append({"kind": kind, "extra_steps": extra_steps})
        if kind == "step_limit":
            return {"decision": "extend", "extraSteps": 5}
        return {"decision": "approve"}

    ext_op.request_website_approval = fake_site_approval  # type: ignore[method-assign]
    ext_ok = ext_op.run(77, "Запусти калькулятор", 1)
    check("verified запрашивает одобрение опасных действий и продлевает шаги на месте без потери контекста",
          ext_ok and ext_state["finished"] and ext_state["executed"] == ["launch_app"]
          and [a["kind"] for a in ext_state["approvals"]] == ["dangerous_action", "step_limit"])

    # Симуляция досрочного увеличения maxSteps прямо на сайте во время работы задачи.
    live_state = {"model_step": 0, "finished": False}

    class LiveExtCrmHttp:
        def call(self, method: str, path: str, payload: Optional[dict] = None,
                 timeout: int = 30, headers: Optional[dict] = None) -> Dict[str, Any]:
            if path == "/api/agent/bot/78" and method == "GET":
                return {"task": {"id": 78, "status": "running",
                                 "maxSteps": 1 if live_state["model_step"] == 0 else 4,
                                 "trustLevel": "full"}, "attachments": []}
            if path == "/api/agent/bot/78/finish" and method == "POST":
                live_state["finished"] = (payload or {}).get("status") == "done"
                return {"ok": True}
            return {"ok": True}

    class LiveExtModelHttp:
        def call(self, method: str, path: str, payload: Optional[dict] = None,
                 timeout: int = 30, headers: Optional[dict] = None) -> Dict[str, Any]:
            live_state["model_step"] += 1
            if live_state["model_step"] == 1:
                return {"choices": [{"message": {"content": json.dumps({
                    "thought": "жду",
                    "action": {"type": "wait", "seconds": 0.1}
                })}}]}
            return {"choices": [{"message": {"content": json.dumps({
                "thought": "готово",
                "action": {"type": "finish", "summary": "досрочно продлено"}
            })}}]}

    live_op = Operator(crm="http://127.0.0.1:3000", token="crmop_" + "a" * 32,
                       base_url="http://127.0.0.1:8000/v1", model="sim-vl", api_key="",
                       dry_run=False, assume_yes=False, max_steps=1, delay=0.0, poll=1.0,
                       max_width=1600, text_only=True, vision_check=False,
                       verify_actions=False, self_reflect=False, trust_level="full")
    live_op.crm = LiveExtCrmHttp()  # type: ignore[assignment]
    live_op.model_http = LiveExtModelHttp()  # type: ignore[assignment]
    live_op.execute = lambda act: "waited"  # type: ignore[method-assign]
    live_ok = live_op.run(78, "Проверь досрочное продление", 1)
    check("увеличение maxSteps на сайте во время работы подхватывается на лету",
          live_ok and live_state["finished"] and live_state["model_step"] == 2)

    # Игровые действия, режим game/copilot, next_advice и пошаговый коучинг Агента.
    check("normalize_task_mode / normalize_coach_mode работают корректно",
          normalize_task_mode("game") == "game"
          and normalize_task_mode("unknown") == "autonomous"
          and normalize_coach_mode("agent") == "agent"
          and normalize_coach_mode("invalid") == "after_step"
          and "hold_key" in build_mode_system_addon("game", "agent"))

    check("action_signature / action_label для hold_key, move_mouse_rel и sequence",
          "hold:w:0.8" in action_signature({"type": "hold_key", "key": "W", "seconds": 0.8})
          and "rel:120:-15" in action_signature({"type": "move_mouse_rel", "dx": 120, "dy": -15})
          and "серия из 2" in action_label({"type": "sequence", "steps": [{"type": "key", "key": "w"}, {"type": "key", "key": "e"}]})
          and is_dangerous_action({"type": "sequence", "steps": [{"type": "hold_key", "key": "w", "seconds": 0.4}, {"type": "run_command", "command": "rm -rf /"}]}))

    parsed_adv = Operator.parse_decision(json.dumps({
        "observation": "Персонаж перед дверью",
        "thought": "Подойду ближе",
        "next_advice": "Потом нажми E",
        "action": {"type": "hold_key", "key": "w", "seconds": 0.5},
    }))
    check("parse_decision извлекает next_advice", parsed_adv["next_advice"] == "Потом нажми E")

    coach_state: Dict[str, Any] = {"step": 0, "prompts": [], "coach_calls": 0, "executed": [], "finished": False}

    class CoachCrmHttp:
        def call(self, method: str, path: str, payload: Optional[dict] = None,
                 timeout: int = 30, headers: Optional[dict] = None) -> Dict[str, Any]:
            if path == "/api/agent/bot/79" and method == "GET":
                return {
                    "task": {
                        "id": 79,
                        "status": "running",
                        "maxSteps": 5,
                        "trustLevel": "full",
                        "taskMode": "game",
                        "coachMode": "agent",
                    },
                    "attachments": [],
                }
            if path == "/api/agent/bot/79/coach" and method == "POST":
                coach_state["coach_calls"] += 1
                return {
                    "ok": True,
                    "guidance": {
                        "id": "g-step-1",
                        "author": "agent",
                        "text": "Нажми E у сундука и проверь инвентарь",
                        "userAdvice": "Персонаж подошёл — открываем сундук",
                    },
                }
            if path == "/api/agent/bot/79/finish" and method == "POST":
                coach_state["finished"] = (payload or {}).get("status") == "done"
                return {"ok": True}
            return {"ok": True}

    class CoachModelHttp:
        def call(self, method: str, path: str, payload: Optional[dict] = None,
                 timeout: int = 30, headers: Optional[dict] = None) -> Dict[str, Any]:
            coach_state["step"] += 1
            msgs = (payload or {}).get("messages") or []
            coach_state["prompts"].append(str(msgs[-1].get("content") or ""))
            if coach_state["step"] == 1:
                return {"choices": [{"message": {"content": json.dumps({
                    "thought": "Иду вперёд в игре",
                    "next_advice": "Подойдём ближе и осмотрим дверь",
                    "action": {"type": "hold_key", "key": "w", "seconds": 0.4}
                })}}]}
            return {"choices": [{"message": {"content": json.dumps({
                "thought": "Готово",
                "action": {"type": "finish", "summary": "дошёл и открыл"}
            })}}]}

    coach_op = Operator(crm="http://127.0.0.1:3000", token="crmop_" + "a" * 32,
                        base_url="http://127.0.0.1:8000/v1", model="sim-vl", api_key="",
                        dry_run=False, assume_yes=False, max_steps=5, delay=0.0, poll=1.0,
                        max_width=1600, text_only=True, vision_check=False,
                        verify_actions=False, self_reflect=False, trust_level="full")
    coach_op.crm = CoachCrmHttp()  # type: ignore[assignment]
    coach_op.model_http = CoachModelHttp()  # type: ignore[assignment]
    coach_op.execute = lambda act: (coach_state["executed"].append(act.get("type")), "done:" + str(act.get("type")))[1]  # type: ignore[method-assign]
    coach_ok = coach_op.run(79, "Помоги пройти квест в игре", 5)
    check("игровой режим и пошаговый коучинг Агента передают наставление в следующий шаг",
          coach_ok
          and coach_state["finished"]
          and coach_state["coach_calls"] == 1
          and coach_state["executed"] == ["hold_key"]
          and len(coach_state["prompts"]) >= 2
          and "Нажми E у сундука" in coach_state["prompts"][1])

    inspect_state: Dict[str, Any] = {"screen_posts": 0, "finished": False, "summary": "", "executed": 0}

    class InspectCrmHttp:
        def call(self, method: str, path: str, payload: Optional[dict] = None,
                 timeout: int = 30, headers: Optional[dict] = None) -> Dict[str, Any]:
            if path == "/api/agent/bot/80" and method == "GET":
                return {
                    "task": {
                        "id": 80,
                        "status": "running",
                        "maxSteps": 2,
                        "trustLevel": "verified",
                        "taskMode": "inspect",
                        "coachMode": "off",
                    },
                    "attachments": [],
                }
            if path == "/api/agent/bot/80/screen" and method == "POST":
                inspect_state["screen_posts"] += 1
                inspect_state["has_image"] = str((payload or {}).get("image") or "").startswith("data:image/")
                return {"ok": True, "eventId": 901}
            if path == "/api/agent/bot/80/finish" and method == "POST":
                inspect_state["finished"] = (payload or {}).get("status") == "done"
                inspect_state["summary"] = str((payload or {}).get("summary") or "")
                return {"ok": True}
            return {"ok": True}

    inspect_op = Operator(crm="http://127.0.0.1:3000", token="crmop_" + "a" * 32,
                          base_url="", model="", api_key="",
                          dry_run=False, assume_yes=False, max_steps=2, delay=0.0, poll=1.0,
                          max_width=1600, text_only=False, vision_check=False,
                          verify_actions=False, self_reflect=False, trust_level="verified")
    inspect_op.crm = InspectCrmHttp()  # type: ignore[assignment]
    inspect_op.screenshot = lambda: (  # type: ignore[method-assign]
        "data:image/jpeg;base64,/9j/4AAQ",
        {"width": 1280, "height": 720, "screen_width": 1920, "screen_height": 1080},
    )
    inspect_op.execute = lambda act: (inspect_state.__setitem__("executed", inspect_state["executed"] + 1), "nope")[1]  # type: ignore[method-assign]
    inspect_ok = inspect_op.run(80, "Покажи Агенту открытое окно", 2)
    check("режим inspect делает только снимок экрана без кликов и отправляет его Агенту",
          inspect_ok
          and normalize_task_mode("inspect") == "inspect"
          and inspect_state["screen_posts"] == 1
          and inspect_state["has_image"]
          and inspect_state["finished"]
          and inspect_state["executed"] == 0
          and "1280×720" in inspect_state["summary"])

    # Проверка Win32-структур SendInput (40 байт на 64-bit / 28 байт на 32-bit) и скан-кодов стрелок.
    import ctypes
    MouseInput, KeyBdInput, _, _, WinInput = _win32_input_types()
    ptr_size = ctypes.sizeof(ctypes.c_size_t)
    expected_input_size = 40 if ptr_size == 8 else 28
    expected_mouse_size = 32 if ptr_size == 8 else 24
    expected_kbd_size = 24 if ptr_size == 8 else 16
    check("Win32 INPUT имеет точный размер для SendInput и корректные make-коды клавиш",
          ctypes.sizeof(WinInput) == expected_input_size
          and ctypes.sizeof(MouseInput) == expected_mouse_size
          and ctypes.sizeof(KeyBdInput) == expected_kbd_size
          and _win32_scancode_lookup("w") == (0x11, False)
          and _win32_scancode_lookup("up") == (0x48, True)
          and _win32_scancode_lookup("down") == (0x50, True)
          and _win32_scancode_lookup("left") == (0x4B, True)
          and _win32_scancode_lookup("right") == (0x4D, True)
          and _win32_scancode_lookup("rshift") == (0x36, False))

    # Проверка парсинга обрезанного JSON саморазбора и достаточного max_tokens у verify_action.
    truncated_refl = (
        '{\n  "question": "Почему персонаж не двигается?",\n'
        '  "diagnosis": "Ввод не дошёл до окна или персонаж упёрся в преп'
    )
    parsed_trunc = Operator.parse_reflection(truncated_refl, "что не так?")
    check("parse_reflection извлекает diagnosis из обрезанного JSON без вывода сырого текста",
          parsed_trunc["question"] == "Почему персонаж не двигается?"
          and "Ввод не дошёл" in parsed_trunc["diagnosis"]
          and not parsed_trunc["diagnosis"].lstrip().startswith("{"))

    verify_payloads: List[Dict[str, Any]] = []

    class VerifyModelHttp:
        def call(self, method: str, path: str, payload: Optional[dict] = None,
                 timeout: int = 30, headers: Optional[dict] = None) -> Dict[str, Any]:
            if payload:
                verify_payloads.append(dict(payload))
            return {"choices": [{"message": {"content": '{"ok": true, "note": "персонаж сдвинулся"}'}}]}

    verify_op = Operator(crm="", token="", base_url="http://127.0.0.1:8000/v1",
                         model="sim-vl", api_key="", dry_run=False, assume_yes=True,
                         max_steps=5, delay=0.0, poll=1.0, max_width=1600,
                         verify_actions=True, self_reflect=False, text_only=False)
    verify_op.model_http = VerifyModelHttp()  # type: ignore[assignment]
    verify_op.screenshot = lambda: (  # type: ignore[method-assign]
        "data:image/jpeg;base64,BBB",
        {"width": 1280, "height": 720, "screen_width": 1920, "screen_height": 1080},
    )
    verdict = verify_op.verify_action(
        {"type": "hold_key", "key": "w", "seconds": 1.0},
        "удержание w (1.00 с)",
        step_context="пройти вперёд",
    )
    check("verify_action использует достаточный max_tokens >= 1200 и возвращает валидный вердикт",
          bool(verify_payloads)
          and int(verify_payloads[0].get("max_tokens") or 0) >= 1200
          and verdict is not None
          and verdict.get("ok") is True)

    passed = sum(1 for item in checks if item)
    print("\n{}/{} проверок пройдено".format(passed, len(checks)))
    return 0 if passed == len(checks) else 1


def get_active_window_title() -> str:
    """Возвращает заголовок активного окна (без ошибок при отсутствии GUI)."""
    system = platform.system()
    try:
        if system == "Windows":
            import ctypes  # noqa: PLC0415

            user32 = ctypes.windll.user32  # type: ignore[attr-defined]
            hwnd = user32.GetForegroundWindow()
            if not hwnd:
                return ""
            length = user32.GetWindowTextLengthW(hwnd)
            if length <= 0:
                return ""
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            return str(buf.value or "").strip()[:300]
        if system == "Darwin" and shutil.which("osascript"):
            proc = subprocess.run(
                [
                    "osascript",
                    "-e",
                    'tell application "System Events" to get name of first application process whose frontmost is true',
                ],
                capture_output=True,
                text=True,
                timeout=3,
            )
            return (proc.stdout or "").strip()[:300]
        if shutil.which("xdotool"):
            proc = subprocess.run(
                ["xdotool", "getactivewindow", "getwindowname"],
                capture_output=True,
                text=True,
                timeout=3,
            )
            if proc.returncode == 0:
                return (proc.stdout or "").strip()[:300]
    except Exception:  # noqa: BLE001
        return ""
    return ""


def copy_to_clipboard(text: str) -> bool:
    """Копирует текст в буфер обмена через pyperclip или системную утилиту."""
    if pyperclip is not None:
        try:
            pyperclip.copy(text)
            return True
        except Exception:  # noqa: BLE001
            pass
    system = platform.system()
    try:
        if system == "Windows":
            subprocess.run(["clip"], input=text.encode("utf-16-le"), check=True, timeout=5)
            return True
        if system == "Darwin" and shutil.which("pbcopy"):
            subprocess.run(["pbcopy"], input=text.encode("utf-8"), check=True, timeout=5)
            return True
        for tool in (["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]):
            if shutil.which(tool[0]):
                subprocess.run(tool, input=text.encode("utf-8"), check=True, timeout=5)
                return True
    except Exception:  # noqa: BLE001
        return False
    return False


def read_from_clipboard() -> str:
    """Читает текст из буфера обмена."""
    if pyperclip is not None:
        try:
            return str(pyperclip.paste() or "")
        except Exception:  # noqa: BLE001
            pass
    system = platform.system()
    try:
        if system == "Darwin" and shutil.which("pbpaste"):
            out = subprocess.run(["pbpaste"], stdout=subprocess.PIPE, check=True, timeout=5)
            return out.stdout.decode("utf-8", "replace")
        for tool in (["xclip", "-selection", "clipboard", "-o"], ["xsel", "--clipboard", "--output"]):
            if shutil.which(tool[0]):
                out = subprocess.run(tool, stdout=subprocess.PIPE, check=True, timeout=5)
                return out.stdout.decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        pass
    return ""


def get_keyboard_layout() -> str:
    """Возвращает код текущей раскладки ('ru', 'en' или ''), если ОС позволяет узнать."""
    if platform.system() == "Windows":
        try:
            import ctypes

            user32 = ctypes.windll.user32
            hwnd = user32.GetForegroundWindow()
            tid = user32.GetWindowThreadProcessId(hwnd, None) if hwnd else 0
            hkl = user32.GetKeyboardLayout(tid)
            lang_id = hkl & 0xFFFF
            if lang_id == 0x0419:
                return "ru"
            if lang_id in (0x0409, 0x0809):
                return "en"
        except Exception:  # noqa: BLE001
            pass
    return ""


def switch_keyboard_layout(target: str = "toggle") -> str:
    """Переключает раскладку клавиатуры (ru / en / toggle)."""
    goal = str(target or "toggle").strip().lower()
    if goal in ("rus", "russian", "рус", "русский"):
        goal = "ru"
    elif goal in ("eng", "english", "us", "англ", "английский"):
        goal = "en"
    elif goal not in ("ru", "en"):
        goal = "toggle"

    current = get_keyboard_layout()
    if goal in ("ru", "en") and current == goal:
        return "раскладка уже {}".format(goal.upper())

    system = platform.system()
    if system == "Windows":
        try:
            import ctypes

            user32 = ctypes.windll.user32
            hwnd = user32.GetForegroundWindow()
            if hwnd and goal in ("ru", "en"):
                layout_hex = "00000419" if goal == "ru" else "00000409"
                hkl = user32.LoadKeyboardLayoutW(layout_hex, 1)
                if hkl:
                    user32.PostMessageW(hwnd, 0x0050, 0, hkl)
                    time.sleep(0.15)
                    if get_keyboard_layout() == goal:
                        return "раскладка переключена на {}".format(goal.upper())
        except Exception:  # noqa: BLE001
            pass
        if pyautogui is not None:
            pyautogui.hotkey("alt", "shift")
            time.sleep(0.15)
            after = get_keyboard_layout()
            if goal in ("ru", "en") and after and after != goal:
                pyautogui.hotkey("win", "space")
                time.sleep(0.15)
            return "переключил раскладку (Alt+Shift / Win+Space)"

    if system == "Linux" and goal in ("ru", "en") and shutil.which("setxkbmap"):
        try:
            subprocess.run(["setxkbmap", "ru" if goal == "ru" else "us"], check=True, timeout=5)
            return "раскладка переключена на {} (setxkbmap)".format(goal.upper())
        except Exception:  # noqa: BLE001
            pass

    require_pyautogui()
    if system == "Darwin":
        pyautogui.hotkey("ctrl", "space")
        return "переключил раскладку (Ctrl+Space)"
    pyautogui.hotkey("alt", "shift")
    return "переключил раскладку (Alt+Shift)"


_WIN_SCANCODES: Dict[str, Tuple[int, bool]] = {
    "escape": (0x01, False), "esc": (0x01, False),
    "1": (0x02, False), "2": (0x03, False), "3": (0x04, False), "4": (0x05, False), "5": (0x06, False),
    "6": (0x07, False), "7": (0x08, False), "8": (0x09, False), "9": (0x0A, False), "0": (0x0B, False),
    "-": (0x0C, False), "=": (0x0D, False), "backspace": (0x0E, False), "tab": (0x0F, False),
    "q": (0x10, False), "w": (0x11, False), "e": (0x12, False), "r": (0x13, False), "t": (0x14, False),
    "y": (0x15, False), "u": (0x16, False), "i": (0x17, False), "o": (0x18, False), "p": (0x19, False),
    "[": (0x1A, False), "]": (0x1B, False), "enter": (0x1C, False), "return": (0x1C, False),
    "ctrl": (0x1D, False), "lctrl": (0x1D, False), "rctrl": (0x1D, True),
    "a": (0x1E, False), "s": (0x1F, False), "d": (0x20, False), "f": (0x21, False), "g": (0x22, False),
    "h": (0x23, False), "j": (0x24, False), "k": (0x25, False), "l": (0x26, False),
    ";": (0x27, False), "'": (0x28, False), "`": (0x29, False),
    "shift": (0x2A, False), "lshift": (0x2A, False), "rshift": (0x36, False),
    "z": (0x2C, False), "x": (0x2D, False), "c": (0x2E, False), "v": (0x2F, False),
    "b": (0x30, False), "n": (0x31, False), "m": (0x32, False),
    ",": (0x33, False), ".": (0x34, False), "/": (0x35, False),
    "alt": (0x38, False), "lalt": (0x38, False), "ralt": (0x38, True),
    "space": (0x39, False), "spacebar": (0x39, False), " ": (0x39, False),
    "capslock": (0x3A, False),
    "f1": (0x3B, False), "f2": (0x3C, False), "f3": (0x3D, False), "f4": (0x3E, False),
    "f5": (0x3F, False), "f6": (0x40, False), "f7": (0x41, False), "f8": (0x42, False),
    "f9": (0x43, False), "f10": (0x44, False), "f11": (0x57, False), "f12": (0x58, False),
    "home": (0x47, True), "up": (0x48, True), "pageup": (0x49, True), "pgup": (0x49, True),
    "left": (0x4B, True), "right": (0x4D, True),
    "end": (0x4F, True), "down": (0x50, True), "pagedown": (0x51, True), "pgdn": (0x51, True),
    "insert": (0x52, True), "delete": (0x53, True),
}

_WIN32_SENDINPUT_WARNED = False


def _win32_scancode_lookup(key: str) -> Optional[Tuple[int, bool]]:
    return _WIN_SCANCODES.get(str(key or "").strip().lower())


def _win32_input_types() -> Tuple[Any, Any, Any, Any, Any]:
    """Win32-структуры INPUT (ровно 40 байт на x64, 28 байт на x86 — иначе SendInput возвращает 0)."""
    import ctypes

    class MouseInput(ctypes.Structure):
        _fields_ = [
            ("dx", ctypes.c_int32),
            ("dy", ctypes.c_int32),
            ("mouseData", ctypes.c_uint32),
            ("dwFlags", ctypes.c_uint32),
            ("time", ctypes.c_uint32),
            ("dwExtraInfo", ctypes.c_size_t),
        ]

    class KeyBdInput(ctypes.Structure):
        _fields_ = [
            ("wVk", ctypes.c_uint16),
            ("wScan", ctypes.c_uint16),
            ("dwFlags", ctypes.c_uint32),
            ("time", ctypes.c_uint32),
            ("dwExtraInfo", ctypes.c_size_t),
        ]

    class HardwareInput(ctypes.Structure):
        _fields_ = [
            ("uMsg", ctypes.c_uint32),
            ("wParamL", ctypes.c_uint16),
            ("wParamH", ctypes.c_uint16),
        ]

    class InputUnion(ctypes.Union):
        _fields_ = [
            ("mi", MouseInput),
            ("ki", KeyBdInput),
            ("hi", HardwareInput),
        ]

    class Input(ctypes.Structure):
        _fields_ = [
            ("type", ctypes.c_uint32),
            ("ii", InputUnion),
        ]

    return MouseInput, KeyBdInput, HardwareInput, InputUnion, Input


def _win32_dispatch_input(inp: Any, InputCls: Any) -> bool:
    global _WIN32_SENDINPUT_WARNED
    import ctypes

    ctypes.set_last_error(0)
    sent = ctypes.windll.user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(InputCls))
    if sent == 1:
        return True
    err = ctypes.get_last_error()
    if not _WIN32_SENDINPUT_WARNED:
        _WIN32_SENDINPUT_WARNED = True
        hint = " (если игра запущена от администратора, запустите Оператора тоже от администратора)" if err == 5 else ""
        log("[!] Win32 SendInput не доставил событие (sent={}, err={}{})".format(sent, err, hint))
    return False


def _win32_send_scancode(key: str, down: bool) -> bool:
    """Низкоуровневый DirectInput-сканкод на Windows (нужен для 3D-игр)."""
    if platform.system() != "Windows":
        return False
    entry = _win32_scancode_lookup(key)
    if entry is None:
        return False
    code, extended = entry
    try:
        _, KeyBdInput, _, InputUnion, Input = _win32_input_types()
        flags = 0x0008  # KEYEVENTF_SCANCODE
        if extended:
            flags |= 0x0001  # KEYEVENTF_EXTENDEDKEY
        if not down:
            flags |= 0x0002  # KEYEVENTF_KEYUP
        ii = InputUnion(ki=KeyBdInput(0, code & 0xFF, flags, 0, 0))
        inp = Input(1, ii)
        return _win32_dispatch_input(inp, Input)
    except Exception:  # noqa: BLE001
        return False


def _win32_move_mouse_rel(dx: int, dy: int) -> bool:
    """Относительное смещение мыши через Windows SendInput (поворот камеры в играх)."""
    if platform.system() != "Windows":
        return False
    try:
        MouseInput, _, _, InputUnion, Input = _win32_input_types()
        ii = InputUnion(mi=MouseInput(int(dx), int(dy), 0, 0x0001, 0, 0))
        inp = Input(0, ii)
        return _win32_dispatch_input(inp, Input)
    except Exception:  # noqa: BLE001
        return False


def _win32_mouse_button(button: str, down: bool) -> bool:
    """Нажатие/отпускание кнопки мыши через 40-байтный SendInput на Windows."""
    if platform.system() != "Windows":
        return False
    btn = str(button or "left").strip().lower()
    flag_map = {
        "left": (0x0002, 0x0004),
        "right": (0x0008, 0x0010),
        "middle": (0x0020, 0x0040),
    }
    pair = flag_map.get(btn)
    if not pair:
        return False
    try:
        MouseInput, _, _, InputUnion, Input = _win32_input_types()
        flag = pair[0] if down else pair[1]
        ii = InputUnion(mi=MouseInput(0, 0, 0, flag, 0, 0))
        inp = Input(0, ii)
        return _win32_dispatch_input(inp, Input)
    except Exception:  # noqa: BLE001
        return False


def send_key_state(key: str, down: bool) -> None:
    """Зажимает или отпускает клавишу (с DirectInput-приоритетом на Windows)."""
    clean = str(key or "").strip().lower()
    if not clean:
        return
    if _win32_send_scancode(clean, down=down):
        return
    require_pyautogui()
    if down:
        pyautogui.keyDown(clean)
    else:
        pyautogui.keyUp(clean)


def send_key_tap(key: str, hold_seconds: float = 0.05) -> None:
    """Нажимает и отпускает клавишу (с DirectInput-приоритетом на Windows)."""
    clean = str(key or "").strip().lower()
    if not clean:
        return
    if _win32_send_scancode(clean, down=True):
        time.sleep(max(0.02, hold_seconds))
        _win32_send_scancode(clean, down=False)
        return
    require_pyautogui()
    pyautogui.press(clean)


def send_mouse_rel(dx: int, dy: int) -> None:
    """Сдвигает мышь относительно текущей позиции (плавно при больших углах для 3D-камеры)."""
    dx_i = int(dx)
    dy_i = int(dy)
    max_delta = max(abs(dx_i), abs(dy_i))
    if max_delta > 30:
        steps = min(14, max(3, max_delta // 25))
        rem_x, rem_y = dx_i, dy_i
        for i in range(steps):
            left = steps - i
            step_x = int(round(rem_x / left))
            step_y = int(round(rem_y / left))
            rem_x -= step_x
            rem_y -= step_y
            if not _win32_move_mouse_rel(step_x, step_y):
                require_pyautogui()
                pyautogui.moveRel(step_x, step_y, duration=0.01)
            time.sleep(0.008)
        return
    if _win32_move_mouse_rel(dx_i, dy_i):
        return
    require_pyautogui()
    pyautogui.moveRel(dx_i, dy_i, duration=0.08)


def type_text(text: str) -> None:
    """Ввод текста: проверяет раскладку и использует буфер обмена для не-ASCII."""
    if not text:
        return
    require_pyautogui()
    plain = all(ord(char) < 128 for char in text) and "\n" not in text
    if plain and len(text) <= 200:
        # Если в Windows стоит русская раскладка, ASCII через write() превратится в кракозябры.
        if get_keyboard_layout() == "ru":
            switch_keyboard_layout("en")
        pyautogui.write(text, interval=0.02)
        return
    if copy_to_clipboard(text):
        modifier = "command" if platform.system() == "Darwin" else "ctrl"
        pyautogui.hotkey(modifier, "v")
        time.sleep(0.06)
        return
    # Резерв: если буфер обмена вообще недоступен, переключаемся на нужную раскладку.
    if any("а" <= ch.lower() <= "я" or ch.lower() == "ё" for ch in text):
        switch_keyboard_layout("ru")
    pyautogui.write(text, interval=0.02)


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
                 self_reflect: bool = True, trust_level: str = "",
                 task_mode: str = "", coach_mode: str = "") -> None:
        self.crm = Http(crm, token, kind="CRM")
        self.has_crm = bool(crm and token)
        self.model_http = Http(base_url, kind="модель", key_hint=key_hint)
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.dry_run = dry_run
        self.assume_yes = assume_yes
        self.cli_trust_level = normalize_trust_level(trust_level, "") if trust_level else ""
        self.task_trust_level = ""
        self.cli_task_mode = normalize_task_mode(task_mode, "") if task_mode else ""
        self.task_mode = ""
        self.cli_coach_mode = normalize_coach_mode(coach_mode, "") if coach_mode else ""
        self.task_coach_mode = ""
        self._held_keys: set[str] = set()
        self._held_buttons: set[str] = set()
        self._last_guidance_id: str = ""
        self.pending_guidance: str = ""
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
        sys_prompt = SYSTEM_PROMPT + build_mode_system_addon(self.current_task_mode(), self.current_coach_mode())
        content: Any = prompt if not parts else [{"type": "text", "text": prompt}, *parts]
        messages = [
            {"role": "system", "content": sys_prompt},
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
                                   "temperature": 0, "max_tokens": 1200, "stream": False}
        self.apply_generation(payload)
        payload["temperature"] = 0
        payload["max_tokens"] = max(1200, int(payload.get("max_tokens") or 0))
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
        # Если JSON оборвался по max_tokens, вытаскиваем хотя бы partial diagnosis/next_strategy.
        if cleaned.lstrip().startswith("{"):
            diag_m = re.search(r'"diagnosis"\s*:\s*"([^"\n]*)', cleaned)
            strat_m = re.search(r'"next_strategy"\s*:\s*"([^"\n]*)', cleaned)
            q_m = re.search(r'"question"\s*:\s*"([^"\n]*)', cleaned)
            if diag_m or strat_m:
                return {
                    "question": (q_m.group(1) if q_m else default_question).strip()[:280],
                    "diagnosis": (diag_m.group(1) if diag_m else "").strip()[:400],
                    "next_strategy": (strat_m.group(1) if strat_m else "").strip()[:400],
                }
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
                "max_tokens": 1200,
                "stream": False,
            }
            self.apply_generation(payload)
            if (self.generation or {}).get("temperature") is None:
                payload["temperature"] = 0.3
            payload["max_tokens"] = max(1200, int(payload.get("max_tokens") or 0))
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
            "next_advice": str(data.get("next_advice") or data.get("advice") or "").strip(),
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

        if kind == "switch_language":
            return switch_keyboard_layout(str(action.get("target") or "toggle"))

        if kind == "clipboard_get":
            text = read_from_clipboard()
            return "в буфере ({} симв.): {}".format(len(text), text[:300])

        if kind == "clipboard_set":
            text = str(action.get("text") or "")
            if copy_to_clipboard(text):
                return "скопировано в буфер ({} симв.)".format(len(text))
            return "не удалось записать в буфер обмена"

        if kind == "launch_app":
            app_name = str(action.get("app") or action.get("path") or "").strip()
            if not app_name:
                return "не указано приложение"
            args = [str(a) for a in (action.get("args") or []) if str(a).strip()]
            exe = shutil.which(app_name)
            if not exe and Path(app_name).is_file():
                exe = app_name
            if not exe and platform.system() == "Windows":
                os.startfile(app_name)  # type: ignore[attr-defined]
                return "запущено приложение: " + app_name
            if not exe and platform.system() == "Darwin":
                subprocess.Popen(["open", "-a", app_name, *args])
                return "запущено приложение: " + app_name
            if not exe:
                raise AgentError("приложение не найдено: " + app_name)
            subprocess.Popen([exe, *args])
            return "запущено приложение: " + app_name

        if kind == "sandbox_write_file":
            if sandbox_mod is None:
                raise AgentError("Модуль sandbox.py не найден")
            rel = str(action.get("path") or "output.txt")
            content = str(action.get("content") or "")
            res = sandbox_mod.write_text_file(rel, content)
            return "Sandbox: сохранён {} ({} Б)".format(res["path"], res["bytes"])

        if kind == "sandbox_list":
            if sandbox_mod is None:
                raise AgentError("Модуль sandbox.py не найден")
            rel = str(action.get("path") or ".")
            items = sandbox_mod.list_tree(rel)
            names = [it["path"] + ("/" if it["is_dir"] else "") for it in items[:25]]
            return "Sandbox ({}): {}".format(len(items), ", ".join(names) or "пусто")

        if kind == "run_command":
            if sandbox_mod is None:
                raise AgentError("Модуль sandbox.py не найден")
            cmd = str(action.get("command") or "").strip()
            if not cmd:
                return "пустая команда"
            cwd = str(action.get("cwd") or ".")
            res = sandbox_mod.run_command(cmd, rel_cwd=cwd, timeout=int(action.get("timeout") or 60))
            out = (res.get("stdout") or "") + (res.get("stderr") or "")
            return "команда (код {}): {}".format(res.get("exit_code"), out[:400] or "без вывода")

        if kind == "export_from_sandbox":
            if sandbox_mod is None:
                raise AgentError("Модуль sandbox.py не найден")
            source = str(action.get("source") or ".")
            destination = str(action.get("destination") or "").strip()
            if not destination:
                raise AgentError("не указана папка назначения для экспорта из Sandbox")
            move = str(action.get("mode") or "copy").lower() == "move"
            res = sandbox_mod.export_path(source, destination, move=move)
            return "экспорт из Sandbox ({}): {} → {} ({} файлов)".format(
                res["mode"], res["source"], res["destination"], res["files"])

        require_pyautogui()

        if kind in ("click", "double_click", "right_click", "middle_click", "triple_click"):
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
            if kind == "middle_click":
                pyautogui.middleClick(x=x, y=y)
                return "средний клик в ({}, {})".format(x, y)
            if kind == "triple_click":
                pyautogui.tripleClick(x=x, y=y)
                return "тройной клик в ({}, {})".format(x, y)
            pyautogui.rightClick(x=x, y=y)
            return "правый клик в ({}, {})".format(x, y)

        if kind == "select_all_copy":
            if action.get("x") is not None and action.get("y") is not None:
                x, y = self.to_screen(action.get("x"), action.get("y"))
                self.ensure_cursor(x, y)
                pyautogui.click(x=x, y=y)
                time.sleep(0.15)
            modifier = "command" if platform.system() == "Darwin" else "ctrl"
            pyautogui.hotkey(modifier, "a")
            time.sleep(0.08)
            pyautogui.hotkey(modifier, "c")
            time.sleep(0.1)
            copied = read_from_clipboard()
            return "скопировано ({} симв.): {}".format(len(copied), copied[:300])

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
            if platform.system() == "Windows" and all(_win32_scancode_lookup(k) is not None for k in keys):
                pressed: List[str] = []
                try:
                    for k in keys:
                        send_key_state(k, down=True)
                        pressed.append(k)
                        time.sleep(0.02)
                    time.sleep(0.04)
                finally:
                    for k in reversed(pressed):
                        send_key_state(k, down=False)
                        time.sleep(0.015)
            else:
                require_pyautogui()
                pyautogui.hotkey(*keys)
            return "нажато: " + " + ".join(keys)

        if kind == "key":
            key = str(action.get("key") or "enter").lower()
            send_key_tap(key, hold_seconds=0.05 if self.current_task_mode() == "game" else 0.03)
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

        if kind == "move_mouse_rel":
            dx = max(-2500, min(2500, int(round(float(action.get("dx") or 0)))))
            dy = max(-2500, min(2500, int(round(float(action.get("dy") or 0)))))
            send_mouse_rel(dx, dy)
            return "смещение мыши ({:+d}, {:+d})".format(dx, dy)

        if kind == "mouse_down":
            button = str(action.get("button") or "left").lower()
            if action.get("x") is not None and action.get("y") is not None:
                x, y = self.to_screen(action.get("x"), action.get("y"))
                self.ensure_cursor(x, y)
            if not _win32_mouse_button(button, down=True):
                require_pyautogui()
                pyautogui.mouseDown(button=button)
            self._held_buttons.add(button)
            return "зажата кнопка мыши " + button

        if kind == "mouse_up":
            button = str(action.get("button") or "left").lower()
            if not _win32_mouse_button(button, down=False):
                require_pyautogui()
                pyautogui.mouseUp(button=button)
            self._held_buttons.discard(button)
            return "отпущена кнопка мыши " + button

        if kind == "key_down":
            key = str(action.get("key") or "").strip().lower()
            if not key:
                return "не указана клавиша"
            send_key_state(key, down=True)
            self._held_keys.add(key)
            return "зажата клавиша " + key

        if kind == "key_up":
            key = str(action.get("key") or "").strip().lower()
            if not key:
                return "не указана клавиша"
            send_key_state(key, down=False)
            self._held_keys.discard(key)
            return "отпущена клавиша " + key

        if kind == "hold_key":
            key = str(action.get("key") or "w").strip().lower()
            seconds = max(0.05, min(5.0, float(action.get("seconds") or 0.5)))
            send_key_state(key, down=True)
            self._held_keys.add(key)
            try:
                time.sleep(seconds)
            finally:
                send_key_state(key, down=False)
                self._held_keys.discard(key)
            return "удержание {} ({:.2f} с)".format(key, seconds)

        if kind == "sequence":
            substeps = action.get("steps") or []
            if not isinstance(substeps, list) or not substeps:
                return "пустая серия действий"
            outcomes: List[str] = []
            for sub in substeps[:10]:
                if not isinstance(sub, dict):
                    continue
                sub_type = str(sub.get("type") or "").lower()
                if sub_type in ("", "sequence", "finish"):
                    continue
                outcomes.append(self.execute(sub))
                time.sleep(0.04)
            return "серия: " + "; ".join(outcomes[:6])

        return "неизвестное действие: {}".format(kind)

    def release_all_inputs(self) -> None:
        """Безопасно отпускает все удержанные клавиши/кнопки мыши при остановке или ошибке."""
        for key in list(self._held_keys):
            try:
                send_key_state(key, down=False)
            except Exception:  # noqa: BLE001
                pass
            self._held_keys.discard(key)
        for btn in list(self._held_buttons):
            try:
                if not _win32_mouse_button(btn, down=False) and pyautogui is not None:
                    pyautogui.mouseUp(button=btn)
            except Exception:  # noqa: BLE001
                pass
            self._held_buttons.discard(btn)

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

    def current_trust_level(self) -> str:
        return effective_trust_level(self.cli_trust_level, self.assume_yes, self.task_trust_level)

    def current_task_mode(self) -> str:
        if self.cli_task_mode:
            return self.cli_task_mode
        if self.task_mode:
            return self.task_mode
        return "autonomous"

    def current_coach_mode(self) -> str:
        if self.cli_coach_mode:
            return self.cli_coach_mode
        if self.task_coach_mode:
            return self.task_coach_mode
        return "after_step"

    def sync_task_state(self, task_id: Optional[int]) -> Optional[Dict[str, Any]]:
        """Запрашиваем свежее состояние задачи (статус, лимит шагов, режим, подсказки и доверие)."""
        if not (self.has_crm and task_id):
            return None
        try:
            data = self.crm.call("GET", "/api/agent/bot/{}".format(task_id), timeout=10)
        except TaskCancelled:
            raise
        except AgentError:
            return None
        task = data.get("task")
        if isinstance(task, dict):
            if task.get("trustLevel"):
                self.task_trust_level = normalize_trust_level(task.get("trustLevel"), "verified")
            if task.get("taskMode"):
                self.task_mode = normalize_task_mode(task.get("taskMode"), "autonomous")
            if task.get("coachMode"):
                self.task_coach_mode = normalize_coach_mode(task.get("coachMode"), "after_step")
            note = task.get("guidanceNote")
            if isinstance(note, dict) and note.get("id") and note.get("text"):
                note_id = str(note.get("id"))
                if note_id != self._last_guidance_id:
                    self._last_guidance_id = note_id
                    guidance_text = str(note.get("text") or "").strip()
                    if note.get("userAdvice"):
                        guidance_text += "\n(Совет пользователю: {})".format(str(note.get("userAdvice")).strip())
                    self.pending_guidance = guidance_text
                    log("  получено указание ({}): {}".format(note.get("author") or "crm", guidance_text[:180]))
            if str(task.get("status") or "") == "cancelled":
                raise TaskCancelled("Задание отменено в CRM")
        return task if isinstance(task, dict) else None

    def post_step_assist(
        self,
        task_id: Optional[int],
        step_index: int,
        action: Dict[str, Any],
        result: str,
        decision: Dict[str, Any],
        screenshot: Optional[str] = None,
    ) -> None:
        """После каждого действия помогает Оператору и пользователю определить, что делать дальше."""
        coach = self.current_coach_mode()
        if coach == "off":
            return

        model_advice = str(decision.get("next_advice") or "").strip()
        observation = str(decision.get("observation") or decision.get("thought") or "").strip()

        if coach == "agent" and self.has_crm and task_id:
            try:
                resp = self.crm.call(
                    "POST",
                    "/api/agent/bot/{}/coach".format(task_id),
                    {
                        "step": step_index + 1,
                        "lastAction": action,
                        "lastResult": result[:400],
                        "observation": observation[:400],
                        "lastGuidanceId": self._last_guidance_id,
                        "history": self.history[-8:],
                        **({"screenshot": screenshot} if screenshot else {}),
                    },
                    timeout=35,
                )
                g = resp.get("guidance") if isinstance(resp, dict) else None
                if isinstance(g, dict) and g.get("text"):
                    if g.get("id"):
                        self._last_guidance_id = str(g["id"])
                    text = str(g["text"]).strip()
                    advice_line = str(g.get("userAdvice") or "").strip()
                    self.pending_guidance = text
                    log("  [совет Агента] {}".format((advice_line or text)[:220]))
                    return
            except TaskCancelled:
                raise
            except AgentError as error:
                log("[!] не удалось получить совет Агента: {}".format(error))

        # Локальный пошаговый помощник (использует next_advice от модели или итог шага).
        hint = model_advice or "Оцени результат «{}» и переходи к следующему действию.".format(result[:120])
        self.pending_guidance = hint
        text = "После шага {} ({}): {}".format(step_index + 1, action_label(action), hint)
        log("  [после шага] {}".format(hint[:220]))
        self.report("guidance", text, action)

    def task_cancelled(self, task_id: Optional[int]) -> bool:
        """Спрашиваем CRM, не отменили ли задание, — до следующего шага."""
        if not (self.has_crm and task_id):
            return False
        try:
            task = self.sync_task_state(task_id)
        except TaskCancelled:
            return True
        if not task:
            return False
        return str(task.get("status") or "") == "cancelled"

    def request_website_approval(
        self,
        task_id: Optional[int],
        kind: str,
        title: str,
        description: str,
        action: Optional[Dict[str, Any]] = None,
        extra_steps: int = 0,
    ) -> Dict[str, Any]:
        """Ставит задание на паузу и ждёт подтверждения/продления от человека на сайте."""
        if not (self.has_crm and task_id):
            return {"decision": "reject"}
        req_id = "req-" + uuid.uuid4().hex[:10]
        payload: Dict[str, Any] = {
            "id": req_id,
            "approvalId": req_id,
            "kind": kind,
            "title": title[:160],
            "description": description[:500],
            "action": action,
        }
        if extra_steps > 0:
            payload["extraSteps"] = int(extra_steps)
        self.crm.call("POST", "/api/agent/bot/{}/approval".format(task_id), payload, timeout=15)
        log("[?] Ожидаю решения на сайте ({}): {}".format(kind, title))
        deadline = time.time() + APPROVAL_WAIT_TIMEOUT
        while time.time() < deadline:
            task = self.sync_task_state(task_id)
            if task:
                raw_resp = task.get("approvalResponse")
                resp: Optional[Dict[str, Any]] = None
                if isinstance(raw_resp, dict):
                    resp = raw_resp
                elif isinstance(raw_resp, str) and raw_resp.strip().startswith("{"):
                    try:
                        resp = json.loads(raw_resp)
                    except json.JSONDecodeError:
                        resp = None
                if resp and resp.get("id") == req_id:
                    return resp
                status = str(task.get("status") or "")
                # Если человек уже нажал «+20 шагов» прямо на сайте, status вернулся в running.
                if kind == "step_limit" and status == "running":
                    return {"id": req_id, "decision": "extend", "extraSteps": int(extra_steps or 20)}
                if status in ("cancelled", "failed", "done"):
                    return {"id": req_id, "decision": "reject"}
            time.sleep(min(2.0, max(1.0, self.poll)))
        return {"id": req_id, "decision": "timeout"}

    def run(self, task_id: Optional[int], prompt: str, max_steps: int) -> bool:
        self.current_task = task_id
        self.history = []
        self.last_signature = ""
        self.repeat_streak = 0
        self.pending_nudge = ""
        self.pending_guidance = ""
        self._last_guidance_id = ""
        self.failed_checks = 0
        self._last_frame_sig = None
        last_outcome = ""
        last_screen_unchanged = False
        current_max_steps = min(HARD_MAX_STEPS_LIMIT, max(1, int(max_steps or 15)))
        try:
            return self._run_loop(task_id, prompt, current_max_steps, last_outcome, last_screen_unchanged)
        finally:
            self.release_all_inputs()

    def inspect_screen_and_report(self, task_id: Optional[int], prompt: str) -> bool:
        """Режим inspect: делает свежий снимок экрана без кликов и отправляет его Агенту."""
        trust = self.current_trust_level()
        if trust == "none" or self.dry_run:
            reason = (
                "режим dry-run: снимок не отправлен"
                if self.dry_run
                else "уровень доверия «Нет доступа к компьютеру»: снимок экрана запрещён"
            )
            self.report("error", reason, {"type": "inspect_screen"})
            if self.has_crm and task_id:
                self.crm.call(
                    "POST",
                    "/api/agent/bot/{}/finish".format(task_id),
                    {"status": "failed", "summary": reason},
                )
            return False

        try:
            screenshot, shot = self.screenshot()
        except SystemExit:
            raise
        except Exception as error:  # noqa: BLE001
            err_msg = "Не удалось сделать снимок экрана: {}".format(error)
            log("[!] " + err_msg)
            self.report("error", err_msg, {"type": "inspect_screen"})
            if self.has_crm and task_id:
                self.crm.call(
                    "POST",
                    "/api/agent/bot/{}/finish".format(task_id),
                    {"status": "failed", "summary": err_msg[:400]},
                )
            return False

        active_window = get_active_window_title()
        width = int((shot or {}).get("width") or 0)
        height = int((shot or {}).get("height") or 0)
        screen_width = int((shot or {}).get("screen_width") or width)
        screen_height = int((shot or {}).get("screen_height") or height)

        lines = [
            "Снимок экрана ПК ({}×{}, экран {}×{}).".format(width, height, screen_width, screen_height),
        ]
        if active_window:
            lines.append("Активное окно: {}.".format(active_window))

        if self.model and screenshot and not self.text_only:
            try:
                obs_prompt = (
                    "Агент запросил осмотр экрана ПК по задаче: «{}». "
                    "Ничего не нажимай и не выполняй действий — верни action={{type:'finish', summary:'...'}} "
                    "и в observation/summary опиши ключевое содержимое экрана, открытые окна, ошибки и важные элементы."
                ).format(prompt)
                decision = self.ask_model(obs_prompt, screenshot)
                obs = str(decision.get("observation") or decision.get("thought") or "").strip()
                act_sum = str((decision.get("action") or {}).get("summary") or "").strip()
                desc = obs or act_sum
                if desc:
                    lines.append("Что видно на экране: " + desc[:1500])
            except Exception as error:  # noqa: BLE001
                log("[!] vision-описание снимка недоступно (отправляю сам снимок): {}".format(error))

        summary = " ".join(lines).strip()
        if self.has_crm and task_id:
            self.crm.call(
                "POST",
                "/api/agent/bot/{}/screen".format(task_id),
                {
                    "image": screenshot,
                    "summary": summary,
                    "activeWindow": active_window,
                    "width": width,
                    "height": height,
                    "screenWidth": screen_width,
                    "screenHeight": screen_height,
                },
                timeout=30,
            )
            self.report("action", "Снимок экрана ПК отправлен Агенту ({}×{})".format(width, height), {"type": "inspect_screen"})
            self.crm.call(
                "POST",
                "/api/agent/bot/{}/finish".format(task_id),
                {"status": "done", "summary": summary[:800]},
            )
        log("Снимок экрана отправлен Агенту: " + summary[:220])
        return True

    def _run_loop(
        self,
        task_id: Optional[int],
        prompt: str,
        current_max_steps: int,
        last_outcome: str,
        last_screen_unchanged: bool,
    ) -> bool:
        if self.has_crm and task_id:
            try:
                task_info = self.sync_task_state(task_id)
                if task_info and task_info.get("maxSteps"):
                    current_max_steps = min(HARD_MAX_STEPS_LIMIT, max(1, int(task_info["maxSteps"])))
            except TaskCancelled:
                log("Задание отменено в CRM — останавливаюсь.")
                return False

        log("Задание: {} (доверие: {}, лимит шагов: {})".format(
            prompt, self.current_trust_level(), current_max_steps))
        self.report("info", "Задание принято (доверие: {}): {}".format(
            self.current_trust_level(), prompt))

        if self.current_task_mode() == "inspect":
            return self.inspect_screen_and_report(task_id, prompt)

        self.attachments_context = self.load_attachments(task_id)
        if self.attachments_context:
            self.report("info", "Прочитал вложения задания — учту их в шагах")

        index = 0
        while True:
            if self.has_crm and task_id:
                try:
                    task_info = self.sync_task_state(task_id)
                except TaskCancelled:
                    log("Задание отменено в CRM — останавливаюсь, шаги больше не шлю.")
                    return False
                if task_info and task_info.get("maxSteps"):
                    server_max = min(HARD_MAX_STEPS_LIMIT, max(1, int(task_info["maxSteps"])))
                    if server_max > current_max_steps:
                        log("Лимит шагов увеличен на сайте: {} → {}".format(current_max_steps, server_max))
                        current_max_steps = server_max
                        if self.max_steps_cap and self.max_steps_cap < server_max:
                            self.max_steps_cap = server_max

            if index >= current_max_steps:
                # Достигнут предел шагов: если есть связь с сайтом и не упёрлись в 2000,
                # спрашиваем на сайте разрешение продолжить в ЭТОМ же чате/контексте.
                if self.has_crm and task_id and current_max_steps < HARD_MAX_STEPS_LIMIT:
                    extra = min(20, HARD_MAX_STEPS_LIMIT - current_max_steps)
                    resp = self.request_website_approval(
                        task_id,
                        kind="step_limit",
                        title="Достигнут лимит {} шагов".format(current_max_steps),
                        description="Разрешите добавить шаги и продолжить выполнение текущей задачи без потери контекста.",
                        action={"type": "extend_steps", "currentSteps": current_max_steps, "addSteps": extra},
                        extra_steps=extra,
                    )
                    decision = str(resp.get("decision") or "reject").lower()
                    if decision in ("approve", "approved", "extend", "extend_steps", "allow"):
                        added = max(1, int(resp.get("extraSteps") or extra))
                        current_max_steps = min(HARD_MAX_STEPS_LIMIT, current_max_steps + added)
                        if self.max_steps_cap:
                            self.max_steps_cap = max(self.max_steps_cap, current_max_steps)
                        self.report("info", "Лимит продлён до {} шагов — продолжаю с шага {}".format(
                            current_max_steps, index + 1))
                        continue
                break

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
                task_mode=self.current_task_mode(),
                pending_guidance=self.pending_guidance,
            )
            decision = self.ask_model(step_prompt, screenshot,
                                      self.attachment_images if index == 0 else None)
            self.pending_nudge = ""
            self.pending_guidance = ""
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
                self.release_all_inputs()
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
            if self.current_task_mode() == "game" and kind in (
                "hold_key", "key", "move_mouse_rel", "mouse_down", "mouse_up", "sequence", "click"
            ):
                limit = max(limit, 8)

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

            trust = self.current_trust_level()
            dangerous = is_dangerous_action(action)
            reason = None
            if self.dry_run:
                reason = "dry-run: действие не выполнено"
            elif trust == "none" and kind not in ("wait", "make_file", "finish"):
                reason = ("заблокировано уровнем доверия «Нет доступа к компьютеру»: "
                          "действие «{}» не выполнено").format(kind)
            elif dangerous and trust == "verified":
                if self.has_crm and task_id:
                    resp = self.request_website_approval(
                        task_id,
                        kind="dangerous_action",
                        title="Подтвердите действие: {}".format(action_label(action)),
                        description="ИИ запрашивает выполнение потенциально опасного действия на вашем ПК / в песочнице.",
                        action=action,
                    )
                    decision_resp = str(resp.get("decision") or "reject").lower()
                    if decision_resp not in ("approve", "approved", "allow", "yes"):
                        reason = "отклонено пользователем на сайте"
                else:
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

                    # После каждого выполненного действия помогаем определить, что делать дальше.
                    if kind not in ("finish",):
                        self.post_step_assist(
                            task_id=task_id,
                            step_index=index,
                            action=action,
                            result=result,
                            decision=decision,
                            screenshot=self._last_verify_shot or screenshot,
                        )
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

            index += 1
            time.sleep(0.15 if self.current_task_mode() == "game" else max(0.2, self.delay))

        self.release_all_inputs()
        note = "Достигнут предел в {} шагов — задание остановлено".format(current_max_steps)
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
            self.task_trust_level = normalize_trust_level(task.get("trustLevel"), "") if task.get("trustLevel") else ""
            self.task_mode = normalize_task_mode(task.get("taskMode"), "autonomous") if task.get("taskMode") else ""
            self.task_coach_mode = normalize_coach_mode(task.get("coachMode"), "after_step") if task.get("coachMode") else ""
            limit = min(HARD_MAX_STEPS_LIMIT, max(1, int(task.get("maxSteps") or 15)))
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
    parser.add_argument("--trust-level", default="", choices=["", "full", "verified", "none"],
                        help="уровень доверия ИИ: full (полный), verified (с проверкой), none (без доступа)")
    parser.add_argument("--task-mode", default="", choices=["", "autonomous", "copilot", "game"],
                        help="режим: autonomous (автопилот), copilot (помощник ПК), game (игра/персонаж)")
    parser.add_argument("--coach", default="", choices=["", "off", "after_step", "agent"],
                        help="подсказки после каждого действия: off, after_step, agent")
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
        max_steps=min(HARD_MAX_STEPS_LIMIT, max(0, args.max_steps)),
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
        trust_level=args.trust_level,
        task_mode=args.task_mode,
        coach_mode=args.coach,
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
    log("Режим: {} · доверие: {} · задача: {} · сопровождение: {}".format(
        "DRY-RUN" if args.dry_run else "ИСПОЛНЕНИЕ",
        operator.current_trust_level(),
        operator.current_task_mode(),
        operator.current_coach_mode(),
    ))
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
