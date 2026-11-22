import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { nowIso, q, q1, toBool, toIso, toNum } from "../dialect";
import { hashOpaqueToken, safeEqualText } from "@/lib/crypto";
import { agentTaskStatusSchema } from "@/lib/validation";
import {
  findTaskMode,
  normalizeCoachMode,
  normalizeTaskMode,
  normalizeTaskSource,
  type OperatorCoachMode,
  type OperatorTaskMode,
  type OperatorTaskSource,
  type TaskGuidanceNote,
} from "@/lib/operatorModes";
import { normalizeTrustLevel, type TrustLevel } from "@/lib/trust";
import { AGENT_MAX_STEPS, isUnlimitedStepsRole, resolveStepsForRole } from "@/lib/genParams";
import { decryptGithubToken, encryptGithubToken, maskGithubToken } from "@/lib/github";
import { readStoredBase64, saveStoredBase64 } from "@/lib/storage";
import type { Role } from "../schema";
import { aiMonthKey, dayAgoIso, getUserRoleById, maskToken, parseJsonObject, type Raw } from "./shared";

export type AgentTaskApprovalRequest = {
  id: string;
  kind: "dangerous_action" | "step_limit" | "sandbox_export" | "shell_command";
  title: string;
  description: string;
  action?: Record<string, unknown>;
  extraSteps?: number;
  requestedAt: string;
};

export type AgentTaskApprovalDecision = {
  id: string;
  decision: "approved" | "rejected" | "extend_steps";
  extraSteps?: number;
  note?: string;
  decidedAt: string;
};

