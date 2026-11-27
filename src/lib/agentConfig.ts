import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { assertSafeAgentUrl, isLoopbackHostname } from "./ssrf";

const NATIVE_FETCH = globalThis.fetch;
const UNDICI_DEFAULT_STREAM_TIMEOUT_MS = 300_000;

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

/**
 * Прямой Node.js HTTP/HTTPS запрос без встроенного 300-секундного `headersTimeout` / `bodyTimeout`
 * у undici `fetch()`, чтобы длинные SSE-потоки (> 300 с, например 1200+ с на тяжёлых проектах)
 * не обрывались на стороне Next.js прокси.
 */
async function performLongTimeoutNodeRequest(
  urlStr: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal | null,
): Promise<Response> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  const target = new URL(urlStr);
  const isHttps = target.protocol === "https:";
  const transport = isHttps ? https : http;
  const method = (init.method ?? "GET").toUpperCase();

  const outHeaders: Record<string, string> = {};
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => {
      outHeaders[key] = value;
    });
  }

  let bodyBuf: Buffer | string | undefined;
  if (init.body !== undefined && init.body !== null) {
    if (typeof init.body === "string") {
      bodyBuf = init.body;
    } else if (init.body instanceof Uint8Array) {
      bodyBuf = Buffer.from(init.body);
    } else if (init.body instanceof ArrayBuffer) {
      bodyBuf = Buffer.from(init.body);
    } else {
      bodyBuf = String(init.body);
    }
    if (!Object.keys(outHeaders).some((k) => k.toLowerCase() === "content-length")) {
      outHeaders["content-length"] = String(
        typeof bodyBuf === "string" ? Buffer.byteLength(bodyBuf, "utf8") : bodyBuf.byteLength,
      );
    }
  }

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    let activeIncoming: http.IncomingMessage | null = null;

    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port ? Number(target.port) : isHttps ? 443 : 80,
        path: `${target.pathname}${target.search}`,
        method,
        headers: outHeaders,
        agent: false,
      },
      (res) => {
        if (settled) {
          res.resume();
          return;
        }
        settled = true;
        activeIncoming = res;
        res.socket?.setNoDelay(true);
        res.on("close", cleanupAbort);
        res.on("end", cleanupAbort);

        const respHeaders = new Headers();
        for (const [key, rawVal] of Object.entries(res.headers)) {
          if (rawVal === undefined) continue;
          if (Array.isArray(rawVal)) {
            for (const item of rawVal) respHeaders.append(key, item);
          } else {
            respHeaders.set(key, rawVal);
          }
        }
        const status = res.statusCode ?? 502;
        const noBody = method === "HEAD" || status === 204 || status === 304;
        if (noBody) {
          res.resume();
        }
        const webBody = noBody
          ? null
          : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
        resolve(
          new Response(webBody, {
            status,
            statusText: res.statusMessage ?? "",
            headers: respHeaders,
          }),
        );
      },
    );

    const onAbort = () => {
      const reason = signal?.reason ?? new DOMException("Aborted", "AbortError");
      if (!settled) {
        settled = true;
        cleanupAbort();
        req.destroy();
        reject(reason);
        return;
      }
      cleanupAbort();
      req.destroy();
      if (activeIncoming && !activeIncoming.destroyed) {
        activeIncoming.destroy(reason instanceof Error ? reason : new Error("Aborted"));
      }
    };

    const cleanupAbort = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    req.on("socket", (sock) => {
      sock.setNoDelay(true);
    });

    req.setTimeout(timeoutMs, () => {
      const err = new DOMException(`Agent request timed out after ${timeoutMs}ms`, "TimeoutError");
      req.destroy(err);
    });

    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        cleanupAbort();
        reject(err);
      }
    });

    if (bodyBuf !== undefined) {
      req.end(bodyBuf);
    } else {
      req.end();
    }
  });
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
    const useLongNodeTransport =
      typeof perAttemptTimeout === "number" &&
      perAttemptTimeout > UNDICI_DEFAULT_STREAM_TIMEOUT_MS &&
      globalThis.fetch === NATIVE_FETCH;
    const timeoutSig =
      !useLongNodeTransport && perAttemptTimeout ? AbortSignal.timeout(perAttemptTimeout) : undefined;
    const signal =
      options?.reqSignal && timeoutSig && typeof AbortSignal.any === "function"
        ? AbortSignal.any([options.reqSignal, timeoutSig])
        : (timeoutSig ?? options?.reqSignal ?? init.signal);

    const doRequest = async (reqInit: RequestInit): Promise<Response> => {
      if (useLongNodeTransport && perAttemptTimeout) {
        return await performLongTimeoutNodeRequest(
          `${endpoint}${pathAndQuery}`,
          reqInit,
          perAttemptTimeout,
          signal,
        );
      }
      return await fetch(`${endpoint}${pathAndQuery}`, reqInit);
    };

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
      let response = await doRequest(reqInit);
      if (response.status === 401 && !hasCallerAuth && auth.fromFile) {
        const refreshed = resolveAgentAuthToken(endpoint);
        if (refreshed.token && refreshed.token !== auth.token) {
          await response.body?.cancel().catch(() => undefined);
          const retryHeaders = new Headers(init.headers);
          retryHeaders.set("Authorization", `Bearer ${refreshed.token}`);
          response = await doRequest({
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
