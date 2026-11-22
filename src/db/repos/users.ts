import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { nowIso, q, q1, toBool, toIso, toNum } from "../dialect";
import { decryptSecret, encryptSecret, hashOpaqueToken, maskSecret } from "@/lib/crypto";
import type { Role } from "../schema";
import type { Raw } from "./shared";

export type UserLite = {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  position: string | null;
  role: Role;
  avatarColor: string;
  avatarUrl: string | null;
  bio: string | null;
  isBot: boolean;
  canUseAgent: boolean;
  canUseOperator: boolean;
  mustChangePassword: boolean;
  totpEnabled: boolean;
  pendingEmail: string | null;
  createdAt: string;
};

export type AuthUserRow = {
  id: number;
  email: string;
  passwordHash: string;
  role: Role;
  name: string;
  totpEnabled: boolean;
  mustChangePassword: boolean;
};

export type UserSessionRow = {
  id: number;
  label: string;
  userAgent: string;
  ip: string;
  lastSeenAt: string | null;
  expiresAt: string;
  createdAt: string;
  current: boolean;
};

export type AiUserSettingsPublic = {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyHint: string;
  updatedAt: string | null;
};

export type AiUserSettingsSecret = {
  baseUrl: string;
  model: string;
  apiKey: string;
};

const SESSION_TOUCH_MIN_MS = 60_000;
const globalForTouch = globalThis as typeof globalThis & {
  __crmSessionTouchMap?: Map<string, number>;
};

function sessionTouchCache(): Map<string, number> {
  if (!globalForTouch.__crmSessionTouchMap) {
    globalForTouch.__crmSessionTouchMap = new Map();
  }
  return globalForTouch.__crmSessionTouchMap;
}

function mapUser(r: Raw): UserLite {
  return {
    id: toNum(r.id),
    name: String(r.name),
    email: String(r.email),
    phone: (r.phone as string | null) ?? null,
    position: (r.position as string | null) ?? null,
    role: (r.role as Role) ?? "user",
    avatarColor: String(r.avatar_color ?? "#7c5cff"),
    avatarUrl: (r.avatar_url as string | null) ?? null,
    bio: (r.bio as string | null) ?? null,
    isBot: toBool(r.is_bot),
    canUseAgent: toBool(r.can_use_agent),
    canUseOperator: toBool(r.can_use_operator),
    mustChangePassword: toBool(r.must_change_password),
    totpEnabled: toBool(r.totp_enabled),
    pendingEmail: (r.pending_email as string | null) ?? null,
    createdAt: toIso(r.created_at) ?? nowIso(),
  };
}

const USER_FIELDS = sql`id, name, email, phone, position, role, avatar_color, avatar_url, bio,
  is_bot, can_use_agent, can_use_operator, must_change_password, totp_enabled, pending_email, created_at`;

export async function listUsers(): Promise<UserLite[]> {
  const rows = await q(sql`
    select ${USER_FIELDS}
    from users
    where is_bot = false and deleted_at is null
    order by name asc`);
  return rows.map(mapUser);
}

export async function getUser(id: number): Promise<UserLite | null> {
  const row = await q1(sql`select ${USER_FIELDS} from users where id = ${id} and deleted_at is null limit 1`);
  return row ? mapUser(row) : null;
}

export async function countSuperAdmins(): Promise<number> {
  const row = await q1<{ id: number }>(sql`select id from users where role = 'super_admin' and deleted_at is null limit 1`);
  return row ? 1 : 0;
}

export async function findUserAuthByEmail(email: string): Promise<AuthUserRow | null> {
  const row = await q1(sql`
    select id, email, password_hash, role, name, totp_enabled, must_change_password
    from users
    where email = ${email} and is_bot = false and deleted_at is null
    limit 1`);
  if (!row) return null;
  return {
    id: toNum(row.id),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    role: (row.role as Role) ?? "user",
    name: String(row.name),
    totpEnabled: toBool(row.totp_enabled),
    mustChangePassword: toBool(row.must_change_password),
  };
}

export async function findUserIdByEmail(email: string): Promise<number | null> {
  const row = await q1<{ id: number }>(sql`select id from users where email = ${email} and deleted_at is null limit 1`);
  return row ? toNum(row.id) : null;
}

