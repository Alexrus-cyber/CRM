import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * Упорядоченный список таблиц схемы (порядок учитывает внешние ключи для sync/backup).
 */
export const SCHEMA_TABLES = [
  "users",
  "sessions",
  "counterparties",
  "tasks",
  "chat_rooms",
  "chat_room_members",
  "chat_room_reads",
  "chat_general_bots",
  "ai_bot_configs",
  "ai_user_settings",
  "messages",
  "chat_reads",
  "message_attachments",
  "task_exports",
  "task_messages",
  "agent_connections",
  "agent_connection_tokens",
  "agent_tokens",
  "agent_subagents",
  "agent_conversations",
  "agent_conversation_messages",
  "agent_tasks",
  "agent_transcripts",
  "agent_events",
  "ai_chats",
  "ai_chat_messages",
  "ai_usage_events",
  "ai_quota_overrides",
  "ai_rag_folders",
  "ai_rag_chunks",
  "ai_rag_terms",
  "agent_usage_events",
  "agent_tester_runs",
  "agent_subagent_runs",
  "github_connections",
];

function resolveDrizzleDir() {
  const candidates = [
    path.join(/*turbopackIgnore: true*/ process.cwd(), "drizzle"),
    path.join(/*turbopackIgnore: true*/ REPO_ROOT, "drizzle"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(/*turbopackIgnore: true*/ dir)) return dir;
  }
  throw new Error(`Drizzle migrations directory not found (checked: ${candidates.join(", ")})`);
}

