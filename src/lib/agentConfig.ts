import { assertSafeAgentUrl, isLoopbackHostname } from "./ssrf";

/**
 * Базовый адрес локального Python-агента (`agent/agent.py`).
 * Вынесен из API-роута в отдельный модуль конфигурации и валидируется
 * политикой `assertSafeAgentUrl` (loopback по умолчанию, валидный порт).
 */
export function resolveSafeAgentUrl(raw?: string): string {
  const envValue = (process.env.AGENT_URL ?? "").trim();
  const candidate = (raw !== undefined ? raw : envValue || "http://127.0.0.1:8899").trim().replace(/\/+$/, "");
  const parsed = assertSafeAgentUrl(candidate);
  return parsed.toString().replace(/\/+$/, "");
}

export function agentLoopbackCandidates(agentUrl: string): string[] {
  const clean = agentUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = assertSafeAgentUrl(clean);
  } catch {
    return [clean];
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!isLoopbackHostname(host)) {
    return [clean];
  }
  const alts =
    host === "127.0.0.1"
      ? ["localhost", "[::1]"]
      : host === "::1"
        ? ["127.0.0.1", "localhost"]
        : ["127.0.0.1", "[::1]"];

  const out: string[] = [clean];
  const seen = new Set<string>([clean]);
  for (const altHost of alts) {
    try {
      const next = new URL(parsed.toString());
      next.hostname = altHost;
      const normalized = assertSafeAgentUrl(next.toString()).toString().replace(/\/+$/, "");
      if (!seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    } catch {
      /* пропускаем невалидный вариант */
    }
  }
  return out;
}

export async function fetchAgent(
  agentUrl: string,
  pathAndQuery: string,
  init: RequestInit = {},
  options?: { timeoutMs?: number; reqSignal?: AbortSignal },
): Promise<{ endpoint: string; response: Response }> {
  const candidates = agentLoopbackCandidates(agentUrl);
  let lastError: unknown = null;

  for (let i = 0; i < candidates.length; i += 1) {
    const endpoint = candidates[i]!;
    if (options?.reqSignal?.aborted) {
      throw options.reqSignal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const perAttemptTimeout =
      i === 0
        ? options?.timeoutMs
        : options?.timeoutMs
          ? Math.min(options.timeoutMs, 2_000)
          : undefined;
    const timeoutSig = perAttemptTimeout ? AbortSignal.timeout(perAttemptTimeout) : undefined;
    const signal =
      options?.reqSignal && timeoutSig && typeof AbortSignal.any === "function"
        ? AbortSignal.any([options.reqSignal, timeoutSig])
        : (timeoutSig ?? options?.reqSignal ?? init.signal);

    try {
      const response = await fetch(`${endpoint}${pathAndQuery}`, {
        ...init,
        signal,
      });
      return { endpoint, response };
    } catch (err) {
      lastError = err;
      if (options?.reqSignal?.aborted) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Не удалось связаться с агентом");
}

export const AGENT_URL = (() => {
  try {
    return resolveSafeAgentUrl(process.env.AGENT_URL);
  } catch (err) {
    console.error("[agentConfig] Invalid AGENT_URL, falling back to local agent:", (err as Error).message);
    return "http://127.0.0.1:8899";
  }
})();

export const AGENT_START_HINT =
  "Запустите агента в папке проекта: python3 agent/agent.py (или задайте AGENT_URL на локальный порт)";
