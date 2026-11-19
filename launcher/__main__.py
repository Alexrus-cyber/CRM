# -*- coding: utf-8 -*-
"""`python -m launcher` — то же, что `python launcher/cli.py`."""

import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from launcher.cli import main

raise SystemExit(main())