export async function getPasswordHash(id: number): Promise<string | null> {
  const row = await q1<{ password_hash: string }>(sql`select password_hash from users where id = ${id} and deleted_at is null limit 1`);
  return row ? String(row.password_hash) : null;
}

export async function getRole(id: number): Promise<Role | null> {
  const row = await q1<{ role: Role }>(sql`select role from users where id = ${id} and deleted_at is null limit 1`);
  return row ? row.role : null;
}

export type InsertUserInput = {
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  position?: string | null;
  phone?: string | null;
  avatarColor: string;
  bio?: string | null;
  mustChangePassword?: boolean;
  createdAt?: string;
};

export async function insertUser(input: InsertUserInput): Promise<number> {
  const now = input.createdAt ?? nowIso();
  const mustChange = Boolean(input.mustChangePassword);
  const row = await q1<{ id: number }>(sql`
    insert into users (email, password_hash, name, phone, position, bio, role, avatar_color, must_change_password, created_at, updated_at)
    values (${input.email}, ${input.passwordHash}, ${input.name}, ${input.phone ?? null}, ${input.position ?? null},
            ${input.bio ?? null}, ${input.role}, ${input.avatarColor}, ${mustChange}, ${now}, ${now})
    returning id`);
  return toNum(row?.id);
}

export async function updateProfile(
  id: number,
  values: {
    name: string;
    email?: string;
    phone: string | null;
    position: string | null;
    bio: string | null;
    avatarColor: string;
    avatarUrl: string | null;
  },
): Promise<void> {
  if (values.email !== undefined) {
    await q(sql`update users set
        name = ${values.name}, email = ${values.email}, phone = ${values.phone}, position = ${values.position},
        bio = ${values.bio}, avatar_color = ${values.avatarColor}, avatar_url = ${values.avatarUrl},
        updated_at = ${nowIso()}
      where id = ${id} and deleted_at is null`);
  } else {
    await q(sql`update users set
        name = ${values.name}, phone = ${values.phone}, position = ${values.position},
        bio = ${values.bio}, avatar_color = ${values.avatarColor}, avatar_url = ${values.avatarUrl},
        updated_at = ${nowIso()}
      where id = ${id} and deleted_at is null`);
  }
}

export async function setUserPassword(
  id: number,
  passwordHash: string,
  options?: { mustChangePassword?: boolean },
): Promise<void> {
  if (options?.mustChangePassword !== undefined) {
    await q(sql`
      update users
      set password_hash = ${passwordHash},
          must_change_password = ${Boolean(options.mustChangePassword)},
          updated_at = ${nowIso()}
      where id = ${id} and deleted_at is null`);
    return;
  }
  await q(sql`update users set password_hash = ${passwordHash}, updated_at = ${nowIso()} where id = ${id} and deleted_at is null`);
}

export async function setUserRole(id: number, role: Role): Promise<void> {
  await q(sql`update users set role = ${role}, updated_at = ${nowIso()} where id = ${id} and role <> 'super_admin' and deleted_at is null`);
}

export async function setUserAgentAccess(
  id: number,
  input: { canUseAgent?: boolean; canUseOperator?: boolean },
): Promise<UserLite | null> {
  const current = await getUser(id);
  if (!current || current.isBot) return null;
  const nextAgent = input.canUseAgent !== undefined ? Boolean(input.canUseAgent) : current.canUseAgent;
  const nextOperator = input.canUseOperator !== undefined ? Boolean(input.canUseOperator) : current.canUseOperator;
  await q(sql`
    update users
    set can_use_agent = ${nextAgent},
        can_use_operator = ${nextOperator},
        updated_at = ${nowIso()}
    where id = ${id} and deleted_at is null`);
  return getUser(id);
}

export async function promoteSuperAdmin(id: number): Promise<void> {
  await q(sql`update users set role = 'super_admin', can_use_agent = true, can_use_operator = true, updated_at = ${nowIso()} where id = ${id} and deleted_at is null`);
}

/**
 * Мягкое удаление (soft delete) пользователя с сохранением истории задач/комментариев.
 * Если указан `reassignToUserId`, открытые задачи переводятся на этого сотрудника.
 */
