import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { normalizeBaseUrl } from "@/lib/ai";
import { nowIso, q, q1, toBool, toIso, toNum } from "../dialect";
import {
  insertAgentConversationMessage,
  createAgentConversation,
  getAgentConversation,
  recordAgentUsage,
  type AgentConversationRow,
} from "./agent";
import type { Raw } from "./shared";

export const MAX_SUBAGENTS_STORED = 50;
export const MAX_ACTIVE_SUBAGENTS = 10;

export type SubagentCallerKind = "orchestrator" | "subagent" | "user";
/**
 * Статусы запуска субагента.
 * `rotated` — автоперенос контекста в новый чат (это НЕ передача задачи другому субагенту),
 * `cancelled` — запуск остановлен пользователем (кнопка «Стоп»/«Сбросить»).
 */
export type SubagentRunStatus =
  | "running"
  | "completed"
  | "rotated"
  | "handoff"
  | "blocked"
  | "error"
  | "cancelled";

export const SUBAGENT_RUN_STATUSES: SubagentRunStatus[] = [
  "running",
  "completed",
  "rotated",
  "handoff",
  "blocked",
  "error",
  "cancelled",
];

/** Запуск считается «зависшим», если он `running` и не подавал heartbeat дольше этого времени. */
export const SUBAGENT_RUN_STALE_MS = 10 * 60 * 1000;
export type SubagentRoutingMode = "linear" | "layered";
export type OverseerMode = "strict" | "rules_only";
export type SubagentToolProfile = "full" | "restricted";

export type OverseerConfigPublic = {
  enabled: boolean;
  mode: OverseerMode;
  systemPrompt: string;
  unlockApi: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyHint: string;
};

export type OverseerConfigSecret = OverseerConfigPublic & {
  apiKey: string;
};

export type AgentOrchestrationConfigPublic = {
  routingMode: SubagentRoutingMode;
  orchestratorPosX: number | null;
  orchestratorPosY: number | null;
  overseer: OverseerConfigPublic;
};

export type AgentOrchestrationConfigSecret = {
  routingMode: SubagentRoutingMode;
  orchestratorPosX: number | null;
  orchestratorPosY: number | null;
  overseer: OverseerConfigSecret;
};

export type AgentSubagentPublic = {
  id: number;
  userId: number;
  slug: string;
  name: string;
  roleTitle: string;
  description: string;
  systemPrompt: string;
  color: string;
  isActive: boolean;
  parentSubagentId: number | null;
  orchestratorCanCall: boolean;
  /** `["*"]` — может просить Оркестратора вызвать любого активного субагента; `[]` — только возврат summary Оркестратору; либо список slug/id. */
  allowedCallees: string[];
  /** `'full'` — все инструменты (включая `browser_inspector` и браузер); `'restricted'` — урезанный профиль без браузера. */
  toolProfile: SubagentToolProfile;
  posX: number | null;
  posY: number | null;
  /** Галочка «Разблокировать API»: `false` = используется заблокированный API Агента (Оркестратора); `true` = используется своё API субагента. */
  unlockApi: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyHint: string;
  reasoningMode: string;
  runsCount: number;
  conversationsCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentSubagentSecret = AgentSubagentPublic & {
  apiKey: string;
};

export type AgentSubagentRunRow = {
  id: number;
  userId: number;
  subagentId: number;
  subagentSlug?: string;
  subagentName?: string;
  subagentColor?: string;
  agentConversationId: number | null;
  subagentConversationId: number;
  callerKind: SubagentCallerKind;
  callerSubagentId: number | null;
  callerSubagentName?: string;
  sandboxProject: string;
  inputSummary: string;
  outputSummary: string;
  status: SubagentRunStatus;
  requestedCalleeSlug: string;
  requestedCalleeTask: string;
  actionsCount: number;
  filesTouched: string[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  usedCustomApi: boolean;
  createdAt: string;
  updatedAt: string;
};

const CYR_MAP: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

export function slugifySubagentName(raw: string): string {
  const lower = String(raw || "").trim().toLowerCase();
  let out = "";
  for (const ch of lower) {
    if (CYR_MAP[ch] !== undefined) {
      out += CYR_MAP[ch];
    } else if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
    } else if (ch === "-" || ch === "_" || ch === " " || ch === ".") {
      out += "-";
    }
  }
  const clean = out.replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return clean || "subagent";
}

function parseStringArray(raw: unknown, fallback: string[] = []): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item ?? "").trim()).filter(Boolean);
  }
  try {
    const parsed = JSON.parse(String(raw ?? "[]")) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item ?? "").trim()).filter(Boolean);
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

export function normalizeAllowedCallees(raw: unknown): string[] {
  if (raw === undefined) return ["*"];
  if (raw === "*") return ["*"];
  const items = Array.isArray(raw)
    ? raw.map((x) => String(x ?? "").trim()).filter(Boolean)
    : parseStringArray(raw, []);
  if (items.includes("*")) return ["*"];
  const unique = Array.from(new Set(items.map((x) => x.slice(0, 64))));
  return unique.slice(0, MAX_SUBAGENTS_STORED);
}

const VALID_REASONING = new Set(["default", "off", "low", "medium", "high", "max"]);

function normalizeReasoningMode(raw: unknown): string {
  const clean = String(raw ?? "default").trim().toLowerCase();
  return VALID_REASONING.has(clean) ? clean : "default";
}

