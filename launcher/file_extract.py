# -*- coding: utf-8 -*-
"""Локальный разбор файлов и картинок для вложений в Чат, Агент и Планировщик.

Работает на стандартной библиотеке Python (+ Pillow при наличии для сжатия
больших изображений). Поддерживает текст, код, JSON/CSV, DOCX/XLSX/PPTX/ODT
и изображения (PNG, JPEG, WEBP, GIF, BMP).
"""

from __future__ import annotations

import base64
import io
import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any, Dict

TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".log",
    ".yml", ".yaml", ".xml", ".html", ".htm", ".css", ".scss", ".js", ".jsx",
    ".ts", ".tsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".java", ".kt",
    ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh", ".bash", ".ps1",
    ".sql", ".ini", ".conf", ".env", ".toml", ".rs", ".vue", ".svelte",
}

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}

MAX_TEXT_EXTRACT = 240_000
MAX_IMAGE_SIDE = 1600


def _clean_text(text: str, limit: int = MAX_TEXT_EXTRACT) -> tuple[str, bool]:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(normalized) > limit:
        return normalized[:limit], True
    return normalized, False


def _decode_bytes(raw: bytes) -> str:
    if not raw:
        return ""
    for enc in ("utf-8-sig", "utf-8", "cp1251", "latin-1"):
        try:
            text = raw.decode(enc)
            if "\x00" in text[:4096]:
                return ""
            return text
        except UnicodeDecodeError:
            continue
    return ""


def _extract_xml_text(xml_bytes: bytes) -> str:
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return ""
    parts: list[str] = []
    for elem in root.iter():
        tag = elem.tag.split("}")[-1].lower()
        if elem.text and elem.text.strip():
            parts.append(elem.text.strip())
        if tag in ("p", "tr", "br", "cr") and parts and parts[-1] != "\n":
            parts.append("\n")
    joined = " ".join(parts).replace(" \n ", "\n").replace(" \n", "\n")
    return re.sub(r"\n{3,}", "\n\n", joined).strip()


