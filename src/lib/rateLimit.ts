/**
 * Rate-limiter в памяти процесса для защиты входа от подбора пароля.
 *
 * Отслеживает попытки по IP и по паре (IP + email), поддерживает сброс при
 * успешном входе и периодическую очистку устаревших записей.
 */

type Bucket = {
  failures: number[];
  blockedUntil: number;
};

export type RateLimitOptions = {
  windowMs?: number;
  maxFailures?: number;
  blockMs?: number;
};

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number; message: string };

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 7;
const DEFAULT_BLOCK_MS = 10 * 60 * 1000;

const globalForRl = globalThis as typeof globalThis & {
  __crmLoginRateLimit?: Map<string, Bucket>;
  __crmLoginRlLastPrune?: number;
};

function getStore(): Map<string, Bucket> {
  if (!globalForRl.__crmLoginRateLimit) {
    globalForRl.__crmLoginRateLimit = new Map<string, Bucket>();
  }
  return globalForRl.__crmLoginRateLimit;
}

function pruneExpired(now: number, windowMs: number) {
  const last = globalForRl.__crmLoginRlLastPrune ?? 0;
  if (now - last < 60_000) return;
  globalForRl.__crmLoginRlLastPrune = now;
  const store = getStore();
  for (const [key, bucket] of store.entries()) {
    const recent = bucket.failures.filter((ts) => now - ts < windowMs);
    if (recent.length === 0 && bucket.blockedUntil <= now) {
      store.delete(key);
    } else {
      bucket.failures = recent;
    }
  }
}

export function extractClientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp.slice(0, 64);
  return "local";
}

function keysFor(ip: string, email: string): string[] {
  const normIp = (ip || "local").trim().toLowerCase();
  const normEmail = (email || "").trim().toLowerCase();
  return normEmail ? [`ip:${normIp}`, `acct:${normIp}:${normEmail}`] : [`ip:${normIp}`];
}

export function checkLoginRateLimit(
  ip: string,
  email: string,
  opts: RateLimitOptions = {},
  now = Date.now(),
): RateLimitDecision {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  pruneExpired(now, windowMs);
  const store = getStore();

  let maxBlockedUntil = 0;
  for (const key of keysFor(ip, email)) {
    const bucket = store.get(key);
    if (!bucket) continue;
    if (bucket.blockedUntil > now) {
      maxBlockedUntil = Math.max(maxBlockedUntil, bucket.blockedUntil);
    }
  }

  if (maxBlockedUntil > now) {
    const retryAfterSec = Math.max(1, Math.ceil((maxBlockedUntil - now) / 1000));
    return {
      allowed: false,
      retryAfterSec,
      message: `Слишком много неудачных попыток входа. Повторите через ${retryAfterSec} сек.`,
    };
  }
  return { allowed: true };
}

export function recordLoginFailure(
  ip: string,
  email: string,
  opts: RateLimitOptions = {},
  now = Date.now(),
): void {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
  const blockMs = opts.blockMs ?? DEFAULT_BLOCK_MS;
  const store = getStore();

  for (const key of keysFor(ip, email)) {
    const isIpOnly = key.startsWith("ip:");
    const limit = isIpOnly ? maxFailures * 3 : maxFailures;
    const bucket = store.get(key) ?? { failures: [], blockedUntil: 0 };
    bucket.failures = bucket.failures.filter((ts) => now - ts < windowMs);
    bucket.failures.push(now);
    if (bucket.failures.length >= limit) {
      bucket.blockedUntil = now + blockMs;
    }
    store.set(key, bucket);
  }
}

export function clearLoginAttempts(ip: string, email: string): void {
  const store = getStore();
  const normIp = (ip || "local").trim().toLowerCase();
  const normEmail = (email || "").trim().toLowerCase();
  if (normEmail) {
    store.delete(`acct:${normIp}:${normEmail}`);
  }
}

export const clearLoginFailures = clearLoginAttempts;

export function resetAllRateLimitsForTests(): void {
  getStore().clear();
}
