/**
 * Базовый адрес локального Python-агента (`agent/agent.py`).
 * Вынесен из API-роута в отдельный модуль конфигурации.
 */
export const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8899").replace(/\/+$/, "");

export const AGENT_START_HINT =
  "Запустите агента в папке проекта: python3 agent/agent.py (или задайте AGENT_URL, если он на другом хосте)";
