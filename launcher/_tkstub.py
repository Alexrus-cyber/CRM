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


_CLIPBOARD: List[str] = [""]


class Widget:
    def __init__(self, master: Any = None, **kwargs: Any) -> None:
        self.master = master
        self.options = dict(kwargs)
        self.children: List["Widget"] = []
        self.items: List[str] = []
        self.selected: tuple[int, ...] = ()
        self.bindings: Dict[str, Any] = {}
        self.focused = False
        if master is not None and hasattr(master, "children"):
            master.children.append(self)

    # всё, что GUI вызывает «в одну строку», здесь просто ничего не делает
    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        return lambda *args, **kwargs: None

    def configure(self, **kwargs: Any) -> None:
        self.options.update(kwargs)

    config = configure

    def cget(self, key: str) -> Any:
        return self.options.get(key, "normal" if key == "state" else "")

    def instate(self, statespec: Any) -> bool:
        state = str(self.options.get("state", "normal"))
        return state in statespec

    def focus_set(self) -> None:
        self.focused = True

    def clipboard_clear(self) -> None:
        _CLIPBOARD[0] = ""

    def clipboard_append(self, text: str) -> None:
        _CLIPBOARD[0] += str(text)

    def clipboard_get(self) -> str:
        return _CLIPBOARD[0]

    def destroy(self) -> None:
        parent = getattr(self.master, "children", None)
        if parent is not None and self in parent:
            parent.remove(self)

    def winfo_children(self) -> List["Widget"]:
        return list(self.children)

    def bind(self, sequence: str, func: Any = None, add: Any = None) -> str:
        self.bindings[sequence] = func
        return "bind-1"

    def insert(self, index: Any, text: str) -> None:
        self.items.append(str(text))

    def delete(self, *args: Any) -> None:
        self.items.clear()

    def curselection(self) -> tuple[int, ...]:
        return self.selected

    def selection_set(self, index: int) -> None:
        self.selected = (index,)

    def index(self, spec: str) -> Any:
        return f"{len(self.items) + 1}.0"


class Entry(Widget):
    def __init__(self, master: Any = None, textvariable: Variable | None = None, **kwargs: Any) -> None:
        super().__init__(master, **kwargs)
        self._var = textvariable
        self._text = "" if textvariable is None else str(textvariable.get() or "")
        self._sel: tuple[int, int] | None = None
        self._cursor = len(self._text)

    def _read(self) -> str:
        return str(self._var.get() or "") if self._var is not None else self._text

    def _write(self, value: str) -> None:
        self._text = value
        if self._var is not None:
            self._var.set(value)

    def get(self) -> str:
        return self._read()

    def selection_present(self) -> bool:
        return self._sel is not None and self._sel[0] < self._sel[1]

    def selection_range(self, start: Any, end: Any) -> None:
        text = self._read()
        s = 0 if start == 0 else int(start)
        e = len(text) if end == "end" else int(end)
        self._sel = (s, e) if s < e else None

    def icursor(self, pos: Any) -> None:
        self._cursor = len(self._read()) if pos == "end" else int(pos)

    def index(self, spec: str) -> int:
        if spec == "sel.first" and self._sel is not None:
            return self._sel[0]
        if spec == "sel.last" and self._sel is not None:
            return self._sel[1]
        if spec == "insert":
            return self._cursor
        if spec == "end":
            return len(self._read())
        return int(spec)

    def insert(self, index: Any, text: str) -> None:
        current = self._read()
        pos = self.index(str(index))
        updated = current[:pos] + str(text) + current[pos:]
        self._write(updated)
        self._cursor = pos + len(str(text))

    def delete(self, first: Any, last: Any = None) -> None:
        current = self._read()
        start = self.index(str(first))
        end = start + 1 if last is None else self.index(str(last))
        self._write(current[:start] + current[end:])
        self._sel = None
        self._cursor = start


class Text(Widget):
    def __init__(self, master: Any = None, **kwargs: Any) -> None:
        super().__init__(master, **kwargs)
        self.content = ""
        self._sel: tuple[int, int] | None = None

    def insert(self, index: Any, text: str) -> None:
        self.content += str(text)

    def delete(self, *args: Any) -> None:
        self.content = ""
        self._sel = None

    def get(self, *args: Any) -> str:
        if len(args) == 2 and args[0] == "sel.first" and args[1] == "sel.last" and self._sel is not None:
            return self.content[self._sel[0]:self._sel[1]]
        return self.content

    def tag_ranges(self, tag: str) -> tuple[str, ...]:
        if tag == "sel" and self._sel is not None:
            return ("1.0", "end-1c")
        return ()

    def tag_add(self, tag: str, start: str, end: str) -> None:
        if tag == "sel" and self.content:
            length = len(self.content) - (1 if end == "end-1c" and self.content.endswith("\n") else 0)
            self._sel = (0, max(0, length))

    def mark_set(self, mark: str, pos: str) -> None:
        return None

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
    ttk.Entry = Entry
    ttk.Combobox = Entry
    ttk.Checkbutton = Widget
    ttk.Scrollbar = Widget
    ttk.Button = Widget
    ttk.Style = Widget
    ttk.Separator = Widget

    messagebox = _FakeModule("tkinter.messagebox")
    messagebox.askyesno = lambda *a, **k: calls["messagebox"].append(("askyesno", a)) or True
    messagebox.showinfo = lambda *a, **k: calls["messagebox"].append(("showinfo", a)) or None
    messagebox.showwarning = lambda *a, **k: calls["messagebox"].append(("showwarning", a)) or None
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
