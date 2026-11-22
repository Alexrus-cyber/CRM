"use server";

import { randomBytes } from "node:crypto";
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
  requestEmailChange,
  revokeAllUserSessions,
  revokeOtherSessions,
  setAiQuotaOverride,
  setUserAgentAccess,
  setUserPassword,
  setUserRole,
  updateProfile,
} from "@/db/repo";
import {
  canManageRole,
  getCurrentSessionToken,
  getCurrentUser,
  hashPasswordAsync,
  verifyPasswordAsync,
} from "@/lib/auth";
import { publishLiveEvent } from "@/lib/events";
import { deleteStoredFile, saveStoredFile } from "@/lib/storage";
import { canManageTeam, canResetPasswords, isAdminRole } from "@/lib/utils";
import { createUserSchema, parseJsonBody, validateStrongPassword } from "@/lib/validation";

export type ActionResult = {
  ok: true;
  id?: number;
  pendingEmail?: string;
  confirmPath?: string;
  avatarUrl?: string | null;
} | { ok: false; error: string };

const ROLES: Role[] = ["super_admin", "admin", "developer", "manager", "consultant", "user"];
const MAX_AVATAR_BYTES = 1_048_576;

function detectImageExtension(bytes: Buffer, declaredExt: string): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return ".png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return ".jpg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return ".webp";
  }
  void declaredExt;
  return null;
}

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
  const parsed = parseJsonBody(input, createUserSchema, "Некорректные данные пользователя");
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { name, email, password, role, position, phone } = parsed.data;
  if (role === "super_admin") return { ok: false, error: "Главный админ только один" };
  if (!canManageRole(me.role, role)) {
    return { ok: false, error: "Вы не можете создавать пользователей с такой ролью" };
  }
  if (await findUserIdByEmail(email)) return { ok: false, error: "Пользователь с таким email уже существует" };
  const colors = ["#7c5cff", "#ec4899", "#f97316", "#22c55e", "#06b6d4", "#3b82f6", "#f59e0b"];
  const passwordHash = await hashPasswordAsync(password);
  const id = await insertUser({
    name,
    email,
    passwordHash,
    role,
    position: position?.trim() || null,
    phone: phone?.trim() || null,
    avatarColor: colors[Math.floor(Math.random() * colors.length)],
    mustChangePassword: true,
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

export async function deleteUserAction(userId: number, reassignToUserId?: number | null): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me || me.role !== "super_admin") return { ok: false, error: "Только главный админ может удалять пользователей" };
  if (userId === me.id) return { ok: false, error: "Нельзя удалить себя" };
  if ((await getRole(userId)) === "super_admin") return { ok: false, error: "Нельзя удалить главного админа" };
  await deleteUser(userId, reassignToUserId);
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
  const pwCheck = validateStrongPassword(password);
  if (!pwCheck.ok) return { ok: false, error: pwCheck.error };
  const passwordHash = await hashPasswordAsync(password);
  await setUserPassword(userId, passwordHash, { mustChangePassword: userId !== me.id });
  await revokeAllUserSessions(userId);
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

/**
 * Выдача или отзыв доступа к разделам «Агент» и «Оператор» (в CRM и лаунчере).
 * Разрешено ИСКЛЮЧИТЕЛЬНО главному администратору (`super_admin`).
 */
export async function setUserAgentAccessAction(
  userId: number,
  input: { canUseAgent?: boolean; canUseOperator?: boolean },
): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me || me.role !== "super_admin") {
    return { ok: false, error: "Только главный администратор может управлять доступом к Агенту и Оператору" };
  }
  const target = await getUser(userId);
  if (!target || target.isBot) return { ok: false, error: "Пользователь не найден" };
  if (target.role === "super_admin") {
    return { ok: false, error: "У главного администратора доступ всегда включён" };
  }

  await setUserAgentAccess(userId, input);
  revalidatePath("/", "layout");
  publishLiveEvent("users", me.id);
  return { ok: true };
}

