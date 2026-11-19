# -*- coding: utf-8 -*-
"""Запуск агента отдельным процессом и чтение его вывода.

GUI только показывает строки, вся работа с процессами — здесь. Модуль не
зависит от tkinter, поэтому его можно проверять в self-test и переиспользовать
в консольном режиме.
"""

from __future__ import annotations

import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Mapping, Sequence

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


def build_env(extra: Mapping[str, str] | None = None) -> Dict[str, str]:
    """Окружение агента: UTF-8, без буферизации, плюс переданные переменные."""
    env = dict(os.environ)
    env.update({
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUNBUFFERED": "1",
        "PYTHONUTF8": "1",
    })
    if extra:
        env.update({str(key): str(value) for key, value in extra.items()})
    return env


@dataclass
class AgentRun:
    """Один запуск агента."""

    agent_id: str
    command: Sequence[str]
    cwd: Path
    env: Mapping[str, str]
    started_at: float = field(default_factory=time.time)
    process: subprocess.Popen | None = None
    lines: List[str] = field(default_factory=list)
    _queue: "queue.Queue[str | None]" = field(default_factory=queue.Queue)

    # ---- управление -----------------------------------------------------
    def start(self) -> None:
        creationflags = 0
        if sys.platform.startswith("win"):
            # Не показывать консольное окно у дочернего процесса.
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self.process = subprocess.Popen(
            list(self.command),
            cwd=str(self.cwd),
            env=dict(self.env),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creationflags,
        )
        threading.Thread(target=self._pump, name=f"agent-{self.agent_id}", daemon=True).start()

    def _pump(self) -> None:
        """Читает вывод построчно и складывает в очередь для интерфейса."""
        process = self.process
        if process is None or process.stdout is None:
            self._queue.put(None)
            return
        try:
            for raw in process.stdout:
                line = strip_ansi(raw.rstrip("\r\n"))
                self.lines.append(line)
                self._queue.put(line)
        except (OSError, ValueError):
            pass
        finally:
            code = process.wait()
            self.lines.append(f"— агент завершился с кодом {code} —")
            self._queue.put(f"— агент завершился с кодом {code} —")
            self._queue.put(None)

    def poll_lines(self, limit: int = 500) -> List[str]:
        """Забрать накопленные строки, не блокируя интерфейс."""
        result: List[str] = []
        for _ in range(limit):
            try:
                item = self._queue.get_nowait()
            except queue.Empty:
                break
            if item is None:
                break
            result.append(item)
        return result

    def is_running(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def stop(self, timeout: float = 5.0) -> None:
        process = self.process
        if process is None or process.poll() is not None:
            return
        try:
            if sys.platform.startswith("win"):
                process.terminate()
            else:
                process.send_signal(signal.SIGINT)  # агенты корректно ловят Ctrl+C
        except OSError:
            return
        try:
            process.wait(timeout=timeout)
            return
        except subprocess.TimeoutExpired:
            pass
        try:
            process.kill()
        except OSError:
            pass

    def pid(self) -> int | None:
        return self.process.pid if self.process else None

    def uptime_text(self) -> str:
        seconds = max(0, int(time.time() - self.started_at))
        hours, rest = divmod(seconds, 3600)
        minutes, seconds = divmod(rest, 60)
        if hours:
            return f"{hours} ч {minutes:02d} мин"
        if minutes:
            return f"{minutes} мин {seconds:02d} с"
        return f"{seconds} с"


def run_to_completion(command: Sequence[str], timeout: float = 30, cwd: Path | None = None,
                      env: Mapping[str, str] | None = None) -> tuple[int, List[str]]:
    """Синхронный запуск — для проверок и «тестового прогона» без GUI."""
    process = subprocess.run(
        list(command),
        cwd=str(cwd) if cwd else None,
        env=build_env(env),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    output = strip_ansi((process.stdout or "") + (process.stderr or ""))
    return process.returncode, output.splitlines()