function normalizeColor(raw: unknown): string {
  const clean = String(raw ?? "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(clean)) return clean.toLowerCase();
  return "#8b5cf6";
}

export function normalizeToolProfile(raw: unknown): SubagentToolProfile {
  return String(raw ?? "").trim().toLowerCase() === "full" ? "full" : "restricted";
}

function normalizeCoord(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return Math.max(-2000, Math.min(8000, Math.round(num * 10) / 10));
}

function mapSubagentPublic(row: Raw): AgentSubagentPublic {
  const encrypted = String(row.api_key_encrypted ?? "");
  const parentRaw = row.parent_subagent_id;
  return {
    id: toNum(row.id),
    userId: toNum(row.user_id),
    slug: String(row.slug ?? ""),
    name: String(row.name ?? ""),
    roleTitle: String(row.role_title ?? ""),
    description: String(row.description ?? ""),
    systemPrompt: String(row.system_prompt ?? ""),
    color: normalizeColor(row.color),
    isActive: toBool(row.is_active),
    parentSubagentId: parentRaw === null || parentRaw === undefined ? null : toNum(parentRaw) || null,
    orchestratorCanCall: row.orchestrator_can_call === undefined ? true : toBool(row.orchestrator_can_call),
    allowedCallees: parseStringArray(row.allowed_callees, ["*"]),
    toolProfile: normalizeToolProfile(row.tool_profile),
    posX: normalizeCoord(row.pos_x),
    posY: normalizeCoord(row.pos_y),
    unlockApi: toBool(row.unlock_api),
    provider: String(row.provider ?? "custom") || "custom",
    baseUrl: String(row.base_url ?? ""),
    model: String(row.model ?? ""),
    hasApiKey: encrypted.length > 0,
    apiKeyHint: String(row.api_key_hint ?? ""),
    reasoningMode: normalizeReasoningMode(row.reasoning_mode),
    runsCount: toNum(row.runs_count),
    conversationsCount: toNum(row.conversations_count),
    createdAt: toIso(row.created_at) ?? nowIso(),
    updatedAt: toIso(row.updated_at) ?? nowIso(),
  };
}

function mapSubagentRun(row: Raw): AgentSubagentRunRow {
  const rawCaller = String(row.caller_kind ?? "orchestrator");
  const callerKind: SubagentCallerKind =
    rawCaller === "subagent" || rawCaller === "user" ? rawCaller : "orchestrator";
  const rawStatus = String(row.status ?? "running").trim().toLowerCase();
  const status: SubagentRunStatus = (SUBAGENT_RUN_STATUSES as string[]).includes(rawStatus)
    ? (rawStatus as SubagentRunStatus)
    : "running";
  return {
    id: toNum(row.id),
    userId: toNum(row.user_id),
    subagentId: toNum(row.subagent_id),
    ...(row.subagent_slug ? { subagentSlug: String(row.subagent_slug) } : {}),
    ...(row.subagent_name ? { subagentName: String(row.subagent_name) } : {}),
    ...(row.subagent_color ? { subagentColor: String(row.subagent_color) } : {}),
    agentConversationId:
      row.agent_conversation_id === null || row.agent_conversation_id === undefined
        ? null
        : toNum(row.agent_conversation_id) || null,
    subagentConversationId: toNum(row.subagent_conversation_id),
    callerKind,
    callerSubagentId:
      row.caller_subagent_id === null || row.caller_subagent_id === undefined
        ? null
        : toNum(row.caller_subagent_id) || null,
    ...(row.caller_subagent_name ? { callerSubagentName: String(row.caller_subagent_name) } : {}),
    sandboxProject: String(row.sandbox_project ?? ""),
    inputSummary: String(row.input_summary ?? ""),
    outputSummary: String(row.output_summary ?? ""),
    status,
    requestedCalleeSlug: String(row.requested_callee_slug ?? ""),
    requestedCalleeTask: String(row.requested_callee_task ?? ""),
    actionsCount: toNum(row.actions_count),
    filesTouched: parseStringArray(row.files_touched, []),
    promptTokens: toNum(row.prompt_tokens),
    completionTokens: toNum(row.completion_tokens),
    totalTokens: toNum(row.total_tokens),
    model: String(row.model ?? ""),
    usedCustomApi: toBool(row.used_custom_api),
    createdAt: toIso(row.created_at) ?? nowIso(),
    updatedAt: toIso(row.updated_at) ?? nowIso(),
  };
}

export async function countSubagents(userId: number): Promise<{ total: number; active: number }> {
  const row = await q1<{ total: number; active: number }>(sql`
    select count(*) as total,
           coalesce(sum(case when is_active then 1 else 0 end), 0) as active
    from agent_subagents
    where user_id = ${userId}`);
  return {
    total: toNum(row?.total),
    active: toNum(row?.active),
  };
}

export async function listSubagentsPublic(userId: number): Promise<AgentSubagentPublic[]> {
  const rows = await q(sql`
    select s.*,
           (select count(*) from agent_subagent_runs r where r.subagent_id = s.id) as runs_count,
           (select count(*) from agent_conversations c where c.user_id = s.user_id and c.kind = 'subagent' and c.subagent_id = s.id) as conversations_count
    from agent_subagents s
    where s.user_id = ${userId}
    order by s.is_active desc, s.id asc`);
  return rows.map(mapSubagentPublic);
}

export async function getSubagentPublic(
  userId: number,
  id: number,
): Promise<AgentSubagentPublic | null> {
  const row = await q1(sql`
    select s.*,
           (select count(*) from agent_subagent_runs r where r.subagent_id = s.id) as runs_count,
           (select count(*) from agent_conversations c where c.user_id = s.user_id and c.kind = 'subagent' and c.subagent_id = s.id) as conversations_count
    from agent_subagents s
    where s.id = ${id} and s.user_id = ${userId}
    limit 1`);
  return row ? mapSubagentPublic(row) : null;
}

export async function getSubagentWithSecret(
  userId: number,
  id: number,
): Promise<AgentSubagentSecret | null> {
  const row = await q1(sql`
    select s.*,
           (select count(*) from agent_subagent_runs r where r.subagent_id = s.id) as runs_count,
           (select count(*) from agent_conversations c where c.user_id = s.user_id and c.kind = 'subagent' and c.subagent_id = s.id) as conversations_count
    from agent_subagents s
    where s.id = ${id} and s.user_id = ${userId}
    limit 1`);
  if (!row) return null;
  const pub = mapSubagentPublic(row);
  let apiKey = "";
  if (pub.unlockApi && row.api_key_encrypted) {
    try {
      apiKey = decryptSecret(String(row.api_key_encrypted));
    } catch {
      apiKey = "";
    }
  }
  return { ...pub, apiKey };
}

/**
 * Возвращает активных субагентов пользователя (строго не более 10) с расшифрованным API-ключом
 * ТОЛЬКО у тех субагентов, у которых включена галочка `unlockApi = true`.
 */
export async function listActiveSubagentsWithSecrets(
  userId: number,
): Promise<AgentSubagentSecret[]> {
  const rows = await q(sql`
    select s.*,
           (select count(*) from agent_subagent_runs r where r.subagent_id = s.id) as runs_count,
           (select count(*) from agent_conversations c where c.user_id = s.user_id and c.kind = 'subagent' and c.subagent_id = s.id) as conversations_count
    from agent_subagents s
    where s.user_id = ${userId} and s.is_active = ${true}
    order by s.id asc
    limit ${MAX_ACTIVE_SUBAGENTS}`);
  return rows.map((row) => {
    const pub = mapSubagentPublic(row);
    let apiKey = "";
    if (pub.unlockApi && row.api_key_encrypted) {
      try {
        apiKey = decryptSecret(String(row.api_key_encrypted));
      } catch {
        apiKey = "";
      }
    }
    return { ...pub, apiKey };
  });
}

async function resolveUniqueSlug(
  userId: number,
  desiredRaw: string,
  excludeId?: number,
): Promise<string> {
  const base = slugifySubagentName(desiredRaw);
  const existingRows = await q<{ id: number; slug: string }>(
    sql`select id, slug from agent_subagents where user_id = ${userId}`,
  );
  const taken = new Set(
    existingRows
      .filter((r) => (excludeId ? toNum(r.id) !== excludeId : true))
      .map((r) => String(r.slug).toLowerCase()),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; i <= MAX_SUBAGENTS_STORED + 20; i += 1) {
    const candidate = `${base.slice(0, 42)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 38)}-${Date.now().toString(36).slice(-5)}`;
}

function assertAcyclicHierarchy(
  parentById: Map<number, number | null>,
): void {
  for (const startId of parentById.keys()) {
    const visited = new Set<number>([startId]);
    let cur = parentById.get(startId) ?? null;
    while (cur !== null) {
      if (!parentById.has(cur)) {
        throw new Error("Родительский субагент не найден");
      }
      if (visited.has(cur)) {
        throw new Error("Циклическая зависимость в дереве субагентов недопустима");
      }
      visited.add(cur);
      cur = parentById.get(cur) ?? null;
    }
  }
}

export type CreateSubagentInput = {
  name: string;
  slug?: string;
  roleTitle?: string;
  description?: string;
  systemPrompt?: string;
  color?: string;
  isActive?: boolean;
  parentSubagentId?: number | null;
  orchestratorCanCall?: boolean;
  allowedCallees?: string[] | string;
  toolProfile?: SubagentToolProfile;
  posX?: number | null;
  posY?: number | null;
  unlockApi?: boolean;
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  reasoningMode?: string;
};

export async function createSubagent(
  userId: number,
  input: CreateSubagentInput,
): Promise<AgentSubagentPublic> {
  const name = String(input.name ?? "").trim().slice(0, 120);
  if (!name) {
    throw new Error("Укажите название субагента");
  }
  const counts = await countSubagents(userId);
  if (counts.total >= MAX_SUBAGENTS_STORED) {
    throw new Error(
      `Можно создать не более ${MAX_SUBAGENTS_STORED} субагентов (сейчас в базе: ${counts.total})`,
    );
  }
  const wantActive = input.isActive !== undefined ? Boolean(input.isActive) : counts.active < MAX_ACTIVE_SUBAGENTS;
  if (wantActive && counts.active >= MAX_ACTIVE_SUBAGENTS) {
    throw new Error(
      `Одновременно может быть активно не более ${MAX_ACTIVE_SUBAGENTS} субагентов (выключите один из активных или создайте субагента неактивным)`,
    );
  }

  const allExisting = await listSubagentsPublic(userId);
  let parentId: number | null = null;
  if (input.parentSubagentId !== null && input.parentSubagentId !== undefined) {
    const pNum = Number(input.parentSubagentId);
    if (Number.isInteger(pNum) && pNum > 0) {
      if (!allExisting.some((s) => s.id === pNum)) {
        throw new Error("Родительский субагент не найден");
      }
      parentId = pNum;
    }
  }

  const slug = await resolveUniqueSlug(userId, input.slug?.trim() || name);
  const roleTitle = String(input.roleTitle ?? "").trim().slice(0, 160);
  const description = String(input.description ?? "").trim().slice(0, 600);
  const systemPrompt = String(input.systemPrompt ?? "").trim().slice(0, 16_000);
  const color = normalizeColor(input.color);
  const orchestratorCanCall = input.orchestratorCanCall !== false;
  const allowedCallees = normalizeAllowedCallees(input.allowedCallees).filter(
    (item) => item !== slug,
  );
  const toolProfile = normalizeToolProfile(input.toolProfile);
  const posX = normalizeCoord(input.posX);
  const posY = normalizeCoord(input.posY);
  const unlockApi = Boolean(input.unlockApi);
  const provider = String(input.provider ?? "custom").trim().slice(0, 40) || "custom";
  const baseUrl = input.baseUrl ? normalizeBaseUrl(String(input.baseUrl).slice(0, 400)) : "";
  const model = String(input.model ?? "").trim().slice(0, 200);
  const cleanKey = String(input.apiKey ?? "").trim().slice(0, 500);
  const encryptedKey = cleanKey ? encryptSecret(cleanKey) : "";
  const keyHint = cleanKey ? maskSecret(cleanKey) : "";
  const reasoningMode = normalizeReasoningMode(input.reasoningMode);
  const now = nowIso();

  const inserted = await q1<{ id: number }>(sql`
    insert into agent_subagents (
      user_id, slug, name, role_title, description, system_prompt, color,
      is_active, parent_subagent_id, orchestrator_can_call, allowed_callees,
      tool_profile, pos_x, pos_y,
      unlock_api, provider, base_url, model, api_key_encrypted, api_key_hint,
      reasoning_mode, created_at, updated_at
    ) values (
      ${userId}, ${slug}, ${name}, ${roleTitle}, ${description}, ${systemPrompt}, ${color},
      ${wantActive}, ${parentId}, ${orchestratorCanCall}, ${JSON.stringify(allowedCallees)},
      ${toolProfile}, ${posX}, ${posY},
      ${unlockApi}, ${provider}, ${baseUrl}, ${model}, ${encryptedKey}, ${keyHint},
      ${reasoningMode}, ${now}, ${now}
    ) returning id`);
  const created = await getSubagentPublic(userId, toNum(inserted?.id));
  if (!created) throw new Error("Не удалось создать субагента");
  return created;
}

export type UpdateSubagentInput = {
  name?: string;
  slug?: string;
  roleTitle?: string;
  description?: string;
  systemPrompt?: string;
  color?: string;
  isActive?: boolean;
  parentSubagentId?: number | null;
  orchestratorCanCall?: boolean;
  allowedCallees?: string[] | string;
  toolProfile?: SubagentToolProfile;
  posX?: number | null;
  posY?: number | null;
  unlockApi?: boolean;
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  reasoningMode?: string;
};

export async function updateSubagent(
  userId: number,
  id: number,
  patch: UpdateSubagentInput,
): Promise<AgentSubagentPublic | null> {
  const existingRow = await q1(sql`
    select * from agent_subagents where id = ${id} and user_id = ${userId} limit 1`);
  if (!existingRow) return null;
  const current = mapSubagentPublic(existingRow);
  const all = await listSubagentsPublic(userId);

  const nextActive = patch.isActive !== undefined ? Boolean(patch.isActive) : current.isActive;
  if (nextActive && !current.isActive) {
    const activeNow = all.filter((s) => s.isActive && s.id !== id).length;
    if (activeNow >= MAX_ACTIVE_SUBAGENTS) {
      throw new Error(
        `Одновременно может быть активно не более ${MAX_ACTIVE_SUBAGENTS} субагентов`,
      );
    }
  }

  let nextParentId = current.parentSubagentId;
  if (patch.parentSubagentId !== undefined) {
    if (patch.parentSubagentId === null || patch.parentSubagentId === 0) {
      nextParentId = null;
    } else {
      const pNum = Number(patch.parentSubagentId);
      if (!Number.isInteger(pNum) || pNum <= 0) {
        nextParentId = null;
      } else {
        if (pNum === id) {
          throw new Error("Субагент не может быть родителем самого себя");
        }
        nextParentId = pNum;
      }
    }
    const parentMap = new Map<number, number | null>(
      all.map((s) => [s.id, s.id === id ? nextParentId : s.parentSubagentId]),
    );
    assertAcyclicHierarchy(parentMap);
  }

  const nextName =
    patch.name !== undefined ? String(patch.name).trim().slice(0, 120) || current.name : current.name;
  const nextSlug =
    patch.slug !== undefined && String(patch.slug).trim()
      ? await resolveUniqueSlug(userId, String(patch.slug).trim(), id)
      : current.slug;
  const nextRoleTitle =
    patch.roleTitle !== undefined ? String(patch.roleTitle).trim().slice(0, 160) : current.roleTitle;
  const nextDescription =
    patch.description !== undefined
      ? String(patch.description).trim().slice(0, 600)
      : current.description;
  const nextSystemPrompt =
    patch.systemPrompt !== undefined
      ? String(patch.systemPrompt).trim().slice(0, 16_000)
      : current.systemPrompt;
  const nextColor = patch.color !== undefined ? normalizeColor(patch.color) : current.color;
  const nextOrchestratorCanCall =
    patch.orchestratorCanCall !== undefined
      ? Boolean(patch.orchestratorCanCall)
      : current.orchestratorCanCall;
  const nextAllowedCallees = (
    patch.allowedCallees !== undefined
      ? normalizeAllowedCallees(patch.allowedCallees)
      : current.allowedCallees
  ).filter((item) => item !== nextSlug && item !== String(id));
  const nextToolProfile =
    patch.toolProfile !== undefined ? normalizeToolProfile(patch.toolProfile) : current.toolProfile;
  const nextPosX = patch.posX !== undefined ? normalizeCoord(patch.posX) : current.posX;
  const nextPosY = patch.posY !== undefined ? normalizeCoord(patch.posY) : current.posY;
  const nextUnlockApi =
    patch.unlockApi !== undefined ? Boolean(patch.unlockApi) : current.unlockApi;
  const nextProvider =
    patch.provider !== undefined
      ? String(patch.provider).trim().slice(0, 40) || "custom"
      : current.provider;
  const nextBaseUrl =
    patch.baseUrl !== undefined
      ? patch.baseUrl
        ? normalizeBaseUrl(String(patch.baseUrl).slice(0, 400))
        : ""
      : current.baseUrl;
  const nextModel =
    patch.model !== undefined ? String(patch.model).trim().slice(0, 200) : current.model;
  const nextReasoningMode =
    patch.reasoningMode !== undefined
      ? normalizeReasoningMode(patch.reasoningMode)
      : current.reasoningMode;

  let nextEncrypted = String(existingRow.api_key_encrypted ?? "");
  let nextHint = String(existingRow.api_key_hint ?? "");
  if (patch.clearApiKey) {
    nextEncrypted = "";
    nextHint = "";
  } else if (typeof patch.apiKey === "string" && patch.apiKey.trim().length > 0) {
    const cleanKey = patch.apiKey.trim().slice(0, 500);
    nextEncrypted = encryptSecret(cleanKey);
    nextHint = maskSecret(cleanKey);
  }

  const now = nowIso();
  await q(sql`
    update agent_subagents
    set slug = ${nextSlug},
        name = ${nextName},
        role_title = ${nextRoleTitle},
        description = ${nextDescription},
        system_prompt = ${nextSystemPrompt},
        color = ${nextColor},
        is_active = ${nextActive},
        parent_subagent_id = ${nextParentId},
        orchestrator_can_call = ${nextOrchestratorCanCall},
        allowed_callees = ${JSON.stringify(nextAllowedCallees)},
        tool_profile = ${nextToolProfile},
        pos_x = ${nextPosX},
        pos_y = ${nextPosY},
        unlock_api = ${nextUnlockApi},
        provider = ${nextProvider},
        base_url = ${nextBaseUrl},
        model = ${nextModel},
        api_key_encrypted = ${nextEncrypted},
        api_key_hint = ${nextHint},
        reasoning_mode = ${nextReasoningMode},
        updated_at = ${now}
    where id = ${id} and user_id = ${userId}`);

  if (nextSlug !== current.slug) {
    // Обновляем ссылки по slug в allowed_callees других субагентов пользователя.
    for (const other of all) {
      if (other.id === id) continue;
      if (other.allowedCallees.includes(current.slug)) {
        const updatedList = other.allowedCallees.map((c) => (c === current.slug ? nextSlug : c));
        await q(sql`
          update agent_subagents
          set allowed_callees = ${JSON.stringify(updatedList)}, updated_at = ${now}
          where id = ${other.id} and user_id = ${userId}`);
      }
    }
  }

  return getSubagentPublic(userId, id);
}

export type DependencyTreeNodeUpdate = {
  id: number;
  isActive?: boolean;
  parentSubagentId?: number | null;
  orchestratorCanCall?: boolean;
  allowedCallees?: string[];
  posX?: number | null;
  posY?: number | null;
};

/**
 * Пакетное обновление дерева зависимостей «Оркестратор ↔ Субагенты» и активного набора (до 10 активных).
 */
export async function updateSubagentsDependencyTree(
  userId: number,
  updates: DependencyTreeNodeUpdate[],
): Promise<AgentSubagentPublic[]> {
  const all = await listSubagentsPublic(userId);
  const byId = new Map(all.map((s) => [s.id, s]));
  const nextActiveMap = new Map<number, boolean>(all.map((s) => [s.id, s.isActive]));
  const nextParentMap = new Map<number, number | null>(all.map((s) => [s.id, s.parentSubagentId]));
  const nextOrchMap = new Map<number, boolean>(all.map((s) => [s.id, s.orchestratorCanCall]));
  const nextCalleesMap = new Map<number, string[]>(all.map((s) => [s.id, s.allowedCallees]));
  const nextPosXMap = new Map<number, number | null>(all.map((s) => [s.id, s.posX]));
  const nextPosYMap = new Map<number, number | null>(all.map((s) => [s.id, s.posY]));

  for (const upd of updates) {
    const id = Number(upd.id);
    const cur = byId.get(id);
    if (!cur) continue;
    if (upd.isActive !== undefined) nextActiveMap.set(id, Boolean(upd.isActive));
    if (upd.parentSubagentId !== undefined) {
      const p = upd.parentSubagentId === null || upd.parentSubagentId === 0 ? null : Number(upd.parentSubagentId);
      if (p === id) {
        throw new Error(`Субагент «${cur.name}» не может быть родителем самого себя`);
      }
      nextParentMap.set(id, p && Number.isInteger(p) && p > 0 ? p : null);
    }
    if (upd.orchestratorCanCall !== undefined) {
      nextOrchMap.set(id, Boolean(upd.orchestratorCanCall));
    }
    if (upd.allowedCallees !== undefined) {
      nextCalleesMap.set(
        id,
        normalizeAllowedCallees(upd.allowedCallees).filter(
          (c) => c !== cur.slug && c !== String(id),
        ),
      );
    }
    if (upd.posX !== undefined) {
      nextPosXMap.set(id, normalizeCoord(upd.posX));
    }
    if (upd.posY !== undefined) {
      nextPosYMap.set(id, normalizeCoord(upd.posY));
    }
  }

  const totalActive = Array.from(nextActiveMap.values()).filter(Boolean).length;
  if (totalActive > MAX_ACTIVE_SUBAGENTS) {
    throw new Error(
      `Одновременно может быть активно не более ${MAX_ACTIVE_SUBAGENTS} субагентов (выбрано: ${totalActive})`,
    );
  }
  assertAcyclicHierarchy(nextParentMap);

  const now = nowIso();
  for (const s of all) {
    await q(sql`
      update agent_subagents
      set is_active = ${nextActiveMap.get(s.id) ?? s.isActive},
          parent_subagent_id = ${nextParentMap.get(s.id) ?? null},
          orchestrator_can_call = ${nextOrchMap.get(s.id) ?? s.orchestratorCanCall},
          allowed_callees = ${JSON.stringify(nextCalleesMap.get(s.id) ?? s.allowedCallees)},
          pos_x = ${nextPosXMap.get(s.id) ?? null},
          pos_y = ${nextPosYMap.get(s.id) ?? null},
          updated_at = ${now}
      where id = ${s.id} and user_id = ${userId}`);
  }
  return listSubagentsPublic(userId);
}

export async function deleteSubagent(userId: number, id: number): Promise<boolean> {
  const current = await getSubagentPublic(userId, id);
  if (!current) return false;
  const now = nowIso();
  // Сбрасываем parent_subagent_id и вычищаем slug из allowed_callees у остальных субагентов.
  await q(sql`
    update agent_subagents
    set parent_subagent_id = ${null}, updated_at = ${now}
    where user_id = ${userId} and parent_subagent_id = ${id}`);
  const others = await listSubagentsPublic(userId);
  for (const other of others) {
    if (other.id === id) continue;
    if (other.allowedCallees.includes(current.slug) || other.allowedCallees.includes(String(id))) {
      const filtered = other.allowedCallees.filter(
        (c) => c !== current.slug && c !== String(id),
      );
      await q(sql`
        update agent_subagents
        set allowed_callees = ${JSON.stringify(filtered)}, updated_at = ${now}
        where id = ${other.id} and user_id = ${userId}`);
    }
  }

  const convRows = await q<{ id: number }>(sql`
    select id from agent_conversations
    where user_id = ${userId} and kind = 'subagent' and subagent_id = ${id}`);
  for (const c of convRows) {
    const cid = toNum(c.id);
    await q(sql`delete from agent_conversation_messages where conversation_id = ${cid}`);
    await q(sql`delete from agent_conversations where id = ${cid} and user_id = ${userId}`);
  }
  await q(sql`delete from agent_subagent_runs where subagent_id = ${id} and user_id = ${userId}`);
  await q(sql`delete from agent_subagents where id = ${id} and user_id = ${userId}`);
  return true;
}

/* --------------------- запуски и изолированные чаты ---------------------- */

export async function getSubagentRun(
  userId: number,
  runId: number,
): Promise<AgentSubagentRunRow | null> {
  const row = await q1(sql`
    select r.*,
           s.slug as subagent_slug,
           s.name as subagent_name,
           s.color as subagent_color,
           cs.name as caller_subagent_name
    from agent_subagent_runs r
    join agent_subagents s on s.id = r.subagent_id
    left join agent_subagents cs on cs.id = r.caller_subagent_id
    where r.id = ${runId} and r.user_id = ${userId}
    limit 1`);
  return row ? mapSubagentRun(row) : null;
}

export async function listSubagentRuns(
  userId: number,
  options?: { subagentId?: number | null; limit?: number },
): Promise<AgentSubagentRunRow[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(options?.limit ?? 60)));
  const subId =
    options?.subagentId && Number.isFinite(options.subagentId) && options.subagentId > 0
      ? Math.floor(options.subagentId)
      : null;
  const rows = subId
    ? await q(sql`
        select r.*,
               s.slug as subagent_slug,
               s.name as subagent_name,
               s.color as subagent_color,
               cs.name as caller_subagent_name
        from agent_subagent_runs r
        join agent_subagents s on s.id = r.subagent_id
        left join agent_subagents cs on cs.id = r.caller_subagent_id
        where r.user_id = ${userId} and r.subagent_id = ${subId}
        order by r.id desc
        limit ${safeLimit}`)
    : await q(sql`
        select r.*,
               s.slug as subagent_slug,
               s.name as subagent_name,
               s.color as subagent_color,
               cs.name as caller_subagent_name
        from agent_subagent_runs r
        join agent_subagents s on s.id = r.subagent_id
        left join agent_subagents cs on cs.id = r.caller_subagent_id
        where r.user_id = ${userId}
        order by r.id desc
        limit ${safeLimit}`);
  return rows.map(mapSubagentRun);
}

