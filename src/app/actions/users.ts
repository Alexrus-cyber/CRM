"use server";

import { revalidatePath } from "next/cache";
import type { Role } from "@/db/schema";
import {
  clearAiQuotaOverride,
  deleteUser,
  findUserIdByEmail,
  getPasswordHash,
  getRole,
  getUser,
  insertUser,
  setAiQuotaOverride,
  setUserPassword,
  setUserRole,
  updateProfile,
} from "@/db/repo";
import {
  canManageRole,
  getCurrentUser,
  hashPassword,
  verifyPassword,
} from "@/lib/auth";
import { publishLiveEvent } from "@/lib/events";
import { canManageTeam, canResetPasswords, isAdminRole } from "@/lib/utils";

export type ActionResult = { ok: true; id?: number } | { ok: false; error: string };

const ROLES: Role[] = ["super_admin", "admin", "developer", "manager", "consultant", "user"];

export type CreateUserInput = {
  name: string;
  email: string;
  password: string;
  role: Role;
  position?: string;
  phone?: string;
};

export async function createUserAction(input: CreateUserInput): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me || !canManageTeam(me.role)) return { ok: false, error: "Нет прав" };
  const role: Role = ROLES.includes(input.role) ? input.role : "user";
  if (role === "super_admin") return { ok: false, error: "Главный админ только один" };
  if (!canManageRole(me.role, role)) {
    return { ok: false, error: "Вы не можете создавать пользователей с такой ролью" };
  }
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!name || !email) return { ok: false, error: "Имя и email обязательны" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Некорректный email" };
  if (input.password.length < 6) return { ok: false, error: "Пароль минимум 6 символов" };
  if (await findUserIdByEmail(email)) return { ok: false, error: "Пользователь с таким email уже существует" };
  const colors = ["#7c5cff", "#ec4899", "#f97316", "#22c55e", "#06b6d4", "#3b82f6", "#f59e0b"];
  const id = await insertUser({
    name,
    email,
    passwordHash: hashPassword(input.password),
    role,
    position: input.position?.trim() || null,
    phone: input.phone?.trim() || null,
    avatarColor: colors[Math.floor(Math.random() * colors.length)],
  });
  revalidatePath("/", "layout");
  publishLiveEvent("users", me.id);
  return { ok: true, id };
}

export async function updateUserRoleAction(userId: number, role: Role): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me || me.role !== "super_admin") return { ok: false, error: "Только главный админ может менять права" };
  if (userId === me.id) return { ok: false, error: "Нельзя изменить собственную роль" };
  if (!ROLES.includes(role) || role === "super_admin") return { ok: false, error: "Некорректная роль" };
  const targetRole = await getRole(userId);
  if (!targetRole) return { ok: false, error: "Пользователь не найден" };
  if (targetRole === "super_admin") return { ok: false, error: "Нельзя изменить главного админа" };
  await setUserRole(userId, role);
  revalidatePath("/", "layout");
  publishLiveEvent("users", me.id);
  return { ok: true };
}

export async function deleteUserAction(userId: number): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me || me.role !== "super_admin") return { ok: false, error: "Только главный админ может удалять пользователей" };
  if (userId === me.id) return { ok: false, error: "Нельзя удалить себя" };
  if ((await getRole(userId)) === "super_admin") return { ok: false, error: "Нельзя удалить главного админа" };
  await deleteUser(userId);
  revalidatePath("/", "layout");
  publishLiveEvent("users", me.id);
  return { ok: true };
}

export async function adminResetPasswordAction(userId: number, password: string): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me || !canResetPasswords(me.role)) return { ok: false, error: "Нет прав: пароли меняют администраторы" };
  const targetRole = await getRole(userId);
  if (!targetRole) return { ok: false, error: "Пользователь не найден" };
  if (userId !== me.id && !canManageRole(me.role, targetRole)) return { ok: false, error: "Нет прав на этого пользователя" };
  if (password.length < 6) return { ok: false, error: "Пароль минимум 6 символов" };
  await setUserPassword(userId, hashPassword(password));
  return { ok: true };
}

/**
 * Расширение месячного лимита ИИ на текущий месяц.
 * Доступно только администратору: «диапазон» роли сам по себе не меняется.
 */
export async function setAiQuotaAction(userId: number, monthlyLimit: number | null): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me || !isAdminRole(me.role)) return { ok: false, error: "Только администратор может расширить лимит ИИ" };
  const targetRole = await getRole(userId);
  if (!targetRole) return { ok: false, error: "Пользователь не найден" };
  if (targetRole === "super_admin") return { ok: false, error: "Главному админу лимит не нужен" };

  if (monthlyLimit === null) {
    await clearAiQuotaOverride(userId);
  } else {
    if (!Number.isFinite(monthlyLimit) || monthlyLimit < 0) return { ok: false, error: "Некорректный лимит" };
    await setAiQuotaOverride(userId, Math.round(monthlyLimit), me.id);
  }
  revalidatePath("/", "layout");
  publishLiveEvent("users", me.id);
  return { ok: true };
}

export type ProfileInput = {
  name: string;
  email: string;
  phone?: string;
  position?: string;
  bio?: string;
  avatarColor: string;
  avatarUrl?: string | null;
};

export async function updateProfileAction(input: ProfileInput): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Не авторизован" };
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name || !email) return { ok: false, error: "Имя и email обязательны" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Некорректный email" };
  if (!/^#[0-9a-fA-F]{6}$/.test(input.avatarColor)) return { ok: false, error: "Некорректный цвет" };
  if (input.avatarUrl && input.avatarUrl.length > 1_500_000) return { ok: false, error: "Аватар слишком большой (до ~1 МБ)" };
  const owner = await findUserIdByEmail(email);
  if (owner && owner !== me.id) return { ok: false, error: "Email уже занят" };
  await updateProfile(me.id, {
    name,
    email,
    phone: input.phone?.trim() || null,
    position: input.position?.trim() || null,
    bio: input.bio?.trim() || null,
    avatarColor: input.avatarColor,
    avatarUrl: input.avatarUrl ?? null,
  });
  revalidatePath("/", "layout");
  publishLiveEvent("users", me.id);
  return { ok: true };
}

export async function changePasswordAction(current: string, next: string): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Не авторизован" };
  const stored = await getPasswordHash(me.id);
  if (!stored || !verifyPassword(current, stored)) return { ok: false, error: "Текущий пароль неверен" };
  if (next.length < 6) return { ok: false, error: "Новый пароль минимум 6 символов" };
  await setUserPassword(me.id, hashPassword(next));
  return { ok: true };
}

/** Kept for compatibility with pages that need a single user. */
export async function getUserForAdmin(id: number) {
  return getUser(id);
}
