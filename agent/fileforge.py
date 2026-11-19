#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Генератор файлов для агентов CRM — только стандартная библиотека.

Агент просит «сделай файл», модель отдаёт имя и содержимое, а этот модуль
собирает настоящий файл нужного типа: текстовые форматы пишутся как есть,
DOCX и XLSX собираются как OOXML-архивы (обычный zip с XML внутри), ZIP — из
нескольких вложенных файлов.

    from fileforge import build
    data, mime, name = build("план.docx", "# План\n- звонки\n- письма")

Поддерживаемые типы: txt, md, csv, tsv, json, html, svg, xml, yaml, sql, py,
js, ts, sh, ini, docx, xlsx, zip.
"""

from __future__ import annotations

import csv
import io
import json
import re
import zipfile
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple
from xml.sax.saxutils import escape

TEXT_EXTENSIONS = {
    "txt", "text", "md", "markdown", "csv", "tsv", "json", "jsonl", "html", "htm",
    "svg", "xml", "yaml", "yml", "sql", "py", "js", "ts", "tsx", "jsx", "sh",
    "ini", "conf", "log", "toml", "css", "env", "bat", "ps1",
}

MIME = {
    "txt": "text/plain; charset=utf-8",
    "md": "text/markdown; charset=utf-8",
    "csv": "text/csv; charset=utf-8",
    "tsv": "text/tab-separated-values; charset=utf-8",
    "json": "application/json; charset=utf-8",
    "html": "text/html; charset=utf-8",
    "htm": "text/html; charset=utf-8",
    "svg": "image/svg+xml",
    "xml": "application/xml; charset=utf-8",
    "yaml": "text/yaml; charset=utf-8",
    "yml": "text/yaml; charset=utf-8",
    "sql": "application/sql; charset=utf-8",
    "py": "text/x-python; charset=utf-8",
    "js": "text/javascript; charset=utf-8",
    "ts": "text/typescript; charset=utf-8",
    "sh": "application/x-sh; charset=utf-8",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "zip": "application/zip",
}

MAX_BYTES = 3_000_000
ZIP_STAMP = (2024, 1, 1, 0, 0, 0)


class FileForgeError(ValueError):
    """Ошибка генерации файла — текст можно показать пользователю."""


def supported() -> List[str]:
    return sorted({"txt", "md", "csv", "tsv", "json", "html", "svg", "xml", "yaml",
                   "sql", "docx", "xlsx", "zip"})


def format_of(name: str, fmt: str | None = None) -> str:
    if fmt:
        return fmt.lower().lstrip(".")
    match = re.search(r"\.([A-Za-z0-9]{1,5})$", name or "")
    return match.group(1).lower() if match else "txt"


def ensure_name(name: str, fmt: str) -> str:
    clean = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", " ", str(name or "")).strip()
    clean = re.sub(r"\s+", " ", clean) or "файл"
    if not re.search(r"\.[A-Za-z0-9]{1,5}$", clean):
        clean = f"{clean}.{fmt}"
    return clean[:120]


# --------------------------------------------------------------------------
# Текстовые форматы
# --------------------------------------------------------------------------


def _text(name: str, content: str, fmt: str) -> bytes:
    if fmt in ("html", "htm") and not content.lstrip().lower().startswith(("<!doctype", "<html")):
        content = (
            "<!doctype html>\n<html lang=\"ru\"><head><meta charset=\"utf-8\">"
            f"<title>{escape(name)}</title>"
            "<style>body{font:16px/1.6 system-ui,sans-serif;max-width:820px;margin:40px auto;"
            "padding:0 16px;color:#111}pre{white-space:pre-wrap;background:#f4f4f7;padding:16px;"
            "border-radius:12px}h1,h2,h3{line-height:1.25}</style></head><body>\n"
            f"<pre>{escape(content)}</pre>\n</body></html>"
        )
    if fmt == "svg" and "<svg" not in content:
        lines = content.splitlines() or [""]
        height = 40 + len(lines) * 22
        spans = "".join(
            f'<text x="24" y="{40 + index * 22}" font-family="monospace" font-size="14" '
            f'fill="#111">{escape(line)}</text>'
            for index, line in enumerate(lines)
        )
        width = max(320, min(1400, 40 + max((len(line) for line in lines), default=10) * 9))
        content = (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
            f'viewBox="0 0 {width} {height}"><rect width="100%" height="100%" fill="#ffffff"/>'
            f"{spans}</svg>"
        )
    if fmt == "json":
        try:
            json.loads(content)
        except json.JSONDecodeError:
            content = json.dumps({"text": content}, ensure_ascii=False, indent=2)
    return content.encode("utf-8")


# --------------------------------------------------------------------------
# DOCX
# --------------------------------------------------------------------------


def _docx_paragraph(line: str) -> str:
    text = line.rstrip()
    heading = 0
    while heading < 3 and text.startswith("#" * (heading + 1) + " "):
        heading += 1
    bullet = False
    if not heading and re.match(r"^\s*[-*•]\s+", text):
        bullet = True
        text = re.sub(r"^\s*[-*•]\s+", "", text)
    elif not heading and re.match(r"^\s*\d+[.)]\s+", text):
        bullet = True
        text = re.sub(r"^\s*(\d+)[.)]\s+", lambda m: f"{m.group(1)}. ", text)

    if heading:
        text = text[heading + 1:]
        size = {1: 36, 2: 30, 3: 26}[heading]
        bold = "<w:b/>"
        spacing = '<w:spacing w:before="240" w:after="120"/>'
    elif bullet:
        size, bold = 22, ""
        spacing = '<w:ind w:left="360" w:hanging="180"/><w:spacing w:after="60"/>'
        text = "• " + text
    else:
        size, bold = 22, ""
        spacing = '<w:spacing w:after="120"/>'

    if not text.strip():
        return '<w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>'

    run = (f'<w:r><w:rPr>{bold}<w:sz w:val="{size}"/><w:szCs w:val="{size}"/></w:rPr>'
           f'<w:t xml:space="preserve">{escape(text)}</w:t></w:r>')
    return f"<w:p><w:pPr>{spacing}</w:pPr>{run}</w:p>"


def _docx(content: str) -> bytes:
    paragraphs = "".join(_docx_paragraph(line) for line in (content.splitlines() or [""]))
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{paragraphs}"
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>'
        "</w:body></w:document>"
    )
    styles = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:docDefaults><w:rPrDefault><w:rPr>"
        '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>'
        '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="ru-RU"/>'
        "</w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults></w:styles>"
    )
    return _zip_bytes({
        "[Content_Types].xml": _content_types_docx(),
        "_rels/.rels": _root_rels("word/document.xml"),
        "word/document.xml": document,
        "word/styles.xml": styles,
    })


def _content_types_docx() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-'
        'officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-'
        'officedocument.wordprocessingml.styles+xml"/>'
        "</Types>"
    )


def _root_rels(target: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
        f'relationships/officeDocument" Target="{target}"/>'
        "</Relationships>"
    )


# --------------------------------------------------------------------------
# XLSX
# --------------------------------------------------------------------------


def _rows_from_content(content: str) -> List[List[Any]]:
    text = (content or "").strip()
    if not text:
        return [[""]]
    if text[0] in "[{":
        try:
            data = json.loads(text)
            if isinstance(data, list) and data and isinstance(data[0], dict):
                headers = list(data[0].keys())
                return [headers] + [[row.get(key, "") for key in headers] for row in data]
            if isinstance(data, list):
                return [(row if isinstance(row, list) else [row]) for row in data]
        except json.JSONDecodeError:
            pass
    sample = text[:1000]
    delimiter = ";" if sample.count(";") >= sample.count(",") else ","
    if "\t" in sample and sample.count("\t") > sample.count(delimiter):
        delimiter = "\t"
    return [row for row in csv.reader(io.StringIO(text), delimiter=delimiter)]


def _column(index: int) -> str:
    name = ""
    index += 1
    while index > 0:
        index, rem = divmod(index - 1, 26)
        name = chr(65 + rem) + name
    return name


def _sheet_cell(row_index: int, col_index: int, value: Any) -> str:
    ref = f"{_column(col_index)}{row_index}"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{ref}"><v>{value}</v></c>'
    text = "" if value is None else str(value)
    if text == "":
        return ""
    return (
        f'<c r="{ref}" t="inlineStr"><is>'
        f'<t xml:space="preserve">{escape(text)}</t></is></c>'
    )


def _xlsx(content: str, sheet_name: str = "Лист1") -> bytes:
    rows = _rows_from_content(content)
    body = []
    for row_index, row in enumerate(rows, start=1):
        cells = "".join(
            _sheet_cell(row_index, col_index, value) for col_index, value in enumerate(row)
        )
        body.append(f'<row r="{row_index}">{cells}</row>')
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<sheetViews><sheetView workbookViewId="0">'
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        "</sheetView></sheetViews>"
        f"<sheetData>{''.join(body)}</sheetData></worksheet>"
    )
    safe_sheet = re.sub(r"[\\/*?:\[\]]", " ", sheet_name or "Лист1")[:31] or "Лист1"
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheets><sheet name="{escape(safe_sheet)}" sheetId="1" r:id="rId1"/></sheets>'
        "</workbook>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
        'relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
        'relationships/styles" Target="styles.xml"/>'
        "</Relationships>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-'
        'officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-'
        'officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-'
        'officedocument.spreadsheetml.styles+xml"/>'
        "</Types>"
    )
    styles = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
        '<borders count="1"><border/></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
        "</styleSheet>"
    )
    return _zip_bytes({
        "[Content_Types].xml": content_types,
        "_rels/.rels": _root_rels("xl/workbook.xml"),
        "xl/workbook.xml": workbook,
        "xl/_rels/workbook.xml.rels": rels,
        "xl/worksheets/sheet1.xml": sheet,
        "xl/styles.xml": styles,
    })


# --------------------------------------------------------------------------
# ZIP и сборка
# --------------------------------------------------------------------------


def _zip_bytes(files: Dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            info = zipfile.ZipInfo(name, ZIP_STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content.encode("utf-8"))
    return buffer.getvalue()


def _zip(content: str) -> bytes:
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as error:
        raise FileForgeError(
            "Для .zip содержимое должно быть JSON: {\"files\": [{\"name\": \"a.txt\", \"content\": \"...\"}]}"
        ) from error
    items = payload.get("files") if isinstance(payload, dict) else payload
    if not isinstance(items, list) or not items:
        raise FileForgeError("В ZIP нечего складывать: нужен список files")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for item in items[:50]:
            if not isinstance(item, dict):
                continue
            name = re.sub(r"[\\/]+", "/", str(item.get("name") or "файл.txt")).lstrip("/")
            data = item.get("content", "")
            info = zipfile.ZipInfo(name, ZIP_STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, str(data).encode("utf-8"))
    return buffer.getvalue()


def build(name: str, content: str, fmt: str | None = None) -> Tuple[bytes, str, str]:
    """Собрать файл. Возвращает (данные, MIME, итоговое имя)."""
    kind = format_of(name, fmt)
    if kind in ("doc", "word"):
        kind = "docx"
    if kind in ("xls", "excel", "sheet"):
        kind = "xlsx"
    final_name = ensure_name(name, kind)
    content = "" if content is None else str(content)

    if kind == "docx":
        data = _docx(content)
    elif kind == "xlsx":
        sheet_name = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", final_name) or "Лист1"
        data = _xlsx(content, sheet_name)
    elif kind == "zip":
        data = _zip(content)
    elif kind in TEXT_EXTENSIONS:
        data = _text(final_name, content, kind)
    else:
        kind = "txt"
        final_name = ensure_name(name, kind)
        data = content.encode("utf-8")

    if len(data) > MAX_BYTES:
        raise FileForgeError(f"Файл получился больше {MAX_BYTES // 1_000_000} МБ — сократите содержимое")

    mime = MIME.get(kind, "application/octet-stream")
    return data, mime, final_name


def stamp() -> str:
    """Метка времени для имён файлов по умолчанию."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")