def _extract_docx(raw: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        chunks: list[str] = []
        for name in sorted(zf.namelist()):
            if name in ("word/document.xml",) or name.startswith(("word/header", "word/footer")):
                if name.endswith(".xml"):
                    txt = _extract_xml_text(zf.read(name))
                    if txt:
                        chunks.append(txt)
        return "\n\n".join(chunks)


def _extract_xlsx(raw: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            try:
                sroot = ET.fromstring(zf.read("xl/sharedStrings.xml"))
                for si in sroot.iter():
                    if si.tag.split("}")[-1] == "si":
                        txt = "".join(t.text or "" for t in si.iter() if t.tag.split("}")[-1] == "t")
                        shared.append(txt)
            except ET.ParseError:
                pass
        sheets = sorted(n for n in zf.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml"))
        out: list[str] = []
        for sheet_name in sheets[:15]:
            try:
                root = ET.fromstring(zf.read(sheet_name))
            except ET.ParseError:
                continue
            rows_text: list[str] = []
            for row in root.iter():
                if row.tag.split("}")[-1] != "row":
                    continue
                vals: list[str] = []
                for cell in row:
                    if cell.tag.split("}")[-1] != "c":
                        continue
                    ctype = cell.attrib.get("t", "")
                    val_txt = ""
                    for ch in cell:
                        local = ch.tag.split("}")[-1]
                        if local == "v" and ch.text is not None:
                            if ctype == "s":
                                try:
                                    idx = int(ch.text)
                                    val_txt = shared[idx] if 0 <= idx < len(shared) else ch.text
                                except ValueError:
                                    val_txt = ch.text
                            else:
                                val_txt = ch.text
                        elif local == "is":
                            val_txt = "".join(t.text or "" for t in ch.iter() if t.tag.split("}")[-1] == "t")
                    if val_txt:
                        vals.append(val_txt)
                if vals:
                    rows_text.append("\t".join(vals))
            if rows_text:
                out.append(f"[{Path(sheet_name).name}]\n" + "\n".join(rows_text))
        return "\n\n".join(out)


def _extract_pptx(raw: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        slides = sorted(
            (n for n in zf.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")),
            key=lambda p: (len(p), p),
        )
        out: list[str] = []
        for idx, name in enumerate(slides[:60], 1):
            txt = _extract_xml_text(zf.read(name))
            if txt:
                out.append(f"Слайд {idx}:\n{txt}")
        return "\n\n".join(out)


def _extract_odt(raw: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        if "content.xml" in zf.namelist():
            return _extract_xml_text(zf.read("content.xml"))
    return ""


def _image_to_data_url(raw: bytes, ext: str, mime: str) -> str:
    mime_clean = mime if mime.startswith("image/") else f"image/{'jpeg' if ext in ('.jpg', '.jpeg') else ext.lstrip('.') or 'png'}"
    try:
        from PIL import Image  # type: ignore

        with Image.open(io.BytesIO(raw)) as img:
            w, h = img.size
            if max(w, h) > MAX_IMAGE_SIDE:
                scale = MAX_IMAGE_SIDE / float(max(w, h))
                img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
                img.save(buf, format="PNG", optimize=True)
                out_mime = "image/png"
            else:
                if img.mode != "RGB":
                    img = img.convert("RGB")
                img.save(buf, format="JPEG", quality=86, optimize=True)
                out_mime = "image/jpeg"
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            return f"data:{out_mime};base64,{b64}"
    except Exception:
        b64 = base64.b64encode(raw).decode("ascii")
        return f"data:{mime_clean};base64,{b64}"


def extract_attachment(name: str, raw: bytes, mime: str = "") -> Dict[str, Any]:
    """Разбирает файл в структуру, совместимую с Чатом и Агентом CRM."""
    clean_name = Path(name or "файл").name
    ext = Path(clean_name).suffix.lower()
    lower_mime = (mime or "").lower()
    size = len(raw)

    if lower_mime.startswith("image/") or ext in IMAGE_EXTS:
        data_url = _image_to_data_url(raw, ext, lower_mime)
        return {
            "name": clean_name,
            "mime": lower_mime or "image/png",
            "size": size,
            "kind": "image",
            "text": "",
            "preview": data_url,
            "note": "Изображение",
            "truncated": False,
        }

    if ext == ".docx":
        try:
            text, truncated = _clean_text(_extract_docx(raw))
            if text:
                return {"name": clean_name, "mime": mime, "size": size, "kind": "text", "text": text, "preview": None, "note": "DOCX", "truncated": truncated}
        except Exception as exc:
            return {"name": clean_name, "mime": mime, "size": size, "kind": "unreadable", "text": "", "preview": None, "note": f"DOCX ошибка: {exc}", "truncated": False}

    if ext == ".xlsx":
        try:
            text, truncated = _clean_text(_extract_xlsx(raw))
            if text:
                return {"name": clean_name, "mime": mime, "size": size, "kind": "text", "text": text, "preview": None, "note": "XLSX", "truncated": truncated}
        except Exception as exc:
            return {"name": clean_name, "mime": mime, "size": size, "kind": "unreadable", "text": "", "preview": None, "note": f"XLSX ошибка: {exc}", "truncated": False}

    if ext == ".pptx":
        try:
            text, truncated = _clean_text(_extract_pptx(raw))
            if text:
                return {"name": clean_name, "mime": mime, "size": size, "kind": "text", "text": text, "preview": None, "note": "PPTX", "truncated": truncated}
        except Exception as exc:
            return {"name": clean_name, "mime": mime, "size": size, "kind": "unreadable", "text": "", "preview": None, "note": f"PPTX ошибка: {exc}", "truncated": False}

    if ext == ".odt":
        try:
            text, truncated = _clean_text(_extract_odt(raw))
            if text:
                return {"name": clean_name, "mime": mime, "size": size, "kind": "text", "text": text, "preview": None, "note": "ODT", "truncated": truncated}
        except Exception as exc:
            return {"name": clean_name, "mime": mime, "size": size, "kind": "unreadable", "text": "", "preview": None, "note": f"ODT ошибка: {exc}", "truncated": False}

    if ext in TEXT_EXTS or lower_mime.startswith("text/") or "json" in lower_mime or "xml" in lower_mime:
        decoded = _decode_bytes(raw)
        if decoded:
            text, truncated = _clean_text(decoded)
            return {"name": clean_name, "mime": mime, "size": size, "kind": "text", "text": text, "preview": None, "note": ext.lstrip(".").upper() or "TXT", "truncated": truncated}

    # Эвристика для текстовых файлов без известного расширения
    decoded = _decode_bytes(raw[:512_000])
    if decoded and sum(1 for ch in decoded[:2048] if ord(ch) < 32 and ch not in "\n\r\t") < 12:
        text, truncated = _clean_text(_decode_bytes(raw))
        return {"name": clean_name, "mime": mime, "size": size, "kind": "text", "text": text, "preview": None, "note": "Текст", "truncated": truncated}

    return {
        "name": clean_name,
        "mime": mime or "application/octet-stream",
        "size": size,
        "kind": "unreadable",
        "text": "",
        "preview": None,
        "note": "Бинарный файл (содержимое не извлечено)",
        "truncated": False,
    }
