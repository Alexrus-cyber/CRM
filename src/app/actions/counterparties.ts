"use server";

import { revalidatePath } from "next/cache";
import {
  deleteCounterparty,
  insertCounterparty,
  updateCounterparty,
  type CounterpartyValues,
} from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
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
