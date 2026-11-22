import { getAiUserSettingsSecret } from "@/db/repo";
import { getCurrentUser } from "@/lib/auth";
import { AI_DEFAULT_BASE_URL, aiAuthHeaders, aiEndpoint, normalizeBaseUrl } from "@/lib/ai";
import {
  extractCapabilitiesFromMetadata,
  pickCapabilitiesForModel,
  resolveModelCapabilities,
  type ModelCapabilities,
} from "@/lib/modelCapabilities";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 2_500;

type RawModelItem = Record<string, unknown> & { id?: string; name?: string; model?: string };
type ModelsResponse = { data?: RawModelItem[]; models?: RawModelItem[] };

function originOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

async function fetchJsonSafe(
  url: string,
  init: RequestInit = {},
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as unknown;
    return json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function inspectModels(baseUrl: string, apiKey: string, targetModel: string) {
  let upstream: Response;
  try {
    upstream = await fetch(aiEndpoint(baseUrl, "/models"), {
      headers: { Accept: "application/json", ...aiAuthHeaders(apiKey) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false as const,
      status: 502,
      error: `Нет связи с ${baseUrl}: ${reason}. Проверьте, что локальный сервер запущен.`,
    };
  }

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "");
    return {
      ok: false as const,
      status: 502,
      error: `Сервер ответил ${upstream.status}: ${body.trim().slice(0, 300) || "без описания"}`,
    };
  }

  const data = (await upstream.json().catch(() => ({}))) as ModelsResponse;
  const rawItems = Array.isArray(data.data)
    ? data.data
    : Array.isArray(data.models)
      ? data.models
      : [];

  const metaById = new Map<string, RawModelItem>();
  const models: string[] = [];
  for (const item of rawItems) {
    const id =
      (typeof item?.id === "string" && item.id) ||
      (typeof item?.model === "string" && item.model) ||
      (typeof item?.name === "string" && item.name) ||
      "";
    if (!id) continue;
    if (!metaById.has(id)) {
      models.push(id);
      metaById.set(id, item);
    }
  }
  models.sort((a, b) => a.localeCompare(b));

  const capabilitiesByModel: Record<string, ModelCapabilities> = {};
  for (const id of models) {
    capabilitiesByModel[id] = resolveModelCapabilities(id, metaById.get(id));
  }

  // Дополнительный опрос метаданных: /models/{id}, LM Studio (/api/v0/models, /api/v1/models), Ollama (/api/show).
  const origin = originOf(baseUrl);
  const headers = { Accept: "application/json", ...aiAuthHeaders(apiKey) };

  const probes: Array<Promise<void>> = [];

  if (origin) {
    for (const lmPath of ["/api/v0/models", "/api/v1/models"]) {
      probes.push(
        fetchJsonSafe(`${origin}${lmPath}`, { headers }).then((lmData) => {
          const lmList = Array.isArray(lmData?.data)
            ? lmData.data
            : Array.isArray(lmData?.models)
              ? lmData.models
              : [];
          for (const item of lmList) {
            if (!item || typeof item !== "object") continue;
            const rec = item as RawModelItem;
            const id = String(rec.id ?? rec.key ?? rec.name ?? "").trim();
            if (!id) continue;
            const caps = extractCapabilitiesFromMetadata(id, rec);
            if (caps) capabilitiesByModel[id] = caps;
          }
        }),
      );
    }
  }

  const inspectId = targetModel || models[0] || "";
  if (inspectId) {
    probes.push(
      fetchJsonSafe(aiEndpoint(baseUrl, `/models/${encodeURIComponent(inspectId)}`), { headers }).then(
        (detail) => {
          if (!detail) return;
          const caps = extractCapabilitiesFromMetadata(inspectId, detail);
          if (caps) capabilitiesByModel[inspectId] = caps;
        },
      ),
    );
    if (origin) {
      probes.push(
        fetchJsonSafe(`${origin}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ model: inspectId }),
        }).then((showData) => {
          if (!showData) return;
          const caps = extractCapabilitiesFromMetadata(inspectId, showData);
          if (caps) capabilitiesByModel[inspectId] = caps;
        }),
      );
    }
  }

  if (probes.length > 0) {
    await Promise.allSettled(probes);
  }

  const selectedCapabilities = inspectId
    ? pickCapabilitiesForModel(capabilitiesByModel, inspectId)
    : undefined;

  return {
    ok: true as const,
    baseUrl,
    models,
    capabilitiesByModel,
    ...(selectedCapabilities ? { selectedCapabilities } : {}),
  };
}

/**
 * `GET /api/ai/models?base=...&model=...` — список моделей сервера и их
 * возможности (режимы раздумий, vision, tools, контекст).
 */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const saved = await getAiUserSettingsSecret(me.id).catch(() => ({ baseUrl: "", model: "", apiKey: "" }));
  const url = new URL(req.url);
  const baseUrl =
    normalizeBaseUrl(url.searchParams.get("base") ?? "") ??
    normalizeBaseUrl(saved.baseUrl) ??
    normalizeBaseUrl(process.env.AI_BASE_URL ?? "") ??
    AI_DEFAULT_BASE_URL;
  const apiKey = (req.headers.get("x-ai-key") ?? saved.apiKey ?? process.env.AI_API_KEY ?? "").trim();
  const targetModel = (url.searchParams.get("model") ?? saved.model ?? "").trim();

  const result = await inspectModels(baseUrl, apiKey, targetModel);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json({
    baseUrl: result.baseUrl,
    models: result.models,
    capabilitiesByModel: result.capabilitiesByModel,
    ...(result.selectedCapabilities ? { selectedCapabilities: result.selectedCapabilities } : {}),
  });
}

/**
 * `POST /api/ai/models` — то же самое, но с ключом/моделью в JSON-теле.
 */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const saved = await getAiUserSettingsSecret(me.id).catch(() => ({ baseUrl: "", model: "", apiKey: "" }));
  const body = (await req.json().catch(() => null)) as {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  } | null;

  const baseUrl =
    normalizeBaseUrl(body?.baseUrl ?? "") ??
    normalizeBaseUrl(saved.baseUrl) ??
    normalizeBaseUrl(process.env.AI_BASE_URL ?? "") ??
    AI_DEFAULT_BASE_URL;
  const apiKey = ((body?.apiKey || "").trim() || req.headers.get("x-ai-key") || saved.apiKey || process.env.AI_API_KEY || "").trim();
  const targetModel = ((body?.model || "").trim() || saved.model || "").trim();

  const result = await inspectModels(baseUrl, apiKey, targetModel);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json({
    baseUrl: result.baseUrl,
    models: result.models,
    capabilitiesByModel: result.capabilitiesByModel,
    ...(result.selectedCapabilities ? { selectedCapabilities: result.selectedCapabilities } : {}),
  });
}
