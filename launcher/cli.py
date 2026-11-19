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
    """В оконной сборке exe stdout/stderr могут быть None — берём реальные fd."""
    for name, fd in (("stdout", 1), ("stderr", 2)):
        stream = getattr(sys, name)
        if stream is not None:
            continue
        try:
            raw = os.fdopen(os.dup(fd), "wb", buffering=0)
            setattr(sys, name, io.TextIOWrapper(raw, encoding="utf-8", errors="replace", line_buffering=True))
        except (OSError, ValueError):
            setattr(sys, name, open(os.devnull, "w", encoding="utf-8"))


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
    off_args = commands.agent_args(operator, off)
    check("оператор: выключение проверки и подсказок",
          "--no-verify-actions" in off_args and "--no-repeat-nudge" in off_args)

    env = commands.agent_env(chat_agent, conf)
    check("агент: адрес, модель и ключ уходят в переменные",
          env.get("AGENT_BASE_URL", "").endswith("/v1") and env.get("AGENT_MODEL") and env.get("AGENT_API_KEY"))
    check("агент: порт по умолчанию", env.get("AGENT_PORT") == "8899")

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
