/**
 * Извлечение текста из файлов для блока «Чат с ИИ».
 *
 * Локальные OpenAI-совместимые модели едят только текст и картинки, поэтому
 * любые файлы (до 20 МБ) сначала превращаются в текст прямо в браузере:
 *
 * * текст/код/CSV/JSON/HTML — как есть;
 * * docx / xlsx / pptx / odt / ods / odp — распаковка ZIP и вычитка XML;
 * * pdf — попытка достать текстовые операторы из потоков (FlateDecode);
 * * rtf — снятие управляющих последовательностей;
 * * всё остальное — метка «содержимое не читается» + имя и размер, чтобы модель
 *   хотя бы знала о файле.
 *
 * Ничего не уходит на сервер: файл читается локально.
 */

import { isImageMime, isTextFile } from "./ai";

/** Сколько символов текста максимум берём из одного файла. */
export const MAX_EXTRACT_CHARS = 200_000;

export type ExtractedFile = {
  /** image — отправим картинкой, text — текстом, unreadable — только метаданные. */
  kind: "image" | "text" | "unreadable";
  text: string;
  /** Пояснение для интерфейса («docx → 12 400 символов», «бинарный формат»). */
  note: string;
  truncated: boolean;
};

const ZIP_BASED = /\.(docx|xlsx|pptx|odt|ods|odp|epub)$/i;

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/* ------------------------------- ZIP -------------------------------- */

type ZipEntry = { name: string; method: number; compressedSize: number; dataOffset: number };