export async function deleteUser(id: number, reassignToUserId?: number | null): Promise<void> {
  const target = await getUser(id);
  if (!target || target.role === "super_admin") return;

  const now = nowIso();
  if (reassignToUserId && reassignToUserId !== id) {
    const recipient = await getUser(reassignToUserId);
    if (recipient && !recipient.isBot) {
      await q(sql`
        update tasks
        set assignee_id = ${recipient.id}, updated_at = ${now}
        where assignee_id = ${id} and status not in ('done', 'closed', 'cancelled')`);
    }
  }

  await revokeAllUserSessions(id);
  await q(sql`update agent_connection_tokens set revoked_at = ${now} where user_id = ${id} and revoked_at is null`);
  await q(sql`delete from agent_tokens where user_id = ${id}`);
  await q(sql`delete from github_connections where user_id = ${id}`);
  await q(sql`delete from ai_user_settings where user_id = ${id}`);

  const tombHash = createHash("sha256").update(`${id}:${target.email}:${now}`).digest("hex").slice(0, 12);
  const tombEmail = `deleted_${id}_${tombHash}@deleted.local`;
  await q(sql`
    update users
    set deleted_at = ${now},
        email = ${tombEmail},
        password_hash = '!deleted',
        can_use_agent = false,
        can_use_operator = false,
        totp_enabled = false,
        totp_secret_encrypted = '',
        pending_email = null,
        pending_email_token_hash = null,
        pending_email_expires_at = null,
        updated_at = ${now}
    where id = ${id} and role <> 'super_admin'`);
}

export async function userExists(id: number): Promise<boolean> {
  const row = await q1<{ id: number }>(sql`select id from users where id = ${id} and deleted_at is null limit 1`);
  return Boolean(row);
}

/* -------------------------- TOTP 2FA & смена email --------------------- */

export async function getUserTotpSecret(userId: number): Promise<{ enabled: boolean; secret: string }> {
  const row = await q1<{ totp_enabled: unknown; totp_secret_encrypted: string }>(sql`
    select totp_enabled, totp_secret_encrypted from users where id = ${userId} and deleted_at is null limit 1`);
  if (!row) return { enabled: false, secret: "" };
  const enc = String(row.totp_secret_encrypted ?? "");
  return {
    enabled: toBool(row.totp_enabled),
    secret: enc ? decryptSecret(enc) : "",
  };
}

export async function setUserTotp(
  userId: number,
  input: { secret?: string; enabled: boolean },
): Promise<void> {
  const encrypted = input.secret !== undefined ? (input.secret ? encryptSecret(input.secret) : "") : undefined;
  const now = nowIso();
  if (encrypted !== undefined) {
    await q(sql`
      update users
      set totp_secret_encrypted = ${encrypted},
          totp_enabled = ${Boolean(input.enabled)},
          updated_at = ${now}
      where id = ${userId} and deleted_at is null`);
  } else {
    await q(sql`
      update users
      set totp_enabled = ${Boolean(input.enabled)},
          updated_at = ${now}
      where id = ${userId} and deleted_at is null`);
  }
}

export async function requestEmailChange(
  userId: number,
  newEmail: string,
  rawToken: string,
  ttlMs = 24 * 60 * 60 * 1000,
): Promise<void> {
  const tokenHash = hashOpaqueToken(rawToken);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await q(sql`
    update users
    set pending_email = ${newEmail.trim().toLowerCase()},
        pending_email_token_hash = ${tokenHash},
        pending_email_expires_at = ${expiresAt},
        updated_at = ${nowIso()}
    where id = ${userId} and deleted_at is null`);
}

