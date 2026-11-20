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
from launcher import bundle, commands, deps, runner, settings as settings_mod  # noqa: E402
from launcher.catalog import DEFAULT_AGENTS, PROVIDER_PRESETS, agent_by_id, load_catalog  # noqa: E402


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
    check("оператор: секреты не светятся в описании команды",
          "sk-secret-key-123456" not in commands.describe_command(args, {})
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
    check("агент: адрес, модель и ключ уходят в переменные",
          env.get("AGENT_BASE_URL", "").endswith("/v1") and env.get("AGENT_MODEL") and env.get("AGENT_API_KEY"))
    check("агент: порт по умолчанию", env.get("AGENT_PORT") == "8899")
    check("агент: уровень доверия уходит в AGENT_TRUST_LEVEL", env.get("AGENT_TRUST_LEVEL") == "verified")

    trust_conf = settings_mod.LaunchSettings()
    trust_conf.set_value("operator", "trust_level", "none")
    trust_args = commands.agent_args(operator, trust_conf)
    check("оператор: уровень доверия передаётся флагом --trust-level",
          "--trust-level" in trust_args and "none" in trust_args)

    custom_conf = settings_mod.LaunchSettings()
    custom_conf.set_value("custom", "args", '--name "Иван Петров" --fast')
    custom_args = commands.agent_args(custom, custom_conf)
    check("свой агент: аргументы разбираются с кавычками",
          custom_args[:2] == ["--name", "Иван Петров"] and custom_args[-1] == "--fast")

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "settings.json"
        conf.remember_key = False
        settings_mod.save(conf, path)
        raw = path.read_text(encoding="utf-8")
        check("настройки: ключ не пишется без разрешения", "sk-secret-key-123456" not in raw)
        restored = settings_mod.load(path)
        check("настройки: значения агента переживают перезапуск",
              restored.values_for(operator).get("task") == "открой блокнот")
        conf.remember_key = True
        settings_mod.save(conf, path)
        check("настройки: с галочкой ключ сохраняется",
              settings_mod.load(path).api_key == "sk-secret-key-123456")

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
    check("сборка: tkinter и зависимости в hiddenimports",
          {"tkinter", "pyautogui", "PIL", "pyperclip"} <= set(captured.get("hiddenimports", [])))
    check("сборка: exe оконный (без консоли)", captured.get("exe", {}).get("console") is False)


def _gui_smoke(check) -> None:
    """Проверка интерфейса на заглушке tkinter: сборка формы и запуск агента."""
    import time

    from launcher import _tkstub

    _tkstub.install()
    for name in [item for item in sys.modules if item.startswith("launcher.gui")]:
        del sys.modules[name]
    from launcher import gui  # noqa: PLC0415 — импорт после подмены tkinter

    with tempfile.TemporaryDirectory() as tmp:
        previous = os.environ.get("CRM_LAUNCHER_CONFIG")
        os.environ["CRM_LAUNCHER_CONFIG"] = str(Path(tmp) / "settings.json")
        try:
            root = sys.modules["tkinter"].Tk()
            app = gui.LauncherApp(root)
            check("интерфейс: агенты попали в список", len(app.agents) >= 3)
            check("интерфейс: выбрана форма оператора", app.spec.id == "operator")
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
                "import os, sys\nprint('gui-smoke-ok', ' '.join(sys.argv[1:]))\nprint(os.environ.get('AGENT_MODEL'))\n",
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
            check("интерфейс: модель уходит в переменные окружения",
                  "gpt-4o-mini" in app.log.content)
            app._on_close()
            check("интерфейс: настройки сохраняются при выходе",
                  Path(os.environ["CRM_LAUNCHER_CONFIG"]).is_file())
        finally:
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
    parser = argparse.ArgumentParser(prog="CRM Agents", description="Запускатор ИИ-агентов CRM")
    parser.add_argument("--run-agent", nargs=argparse.REMAINDER, metavar="SCRIPT",
                        help="выполнить скрипт агента внутри приложения и выйти")
    parser.add_argument("--self-test", action="store_true", help="самопроверки без экрана")
    parser.add_argument("--list", action="store_true", help="показать каталог агентов")
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

    from launcher.gui import run_gui

    return run_gui()


if __name__ == "__main__":
    raise SystemExit(main())
