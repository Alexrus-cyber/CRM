import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "crypto";
import type { Role } from "@/db/schema";
import {
  deleteSession,
  findSessionUser,
  getUserTotpSecret,
  insertSession,
  touchSession,
  type UserLite,
} from "@/db/repo";
import { verifyTotpCode } from "./totp";
import { MAX_PASSWORD_LENGTH } from "./validation";
import { canManageRole, isAdminRole } from "./permissions";

export const SESSION_COOKIE = "crm_session";
const SESSION_DAYS = 30;
const MAX_CONCURRENT_SCRYPT = 8;

let activeScryptOps = 0;
const scryptWaitQueue: Array<() => void> = [];

async function withScryptSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeScryptOps >= MAX_CONCURRENT_SCRYPT) {
    await new Promise<void>((resolve) => scryptWaitQueue.push(resolve));
  }
  activeScryptOps += 1;
  try {
    return await fn();
  } finally {
    activeScryptOps = Math.max(0, activeScryptOps - 1);
    const next = scryptWaitQueue.shift();
    if (next) next();
  }
}

function scryptAsync(password: string, salt: string, keylen = 64): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/** Authenticated user shape — works for both database engines. */
export type SafeUser = UserLite;

export function hashPassword(password: string): string {
  const safe = String(password || "").slice(0, MAX_PASSWORD_LENGTH);
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(safe, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!password || password.length > MAX_PASSWORD_LENGTH) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/**
 * Неблокирующий scrypt с ограничением параллельности (P1-4):
 * не блокирует event loop и защищает CPU от флуда одновременными логинами.
 */
export async function hashPasswordAsync(password: string): Promise<string> {
  if (!password || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Пароль не должен превышать ${MAX_PASSWORD_LENGTH} символов`);
  }
  const salt = randomBytes(16).toString("hex");
  const derived = await withScryptSlot(() => scryptAsync(password, salt, 64));
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  if (!password || password.length > MAX_PASSWORD_LENGTH) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash || !/^[0-9a-f]+$/i.test(hash)) return false;
  const expected = Buffer.from(hash, "hex");
  const candidate = await withScryptSlot(() => scryptAsync(password, salt, 64));
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export async function verifyUserTotp(userId: number, code: string): Promise<boolean> {
  const { enabled, secret } = await getUserTotpSecret(userId);
  if (!enabled || !secret) return true;
  return verifyTotpCode(secret, code);
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
