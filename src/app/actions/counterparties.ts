"use server";

import { revalidatePath } from "next/cache";
import {
  deleteCounterparty,
  findCounterpartiesByInns,
  insertCounterpartiesBulk,
  insertCounterparty,
  updateCounterparty,
  updateCounterpartyFromImport,
  type CounterpartyValues,
} from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import {
  INN_RE,
  KPP_RE,
  IMPORT_ROW_LIMIT,
  normalizeInn,
  normalizeKpp,
} from "@/lib/counterpartyImport";
import { isAdminRole } from "@/lib/utils";
import type { ActionResult } from "./users";

export type CounterpartyInput = {
  id?: number;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  inn?: string;
  kpp?: string;
  notes?: string;
};

function clean(v?: string) {
  const s = v?.trim();
  return s ? s : null;
}

export async function saveCounterpartyAction(input: CounterpartyInput): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me || !isAdminRole(me.role)) {
    return { ok: false, error: "Создавать и редактировать контрагентов могут только администраторы" };
  }
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Название / Имя обязательно" };
  const inn = clean(input.inn);
  if (inn && !/^\d{10}$|^\d{12}$/.test(inn)) return { ok: false, error: "ИНН должен содержать 10 или 12 цифр" };
  const kpp = clean(input.kpp);
  if (kpp && !/^\d{9}$/.test(kpp)) return { ok: false, error: "КПП должен содержать 9 цифр" };
  const email = clean(input.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Некорректный email" };

  const values: CounterpartyValues = {
    name,
    phone: clean(input.phone),
    email,
    address: clean(input.address),
    inn,
    kpp,
    notes: clean(input.notes),
  };

  if (input.id) {
    await updateCounterparty(input.id, values);
    revalidatePath("/", "layout");
    return { ok: true, id: input.id };
  }
  const id = await insertCounterparty(values, me.id);
  revalidatePath("/", "layout");
  return { ok: true, id };
}

export async function deleteCounterpartyAction(id: number): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me || !isAdminRole(me.role)) return { ok: false, error: "Нет прав" };
  await deleteCounterparty(id);
  revalidatePath("/", "layout");
  return { ok: true };
}

/* ------------------------- импорт из Excel ------------------------- */

export type CounterpartyImportRowInput = {
  name: string;
  inn?: string;
  kpp?: string;
  /** Номер строки в файле — только для понятных сообщений об ошибках. */
  line?: number;
};

export type CounterpartyImportResult =
  | { ok: true; inserted: number; updated: number; skipped: number; warnings: string[] }
  | { ok: false; error: string };

/**
 * Загрузка контрагентов из Excel-файла (столбцы «Наименование», «ИНН», «КПП»).
 *
 * Правила:
 *   • наименование обязательно, ИНН — 10/12 цифр, КПП — 9 цифр (если указаны);
 *   • повторы ИНН внутри файла и уже существующие ИНН пропускаются,
 *     а с флагом `updateExisting` — обновляются (наименование и КПП);
 *   • строки без ИНН добавляются всегда: сравнивать их не с чем.
 */
export async function importCounterpartiesAction(input: {
  rows: CounterpartyImportRowInput[];
  updateExisting?: boolean;
}): Promise<CounterpartyImportResult> {
  const me = await getCurrentUser();
  if (!me || !isAdminRole(me.role)) {
    return { ok: false, error: "Загружать контрагентов из файла могут только администраторы" };
  }

  const rows = Array.isArray(input.rows) ? input.rows : [];
  if (rows.length === 0) return { ok: false, error: "В файле нет строк для загрузки" };
  if (rows.length > IMPORT_ROW_LIMIT) {
    return { ok: false, error: `За один раз можно загрузить не более ${IMPORT_ROW_LIMIT} строк. Разделите файл на части.` };
  }

  const warnings: string[] = [];
  const prepared: CounterpartyValues[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  let duplicates = 0;

  rows.forEach((row, index) => {
    const name = String(row?.name ?? "").replace(/\s+/g, " ").trim();
    const inn = normalizeInn(row?.inn);
    const kpp = normalizeKpp(row?.kpp);

    const problems: string[] = [];
    if (!name) problems.push("нет наименования");
    if (inn && !INN_RE.test(inn)) problems.push("ИНН не 10 и не 12 цифр");
    if (kpp && !KPP_RE.test(kpp)) problems.push("КПП не 9 цифр");
    if (problems.length > 0) {
      invalid += 1;
      if (warnings.length < 5) {
        const line = Number.isInteger(row?.line) && Number(row.line) > 0 ? Number(row.line) : index + 1;
        warnings.push(`Строка ${line}: ${problems.join(", ")}`);
      }
      return;
    }

    if (inn) {
      if (seen.has(inn)) {
        duplicates += 1;
        return;
      }
      seen.add(inn);
    }

    prepared.push({
      name,
      phone: null,
      email: null,
      address: null,
      inn: inn || null,
      kpp: kpp || null,
      notes: null,
    });
  });

  const existing = await findCounterpartiesByInns(prepared.map((v) => v.inn).filter((v): v is string => Boolean(v)));
  const toInsert: CounterpartyValues[] = [];
  let updated = 0;

  for (const values of prepared) {
    const found = values.inn ? existing.get(values.inn) : undefined;
    if (!found) {
      toInsert.push(values);
      continue;
    }
    if (!input.updateExisting) {
      duplicates += 1;
      continue;
    }
    await updateCounterpartyFromImport(found.id, values.name, values.kpp);
    updated += 1;
  }

  const inserted = await insertCounterpartiesBulk(toInsert, me.id);
  revalidatePath("/", "layout");

  return {
    ok: true,
    inserted,
    updated,
    skipped: invalid + duplicates,
    warnings,
  };
}