export async function confirmEmailChangeByToken(
  rawToken: string,
): Promise<{ ok: true; userId: number; newEmail: string } | { ok: false; error: string }> {
  if (!rawToken.trim()) return { ok: false, error: "Токен подтверждения отсутствует" };
  const tokenHash = hashOpaqueToken(rawToken.trim());
  const now = nowIso();
  const row = await q1<{ id: number; pending_email: string | null; pending_email_expires_at: unknown }>(sql`
    select id, pending_email, pending_email_expires_at
    from users
    where pending_email_token_hash = ${tokenHash} and deleted_at is null
    limit 1`);
  if (!row || !row.pending_email) {
    return { ok: false, error: "Ссылка подтверждения недействительна или уже использована" };
  }
  const expiresIso = toIso(row.pending_email_expires_at);
  if (!expiresIso || expiresIso <= now) {
    return { ok: false, error: "Срок действия ссылки истёк" };
  }
  const userId = toNum(row.id);
  const newEmail = String(row.pending_email).trim().toLowerCase();
  const conflict = await q1<{ id: number }>(sql`
    select id from users where email = ${newEmail} and id <> ${userId} and deleted_at is null limit 1`);
  if (conflict) {
    return { ok: false, error: "Этот email уже занят другим пользователем" };
  }

  await q(sql`
    update users
    set email = ${newEmail},
        pending_email = null,
        pending_email_token_hash = null,
        pending_email_expires_at = null,
        updated_at = ${now}
    where id = ${userId}`);
  await revokeAllUserSessions(userId);
  return { ok: true, userId, newEmail };
}

/* ----------------------------- sessions ---------------------------- */

export async function insertSession(
  token: string,
  userId: number,
  expiresAt: string,
  meta?: { label?: string; userAgent?: string; ip?: string },
): Promise<void> {
  const tokenHash = hashOpaqueToken(token);
  const now = nowIso();
  await q(sql`
    insert into sessions (token, user_id, label, user_agent, ip, last_seen_at, revoked_at, expires_at, created_at)
    values (
      ${tokenHash},
      ${userId},
      ${String(meta?.label ?? "").slice(0, 120)},
      ${String(meta?.userAgent ?? "").slice(0, 300)},
      ${String(meta?.ip ?? "").slice(0, 80)},
      ${now},
      ${null},
      ${expiresAt},
      ${now}
    )`);
}

export async function findSessionUser(token: string): Promise<{ user: UserLite; sessionId: number } | null> {
  if (!token) return null;
  const tokenHash = hashOpaqueToken(token);
  const row = await q1(sql`
    select s.id as session_id,
           u.id, u.name, u.email, u.phone, u.position, u.role, u.avatar_color, u.avatar_url, u.bio,
           u.is_bot, u.can_use_agent, u.can_use_operator, u.must_change_password, u.totp_enabled, u.pending_email,
           u.created_at
    from sessions s join users u on u.id = s.user_id
    where s.token = ${tokenHash}
      and s.revoked_at is null
      and s.expires_at > ${nowIso()}
      and u.is_bot = false
      and u.deleted_at is null
    limit 1`);
  if (!row) return null;
  return { user: mapUser(row), sessionId: toNum(row.session_id) };
}

export async function touchSession(token: string, force = false): Promise<void> {
  if (!token) return;
  const tokenHash = hashOpaqueToken(token);
  const cache = sessionTouchCache();
  const nowMs = Date.now();
  const prevMs = cache.get(tokenHash) ?? 0;
  if (!force && nowMs - prevMs < SESSION_TOUCH_MIN_MS) {
    return;
  }
  if (cache.size > 10_000) {
    cache.clear();
  }
  cache.set(tokenHash, nowMs);
  await q(sql`update sessions set last_seen_at = ${nowIso()} where token = ${tokenHash} and revoked_at is null`);
}

export async function deleteSession(token: string): Promise<void> {
  if (!token) return;
  const tokenHash = hashOpaqueToken(token);
  sessionTouchCache().delete(tokenHash);
  await q(sql`update sessions set revoked_at = ${nowIso()} where token = ${tokenHash} and revoked_at is null`);
}

export async function listUserSessions(userId: number, currentToken?: string | null): Promise<UserSessionRow[]> {
  const currentHash = currentToken ? hashOpaqueToken(currentToken) : "";
  const rows = await q(sql`
    select id, token, label, user_agent, ip, last_seen_at, expires_at, created_at
    from sessions
    where user_id = ${userId} and revoked_at is null and expires_at > ${nowIso()}
    order by coalesce(last_seen_at, created_at) desc, id desc
    limit 50`);
  return rows.map((r) => ({
    id: toNum(r.id),
    label: String(r.label ?? ""),
    userAgent: String(r.user_agent ?? ""),
    ip: String(r.ip ?? ""),
    lastSeenAt: toIso(r.last_seen_at),
    expiresAt: toIso(r.expires_at) ?? nowIso(),
    createdAt: toIso(r.created_at) ?? nowIso(),
    current: Boolean(currentHash && String(r.token) === currentHash),
  }));
}

