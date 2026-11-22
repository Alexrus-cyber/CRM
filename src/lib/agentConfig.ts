import { assertSafeAgentUrl } from "./ssrf";

/**
 * Базовый адрес локального Python-агента (`agent/agent.py`).
 * Вынесен из API-роута в отдельный модуль конфигурации и валидируется
 * политикой `assertSafeAgentUrl` (loopback по умолчанию, валидный порт).
 */
export function resolveSafeAgentUrl(raw?: string): string {
  const candidate = (raw ?? process.env.AGENT_URL ?? "http://127.0.0.1:8899").trim().replace(/\/+$/, "");
  const parsed = assertSafeAgentUrl(candidate);
  return parsed.toString().replace(/\/+$/, "");
}

export const AGENT_URL = (() => {
  try {
    return resolveSafeAgentUrl(process.env.AGENT_URL);
  } catch {
    return "http://127.0.0.1:8899";
  }
})();

export const AGENT_START_HINT =
  "Запустите агента в папке проекта: python3 agent/agent.py (или задайте AGENT_URL на локальный порт)";
