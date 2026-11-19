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

SYSTEM_PROMPT = """Ты — оператор рабочего стола внутри CRM. Ты видишь скриншот экрана
пользователя и выполняешь задание по шагам.

Отвечай ТОЛЬКО одним JSON-объектом без пояснений и без markdown:
{"thought": "короткая мысль по-русски", "action": {"type": "...", ...}}

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
- Текущее положение курсора отмечено на скриншоте красным крестиком. Если он не
  там, куда нужно кликнуть, — сначала переведи его (action move), затем кликай.
- Один шаг — одно действие. Не спеши: сначала осмотрись, потом действуй.
- Писать текст можно только в то поле, куда сначала кликнул. Всегда указывай x и y
  в action type/paste — иначе текст уйдёт в случайное активное окно.
- Если просят написать в чате или мессенджере: кликни в поле ввода внизу окна чата,
  набери текст, затем action key с "enter" для отправки. Убедись по скриншоту, что
  текст появился в поле ввода, а не в документе, поиске или адресной строке; если
  попал не туда — не продолжай, вернись и кликни точнее.
- Не открывай блокнот или документ, если просят написать в чате: работай в том окне,
  которое открыто у пользователя.
- Для файлов используй make_file и укажи расширение: docx (документ с заголовками
  через # и списками), xlsx (строки CSV через ; ), csv, md, html, svg, zip, txt, json.
  Содержимое пиши полностью, по-русски.
- Когда задание выполнено — action finish с кратким итогом.
- Не выдумывай, что видишь: если нужного окна нет, открой его.
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


def log(message: str) -> None:
    print(time.strftime("[%H:%M:%S] ") + str(message), flush=True)


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
                 vision_forced: bool = False, cursor_marker: bool = True) -> None:
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
        self.map_logged = False
        self.last_shot: Optional[Dict[str, Any]] = None
        self.history: List[str] = []

    # ------------------------------------------------------------- модель
    def ask_model(self, prompt: str, screenshot: Optional[str]) -> Dict[str, Any]:
        if not self.model:
            raise AgentError("Не указана модель: --model или --provider")

        content: Any = prompt
        if screenshot and not self.text_only:
            content = [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": screenshot}},
            ]
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            *([] if not self.history else [{"role": "user", "content": "Что уже сделано:\n" + "\n".join(self.history[-8:])}]),
            {"role": "user", "content": content},
        ]
        payload = {"model": self.model, "messages": messages, "temperature": 0.2, "stream": False}
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
        text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            raise AgentError("Модель ответила без JSON: " + text[:200])
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError as error:
            raise AgentError("Не разобрал JSON модели: " + text[:200]) from error
        action = data.get("action") or {}
        if not isinstance(action, dict) or not action.get("type"):
            raise AgentError("В ответе модели нет action.type")
        return {"thought": str(data.get("thought") or ""), "action": action}

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
            log("  вложение: {} ({} Б, {} симв. текста)".format(name, len(data), len(text)))
            blocks.append("--- {} ({} Б) ---\n{}".format(name, len(data), text))
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
        log("Задание: {}".format(prompt))
        self.report("info", "Задание принято: " + prompt)

        self.attachments_context = self.load_attachments(task_id)
        if self.attachments_context:
            self.report("info", "Прочитал вложения задания — учту их в шагах")

        for index in range(max(1, max_steps)):
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

            parts = ['Задание: "{}"'.format(prompt),
                     'Это шаг {}.'.format(index + 1)]
            if not self.text_only and self.last_shot:
                parts.append('Размер кадра: {width}×{height} px — координаты клика '
                             'в этих пикселях.'.format(**self.last_shot))
            elif self.text_only:
                parts.append('Работаем без скриншота: координаты считай по текущему экрану.')
            parts.append('Опиши мысль и выбери одно действие. Если всё готово — action finish.')
            if self.attachments_context:
                if index == 0:
                    parts.append('Файлы от пользователя (используй их содержимое):')
                    parts.append(self.attachments_context)
                else:
                    parts.append('Вложения задания уже прочитаны на первом шаге.')
            step_prompt = "\n".join(parts)
            decision = self.ask_model(step_prompt, screenshot)
            action = decision["action"]
            thought = decision.get("thought") or ""
            log("Шаг {} | {} {}".format(index + 1, action.get("type"),
                                        "({} симв.)".format(len(str(action.get("content") or "")))
                                        if action.get("type") == "make_file" else ""))
            if thought:
                print("         " + thought, flush=True)
            if thought:
                self.report("thought", thought, action)

            if action.get("type") == "finish":
                summary = str(action.get("summary") or "Готово")
                self.report("info", "Итог: " + summary)
                if self.has_crm and task_id:
                    self.crm.call("POST", "/api/agent/bot/{}/finish".format(task_id),
                                  {"status": "done", "summary": summary})
                log("ГОТОВО: " + summary)
                return True

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
            else:
                try:
                    result = self.execute(action)
                    log("  выполнено: " + result)
                    self.report("action", result, action)
                    self.history.append("шаг {}: {} → {}".format(index + 1, action.get("type"), result[:160]))
                except TaskCancelled:
                    raise
                except Exception as error:  # noqa: BLE001
                    log("  ошибка: {}".format(error))
                    self.report("error", str(error)[:400], action)
                    self.history.append("шаг {}: ошибка {}".format(index + 1, error))

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
            limit = int(task.get("maxSteps") or 15)
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
    parser.add_argument("--check", action="store_true",
                        help="проверить связь с CRM и токен (без экрана и модели)")
    parser.add_argument("--self-test", action="store_true", help="проверки без экрана и зависимостей")
    return parser.parse_args()


def main() -> int:
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
        dry_run=args.dry_run, assume_yes=args.yes, max_steps=max(0, args.max_steps),
        delay=args.delay, poll=args.poll, max_width=args.max_width, text_only=args.text_only,
        key_hint=PROVIDERS.get(args.provider or "local", {}).get("key_env", ""),
        offset_x=args.offset_x, offset_y=args.offset_y,
        vision_check=not args.no_vision_check, vision_forced=args.vision,
        cursor_marker=not args.no_cursor_marker,
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