export async function revokeSessionById(userId: number, sessionId: number): Promise<boolean> {
  const existing = await q1<{ id: number }>(sql`
    select id from sessions where id = ${sessionId} and user_id = ${userId} and revoked_at is null limit 1`);
  if (!existing) return false;
  await q(sql`update sessions set revoked_at = ${nowIso()} where id = ${sessionId} and user_id = ${userId}`);
  return true;
}

export async function revokeOtherSessions(userId: number, currentToken: string): Promise<number> {
  const currentHash = hashOpaqueToken(currentToken);
  const rows = await q<{ id: number }>(sql`
    update sessions
    set revoked_at = ${nowIso()}
    where user_id = ${userId} and revoked_at is null and token <> ${currentHash}
    returning id`);
  return rows.length;
}

export async function revokeAllUserSessions(userId: number): Promise<void> {
  await q(sql`update sessions set revoked_at = ${nowIso()} where user_id = ${userId} and revoked_at is null`);
}

/* --------------------- персональные настройки ИИ ------------------- */

export async function getAiUserSettingsPublic(userId: number): Promise<AiUserSettingsPublic> {
  const row = await q1(sql`
    select base_url, model, api_key_encrypted, api_key_hint, updated_at
    from ai_user_settings where user_id = ${userId} limit 1`);
  if (!row) {
    return { baseUrl: "", model: "", hasApiKey: false, apiKeyHint: "", updatedAt: null };
  }
  return {
    baseUrl: String(row.base_url ?? ""),
    model: String(row.model ?? ""),
    hasApiKey: Boolean(String(row.api_key_encrypted ?? "")),
    apiKeyHint: String(row.api_key_hint ?? ""),
    updatedAt: toIso(row.updated_at),
  };
}

export async function getAiUserSettingsSecret(userId: number): Promise<AiUserSettingsSecret> {
  const row = await q1(sql`
    select base_url, model, api_key_encrypted
    from ai_user_settings where user_id = ${userId} limit 1`);
  if (!row) {
    return { baseUrl: "", model: "", apiKey: "" };
  }
  const encrypted = String(row.api_key_encrypted ?? "");
  return {
    baseUrl: String(row.base_url ?? ""),
    model: String(row.model ?? ""),
    apiKey: encrypted ? decryptSecret(encrypted) : "",
  };
}

export async function upsertAiUserSettings(
  userId: number,
  input: { baseUrl?: string; apiKey?: string; clearApiKey?: boolean; model?: string },
): Promise<AiUserSettingsPublic> {
  const now = nowIso();
  const existing = await q1(sql`
    select base_url, model, api_key_encrypted, api_key_hint
    from ai_user_settings where user_id = ${userId} limit 1`);

  const nextBaseUrl =
    input.baseUrl !== undefined
      ? input.baseUrl.trim().slice(0, 400)
      : String(existing?.base_url ?? "");
  const nextModel =
    input.model !== undefined
      ? input.model.trim().slice(0, 200)
      : String(existing?.model ?? "");

  let nextEncrypted = String(existing?.api_key_encrypted ?? "");
  let nextHint = String(existing?.api_key_hint ?? "");
  if (input.clearApiKey) {
    nextEncrypted = "";
    nextHint = "";
  } else if (input.apiKey !== undefined && input.apiKey.trim()) {
    const cleanKey = input.apiKey.trim().slice(0, 400);
    nextEncrypted = encryptSecret(cleanKey);
    nextHint = maskSecret(cleanKey);
  }

  if (existing) {
    await q(sql`
      update ai_user_settings
      set base_url = ${nextBaseUrl},
          api_key_encrypted = ${nextEncrypted},
          api_key_hint = ${nextHint},
          model = ${nextModel},
          updated_at = ${now}
      where user_id = ${userId}`);
  } else {
    await q(sql`
      insert into ai_user_settings (user_id, base_url, api_key_encrypted, api_key_hint, model, created_at, updated_at)
      values (${userId}, ${nextBaseUrl}, ${nextEncrypted}, ${nextHint}, ${nextModel}, ${now}, ${now})`);
  }

  return getAiUserSettingsPublic(userId);
}