/**
 * Создаёт новый изолированный чат субагента (`agent_conversations` с `kind = "subagent"`)
 * и запись запуска `agent_subagent_runs` — каждый вызов Оркестратора работает в свежем чате
 * без лишних токенов истории, сохраняя общий доступ к проекту Sandbox/GitHub.
 */
export async function createSubagentRunWithConversation(input: {
  userId: number;
  subagentId: number;
  agentConversationId?: number | null;
  existingConversationId?: number | null;
  skipInitialMessage?: boolean;
  callerKind?: SubagentCallerKind;
  callerSubagentId?: number | null;
  sandboxProject?: string;
  inputSummary?: string;
  taskPrompt?: string;
  model?: string;
  usedCustomApi?: boolean;
}): Promise<{ run: AgentSubagentRunRow; conversation: AgentConversationRow }> {
  const subagent = await getSubagentPublic(input.userId, input.subagentId);
  if (!subagent) throw new Error("Субагент не найден");

  const projectLabel = (input.sandboxProject ?? "").trim() || ".";
  const summaryText = (input.inputSummary ?? "").trim();
  const taskText = (input.taskPrompt ?? "").trim();
  const callerKind: SubagentCallerKind = input.callerKind ?? "orchestrator";

  let conv: AgentConversationRow | null = null;
  if (input.existingConversationId && input.existingConversationId > 0) {
    const found = await getAgentConversation(input.userId, input.existingConversationId);
    if (found && found.kind === "subagent") {
      conv = found;
    }
  }
  if (!conv) {
    const shortTopic = (taskText || summaryText || projectLabel).replace(/\s+/g, " ").slice(0, 64);
    const title = `${subagent.name}: ${shortTopic}`.slice(0, 120);
    conv = await createAgentConversation(
      input.userId,
      "subagent",
      title,
      subagent.systemPrompt,
      subagent.id,
    );
  }

  const now = nowIso();
  const initialUserContent =
    callerKind === "subagent"
      ? `Запрос через Оркестратора от другого субагента (проект Sandbox: \`${projectLabel}\`).\n\nSummary предыдущих действий:\n${summaryText || "(не указано)"}${taskText ? `\n\nЗадача для выполнения:\n${taskText}` : ""}`
      : callerKind === "user"
        ? taskText || summaryText || `Выполни задачу в проекте \`${projectLabel}\`.`
        : `Задание от Главного Агента — Оркестратора (проект Sandbox: \`${projectLabel}\`).\n\nSummary контекста и выполненных действий:\n${summaryText || "(не указано)"}${taskText ? `\n\nЧто нужно сделать:\n${taskText}` : ""}`;

  if (!input.skipInitialMessage) {
    await insertAgentConversationMessage({
      userId: input.userId,
      conversationId: conv.id,
      role: "user",
      content: initialUserContent,
    });
  }

  const inserted = await q1<{ id: number }>(sql`
    insert into agent_subagent_runs (
      user_id, subagent_id, agent_conversation_id, subagent_conversation_id,
      caller_kind, caller_subagent_id, sandbox_project, input_summary, output_summary,
      status, requested_callee_slug, requested_callee_task, actions_count, files_touched,
      prompt_tokens, completion_tokens, total_tokens, model, used_custom_api,
      created_at, updated_at
    ) values (
      ${input.userId},
      ${subagent.id},
      ${input.agentConversationId ?? null},
      ${conv.id},
      ${callerKind},
      ${input.callerSubagentId ?? null},
      ${projectLabel},
      ${summaryText || taskText},
      '',
      'running',
      '',
      '',
      0,
      '[]',
      0,
      0,
      0,
      ${String(input.model ?? "")},
      ${Boolean(input.usedCustomApi)},
      ${now},
      ${now}
    ) returning id`);

  const run = await getSubagentRun(input.userId, toNum(inserted?.id));
  if (!run) throw new Error("Не удалось создать запуск субагента");
  return {
    run,
    conversation: {
      ...conv,
      messagesCount: input.skipInitialMessage ? conv.messagesCount : conv.messagesCount + 1,
    },
  };
}

