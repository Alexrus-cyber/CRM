import { sql } from "drizzle-orm";
import { q1, toNum } from "../dialect";
import type { Role } from "../schema";

export type Raw = Record<string, unknown>;

export function parseJsonObject<T>(raw: unknown): T | null {
  const str = String(raw ?? "").trim();
  if (!str) return null;
  try {
    const parsed: unknown = JSON.parse(str);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export function maskToken(token: string): string {
  const value = String(token ?? "");
  return value ? `…${value.slice(-6)}` : "";
}

export function dayAgoIso(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

export async function getUserRoleById(userId: number): Promise<Role | null> {
  const row = await q1<{ role: string }>(sql`select role from users where id = ${userId}`);
  return (row?.role as Role) ?? null;
}

/** Месяц в формате YYYY-MM по часовому поясу приложения. */
export function aiMonthKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}`;
}
