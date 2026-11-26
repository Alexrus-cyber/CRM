# -*- coding: utf-8 -*-
"""Точка входа приложения.

    CRM Agents.exe                 — графический запускатор (по умолчанию)
    CRM Agents.exe --run-agent X   — выполнить агента X внутри этого же exe
    CRM Agents.exe --list          — показать каталог агентов (консоль)
    CRM Agents.exe --self-test     — самопроверки без экрана и без сети

`--run-agent` нужен потому, что в exe нет отдельного Python: GUI запускает
самого себя в режиме агента, и уже тот выполняет встроенный скрипт.
"""

from __future__ import annotations

import argparse
import io
import os
import runpy
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import List, Sequence, Tuple

if __package__ in (None, ""):  # запуск из исходников: python launcher/cli.py
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from launcher import APP_NAME, APP_VERSION  # noqa: E402
from launcher import (  # noqa: E402
    bundle,
    commands,
    crm_client,
    deps,
    desktop_window,
    file_extract,
    harness_server,
    runner,
    settings as settings_mod,
)
from launcher.catalog import DEFAULT_AGENTS, PROVIDER_PRESETS, REASONING_MODES, agent_by_id, load_catalog  # noqa: E402


# --------------------------------------------------------------------------
# режим «выполнить агента»
# --------------------------------------------------------------------------

def ensure_std_streams() -> None:
    """Настраивает stdout/stderr на UTF-8 с заменой неизвестных символов.

    В оконной сборке exe потоки могут быть None, а при запуске через pipe на
    русской Windows Python открывает их в cp1251 с errors='strict' — любая
    стрелка «→» или эмодзи в логах роняет процесс с UnicodeEncodeError.
    """
    for name, fd in (("stdout", 1), ("stderr", 2)):
        stream = getattr(sys, name, None)
        if stream is None:
            try:
                raw = os.fdopen(os.dup(fd), "wb", buffering=0)
                setattr(sys, name, io.TextIOWrapper(raw, encoding="utf-8", errors="replace", line_buffering=True))
            except (OSError, ValueError):
                setattr(sys, name, open(os.devnull, "w", encoding="utf-8", errors="replace"))
            continue
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
            except (OSError, ValueError, AttributeError):
                try:
                    reconfigure(errors="replace")
                except (OSError, ValueError, AttributeError):
                    pass


def run_agent(argv: Sequence[str]) -> int:
    """Выполнить скрипт агента в текущем процессе (внутри exe или в Python)."""
    ensure_std_streams()
    if not argv:
        print("нужен путь к скрипту агента: --run-agent <файл.py> [аргументы]", file=sys.stderr)
        return 2
    script = Path(argv[0]).expanduser()
    if not script.is_absolute():
        # В сборке скрипты лежат в agents/, в исходниках можно указать путь от cwd.
        inside_bundle = bundle.agents_dir() / script
        script = inside_bundle if inside_bundle.is_file() else script
    script = script.resolve()
    if not script.is_file():
        print(f"скрипт агента не найден: {script}", file=sys.stderr)
        return 2

    print(f"[{APP_NAME}] запускаю {script.name}", flush=True)
    sys.argv = [str(script), *argv[1:]]
    os.environ.setdefault("CRM_LAUNCHER", APP_VERSION)
    try:
        runpy.run_path(str(script), run_name="__main__")
        return 0
    except SystemExit as exit_code:
        code = exit_code.code
        if code is None:
            return 0
        return int(code) if isinstance(code, int) else 0
    except KeyboardInterrupt:
        return 130
    except BaseException:  # noqa: BLE001 — показываем трейсбек в лог
        traceback.print_exc()
        return 1


# --------------------------------------------------------------------------
# самопроверки
# --------------------------------------------------------------------------