export type AgentTaskRow = {
  id: number;
  userId: number;
  prompt: string;
  status: string;
  maxSteps: number;
  steps: number;
  summary: string;
  trustLevel: TrustLevel;
  taskMode: OperatorTaskMode;
  source: OperatorTaskSource;
  coachMode: OperatorCoachMode;
  guidanceNote: TaskGuidanceNote | null;
  pendingApproval: AgentTaskApprovalRequest | null;
  approvalResponse: AgentTaskApprovalDecision | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentEventRow = {
  id: number;
  taskId: number;
  kind: string;
  text: string;
  action: string;
  fileName: string;
  fileMime: string;
  fileSize: number;
  hasFile: boolean;
  createdAt: string;
};

export type AgentBotConnectionStatus = {
  state: "online" | "stale" | "never" | "no_tokens";
  connected: boolean;
  secondsAgo: number | null;
  lastSeenAt: string | null;
  tokenName: string;
  tokenHint: string;
  connectionName: string;
  tokensCount: number;
  totalTokensCount: number;
  runningTask: { id: number; steps: number; maxSteps: number; updatedAt: string } | null;
  queue: { queued: number; running: number };
};

export type AgentConnectionRow = {
  id: number;
  userId: number;
  name: string;
  serverUrl: string;
  isDefault: boolean;
  tokensCount: number;
  activeTokens: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentTokenRow = {
  id: number;
  connectionId: number;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt?: string | null;
  isExpired?: boolean;
  expiringSoon?: boolean;
};

export type AgentConversationKind = "plan" | "agent" | "tester";

export type TesterIssue = {
  title: string;
  description: string;
  file?: string;
  line?: number;
  fixHint?: string;
  severity: "critical" | "minor";
};

export type TesterCheck = {
  name: string;
  tool?: string;
  status: "pass" | "fail" | "warn";
  details: string;
};

export type TesterRunStatus = "running" | "passed" | "minor_issues" | "critical_issues" | "error";

export type TesterMinorDecision = "not_needed" | "pending" | "approved" | "rejected";

export type AgentTesterRunRow = {
  id: number;
  userId: number;
  agentConversationId: number | null;
  testerConversationId: number;
  sandboxProject: string;
  summary: string;
  status: TesterRunStatus;
  reportSummary: string;
  criticalIssues: TesterIssue[];
  minorIssues: TesterIssue[];
  checksRun: TesterCheck[];
  minorDecision: TesterMinorDecision;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentConversationRow = {
  id: number;
  userId: number;
  kind: AgentConversationKind;
  title: string;
  systemPrompt: string;
  messagesCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentConversationMessageRow = {
  id: number;
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  reasoning: string;
  attachments: unknown[];
  actions: unknown[];
  files: unknown[];
  error: string;
  createdAt: string;
};

export type AgentTranscriptRow = {
  id: number;
  userId: number;
  conversationId: number;
  title: string;
  summary: string;
  fileName: string;
  content: string;
  chars: number;
  createdAt: string;
};

export type AgentUsageKind = "agent" | "operator";

export type AgentUsageTotals = {
  prompt: number;
  completion: number;
  total: number;
  events: number;
};

export type AgentUsageSummaryData = {
  currentMonth: string;
  month: {
    agent: AgentUsageTotals;
    operator: AgentUsageTotals;
    total: AgentUsageTotals;
  };
  all: {
    agent: AgentUsageTotals;
    operator: AgentUsageTotals;
    total: AgentUsageTotals;
  };
};

export type UserAgentUsageRow = {
  userId: number;
  name: string;
  email: string;
  role: Role;
  canUseAgent: boolean;
  canUseOperator: boolean;
  monthAgent: number;
  monthOperator: number;
  monthTotal: number;
  allAgent: number;
  allOperator: number;
  allTotal: number;
};

export type GithubConnectionPublic = {
  id: number;
  userId: number;
  githubUserId: number;
  login: string;
  name: string;
  email: string;
  avatarUrl: string;
  tokenHint: string;
  scopes: string;
  selectedOwner: string;
  selectedRepo: string;
  selectedBranch: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GithubConnectionWithSecret = GithubConnectionPublic & {
  token: string;
};

function mapAgentTask(r: Raw): AgentTaskRow {
  return {
    id: toNum(r.id),
    userId: toNum(r.user_id),
    prompt: String(r.prompt ?? ""),
    status: String(r.status ?? "queued"),
    maxSteps: toNum(r.max_steps),
    steps: toNum(r.steps),
    summary: String(r.summary ?? ""),
    trustLevel: normalizeTrustLevel(r.trust_level),
    taskMode: normalizeTaskMode(r.task_mode),
    source: normalizeTaskSource(r.source),
    coachMode: normalizeCoachMode(r.coach_mode),
    guidanceNote: parseJsonObject<TaskGuidanceNote>(r.guidance_note),
    pendingApproval: parseJsonObject<AgentTaskApprovalRequest>(r.pending_approval),
    approvalResponse: parseJsonObject<AgentTaskApprovalDecision>(r.approval_response),
    createdAt: toIso(r.created_at) ?? nowIso(),
    updatedAt: toIso(r.updated_at) ?? nowIso(),
  };
}

const OPERATOR_TOKEN_TTL_DAYS = 90;
const OPERATOR_TOKEN_TTL_MS = OPERATOR_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
const OPERATOR_TOKEN_WARN_MS = 14 * 24 * 60 * 60 * 1000;
const TOKEN_TOUCH_MIN_MS = 60_000;
const STALE_REAP_THROTTLE_MS = 60_000;

const globalForAgentPerf = globalThis as typeof globalThis & {
  __crmTokenTouchMap?: Map<string, number>;
  __crmLastStaleReapMs?: number;
};

function tokenTouchMap(): Map<string, number> {
  if (!globalForAgentPerf.__crmTokenTouchMap) {
    globalForAgentPerf.__crmTokenTouchMap = new Map();
  }
  return globalForAgentPerf.__crmTokenTouchMap;
}

function defaultTokenExpiryIso(fromMs = Date.now()): string {
  return new Date(fromMs + OPERATOR_TOKEN_TTL_MS).toISOString();
}

export async function getAgentToken(userId: number): Promise<string | null> {
  // Возвращается только маскированная подсказка, никогда не сырой токен (P0-2).
  const row = await q1<{ token_hint: string }>(sql`
    select token_hint from agent_connection_tokens
    where user_id = ${userId} and revoked_at is null
    order by id desc limit 1`);
  return row?.token_hint ? String(row.token_hint) : null;
}

export async function saveAgentToken(userId: number, token: string): Promise<void> {
  const hashed = token.startsWith("sha256:") ? token : hashOpaqueToken(token);
  const existing = await q1<{ id: number }>(sql`select id from agent_tokens where user_id = ${userId} limit 1`);
  if (existing) {
    await q(sql`update agent_tokens set token = ${hashed} where user_id = ${userId}`);
    return;
  }
  await q(sql`insert into agent_tokens (user_id, token, created_at) values (${userId}, ${hashed}, ${nowIso()})`);
}

export async function findAgentTokenOwner(
  token: string,
  options?: { touch?: boolean },
): Promise<number | null> {
  if (!token) return null;
  const candidateHash = hashOpaqueToken(token);
  const now = nowIso();
  const nowMs = Date.now();

  const fresh = await q1<{
    id: number;
    user_id: number;
    token_hash: string;
    token: string;
    expires_at: unknown;
    last_used_at: unknown;
    revoked_at: unknown;
  }>(sql`
    select t.id, t.user_id, t.token_hash, t.token, t.expires_at, t.last_used_at, t.revoked_at
    from agent_connection_tokens t
    join users u on u.id = t.user_id
    where (t.token_hash = ${candidateHash} or t.token = ${candidateHash})
      and t.revoked_at is null
      and u.deleted_at is null
    limit 1`);

  if (fresh) {
    const storedHash = String(fresh.token_hash || fresh.token || "");
    if (!safeEqualText(storedHash, candidateHash)) return null;

    const expIso = toIso(fresh.expires_at);
    const expMs = expIso ? new Date(expIso).getTime() : NaN;
    const lastUsedIso = toIso(fresh.last_used_at);
    const lastUsedMs = lastUsedIso ? new Date(lastUsedIso).getTime() : NaN;
    const inactiveExpired = !Number.isNaN(lastUsedMs) && nowMs - lastUsedMs > OPERATOR_TOKEN_TTL_MS;
    const ttlExpired = !Number.isNaN(expMs) && expMs <= nowMs;

    if (ttlExpired || inactiveExpired) {
      await q(sql`update agent_connection_tokens set revoked_at = ${now} where id = ${toNum(fresh.id)}`);
      return null;
    }

    if (options?.touch !== false) {
      const cache = tokenTouchMap();
      const prevTouch = cache.get(candidateHash) ?? 0;
      if (nowMs - prevTouch >= TOKEN_TOUCH_MIN_MS) {
        if (cache.size > 10_000) cache.clear();
        cache.set(candidateHash, nowMs);
        await q(sql`update agent_connection_tokens set last_used_at = ${now} where id = ${toNum(fresh.id)}`);
      }
    }
    return toNum(fresh.user_id);
  }

  return null;
}

const BOT_ONLINE_WINDOW_SEC = 30;
const BOT_RUNNING_TASK_WINDOW_SEC = 120;

export async function getAgentBotConnectionStatus(
  userId: number,
  connectionId?: number,
): Promise<AgentBotConnectionStatus> {
  await maybeReapStaleAgentTasks();
  const scopeId = connectionId && connectionId > 0 ? connectionId : 0;
  const now = nowIso();

  const totalConnRow = await q1<{ count: number }>(sql`
    select count(*) as count from agent_connection_tokens
    where user_id = ${userId} and revoked_at is null and (expires_at is null or expires_at > ${now})`);
  const totalTokensCount = toNum(totalConnRow?.count);

  const tokenRows = scopeId
    ? await q(sql`
        select t.id, t.name, t.token_hint, t.last_used_at, c.name as connection_name
        from agent_connection_tokens t
        join agent_connections c on c.id = t.connection_id
        where t.user_id = ${userId} and t.connection_id = ${scopeId}
          and t.revoked_at is null and (t.expires_at is null or t.expires_at > ${now})
        order by t.last_used_at desc, t.id desc`)
    : await q(sql`
        select t.id, t.name, t.token_hint, t.last_used_at, c.name as connection_name
        from agent_connection_tokens t
        join agent_connections c on c.id = t.connection_id
        where t.user_id = ${userId}
          and t.revoked_at is null and (t.expires_at is null or t.expires_at > ${now})
        order by t.last_used_at desc, t.id desc`);

  const tokensCount = scopeId ? tokenRows.length : totalTokensCount;
  let latestRow: Raw | null = null;
  let latestMs = -1;
  for (const row of tokenRows) {
    const iso = toIso(row.last_used_at);
    if (!iso) continue;
    const ms = new Date(iso).getTime();
    if (!Number.isNaN(ms) && ms > latestMs) {
      latestMs = ms;
      latestRow = row;
    }
  }

  const queuedRow = await q1<{ count: number }>(sql`
    select count(*) as count from agent_tasks where user_id = ${userId} and status = 'queued'`);
  const runningCountRow = await q1<{ count: number }>(sql`
    select count(*) as count from agent_tasks where user_id = ${userId} and status in ('running', 'waiting_approval', 'waiting_steps')`);
  const runningRow = await q1(sql`
    select id, steps, max_steps, updated_at
    from agent_tasks
    where user_id = ${userId} and status in ('running', 'waiting_approval', 'waiting_steps')
    order by updated_at desc, id desc limit 1`);

  const nowMs = Date.now();
  const lastSeenAt = latestRow ? toIso(latestRow.last_used_at) : null;
  const secondsAgo = latestMs >= 0 ? Math.max(0, Math.round((nowMs - latestMs) / 1000)) : null;

  const runningTask = runningRow
    ? {
        id: toNum(runningRow.id),
        steps: toNum(runningRow.steps),
        maxSteps: toNum(runningRow.max_steps),
        updatedAt: toIso(runningRow.updated_at) ?? nowIso(),
      }
    : null;
  const runningMs = runningTask ? new Date(runningTask.updatedAt).getTime() : NaN;
  const runningSecondsAgo = !Number.isNaN(runningMs) ? Math.max(0, Math.round((nowMs - runningMs) / 1000)) : null;

  const connected =
    (secondsAgo !== null && secondsAgo <= BOT_ONLINE_WINDOW_SEC) ||
    (runningSecondsAgo !== null && runningSecondsAgo <= BOT_RUNNING_TASK_WINDOW_SEC);

  let state: AgentBotConnectionStatus["state"];
  if (tokensCount === 0) state = "no_tokens";
  else if (connected) state = "online";
  else if (lastSeenAt !== null) state = "stale";
  else state = "never";

  return {
    state,
    connected,
    secondsAgo,
    lastSeenAt,
    tokenName: latestRow ? String(latestRow.name ?? "") : "",
    tokenHint: latestRow ? String(latestRow.token_hint ?? "") : "",
    connectionName: latestRow ? String(latestRow.connection_name ?? "") : "",
    tokensCount,
    totalTokensCount,
    runningTask,
    queue: {
      queued: toNum(queuedRow?.count),
      running: toNum(runningCountRow?.count),
    },
  };
}

function mapAgentConnection(row: Raw): AgentConnectionRow {
  return {
    id: toNum(row.id),
    userId: toNum(row.user_id),
    name: String(row.name ?? ""),
    serverUrl: String(row.server_url ?? ""),
    isDefault: toBool(row.is_default),
    tokensCount: toNum(row.tokens_count),
    activeTokens: toNum(row.active_tokens),
    createdAt: toIso(row.created_at) ?? nowIso(),
    updatedAt: toIso(row.updated_at) ?? nowIso(),
  };
}

function mapAgentToken(row: Raw): AgentTokenRow {
  const expiresAt = toIso(row.expires_at);
  const expMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
  const nowMs = Date.now();
  const isExpired = !Number.isNaN(expMs) && expMs <= nowMs;
  const expiringSoon = !isExpired && !Number.isNaN(expMs) && expMs - nowMs <= OPERATOR_TOKEN_WARN_MS;
  const hint = String(row.token_hint ?? "") || maskToken(String(row.token ?? ""));
  return {
    id: toNum(row.id),
    connectionId: toNum(row.connection_id),
    name: String(row.name ?? ""),
    hint,
    createdAt: toIso(row.created_at) ?? nowIso(),
    lastUsedAt: toIso(row.last_used_at),
    expiresAt,
    isExpired,
    expiringSoon,
  };
}

export async function listAgentConnections(userId: number): Promise<AgentConnectionRow[]> {
  const now = nowIso();
  const rows = await q(sql`
    select c.*,
           (select count(*) from agent_connection_tokens t where t.connection_id = c.id and t.revoked_at is null) as tokens_count,
           (select count(*) from agent_connection_tokens t
              where t.connection_id = c.id
                and t.revoked_at is null
                and (t.expires_at is null or t.expires_at > ${now})
                and (t.last_used_at is null or t.last_used_at > ${dayAgoIso()})) as active_tokens
    from agent_connections c
    where c.user_id = ${userId}
    order by c.is_default desc, c.id`);
  return rows.map(mapAgentConnection);
}

export async function getAgentConnection(userId: number, id: number): Promise<AgentConnectionRow | null> {
  const now = nowIso();
  const row = await q1(sql`
    select c.*,
           (select count(*) from agent_connection_tokens t where t.connection_id = c.id and t.revoked_at is null) as tokens_count,
           (select count(*) from agent_connection_tokens t
              where t.connection_id = c.id
                and t.revoked_at is null
                and (t.expires_at is null or t.expires_at > ${now})
                and (t.last_used_at is null or t.last_used_at > ${dayAgoIso()})) as active_tokens
    from agent_connections c
    where c.id = ${id} and c.user_id = ${userId} limit 1`);
  return row ? mapAgentConnection(row) : null;
}

export async function createAgentConnection(
  userId: number,
  name: string,
  serverUrl: string,
): Promise<AgentConnectionRow> {
  const now = nowIso();
  const existing = await q1<{ count: number }>(
    sql`select count(*) as count from agent_connections where user_id = ${userId}`,
  );
  const isDefault = toNum(existing?.count) === 0;
  const inserted = await q1<{ id: number }>(sql`
    insert into agent_connections (user_id, name, server_url, is_default, created_at, updated_at)
    values (${userId}, ${name}, ${serverUrl}, ${isDefault}, ${now}, ${now}) returning id`);
  const id = toNum(inserted?.id);
  const created = await getAgentConnection(userId, id);
  if (!created) throw new Error("Не удалось создать подключение");
  return created;
}

export async function updateAgentConnection(
  userId: number,
  id: number,
  patch: { name?: string; serverUrl?: string },
): Promise<AgentConnectionRow | null> {
  const current = await getAgentConnection(userId, id);
  if (!current) return null;
  const name = patch.name?.trim() || current.name;
  const serverUrl = patch.serverUrl !== undefined ? patch.serverUrl.trim() : current.serverUrl;
  await q(sql`update agent_connections set name = ${name}, server_url = ${serverUrl}, updated_at = ${nowIso()}
    where id = ${id} and user_id = ${userId}`);
  return getAgentConnection(userId, id);
}

export async function setDefaultAgentConnection(userId: number, id: number): Promise<boolean> {
  const current = await getAgentConnection(userId, id);
  if (!current) return false;
  await q(sql`update agent_connections set is_default = false where user_id = ${userId}`);
  await q(sql`update agent_connections set is_default = true, updated_at = ${nowIso()}
    where id = ${id} and user_id = ${userId}`);
  return true;
}

export async function deleteAgentConnection(userId: number, id: number): Promise<boolean> {
  const current = await getAgentConnection(userId, id);
  if (!current) return false;
  await q(sql`delete from agent_connection_tokens where connection_id = ${id}`);
  await q(sql`delete from agent_connections where id = ${id} and user_id = ${userId}`);
  if (current.isDefault) {
    const next = await q1<{ id: number }>(
      sql`select id from agent_connections where user_id = ${userId} order by id limit 1`,
    );
    if (next) await setDefaultAgentConnection(userId, toNum(next.id));
  }
  return true;
}

export async function listAgentTokens(userId: number, connectionId: number): Promise<AgentTokenRow[]> {
  const rows = await q(sql`
    select id, connection_id, name, token, token_hint, expires_at, created_at, last_used_at
    from agent_connection_tokens
    where user_id = ${userId} and connection_id = ${connectionId} and revoked_at is null
    order by id desc`);
  return rows.map(mapAgentToken);
}

export async function countAgentTokens(userId: number, connectionId: number): Promise<number> {
  const row = await q1<{ count: number }>(sql`
    select count(*) as count from agent_connection_tokens
    where user_id = ${userId} and connection_id = ${connectionId} and revoked_at is null`);
  return toNum(row?.count);
}

export async function createAgentConnectionToken(
  userId: number,
  connectionId: number,
  name: string,
): Promise<{ token: string; item: AgentTokenRow } | null> {
  const connection = await getAgentConnection(userId, connectionId);
  if (!connection) return null;
  const token = `crmop_${randomBytes(24).toString("hex")}`;
  const tokenHash = hashOpaqueToken(token);
  const hint = maskToken(token);
  const now = nowIso();
  const expiresAt = defaultTokenExpiryIso();
  const inserted = await q1<{ id: number }>(sql`
    insert into agent_connection_tokens (connection_id, user_id, name, token, token_hash, token_hint, expires_at, created_at)
    values (${connectionId}, ${userId}, ${name}, ${tokenHash}, ${tokenHash}, ${hint}, ${expiresAt}, ${now}) returning id`);
  const id = toNum(inserted?.id);
  return {
    token,
    item: {
      id,
      connectionId,
      name,
      hint,
      createdAt: now,
      lastUsedAt: null,
      expiresAt,
      isExpired: false,
      expiringSoon: false,
    },
  };
}

/**
 * Перевыпускает токен (ротация): старый хеш немедленно заменяется новым и больше не работает,
 * новый токен возвращается единоразово.
 */
export async function reissueAgentConnectionToken(
  userId: number,
  tokenId: number,
): Promise<{ token: string; item: AgentTokenRow } | null> {
  const row = await q1(sql`
    select id, connection_id, name, token_hash, token
    from agent_connection_tokens
    where id = ${tokenId} and user_id = ${userId} and revoked_at is null
    limit 1`);
  if (!row) return null;

  const oldHash = String(row.token_hash || row.token || "");
  if (oldHash) tokenTouchMap().delete(oldHash);

  const token = `crmop_${randomBytes(24).toString("hex")}`;
  const tokenHash = hashOpaqueToken(token);
  const hint = maskToken(token);
  const now = nowIso();
  const expiresAt = defaultTokenExpiryIso();

  await q(sql`
    update agent_connection_tokens
    set token = ${tokenHash},
        token_hash = ${tokenHash},
        token_hint = ${hint},
        created_at = ${now},
        last_used_at = ${null},
        expires_at = ${expiresAt},
        revoked_at = ${null}
    where id = ${tokenId} and user_id = ${userId}`);

  return {
    token,
    item: {
      id: toNum(row.id),
      connectionId: toNum(row.connection_id),
      name: String(row.name ?? ""),
      hint,
      createdAt: now,
      lastUsedAt: null,
      expiresAt,
      isExpired: false,
      expiringSoon: false,
    },
  };
}

export async function deleteAgentConnectionToken(userId: number, tokenId: number): Promise<boolean> {
  const row = await q1<{ id: number; token_hash: string; token: string }>(
    sql`select id, token_hash, token from agent_connection_tokens where id = ${tokenId} and user_id = ${userId} limit 1`,
  );
  if (!row) return false;
  const oldHash = String(row.token_hash || row.token || "");
  if (oldHash) tokenTouchMap().delete(oldHash);
  await q(sql`delete from agent_connection_tokens where id = ${tokenId} and user_id = ${userId}`);
  return true;
}

export async function createAgentTask(
  userId: number,
  prompt: string,
  maxSteps: number,
  trustLevel: TrustLevel = "verified",
  options?: {
    taskMode?: OperatorTaskMode;
    source?: OperatorTaskSource;
    coachMode?: OperatorCoachMode;
  },
): Promise<AgentTaskRow> {
  const now = nowIso();
  const safeTrust = normalizeTrustLevel(trustLevel);
  const taskMode = normalizeTaskMode(options?.taskMode);
  const source = normalizeTaskSource(options?.source);
  const coachMode = normalizeCoachMode(options?.coachMode);
  const ownerRole = await getUserRoleById(userId);
  const safeMaxSteps = resolveStepsForRole(ownerRole, maxSteps, isUnlimitedStepsRole(ownerRole) ? 0 : 15);
  const row = await q1<{ id: number }>(sql`
    insert into agent_tasks (user_id, prompt, status, max_steps, steps, summary, trust_level, task_mode, source, coach_mode, guidance_note, pending_approval, approval_response, created_at, updated_at)
    values (${userId}, ${prompt}, 'queued', ${safeMaxSteps}, 0, '', ${safeTrust}, ${taskMode}, ${source}, ${coachMode}, '', '', '', ${now}, ${now}) returning id`);
  const id = toNum(row?.id);
  return {
    id,
    userId,
    prompt,
    status: "queued",
    maxSteps: safeMaxSteps,
    steps: 0,
    summary: "",
    trustLevel: safeTrust,
    taskMode,
    source,
    coachMode,
    guidanceNote: null,
    pendingApproval: null,
    approvalResponse: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function listAgentTasks(userId: number, limit = 100): Promise<AgentTaskRow[]> {
  await maybeReapStaleAgentTasks();
  const rows = await q(sql`
    select id, user_id, prompt, status, max_steps, steps, summary, trust_level, task_mode, source, coach_mode, guidance_note, pending_approval, approval_response, created_at, updated_at
    from agent_tasks where user_id = ${userId} order by id desc limit ${Math.max(1, Math.floor(limit))}`);
  return rows.map(mapAgentTask);
}

export async function getAgentTask(userId: number, id: number): Promise<AgentTaskRow | null> {
  const row = await q1(sql`
    select id, user_id, prompt, status, max_steps, steps, summary, trust_level, task_mode, source, coach_mode, guidance_note, pending_approval, approval_response, created_at, updated_at
    from agent_tasks where id = ${id} and user_id = ${userId} limit 1`);
  return row ? mapAgentTask(row) : null;
}

export async function setAgentTaskGuidance(
  taskId: number,
  userId: number,
  input: {
    id?: string;
    author: "agent" | "user" | "operator";
    text: string;
    userAdvice?: string;
    addEvent?: boolean;
  },
): Promise<{ task: AgentTaskRow; guidance: TaskGuidanceNote } | null> {
  const task = await getAgentTask(userId, taskId);
  if (!task || task.status === "cancelled" || task.status === "done") return null;
  const now = nowIso();
  const cleanText = String(input.text ?? "").trim();
  if (!cleanText) return null;
  const guidance: TaskGuidanceNote = {
    id: input.id || `guid_${taskId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    author: input.author,
    text: cleanText,
    ...(input.userAdvice?.trim() ? { userAdvice: input.userAdvice.trim() } : {}),
    createdAt: now,
  };
  await q(sql`
    update agent_tasks
    set guidance_note = ${JSON.stringify(guidance)},
        updated_at = ${now}
    where id = ${taskId} and user_id = ${userId}`);
  if (input.addEvent !== false) {
    const prefix =
      input.author === "agent"
        ? "🤖 Совет Агента: "
        : input.author === "user"
          ? "👤 Подсказка пользователя: "
          : "💡 Что делать дальше: ";
    const adviceTail =
      guidance.userAdvice && guidance.userAdvice !== cleanText
        ? `\nПользователю: ${guidance.userAdvice}`
        : "";
    await addAgentEvent({
      taskId,
      kind: "guidance",
      text: `${prefix}${cleanText}${adviceTail}`,
    });
  }
  const updated = await getAgentTask(userId, taskId);
  return updated ? { task: updated, guidance } : null;
}

export async function getAgentTaskForBot(id: number, userId: number): Promise<AgentTaskRow | null> {
  return getAgentTask(userId, id);
}

function defaultStaleTimeoutMs(): number {
  const mins = Number(process.env.AGENT_TASK_STALE_MINUTES ?? 15);
  const safeMins = Number.isFinite(mins) && mins >= 1 ? mins : 15;
  return safeMins * 60_000;
}

/**
 * Переводит зависшие задачи (`running`, `waiting_approval`, `waiting_steps`),
 * не обновлявшиеся дольше `maxIdleMs`, в статус `failed` с записью в лог.
 */
export async function reapStaleAgentTasks(maxIdleMs = defaultStaleTimeoutMs()): Promise<number> {
  const cutoff = new Date(Date.now() - Math.max(1000, maxIdleMs)).toISOString();
  const now = nowIso();
  const staleMsg = "Задача остановлена по таймауту (нет отклика от бота)";
  const reaped = await q<{ id: number }>(sql`
    update agent_tasks
    set status = 'failed',
        pending_approval = '',
        summary = case when summary = '' then ${staleMsg} else summary end,
        updated_at = ${now}
    where status in ('running', 'waiting_approval', 'waiting_steps')
      and updated_at < ${cutoff}
    returning id`);
  for (const row of reaped) {
    await addAgentEvent({ taskId: toNum(row.id), kind: "error", text: staleMsg }).catch(() => undefined);
  }
  return reaped.length;
}

export async function maybeReapStaleAgentTasks(): Promise<void> {
  const nowMs = Date.now();
  const prev = globalForAgentPerf.__crmLastStaleReapMs ?? 0;
  if (nowMs - prev < STALE_REAP_THROTTLE_MS) return;
  globalForAgentPerf.__crmLastStaleReapMs = nowMs;
  await reapStaleAgentTasks().catch(() => undefined);
}

/**
 * Атомарный захват следующей задачи из очереди (без гонки между двумя ботами).
 */
export async function claimAgentTask(userId: number): Promise<AgentTaskRow | null> {
  await maybeReapStaleAgentTasks();
  const now = nowIso();
  const taken = await q1<{ id: number }>(sql`
    update agent_tasks
    set status = 'running', updated_at = ${now}
    where id = (
      select id from agent_tasks
      where user_id = ${userId} and status = 'queued'
      order by id asc limit 1
    )
      and user_id = ${userId}
      and status = 'queued'
    returning id`);
  if (!taken) return null;
  return getAgentTask(userId, toNum(taken.id));
}

export async function setAgentTaskStatus(
  id: number,
  userId: number,
  status: string,
  summary?: string,
): Promise<void> {
  const parsedStatus = agentTaskStatusSchema.parse(status);
  const now = nowIso();
  const clearPending = ["done", "failed", "cancelled"].includes(parsedStatus);
  if (summary === undefined) {
    await q(sql`update agent_tasks
      set status = ${parsedStatus},
          pending_approval = case when ${clearPending} then '' else pending_approval end,
          updated_at = ${now}
      where id = ${id} and user_id = ${userId}`);
    return;
  }
  await q(sql`
    update agent_tasks
    set status = ${parsedStatus},
        summary = ${summary},
        pending_approval = case when ${clearPending} then '' else pending_approval end,
        updated_at = ${now}
    where id = ${id} and user_id = ${userId}`);
}

export async function requestAgentTaskApproval(
  taskId: number,
  userId: number,
  input: {
    id: string;
    kind: AgentTaskApprovalRequest["kind"];
    title: string;
    description: string;
    action?: Record<string, unknown>;
    extraSteps?: number;
  },
): Promise<AgentTaskApprovalRequest | null> {
  const task = await getAgentTask(userId, taskId);
  if (!task || task.status === "cancelled") return null;
  const now = nowIso();
  const reqPayload: AgentTaskApprovalRequest = {
    id: input.id,
    kind: input.kind,
    title: input.title.slice(0, 240),
    description: input.description.slice(0, 2000),
    ...(input.action ? { action: input.action } : {}),
    ...(input.extraSteps ? { extraSteps: input.extraSteps } : {}),
    requestedAt: now,
  };
  const nextStatus = input.kind === "step_limit" ? "waiting_steps" : "waiting_approval";
  await q(sql`
    update agent_tasks
    set status = ${nextStatus},
        pending_approval = ${JSON.stringify(reqPayload)},
        approval_response = '',
        updated_at = ${now}
    where id = ${taskId} and user_id = ${userId}`);
  await addAgentEvent({
    taskId,
    kind: "approval",
    text: `${reqPayload.title}${reqPayload.description ? ` — ${reqPayload.description}` : ""}`,
    action: input.action ? JSON.stringify(input.action) : "",
  });
  return reqPayload;
}

export async function respondAgentTaskApproval(
  taskId: number,
  userId: number,
  input: {
    approvalId?: string;
    decision: "approved" | "rejected" | "extend_steps";
    extraSteps?: number;
    note?: string;
  },
): Promise<AgentTaskRow | null> {
  const task = await getAgentTask(userId, taskId);
  if (!task || task.status === "cancelled") return null;
  const now = nowIso();
  const ownerRole = await getUserRoleById(userId);
  const unlimited = isUnlimitedStepsRole(ownerRole);
  const id = input.approvalId || task.pendingApproval?.id || `appr_${Date.now()}`;
  const requestedAdd = Math.max(1, Math.round(input.extraSteps || 15));
  const addSteps =
    input.decision === "extend_steps"
      ? unlimited
        ? requestedAdd
        : Math.max(0, Math.min(AGENT_MAX_STEPS - task.maxSteps, requestedAdd))
      : 0;
  const nextMaxSteps =
    input.decision === "extend_steps"
      ? unlimited
        ? task.maxSteps === 0
          ? 0
          : task.maxSteps + addSteps
        : Math.min(AGENT_MAX_STEPS, task.maxSteps + addSteps)
      : task.maxSteps;
  const decisionPayload: AgentTaskApprovalDecision = {
    id,
    decision: input.decision,
    ...(addSteps > 0 ? { extraSteps: addSteps } : {}),
    ...(input.note ? { note: input.note.slice(0, 500) } : {}),
    decidedAt: now,
  };

  await q(sql`
    update agent_tasks
    set status = 'running',
        max_steps = ${nextMaxSteps},
        pending_approval = '',
        approval_response = ${JSON.stringify(decisionPayload)},
        updated_at = ${now}
    where id = ${taskId} and user_id = ${userId}`);

  const eventText =
    input.decision === "extend_steps"
      ? nextMaxSteps === 0
        ? "Лимит шагов снят (без лимита) — продолжаем с текущего шага"
        : `Лимит шагов расширен (+${addSteps}) до ${nextMaxSteps} — продолжаем с текущего шага`
      : input.decision === "approved"
        ? `Пользователь на сайте разрешил действие${input.note ? `: ${input.note}` : ""}`
        : `Пользователь на сайте отклонил действие${input.note ? `: ${input.note}` : ""}`;
  await addAgentEvent({ taskId, kind: "info", text: eventText });
  return getAgentTask(userId, taskId);
}

export async function extendAgentTaskSteps(
  taskId: number,
  userId: number,
  addStepsRaw: number,
): Promise<AgentTaskRow | null> {
  const task = await getAgentTask(userId, taskId);
  if (!task || task.status === "cancelled" || task.status === "done") return null;
  const ownerRole = await getUserRoleById(userId);
  const unlimited = isUnlimitedStepsRole(ownerRole);
  const addSteps = Math.max(1, Math.round(addStepsRaw || 15));
  const nextMaxSteps = unlimited
    ? task.maxSteps === 0
      ? 0
      : Math.max(task.maxSteps + addSteps, task.steps + 1)
    : Math.min(AGENT_MAX_STEPS, Math.max(task.maxSteps + addSteps, task.steps + 1));
  const actualAdded = nextMaxSteps - task.maxSteps;
  if (task.pendingApproval?.kind === "step_limit") {
    return respondAgentTaskApproval(taskId, userId, {
      approvalId: task.pendingApproval.id,
      decision: "extend_steps",
      extraSteps: Math.max(1, actualAdded),
    });
  }
  const now = nowIso();
  const nextStatus = task.status === "waiting_steps" ? "running" : task.status;
  await q(sql`
    update agent_tasks
    set max_steps = ${nextMaxSteps},
        status = ${nextStatus},
        updated_at = ${now}
    where id = ${taskId} and user_id = ${userId}`);
  await addAgentEvent({
    taskId,
    kind: "info",
    text:
      nextMaxSteps === 0
        ? "Задача выполняется без лимита шагов"
        : `Лимит шагов увеличен до ${nextMaxSteps} (+${actualAdded})`,
  });
  return getAgentTask(userId, taskId);
}

export async function bumpAgentTaskStep(id: number): Promise<void> {
  await q(sql`update agent_tasks set steps = steps + 1, updated_at = ${nowIso()} where id = ${id}`);
}

/** Сохраняет событие Оператора; бинарные файлы и скриншоты выносятся в файловое хранилище. */
export async function addAgentEvent(input: {
  taskId: number;
  kind: string;
  text?: string;
  action?: string;
  fileName?: string;
  fileMime?: string;
  fileSize?: number;
  fileData?: string;
}): Promise<number> {
  let storageKey = "";
  let fileSize = input.fileSize ?? 0;
  if (input.fileData) {
    const category = input.kind === "screen" ? "screens" : "agent";
    const stored = await saveStoredBase64(category, input.fileData, input.fileName || "file.bin");
    storageKey = stored.storageKey;
    if (!fileSize) fileSize = stored.byteSize;
  }
  const row = await q1<{ id: number }>(sql`
    insert into agent_events (task_id, kind, text, action, file_name, file_mime, file_size, storage_key, file_data, created_at)
    values (${input.taskId}, ${input.kind}, ${input.text ?? ""}, ${input.action ?? ""},
            ${input.fileName ?? ""}, ${input.fileMime ?? ""}, ${fileSize}, ${storageKey}, '',
            ${nowIso()}) returning id`);
  return toNum(row?.id);
}

export async function listAgentEvents(taskId: number, limit = 10_000): Promise<AgentEventRow[]> {
  const safeLimit = Math.floor(Number(limit));
  const rows =
    safeLimit > 0
      ? await q(sql`
          select id, task_id, kind, text, action, file_name, file_mime, file_size, created_at,
            case when file_data = '' and storage_key = '' then 0 else 1 end as has_file
          from agent_events where task_id = ${taskId} order by id asc limit ${safeLimit}`)
      : await q(sql`
          select id, task_id, kind, text, action, file_name, file_mime, file_size, created_at,
            case when file_data = '' and storage_key = '' then 0 else 1 end as has_file
          from agent_events where task_id = ${taskId} order by id asc`);
  return rows.map((r) => ({
    id: toNum(r.id),
    taskId: toNum(r.task_id),
    kind: String(r.kind ?? "info"),
    text: String(r.text ?? ""),
    action: String(r.action ?? ""),
    fileName: String(r.file_name ?? ""),
    fileMime: String(r.file_mime ?? ""),
    fileSize: toNum(r.file_size),
    hasFile: toNum(r.has_file) === 1,
    createdAt: toIso(r.created_at) ?? nowIso(),
  }));
}

export async function getAgentEventFile(
  eventId: number,
): Promise<{ name: string; mime: string; data: string; userId: number; taskId: number } | null> {
  const row = await q1(sql`
    select e.file_name, e.file_mime, e.storage_key, e.file_data, t.user_id, e.task_id
    from agent_events e join agent_tasks t on t.id = e.task_id
    where e.id = ${eventId} and (e.file_data <> '' or e.storage_key <> '') limit 1`);
  if (!row) return null;
  const storageKey = String(row.storage_key ?? "");
  let data = String(row.file_data ?? "");
  if (storageKey) {
    const diskData = await readStoredBase64(storageKey);
    if (diskData !== null) data = diskData;
  }
  if (!data) return null;
  return {
    name: String(row.file_name ?? "файл"),
    mime: String(row.file_mime ?? "application/octet-stream"),
    data,
    userId: toNum(row.user_id),
    taskId: toNum(row.task_id),
  };
}

export async function getLatestAgentScreen(taskId: number): Promise<{
  eventId: number;
  summary: string;
  meta: Record<string, unknown> | null;
  dataUrl: string;
  createdAt: string;
} | null> {
  const row = await q1(sql`
    select id, text, action, file_mime, storage_key, file_data, created_at
    from agent_events
    where task_id = ${taskId} and kind = 'screen'
    order by id desc limit 1`);
  if (!row) return null;
  const storageKey = String(row.storage_key ?? "");
  let data = String(row.file_data ?? "");
  if (storageKey) {
    const diskData = await readStoredBase64(storageKey);
    if (diskData !== null) data = diskData;
  }
  const mime = String(row.file_mime ?? "image/jpeg") || "image/jpeg";
  let meta: Record<string, unknown> | null = null;
  const rawAction = String(row.action ?? "");
  if (rawAction.trim().startsWith("{")) {
    try {
      meta = JSON.parse(rawAction) as Record<string, unknown>;
    } catch {
      meta = null;
    }
  }
  return {
    eventId: toNum(row.id),
    summary: String(row.text ?? ""),
    meta,
    dataUrl: data ? `data:${mime};base64,${data}` : "",
    createdAt: toIso(row.created_at) ?? nowIso(),
  };
}

/* ---------------------- история агента и планировщика --------------------- */

function parseStoredArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapAgentConversation(row: Raw): AgentConversationRow {
  const rawKind = String(row.kind ?? "agent");
  const kind: AgentConversationKind =
    rawKind === "plan" ? "plan" : rawKind === "tester" ? "tester" : "agent";
  return {
    id: toNum(row.id),
    userId: toNum(row.user_id),
    kind,
    title: String(row.title ?? "Новый чат"),
    systemPrompt: String(row.system_prompt ?? ""),
    messagesCount: toNum(row.messages_count),
    createdAt: toIso(row.created_at) ?? nowIso(),
    updatedAt: toIso(row.updated_at) ?? nowIso(),
  };
}

export async function listAgentConversations(
  userId: number,
  kind: AgentConversationKind,
  limit = 500,
): Promise<AgentConversationRow[]> {
  const rows = await q(sql`select c.*,
      (select count(*) from agent_conversation_messages m where m.conversation_id = c.id) as messages_count
    from agent_conversations c
    where c.user_id = ${userId} and c.kind = ${kind}
    order by c.updated_at desc, c.id desc limit ${Math.max(1, Math.floor(limit))}`);
  return rows.map(mapAgentConversation);
}

export async function getAgentConversation(userId: number, id: number): Promise<AgentConversationRow | null> {
  const row = await q1(sql`select c.*,
      (select count(*) from agent_conversation_messages m where m.conversation_id = c.id) as messages_count
    from agent_conversations c where c.id = ${id} and c.user_id = ${userId} limit 1`);
  return row ? mapAgentConversation(row) : null;
}

export async function createAgentConversation(
  userId: number,
  kind: AgentConversationKind,
  title = kind === "plan" ? "Новый план" : kind === "tester" ? "Тестирование" : "Новый чат",
  systemPrompt = "",
): Promise<AgentConversationRow> {
  const now = nowIso();
  const row = await q1<{ id: number }>(sql`insert into agent_conversations
      (user_id, kind, title, system_prompt, created_at, updated_at)
    values (${userId}, ${kind}, ${title.slice(0, 120)}, ${systemPrompt}, ${now}, ${now}) returning id`);
  return {
    id: toNum(row?.id),
    userId,
    kind,
    title: title.slice(0, 120),
    systemPrompt,
    messagesCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateAgentConversation(
  userId: number,
  id: number,
  input: { title?: string; systemPrompt?: string },
): Promise<AgentConversationRow | null> {
  const current = await getAgentConversation(userId, id);
  if (!current) return null;
  const title = input.title === undefined ? current.title : input.title.slice(0, 120);
  const systemPrompt = input.systemPrompt === undefined ? current.systemPrompt : input.systemPrompt;
  await q(sql`update agent_conversations
    set title = ${title}, system_prompt = ${systemPrompt}, updated_at = ${nowIso()}
    where id = ${id} and user_id = ${userId}`);
  return getAgentConversation(userId, id);
}

export async function deleteAgentConversation(userId: number, id: number): Promise<boolean> {
  const current = await getAgentConversation(userId, id);
  if (!current) return false;
  await q(sql`delete from agent_tester_runs where tester_conversation_id = ${id} and user_id = ${userId}`);
  await q(sql`delete from agent_conversation_messages where conversation_id = ${id}`);
  await q(sql`delete from agent_conversations where id = ${id} and user_id = ${userId}`);
  return true;
}

export async function listAgentConversationMessages(conversationId: number): Promise<AgentConversationMessageRow[]> {
  const rows = await q(sql`select id, conversation_id, role, content, reasoning, attachments, actions, files, error, created_at
    from agent_conversation_messages where conversation_id = ${conversationId} order by id asc limit 400`);
  return rows.map((row) => ({
    id: toNum(row.id),
    conversationId: toNum(row.conversation_id),
    role: row.role === "assistant" ? "assistant" : "user",
    content: String(row.content ?? ""),
    reasoning: String(row.reasoning ?? ""),
    attachments: parseStoredArray(row.attachments),
    actions: parseStoredArray(row.actions),
    files: parseStoredArray(row.files),
    error: String(row.error ?? ""),
    createdAt: toIso(row.created_at) ?? nowIso(),
  }));
}

export async function insertAgentConversationMessage(input: {
  userId: number;
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  attachments?: string;
  actions?: string;
  files?: string;
  error?: string;
}): Promise<AgentConversationMessageRow | null> {
  const createdAt = nowIso();
  const row = await q1<{ id: number }>(sql`insert into agent_conversation_messages
      (conversation_id, role, content, reasoning, attachments, actions, files, error, created_at)
    select id, ${input.role}, ${input.content}, ${input.reasoning ?? ""}, ${input.attachments ?? "[]"},
      ${input.actions ?? "[]"}, ${input.files ?? "[]"}, ${input.error ?? ""}, ${createdAt}
    from agent_conversations where id = ${input.conversationId} and user_id = ${input.userId}
    returning id`);
  if (!row) return null;

  const title = input.content.replace(/\s+/g, " ").trim().slice(0, 80);
  await q(sql`update agent_conversations set
      title = case
        when ${input.role} = 'user' and title in ('Новый план', 'Новый чат', 'Тестирование') and ${title} <> '' then ${title}
        else title
      end,
      updated_at = ${createdAt}
    where id = ${input.conversationId} and user_id = ${input.userId}`);

  return {
    id: toNum(row.id),
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    reasoning: input.reasoning ?? "",
    attachments: parseStoredArray(input.attachments),
    actions: parseStoredArray(input.actions),
    files: parseStoredArray(input.files),
    error: input.error ?? "",
    createdAt,
  };
}

export async function findOperatorTaskConversation(
  userId: number,
  taskId: number,
): Promise<AgentConversationRow | null> {
  const marker = `operator_task:${taskId}`;
  const row = await q1(sql`select c.*,
      (select count(*) from agent_conversation_messages m where m.conversation_id = c.id) as messages_count
    from agent_conversations c
    where c.user_id = ${userId} and c.kind = 'agent' and c.system_prompt = ${marker}
    order by c.id desc limit 1`);
  return row ? mapAgentConversation(row) : null;
}

const OP_STATUS_LABELS: Record<string, string> = {
  queued: "в очереди",
  running: "выполняется",
  waiting_approval: "ждёт подтверждения",
  waiting_steps: "лимит шагов",
  done: "готово",
  failed: "ошибка",
  cancelled: "отменено",
  paused: "пауза",
};

export async function syncOperatorTaskToConversation(
  userId: number,
  taskId: number,
  options?: { onlyIfExisting?: boolean },
): Promise<number | null> {
  const task = await getAgentTask(userId, taskId);
  if (!task) return null;

  let conv = await findOperatorTaskConversation(userId, task.id);
  if (!conv && options?.onlyIfExisting) {
    return null;
  }

  const events = await listAgentEvents(task.id, 0);

  const marker = `operator_task:${task.id}`;
  const cleanPromptTitle = task.prompt.replace(/\s+/g, " ").trim().slice(0, 64);
  const title = `Оператор #${task.id}: ${cleanPromptTitle || "задача на ПК"}`.slice(0, 120);

  if (!conv) {
    conv = await createAgentConversation(userId, "agent", title, marker);
  }

  const modeLabel = findTaskMode(task.taskMode).shortLabel;
  const statusLabel = OP_STATUS_LABELS[task.status] ?? task.status;
  const userContent = `Задача для Оператора #${task.id} (${modeLabel}, доверие: ${task.trustLevel}):\n${task.prompt}`;

  const reasoningLines: string[] = [];
  const dialogueLines: string[] = [
    `Диалог Агент ↔ Оператор #${task.id} · статус: ${statusLabel} · ${task.maxSteps <= 0 ? `шагов ${task.steps} (без лимита)` : `шагов ${task.steps}/${task.maxSteps}`}`,
  ];
  const filesMeta: Array<{ name: string; mime: string; size: number }> = [];
  let lastErrorText = "";

  for (const ev of events) {
    const text = ev.text.trim();
    if (ev.kind === "thought") {
      if (text) {
        reasoningLines.push(`💭 ${text}`);
        dialogueLines.push(`💭 Размышление: ${text}`);
      }
      continue;
    }
    if (ev.kind === "guidance") {
      if (text) {
        reasoningLines.push(`🤝 ${text}`);
        dialogueLines.push(text);
      }
      continue;
    }
    if (ev.kind === "action") {
      const desc = text || ev.action;
      if (desc) dialogueLines.push(`▸ Действие: ${desc}`);
      continue;
    }
    if (ev.kind === "result") {
      if (text) dialogueLines.push(`Проверка: ${text}`);
      continue;
    }
    if (ev.kind === "approval") {
      if (text) {
        reasoningLines.push(`🔐 ${text}`);
        dialogueLines.push(`🔐 Запрос разрешения: ${text}`);
      }
      continue;
    }
    if (ev.kind === "file") {
      filesMeta.push({
        name: ev.fileName || text || "файл",
        mime: ev.fileMime || "application/octet-stream",
        size: ev.fileSize || 0,
      });
      dialogueLines.push(`📎 Файл: ${ev.fileName || text}`);
      continue;
    }
    if (ev.kind === "screen") {
      if (text) dialogueLines.push(`📷 Снимок экрана: ${text}`);
      continue;
    }
    if (ev.kind === "error") {
      if (text) {
        lastErrorText = text;
        reasoningLines.push(`⚠️ ${text}`);
        dialogueLines.push(`⚠️ Ошибка: ${text}`);
      }
      continue;
    }
    if (text) {
      if (
        text.includes("Навёл курсор") ||
        text.includes("совещаюсь") ||
        text.includes("зацикливан") ||
        text.includes("Результата нет") ||
        text.includes("не подтверждено")
      ) {
        reasoningLines.push(`🎯 ${text}`);
      }
      dialogueLines.push(`ℹ️ ${text}`);
    }
  }

  if (task.summary) {
    const line = `Итог: ${task.summary}`;
    if (!dialogueLines.some((l) => l.includes(task.summary))) {
      dialogueLines.push(line);
    }
  } else if (events.length === 0) {
    dialogueLines.push("Ожидаю первого шага и размышлений Оператора…");
  }

  const assistantContent = dialogueLines.join("\n");
  const assistantReasoning = reasoningLines.join("\n\n");
  const assistantActions = JSON.stringify([
    {
      type: "operator_task",
      taskId: task.id,
      task: task.prompt.slice(0, 300),
      mode: task.taskMode,
    },
  ]);
  const assistantFiles = JSON.stringify(filesMeta);
  const assistantError = task.status === "failed" ? (task.summary || lastErrorText) : "";

  const existing = await listAgentConversationMessages(conv.id);
  const now = nowIso();
  if (existing.length === 0) {
    await insertAgentConversationMessage({
      userId,
      conversationId: conv.id,
      role: "user",
      content: userContent,
    });
    await insertAgentConversationMessage({
      userId,
      conversationId: conv.id,
      role: "assistant",
      content: assistantContent,
      reasoning: assistantReasoning,
      actions: assistantActions,
      files: assistantFiles,
      error: assistantError,
    });
  } else {
    const assistantMsg = existing.find((m) => m.role === "assistant");
    if (assistantMsg) {
      await q(sql`update agent_conversation_messages
        set content = ${assistantContent},
            reasoning = ${assistantReasoning},
            actions = ${assistantActions},
            files = ${assistantFiles},
            error = ${assistantError}
        where id = ${assistantMsg.id} and conversation_id = ${conv.id}`);
    } else {
      await insertAgentConversationMessage({
        userId,
        conversationId: conv.id,
        role: "assistant",
        content: assistantContent,
        reasoning: assistantReasoning,
        actions: assistantActions,
        files: assistantFiles,
        error: assistantError,
      });
    }
    await q(sql`update agent_conversations set title = ${title}, updated_at = ${now}
      where id = ${conv.id} and user_id = ${userId}`);
  }

  return conv.id;
}

/* ------------------ сохранённые переписки (файлы истории) ---------------- */

function mapAgentTranscript(row: Raw): AgentTranscriptRow {
  const content = String(row.content ?? "");
  return {
    id: toNum(row.id),
    userId: toNum(row.user_id),
    conversationId: toNum(row.conversation_id),
    title: String(row.title ?? "Переписка агента"),
    summary: String(row.summary ?? ""),
    fileName: String(row.file_name ?? "transcript.md"),
    content,
    chars: toNum(row.chars) || content.length,
    createdAt: toIso(row.created_at) ?? nowIso(),
  };
}

export async function createAgentTranscript(input: {
  userId: number;
  conversationId: number;
  title: string;
  summary: string;
  fileName: string;
  content: string;
}): Promise<AgentTranscriptRow> {
  const createdAt = nowIso();
  const content = String(input.content ?? "");
  const chars = content.length;
  const row = await q1<{ id: number }>(sql`
    insert into agent_transcripts (user_id, conversation_id, title, summary, file_name, content, chars, created_at)
    values (${input.userId}, ${input.conversationId}, ${input.title.slice(0, 160)}, ${input.summary},
            ${input.fileName.slice(0, 160)}, ${content}, ${chars}, ${createdAt})
    returning id`);
  return {
    id: toNum(row?.id),
    userId: input.userId,
    conversationId: input.conversationId,
    title: input.title.slice(0, 160),
    summary: input.summary,
    fileName: input.fileName.slice(0, 160),
    content,
    chars,
    createdAt,
  };
}

export async function listAgentTranscripts(
  userId: number,
  limit = 500,
): Promise<Array<Omit<AgentTranscriptRow, "content">>> {
  const rows = await q(sql`
    select id, user_id, conversation_id, title, summary, file_name, chars, created_at
    from agent_transcripts
    where user_id = ${userId}
    order by id desc
    limit ${Math.max(1, Math.floor(limit))}`);
  return rows.map((row) => ({
    id: toNum(row.id),
    userId: toNum(row.user_id),
    conversationId: toNum(row.conversation_id),
    title: String(row.title ?? "Переписка агента"),
    summary: String(row.summary ?? ""),
    fileName: String(row.file_name ?? "transcript.md"),
    chars: toNum(row.chars),
    createdAt: toIso(row.created_at) ?? nowIso(),
  }));
}

export async function getAgentTranscript(userId: number, id: number): Promise<AgentTranscriptRow | null> {
  const row = await q1(sql`
    select id, user_id, conversation_id, title, summary, file_name, content, chars, created_at
    from agent_transcripts
    where id = ${id} and user_id = ${userId}
    limit 1`);
  return row ? mapAgentTranscript(row) : null;
}

export async function deleteAgentTranscript(userId: number, id: number): Promise<boolean> {
  const existing = await getAgentTranscript(userId, id);
  if (!existing) return false;
  await q(sql`delete from agent_transcripts where id = ${id} and user_id = ${userId}`);
  return true;
}

/* --------------- расход токенов Агента и Оператора ----------------- */

const EMPTY_AGENT_USAGE_TOTALS: AgentUsageTotals = { prompt: 0, completion: 0, total: 0, events: 0 };

function sumAgentUsageTotals(a: AgentUsageTotals, b: AgentUsageTotals): AgentUsageTotals {
  return {
    prompt: a.prompt + b.prompt,
    completion: a.completion + b.completion,
    total: a.total + b.total,
    events: a.events + b.events,
  };
}

export async function recordAgentUsage(input: {
  userId: number;
  kind: AgentUsageKind;
  refId?: number;
  model?: string;
  prompt: number;
  completion: number;
  total?: number;
}): Promise<void> {
  const prompt = Math.max(0, Math.round(input.prompt));
  const completion = Math.max(0, Math.round(input.completion));
  const total = Math.max(prompt + completion, Math.round(input.total ?? prompt + completion));
  if (total <= 0 && prompt <= 0 && completion <= 0) return;
  const month = aiMonthKey();
  await q(sql`
    insert into agent_usage_events (user_id, kind, ref_id, model, prompt_tokens, completion_tokens, total_tokens, month, created_at)
    values (${input.userId}, ${input.kind}, ${Math.max(0, Math.round(input.refId ?? 0))}, ${String(input.model ?? "").slice(0, 160)},
            ${prompt}, ${completion}, ${total}, ${month}, ${nowIso()})`);
}

export async function getAgentUsage(userId: number, month = aiMonthKey()): Promise<AgentUsageSummaryData> {
  const allRows = await q(sql`
    select kind,
      coalesce(sum(prompt_tokens), 0) as prompt,
      coalesce(sum(completion_tokens), 0) as completion,
      coalesce(sum(total_tokens), 0) as total,
      count(*) as events
    from agent_usage_events
    where user_id = ${userId}
    group by kind`);
  const monthRows = await q(sql`
    select kind,
      coalesce(sum(prompt_tokens), 0) as prompt,
      coalesce(sum(completion_tokens), 0) as completion,
      coalesce(sum(total_tokens), 0) as total,
      count(*) as events
    from agent_usage_events
    where user_id = ${userId} and month = ${month}
    group by kind`);

  const extract = (rows: Raw[], kind: AgentUsageKind): AgentUsageTotals => {
    const row = rows.find((r) => r.kind === kind);
    if (!row) return { ...EMPTY_AGENT_USAGE_TOTALS };
    return {
      prompt: toNum(row.prompt),
      completion: toNum(row.completion),
      total: toNum(row.total),
      events: toNum(row.events),
    };
  };

  const monthAgent = extract(monthRows, "agent");
  const monthOperator = extract(monthRows, "operator");
  const allAgent = extract(allRows, "agent");
  const allOperator = extract(allRows, "operator");

  return {
    currentMonth: month,
    month: {
      agent: monthAgent,
      operator: monthOperator,
      total: sumAgentUsageTotals(monthAgent, monthOperator),
    },
    all: {
      agent: allAgent,
      operator: allOperator,
      total: sumAgentUsageTotals(allAgent, allOperator),
    },
  };
}

export async function listUsersAgentUsage(month = aiMonthKey()): Promise<UserAgentUsageRow[]> {
  const rows = await q(sql`
    select u.id, u.name, u.email, u.role, u.can_use_agent, u.can_use_operator,
      coalesce((select sum(e.total_tokens) from agent_usage_events e where e.user_id = u.id and e.kind = 'agent' and e.month = ${month}), 0) as month_agent,
      coalesce((select sum(e.total_tokens) from agent_usage_events e where e.user_id = u.id and e.kind = 'operator' and e.month = ${month}), 0) as month_operator,
      coalesce((select sum(e.total_tokens) from agent_usage_events e where e.user_id = u.id and e.kind = 'agent'), 0) as all_agent,
      coalesce((select sum(e.total_tokens) from agent_usage_events e where e.user_id = u.id and e.kind = 'operator'), 0) as all_operator
    from users u
    where u.is_bot = false and u.deleted_at is null
    order by u.name asc`);
  return rows.map((r) => {
    const monthAgent = toNum(r.month_agent);
    const monthOperator = toNum(r.month_operator);
    const allAgent = toNum(r.all_agent);
    const allOperator = toNum(r.all_operator);
    return {
      userId: toNum(r.id),
      name: String(r.name ?? ""),
      email: String(r.email ?? ""),
      role: (r.role as Role) ?? "user",
      canUseAgent: toBool(r.can_use_agent) || r.role === "super_admin",
      canUseOperator: toBool(r.can_use_operator) || r.role === "super_admin",
      monthAgent,
      monthOperator,
      monthTotal: monthAgent + monthOperator,
      allAgent,
      allOperator,
      allTotal: allAgent + allOperator,
    };
  });
}

/* --------------------------- персональный GitHub Агента --------------- */

function mapGithubPublic(row: Raw): GithubConnectionPublic {
  return {
    id: toNum(row.id),
    userId: toNum(row.user_id),
    githubUserId: toNum(row.github_user_id),
    login: String(row.login ?? ""),
    name: String(row.name ?? ""),
    email: String(row.email ?? ""),
    avatarUrl: String(row.avatar_url ?? ""),
    tokenHint: String(row.token_hint ?? ""),
    scopes: String(row.scopes ?? ""),
    selectedOwner: String(row.selected_owner ?? ""),
    selectedRepo: String(row.selected_repo ?? ""),
    selectedBranch: String(row.selected_branch ?? ""),
    enabled: toBool(row.enabled),
    createdAt: toIso(row.created_at) ?? nowIso(),
    updatedAt: toIso(row.updated_at) ?? nowIso(),
  };
}

export async function getGithubConnectionPublic(userId: number): Promise<GithubConnectionPublic | null> {
  const row = await q1(sql`
    select id, user_id, github_user_id, login, name, email, avatar_url, token_hint, scopes,
      selected_owner, selected_repo, selected_branch, enabled, created_at, updated_at
    from github_connections where user_id = ${userId} limit 1`);
  return row ? mapGithubPublic(row) : null;
}

export async function getGithubConnectionWithSecret(userId: number): Promise<GithubConnectionWithSecret | null> {
  const row = await q1(sql`
    select id, user_id, github_user_id, login, name, email, avatar_url, token_encrypted, token_hint, scopes,
      selected_owner, selected_repo, selected_branch, enabled, created_at, updated_at
    from github_connections where user_id = ${userId} limit 1`);
  if (!row) return null;
  const pub = mapGithubPublic(row);
  const token = decryptGithubToken(String(row.token_encrypted ?? ""));
  if (!token) return null;
  return { ...pub, token };
}

export async function upsertGithubConnection(input: {
  userId: number;
  githubUserId: number;
  login: string;
  name: string;
  email: string;
  avatarUrl: string;
  token: string;
  scopes?: string;
  selectedOwner?: string;
  selectedRepo?: string;
  selectedBranch?: string;
  enabled?: boolean;
}): Promise<GithubConnectionPublic> {
  const now = nowIso();
  const encrypted = encryptGithubToken(input.token);
  const hint = maskGithubToken(input.token);
  const existing = await getGithubConnectionPublic(input.userId);
  if (existing) {
    const owner = input.selectedOwner !== undefined ? input.selectedOwner.trim() : existing.selectedOwner;
    const repo = input.selectedRepo !== undefined ? input.selectedRepo.trim() : existing.selectedRepo;
    const branch = input.selectedBranch !== undefined ? input.selectedBranch.trim() : existing.selectedBranch;
    const enabled = input.enabled !== undefined ? Boolean(input.enabled) : existing.enabled;
    await q(sql`
      update github_connections set
        github_user_id = ${input.githubUserId},
        login = ${input.login},
        name = ${input.name},
        email = ${input.email},
        avatar_url = ${input.avatarUrl},
        token_encrypted = ${encrypted},
        token_hint = ${hint},
        scopes = ${input.scopes ?? ""},
        selected_owner = ${owner},
        selected_repo = ${repo},
        selected_branch = ${branch},
        enabled = ${enabled},
        updated_at = ${now}
      where user_id = ${input.userId}`);
  } else {
    const enabled = input.enabled !== false;
    await q(sql`
      insert into github_connections (
        user_id, github_user_id, login, name, email, avatar_url,
        token_encrypted, token_hint, scopes,
        selected_owner, selected_repo, selected_branch, enabled, created_at, updated_at
      ) values (
        ${input.userId}, ${input.githubUserId}, ${input.login}, ${input.name}, ${input.email}, ${input.avatarUrl},
        ${encrypted}, ${hint}, ${input.scopes ?? ""},
        ${(input.selectedOwner ?? "").trim()}, ${(input.selectedRepo ?? "").trim()},
        ${(input.selectedBranch ?? "").trim()}, ${enabled}, ${now}, ${now}
      )`);
  }
  const saved = await getGithubConnectionPublic(input.userId);
  if (!saved) throw new Error("Не удалось сохранить подключение GitHub");
  return saved;
}

export async function updateGithubRepoSelection(
  userId: number,
  input: {
    selectedOwner?: string;
    selectedRepo?: string;
    selectedBranch?: string;
    enabled?: boolean;
  },
): Promise<GithubConnectionPublic | null> {
  const existing = await getGithubConnectionPublic(userId);
  if (!existing) return null;
  const owner = input.selectedOwner !== undefined ? input.selectedOwner.trim() : existing.selectedOwner;
  const repo = input.selectedRepo !== undefined ? input.selectedRepo.trim() : existing.selectedRepo;
  const branch = input.selectedBranch !== undefined ? input.selectedBranch.trim() : existing.selectedBranch;
  const enabled = input.enabled !== undefined ? Boolean(input.enabled) : existing.enabled;
  const now = nowIso();
  await q(sql`
    update github_connections set
      selected_owner = ${owner},
      selected_repo = ${repo},
      selected_branch = ${branch},
      enabled = ${enabled},
      updated_at = ${now}
    where user_id = ${userId}`);
  return getGithubConnectionPublic(userId);
}

export async function deleteGithubConnection(userId: number): Promise<boolean> {
  const existing = await getGithubConnectionPublic(userId);
  if (!existing) return false;
  await q(sql`delete from github_connections where user_id = ${userId}`);
  return true;
}

/* ----------------------- Под-агент Тестировщик ------------------------ */

function normalizeTesterStatus(raw: unknown): TesterRunStatus {
  const v = String(raw ?? "").trim();
  if (v === "passed" || v === "minor_issues" || v === "critical_issues" || v === "error") {
    return v;
  }
  return "running";
}

function normalizeMinorDecision(raw: unknown): TesterMinorDecision {
  const v = String(raw ?? "").trim();
  if (v === "pending" || v === "approved" || v === "rejected") {
    return v;
  }
  return "not_needed";
}

function normalizeTesterIssues(raw: unknown, fallbackSeverity: "critical" | "minor"): TesterIssue[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? parseStoredArray(raw) : [];
  const out: TesterIssue[] = [];
  for (const item of list.slice(0, 100)) {
    if (typeof item === "string") {
      const clean = item.trim().slice(0, 2_000);
      if (clean) {
        out.push({ title: clean.slice(0, 180), description: clean, severity: fallbackSeverity });
      }
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const title = String(obj.title ?? obj.name ?? obj.description ?? "").trim().slice(0, 240);
    const description = String(obj.description ?? obj.details ?? title).trim().slice(0, 4_000);
    if (!title && !description) continue;
    const sev = obj.severity === "critical" || obj.severity === "minor" ? obj.severity : fallbackSeverity;
    const file = typeof obj.file === "string" && obj.file.trim() ? obj.file.trim().slice(0, 300) : undefined;
    const lineNum = Number(obj.line);
    const line = Number.isFinite(lineNum) && lineNum > 0 ? Math.floor(lineNum) : undefined;
    const fixHint =
      typeof (obj.fixHint ?? obj.fix_hint) === "string" && String(obj.fixHint ?? obj.fix_hint).trim()
        ? String(obj.fixHint ?? obj.fix_hint).trim().slice(0, 1_500)
        : undefined;
    out.push({
      title: title || description.slice(0, 180),
      description: description || title,
      severity: sev,
      ...(file ? { file } : {}),
      ...(line ? { line } : {}),
      ...(fixHint ? { fixHint } : {}),
    });
  }
  return out;
}

function normalizeTesterChecks(raw: unknown): TesterCheck[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? parseStoredArray(raw) : [];
  const out: TesterCheck[] = [];
  for (const item of list.slice(0, 100)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const name = String(obj.name ?? obj.check ?? "Проверка").trim().slice(0, 240);
    const details = String(obj.details ?? obj.output ?? "").trim().slice(0, 2_000);
    const rawStatus = String(obj.status ?? "pass").toLowerCase();
    const status: TesterCheck["status"] =
      rawStatus === "fail" ? "fail" : rawStatus === "warn" ? "warn" : "pass";
    const tool = typeof obj.tool === "string" && obj.tool.trim() ? obj.tool.trim().slice(0, 120) : undefined;
    out.push({ name, status, details, ...(tool ? { tool } : {}) });
  }
  return out;
}

function mapTesterRun(row: Raw): AgentTesterRunRow {
  const agentConvNum = toNum(row.agent_conversation_id);
  return {
    id: toNum(row.id),
    userId: toNum(row.user_id),
    agentConversationId: agentConvNum > 0 ? agentConvNum : null,
    testerConversationId: toNum(row.tester_conversation_id),
    sandboxProject: String(row.sandbox_project ?? ""),
    summary: String(row.summary ?? ""),
    status: normalizeTesterStatus(row.status),
    reportSummary: String(row.report_summary ?? ""),
    criticalIssues: normalizeTesterIssues(row.critical_issues, "critical"),
    minorIssues: normalizeTesterIssues(row.minor_issues, "minor"),
    checksRun: normalizeTesterChecks(row.checks_run),
    minorDecision: normalizeMinorDecision(row.minor_decision),
    promptTokens: toNum(row.prompt_tokens),
    completionTokens: toNum(row.completion_tokens),
    totalTokens: toNum(row.total_tokens),
    model: String(row.model ?? ""),
    createdAt: toIso(row.created_at) ?? nowIso(),
    updatedAt: toIso(row.updated_at) ?? nowIso(),
  };
}

export function formatTesterReportMessage(input: {
  sandboxProject?: string;
  status: TesterRunStatus;
  reportSummary: string;
  criticalIssues: TesterIssue[];
  minorIssues: TesterIssue[];
  checksRun: TesterCheck[];
  fullResponse?: string;
}): string {
  const lines: string[] = [];
  const statusLabel =
    input.status === "passed"
      ? "Проверка пройдена без замечаний"
      : input.status === "critical_issues"
        ? "Найдены критические ошибки (требуется исправление Агентом)"
        : input.status === "minor_issues"
          ? "Критических ошибок нет, найдены некритические/мелкие замечания"
          : input.status === "error"
            ? "Тестирование завершилось с ошибкой"
            : "Выполняется тестирование";
  lines.push(`Статус проверки: ${statusLabel}`);
  if (input.sandboxProject) {
    lines.push(`Проект в Sandbox: ${input.sandboxProject}`);
  }
  if (input.reportSummary.trim()) {
    lines.push("", input.reportSummary.trim());
  }
  if (input.criticalIssues.length > 0) {
    lines.push("", `Критические ошибки (${input.criticalIssues.length}):`);
    for (const issue of input.criticalIssues) {
      const loc = issue.file ? ` [${issue.file}${issue.line ? `:${issue.line}` : ""}]` : "";
      lines.push(`- ${issue.title}${loc}: ${issue.description}`);
    }
  }
  if (input.minorIssues.length > 0) {
    lines.push("", `Мелкие / некритические замечания (${input.minorIssues.length}):`);
    for (const issue of input.minorIssues) {
      const loc = issue.file ? ` [${issue.file}${issue.line ? `:${issue.line}` : ""}]` : "";
      lines.push(`- ${issue.title}${loc}: ${issue.description}`);
    }
  }
  if (input.checksRun.length > 0) {
    lines.push("", `Выполненные проверки (${input.checksRun.length}):`);
    for (const chk of input.checksRun) {
      const badge = chk.status === "pass" ? "OK" : chk.status === "fail" ? "FAIL" : "WARN";
      lines.push(`- [${badge}] ${chk.name}: ${chk.details}`);
    }
  }
  const full = String(input.fullResponse ?? "").trim();
  if (full && !lines.join("\n").includes(full.slice(0, 80))) {
    lines.push("", "Подробный комментарий тестировщика:", full);
  }
  return lines.join("\n").slice(0, 48_000);
}

export async function createTesterRunWithConversation(input: {
  userId: number;
  agentConversationId?: number | null;
  testerConversationId?: number | null;
  title?: string;
  sandboxProject?: string;
  summary: string;
  model?: string;
  skipInitialMessage?: boolean;
}): Promise<{ run: AgentTesterRunRow; conversation: AgentConversationRow }> {
  const cleanProject = String(input.sandboxProject ?? "").trim().slice(0, 300);
  const cleanSummary = String(input.summary ?? "").trim().slice(0, 48_000);
  const agentConvId =
    typeof input.agentConversationId === "number" && input.agentConversationId > 0
      ? Math.floor(input.agentConversationId)
      : null;

  let conversation: AgentConversationRow | null = null;
  if (typeof input.testerConversationId === "number" && input.testerConversationId > 0) {
    const existing = await getAgentConversation(input.userId, Math.floor(input.testerConversationId));
    if (existing && existing.kind === "tester") {
      conversation = existing;
    }
  }
  if (!conversation) {
    const rawTitle = String(input.title ?? "").trim();
    const convTitle =
      rawTitle ||
      (cleanProject && cleanProject !== "."
        ? `Тест: ${cleanProject}`
        : cleanSummary.replace(/\s+/g, " ").trim().slice(0, 60) || "Тестирование проекта");
    conversation = await createAgentConversation(
      input.userId,
      "tester",
      convTitle.slice(0, 120),
      agentConvId ? `agent_chat:${agentConvId}` : "",
    );
  }

  const promptContent = cleanProject
    ? `Проект Sandbox: ${cleanProject}\n\nSummary от Агента:\n${cleanSummary}`
    : cleanSummary;
  if (!input.skipInitialMessage && promptContent.trim()) {
    await insertAgentConversationMessage({
      userId: input.userId,
      conversationId: conversation.id,
      role: "user",
      content: promptContent.slice(0, 48_000),
    });
  }

  const now = nowIso();
  const row = await q1<{ id: number }>(sql`insert into agent_tester_runs
      (user_id, agent_conversation_id, tester_conversation_id, sandbox_project, summary, status, model, created_at, updated_at)
    values (
      ${input.userId}, ${agentConvId}, ${conversation.id}, ${cleanProject},
      ${cleanSummary}, 'running', ${String(input.model ?? "").slice(0, 160)}, ${now}, ${now}
    ) returning id`);

  const run = await getTesterRun(input.userId, toNum(row?.id));
  if (!run) throw new Error("Не удалось создать прогон Тестировщика");
  const refreshedConv = (await getAgentConversation(input.userId, conversation.id)) ?? conversation;
  return { run, conversation: refreshedConv };
}

export async function completeTesterRun(
  userId: number,
  runId: number,
  input: {
    status: TesterRunStatus;
    reportSummary?: string;
    criticalIssues?: unknown;
    minorIssues?: unknown;
    checksRun?: unknown;
    minorDecision?: TesterMinorDecision;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    model?: string;
    fullResponse?: string;
    reasoning?: string;
    actions?: unknown[];
    files?: unknown[];
    error?: string;
    skipUsageRecord?: boolean;
  },
): Promise<AgentTesterRunRow | null> {
  const existing = await getTesterRun(userId, runId);
  if (!existing) return null;

  const critical = normalizeTesterIssues(input.criticalIssues, "critical");
  const minor = normalizeTesterIssues(input.minorIssues, "minor");
  const checks = normalizeTesterChecks(input.checksRun);
  let status = normalizeTesterStatus(input.status);
  if (status === "running") {
    status = critical.length > 0 ? "critical_issues" : minor.length > 0 ? "minor_issues" : "passed";
  }
  const minorDecision: TesterMinorDecision =
    input.minorDecision !== undefined
      ? normalizeMinorDecision(input.minorDecision)
      : minor.length > 0
        ? "pending"
        : "not_needed";
  const promptTokens = Math.max(0, Math.round(Number(input.promptTokens ?? 0) || 0));
  const completionTokens = Math.max(0, Math.round(Number(input.completionTokens ?? 0) || 0));
  const totalTokens = Math.max(
    promptTokens + completionTokens,
    Math.round(Number(input.totalTokens ?? 0) || 0),
  );
  const reportSummary = String(input.reportSummary ?? input.fullResponse ?? "").trim().slice(0, 16_000);
  const model = String(input.model ?? existing.model ?? "").slice(0, 160);
  const now = nowIso();

  await q(sql`update agent_tester_runs set
      status = ${status},
      report_summary = ${reportSummary},
      critical_issues = ${JSON.stringify(critical)},
      minor_issues = ${JSON.stringify(minor)},
      checks_run = ${JSON.stringify(checks)},
      minor_decision = ${minorDecision},
      prompt_tokens = ${promptTokens},
      completion_tokens = ${completionTokens},
      total_tokens = ${totalTokens},
      model = ${model},
      updated_at = ${now}
    where id = ${runId} and user_id = ${userId}`);

  const assistantText = formatTesterReportMessage({
    sandboxProject: existing.sandboxProject,
    status,
    reportSummary,
    criticalIssues: critical,
    minorIssues: minor,
    checksRun: checks,
    fullResponse: input.fullResponse,
  });
  const storedFiles = Array.isArray(input.files)
    ? input.files
        .filter((f): f is Record<string, unknown> => Boolean(f && typeof f === "object"))
        .map((f) => ({
          name: String(f.name ?? "файл").slice(0, 240),
          mime: String(f.mime ?? "application/octet-stream").slice(0, 160),
          size: Math.max(0, Math.round(Number(f.size ?? 0) || 0)),
        }))
    : [];
  const storedActions = Array.isArray(input.actions) ? input.actions.slice(0, 60) : [];

  await insertAgentConversationMessage({
    userId,
    conversationId: existing.testerConversationId,
    role: "assistant",
    content: assistantText,
    reasoning: String(input.reasoning ?? "").slice(0, 48_000),
    actions: JSON.stringify(storedActions),
    files: JSON.stringify(storedFiles),
    error: String(input.error ?? "").slice(0, 2_000),
  });

  if (!input.skipUsageRecord && (totalTokens > 0 || promptTokens > 0 || completionTokens > 0)) {
    await recordAgentUsage({
      userId,
      kind: "agent",
      refId: existing.testerConversationId,
      model,
      prompt: promptTokens,
      completion: completionTokens,
      total: totalTokens,
    }).catch(() => undefined);
  }

  return getTesterRun(userId, runId);
}

export async function updateTesterMinorDecision(
  userId: number,
  runId: number,
  decision: "approved" | "rejected" | "pending",
  note?: string,
): Promise<AgentTesterRunRow | null> {
  const existing = await getTesterRun(userId, runId);
  if (!existing) return null;
  const now = nowIso();
  await q(sql`update agent_tester_runs set minor_decision = ${decision}, updated_at = ${now}
    where id = ${runId} and user_id = ${userId}`);
  if (decision === "approved" || decision === "rejected") {
    const label =
      decision === "approved"
        ? "Решение пользователя: внесение мелких/некритических изменений ОДОБРЕНО."
        : "Решение пользователя: мелкие/некритические изменения ОСТАВИТЬ КАК ЕСТЬ (отклонено).";
    const fullNote = note?.trim() ? `${label}\nКомментарий: ${note.trim()}` : label;
    await insertAgentConversationMessage({
      userId,
      conversationId: existing.testerConversationId,
      role: "user",
      content: fullNote.slice(0, 4_000),
    });
  }
  return getTesterRun(userId, runId);
}

export async function getTesterRun(userId: number, id: number): Promise<AgentTesterRunRow | null> {
  const row = await q1(sql`select * from agent_tester_runs where id = ${id} and user_id = ${userId} limit 1`);
  return row ? mapTesterRun(row) : null;
}

export async function getTesterRunByConversationId(
  userId: number,
  testerConversationId: number,
): Promise<AgentTesterRunRow | null> {
  const row = await q1(sql`select * from agent_tester_runs
    where tester_conversation_id = ${testerConversationId} and user_id = ${userId}
    order by id desc limit 1`);
  return row ? mapTesterRun(row) : null;
}

export async function listTesterRuns(userId: number, limit = 50): Promise<AgentTesterRunRow[]> {
  const cap = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = await q(sql`select * from agent_tester_runs where user_id = ${userId} order by id desc limit ${cap}`);
  return rows.map(mapTesterRun);
}
