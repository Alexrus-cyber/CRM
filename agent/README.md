# Агенты CRM — обзор

В папке `agent/` два независимых агента и общий генератор файлов.

| Файл | Что это | Зависимости |
| --- | --- | --- |
| `agent.py` | агент для вкладки «Агент» на странице `/ai`: диалог, файлы, открытие сайтов и видео | нет, только стандартная библиотека Python |
| `desktop_operator.py` | бот-оператор рабочего стола: смотрит на экран, кликает, печатает, делает файлы | `pyautogui`, `Pillow`, `pyperclip` |
| `fileforge.py` | сборка файлов (docx, xlsx, csv, md, html, svg, zip…) | нет |
| `requirements.txt` | зависимости **оператора** | — |
| `OPERATOR.md` | пошаговая инструкция для оператора | — |

## Агент в чате (`agent.py`)

```bash
python3 agent/agent.py          # http://127.0.0.1:8899
```

`pip install` не нужен: агент написан на стандартной библиотеке (HTTP-сервер,
JSON, urllib). CRM находит его по переменной `AGENT_URL`
(по умолчанию `http://127.0.0.1:8899`).

Инструменты: `create_file` (docx/xlsx/csv/md/html/svg/json/zip/txt),
`open_website`, `play_youtube`. Адрес модели, ключ и имя модели приходят из
интерфейса — подойдёт и локальный сервер, и облачный API.

Переменные: `AGENT_HOST`, `AGENT_PORT`, `AGENT_BASE_URL`, `AGENT_MODEL`,
`AGENT_API_KEY`, `AGENT_WORKSPACE`, `AGENT_MAX_STEPS`, `AGENT_TIMEOUT`.

## Оператор рабочего стола (`desktop_operator.py`)

```bash
pip install -r agent/requirements.txt
python3 agent/desktop_operator.py --watch --token ТОКЕН --provider local
```

Подробная инструкция — [`OPERATOR.md`](OPERATOR.md).

Оператору нужны `pyautogui` и `Pillow`: он делает скриншоты и двигает мышь —
без этих библиотек такое не сделать (агент в чате работает с браузером и
файлами, ему они не нужны).

## Генератор файлов (`fileforge.py`)

Оба агента собирают файлы одним модулем:

```python
import fileforge
data, mime, name = fileforge.build("план.docx", "# План\n- пункт")
```

Поддерживаются: `txt`, `md`, `csv`, `tsv`, `json`, `html`, `svg`, `xml`, `yaml`,
`sql`, `py`, `js`, `ts`, `sh`, `docx`, `xlsx`, `zip`. DOCX и XLSX собираются как
OOXML-архивы — Word и Excel открывают их без предупреждений, кириллица в порядке.
PDF намеренно не поддерживается: без встроенного шрифта русский текст в PDF
превращается в мусор, поэтому документы отдаются в DOCX/HTML.

Проверка без экрана и зависимостей:

```bash
python3 agent/desktop_operator.py --self-test
```

## Провайдеры моделей

Оба агента работают с любым OpenAI-совместимым API:

| `--provider` | Адрес по умолчанию | Ключ |
| --- | --- | --- |
| `local` | `http://127.0.0.1:8000/v1` | обычно не нужен |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `groq` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `together` | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` |
| `mistral` | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` |

Свой адрес: `--base-url … --model … --api-key …`. Для оператора модель должна
уметь смотреть картинки (vision): например `gpt-4o-mini`, `qwen/qwen2.5-vl-72b-instruct`,
`Qwen/Qwen3-VL-8B-Instruct` на vLLM. Если модель не принимает скриншот, оператор
сам переходит в текстовый режим и предупреждает об этом.

## Настольный запускатор (`launcher/`)

Чтобы не держать два окна терминала, оба агента можно запускать из одного окна:
`launcher/` — приложение на Python (tkinter), которое собирается в **один exe**.

```bash
python -m launcher                 # окно: список агентов, настройки модели, журнал
python -m launcher --self-test     # 42 проверки без экрана
python launcher/build_exe.py       # dist/CRM Agents.exe
```

Внутри exe уже лежат Python, tkinter, сами агенты и их зависимости
(Pillow, pyautogui, pyperclip), поэтому пользователю ничего устанавливать не
нужно. Агентов приложение запускает тем же exe в режиме
`--run-agent agents/desktop_operator.py …` — отдельный интерпретатор не требуется.

Подробности, флаги сборки и формат `agents.json` для своих агентов —
[`launcher/README.md`](../launcher/README.md).