def self_test() -> int:
    checks: List[Tuple[str, bool]] = []

    def check(name: str, ok: bool) -> None:
        checks.append((name, bool(ok)))

    agents = DEFAULT_AGENTS
    ids = [spec.id for spec in agents]
    check("каталог: у агентов уникальные id", len(ids) == len(set(ids)))
    check("каталог: у всех есть описание и заголовок", all(spec.title and spec.description for spec in agents))
    check("каталог: провайдеры содержат адрес и модель",
          all("base_url" in preset and "model" in preset for preset in PROVIDER_PRESETS.values()))

    operator = agent_by_id(agents, "operator")
    chat_agent = agent_by_id(agents, "chat_agent")
    custom = agent_by_id(agents, "custom")
    assert operator and chat_agent and custom

    conf = settings_mod.LaunchSettings()
    conf.apply_preset("deepseek")
    conf.api_key = "sk-secret-key-123456"
    conf.temperature = 0.3
    conf.set_value("operator", "crm_token", "crmop_token_value")
    conf.set_value("operator", "mode", "task")
    conf.set_value("operator", "task", "открой блокнот")

    args = commands.agent_args(operator, conf)
    check("оператор: провайбер и модель в аргументах", "--provider" in args and "deepseek" in args and "--model" in args)
    check("оператор: разовое задание передаётся флагом", "--task" in args and "открой блокнот" in args)
    check("оператор: watch не добавляется в разовом режиме", "--watch" not in args)
    check("оператор: температура передаётся", "--temperature" in args and "0.3" in args)
    check("оператор: секреты не попадают в argv и описание команды",
          "--api-key" not in args and "--token" not in args
          and "sk-secret-key-123456" not in " ".join(args)
          and "crmop_token_value" not in " ".join(args)
          and "sk-secret-key-123456" not in commands.describe_command(args, {})
          and "crmop_token_value" not in commands.describe_command(args, {}))

    watch = settings_mod.LaunchSettings()
    watch.set_value("operator", "mode", "watch")
    check("оператор: режим watch", "--watch" in commands.agent_args(operator, watch))
    once = settings_mod.LaunchSettings()
    once.set_value("operator", "mode", "once")
    check("оператор: режим once", "--once" in commands.agent_args(operator, once))

    off = settings_mod.LaunchSettings()
    off.set_value("operator", "verify", False)
    off.set_value("operator", "repeat_nudge", False)
    off.set_value("operator", "self_reflect", False)
    off_args = commands.agent_args(operator, off)
    check("оператор: выключение проверки, подсказок и саморазбора",
          "--no-verify-actions" in off_args and "--no-repeat-nudge" in off_args
          and "--no-self-reflect" in off_args)

    env = commands.agent_env(chat_agent, conf)
    sec = commands.agent_secrets(chat_agent, conf)
    check("агент: адрес и модель уходят в env, а ключ — в изолированные секреты (P1-20)",
          env.get("AGENT_BASE_URL", "").endswith("/v1")
          and bool(env.get("AGENT_MODEL"))
          and "AGENT_API_KEY" not in env
          and sec.get("AGENT_API_KEY") == "sk-secret-key-123456")
    check("агент: порт по умолчанию", env.get("AGENT_PORT") == "8899")
    check("агент: уровень доверия уходит в AGENT_TRUST_LEVEL", env.get("AGENT_TRUST_LEVEL") == "verified")

    trust_conf = settings_mod.LaunchSettings()
    trust_conf.set_value("operator", "trust_level", "none")
    trust_args = commands.agent_args(operator, trust_conf)
    check("оператор: уровень доверия передаётся флагом --trust-level",
          "--trust-level" in trust_args and "none" in trust_args)

    mode_conf = settings_mod.LaunchSettings()
    mode_conf.set_value("operator", "task_mode", "game")
    mode_conf.set_value("operator", "coach_mode", "agent")
    mode_conf.reasoning = "max"
    mode_args = commands.agent_args(operator, mode_conf)
    check("лаунчер: режим раздумий max передаётся в --reasoning",
          any(val == "max" for val, _ in REASONING_MODES)
          and "--reasoning" in mode_args and "max" in mode_args)
    check("оператор: режим игры и советчик Агента передаются --task-mode и --coach",
          "--task-mode" in mode_args and "game" in mode_args
          and "--coach" in mode_args and "agent" in mode_args)

    custom_conf = settings_mod.LaunchSettings()
    custom_conf.set_value("custom", "args", '--name "Иван Петров" --fast')
    custom_args = commands.agent_args(custom, custom_conf)
    check("свой агент: аргументы разбираются с кавычками",
          custom_args[:2] == ["--name", "Иван Петров"] and custom_args[-1] == "--fast")

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "settings.json"
        conf.remember_key = False
        conf.crm_session_token = "sess-secret-token-xyz"
        settings_mod.save(conf, path)
        raw = path.read_text(encoding="utf-8")
        check("настройки: ключ и сессия CRM не пишутся без разрешения (P1-21)",
              "sk-secret-key-123456" not in raw and "sess-secret-token-xyz" not in raw)
        restored = settings_mod.load(path)
        check("настройки: значения агента переживают перезапуск",
              restored.values_for(operator).get("task") == "открой блокнот")
        conf.remember_key = True
        settings_mod.save(conf, path)
        reloaded = settings_mod.load(path)
        check("настройки: с галочкой ключ и сессия сохраняются",
              reloaded.api_key == "sk-secret-key-123456" and reloaded.crm_session_token == "sess-secret-token-xyz")

    os.environ["AWS_SECRET_ACCESS_KEY"] = "leaked-aws-secret"
    try:
        filtered_env = bundle.child_env({"AGENT_MODEL": "m"})
        check("child_env отфильтровывает секреты хоста по allowlist (P1-20)",
              "AWS_SECRET_ACCESS_KEY" not in filtered_env and filtered_env.get("AGENT_MODEL") == "m")
    finally:
        os.environ.pop("AWS_SECRET_ACCESS_KEY", None)

    check("секрет в подсказке маскируется", settings_mod.mask_secret("sk-secret-key-123456").startswith("sk-s"))
    check("зависимости оператора перечислены", len(deps.check("operator")) == 3)
    check("у агента с инструментами внешних зависимостей нет", deps.report("chat_agent")[0].endswith("библиотека."))

    check("папка агентов найдена", bundle.agents_dir().is_dir())
    check("скрипт оператора на месте", (bundle.agents_dir() / "desktop_operator.py").is_file())
    check("скрипт агента на месте", (bundle.agents_dir() / "agent.py").is_file())
    child_env = bundle.child_env({"AGENT_MODEL": "m"})
    check("агент получает свою временную папку",
          child_env.get("TEMP") == str(bundle.runtime_temp_dir())
          and child_env.get("TMP") == child_env.get("TEMP")
          and child_env.get("AGENT_MODEL") == "m")
    info = bundle.runtime_info()
    check("среда запуска описана", info["режим"] == "исходники" and info["запись во временную папку"] == "ок")
    check("однофайловый режим в исходниках не определяется", bundle.is_onefile() is False)
    check("подсказка про код -1 говорит про onedir/tmpdir",
          "onedir" in runner.exit_hint(-1) and "tmpdir" in runner.exit_hint(4294967295))
    check("для успешного кода подсказки нет", runner.exit_hint(0) == "")

    # Проверяем ветку «однофайловая сборка → дочерний процесс переиспользует runtime».
    had_meipass = getattr(sys, "_MEIPASS", None)
    original_onefile = bundle.is_onefile
    try:
        bundle.is_onefile = lambda: True  # type: ignore[assignment]
        sys._MEIPASS = str(bundle.agents_dir())  # type: ignore[attr-defined]
        reuse = bundle.child_env({})
        plain = bundle.child_env({}, reuse_runtime=False)
        check("onefile: дочерний процесс переиспользует распакованный runtime",
              reuse.get("_PYI_APPLICATION_HOME_DIR") == str(bundle.agents_dir())
              and reuse.get("_PYI_PARENT_PROCESS_LEVEL") == "1"
              and reuse.get("_PYI_ARCHIVE_FILE") == sys.executable)
        check("onefile: вторая попытка запуска не навязывает _PYI_*",
              "_PYI_APPLICATION_HOME_DIR" not in plain)
    finally:
        bundle.is_onefile = original_onefile  # type: ignore[assignment]
        if had_meipass is None:
            try:
                delattr(sys, "_MEIPASS")
            except AttributeError:
                pass
        else:
            sys._MEIPASS = had_meipass  # type: ignore[attr-defined]

    build = __import__("launcher.build_exe", fromlist=["build_parser"]).build_parser()
    check("сборка по умолчанию — папкой", build.parse_args([]).onefile is False)
    check("флаг --onefile и --tmpdir разбираются",
          build.parse_args(["--onefile", "--tmpdir", "D:/tmp"]).onefile is True
          and build.parse_args(["--tmpdir", "D:/tmp"]).tmpdir == "D:/tmp")

    failing = runner.AgentRun(agent_id="t", command=[sys.executable, "-c", "raise SystemExit(3)"],
                              cwd=Path("."), env={})
    failing.start()
    deadline = time.time() + 30
    while failing.is_running() and time.time() < deadline:
        time.sleep(0.05)
    check("код завершения процесса запоминается", failing.exit_code == 3)
    check("префикс запуска содержит --run-agent",
          "--run-agent" in bundle.run_agent_args(Path("x.py"), ["--watch"]))

    code, lines = runner.run_to_completion([sys.executable, "-c", "print('ok-line')"], timeout=30)
    check("процесс запускается и отдаёт вывод", code == 0 and "ok-line" in lines)
    check("ANSI-коды вырезаются", runner.strip_ansi("\x1b[31mred\x1b[0m") == "red")

    warnings = commands.validate(operator, settings_mod.LaunchSettings(), bundle.agents_dir())
    check("валидация ругается на пустой токен CRM", any("токен" in item.lower() for item in warnings))
    cloud = settings_mod.LaunchSettings()
    cloud.apply_preset("openai")
    check("валидация ругается на облако без ключа",
          any("ключ" in item.lower() for item in commands.validate(chat_agent, cloud, bundle.agents_dir())))
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "my_agent.py"
        script.write_text("print('hi')\n", encoding="utf-8")
        custom_conf.set_value("custom", "script_path", str(script))
        check("валидация своего агента: файл найден",
              not any("не найден" in item for item in commands.validate(custom, custom_conf, bundle.agents_dir())))
        code, out = runner.run_to_completion(
            [*bundle.run_agent_args(script, ["--demo"]), ], timeout=60
        ) if not bundle.is_frozen() else (0, [])
        check("режим --run-agent выполняет скрипт", code == 0 and any("hi" in line for line in out))

        # Проверка защиты от Windows cp1251 в дочернем pipe и в ensure_std_streams.
        child_env = bundle.child_env({})
        check("окружение child_env включает UTF-8 для Python",
              child_env.get("PYTHONIOENCODING") == "utf-8"
              and child_env.get("PYTHONUTF8") == "1"
              and child_env.get("PYTHONUNBUFFERED") == "1")

        orig_stdout = sys.stdout
        cp_buf = io.BytesIO()
        try:
            sys.stdout = io.TextIOWrapper(cp_buf, encoding="cp1251", errors="strict")
            ensure_std_streams()
            print("Ошибка → тест", flush=True)
            sys.stdout.flush()
            reconfigured_ok = "Ошибка → тест" in cp_buf.getvalue().decode("utf-8", errors="strict")
        except BaseException:  # noqa: BLE001 — тест не должен ронять self-test
            reconfigured_ok = False
        finally:
            sys.stdout = orig_stdout
        check("ensure_std_streams переводит cp1251-поток на UTF-8", reconfigured_ok)

        if not bundle.is_frozen():
            import subprocess

            utf_script = Path(tmp) / "utf_agent.py"
            utf_script.write_text("print('Ошибка: тест → ✅')\n", encoding="utf-8")
            cp_env = dict(os.environ)
            cp_env["PYTHONIOENCODING"] = "cp1251"
            cp_env["PYTHONUTF8"] = "0"
            proc = subprocess.run(
                bundle.run_agent_args(utf_script, []),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="strict",
                env=cp_env,
                timeout=30,
            )
            check("--run-agent не падает на кириллице и '→' при cp1251 в окружении",
                  proc.returncode == 0 and "Ошибка: тест → ✅" in (proc.stdout or ""))

    _spec_checks(check)
    _crm_auth_checks(check)
    _harness_checks(check)
    _gui_smoke(check)

    passed = sum(1 for _, ok in checks if ok)
    for name, ok in checks:
        print(("OK   " if ok else "FAIL ") + name)
    print(f"\n{passed}/{len(checks)} проверок пройдено")
    return 0 if passed == len(checks) else 1