export function splitSqlStatements(sqlText) {
  const withoutLineComments = sqlText
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  return withoutLineComments
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function pgStatementToSqlite(statement) {
  return statement
    .replace(/\bserial\s+primary\s+key\b/gi, "integer primary key autoincrement")
    .replace(/\btimestamptz\b/gi, "text")
    .replace(/(\bdeadline\s+)date(\b)/gi, "$1text$2")
    .replace(/\bdefault\s+now\(\)/gi, "default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
    .replace(/\badd\s+column\s+if\s+not\s+exists\b/gi, "add column");
}

function sha256Opaque(value) {
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function maskOpaqueHint(value) {
  const s = String(value || "");
  return s ? `…${s.slice(-6)}` : "";
}

function defaultTokenExpiryIso() {
  return new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Обновляет старые базы данных, созданные до появления новых колонок.
 * Выполняется до создания индексов из последующих миграций.
 */
async function ensureLegacyColumns(executor) {
  const ts = executor.dialect === "postgres" ? "timestamptz" : "text";
  const ifNotExists = executor.dialect === "postgres" ? "if not exists " : "";
  const statements = [
    `alter table tasks add column ${ifNotExists}deadline_time text`,
    `alter table tasks add column ${ifNotExists}accepted_at ${ts}`,
    `alter table messages add column ${ifNotExists}content_lower text not null default ''`,
    `alter table messages add column ${ifNotExists}room_id integer references chat_rooms(id) on delete cascade`,
    `alter table message_attachments add column ${ifNotExists}name_lower text not null default ''`,
    `alter table message_attachments add column ${ifNotExists}storage_key text not null default ''`,
    `alter table agent_events add column ${ifNotExists}storage_key text not null default ''`,
    `alter table agent_tasks add column ${ifNotExists}trust_level text not null default 'verified'`,
    `alter table agent_tasks add column ${ifNotExists}task_mode text not null default 'autonomous'`,
    `alter table agent_tasks add column ${ifNotExists}source text not null default 'operator'`,
    `alter table agent_tasks add column ${ifNotExists}coach_mode text not null default 'after_step'`,
    `alter table agent_tasks add column ${ifNotExists}guidance_note text not null default ''`,
    `alter table agent_tasks add column ${ifNotExists}pending_approval text not null default ''`,
    `alter table agent_tasks add column ${ifNotExists}approval_response text not null default ''`,
    `alter table users add column ${ifNotExists}is_bot boolean not null default false`,
    `alter table users add column ${ifNotExists}can_use_agent boolean not null default false`,
    `alter table users add column ${ifNotExists}can_use_operator boolean not null default false`,
    `alter table users add column ${ifNotExists}deleted_at ${ts}`,
    `alter table users add column ${ifNotExists}must_change_password boolean not null default false`,
    `alter table users add column ${ifNotExists}totp_secret_encrypted text not null default ''`,
    `alter table users add column ${ifNotExists}totp_enabled boolean not null default false`,
    `alter table users add column ${ifNotExists}pending_email text`,
    `alter table users add column ${ifNotExists}pending_email_token_hash text`,
    `alter table users add column ${ifNotExists}pending_email_expires_at ${ts}`,
    `alter table sessions add column ${ifNotExists}label text not null default ''`,
    `alter table sessions add column ${ifNotExists}user_agent text not null default ''`,
    `alter table sessions add column ${ifNotExists}ip text not null default ''`,
    `alter table sessions add column ${ifNotExists}last_seen_at ${ts}`,
    `alter table sessions add column ${ifNotExists}revoked_at ${ts}`,
    `alter table agent_connection_tokens add column ${ifNotExists}token_hash text not null default ''`,
    `alter table agent_connection_tokens add column ${ifNotExists}token_hint text not null default ''`,
    `alter table agent_connection_tokens add column ${ifNotExists}expires_at ${ts}`,
    `alter table agent_connection_tokens add column ${ifNotExists}revoked_at ${ts}`,
  ];
  for (const statement of statements) {
    try {
      await executor.exec(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists|duplicate column/i.test(message)) throw error;
    }
  }
}

async function convertPostgresIntegerBooleans(executor) {
  if (executor.dialect !== "postgres") return;
  const targets = [
    ["users", "is_bot", false],
    ["users", "can_use_agent", false],
    ["users", "can_use_operator", false],
    ["users", "must_change_password", false],
    ["users", "totp_enabled", false],
    ["ai_bot_configs", "is_active", true],
    ["agent_connections", "is_default", false],
    ["github_connections", "enabled", true],
    ["agent_subagents", "is_active", true],
    ["agent_subagents", "orchestrator_can_call", true],
    ["agent_subagents", "unlock_api", false],
    ["agent_subagent_runs", "used_custom_api", false],
    ["ai_user_settings", "overseer_enabled", true],
    ["ai_user_settings", "overseer_unlock_api", false],
  ];
  for (const [table, column, defVal] of targets) {
    const rows = await executor.queryRaw(
      `select data_type from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2`,
      [table, column],
    );
    if (rows[0]?.data_type === "integer") {
      await executor.exec(`alter table ${table} alter column ${column} drop default`);
      await executor.exec(
        `alter table ${table} alter column ${column} type boolean using (${column} <> 0)`,
      );
      await executor.exec(
        `alter table ${table} alter column ${column} set default ${defVal ? "true" : "false"}`,
      );
    }
  }
}

async function migrateLegacyAgentTokens(executor) {
  try {
    await executor.exec(
      `insert into agent_connections (user_id, name, server_url, is_default, created_at, updated_at)
       select t.user_id, 'Основной CRM', '', true, t.created_at, t.created_at
       from agent_tokens t
       where not exists (select 1 from agent_connections c where c.user_id = t.user_id)`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such table|does not exist/i.test(message)) throw error;
  }

  let legacyRows = [];
  try {
    legacyRows = await executor.queryRaw(`select id, user_id, token, created_at from agent_tokens`, []);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table|does not exist/i.test(message)) return;
    throw error;
  }

  const graceExpiry = defaultTokenExpiryIso();
  for (const row of legacyRows) {
    const raw = String(row.token || "");
    if (!raw) continue;
    const isAlreadyHashed = raw.startsWith("sha256:");
    const hashed = isAlreadyHashed ? raw : sha256Opaque(raw);
    const hint = isAlreadyHashed ? "" : maskOpaqueHint(raw);
    const connRows = await executor.queryRaw(
      executor.dialect === "postgres"
        ? `select id from agent_connections where user_id = $1 order by is_default desc, id asc limit 1`
        : `select id from agent_connections where user_id = ? order by is_default desc, id asc limit 1`,
      [row.user_id],
    );
    const connId = connRows[0]?.id;
    if (connId) {
      const existing = await executor.queryRaw(
        executor.dialect === "postgres"
          ? `select id from agent_connection_tokens where token = $1 or token = $2 or token_hash = $3 limit 1`
          : `select id from agent_connection_tokens where token = ? or token = ? or token_hash = ? limit 1`,
        [raw, hashed, hashed],
      );
      if (existing.length === 0) {
        await executor.queryRaw(
          executor.dialect === "postgres"
            ? `insert into agent_connection_tokens (connection_id, user_id, name, token, token_hash, token_hint, expires_at, created_at, last_used_at)
               values ($1, $2, 'Основной', $3, $4, $5, $6, $7, null)`
            : `insert into agent_connection_tokens (connection_id, user_id, name, token, token_hash, token_hint, expires_at, created_at, last_used_at)
               values (?, ?, 'Основной', ?, ?, ?, ?, ?, null)`,
          [connId, row.user_id, hashed, hashed, hint, graceExpiry, row.created_at],
        );
      }
    }
    if (!isAlreadyHashed) {
      await executor.queryRaw(
        executor.dialect === "postgres"
          ? `update agent_tokens set token = $1 where id = $2`
          : `update agent_tokens set token = ? where id = ?`,
        [hashed, row.id],
      );
    }
  }
}

async function migratePlaintextAgentTokensToHashed(executor) {
  const rows = await executor.queryRaw(
    `select id, token, token_hash, token_hint, expires_at from agent_connection_tokens where token not like 'sha256:%' or token_hash = ''`,
    [],
  );
  const graceExpiry = defaultTokenExpiryIso();
  for (const row of rows) {
    const raw = String(row.token || "");
    if (!raw) continue;
    const isHashed = raw.startsWith("sha256:");
    const hashed = isHashed ? raw : sha256Opaque(raw);
    const hint = String(row.token_hint || "") || (isHashed ? "" : maskOpaqueHint(raw));
    const exp = row.expires_at ? String(row.expires_at) : graceExpiry;
    await executor.queryRaw(
      executor.dialect === "postgres"
        ? `update agent_connection_tokens set token = $1, token_hash = $2, token_hint = $3, expires_at = $4 where id = $5`
        : `update agent_connection_tokens set token = ?, token_hash = ?, token_hint = ?, expires_at = ? where id = ?`,
      [hashed, hashed, hint, exp, row.id],
    );
  }
}

async function migrateLegacySessionTokens(executor) {
  const rows = await executor.queryRaw(
    `select id, token from sessions where token not like 'sha256:%'`,
    [],
  );
  for (const row of rows) {
    if (!row?.token) continue;
    const hashed = sha256Opaque(String(row.token));
    await executor.queryRaw(
      executor.dialect === "postgres"
        ? `update sessions set token = $1 where id = $2`
        : `update sessions set token = ? where id = ?`,
      [hashed, row.id],
    );
  }
}

async function ensureFullTextSearch(executor) {
  if (executor.dialect === "sqlite") {
    try {
      await executor.exec(`
        create virtual table if not exists ai_rag_chunks_fts using fts5(
          path,
          text,
          content='ai_rag_chunks',
          content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        )
      `);
      await executor.exec(`
        create trigger if not exists ai_rag_chunks_ai after insert on ai_rag_chunks begin
          insert into ai_rag_chunks_fts(rowid, path, text) values (new.id, new.path, new.text);
        end
      `);
      await executor.exec(`
        create trigger if not exists ai_rag_chunks_ad after delete on ai_rag_chunks begin
          insert into ai_rag_chunks_fts(ai_rag_chunks_fts, rowid, path, text) values ('delete', old.id, old.path, old.text);
        end
      `);
      await executor.exec(`
        create trigger if not exists ai_rag_chunks_au after update on ai_rag_chunks begin
          insert into ai_rag_chunks_fts(ai_rag_chunks_fts, rowid, path, text) values ('delete', old.id, old.path, old.text);
          insert into ai_rag_chunks_fts(rowid, path, text) values (new.id, new.path, new.text);
        end
      `);
      const chunksCount = await executor.queryRaw(`select count(*) as c from ai_rag_chunks`, []);
      const ftsCount = await executor.queryRaw(`select count(*) as c from ai_rag_chunks_fts`, []);
      if (Number(chunksCount[0]?.c || 0) > Number(ftsCount[0]?.c || 0)) {
        await executor.exec(`insert into ai_rag_chunks_fts(ai_rag_chunks_fts) values('rebuild')`);
      }
    } catch (error) {
      // На старых сборках SQLite без FTS5 сохраняем fallback на таблицу ai_rag_terms.
      console.warn("[db] FTS5 unavailable, using ai_rag_terms fallback:", error instanceof Error ? error.message : String(error));
    }
    return;
  }

  await executor.exec(`alter table ai_rag_chunks add column if not exists search_vector tsvector`);
  await executor.exec(`create index if not exists ai_rag_chunks_search_gin on ai_rag_chunks using gin (search_vector)`);
  await executor.exec(`
    create or replace function ai_rag_chunks_sync_vector() returns trigger as $$
    begin
      new.search_vector :=
        to_tsvector('russian', coalesce(new.path, '') || ' ' || coalesce(new.text, '')) ||
        to_tsvector('english', coalesce(new.path, '') || ' ' || coalesce(new.text, ''));
      return new;
    end;
    $$ language plpgsql
  `);
  await executor.exec(`drop trigger if exists ai_rag_chunks_vector_trg on ai_rag_chunks`);
  await executor.exec(`
    create trigger ai_rag_chunks_vector_trg
    before insert or update of path, text on ai_rag_chunks
    for each row execute function ai_rag_chunks_sync_vector()
  `);
  await executor.exec(`
    update ai_rag_chunks
    set search_vector =
      to_tsvector('russian', coalesce(path, '') || ' ' || coalesce(text, '')) ||
      to_tsvector('english', coalesce(path, '') || ' ' || coalesce(text, ''))
    where search_vector is null
  `);
}

export async function runMigrations(executor) {
  const drizzleDir = resolveDrizzleDir();
  const migrationFiles = fs
    .readdirSync(/*turbopackIgnore: true*/ drizzleDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const createMetaTable =
    executor.dialect === "postgres"
      ? `create table if not exists _crm_migrations (
           id serial primary key,
           name text not null unique,
           applied_at timestamptz not null default now()
         )`
      : `create table if not exists _crm_migrations (
           id integer primary key autoincrement,
           name text not null unique,
           applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         )`;
  await executor.exec(createMetaTable);

  const appliedRows = await executor.queryRaw(`select name from _crm_migrations`, []);
  const applied = new Set(appliedRows.map((r) => String(r.name)));

  for (const file of migrationFiles) {
    const rawSql = fs.readFileSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ drizzleDir, file), "utf8");
    const statements = splitSqlStatements(rawSql);
    if (!applied.has(file)) {
      for (const stmt of statements) {
        const sqlText = executor.dialect === "sqlite" ? pgStatementToSqlite(stmt) : stmt;
        try {
          await executor.exec(sqlText);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/already exists|duplicate column/i.test(message)) throw error;
        }
      }
      if (file === "0001_baseline.sql") {
        await ensureLegacyColumns(executor);
        await convertPostgresIntegerBooleans(executor);
      }
      const now = new Date().toISOString();
      await executor.queryRaw(
        executor.dialect === "postgres"
          ? `insert into _crm_migrations (name, applied_at) values ($1, $2) on conflict (name) do nothing`
          : `insert or ignore into _crm_migrations (name, applied_at) values (?, ?)`,
        [file, now],
      );
      applied.add(file);
    } else if (file === "0001_baseline.sql") {
      await ensureLegacyColumns(executor);
      await convertPostgresIntegerBooleans(executor);
    }
  }

  await migrateLegacyAgentTokens(executor);
  await migratePlaintextAgentTokensToHashed(executor);
  await migrateLegacySessionTokens(executor);
  await ensureFullTextSearch(executor);
}

/**
 * Помощник для внешних скриптов (seed/sync): оборачивает Pool или better-sqlite3 Database
 * в минимальный Executor для runMigrations.
 */
export function wrapPgPool(pool) {
  return {
    dialect: "postgres",
    async exec(statement) {
      await pool.query(statement);
    },
    async queryRaw(sqlText, params = []) {
      const res = await pool.query(sqlText, params);
      return res.rows;
    },
  };
}

export function wrapSqliteDb(database) {
  return {
    dialect: "sqlite",
    async exec(statement) {
      database.exec(statement);
    },
    async queryRaw(sqlText, params = []) {
      const stmt = database.prepare(sqlText);
      if (!stmt.reader) {
        stmt.run(...params);
        return [];
      }
      return stmt.all(...params);
    },
  };
}
