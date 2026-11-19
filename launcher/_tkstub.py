# -*- coding: utf-8 -*-
"""Учебный двойник tkinter для самопроверок без экрана.

Настоящий tkinter требует графической сессии, поэтому GUI проверяется на
заглушке: она повторяет ровно тот набор вызовов, который использует
`launcher/gui.py`. Модуль попадает в `sys.modules` только во время self-test и
никогда не используется в собранном приложении.
"""

from __future__ import annotations

import sys
import types
from typing import Any, Dict, List


class Variable:
    def __init__(self, master: Any = None, value: Any = None, name: str | None = None) -> None:
        self._value = value

    def get(self) -> Any:
        return self._value

    def set(self, value: Any) -> None:
        self._value = value


class Widget:
    def __init__(self, master: Any = None, **kwargs: Any) -> None:
        self.master = master
        self.options = dict(kwargs)
        self.children: List["Widget"] = []
        self.items: List[str] = []
        self.selected: tuple[int, ...] = ()
        if master is not None and hasattr(master, "children"):
            master.children.append(self)

    # всё, что GUI вызывает «в одну строку», здесь просто ничего не делает
    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        return lambda *args, **kwargs: None

    def destroy(self) -> None:
        parent = getattr(self.master, "children", None)
        if parent is not None and self in parent:
            parent.remove(self)

    def winfo_children(self) -> List["Widget"]:
        return list(self.children)

    def insert(self, index: Any, text: str) -> None:
        self.items.append(str(text))

    def delete(self, *args: Any) -> None:
        self.items.clear()

    def curselection(self) -> tuple[int, ...]:
        return self.selected

    def selection_set(self, index: int) -> None:
        self.selected = (index,)

    def index(self, spec: str) -> str:
        return f"{len(self.items) + 1}.0"


class Text(Widget):
    def __init__(self, master: Any = None, **kwargs: Any) -> None:
        super().__init__(master, **kwargs)
        self.content = ""

    def insert(self, index: Any, text: str) -> None:
        self.content += str(text)

    def delete(self, *args: Any) -> None:
        self.content = ""

    def get(self, *args: Any) -> str:
        return self.content

    def index(self, spec: str) -> str:
        return f"{self.content.count(chr(10)) + 1}.0"


class Tk(Widget):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(None, **kwargs)

    def destroy(self) -> None:
        self.destroyed = True

    def mainloop(self, *args: Any) -> None:
        return None

    def after(self, delay: int, callback: Any = None, *args: Any) -> str:
        # Колбэки не выполняем: тест вызывает нужные методы сам.
        return "after-1"

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        return lambda *args, **kwargs: None


class _FakeModule(types.ModuleType):
    pass


def install() -> Dict[str, Any]:
    """Подменить tkinter заглушкой. Возвращает словарь с журналом вызовов."""
    calls: Dict[str, Any] = {"messagebox": [], "filedialog": [], "browser": []}

    tk = _FakeModule("tkinter")
    tk.Tk = Tk
    tk.Frame = Widget
    tk.Label = Widget
    tk.Button = Widget
    tk.Listbox = Widget
    tk.Text = Text
    tk.StringVar = Variable
    tk.BooleanVar = Variable
    tk.TclError = RuntimeError

    ttk = _FakeModule("tkinter.ttk")

    class Notebook(Widget):
        def add(self, child: Any, text: str = "") -> None:
            self.children.append(child)

    ttk.Notebook = Notebook
    ttk.Frame = Widget
    ttk.Label = Widget
    ttk.Entry = Widget
    ttk.Combobox = Widget
    ttk.Checkbutton = Widget
    ttk.Scrollbar = Widget
    ttk.Button = Widget
    ttk.Style = Widget
    ttk.Separator = Widget

    messagebox = _FakeModule("tkinter.messagebox")
    messagebox.askyesno = lambda *a, **k: calls["messagebox"].append(("askyesno", a)) or True
    messagebox.showinfo = lambda *a, **k: calls["messagebox"].append(("showinfo", a)) or None
    messagebox.showerror = lambda *a, **k: calls["messagebox"].append(("showerror", a)) or None

    filedialog = _FakeModule("tkinter.filedialog")
    filedialog.askopenfilename = lambda *a, **k: calls["filedialog"].append("open") or ""
    filedialog.askdirectory = lambda *a, **k: calls["filedialog"].append("dir") or ""

    tk.ttk = ttk
    tk.messagebox = messagebox
    tk.filedialog = filedialog

    sys.modules["tkinter"] = tk
    sys.modules["tkinter.ttk"] = ttk
    sys.modules["tkinter.messagebox"] = messagebox
    sys.modules["tkinter.filedialog"] = filedialog
    return calls