export type ProfileInput = {
  name: string;
  email: string;
  currentPassword?: string;
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

  let nextAvatarUrl: string | null = me.avatarUrl;
  const oldStorageKey = me.avatarUrl?.startsWith("/api/avatars/")
    ? me.avatarUrl.slice("/api/avatars/".length)
    : null;

  if (input.avatarUrl === null || input.avatarUrl === "") {
    nextAvatarUrl = null;
    if (oldStorageKey) await deleteStoredFile(oldStorageKey);
  } else if (typeof input.avatarUrl === "string" && input.avatarUrl !== me.avatarUrl) {
    const match = input.avatarUrl.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i);
    if (match) {
      const b64 = match[2];
      const bytes = Buffer.from(b64, "base64");
      if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) {
        return { ok: false, error: "Аватар слишком большой (максимум 1 МБ)" };
      }
      const ext = detectImageExtension(bytes, match[1]);
      if (!ext) {
        return { ok: false, error: "Поддерживаются только изображения PNG, JPEG и WebP" };
      }
      const key = await saveStoredFile("avatars", bytes, `avatar${ext}`);
      nextAvatarUrl = `/api/avatars/${key}`;
      if (oldStorageKey) await deleteStoredFile(oldStorageKey);
    } else if (input.avatarUrl.startsWith("/api/avatars/avatars/")) {
      nextAvatarUrl = input.avatarUrl;
    } else {
      return { ok: false, error: "Некорректный формат аватара (загрузите PNG, JPEG или WebP)" };
    }
  }

  let pendingEmailResult: { pendingEmail: string; confirmPath?: string } | null = null;
  if (email !== me.email.toLowerCase()) {
    const owner = await findUserIdByEmail(email);
    if (owner && owner !== me.id) return { ok: false, error: "Email уже занят" };

    const currentPass = input.currentPassword ?? "";
    const storedHash = await getPasswordHash(me.id);
    if (!currentPass || !storedHash || !(await verifyPasswordAsync(currentPass, storedHash))) {
      return { ok: false, error: "Для смены email необходимо ввести текущий пароль" };
    }

    const confirmToken = randomBytes(32).toString("hex");
    await requestEmailChange(me.id, email, confirmToken);
    const confirmPath = `/api/auth/confirm-email?token=${confirmToken}`;

    const webhook = process.env.CRM_EMAIL_WEBHOOK_URL?.trim();
    if (webhook) {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "email_change", oldEmail: me.email, newEmail: email, confirmPath }),
      }).catch(() => undefined);
    }

    const allowDirectConfirmUi =
      process.env.NODE_ENV !== "production" || process.env.CRM_LOCAL_EMAIL_CONFIRM_IN_UI === "1";
    pendingEmailResult = {
      pendingEmail: email,
      ...(allowDirectConfirmUi ? { confirmPath } : {}),
    };
  }

  await updateProfile(me.id, {
    name,
    phone: input.phone?.trim() || null,
    position: input.position?.trim() || null,
    bio: input.bio?.trim() || null,
    avatarColor: input.avatarColor,
    avatarUrl: nextAvatarUrl,
  });

  revalidatePath("/", "layout");
  publishLiveEvent("users", me.id);
  return {
    ok: true,
    avatarUrl: nextAvatarUrl,
    ...(pendingEmailResult ?? {}),
  };
}

export async function changePasswordAction(current: string, next: string): Promise<ActionResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Не авторизован" };
  const stored = await getPasswordHash(me.id);
  if (!stored || !(await verifyPasswordAsync(current, stored))) {
    return { ok: false, error: "Текущий пароль неверен" };
  }
  const pwCheck = validateStrongPassword(next);
  if (!pwCheck.ok) return { ok: false, error: pwCheck.error };
  const newHash = await hashPasswordAsync(next);
  await setUserPassword(me.id, newHash, { mustChangePassword: false });
  const currentToken = await getCurrentSessionToken();
  if (currentToken) {
    await revokeOtherSessions(me.id, currentToken);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Kept for compatibility with pages that need a single user. */
export async function getUserForAdmin(id: number) {
  return getUser(id);
}