/** Минимальный читатель ZIP: центральный каталог + локальные заголовки. */
function readZipEntries(buffer: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder("latin1");

  // Ищем End Of Central Directory с конца файла.
  let eocd = -1;
  const stop = Math.max(bytes.length - 66_000, 0);
  for (let offset = bytes.length - 22; offset >= stop; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return [];

  const total = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < total; index += 1) {
    if (pointer + 46 > bytes.length || view.getUint32(pointer, true) !== 0x02014b50) break;
    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const name = decoder.decode(bytes.slice(pointer + 46, pointer + 46 + nameLength));

    if (localOffset + 30 <= bytes.length && view.getUint32(localOffset, true) === 0x04034b50) {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      entries.push({
        name,
        method,
        compressedSize,
        dataOffset: localOffset + 30 + localNameLength + localExtraLength,
      });
    }

    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Blob хочет ArrayBuffer, а не view — копируем срез байтов. */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

async function inflateRaw(data: Uint8Array): Promise<string | null> {
  if (typeof DecompressionStream === "undefined" || data.length === 0) return null;
  try {
    const stream = new Blob([toArrayBuffer(data)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return await new Response(stream).text();
  } catch {
    return null;
  }
}

/** Читает из ZIP только нужные файлы (по префиксу/суффиксу имени). */
async function readZipTexts(buffer: ArrayBuffer, wanted: (name: string) => boolean): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const bytes = new Uint8Array(buffer);
  for (const entry of readZipEntries(buffer)) {
    if (!wanted(entry.name)) continue;
    const slice = bytes.slice(entry.dataOffset, entry.dataOffset + (entry.compressedSize || bytes.length - entry.dataOffset));
    if (entry.method === 0) {
      result.set(entry.name, new TextDecoder("utf-8").decode(slice));
      continue;
    }
    const inflated = await inflateRaw(slice);
    if (inflated) result.set(entry.name, inflated);
  }
  return result;
}

/* ------------------------------ XML/текст --------------------------- */

function xmlToPlainText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/a:p>/g, "\n")
      .replace(/<\/text:p>/g, "\n")
      .replace(/<\/row>/g, "\n")
      .replace(/<\/c>/g, "\t")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripRtf(rtf: string): string {
  return rtf
    .replace(/\\'([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, code: string) => String.fromCharCode(Number(code) < 0 ? Number(code) + 65536 : Number(code)))
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* -------------------------------- PDF ------------------------------- */

function pdfStringsToText(content: string): string {
  const parts: string[] = [];
  // Текстовые операторы: (строка) Tj и [(a) -20 (b)] TJ.
  const operator = /\((?:\\.|[^\\()])*\)\s*(?:Tj|TJ|'|")/g;
  for (const match of content.matchAll(operator)) {
    const raw = match[0];
    const literal = raw.slice(0, raw.lastIndexOf(")") + 1);
    const decoded = literal
      .slice(1, -1)
      .replace(/\\([nrtbf()\\])/g, (_, code: string) => {
        if (code === "n") return "\n";
        if (code === "r") return "\n";
        if (code === "t") return "\t";
        return code;
      })
      .replace(/\\([0-7]{1,3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    if (decoded.trim()) parts.push(decoded);
  }
  return parts.join(" ").replace(/\s{2,}/g, " ").trim();
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === "undefined") return null;
  for (const format of ["deflate", "deflate-raw"] as const) {
    try {
      const stream = new Blob([toArrayBuffer(data)]).stream().pipeThrough(new DecompressionStream(format));
      const buffer = await new Response(stream).arrayBuffer();
      return new Uint8Array(buffer);
    } catch {
      /* пробуем другой формат */
    }
  }
  return null;
}

async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const latin = new TextDecoder("latin1").decode(bytes);
  const collected: string[] = [];

  let cursor = 0;
  let guard = 0;
  while (guard < 800) {
    guard += 1;
    const streamAt = latin.indexOf("stream", cursor);
    if (streamAt < 0) break;
    const endAt = latin.indexOf("endstream", streamAt);
    if (endAt < 0) break;
    let dataStart = streamAt + 6;
    if (latin[dataStart] === "\r") dataStart += 1;
    if (latin[dataStart] === "\n") dataStart += 1;
    const slice = bytes.slice(dataStart, endAt);
    cursor = endAt + 9;

    // Сначала пробуем как есть (бывают незапакованные потоки), потом — inflate.
    const plain = new TextDecoder("latin1").decode(slice);
    if (/Tj|TJ/.test(plain)) {
      collected.push(pdfStringsToText(plain));
      continue;
    }
    const inflated = await inflateZlib(slice);
    if (inflated) {
      const text = new TextDecoder("latin1").decode(inflated);
      if (/Tj|TJ/.test(text)) collected.push(pdfStringsToText(text));
    }
  }

  const joined = collected.join("\n").replace(/[ \t]{2,}/g, " ").trim();
  // Если текста почти нет или он из «кракозябр» (CID-кодировка), честно скажем.
  const letters = (joined.match(/[A-Za-zА-Яа-яЁё]/g) ?? []).length;
  if (joined.length < 40 || letters / Math.max(joined.length, 1) < 0.35) return "";
  return joined;
}

/* ------------------------------ публичное --------------------------- */

const ZIP_TARGETS: Array<{ match: RegExp; files: (name: string) => boolean }> = [
  { match: /\.docx$/i, files: (name) => name === "word/document.xml" || name === "word/footnotes.xml" },
  { match: /\.pptx$/i, files: (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name) },
  {
    match: /\.xlsx$/i,
    files: (name) => name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
  },
  { match: /\.(odt|ods|odp)$/i, files: (name) => name === "content.xml" },
  { match: /\.epub$/i, files: (name) => /\.x?html?$/i.test(name) },
];

function clip(text: string): { text: string; truncated: boolean } {
  const clean = text.replace(/\u0000/g, "").replace(/\r\n/g, "\n").trim();
  if (clean.length <= MAX_EXTRACT_CHARS) return { text: clean, truncated: false };
  return { text: clean.slice(0, MAX_EXTRACT_CHARS), truncated: true };
}

/** Похоже ли содержимое на текст (эвристика для файлов без расширения). */
function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.slice(0, 4000);
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte !== 127)) printable += 1;
  }
  return printable / Math.max(sample.length, 1) > 0.9;
}

export async function extractFile(file: File): Promise<ExtractedFile> {
  const name = file.name || "файл";
  const type = file.type || "";

  if (isImageMime(type)) {
    return { kind: "image", text: "", note: "картинка → модели как изображение", truncated: false };
  }

  try {
    if (ZIP_BASED.test(name)) {
      const targets = ZIP_TARGETS.find((target) => target.match.test(name));
      const buffer = await file.arrayBuffer();
      const texts = await readZipTexts(buffer, targets?.files ?? (() => false));
      const joined = Array.from(texts.entries())
        .map(([entryName, xml]) => {
          // В xlsx общие строки лежат отдельным файлом, а листы ссылаются на них номерами.
          if (/sharedStrings\.xml$/i.test(entryName)) {
            return decodeEntities(
              Array.from(xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g))
                .map((match) => match[1])
                .join("\n"),
            );
          }
          return xmlToPlainText(xml);
        })
        .join("\n\n");
      const clipped = clip(joined);
      if (!clipped.text) {
        return { kind: "unreadable", text: "", note: "не удалось прочитать содержимое архива", truncated: false };
      }
      return { kind: "text", text: clipped.text, note: `${name.split(".").pop()?.toUpperCase() ?? "архив"} → текст`, truncated: clipped.truncated };
    }

    if (/\.pdf$/i.test(name) || type === "application/pdf") {
      const text = await extractPdfText(await file.arrayBuffer());
      if (!text) {
        return {
          kind: "unreadable",
          text: "",
          note: "PDF без извлекаемого текста (скан или CID-шрифты) — отправлены только имя и размер",
          truncated: false,
        };
      }
      const clipped = clip(text);
      return { kind: "text", text: clipped.text, note: "PDF → текст", truncated: clipped.truncated };
    }

    if (/\.rtf$/i.test(name)) {
      const clipped = clip(stripRtf(await file.text()));
      return { kind: "text", text: clipped.text, note: "RTF → текст", truncated: clipped.truncated };
    }

    if (/\.html?$/i.test(name) || type === "text/html") {
      const clipped = clip(xmlToPlainText(await file.text()));
      return { kind: "text", text: clipped.text, note: "HTML → текст", truncated: clipped.truncated };
    }

    if (isTextFile(type, name)) {
      const clipped = clip(await file.text());
      return { kind: "text", text: clipped.text, note: "текст", truncated: clipped.truncated };
    }

    // Неизвестный формат: если байты выглядят текстом — прочитаем, иначе только метаданные.
    const buffer = await file.arrayBuffer();
    if (looksLikeText(new Uint8Array(buffer))) {
      const clipped = clip(new TextDecoder("utf-8", { fatal: false }).decode(buffer));
      return { kind: "text", text: clipped.text, note: "распознано как текст", truncated: clipped.truncated };
    }
    return {
      kind: "unreadable",
      text: "",
      note: "бинарный формат — отправлены только имя и размер",
      truncated: false,
    };
  } catch {
    return { kind: "unreadable", text: "", note: "не удалось прочитать файл", truncated: false };
  }
}

/**
 * Картинка для vision-модели: уменьшаем до 1600 px по длинной стороне и
 * пережимаем в JPEG — так 20-мегабайтный снимок превращается в ~300 КБ и не
 * раздувает запрос.
 */
export async function imageToDataUrl(file: File, maxSide = 1600): Promise<{ dataUrl: string; note: string }> {
  const fallback = async () => ({ dataUrl: await blobToDataUrl(file), note: "оригинал" });
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return fallback();
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return fallback();
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return {
      dataUrl,
      note: scale < 1 ? `сжато до ${width}×${height}` : "сжато в JPEG",
    };
  } catch {
    return fallback();
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.readAsDataURL(blob);
  });
}