export async function completeSubagentRun(input: {
  userId: number;
  runId: number;
  status: SubagentRunStatus;
  outputSummary: string;
  requestedCalleeSlug?: string;
  requestedCalleeTask?: string;
  filesTouched?: string[];
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  model?: string;
  usedCustomApi?: boolean;
  assistantContent?: string;
  assistantReasoning?: string;
  assistantActions?: unknown[];
  assistantFiles?: unknown[];
  assistantError?: string;
}): Promise<AgentSubagentRunRow | null> {
  const existing = await getSubagentRun(input.userId, input.runId);
  if (!existing) return null;

  const now = nowIso();
  const promptTok = Math.max(0, Math.round(input.promptTokens ?? 0));
  const compTok = Math.max(0, Math.round(input.completionTokens ?? 0));
  const totalTok = Math.max(0, Math.round(input.totalTokens ?? promptTok + compTok));
  const model = String(input.model ?? existing.model ?? "");
  const usedCustomApi =
    input.usedCustomApi !== undefined ? Boolean(input.usedCustomApi) : existing.usedCustomApi;
  const filesTouched = Array.isArray(input.filesTouched)
    ? Array.from(new Set(input.filesTouched.map((f) => String(f).trim()).filter(Boolean))).slice(0, 100)
    : existing.filesTouched;
  const actionsArr = Array.isArray(input.assistantActions) ? input.assistantActions : [];
  const outputSummary = String(input.outputSummary ?? "").trim().slice(0, 12_000);
  const reqSlug = String(input.requestedCalleeSlug ?? "").trim().slice(0, 80);
  const reqTask = String(input.requestedCalleeTask ?? "").trim().slice(0, 4_000);

  await q(sql`
    update agent_subagent_runs
    set status = ${input.status},
        output_summary = ${outputSummary},
        requested_callee_slug = ${reqSlug},
        requested_callee_task = ${reqTask},
        actions_count = ${actionsArr.length},
        files_touched = ${JSON.stringify(filesTouched)},
        prompt_tokens = ${promptTok},
        completion_tokens = ${compTok},
        total_tokens = ${totalTok},
        model = ${model},
        used_custom_api = ${usedCustomApi},
        updated_at = ${now}
    where id = ${input.runId} and user_id = ${input.userId}`);

  if (
    input.assistantContent !== undefined ||
    input.assistantReasoning !== undefined ||
    input.assistantActions !== undefined ||
    input.assistantError !== undefined
  ) {
    await insertAgentConversationMessage({
      userId: input.userId,
      conversationId: existing.subagentConversationId,
      role: "assistant",
      content: input.assistantContent ?? outputSummary,
      reasoning: input.assistantReasoning ?? "",
      actions: JSON.stringify(actionsArr),
      files: JSON.stringify(input.assistantFiles ?? []),
      error: input.assistantError ?? "",
    });
  }

  if (totalTok > 0) {
    await recordAgentUsage({
      userId: input.userId,
      kind: "agent",
      model,
      prompt: promptTok,
      completion: compTok,
      total: totalTok,
      refId: existing.subagentConversationId,
    }).catch(() => undefined);
  }

  return getSubagentRun(input.userId, input.runId);
}

