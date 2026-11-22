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
  createdAt: string;
};

export type AuthUserRow = {
  id: number;
  email: string;
  passwordHash: string;
  role: Role;
  name: string;
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
    createdAt: toIso(r.created_at) ?? nowIso(),
  };
}

const USER_FIELDS = sql`id, name, email, phone, position, role, avatar_color, avatar_url, bio, is_bot, can_use_agent, can_use_operator, created_at`;

export async function listUsers(): Promise<UserLite[]> {
  const rows = await q(sql`select ${USER_FIELDS} from users where is_bot = false order by name asc`);
  return rows.map(mapUser);
}

export async function getUser(id: number): Promise<UserLite | null> {
  const row = await q1(sql`select ${USER_FIELDS} from users where id = ${id} limit 1`);
  return row ? mapUser(row) : null;
}

export async function countSuperAdmins(): Promise<number> {
  const row = await q1<{ id: number }>(sql`select id from users where role = 'super_admin' limit 1`);
  return row ? 1 : 0;
}

export async function findUserAuthByEmail(email: string): Promise<AuthUserRow | null> {
  const row = await q1(sql`select id, email, password_hash, role, name from users where email = ${email} and is_bot = false limit 1`);
  if (!row) return null;
  return {
    id: toNum(row.id),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    role: (row.role as Role) ?? "user",
    name: String(row.name),
  };
}

export async function findUserIdByEmail(email: string): Promise<number | null> {
  const row = await q1<{ id: number }>(sql`select id from users where email = ${email} limit 1`);
  return row ? toNum(row.id) : null;
}

export async function getPasswordHash(id: number): Promise<string | null> {
  const row = await q1<{ password_hash: string }>(sql`select password_hash from users where id = ${id} limit 1`);
  return row ? String(row.password_hash) : null;
}

export async function getRole(id: number): Promise<Role | null> {
  const row = await q1<{ role: Role }>(sql`select role from users where id = ${id} limit 1`);
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
  createdAt?: string;
};

export async function insertUser(input: InsertUserInput): Promise<number> {
  const now = input.createdAt ?? nowIso();
  const row = await q1<{ id: number }>(sql`
    insert into users (email, password_hash, name, phone, position, bio, role, avatar_color, created_at, updated_at)
    values (${input.email}, ${input.passwordHash}, ${input.name}, ${input.phone ?? null}, ${input.position ?? null},
            ${input.bio ?? null}, ${input.role}, ${input.avatarColor}, ${now}, ${now})
    returning id`);
  return toNum(row?.id);
}

export async function updateProfile(
  id: number,
  values: {
    name: string;
    email: string;
    phone: string | null;
    position: string | null;
    bio: string | null;
    avatarColor: string;
    avatarUrl: string | null;
  },
): Promise<void> {
  await q(sql`update users set
      name = ${values.name}, email = ${values.email}, phone = ${values.phone}, position = ${values.position},
      bio = ${values.bio}, avatar_color = ${values.avatarColor}, avatar_url = ${values.avatarUrl},
      updated_at = ${nowIso()}
    where id = ${id}`);
}

export async function setUserPassword(id: number, passwordHash: string): Promise<void> {
  await q(sql`update users set password_hash = ${passwordHash}, updated_at = ${nowIso()} where id = ${id}`);
}

export async function setUserRole(id: number, role: Role): Promise<void> {
  await q(sql`update users set role = ${role}, updated_at = ${nowIso()} where id = ${id} and role <> 'super_admin'`);
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
    where id = ${id}`);
  return getUser(id);
}

export async function promoteSuperAdmin(id: number): Promise<void> {
  await q(sql`update users set role = 'super_admin', can_use_agent = true, can_use_operator = true, updated_at = ${nowIso()} where id = ${id}`);
}

export async function deleteUser(id: number): Promise<void> {
  await q(sql`delete from users where id = ${id} and role <> 'super_admin'`);
}

export async function userExists(id: number): Promise<boolean> {
  const row = await q1<{ id: number }>(sql`select id from users where id = ${id} limit 1`);
  return Boolean(row);
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
           u.is_bot, u.can_use_agent, u.can_use_operator, u.created_at
    from sessions s join users u on u.id = s.user_id
    where s.token = ${tokenHash}
      and s.revoked_at is null
      and s.expires_at > ${nowIso()}
      and u.is_bot = false
    limit 1`);
  if (!row) return null;
  return { user: mapUser(row), sessionId: toNum(row.session_id) };
}

export async function touchSession(token: string): Promise<void> {
  if (!token) return;
  const tokenHash = hashOpaqueToken(token);
  await q(sql`update sessions set last_seen_at = ${nowIso()} where token = ${tokenHash} and revoked_at is null`);
}

export async function deleteSession(token: string): Promise<void> {
  if (!token) return;
  const tokenHash = hashOpaqueToken(token);
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