def _spec_checks(check) -> None:
    """Прогон launcher.spec с заглушками PyInstaller: проверяем, что он корректен."""
    spec = Path(__file__).resolve().parent / "launcher.spec"
    source = spec.read_text(encoding="utf-8")
    captured: Dict[str, Any] = {}

    class StubAnalysis:  # noqa: D401 — заглушка вместо PyInstaller.Analysis
        def __init__(self, scripts, **kwargs):
            captured["scripts"] = scripts
            captured["datas"] = kwargs.get("datas") or []
            captured["hiddenimports"] = kwargs.get("hiddenimports") or []
            captured["pathex"] = kwargs.get("pathex") or []
            self.pure: list = []
            self.scripts: list = []
            self.binaries: list = []
            self.datas: list = []

    namespace = {
        "__name__": "launcher_spec",
        "Analysis": StubAnalysis,
        "PYZ": lambda pure: "pyz",
        "EXE": lambda *args, **kwargs: captured.setdefault("exe", kwargs),
        "COLLECT": lambda *args, **kwargs: None,
    }
    try:
        exec(compile(source, str(spec), "exec"), namespace)  # noqa: S102 — наш же файл
        error = ""
    except SystemExit as exc:  # pragma: no cover — сработает при съехавших путях
        error = str(exc)
    check("сборка: spec выполняется без ошибок", not error)
    check("сборка: точкой входа выбран launcher/cli.py",
          any(str(item).endswith("cli.py") for item in captured.get("scripts", [])))
    check("сборка: скрипты агентов попадают в datas",
          any(destination == "agents" for _source, destination in captured.get("datas", [])))
    agent_dir = Path(__file__).resolve().parent.parent / "agent"
    bundled_agent_files = {
        Path(src).name for src, dest in captured.get("datas", []) if dest == "agents"
    }
    expected_agent_py = {p.name for p in agent_dir.glob("*.py")}
    check("сборка: все модули agent/*.py (вкл. overseer.py) попадают в datas",
          expected_agent_py <= bundled_agent_files and "overseer.py" in bundled_agent_files)
    hidden = set(captured.get("hiddenimports", []))
    check("сборка: tkinter и зависимости в hiddenimports",
          {"tkinter", "pyautogui", "PIL", "pyperclip", "launcher.crm_client"} <= hidden)
    check("сборка: модули нового harness и webview в hiddenimports",
          {"launcher.harness_server", "launcher.file_extract", "launcher.desktop_window", "webview"} <= hidden)
    ui_bundled = {
        Path(src).name for src, dest in captured.get("datas", []) if dest == "ui"
    }
    check("сборка: веб-интерфейс launcher/ui попадает в datas",
          {"index.html", "styles.css", "app.js", "tab_chat.js", "tab_agent.js", "tab_operator.js", "tab_limits.js"} <= ui_bundled)
    check("сборка: stdlib-модули агентов (uuid, http.server, hmac, xml.sax.saxutils, zipfile) в hiddenimports",
          {"uuid", "hmac", "http.client", "http.server", "socketserver", "xml.sax.saxutils", "zipfile", "csv", "ast", "ipaddress", "ssl"} <= hidden)
    check("сборка: exe оконный (без консоли)", captured.get("exe", {}).get("console") is False)