export function normalizeSubagentRoutingMode(raw: unknown): SubagentRoutingMode {
  return String(raw ?? "").trim().toLowerCase() === "layered" ? "layered" : "linear";
}

export function normalizeOverseerMode(raw: unknown): OverseerMode {
  return String(raw ?? "").trim().toLowerCase() === "rules_only" ? "rules_only" : "strict";
}

const DEFAULT_ORCHESTRATION_PUBLIC: AgentOrchestrationConfigPublic = {
  routingMode: "linear",
  orchestratorPosX: null,
  orchestratorPosY: null,
  overseer: {
    enabled: true,
    mode: "strict",
    systemPrompt: "",
    unlockApi: false,
    provider: "custom",
    baseUrl: "",
    model: "",
    hasApiKey: false,
    apiKeyHint: "",
  },
};

function mapOrchestrationPublic(row: Raw | null | undefined): AgentOrchestrationConfigPublic {
  if (!row) {
    return {
      routingMode: DEFAULT_ORCHESTRATION_PUBLIC.routingMode,
      orchestratorPosX: null,
      orchestratorPosY: null,
      overseer: { ...DEFAULT_ORCHESTRATION_PUBLIC.overseer },
    };
  }
  const encrypted = String(row.overseer_api_key_encrypted ?? "");
  return {
    routingMode: normalizeSubagentRoutingMode(row.subagent_routing_mode),
    orchestratorPosX: normalizeCoord(row.orchestrator_pos_x),
    orchestratorPosY: normalizeCoord(row.orchestrator_pos_y),
    overseer: {
      enabled: row.overseer_enabled === undefined ? true : toBool(row.overseer_enabled),
      mode: normalizeOverseerMode(row.overseer_mode),
      systemPrompt: String(row.overseer_system_prompt ?? ""),
      unlockApi: toBool(row.overseer_unlock_api),
      provider: String(row.overseer_provider ?? "custom") || "custom",
      baseUrl: String(row.overseer_base_url ?? ""),
      model: String(row.overseer_model ?? ""),
      hasApiKey: encrypted.length > 0,
      apiKeyHint: String(row.overseer_api_key_hint ?? ""),
    },
  };
}

