import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertSafeAgentUrl, isLoopbackHostname } from "./ssrf";

function readLocalAgentTokenFile(port: number): string {
  try {
    const filePath = join(homedir(), ".crm-agent", `http-token-${port}.json`);
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed?.token === "string" ? parsed.token.trim() : "";
  } catch {
    return "";
  }
}

export function resolveAgentAuthToken(endpoint: string): { token: string; fromFile: boolean } {
  const envTok = (process.env.AGENT_HTTP_TOKEN ?? "").trim();
  if (envTok) return { token: envTok, fromFile: false };
  try {
    const u = new URL(endpoint);
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!isLoopbackHostname(host)) return { token: "", fromFile: false };
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { token: "", fromFile: false };
    const fileTok = readLocalAgentTokenFile(port);
    return { token: fileTok, fromFile: Boolean(fileTok) };
  } catch {
    return { token: "", fromFile: false };
  }
}

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
      const auth = resolveAgentAuthToken(endpoint);
      const reqHeaders = new Headers(init.headers);
      const hasCallerAuth = reqHeaders.has("authorization") || reqHeaders.has("x-agent-token");
      if (!hasCallerAuth && auth.token) {
        reqHeaders.set("Authorization", `Bearer ${auth.token}`);
      }
      const hasHeaders = Array.from(reqHeaders.keys()).length > 0;
      const reqInit: RequestInit = {
        ...init,
        ...(hasHeaders ? { headers: reqHeaders } : {}),
        signal,
      };
      let response = await fetch(`${endpoint}${pathAndQuery}`, reqInit);
      if (response.status === 401 && !hasCallerAuth && auth.fromFile) {
        const refreshed = resolveAgentAuthToken(endpoint);
        if (refreshed.token && refreshed.token !== auth.token) {
          const retryHeaders = new Headers(init.headers);
          retryHeaders.set("Authorization", `Bearer ${refreshed.token}`);
          response = await fetch(`${endpoint}${pathAndQuery}`, {
            ...init,
            headers: retryHeaders,
            signal,
          });
        }
      }
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
  "Запустите агента на компьютере: python3 agent/agent.py (для доступа из локальной сети LAN / Docker задайте AGENT_HOST=0.0.0.0 и на сервере CRM: AGENT_URL + CRM_ALLOW_REMOTE_AGENT=1)";