def _harness_checks(check) -> None:
    """Проверки локального веб-сервера harness, разбора файлов и настольного окна."""
    import json
    import urllib.error
    import urllib.request
    import zipfile

    ui_path = bundle.ui_dir()
    required_ui = {"index.html", "styles.css", "app.js", "tab_chat.js", "tab_agent.js", "tab_operator.js", "tab_limits.js"}
    check("harness: папка ui и все 7 модулей на месте",
          ui_path.is_dir() and all((ui_path / name).is_file() for name in required_ui))

    txt_res = file_extract.extract_attachment("notes.txt", "Привет CRM!\nСтрока 2".encode("utf-8"), "text/plain")
    check("file_extract: извлекает текст из .txt",
          "Привет CRM!" in txt_res.get("text", "") and txt_res.get("kind") == "text")

    docx_buf = io.BytesIO()
    with zipfile.ZipFile(docx_buf, "w") as zf:
        zf.writestr(
            "word/document.xml",
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:body><w:p><w:r><w:t>Договор аренды №42</w:t></w:r></w:p></w:body></w:document>',
        )
    docx_res = file_extract.extract_attachment("contract.docx", docx_buf.getvalue())
    check("file_extract: извлекает текст из .docx",
          "Договор аренды №42" in docx_res.get("text", "") and docx_res.get("note") == "DOCX")

    xlsx_buf = io.BytesIO()
    with zipfile.ZipFile(xlsx_buf, "w") as zf:
        zf.writestr(
            "xl/sharedStrings.xml",
            '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Выручка</t></si></sst>',
        )
        zf.writestr(
            "xl/worksheets/sheet1.xml",
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
            '<row><c t="s"><v>0</v></c><c><v>150000</v></c></row></sheetData></worksheet>',
        )
    xlsx_res = file_extract.extract_attachment("report.xlsx", xlsx_buf.getvalue())
    check("file_extract: извлекает таблицу из .xlsx",
          "Выручка" in xlsx_res.get("text", "") and "150000" in xlsx_res.get("text", ""))

    check("crm_client: определяет локальные LLM URL",
          crm_client.is_local_model_url("http://127.0.0.1:1234/v1")
          and crm_client.is_local_model_url("http://localhost:11434/v1")
          and not crm_client.is_local_model_url("https://api.openai.com/v1"))

    check("desktop_window: определяет способ запуска окна",
          desktop_window.detect_window_backend() in {"pywebview", "browser_app", "webbrowser"})

    with tempfile.TemporaryDirectory() as tmp:
        prev_cfg = os.environ.get("CRM_LAUNCHER_CONFIG")
        os.environ["CRM_LAUNCHER_CONFIG"] = str(Path(tmp) / "settings.json")
        srv = None
        try:
            prof_dir = desktop_window._app_profile_dir()
            check("desktop_window: папка профиля браузера создаётся в config_dir",
                  prof_dir.is_dir() and prof_dir.parent == settings_mod.config_dir())
            srv = harness_server.HarnessServer(port=0)
            srv.start()
            base = srv.base_url()

            # 1. Главная страница доступна с ?ht=... и содержит мета-тег токена
            with urllib.request.urlopen(srv.entry_url(), timeout=5) as resp:
                html_body = resp.read().decode("utf-8")
                check("harness_server: отдаёт index.html с токеном доступа",
                      resp.status == 200 and 'name="crm-harness-token"' in html_body and srv.app_token in html_body)

            # 2. Без X-Harness-Token API отвечает 403
            unauth_code = 0
            try:
                urllib.request.urlopen(f"{base}/api/app/state", timeout=5)
            except urllib.error.HTTPError as err:
                unauth_code = err.code
            check("harness_server: блокирует API-запросы без X-Harness-Token (403)", unauth_code == 403)

            # 3. С валидным X-Harness-Token state, runtime, logs работают
            req_state = urllib.request.Request(
                f"{base}/api/app/state",
                headers={"X-Harness-Token": srv.token},
            )
            with urllib.request.urlopen(req_state, timeout=5) as resp:
                state_json = json.loads(resp.read().decode("utf-8"))
                check("harness_server: /api/app/state отдаёт конфигурацию",
                      bool(state_json.get("ok")) and "presets" in state_json and "agentHealth" in state_json)

            req_rt = urllib.request.Request(
                f"{base}/api/app/runtime",
                headers={"X-Harness-Token": srv.token},
            )
            with urllib.request.urlopen(req_rt, timeout=5) as resp:
                rt_json = json.loads(resp.read().decode("utf-8"))
                check("harness_server: /api/app/runtime отдаёт диагностику среды",
                      bool(rt_json.get("ok")) and "runtime" in rt_json and "agentHealth" in rt_json)

            # 4. Без входа в CRM запросы к /api/ai/agent отклоняются 401, а после подстановки сессии работают
            unauth_crm = 0
            try:
                urllib.request.urlopen(
                    urllib.request.Request(f"{base}/api/ai/agent", headers={"X-Harness-Token": srv.token}),
                    timeout=5,
                )
            except urllib.error.HTTPError as err:
                unauth_crm = err.code
            check("harness_server: без учётки CRM /api/ai/agent возвращает 401", unauth_crm == 401)

            srv.settings.crm_url = "https://crm.example.com"
            srv.settings.crm_session_token = "sess-ok"
            req_agent = urllib.request.Request(
                f"{base}/api/ai/agent",
                headers={"X-Harness-Token": srv.token},
            )
            with urllib.request.urlopen(req_agent, timeout=5) as resp:
                ag_json = json.loads(resp.read().decode("utf-8"))
                check("harness_server: /api/ai/agent отдаёт статус локального агента",
                      "available" in ag_json and "workspace" in ag_json)

            req_theme = urllib.request.Request(
                f"{base}/api/app/theme",
                data=json.dumps({"theme": "light"}).encode("utf-8"),
                headers={"X-Harness-Token": srv.token, "Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req_theme, timeout=5) as resp:
                th_json = json.loads(resp.read().decode("utf-8"))
                check("harness_server: переключение темы сохраняется",
                      th_json.get("theme") == "light" and srv.settings.theme == "light")
        finally:
            if srv is not None:
                srv.shutdown()
            if prev_cfg is None:
                os.environ.pop("CRM_LAUNCHER_CONFIG", None)
            else:
                os.environ["CRM_LAUNCHER_CONFIG"] = prev_cfg


def _crm_auth_checks(check) -> None:
    """Проверки ограничений CRM, автотокена и прав доступа в лаунчере."""
    check("crm_client: нормализует URL без схемы (localhost → http, удалённый → https)",
          crm_client.normalize_server_url("localhost:3000/") == "http://localhost:3000"
          and crm_client.normalize_server_url("crm.example.com/") == "https://crm.example.com")
    http_rejected = False
    try:
        crm_client._assert_safe_crm_transport("http://crm.example.com/api/health")
    except crm_client.CrmClientError:
        http_rejected = True
    check("crm_client: запрещает незашифрованный http:// для удалённого CRM (P1-22)", http_rejected)
    check("crm_client: max_steps без лимита при maxSteps=None и учитывает явный лимит",
          crm_client.clamp_max_steps(999, None, False) == 999
          and crm_client.clamp_max_steps(0, None, False) == 0
          and crm_client.clamp_max_steps(999, 500, False) == 500
          and crm_client.clamp_max_steps(999, 500, True) == 999)
    check("crm_client: ограничивает reasoning по политике роли",
          crm_client.clamp_reasoning("max", ["default", "low"]) == "default"
          and crm_client.clamp_reasoning("low", ["default", "low"]) == "low")

    agents = DEFAULT_AGENTS
    operator = agent_by_id(agents, "operator")
    chat_agent = agent_by_id(agents, "chat_agent")
    assert operator and chat_agent

    limited = settings_mod.LaunchSettings()
    limited.reasoning = "max"
    limited.set_value("operator", "max_steps", 900)
    limited.set_value("chat_agent", "max_steps", 900)
    limited.crm_profile = {
        "user": {
            "id": 2,
            "name": "Сотрудник",
            "role": "developer",
            "canUseAgent": True,
            "canUseOperator": False,
        },
        "limits": {
            "unlimited": False,
            "maxSteps": None,
            "reasoning": ["default", "low"],
        },
        "operator": {
            "enabled": True,
            "serverUrl": "https://crm.example.com",
            "token": "crmop_auto_token",
        },
    }
    check("crm_client: без права на Оператора запуск запрещён, а на Агента разрешён",
          not crm_client.can_launch_agent("operator", limited.crm_profile)[0]
          and crm_client.can_launch_agent("chat_agent", limited.crm_profile)[0])
    op_args = commands.agent_args(operator, limited)
    op_sec = commands.agent_secrets(operator, limited)
    check("crm_client: оператор получает автотокен в изолированный файл секретов и шаги без потолка",
          "--token" not in op_args
          and op_sec.get("CRM_AGENT_TOKEN") == "crmop_auto_token"
          and "--max-steps" in op_args and op_args[op_args.index("--max-steps") + 1] == "900")
    check("crm_client: reasoning сбрасывается до разрешённого уровня",
          "--reasoning" not in op_args
          and crm_client.clamp_reasoning("max", ["low", "medium"]) == "low")
    agent_env = commands.agent_env(chat_agent, limited)
    check("crm_client: AGENT_MAX_STEPS передаётся без урезания для всех ролей",
          agent_env.get("AGENT_MAX_STEPS") == "900")


def _gui_smoke(check) -> None:
    """Проверка интерфейса на заглушке tkinter: сборка формы, вход в CRM и запуск агента."""
    import time

    from launcher import _tkstub

    _tkstub.install()
    for name in [item for item in sys.modules if item.startswith("launcher.gui")]:
        del sys.modules[name]
    from launcher import gui  # noqa: PLC0415 — импорт после подмены tkinter

    orig_health = crm_client.check_health
    orig_login = crm_client.login
    orig_profile = crm_client.fetch_profile
    orig_logout = crm_client.logout
    active_profile: dict = {
        "ok": True,
        "user": {
            "id": 10,
            "name": "Тестовый разработчик",
            "email": "dev@example.com",
            "role": "developer",
            "roleLabel": "Разработчик",
            "canUseAgent": True,
            "canUseOperator": False,
        },
        "limits": {
            "unlimited": False,
            "maxSteps": 500,
            "reasoning": ["default", "low"],
        },
        "operator": {
            "enabled": False,
            "serverUrl": "http://localhost:3000",
            "token": "",
        },
    }

    def fake_health(url: str, timeout: float = 8.0):
        clean = crm_client.normalize_server_url(url)
        if "bad" in clean:
            return False, "CRM не отвечает"
        return True, f"CRM доступна ({clean})"

    def fake_login(url: str, email: str, password: str, timeout: float = 15.0):
        return {**active_profile, "sessionToken": "crm_sess_smoke_123"}

    def fake_fetch_profile(url: str, token: str, timeout: float = 12.0):
        return active_profile

    crm_client.check_health = fake_health  # type: ignore[assignment]
    crm_client.login = fake_login  # type: ignore[assignment]
    crm_client.fetch_profile = fake_fetch_profile  # type: ignore[assignment]
    crm_client.logout = lambda *_a, **_k: None  # type: ignore[assignment]

    with tempfile.TemporaryDirectory() as tmp:
        previous = os.environ.get("CRM_LAUNCHER_CONFIG")
        os.environ["CRM_LAUNCHER_CONFIG"] = str(Path(tmp) / "settings.json")
        try:
            root = sys.modules["tkinter"].Tk()
            app = gui.LauncherApp(root)
            check("интерфейс: агенты попали в список", len(app.agents) >= 3)
            check("интерфейс: выбрана форма оператора", app.spec.id == "operator")
            check("интерфейс: без входа в CRM запуск заблокирован и шаг 2 закрыт",
                  app.run_button.cget("state") == "disabled"
                  and app.crm_login_btn.cget("state") == "disabled")

            app.start_agent()
            check("интерфейс: попытка запуска без входа в CRM отклоняется", app.run is None)

            app.crm_url_var.set("http://bad-crm.local")
            check("интерфейс: шаг 1 отклоняет нерабочий URL CRM", app.verify_crm_url() is False)
            app.crm_url_var.set("http://localhost:3000")
            check("интерфейс: шаг 1 проверяет URL и открывает шаг 2",
                  app.verify_crm_url() is True and app.crm_login_btn.cget("state") == "normal")

            app.crm_email_var.set("dev@example.com")
            app.crm_password_var.set("secret123")
            check("интерфейс: шаг 2 выполняет вход и подтягивает профиль",
                  app.login_crm() is True and app.crm_password_var.get() == "")
            check("интерфейс: без прав Оператора кнопка запуска Оператора отключена",
                  app.run_button.cget("state") == "disabled")
            app.start_agent()
            check("интерфейс: запуск Оператора без прав в CRM не стартует процесс", app.run is None)

            hotkeys = {"<Control-a>", "<Control-c>", "<Control-v>", "<Control-KeyPress>"}
            check("интерфейс: Ctrl+A/C/V привязаны к полям и журналу",
                  hotkeys <= set(app._model_widgets["model"].bindings)
                  and hotkeys <= set(app.log.bindings))

            # Проверяем работу выделения/копирования/вставки в полях и журнале,
            # включая русскую раскладку и запрет вставки в журнал (disabled).
            model_entry = app._model_widgets["model"]
            base_entry = app._model_widgets["base_url"]
            app.model_var.set("qwen3-vl:8b")
            app.base_url_var.set("old-url")
            model_entry.bindings["<Control-a>"](type("E", (), {"widget": model_entry})())
            model_entry.bindings["<Control-c>"](type("E", (), {"widget": model_entry})())
            base_entry.bindings["<Control-KeyPress>"](
                type("E", (), {"widget": base_entry, "keysym": "Cyrillic_ef", "keycode": 65})(),
            )
            base_entry.bindings["<Control-KeyPress>"](
                type("E", (), {"widget": base_entry, "keysym": "Cyrillic_em", "keycode": 86})(),
            )
            check("интерфейс: Ctrl+A/C/V работают в полях (в т.ч. на русской раскладке)",
                  app.base_url_var.get() == "qwen3-vl:8b")

            app._log("лог для копирования")
            app.log.bindings["<Control-a>"](type("E", (), {"widget": app.log})())
            app.log.bindings["<Control-KeyPress>"](
                type("E", (), {"widget": app.log, "keysym": "Cyrillic_es", "keycode": 67})(),
            )
            before_log = app.log.content
            app.log.bindings["<Control-v>"](type("E", (), {"widget": app.log})())
            check("интерфейс: журнал копируется через Ctrl+A/C и не портится по Ctrl+V",
                  "лог для копирования" in app.log.clipboard_get() and app.log.content == before_log)
            app._sync_model_tab()

            # Выдаём право на Оператора и проверяем автоподстановку токена и разблокировку.
            active_profile["user"]["canUseOperator"] = True
            active_profile["operator"] = {
                "enabled": True,
                "serverUrl": "http://localhost:3000",
                "token": "crmop_live_auto",
            }
            app.refresh_crm_profile()
            check("интерфейс: после выдачи прав Оператор разблокирован и токен подставлен",
                  app.run_button.cget("state") == "normal"
                  and app.field_vars["crm_token"].get() == "crmop_live_auto")

            app._show_agent("chat_agent")
            app.field_vars["port"].set("8901")
            app.collect()
            check("интерфейс: поля агента сохраняются в настройки",
                  app.settings.values_for(app.spec).get("port") == 8901)

            app.provider_var.set("OpenAI")
            app._on_provider_change()
            check("интерфейс: провайдер подставляет адрес и модель",
                  app.settings.base_url.startswith("https://api.openai.com")
                  and app.settings.model == "gpt-4o-mini")

            script = Path(tmp) / "my_agent.py"
            script.write_text(
                "import json, os, pathlib, sys\nprint('gui-smoke-ok', ' '.join(sys.argv[1:]))\nprint(os.environ.get('AGENT_MODEL'))\n"
                "sf = os.environ.get('CRM_SECRETS_FILE', '')\n"
                "print(json.loads(pathlib.Path(sf).read_text(encoding='utf-8')).get('CRM_LAUNCHER_SESSION_TOKEN') if sf else '')\n",
                encoding="utf-8",
            )
            app._show_agent("custom")
            app.field_vars["script_path"].set(str(script))
            app.field_vars["args"].set("--check")
            app.collect()
            app.start_agent()
            deadline = time.time() + 60
            while app.run is not None and app.run.is_running() and time.time() < deadline:
                time.sleep(0.2)
            time.sleep(0.3)
            app._drain_log()
            check("интерфейс: агент запускается и пишет в журнал",
                  "gui-smoke-ok --check" in app.log.content)
            check("интерфейс: модель уходит в env, а сессия CRM — через 0600 файл секретов",
                  "gpt-4o-mini" in app.log.content and "crm_sess_smoke_123" in app.log.content)
            app._on_close()
            check("интерфейс: настройки сохраняются при выходе",
                  Path(os.environ["CRM_LAUNCHER_CONFIG"]).is_file())
        finally:
            crm_client.check_health = orig_health  # type: ignore[assignment]
            crm_client.login = orig_login  # type: ignore[assignment]
            crm_client.fetch_profile = orig_profile  # type: ignore[assignment]
            crm_client.logout = orig_logout  # type: ignore[assignment]
            if previous is None:
                os.environ.pop("CRM_LAUNCHER_CONFIG", None)
            else:
                os.environ["CRM_LAUNCHER_CONFIG"] = previous


# --------------------------------------------------------------------------
# консольный список агентов
# --------------------------------------------------------------------------

def list_agents() -> int:
    for spec in load_catalog():
        needs = ", ".join(spec.requires) or "ничего"
        print(f"{spec.id:<12} {spec.title} — {spec.subtitle} (нужно: {needs})")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="CRM Agents", description="Настольный CRM ИИ-harness и запускатор агентов")
    parser.add_argument("--run-agent", nargs=argparse.REMAINDER, metavar="SCRIPT",
                        help="выполнить скрипт агента внутри приложения и выйти")
    parser.add_argument("--self-test", action="store_true", help="самопроверки без экрана")
    parser.add_argument("--list", action="store_true", help="показать каталог агентов")
    parser.add_argument("--classic-tk", action="store_true", help="открыть классический Tkinter-интерфейс")
    parser.add_argument("--headless", action="store_true", help="запустить только локальный сервер (без окна)")
    parser.add_argument("--port", type=int, default=0, help="порт локального сервера интерфейса (по умолчанию авто)")
    parser.add_argument("--version", action="version", version=f"{APP_NAME} {APP_VERSION}")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    ensure_std_streams()
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.run_agent is not None:
        return run_agent(args.run_agent)
    if args.self_test:
        return self_test()
    if args.list:
        return list_agents()
    if args.classic_tk:
        from launcher.gui import run_gui

        return run_gui()

    server = harness_server.HarnessServer(port=max(0, int(args.port or 0)))
    server.start()
    try:
        return desktop_window.open_desktop_window(server.entry_url(), headless=bool(args.headless))
    finally:
        server.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