export async function getAgentOrchestrationConfigPublic(
  userId: number,
): Promise<AgentOrchestrationConfigPublic> {
  const row = await q1(sql`
    select subagent_routing_mode,
           orchestrator_pos_x,
           orchestrator_pos_y,
           overseer_enabled,
           overseer_mode,
           overseer_system_prompt,
           overseer_unlock_api,
           overseer_provider,
           overseer_base_url,
           overseer_model,
           overseer_api_key_encrypted,
           overseer_api_key_hint
    from ai_user_settings
    where user_id = ${userId}
    limit 1`);
  return mapOrchestrationPublic(row);
}

export async function getAgentOrchestrationConfigSecret(
  userId: number,
): Promise<AgentOrchestrationConfigSecret> {
  const row = await q1(sql`
    select subagent_routing_mode,
           orchestrator_pos_x,
           orchestrator_pos_y,
           overseer_enabled,
           overseer_mode,
           overseer_system_prompt,
           overseer_unlock_api,
           overseer_provider,
           overseer_base_url,
           overseer_model,
           overseer_api_key_encrypted,
           overseer_api_key_hint
    from ai_user_settings
    where user_id = ${userId}
    limit 1`);
  const pub = mapOrchestrationPublic(row);
  let apiKey = "";
  if (pub.overseer.unlockApi && row?.overseer_api_key_encrypted) {
    try {
      apiKey = decryptSecret(String(row.overseer_api_key_encrypted));
    } catch {
      apiKey = "";
    }
  }
  return {
    routingMode: pub.routingMode,
    orchestratorPosX: pub.orchestratorPosX,
    orchestratorPosY: pub.orchestratorPosY,
    overseer: {
      ...pub.overseer,
      apiKey,
    },
  };
}

