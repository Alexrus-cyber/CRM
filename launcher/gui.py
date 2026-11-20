# -*- coding: utf-8 -*-
"""Графический запускатор: выбор агента, общие настройки модели, журнал.

Только стандартный tkinter — ничего доустанавливать не нужно, и всё это
замечательно замораживается PyInstaller'ом в один exe.
"""

from __future__ import annotations

import sys
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from typing import Any, Dict, List

from launcher import APP_NAME, APP_VERSION, deps
from launcher import bundle, commands
from launcher import runner as runner_module
from launcher import settings as settings_mod
from launcher.catalog import PROVIDER_PRESETS, REASONING_MODES, AgentSpec, Field, load_catalog
from launcher.runner import AgentRun

MAX_LOG_LINES = 4000
LOG_BG = "#111318"
LOG_FG = "#d7dbe0"
MUTED = "#8b93a1"


def _bind_edit_shortcuts(widget: tk.Widget) -> None:
    """Bind standard clipboard shortcuts explicitly for bundled Tk runtimes.

    Some portable Tcl/Tk bundles omit or alter the platform's default Entry
    bindings, and Windows Tk ignores `<Control-c/v/a>` when a non-Latin
    (e.g. Russian) keyboard layout is active. Handling both key names and
    layout-independent keycodes/keysyms makes editing reliable in dist builds.
    """

    def is_text(target: Any) -> bool:
        return isinstance(target, tk.Text)

    def has_selection(target: Any) -> bool:
        try:
            if is_text(target):
                return bool(target.tag_ranges("sel"))
            return bool(target.selection_present())
        except (tk.TclError, AttributeError):
            return False

    def selected_text(target: Any) -> str:
        if is_text(target):
            return str(target.get("sel.first", "sel.last"))
        start = int(target.index("sel.first"))
        end = int(target.index("sel.last"))
        return str(target.get())[start:end]

    def copy(event: Any) -> str:
        target = getattr(event, "widget", None) or widget
        if not has_selection(target):
            return "break"
        try:
            value = selected_text(target)
            target.clipboard_clear()
            target.clipboard_append(value)
        except (tk.TclError, AttributeError, TypeError, ValueError):
            pass
        return "break"

    def editable(target: Any) -> bool:
        try:
            if isinstance(target, (ttk.Entry, ttk.Combobox)) and hasattr(target, "instate"):
                if target.instate(["disabled"]) or target.instate(["readonly"]):
                    return False
            return str(target.cget("state")) not in {"disabled", "readonly"}
        except (tk.TclError, AttributeError):
            return True

    def cut(event: Any) -> str:
        target = getattr(event, "widget", None) or widget
        if not editable(target) or not has_selection(target):
            return "break"
        copy(event)
        try:
            target.delete("sel.first", "sel.last")
        except (tk.TclError, AttributeError):
            pass
        return "break"

    def paste(event: Any) -> str:
        target = getattr(event, "widget", None) or widget
        if not editable(target):
            return "break"
        try:
            value = str(target.clipboard_get())
            if not is_text(target):
                value = value.replace("\r\n", "\n").strip("\r\n")
            if has_selection(target):
                target.delete("sel.first", "sel.last")
            target.insert("insert", value)
        except (tk.TclError, AttributeError):
            pass
        return "break"

    def select_all(event: Any) -> str:
        target = getattr(event, "widget", None) or widget
        try:
            if is_text(target):
                target.tag_add("sel", "1.0", "end-1c")
                target.mark_set("insert", "end-1c")
            else:
                target.selection_range(0, "end")
                target.icursor("end")
        except (tk.TclError, AttributeError):
            pass
        return "break"

    def dispatch_ctrl_key(event: Any) -> str | None:
        keysym = str(getattr(event, "keysym", "") or "").lower()
        # Латинские сочетания уже перехватываются отдельными привязками ниже.
        if keysym in {"a", "c", "x", "v"}:
            return None
        keycode = getattr(event, "keycode", None)
        win = sys.platform.startswith("win")
        if keysym == "cyrillic_ef" or (win and keycode == 65):
            return select_all(event)
        if keysym == "cyrillic_es" or (win and keycode == 67):
            return copy(event)
        if keysym == "cyrillic_che" or (win and keycode == 88):
            return cut(event)
        if keysym == "cyrillic_em" or (win and keycode == 86):
            return paste(event)
        return None

    sequences: list[tuple[str, Any]] = [
        ("<Control-a>", select_all),
        ("<Control-A>", select_all),
        ("<Control-c>", copy),
        ("<Control-C>", copy),
        ("<Control-x>", cut),
        ("<Control-X>", cut),
        ("<Control-v>", paste),
        ("<Control-V>", paste),
        ("<Control-Insert>", copy),
        ("<Shift-Insert>", paste),
        ("<Control-KeyPress>", dispatch_ctrl_key),
    ]
    if sys.platform == "darwin":
        sequences.extend([
            ("<Command-a>", select_all),
            ("<Command-A>", select_all),
            ("<Command-c>", copy),
            ("<Command-C>", copy),
            ("<Command-x>", cut),
            ("<Command-X>", cut),
            ("<Command-v>", paste),
            ("<Command-V>", paste),
        ])
    for sequence, handler in sequences:
        widget.bind(sequence, handler)


class LauncherApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(f"{APP_NAME} {APP_VERSION}")
        self.root.geometry("1180x840")
        self.root.minsize(1020, 700)

        self.settings = settings_mod.load()
        self.agents = load_catalog(settings_mod.config_dir() / "agents.json")
        self.spec: AgentSpec = self._initial_spec()
        self.run: AgentRun | None = None
        self._stopped_by_user = False
        self._retried = False
        self._last_launch: tuple[Path, List[str], Dict[str, str], Path] | None = None
        self.field_vars: Dict[str, Any] = {}
        self.choice_maps: Dict[str, Dict[str, str]] = {}
        self._drain_after_id: str | None = None

        self._build_header()
        self._build_body()
        self._build_log()
        self._build_footer()

        self._sync_model_tab()
        self._show_agent(self.spec.id, remember=False)
        self._log(f"{APP_NAME} {APP_VERSION}")
        self._log(f"настройки: {settings_mod.config_path()}")
        self._log(f"агенты: {bundle.agents_dir()}")
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.bind("<Control-Return>", lambda _event: self.start_agent())
        self.root.bind("<Control-period>", lambda _event: self.stop_agent())

    # ------------------------------------------------------------------
    # построение интерфейса
    # ------------------------------------------------------------------
    def _build_header(self) -> None:
        header = tk.Frame(self.root, padx=14, pady=10)
        header.grid(row=0, column=0, columnspan=2, sticky="ew")
        header.columnconfigure(1, weight=1)
        tk.Label(header, text="CRM Agents", font=("Segoe UI", 16, "bold")).grid(row=0, column=0, sticky="w")
        tk.Label(
            header, text="выберите агента, укажите модель — и запускайте", fg=MUTED, font=("Segoe UI", 9)
        ).grid(row=0, column=1, sticky="w", padx=(12, 0))
        self.summary_var = tk.StringVar(value=self.settings.describe())
        tk.Label(header, textvariable=self.summary_var, fg=MUTED, font=("Segoe UI", 9)).grid(
            row=0, column=2, sticky="e"
        )

    def _build_body(self) -> None:
        body = tk.Frame(self.root, padx=14)
        body.grid(row=1, column=0, columnspan=2, sticky="nsew")
        body.columnconfigure(1, weight=1)
        body.rowconfigure(0, weight=1)
        self.root.rowconfigure(1, weight=1)

        left = tk.Frame(body)
        left.grid(row=0, column=0, sticky="nsw", padx=(0, 12))
        tk.Label(left, text="Агенты", font=("Segoe UI", 10, "bold")).pack(anchor="w")
        self.agent_list = tk.Listbox(
            left, width=34, height=8, activestyle="none", exportselection=False,
            font=("Segoe UI", 10), selectbackground="#7c5cff", selectforeground="white",
        )
        self.agent_list.pack(fill="both", expand=False, pady=(6, 6))
        for spec in self.agents:
            self.agent_list.insert("end", f"{spec.title}\n{spec.subtitle}")
        self.agent_list.bind("<<ListboxSelect>>", self._on_agent_click)
        self.description = tk.Label(
            left, text="", wraplength=260, justify="left", fg=MUTED, font=("Segoe UI", 9)
        )
        self.description.pack(anchor="w", pady=(0, 8))
        self.requirements = tk.Label(left, text="", wraplength=260, justify="left", font=("Segoe UI", 9))
        self.requirements.pack(anchor="w")
        tk.Button(left, text="Проверить окружение", command=self._check_environment).pack(anchor="w", pady=(10, 0))
        tk.Button(left, text="Открыть рабочую папку", command=self._open_workspace).pack(anchor="w", pady=(4, 0))

        self.notebook = ttk.Notebook(body)
        self.notebook.grid(row=0, column=1, sticky="nsew")

        self.agent_tab = tk.Frame(self.notebook, padx=8, pady=8)
        self.agent_tab.columnconfigure(0, weight=1)
        self.agent_tab.columnconfigure(1, weight=1)
        self.notebook.add(self.agent_tab, text="Агент")

        self.model_tab = tk.Frame(self.notebook, padx=8, pady=8)
        self.model_tab.columnconfigure(0, weight=1)
        self.model_tab.columnconfigure(1, weight=1)
        self.notebook.add(self.model_tab, text="Модель")

        # --- вкладка «Модель» ---
        self.provider_var = tk.StringVar()
        self.base_url_var = tk.StringVar()
        self.model_var = tk.StringVar()
        self.api_key_var = tk.StringVar()
        self.temperature_var = tk.StringVar()
        self.top_p_var = tk.StringVar()
        self.max_tokens_var = tk.StringVar()
        self.reasoning_var = tk.StringVar()
        self.remember_var = tk.BooleanVar()

        provider_labels = {preset["label"]: key for key, preset in PROVIDER_PRESETS.items()}
        provider_labels["Свой адрес (custom)"] = "custom"
        self._provider_by_label = provider_labels
        self._label_by_provider = {value: key for key, value in provider_labels.items()}

        fields: List[tuple[str, Any]] = [
            ("Провайдер", "provider"),
            ("Адрес API", "base_url"),
            ("Модель", "model"),
            ("Ключ API", "api_key"),
            ("Temperature", "temperature"),
            ("top_p", "top_p"),
            ("max_tokens", "max_tokens"),
            ("Раздумья", "reasoning"),
        ]
        self._model_widgets: Dict[str, Any] = {}
        for index, (label, key) in enumerate(fields):
            row, column = divmod(index, 2)
            self._model_field(self.model_tab, row, column, label, key)
        remember = ttk.Checkbutton(
            self.model_tab, text="Сохранять ключ API в настройках (иначе каждый раз вводить заново)",
            variable=self.remember_var, command=self._on_remember_toggle,
        )
        remember.grid(row=4, column=0, columnspan=2, sticky="w", padx=6, pady=(10, 0))
        hint = tk.Label(
            self.model_tab,
            text="Параметры применяются ко всем агентам. Пустое поле = агент использует значение по умолчанию.",
            fg=MUTED, font=("Segoe UI", 9), wraplength=700, justify="left",
        )
        hint.grid(row=5, column=0, columnspan=2, sticky="w", padx=6, pady=(8, 0))

    def _model_field(self, parent: tk.Widget, row: int, column: int, label: str, key: str) -> None:
        holder = tk.Frame(parent)
        holder.grid(row=row, column=column, sticky="ew", padx=6, pady=5)
        holder.columnconfigure(0, weight=1)
        tk.Label(holder, text=label, font=("Segoe UI", 9)).grid(row=0, column=0, sticky="w")
        if key == "provider":
            widget = ttk.Combobox(holder, textvariable=self.provider_var, state="readonly",
                                  values=list(self._provider_by_label))
        elif key == "reasoning":
            self._reasoning_by_label = {label_: value for value, label_ in REASONING_MODES}
            widget = ttk.Combobox(holder, textvariable=self.reasoning_var, state="readonly",
                                  values=list(self._reasoning_by_label))
        elif key == "api_key":
            widget = ttk.Entry(holder, textvariable=self.api_key_var, show="•")
        else:
            variable = {
                "base_url": self.base_url_var,
                "model": self.model_var,
                "temperature": self.temperature_var,
                "top_p": self.top_p_var,
                "max_tokens": self.max_tokens_var,
            }[key]
            widget = ttk.Entry(holder, textvariable=variable)
        _bind_edit_shortcuts(widget)
        widget.grid(row=1, column=0, sticky="ew", pady=(2, 0))
        self._model_widgets[key] = widget
        if key == "provider":
            widget.bind("<<ComboboxSelected>>", self._on_provider_change)

    def _build_log(self) -> None:
        frame = tk.Frame(self.root, padx=14, pady=8)
        frame.grid(row=2, column=0, columnspan=2, sticky="nsew")
        frame.columnconfigure(0, weight=1)
        frame.rowconfigure(1, weight=1)
        self.root.rowconfigure(2, weight=1)

        head = tk.Frame(frame)
        head.grid(row=0, column=0, sticky="ew", pady=(0, 4))
        tk.Label(head, text="Журнал агента", font=("Segoe UI", 10, "bold")).pack(side="left")
        tk.Button(head, text="Очистить", command=self._clear_log).pack(side="right")
        self.stop_button = tk.Button(head, text="■ Остановить", command=self.stop_agent, state="disabled")
        self.stop_button.pack(side="right", padx=6)
        self.run_button = tk.Button(head, text="▶ Запустить", command=self.start_agent)
        self.run_button.pack(side="right")

        self.log = tk.Text(frame, height=10, bg=LOG_BG, fg=LOG_FG, insertbackground=LOG_FG,
                           relief="flat", wrap="word", font=("Consolas", 9), padx=8, pady=6)
        _bind_edit_shortcuts(self.log)
        # Отключённый Text в Tk часто не получает фокус по клику — без этого
        # Ctrl+A/Ctrl+C после клика по журналу уходили в предыдущее поле.
        self.log.bind("<Button-1>", lambda _event: self.log.focus_set(), add="+")
        self.log.grid(row=1, column=0, sticky="nsew")
        self.log.configure(state="disabled")
        scroll = ttk.Scrollbar(frame, orient="vertical", command=self.log.yview)
        scroll.grid(row=1, column=1, sticky="ns")
        self.log.configure(yscrollcommand=scroll.set)

    def _build_footer(self) -> None:
        footer = tk.Frame(self.root, padx=14, pady=8)
        footer.grid(row=3, column=0, columnspan=2, sticky="ew")
        footer.columnconfigure(1, weight=1)
        self.status_var = tk.StringVar(value="агент не запущен")
        tk.Label(footer, textvariable=self.status_var, font=("Segoe UI", 9)).grid(row=0, column=0, sticky="w")
        tk.Label(footer, text="Ctrl+A/C/V — выделить/копировать/вставить · Ctrl+Enter — запуск · Ctrl+. — остановка", fg=MUTED,
                 font=("Segoe UI", 9)).grid(row=0, column=2, sticky="e")

    # ------------------------------------------------------------------
    # данные формы
    # ------------------------------------------------------------------
    def _initial_spec(self) -> AgentSpec:
        for spec in self.agents:
            if spec.id == self.settings.last_agent:
                return spec
        return self.agents[0]

    def _sync_model_tab(self) -> None:
        self.provider_var.set(self._label_by_provider.get(self.settings.provider, "Локальный сервер"))
        self.base_url_var.set(self.settings.base_url)
        self.model_var.set(self.settings.model)
        self.api_key_var.set(self.settings.api_key)
        self.temperature_var.set("" if self.settings.temperature is None else str(self.settings.temperature))
        self.top_p_var.set("" if self.settings.top_p is None else str(self.settings.top_p))
        self.max_tokens_var.set("" if self.settings.max_tokens is None else str(self.settings.max_tokens))
        labels = {value: label for value, label in REASONING_MODES}
        self.reasoning_var.set(labels.get(self.settings.reasoning, labels["default"]))
        self.remember_var.set(self.settings.remember_key)

    def _collect_model_tab(self) -> None:
        self.settings.provider = self._provider_by_label.get(self.provider_var.get(), "local")
        self.settings.base_url = self.base_url_var.get().strip()
        self.settings.model = self.model_var.get().strip()
        self.settings.api_key = self.api_key_var.get().strip()
        self.settings.temperature = _float_or_none(self.temperature_var.get())
        self.settings.top_p = _float_or_none(self.top_p_var.get())
        self.settings.max_tokens = _int_or_none(self.max_tokens_var.get())
        self.settings.reasoning = self._reasoning_by_label.get(self.reasoning_var.get(), "default")
        self.settings.remember_key = bool(self.remember_var.get())

    def _collect_agent_tab(self) -> None:
        values: Dict[str, Any] = {}
        for field in self.spec.fields:
            variable = self.field_vars.get(field.key)
            if variable is None:
                continue
            if field.kind == "bool":
                values[field.key] = bool(variable.get())
            elif field.kind == "int":
                # Пустое поле — не задаём параметр вовсе, агент возьмёт своё значение.
                values[field.key] = _int_or_none(str(variable.get()))
            elif field.kind == "float":
                values[field.key] = _float_or_none(str(variable.get()))
            elif field.kind == "choice":
                label = str(variable.get())
                values[field.key] = self.choice_maps.get(field.key, {}).get(label, label)
            else:
                values[field.key] = str(variable.get()).strip()
        self.settings.replace_values(self.spec.id, values)

    def collect(self) -> None:
        self._collect_model_tab()
        self._collect_agent_tab()
        self.summary_var.set(self.settings.describe())
        self.settings.last_agent = self.spec.id

    # ------------------------------------------------------------------
    # агент
    # ------------------------------------------------------------------
    def _on_agent_click(self, _event: object | None = None) -> None:
        selection = self.agent_list.curselection()
        if not selection:
            return
        spec = self.agents[selection[0]]
        if spec.id == self.spec.id:
            return
        self.collect()
        self._show_agent(spec.id)

    def _show_agent(self, agent_id: str, remember: bool = True) -> None:
        spec = next((item for item in self.agents if item.id == agent_id), self.agents[0])
        self.spec = spec
        index = self.agents.index(spec)
        self.agent_list.selection_clear(0, "end")
        self.agent_list.selection_set(index)
        self.agent_list.see(index)

        for child in self.agent_tab.winfo_children():
            child.destroy()
        self.field_vars = {}
        self.choice_maps = {}
        values = self.settings.values_for(spec)

        if spec.fields:
            for position, field in enumerate(spec.fields):
                row, column = divmod(position, 2)
                self._agent_field(self.agent_tab, row, column, field, values.get(field.key, field.default))
        else:
            tk.Label(self.agent_tab, text="У этого агента нет настроек.", fg=MUTED).grid(
                row=0, column=0, sticky="w", padx=6, pady=6
            )

        self.description.configure(text=spec.description)
        self.requirements.configure(text=self._requirements_text(spec))
        if remember:
            self.settings.last_agent = spec.id

    def _requirements_text(self, spec: AgentSpec) -> str:
        needs = {
            "screen": "экран (Windows/macOS/Linux с графической сессией)",
            "model": "модель с OpenAI-совместимым API",
            "crm": "доступ к CRM (токен агента)",
            "python": "Python на машине (для своих скриптов)",
        }
        lines = ["Нужно: " + ", ".join(needs.get(key, key) for key in spec.requires)]
        if spec.docs:
            lines.append(f"Инструкция: {spec.docs}")
        for item in deps.check(spec.id):
            lines.append(f"{item.package}: {'есть' if item.present else 'нет'}")
        return "\n".join(lines)

    def _agent_field(self, parent: tk.Widget, row: int, column: int, field: Field, value: Any) -> None:
        holder = tk.Frame(parent)
        holder.grid(row=row, column=column, sticky="ew", padx=6, pady=5)
        holder.columnconfigure(0, weight=1)

        if field.kind == "bool":
            variable = tk.BooleanVar(value=bool(value))
            ttk.Checkbutton(holder, text=field.label, variable=variable).grid(row=0, column=0, columnspan=2, sticky="w")
            self.field_vars[field.key] = variable
        else:
            tk.Label(holder, text=field.label, font=("Segoe UI", 9)).grid(row=0, column=0, columnspan=2, sticky="w")
            if field.kind == "choice":
                labels = {label: key for key, label in field.choices}
                variable = tk.StringVar(value=labels.get(str(value), field.choices[0][1] if field.choices else ""))
                widget = ttk.Combobox(holder, textvariable=variable, state="readonly", values=list(labels))
                self.choice_maps[field.key] = {label: key for key, label in field.choices}
            elif field.kind == "secret":
                variable = tk.StringVar(value=str(value))
                widget = ttk.Entry(holder, textvariable=variable, show="•")
            else:
                variable = tk.StringVar(value="" if value is None else str(value))
                widget = ttk.Entry(holder, textvariable=variable)
            _bind_edit_shortcuts(widget)
            widget.grid(row=1, column=0, sticky="ew", padx=(0, 4), pady=(2, 0))
            self.field_vars[field.key] = variable
            if field.kind in ("file", "folder"):
                ttk.Button(holder, text="…", width=3,
                           command=lambda f=field, v=variable: self._browse(f, v)).grid(row=1, column=1, sticky="e")
        if field.hint:
            tk.Label(holder, text=field.hint, fg=MUTED, font=("Segoe UI", 8), wraplength=320,
                     justify="left").grid(row=2, column=0, columnspan=2, sticky="w")

    def _browse(self, field: Field, variable: tk.StringVar) -> None:
        if field.kind == "file":
            path = filedialog.askopenfilename(title="Выберите файл агента",
                                              filetypes=[("Python", "*.py"), ("Все файлы", "*.*")])
        else:
            path = filedialog.askdirectory(title="Выберите папку")
        if path:
            variable.set(path)

    def _on_provider_change(self, _event: object | None = None) -> None:
        provider = self._provider_by_label.get(self.provider_var.get(), "local")
        preset = PROVIDER_PRESETS.get(provider)
        if preset:
            self.base_url_var.set(preset["base_url"])
            if not self.model_var.get().strip() or self.model_var.get().strip() in {
                item["model"] for item in PROVIDER_PRESETS.values()
            }:
                self.model_var.set(preset["model"])
        self._collect_model_tab()
        self.summary_var.set(self.settings.describe())
        self._log(f"провайдер: {self.settings.describe()}")

    def _on_remember_toggle(self) -> None:
        self.settings.remember_key = bool(self.remember_var.get())
        if not self.settings.remember_key:
            self.settings.api_key = self.api_key_var.get().strip()
            self._log("ключ API не будет сохранён на диск")

    # ------------------------------------------------------------------
    # запуск и остановка
    # ------------------------------------------------------------------
    def start_agent(self) -> None:
        if self.run is not None and self.run.is_running():
            messagebox.showinfo(APP_NAME, "Агент уже запущен. Сначала остановите его.")
            return
        self.collect()

        missing = deps.missing(self.spec.id)
        if missing:
            names = ", ".join(item.package for item in missing)
            answer = messagebox.askyesno(
                APP_NAME,
                f"Не хватает модулей: {names}.\n\nПопробовать поставить их из локальной папки wheels?\n"
                f"({deps.interpreter_hint()})",
            )
            if answer:
                ok, message = deps.install_offline(self.spec.id, bundle.wheels_dir())
                self._log(message)
                if not ok:
                    messagebox.showerror(APP_NAME, message)
                    return
            else:
                return

        info = bundle.runtime_info()
        if info["_MEIPASS существует"] == "нет" and bundle.is_frozen():
            messagebox.showerror(
                APP_NAME,
                "Не удалось распаковать встроенный runtime (нет папки _MEIxxxx).\n\n"
                "Обычно это однофайловая сборка, которой запретили писать во временную папку.\n"
                "Что сделать: собрать папкой (`python launcher/build_exe.py --onedir`) "
                "или указать свою папку (`--tmpdir D:\\crm-temp`), проверить TEMP и антивирус.",
            )
            return
        if info["запись во временную папку"] != "ок":
            self._log("внимание: " + info["запись во временную папку"])

        warnings = commands.validate(self.spec, self.settings, bundle.agents_dir())
        if warnings:
            text = "\n".join(f"• {item}" for item in warnings)
            self._log("предупреждения:\n" + text)
            if not messagebox.askyesno(APP_NAME, f"Есть замечания:\n\n{text}\n\nВсё равно запустить?"):
                return

        script = commands.script_path(self.spec, self.settings, bundle.agents_dir())
        if script is None:
            messagebox.showerror(APP_NAME, "Не выбран скрипт агента.")
            return

        args = commands.agent_args(self.spec, self.settings)
        env = commands.agent_env(self.spec, self.settings)
        cwd = commands.working_dir(self.spec, self.settings, bundle.agents_dir(), settings_mod.workspace_dir())
        bundle.ensure_dir(cwd)
        self._last_launch = (script, args, env, cwd)
        self._retried = False
        self._spawn(reuse_runtime=True)

    def _spawn(self, reuse_runtime: bool) -> None:
        """Запуск агента; `reuse_runtime=False` — вторая попытка без _PYI_* подсказок."""
        if self._last_launch is None:
            return
        script, args, env, cwd = self._last_launch
        command = bundle.run_agent_args(script, args)
        if reuse_runtime:
            self._log("")
            self._log(f"▶ {self.spec.title}")
            self._log("  " + commands.describe_command([script.name, *args], env))
        try:
            run = AgentRun(
                agent_id=self.spec.id,
                command=command,
                cwd=cwd,
                env=bundle.child_env({key: value for key, value in env.items() if value},
                                     reuse_runtime=reuse_runtime),
            )
            run.start()
        except OSError as error:
            self._log(f"не удалось запустить: {error}")
            messagebox.showerror(APP_NAME, f"Не удалось запустить агента:\n{error}")
            return

        self.run = run
        self._stopped_by_user = False
        self.run_button.configure(state="disabled")
        self.stop_button.configure(state="normal")
        self.status_var.set(f"● {self.spec.title} — работает (PID {run.pid()})")
        self._schedule_drain()
        self.root.after(2500, self._watch_early_exit)
        if reuse_runtime:
            self._maybe_open_url()

    def _watch_early_exit(self) -> None:
        """Bootloader может умереть сразу с кодом -1: пробуем второй вариант запуска."""
        run = self.run
        if run is None or self._stopped_by_user or self._retried:
            return
        if run.is_running():
            return
        if run.exit_code not in (-1, 4294967295):
            return
        self._retried = True
        self._log("bootloader не смог переиспользовать runtime — пробую обычный запуск")
        self._spawn(reuse_runtime=False)

    def _maybe_open_url(self) -> None:
        if not self.spec.open_url:
            return
        if not commands.truthy(self.settings.values_for(self.spec).get("open_browser", False)):
            return
        port = commands.number(self.settings.values_for(self.spec).get("port"), int) or 8899
        url = self.spec.open_url.format(port=port)
        self._log(f"  открою {url}")
        self.root.after(1500, lambda: webbrowser.open(url))

    def stop_agent(self) -> None:
        if self.run is None:
            return
        self._stopped_by_user = True
        self._log("останавливаю агента…")
        self.run.stop()
        self._log("агент остановлен")
        self._finish_run()

    def _finish_run(self) -> None:
        self.run_button.configure(state="normal")
        self.stop_button.configure(state="disabled")
        self.status_var.set("агент не запущен")
        self.run = None

    def _schedule_drain(self) -> None:
        self._drain_after_id = self.root.after(120, self._drain_log)

    def _drain_log(self) -> None:
        run = self.run
        if run is not None:
            for line in run.poll_lines():
                self._log(line)
            if run.is_running():
                self.status_var.set(f"● {self.spec.title} — работает (PID {run.pid()}) · {run.uptime_text()}")
                self._schedule_drain()
                return
            self._report_exit(run)
            self._finish_run()
        self._drain_after_id = None

    # ------------------------------------------------------------------
    # журнал и служебные действия
    # ------------------------------------------------------------------
    def _report_exit(self, run: AgentRun) -> None:
        """Понятное объяснение, если агент умер не «сам по себе»."""
        if self._stopped_by_user or run.exit_code in (None, 0):
            return
        hint = runner_module.exit_hint(run.exit_code)
        if not hint:
            return
        self._log("подсказка: " + hint)
        messagebox.showwarning(APP_NAME, hint)

    def _log(self, text: str) -> None:
        self.log.configure(state="normal")
        self.log.insert("end", text.rstrip() + "\n")
        lines = int(self.log.index("end-1c").split(".")[0])
        if lines > MAX_LOG_LINES:
            self.log.delete("1.0", f"{lines - MAX_LOG_LINES}.0")
        self.log.configure(state="disabled")
        self.log.see("end")

    def _clear_log(self) -> None:
        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        self.log.configure(state="disabled")

    def _check_environment(self) -> None:
        self.collect()
        lines = [f"Версия: {APP_NAME} {APP_VERSION}", f"Агенты: {bundle.agents_dir()}",
                 f"Настройки: {settings_mod.config_path()}"]
        lines += [f"{key}: {value}" for key, value in bundle.runtime_info().items()]
        lines += deps.report(self.spec.id)
        info = bundle.runtime_info()
        if info["запись во временную папку"] != "ок":
            lines.append("Внимание: " + info["запись во временную папку"])

        warnings = commands.validate(self.spec, self.settings, bundle.agents_dir())
        lines.append("Замечания: " + ("; ".join(warnings) if warnings else "нет"))
        for line in lines:
            self._log(line)
        messagebox.showinfo(APP_NAME, "\n".join(lines))

    def _open_workspace(self) -> None:
        try:
            bundle.open_folder(settings_mod.workspace_dir())
        except OSError as error:
            messagebox.showerror(APP_NAME, f"Не удалось открыть папку: {error}")

    def _save_settings(self) -> None:
        try:
            path = settings_mod.save(self.settings)
            self._log(f"настройки сохранены: {path}")
        except OSError as error:
            self._log(f"не удалось сохранить настройки: {error}")

    def _on_close(self) -> None:
        if self.run is not None and self.run.is_running():
            if not messagebox.askyesno(APP_NAME, "Агент ещё работает. Остановить его и выйти?"):
                return
            self.run.stop()
        self.collect()
        self._save_settings()
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


def _float_or_none(text: str) -> float | None:
    value = (text or "").strip().replace(",", ".")
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _int_or_none(text: str) -> int | None:
    value = (text or "").strip()
    if not value:
        return None
    try:
        return int(float(value))
    except ValueError:
        return None


def run_gui() -> int:
    try:
        root = tk.Tk()
    except tk.TclError as error:
        print(f"Не удалось открыть окно: {error}", file=sys.stderr)
        return 1
    try:
        LauncherApp(root)
    except Exception as error:  # noqa: BLE001 — окно не должно падать молча
        print(f"Ошибка запуска интерфейса: {error}", file=sys.stderr)
        raise
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(run_gui())
