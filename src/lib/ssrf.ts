import dns from "node:dns/promises";
import net from "node:net";

/**
 * Политика SSRF для исходящих AI-запросов и URL локального агента.
 *
 * По решению администратора локальные LLM-серверы (127.0.0.1, ::1, localhost,
 * Ollama/LM Studio в локальной сети) разрешены, а облачные metadata-адреса
 * (169.254.169.254 и link-local диапазоны), опасные схемы, встроенные учётные
 * данные в URL и HTTP-редиректы жёстко блокируются.
 */

const BLOCKED_METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata.azure.internal",
  "metadata.aws.internal",
  "instance-data",
  "169.254.169.254",
]);

function normalizeIpv4Candidate(ip: string): string | null {
  const clean = ip.trim();
  if (net.isIPv4(clean)) return clean;
  if (clean.toLowerCase().startsWith("::ffff:")) {
    const mapped = clean.slice(7);
    if (net.isIPv4(mapped)) return mapped;
  }
  return null;
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function inCidr4(ipInt: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (ipv4ToInt(base) & mask);
}

export function isBlockedCloudOrSpecialIp(ip: string): boolean {
  const v4 = normalizeIpv4Candidate(ip);
  if (v4) {
    const n = ipv4ToInt(v4);
    // 0.0.0.0/8 ("this" network), 169.254.0.0/16 (cloud metadata & link-local),
    // 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved/broadcast)
    return (
      inCidr4(n, "0.0.0.0", 8) ||
      inCidr4(n, "169.254.0.0", 16) ||
      inCidr4(n, "224.0.0.0", 4) ||
      inCidr4(n, "240.0.0.0", 4)
    );
  }

  const lower = ip.trim().toLowerCase().split("%")[0] ?? "";
  if (!net.isIPv6(lower)) return true;
  if (lower === "::") return true;
  // IPv6 link-local (fe80::/10)
  if (/^fe[89ab][0-9a-f]:/i.test(lower) || /^fe[89ab][0-9a-f]$/i.test(lower)) return true;
  // IPv6 multicast (ff00::/8)
  if (lower.startsWith("ff")) return true;
  // AWS IMDSv6 (fd00:ec2::254)
  if (lower === "fd00:ec2::254") return true;
  return false;
}

export function parseHttpUrlStrict(rawUrl: string): URL {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) {
    throw new Error("Не указан URL модели");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Некорректный формат URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Разрешены только протоколы http:// и https://");
  }
  if (url.username || url.password) {
    throw new Error("Учётные данные в URL запрещены");
  }
  return url;
}

export async function assertSafeAiUrl(rawUrl: string): Promise<URL> {
  const url = parseHttpUrlStrict(rawUrl);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || BLOCKED_METADATA_HOSTS.has(host) || host.endsWith(".metadata.google.internal")) {
    throw new Error("Запрещённый адрес назначения");
  }

  if (net.isIP(host)) {
    if (isBlockedCloudOrSpecialIp(host)) {
      throw new Error("Запрещён доступ к link-local и metadata-адресам");
    }
    return url;
  }

  if (host === "localhost" || host.endsWith(".localhost")) {
    return url;
  }

  try {
    const resolved = await dns.lookup(host, { all: true });
    if (!resolved || resolved.length === 0) {
      throw new Error("Не удалось разрешить доменное имя");
    }
    for (const entry of resolved) {
      if (isBlockedCloudOrSpecialIp(entry.address)) {
        throw new Error("Домен указывает на запрещённый link-local или metadata-адрес");
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("запрещ")) {
      throw err;
    }
    // Если локальный офлайн-хост без DNS (например внутренний Docker-сервис или mDNS .local),
    // не падаем на временном отсутствии DNS — явные link-local IP уже отфильтрованы выше.
    const code = (err as { code?: string })?.code;
    const isLocalName = host.endsWith(".local") || host.endsWith(".lan") || !host.includes(".");
    if (code && code !== "ENOTFOUND" && code !== "EAI_AGAIN" && !(isLocalName && code === "ETIMEOUT")) {
      throw new Error("Ошибка DNS-проверки адреса");
    }
  }

  return url;
}

export function isLoopbackHostname(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

/**
 * Строгая валидация адреса локального Python-агента (`AGENT_URL`):
 * по умолчанию разрешён только loopback (127.0.0.1 / localhost / ::1)
 * с валидным портом, если явно не включён `CRM_ALLOW_REMOTE_AGENT=1`.
 */
export function assertSafeAgentUrl(rawUrl: string): URL {
  const url = parseHttpUrlStrict(rawUrl);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_METADATA_HOSTS.has(host)) {
    throw new Error("Некорректный AGENT_URL");
  }
  if (net.isIP(host) && isBlockedCloudOrSpecialIp(host)) {
    throw new Error("Некорректный IP в AGENT_URL");
  }
  if (url.search || url.hash) {
    throw new Error("AGENT_URL не должен содержать query или hash");
  }
  const allowRemote = process.env.CRM_ALLOW_REMOTE_AGENT === "1";
  if (!allowRemote && !isLoopbackHostname(host)) {
    throw new Error(
      "AGENT_URL должен указывать на локальный хост (127.0.0.1 / localhost). Для подключения агента по локальной сети (LAN) задайте CRM_ALLOW_REMOTE_AGENT=1.",
    );
  }
  if (url.port) {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Некорректный порт в AGENT_URL");
    }
  }
  return url;
}

/**
 * Обёртка fetch для AI/внешних запросов без автоматических редиректов (предотвращает 30x SSRF-обход).
 */
export async function safeAiFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  const safeUrl = await assertSafeAiUrl(rawUrl);
  const res = await fetch(safeUrl.toString(), {
    ...init,
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error("HTTP-редиректы на сервере модели запрещены политикой безопасности");
  }
  return res;
}