export type UpsertAgentOrchestrationInput = {
  routingMode?: SubagentRoutingMode;
  orchestratorPosX?: number | null;
  orchestratorPosY?: number | null;
  overseer?: {
    enabled?: boolean;
    mode?: OverseerMode;
    systemPrompt?: string;
    unlockApi?: boolean;
    provider?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    clearApiKey?: boolean;
  };
};

export async function upsertAgentOrchestrationConfig(
  userId: number,
  input: UpsertAgentOrchestrationInput,
): Promise<AgentOrchestrationConfigPublic> {
  const now = nowIso();
  const existing = await q1(sql`
    select id,
           subagent_routing_mode,
           orchestrator_pos_x,
           orchestrator_pos_y,
           overseer_enabled,
           overseer_mode,
           overseer_system_prompt,
           overseer_unlock_api,
           overseer_provider,
           overseer_base_url,
           overseer_model,
           overseer_api_key_encrypted,
           overseer_api_key_hint
    from ai_user_settings
    where user_id = ${userId}
    limit 1`);

  const cur = mapOrchestrationPublic(existing);
  const nextRouting =
    input.routingMode !== undefined
      ? normalizeSubagentRoutingMode(input.routingMode)
      : cur.routingMode;
  const nextOrchPosX =
    input.orchestratorPosX !== undefined ? normalizeCoord(input.orchestratorPosX) : cur.orchestratorPosX;
  const nextOrchPosY =
    input.orchestratorPosY !== undefined ? normalizeCoord(input.orchestratorPosY) : cur.orchestratorPosY;

  const ov = input.overseer ?? {};
  // Надсмотрщик всегда остаётся активным для защиты Sandbox; режим можно выбрать ('strict' | 'rules_only').
  const nextEnabled = ov.enabled !== undefined ? Boolean(ov.enabled) : cur.overseer.enabled;
  const nextMode = ov.mode !== undefined ? normalizeOverseerMode(ov.mode) : cur.overseer.mode;
  const nextPrompt =
    ov.systemPrompt !== undefined
      ? String(ov.systemPrompt ?? "").trim().slice(0, 16_000)
      : cur.overseer.systemPrompt;
  const nextUnlockApi =
    ov.unlockApi !== undefined ? Boolean(ov.unlockApi) : cur.overseer.unlockApi;
  const nextProvider =
    ov.provider !== undefined
      ? String(ov.provider ?? "").trim().slice(0, 40) || "custom"
      : cur.overseer.provider;
  const nextBaseUrl =
    ov.baseUrl !== undefined
      ? ov.baseUrl
        ? normalizeBaseUrl(String(ov.baseUrl).slice(0, 400)) ?? ""
        : ""
      : cur.overseer.baseUrl;
  const nextModel =
    ov.model !== undefined
      ? String(ov.model ?? "").trim().slice(0, 200)
      : cur.overseer.model;

  let nextEncrypted = String(existing?.overseer_api_key_encrypted ?? "");
  let nextHint = String(existing?.overseer_api_key_hint ?? "");
  if (ov.clearApiKey) {
    nextEncrypted = "";
    nextHint = "";
  } else if (typeof ov.apiKey === "string" && ov.apiKey.trim()) {
    const cleanKey = ov.apiKey.trim().slice(0, 500);
    nextEncrypted = encryptSecret(cleanKey);
    nextHint = maskSecret(cleanKey);
  }

  if (existing) {
    await q(sql`
      update ai_user_settings
      set subagent_routing_mode = ${nextRouting},
          orchestrator_pos_x = ${nextOrchPosX},
          orchestrator_pos_y = ${nextOrchPosY},
          overseer_enabled = ${nextEnabled},
          overseer_mode = ${nextMode},
          overseer_system_prompt = ${nextPrompt},
          overseer_unlock_api = ${nextUnlockApi},
          overseer_provider = ${nextProvider},
          overseer_base_url = ${nextBaseUrl},
          overseer_model = ${nextModel},
          overseer_api_key_encrypted = ${nextEncrypted},
          overseer_api_key_hint = ${nextHint},
          updated_at = ${now}
      where user_id = ${userId}`);
  } else {
    await q(sql`
      insert into ai_user_settings (
        user_id, base_url, api_key_encrypted, api_key_hint, model,
        subagent_routing_mode, orchestrator_pos_x, orchestrator_pos_y,
        overseer_enabled, overseer_mode, overseer_system_prompt,
        overseer_unlock_api, overseer_provider, overseer_base_url, overseer_model,
        overseer_api_key_encrypted, overseer_api_key_hint, created_at, updated_at
      ) values (
        ${userId}, '', '', '', '',
        ${nextRouting}, ${nextOrchPosX}, ${nextOrchPosY},
        ${nextEnabled}, ${nextMode}, ${nextPrompt},
        ${nextUnlockApi}, ${nextProvider}, ${nextBaseUrl}, ${nextModel},
        ${nextEncrypted}, ${nextHint}, ${now}, ${now}
      )`);
  }

  return getAgentOrchestrationConfigPublic(userId);
}

