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
  type UserLite,
} from "@/db/repo";
import { isAdminRole } from "./utils";

const SESSION_COOKIE = "crm_session";
const SESSION_DAYS = 30;

export const SUPER_ADMIN_CREDENTIALS = {
  email: "admin@crm.ru",
  password: "Admin12345",
  name: "Главный администратор",
};

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

/** Ensures that the main administrator account always exists. */
export async function ensureSuperAdmin() {
  if ((await countSuperAdmins()) > 0) return;
  const existingId = await findUserIdByEmail(SUPER_ADMIN_CREDENTIALS.email);
  if (existingId) {
    await promoteSuperAdmin(existingId);
    return;
  }
  await insertUser({
    name: SUPER_ADMIN_CREDENTIALS.name,
    email: SUPER_ADMIN_CREDENTIALS.email,
    passwordHash: hashPassword(SUPER_ADMIN_CREDENTIALS.password),
    role: "super_admin",
    position: "Руководитель",
    avatarColor: "#7c5cff",
  });
}

export async function createSession(userId: number) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);
  await insertSession(token, userId, expiresAt.toISOString());
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
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
  return found?.user ?? null;
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

export function canManageRole(actor: Role, target: Role) {
  if (actor === "super_admin") return true;
  // Администратор и менеджер оперируют только рядовыми ролями.
  if (actor === "admin" || actor === "manager") return target === "user" || target === "consultant";
  return false;
}
