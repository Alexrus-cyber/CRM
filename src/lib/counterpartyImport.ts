/**
 * Разбор Excel-файла с контрагентами: столбцы «Наименование», «ИНН», «КПП».
 *
 * Модуль изоморфный (без node-only импортов): используется в браузере для
 * предпросмотра файла и в server action `importCounterpartiesAction` для
 * повторной проверки строк перед записью в БД.
 */

export const IMPORT_COLUMNS = ["Наименование", "ИНН", "КПП"] as const;

export const INN_RE = /^\d{10}$|^\d{12}$/;
export const KPP_RE = /^\d{9}$/;

/** Максимальное число строк в одном файле. */
export const IMPORT_ROW_LIMIT = 5000;

export type ImportColumn = "name" | "inn" | "kpp";

const HEADER_ALIASES: Record<ImportColumn, string[]> = {
  name: [
    "наименование",
    "название",
    "наименование организации",
    "наименование контрагента",
    "наименование клиента",
    "контрагент",
    "организация",
    "клиент",
    "name",
  ],
  inn: ["инн", "инн организации", "инн контрагента", "inn"],
  kpp: ["кпп", "кпп организации", "кпп контрагента", "kpp"],
};

export type ParsedCounterpartyRow = {
  /** Номер строки в файле (1 — заголовок таблицы). */
  line: number;
  name: string;
  inn: string;
  kpp: string;
  /** Текст ошибки; null — строка пригодна к загрузке. */
  error: string | null;
};

export type ParseResult = {
  rows: ParsedCounterpartyRow[];
  /** Столбцы, которых не нашлось в заголовке. */
  missingColumns: string[];
  headerFound: boolean;
};

/** Значение ячейки как текст (числа из Excel не превращаются в «1e+21»). */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : String(value).trim();
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

/** Только цифры — ИНН часто приходит с пробелами, дефисами или «ИНН » в ячейке. */
export function normalizeInn(value: unknown): string {
  return cellToString(value).replace(/\D+/g, "");
}

/**
 * КПП может начинаться с нуля, а Excel хранит числа без ведущих нулей:
 * 010101001 приходит как 10101001 — дополняем до 9 цифр.
 */
export function normalizeKpp(value: unknown): string {
  const digits = cellToString(value).replace(/\D+/g, "");
  if (!digits) return "";
  if (typeof value === "number" && digits.length < 9) return digits.padStart(9, "0");
  return digits;
}

function normalizeHeader(value: unknown): string {
  return cellToString(value)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/g, " ")
    .trim();
}

type ColumnMap = { name: number; inn: number | null; kpp: number | null };

function detectHeaderRow(row: unknown[]): ColumnMap | null {
  const cells = row.map(normalizeHeader);

  const findColumn = (aliases: string[]) => {
    let fuzzy = -1;
    for (let i = 0; i < cells.length; i += 1) {
      const header = cells[i];
      if (!header) continue;
      if (aliases.includes(header)) return i;
      // «ИНН / КПП» в одной колонке не подходит ни туда, ни туда.
      if (fuzzy === -1 && !(header.includes("инн") && header.includes("кпп"))) {
        if (aliases.some((alias) => header.startsWith(`${alias} `) || header.endsWith(` ${alias}`))) {
          fuzzy = i;
        }
      }
    }
    return fuzzy;
  };

  const name = findColumn(HEADER_ALIASES.name);
  if (name === -1) return null;
  const inn = findColumn(HEADER_ALIASES.inn);
  const kpp = findColumn(HEADER_ALIASES.kpp);
  return {
    name,
    inn: inn === -1 || inn === name ? null : inn,
    kpp: kpp === -1 || kpp === name ? null : kpp,
  };
}

/** Строки листа (как их отдаёт `sheet_to_json(..., { header: 1 })`) → проверенные записи. */
export function parseCounterpartyMatrix(matrix: unknown[][]): ParseResult {
  let headerRow = -1;
  let map: ColumnMap | null = null;

  // Заголовок может быть не первой строкой: над таблицей часто есть шапка отчёта.
  for (let i = 0; i < Math.min(matrix.length, 10); i += 1) {
    const detected = detectHeaderRow(matrix[i] ?? []);
    if (detected) {
      headerRow = i;
      map = detected;
      break;
    }
  }

  if (!map) {
    return { rows: [], missingColumns: [...IMPORT_COLUMNS], headerFound: false };
  }

  const missing = [
    map.inn === null ? "ИНН" : null,
    map.kpp === null ? "КПП" : null,
  ].filter((value): value is string => Boolean(value));

  const rows: ParsedCounterpartyRow[] = [];
  for (let i = headerRow + 1; i < matrix.length; i += 1) {
    const raw = matrix[i] ?? [];
    const name = cellToString(raw[map.name]).replace(/\s+/g, " ").trim();
    const inn = normalizeInn(map.inn === null ? "" : raw[map.inn]);
    const kpp = normalizeKpp(map.kpp === null ? "" : raw[map.kpp]);
    if (!name && !inn && !kpp) continue;

    const problems: string[] = [];
    if (!name) problems.push("не заполнено наименование");
    if (inn && !INN_RE.test(inn)) problems.push("ИНН должен содержать 10 или 12 цифр");
    if (kpp && !KPP_RE.test(kpp)) problems.push("КПП должен содержать 9 цифр");

    rows.push({
      line: i + 1,
      name,
      inn,
      kpp,
      error: problems.length > 0 ? problems.join("; ") : null,
    });
  }

  return { rows, missingColumns: missing, headerFound: true };
}

/** Простой RFC-4180 CSV-парсер (поддерживает запятую и точку с запятой, кавычки и BOM). */
export function parseCsvMatrix(text: string): unknown[][] {
  const clean = text.replace(/^\uFEFF/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const delimiter =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"' && clean[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && clean[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
    } else if (ch === "\n" || ch === "\r") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Содержимое шаблона, который скачивает пользователь. */
export const IMPORT_TEMPLATE_ROWS = [
  { Наименование: "ООО «Ромашка»", ИНН: "7707083893", КПП: "773601001" },
  { Наименование: "ИП Иванов Иван Иванович", ИНН: "770708389312", КПП: "" },
];
