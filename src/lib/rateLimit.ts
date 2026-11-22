/**
 * Rate-limiter в памяти процесса для защиты входа и дорогостоящих API-ручек.
 *
 * - Извлечение IP учитывает `CRM_TRUST_PROXY=1` (чтобы клиент не мог подделать
 *   `X-Forwarded-For` при прямом подключении).
 * - Поддерживает как лимитер логинов с блокировкой, так и sliding-window лимитер
 *   по `(scope, userId/ip)` с ограничением размера кэша.
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
const MAX_STORE_ENTRIES = 20_000;

const globalForRl = globalThis as typeof globalThis & {
  __crmLoginRateLimit?: Map<string, Bucket>;
  __crmLoginRlLastPrune?: number;
  __crmApiRateLimit?: Map<string, number[]>;
  __crmApiRlLastPrune?: number;
};

function getStore(): Map<string, Bucket> {
  if (!globalForRl.__crmLoginRateLimit) {
    globalForRl.__crmLoginRateLimit = new Map<string, Bucket>();
  }
  return globalForRl.__crmLoginRateLimit;
}

function getApiStore(): Map<string, number[]> {
  if (!globalForRl.__crmApiRateLimit) {
    globalForRl.__crmApiRateLimit = new Map<string, number[]>();
  }
  return globalForRl.__crmApiRateLimit;
}

function pruneExpired(now: number, windowMs: number) {
  const last = globalForRl.__crmLoginRlLastPrune ?? 0;
  const store = getStore();
  if (now - last < 60_000 && store.size < MAX_STORE_ENTRIES) return;
  globalForRl.__crmLoginRlLastPrune = now;
  for (const [key, bucket] of store.entries()) {
    const recent = bucket.failures.filter((ts) => now - ts < windowMs);
    if (recent.length === 0 && bucket.blockedUntil <= now) {
      store.delete(key);
    } else {
      bucket.failures = recent;
    }
  }
  while (store.size > MAX_STORE_ENTRIES) {
    const oldest = store.keys().next().value;
    if (!oldest) break;
    store.delete(oldest);
  }
}

function pruneApiStore(now: number, windowMs: number) {
  const last = globalForRl.__crmApiRlLastPrune ?? 0;
  const store = getApiStore();
  if (now - last < 30_000 && store.size < MAX_STORE_ENTRIES) return;
  globalForRl.__crmApiRlLastPrune = now;
  for (const [key, stamps] of store.entries()) {
    const recent = stamps.filter((ts) => now - ts < windowMs);
    if (recent.length === 0) store.delete(key);
    else store.set(key, recent);
  }
  while (store.size > MAX_STORE_ENTRIES) {
    const oldest = store.keys().next().value;
    if (!oldest) break;
    store.delete(oldest);
  }
}

/**
 * Безопасное извлечение клиентского IP.
 *
 * Заголовки `x-forwarded-for` и `x-real-ip` учитываются ТОЛЬКО при
 * `CRM_TRUST_PROXY=1`. В случае XFF используется правый доверенный hop
 * (согласно `CRM_TRUST_PROXY_HOPS`, по умолчанию 1), а не подделываемый левый элемент.
 */
export function extractClientIp(headers: Headers): string {
  const trustProxy = process.env.CRM_TRUST_PROXY === "1";
  if (trustProxy) {
    const realIp = headers.get("x-real-ip")?.trim();
    if (realIp) return realIp.slice(0, 64);

    const xff = headers.get("x-forwarded-for");
    if (xff) {
      const hops = Math.max(1, Number.parseInt(process.env.CRM_TRUST_PROXY_HOPS ?? "1", 10) || 1);
      const list = xff
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length > 0) {
        const idx = Math.max(0, list.length - hops);
        return list[idx].slice(0, 64);
      }
    }
  }

  // Fallback при прямом подключении без trusted proxy: изолированный маркер + User-Agent не доверяем как IP,
  // но x-forwarded-for при недоверенном прокси игнорируем, чтобы злоумышленник не обходил лимиты подменой XFF.
  return "direct";
}

function keysFor(ip: string, email: string): string[] {
  const normIp = (ip || "direct").trim().toLowerCase();
  const normEmail = (email || "").trim().toLowerCase();
  // При работе без доверенного reverse-proxy (`CRM_TRUST_PROXY !== "1"`) все пользователи
  // приходят под маркером "direct" — нельзя шарить общий IP-бакет, иначе 15 ошибок входа
  // одного сотрудника заблокируют вход для всей организации.
  const includeSharedIpBucket = normIp !== "direct" && normIp !== "local";
  if (!normEmail) {
    return includeSharedIpBucket ? [`ip:${normIp}`] : [`ip:${normIp}`];
  }
  const keys = [`acct:${normIp}:${normEmail}`, `mail:${normEmail}`];
  if (includeSharedIpBucket) {
    keys.unshift(`ip:${normIp}`);
  }
  return keys;
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
    const limit = key.startsWith("ip:") ? maxFailures * 3 : key.startsWith("mail:") ? maxFailures * 2 : maxFailures;
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
    store.delete(`mail:${normEmail}`);
  }
}

export const clearLoginFailures = clearLoginAttempts;

export type ApiRateLimitConfig = {
  scope: string;
  userId?: number | null;
  ip?: string;
  maxRequests: number;
  windowMs: number;
};

/**
 * Sliding-window rate limiter для API-ручек (по userId и по IP).
 */
export function checkApiRateLimit(
  cfg: ApiRateLimitConfig,
  now = Date.now(),
): RateLimitDecision {
  pruneApiStore(now, cfg.windowMs);
  const store = getApiStore();
  const keys: Array<{ key: string; limit: number }> = [];
  if (cfg.userId && cfg.userId > 0) {
    keys.push({ key: `${cfg.scope}:u:${cfg.userId}`, limit: cfg.maxRequests });
  }
  if (cfg.ip) {
    keys.push({
      key: `${cfg.scope}:ip:${cfg.ip}`,
      limit: cfg.userId ? cfg.maxRequests * 3 : cfg.maxRequests,
    });
  }
  if (keys.length === 0) {
    keys.push({ key: `${cfg.scope}:global`, limit: cfg.maxRequests });
  }

  for (const { key, limit } of keys) {
    const recent = (store.get(key) ?? []).filter((ts) => now - ts < cfg.windowMs);
    if (recent.length >= limit) {
      const oldest = recent[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + cfg.windowMs - now) / 1000));
      return {
        allowed: false,
        retryAfterSec,
        message: `Слишком много запросов (${cfg.scope}). Повторите через ${retryAfterSec} сек.`,
      };
    }
  }

  for (const { key } of keys) {
    const recent = (store.get(key) ?? []).filter((ts) => now - ts < cfg.windowMs);
    recent.push(now);
    store.set(key, recent);
  }

  return { allowed: true };
}

export function rateLimitErrorResponse(decision: Extract<RateLimitDecision, { allowed: false }>): Response {
  return Response.json(
    { error: decision.message },
    {
      status: 429,
      headers: { "Retry-After": String(decision.retryAfterSec) },
    },
  );
}

export function resetAllRateLimitsForTests(): void {
  getStore().clear();
  getApiStore().clear();
}
