import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import type { Role } from "@/db/schema";
import {
  countSuperAdmins,
  deleteSession,
  findSessionUser,
  findUserIdByEmail,
  insertSession,
  insertUser,
  promoteSuperAdmin,
  touchSession,
  type UserLite,
} from "@/db/repo";
import { canManageRole, isAdminRole } from "./permissions";

export const SESSION_COOKIE = "crm_session";
const SESSION_DAYS = 30;

/** Authenticated user shape — works for both database engines. */
export type SafeUser = UserLite;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/**
 * Первичная инициализация `super_admin` без зашитых паролей в коде.
 *
 * Если ни одного `super_admin` ещё нет, аккаунт создаётся/повышается только
 * при наличии явно заданной переменной `CRM_ADMIN_PASSWORD` (или `CRM_SEED_ADMIN_PASSWORD`).
 */
export async function ensureSuperAdmin() {
  if ((await countSuperAdmins()) > 0) return;

  const email = (process.env.CRM_ADMIN_EMAIL || process.env.CRM_SEED_ADMIN_EMAIL || "admin@crm.local")
    .trim()
    .toLowerCase();
  const password = (process.env.CRM_ADMIN_PASSWORD || process.env.CRM_SEED_ADMIN_PASSWORD || "").trim();
  const name = (process.env.CRM_ADMIN_NAME || process.env.CRM_SEED_ADMIN_NAME || "Главный администратор").trim();

  const existingId = await findUserIdByEmail(email);
  if (existingId) {
    await promoteSuperAdmin(existingId);
    return;
  }

  if (!password) {
    console.warn(
      "[auth] Нет super_admin в базе и не задан CRM_ADMIN_PASSWORD. " +
        "Запустите `node scripts/seed.mjs` или задайте CRM_ADMIN_EMAIL и CRM_ADMIN_PASSWORD.",
    );
    return;
  }

  await insertUser({
    name,
    email,
    passwordHash: hashPassword(password),
    role: "super_admin",
    position: "Руководитель",
    avatarColor: "#7c5cff",
  });
}

export async function createSession(
  userId: number,
  meta?: { label?: string; userAgent?: string; ip?: string },
) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);
  await insertSession(token, userId, expiresAt.toISOString(), meta);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
}

/** Создаёт долгоживущую сессию для настольного лаунчера (возвращает Bearer-токен). */
export async function createLauncherSession(
  userId: number,
  meta?: { label?: string; userAgent?: string; ip?: string },
): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await insertSession(token, userId, expiresAt, {
    label: meta?.label || "Лаунчер",
    userAgent: meta?.userAgent || "",
    ip: meta?.ip || "",
  });
  return { token, expiresAt };
}

export async function destroyTokenSession(token: string): Promise<void> {
  if (token) await deleteSession(token);
}

export async function findUserByBearer(req: Request): Promise<SafeUser | null> {
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : "";
  if (!token) return null;
  const found = await findSessionUser(token);
  if (!found) return null;
  touchSession(token).catch(() => undefined);
  return found.user;
}

export async function getRequestUser(req: Request): Promise<SafeUser | null> {
  const bearer = await findUserByBearer(req);
  if (bearer) return bearer;
  return getCurrentUser();
}

export async function getCurrentSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await deleteSession(token);
  }
  store.delete(SESSION_COOKIE);
}

export const getCurrentUser = cache(async (): Promise<SafeUser | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const found = await findSessionUser(token);
  if (!found) return null;
  touchSession(token).catch(() => undefined);
  return found.user;
});

export async function requireUser(): Promise<SafeUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdmin(): Promise<SafeUser> {
  const user = await requireUser();
  if (!isAdminRole(user.role)) redirect("/dashboard");
  return user;
}

export { canManageRole };

export function canAssignRole(actorRole: Role, targetRole: Role): boolean {
  if (!isAdminRole(actorRole) && actorRole !== "manager") return false;
  return canManageRole(actorRole, targetRole);
}
