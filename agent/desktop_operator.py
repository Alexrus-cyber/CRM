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
    python3 agent/operator.py --watch --token ТОКЕН --provider openrouter \
        --model qwen/qwen2.5-vl-72b-instruct --api-key sk-...

    python3 agent/operator.py --task "Открой блокнот и напиши план на день"
    python3 agent/operator.py --self-test        # без экрана и зависимостей

Опасные действия (удаление, покупки, переводы) спрашивают подтверждение;
--yes отключает вопрос, --dry-run только планирует. Аварийная остановка —
резко уведите курсор в левый верхний угол экрана.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import platform
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
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
    from PIL import Image  # noqa: F401  (нужен для пережатия скриншотов)
except ImportError:
    Image = None

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
    "deepseek": {"base_url": "https://api.deepseek.com/v1", "model": "deepseek-chat",
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
- {"type":"type","text":"текст"} — набрать текст в активном поле;
- {"type":"hotkey","keys":["ctrl","s"]} — сочетание клавиш;
- {"type":"key","key":"enter"} — одна клавиша;
- {"type":"scroll","amount":-3,"x":..,"y":..} — прокрутка (минус — вниз);
- {"type":"drag","fromX":..,"fromY":..,"toX":..,"toY":..};
- {"type":"wait","seconds":1};
- {"type":"open_url","url":"https://…"} — открыть сайт или видео в браузере;
- {"type":"make_file","name":"план.docx","content":"…"} — сделать файл и отдать в чат;
- {"type":"finish","summary":"что сделано"}.

Правила:
- Координаты — в пикселях скриншота, который ты видишь.
- Один шаг — одно действие. Не спеши: сначала осмотрись, потом действуй.
- Для файлов используй make_file и укажи расширение: docx (документ с заголовками
  через # и списками), xlsx (строки CSV через ; ), csv, md, html, svg, zip, txt, json.
  Содержимое пиши полностью, по-русски.
- Когда задание выполнено — action finish с кратким итогом.
- Не выдумывай, что видишь: если нужного окна нет, открой его.
- Опасные действия (удаление, переводы, покупки) выполняй, только если пользователь
  прямо об этом попросил; иначе сначала спроси через finish и объясни причину.
"""

DANGEROUS = re.compile(
    r"удал|удали|снеси|формат|перевод|оплат|купи|покупк|пароль|delete|rm -rf|format|"
    r"payment|transfer|покупка|очист",
    re.IGNORECASE,
)


class AgentError(RuntimeError):
    """Ошибка, текст которой можно показать пользователю."""


def log(message: str) -> None:
    print(time.strftime("[%H:%M:%S] ") + str(message), flush=True)


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

    passed = sum(1 for item in checks if item)
    print("\n{}/{} проверок пройдено".format(passed, len(checks)))
    return 0 if passed == len(checks) else 1


def type_text(text: str) -> None:
    """Ввод текста; кириллица — через буфер обмена, иначе pyautogui пишет мусор."""
    if not text:
        return
    require_pyautogui()
    if all(ord(char) < 128 for char in text) or pyperclip is None:
        pyautogui.write(text, interval=0.02)
        return
    pyperclip.copy(text)
    modifier = "command" if platform.system() == "Darwin" else "ctrl"
    pyautogui.hotkey(modifier, "v")


class Http:
    """Минимальный HTTP-клиент без внешних зависимостей."""

    def __init__(self, base: str, token: str = "") -> None:
        self.base = (base or "").rstrip("/")
        self.token = token

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
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:400]
            if error.code == 401:
                raise AgentError("CRM отклонила токен агента. Создайте токен заново во вкладке «Оператор».") from error
            raise AgentError("{} {} → HTTP {}: {}".format(method, path, error.code, detail)) from error
        except urllib.error.URLError as error:
            raise AgentError("CRM недоступна ({}): {}".format(url, error.reason)) from error
        try:
            return json.loads(body or "{}")
        except json.JSONDecodeError as error:
            raise AgentError("CRM вернула не JSON") from error


class Operator:
    def __init__(self, crm: str, token: str, base_url: str, model: str, api_key: str,
                 dry_run: bool, assume_yes: bool, max_steps: int, delay: float,
                 poll: float, max_width: int, text_only: bool) -> None:
        self.crm = Http(crm, token)
        self.has_crm = bool(crm and token)
        self.model_http = Http(base_url)
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
            # Модель без поддержки картинок: пробуем текстовый режим один раз.
            if screenshot and not self.text_only and "image" in str(error).lower():
                log("[!] Модель не приняла скриншот — продолжаю в текстовом режиме")
                self.text_only = True
                return self.ask_model(prompt, None)
            raise

        choices = data.get("choices") or []
        if not choices:
            raise AgentError("Модель вернула пустой ответ")
        text = str((choices[0].get("message") or {}).get("content") or "").strip()
        return self.parse_decision(text)

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
        return map_point(x, y, shot["width"], shot["height"],
                         shot["screen_width"], shot["screen_height"])

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
            except AgentError as error:
                return "файл «{}» создан локально ({}), но отправить в CRM не удалось: {}".format(
                    final_name, path, error)
        return "файл «{}» создан локально: {}".format(final_name, path)

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
            pyautogui.moveTo(x, y, duration=0.25)
            return "курсор в ({}, {})".format(x, y)

        if kind == "type":
            text = str(action.get("text") or "")
            type_text(text)
            return "введено {} символов".format(len(text))

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
                pyautogui.moveTo(x, y, duration=0.15)
            pyautogui.scroll(amount * 120)
            return "прокрутка {}".format("вверх" if amount > 0 else "вниз")

        if kind == "drag":
            from_x, from_y = self.to_screen(action.get("fromX", 0), action.get("fromY", 0))
            to_x, to_y = self.to_screen(action.get("toX", 0), action.get("toY", 0))
            pyautogui.moveTo(from_x, from_y, duration=0.2)
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
        except AgentError as error:
            log("[!] не смог отправить шаг в CRM: {}".format(error))

    def run(self, task_id: Optional[int], prompt: str, max_steps: int) -> bool:
        self.current_task = task_id
        self.history = []
        log("Задание: {}".format(prompt))
        self.report("info", "Задание принято: " + prompt)

        for index in range(max(1, max_steps)):
            if self.has_crm and task_id:
                try:
                    self.crm.call("GET", "/api/agent/bot/next", timeout=10)  # поддержать соединение
                except AgentError:
                    pass

            screenshot = None
            shot = None
            if not self.text_only:
                try:
                    screenshot, shot = self.screenshot()
                except SystemExit:
                    raise
                except Exception as error:  # noqa: BLE001
                    log("[!] скриншот не удался: {}".format(error))

            step_prompt = ('Задание: "{}"\nЭто шаг {}. Опиши мысль и выбери одно действие. '
                           'Если всё готово — action finish.'.format(prompt, index + 1))
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
            except AgentError as error:
                log("Ошибка: {}".format(error))
                try:
                    self.crm.call("POST", "/api/agent/bot/{}/finish".format(task["id"]),
                                  {"status": "failed", "summary": str(error)[:400]})
                except AgentError:
                    pass
            if once:
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
    parser.add_argument("--self-test", action="store_true", help="проверки без экрана и зависимостей")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.self_test:
        return self_test()

    base_url, model, api_key = resolve_provider(args)
    enable_dpi_awareness()
    require_pyautogui()

    operator = Operator(
        crm=args.server, token=args.token, base_url=base_url, model=model, api_key=api_key,
        dry_run=args.dry_run, assume_yes=args.yes, max_steps=max(0, args.max_steps),
        delay=args.delay, poll=args.poll, max_width=args.max_width, text_only=args.text_only,
    )
    operator.current_task = None

    log("Модель: {} @ {}".format(model or "—", base_url))
    if not api_key and "127.0.0.1" not in base_url and "localhost" not in base_url:
        log("[!] Ключ API не задан — облачный провайдер, скорее всего, ответит 401")
    log("Режим: {}{}".format("DRY-RUN" if args.dry_run else "ИСПОЛНЕНИЕ",
                             " + подтверждения" if not args.yes else ""))
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