/* ------------- управление запусками: heartbeat, отмена, retry, реапер ------------- */

/**
 * Обновляет `updated_at` запуска — используется как heartbeat во время стрима,
 * чтобы реапер не считал живой запуск зависшим.
 */
export async function touchSubagentRun(userId: number, runId: number): Promise<void> {
  await q(sql`
    update agent_subagent_runs
    set updated_at = ${nowIso()}
    where id = ${runId} and user_id = ${userId} and status = 'running'`);
}

/** Останавливает «висящий» запуск: `running` -> `cancelled`. Возвращает актуальную запись. */
export async function cancelSubagentRun(
  userId: number,
  runId: number,
  reason = "Запуск остановлен пользователем",
): Promise<AgentSubagentRunRow | null> {
  const current = await getSubagentRun(userId, runId);
  if (!current) return null;
  if (current.status !== "running") return current;
  await q(sql`
    update agent_subagent_runs
    set status = 'cancelled',
        output_summary = ${String(reason || "Запуск остановлен пользователем").slice(0, 4000)},
        updated_at = ${nowIso()}
    where id = ${runId} and user_id = ${userId}`);
  return getSubagentRun(userId, runId);
}

/**
 * Перезапуск задачи субагента: старый «висящий» запуск закрывается как `cancelled`,
 * создаётся новый запуск в том же изолированном чате с тем же контекстом (input_summary).
 * Модель не вызывается — UI получает новый `run` и может отправить ход заново.
 */
export async function retrySubagentRun(
  userId: number,
  runId: number,
): Promise<{ run: AgentSubagentRunRow; conversation: AgentConversationRow } | null> {
  const current = await getSubagentRun(userId, runId);
  if (!current) return null;
  if (current.status === "running") {
    await cancelSubagentRun(userId, runId, "Запуск перезапущен пользователем");
  }
  return createSubagentRunWithConversation({
    userId,
    subagentId: current.subagentId,
    agentConversationId: current.agentConversationId ?? null,
    existingConversationId: current.subagentConversationId,
    callerKind: current.callerKind,
    callerSubagentId: current.callerSubagentId ?? null,
    sandboxProject: current.sandboxProject,
    inputSummary: current.inputSummary,
    taskPrompt: current.requestedCalleeTask || "",
    model: current.model,
    usedCustomApi: current.usedCustomApi,
  });
}

/**
 * Реапер «осиротевших» запусков: помечает `error` все `running`-запуски пользователя,
 * которые не подавали heartbeat дольше `maxAgeMs`. Возвращает число закрытых запусков.
 */
export async function reapStaleSubagentRuns(
  userId: number,
  options?: { maxAgeMs?: number },
): Promise<number> {
  const maxAgeMs = Math.max(60_000, Math.floor(options?.maxAgeMs ?? SUBAGENT_RUN_STALE_MS));
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const stale = await q<{ id: number }>(sql`
    select id from agent_subagent_runs
    where user_id = ${userId} and status = 'running' and updated_at < ${cutoff}`);
  if (!stale.length) return 0;
  const now = nowIso();
  for (const row of stale) {
    const rid = toNum(row.id);
    if (!rid) continue;
    await q(sql`
      update agent_subagent_runs
      set status = 'error',
          output_summary = ${"Запуск прерван: соединение с агентом закрыто, heartbeat не поступал. Используйте «Повторить», чтобы продолжить задачу."},
          updated_at = ${now}
      where id = ${rid} and user_id = ${userId} and status = 'running'`);
  }
  return stale.length;
}

/**
 * Версия семантического состояния дерева зависимостей (без координат узлов —
 * они косметические и сохраняются last-write-wins).
 * Используется для оптимистичных блокировок при сохранении дерева.
 */
export function computeSubagentsTreeVersion(
  subagents: AgentSubagentPublic[],
  orchestration?: { routingMode?: string | null } | null,
): string {
  const rows = [...subagents]
    .sort((a, b) => a.id - b.id)
    .map((s) =>
      [
        s.id,
        s.isActive ? 1 : 0,
        s.parentSubagentId ?? 0,
        s.orchestratorCanCall ? 1 : 0,
        [...s.allowedCallees].map((c) => String(c).trim().toLowerCase()).sort().join("|"),
      ].join("~"),
    );
  rows.push(`mode:${String(orchestration?.routingMode ?? "")}`);
  return createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 16);
}
