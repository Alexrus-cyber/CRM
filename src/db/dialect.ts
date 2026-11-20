/**
 * Dual-database layer: PostgreSQL (primary) + SQLite (portable fallback).
 *
 * Selection order:
 *   1. DB_DIALECT=postgres | sqlite  — explicit choice
 *   2. otherwise: if DATABASE_URL is reachable -> PostgreSQL, else -> SQLite
 *
 * All application code talks to the database through `q` / `q1` (drizzle `sql`
 * templates), so the exact same SQL source works on both engines: drizzle
 * serialises the query with the right placeholder style per dialect.
 */
import fs from "node:fs";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { Pool } from "pg";
import Database from "better-sqlite3";

export type DbDialect = "postgres" | "sqlite";

type Executor = {
  dialect: DbDialect;
  label: string;
  all<T>(query: SQL): Promise<T[]>;
  exec(statement: string): Promise<void>;
  ping(): Promise<void>;
};

const globalForDb = globalThis as typeof globalThis & {
  __crmDatabase?: Promise<Executor>;
  __crmPool?: Pool;
  __crmSqlite?: Database.Database;
};

/* ------------------------------------------------------------------ */
/* DDL — kept in sync with src/db/schema.ts (PostgreSQL / drizzle-kit) */
/* ------------------------------------------------------------------ */

const PG_DDL = [
  `create table if not exists users (
    id serial primary key,
    email text not null unique,
    password_hash text not null,
    name text not null,
    phone text,
    position text,
    bio text,
    role text not null default 'user',
    avatar_color text not null default '#7c5cff',
    avatar_url text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists sessions (
    id serial primary key,
    token text not null unique,
    user_id integer not null references users(id) on delete cascade,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists sessions_user_idx on sessions (user_id)`,
  `create table if not exists counterparties (
    id serial primary key,
    name text not null,
    phone text,
    email text,
    address text,
    inn text,
    kpp text,
    notes text,
    created_by_id integer references users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists tasks (
    id serial primary key,
    title text not null,
    description text,
    assignee_id integer not null references users(id) on delete cascade,
    author_id integer not null references users(id) on delete cascade,
    counterparty_id integer references counterparties(id) on delete set null,
    deadline date not null,
    deadline_time text,
    accepted_at timestamptz,
    hours real not null default 0,
    status text not null default 'new',
    priority text not null default 'medium',
    completed_at timestamptz,
    closed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create index if not exists tasks_assignee_idx on tasks (assignee_id)`,
  `create index if not exists tasks_author_idx on tasks (author_id)`,
  `create index if not exists tasks_deadline_idx on tasks (deadline)`,
  `create table if not exists messages (
    id serial primary key,
    sender_id integer not null references users(id) on delete cascade,
    recipient_id integer references users(id) on delete cascade,
    content text not null,
    content_lower text not null default '',
    created_at timestamptz not null default now()
  )`,
  `create index if not exists messages_created_idx on messages (created_at)`,
  `create table if not exists task_exports (
    id serial primary key,
    user_id integer not null references users(id) on delete cascade,
    task_id integer not null references tasks(id) on delete cascade,
    created_at timestamptz not null default now()
  )`,
  `create unique index if not exists task_exports_user_task_uq on task_exports (user_id, task_id)`,
  `create table if not exists task_messages (
    id serial primary key,
    task_id integer not null references tasks(id) on delete cascade,
    author_id integer not null references users(id) on delete cascade,
    content text not null,
    content_lower text not null default '',
    created_at timestamptz not null default now()
  )`,
  `create index if not exists task_messages_task_idx on task_messages (task_id, id)`,
  `create table if not exists agent_tokens (
    id serial primary key,
    user_id integer not null unique references users(id) on delete cascade,
    token text not null unique,
    created_at timestamptz not null default now()
  )`,
  // Подключения: адрес CRM, к которому подключается бот. У пользователя их
  // может быть несколько (свой сервер, тестовый, сервер заказчика), а токенов
  // на каждое — сколько нужно (по одному на машину/оператора).
  `create table if not exists agent_connections (
    id serial primary key,
    user_id integer not null references users(id) on delete cascade,
    name text not null,
    server_url text not null default '',
    is_default integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, name)
  )`,
  `create table if not exists agent_connection_tokens (
    id serial primary key,
    connection_id integer not null references agent_connections(id) on delete cascade,
    user_id integer not null references users(id) on delete cascade,
    name text not null default '',
    token text not null unique,
    created_at timestamptz not null default now(),
    last_used_at timestamptz
  )`,
  `create index if not exists agent_connections_user_idx on agent_connections (user_id)`,
  `create index if not exists agent_connection_tokens_conn_idx on agent_connection_tokens (connection_id)`,
  `create table if not exists agent_tasks (
    id serial primary key,
    user_id integer not null references users(id) on delete cascade,
    prompt text not null,
    status text not null default 'queued',
    max_steps integer not null default 15,
    steps integer not null default 0,
    summary text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create index if not exists agent_tasks_status_idx on agent_tasks (status, id)`,
  `create table if not exists agent_events (
    id serial primary key,
    task_id integer not null references agent_tasks(id) on delete cascade,
    kind text not null,
    text text not null default '',
    action text not null default '',
    file_name text not null default '',
    file_mime text not null default '',
    file_size integer not null default 0,
    file_data text not null default '',
    created_at timestamptz not null default now()
  )`,
  `create index if not exists agent_events_task_idx on agent_events (task_id, id)`,
  `create table if not exists chat_reads (
    id serial primary key,
    user_id integer not null references users(id) on delete cascade,
    peer_id integer not null default 0,
    last_read_id integer not null default 0,
    updated_at timestamptz not null default now()
  )`,
  `create unique index if not exists chat_reads_user_peer_uq on chat_reads (user_id, peer_id)`,
  `create table if not exists message_attachments (
    id serial primary key,
    message_id integer not null references messages(id) on delete cascade,
    name text not null,
    name_lower text not null default '',
    mime text not null,
    size integer not null,
    data text not null,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists message_attachments_message_idx on message_attachments (message_id)`,
  `create table if not exists ai_rag_folders (
    id serial primary key,
    user_id integer not null references users(id) on delete cascade,
    name text not null,
    files_count integer not null default 0,
    chunks_count integer not null default 0,
    chars integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists ai_chats (
    id serial primary key,
    user_id integer not null references users(id) on delete cascade,
    title text not null default 'Новый чат',
    tokens_prompt integer not null default 0,
    tokens_completion integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create index if not exists ai_chats_user_idx on ai_chats (user_id, updated_at)`,
  `create table if not exists ai_chat_messages (
    id serial primary key,
    chat_id integer not null references ai_chats(id) on delete cascade,
    role text not null,
    content text not null default '',
    reasoning text not null default '',
    attachments text not null default '[]',
    tokens integer not null default 0,
    prompt_tokens integer not null default 0,
    completion_tokens integer not null default 0,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists ai_chat_messages_chat_idx on ai_chat_messages (chat_id)`,
  `create table if not exists ai_usage_events (
    id serial primary key,
    user_id integer not null references users(id) on delete cascade,
    chat_id integer not null default 0,
    prompt_tokens integer not null default 0,
    completion_tokens integer not null default 0,
    total_tokens integer not null default 0,
    month text not null,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists ai_usage_events_user_month_idx on ai_usage_events (user_id, month)`,
  `create table if not exists ai_quota_overrides (
    id serial primary key,
    user_id integer not null references users(id) on delete cascade,
    month text not null,
    monthly_limit integer not null,
    created_by integer references users(id) on delete set null,
    created_at timestamptz not null default now()
  )`,
  `create unique index if not exists ai_quota_overrides_user_month_uq on ai_quota_overrides (user_id, month)`,
  `create index if not exists ai_rag_folders_user_idx on ai_rag_folders (user_id)`,
  `create table if not exists ai_rag_chunks (
    id serial primary key,
    folder_id integer not null references ai_rag_folders(id) on delete cascade,
    path text not null,
    chunk_index integer not null default 0,
    text text not null,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists ai_rag_chunks_folder_idx on ai_rag_chunks (folder_id)`,
  `create table if not exists ai_rag_terms (
    id serial primary key,
    folder_id integer not null references ai_rag_folders(id) on delete cascade,
    term text not null,
    chunk_id integer not null references ai_rag_chunks(id) on delete cascade,
    tf integer not null default 1
  )`,
  `create index if not exists ai_rag_terms_lookup_idx on ai_rag_terms (folder_id, term)`,
];

/**
 * SQLite schema. ISO-8601 TEXT timestamps keep sorting/comparison identical
 * to PostgreSQL, so no query has to be dialect-specific.
 */
const SQLITE_DDL = [
  `create table if not exists users (
    id integer primary key autoincrement,
    email text not null unique,
    password_hash text not null,
    name text not null,
    phone text,
    position text,
    bio text,
    role text not null default 'user',
    avatar_color text not null default '#7c5cff',
    avatar_url text,
    created_at text not null,
    updated_at text not null
  )`,
  `create table if not exists sessions (
    id integer primary key autoincrement,
    token text not null unique,
    user_id integer not null references users(id) on delete cascade,
    expires_at text not null,
    created_at text not null
  )`,
  `create index if not exists sessions_user_idx on sessions (user_id)`,
  `create table if not exists counterparties (
    id integer primary key autoincrement,
    name text not null,
    phone text,
    email text,
    address text,
    inn text,
    kpp text,
    notes text,
    created_by_id integer references users(id) on delete set null,
    created_at text not null,
    updated_at text not null
  )`,
  `create table if not exists tasks (
    id integer primary key autoincrement,
    title text not null,
    description text,
    assignee_id integer not null references users(id) on delete cascade,
    author_id integer not null references users(id) on delete cascade,
    counterparty_id integer references counterparties(id) on delete set null,
    deadline text not null,
    deadline_time text,
    accepted_at text,
    hours real not null default 0,
    status text not null default 'new',
    priority text not null default 'medium',
    completed_at text,
    closed_at text,
    created_at text not null,
    updated_at text not null
  )`,
  `create index if not exists tasks_assignee_idx on tasks (assignee_id)`,
  `create index if not exists tasks_author_idx on tasks (author_id)`,
  `create index if not exists tasks_deadline_idx on tasks (deadline)`,
  `create table if not exists messages (
    id integer primary key autoincrement,
    sender_id integer not null references users(id) on delete cascade,
    recipient_id integer references users(id) on delete cascade,
    content text not null,
    content_lower text not null default '',
    created_at text not null
  )`,
  `create index if not exists messages_created_idx on messages (created_at)`,
  `create table if not exists task_exports (
    id integer primary key autoincrement,
    user_id integer not null references users(id) on delete cascade,
    task_id integer not null references tasks(id) on delete cascade,
    created_at text not null
  )`,
  `create unique index if not exists task_exports_user_task_uq on task_exports (user_id, task_id)`,
  `create table if not exists task_messages (
    id integer primary key autoincrement,
    task_id integer not null references tasks(id) on delete cascade,
    author_id integer not null references users(id) on delete cascade,
    content text not null,
    content_lower text not null default '',
    created_at text not null
  )`,
  `create index if not exists task_messages_task_idx on task_messages (task_id, id)`,
  `create table if not exists agent_tokens (
    id integer primary key autoincrement,
    user_id integer not null unique references users(id) on delete cascade,
    token text not null unique,
    created_at text not null
  )`,
  `create table if not exists agent_connections (
    id integer primary key autoincrement,
    user_id integer not null references users(id) on delete cascade,
    name text not null,
    server_url text not null default '',
    is_default integer not null default 0,
    created_at text not null,
    updated_at text not null,
    unique (user_id, name)
  )`,
  `create table if not exists agent_connection_tokens (
    id integer primary key autoincrement,
    connection_id integer not null references agent_connections(id) on delete cascade,
    user_id integer not null references users(id) on delete cascade,
    name text not null default '',
    token text not null unique,
    created_at text not null,
    last_used_at text
  )`,
  `create index if not exists agent_connections_user_idx on agent_connections (user_id)`,
  `create index if not exists agent_connection_tokens_conn_idx on agent_connection_tokens (connection_id)`,
  `create table if not exists agent_tasks (
    id integer primary key autoincrement,
    user_id integer not null references users(id) on delete cascade,
    prompt text not null,
    status text not null default 'queued',
    max_steps integer not null default 15,
    steps integer not null default 0,
    summary text not null default '',
    created_at text not null,
    updated_at text not null
  )`,
  `create index if not exists agent_tasks_status_idx on agent_tasks (status, id)`,
  `create table if not exists agent_events (
    id integer primary key autoincrement,
    task_id integer not null references agent_tasks(id) on delete cascade,
    kind text not null,
    text text not null default '',
    action text not null default '',
    file_name text not null default '',
    file_mime text not null default '',
    file_size integer not null default 0,
    file_data text not null default '',
    created_at text not null
  )`,
  `create index if not exists agent_events_task_idx on agent_events (task_id, id)`,
  `create table if not exists chat_reads (
    id integer primary key autoincrement,
    user_id integer not null references users(id) on delete cascade,
    peer_id integer not null default 0,
    last_read_id integer not null default 0,
    updated_at text not null
  )`,
  `create unique index if not exists chat_reads_user_peer_uq on chat_reads (user_id, peer_id)`,
  `create table if not exists message_attachments (
    id integer primary key autoincrement,
    message_id integer not null references messages(id) on delete cascade,
    name text not null,
    name_lower text not null default '',
    mime text not null,
    size integer not null,
    data text not null,
    created_at text not null
  )`,
  `create index if not exists message_attachments_message_idx on message_attachments (message_id)`,
  `create table if not exists ai_rag_folders (
    id integer primary key autoincrement,
    user_id integer not null references users(id) on delete cascade,
    name text not null,
    files_count integer not null default 0,
    chunks_count integer not null default 0,
    chars integer not null default 0,
    created_at text not null,
    updated_at text not null
  )`,
  `create table if not exists ai_chats (
    id integer primary key autoincrement,
    user_id integer not null references users(id) on delete cascade,
    title text not null default 'Новый чат',
    tokens_prompt integer not null default 0,
    tokens_completion integer not null default 0,
    created_at text not null,
    updated_at text not null
  )`,
  `create index if not exists ai_chats_user_idx on ai_chats (user_id, updated_at)`,
  `create table if not exists ai_chat_messages (
    id integer primary key autoincrement,
    chat_id integer not null references ai_chats(id) on delete cascade,
    role text not null,
    content text not null default '',
    reasoning text not null default '',
    attachments text not null default '[]',
    tokens integer not null default 0,
    prompt_tokens integer not null default 0,
    completion_tokens integer not null default 0,
    created_at text not null
  )`,
  `create index if not exists ai_chat_messages_chat_idx on ai_chat_messages (chat_id)`,
  `create table if not exists ai_usage_events (
    id integer primary key autoincrement,
    user_id integer not null references users(id) on delete cascade,
    chat_id integer not null default 0,
    prompt_tokens integer not null default 0,
    completion_tokens integer not null default 0,
    total_tokens integer not null default 0,
    month text not null,
    created_at text not null
  )`,
  `create index if not exists ai_usage_events_user_month_idx on ai_usage_events (user_id, month)`,
  `create table if not exists ai_quota_overrides (
    id integer primary key autoincrement,
    user_id integer not null references users(id) on delete cascade,
    month text not null,
    monthly_limit integer not null,
    created_by integer references users(id) on delete set null,
    created_at text not null
  )`,
  `create unique index if not exists ai_quota_overrides_user_month_uq on ai_quota_overrides (user_id, month)`,
  `create table if not exists ai_rag_chunks (
    id integer primary key autoincrement,
    folder_id integer not null references ai_rag_folders(id) on delete cascade,
    path text not null,
    chunk_index integer not null default 0,
    text text not null,
    created_at text not null
  )`,
  `create index if not exists ai_rag_chunks_folder_idx on ai_rag_chunks (folder_id)`,
  `create table if not exists ai_rag_terms (
    id integer primary key autoincrement,
    folder_id integer not null references ai_rag_folders(id) on delete cascade,
    term text not null,
    chunk_id integer not null references ai_rag_chunks(id) on delete cascade,
    tf integer not null default 1
  )`,
  `create index if not exists ai_rag_terms_lookup_idx on ai_rag_terms (folder_id, term)`,
];

/* ------------------------------------------------------------------ */
/* Value normalisation (PostgreSQL may return Date / bigint-string)    */
/* ------------------------------------------------------------------ */

export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

export function toYmd(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

export function toNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ */
/* Executors                                                           */
/* ------------------------------------------------------------------ */

function sqliteFile(): string {
  return process.env.SQLITE_PATH || path.join(process.cwd(), "data", "crm.sqlite");
}

function sqliteParams(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (p instanceof Date) return p.toISOString();
    if (typeof p === "boolean") return p ? 1 : 0;
    return p;
  });
}

async function buildPostgres(): Promise<Executor> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 4000 });
  const db = drizzle(pool);
  try {
    await pool.query("select 1");
  } catch (error) {
    // Do not leak a half-open pool when we are about to fall back to SQLite.
    await pool.end().catch(() => undefined);
    throw error;
  }
  globalForDb.__crmPool = pool;

  return {
    dialect: "postgres",
    label: "PostgreSQL",
    async all<T>(query: SQL): Promise<T[]> {
      const res = await db.execute(query);
      return res.rows as T[];
    },
    async exec(statement: string) {
      await pool.query(statement);
    },
    async ping() {
      await pool.query("select 1");
    },
  };
}

async function buildSqlite(): Promise<Executor> {
  const file = sqliteFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new Database(file);
  database.pragma("journal_mode = WAL");
  // 50+ concurrent users mostly read; WAL allows readers while one writer runs.
  // busy_timeout makes writers wait for the lock instead of failing instantly.
  database.pragma("busy_timeout = 5000");
  database.pragma("synchronous = NORMAL");
  database.pragma("foreign_keys = ON");
  database.pragma("cache_size = -16000");
  database.pragma("wal_autocheckpoint = 1000");
  globalForDb.__crmSqlite = database;
  const dialect = new SQLiteSyncDialect();

  return {
    dialect: "sqlite",
    label: "SQLite",
    async all<T>(query: SQL): Promise<T[]> {
      const { sql: text, params } = dialect.sqlToQuery(query);
      const args = sqliteParams(params);
      // Short retry for SQLITE_BUSY: with several writers this avoids user-facing
      // 500s when the WAL writer lock is held by another request for a moment.
      const attempt = <R>(fn: () => R): R => {
        let lastError: unknown;
        for (let i = 0; i < 4; i += 1) {
          try {
            return fn();
          } catch (error) {
            lastError = error;
            const code = (error as { code?: string }).code ?? "";
            if (!code.startsWith("SQLITE_BUSY") && !code.startsWith("SQLITE_LOCKED")) break;
            const until = Date.now() + 50 * (i + 1);
            while (Date.now() < until) {
              /* small synchronous backoff, better-sqlite3 has no async lock wait */
            }
          }
        }
        throw lastError;
      };
      const statement = database.prepare(text);
      // better-sqlite3 requires run() for statements that return no rows
      // (INSERT/UPDATE/DELETE without RETURNING); all() throws in that case.
      if (!statement.reader) {
        attempt(() => statement.run(...args));
        return [];
      }
      return attempt(() => statement.all(...args)) as T[];
    },
    async exec(statement: string) {
      database.exec(statement);
    },
    async ping() {
      database.prepare("select 1").get();
    },
  };
}

async function init(): Promise<Executor> {
  const requested = (process.env.DB_DIALECT || "").trim().toLowerCase();
  let executor: Executor;

  if (requested === "sqlite" || requested === "sqlite3") {
    executor = await buildSqlite();
  } else if (requested === "postgres" || requested === "postgresql" || requested === "pg") {
    executor = await buildPostgres();
  } else {
    // Auto: prefer PostgreSQL when reachable, otherwise fall back to SQLite.
    try {
      executor = await buildPostgres();
    } catch (error) {
      console.warn("[db] PostgreSQL is unavailable, using SQLite instead:", (error as Error).message);
      executor = await buildSqlite();
    }
  }

  const ddl = executor.dialect === "postgres" ? PG_DDL : SQLITE_DDL;
  for (const statement of ddl) {
    await executor.exec(statement);
  }
  await migrateColumns(executor);
  await backfillMessageSearch(executor);
  console.info(`[db] connected: ${executor.label}${executor.dialect === "sqlite" ? ` (${sqliteFile()})` : ""}`);
  return executor;
}

/**
 * Additive migrations for databases created before a column existed.
 * `add column` cannot be made idempotent in SQLite, so errors about existing
 * columns are ignored while everything else is re-thrown.
 */
async function migrateColumns(executor: Executor): Promise<void> {
  const timestamp = executor.dialect === "postgres" ? "timestamptz" : "text";
  const statements = [
    `alter table tasks add column deadline_time text`,
    `alter table tasks add column accepted_at ${timestamp}`,
    // Колонка для поиска по чату: lower() в SQLite не знает кириллицу,
    // поэтому нормализуем текст в JS и ищем по готовой строке.
    `alter table messages add column content_lower text not null default ''`,
    `alter table message_attachments add column name_lower text not null default ''`,
  ];
  for (const statement of statements) {
    try {
      await executor.exec(statement);
    } catch (error) {
      const message = (error as Error).message ?? "";
      if (!/already exists|duplicate column/i.test(message)) throw error;
    }
  }
  await migrateLegacyAgentTokens(executor);
}

/**
 * Старые токены (`agent_tokens`, один на пользователя) переезжают в первое
 * подключение: у пользователя появляется «Основной CRM» с одним токеном.
 * Повторный запуск ничего не делает — обе вставки проверяют `not exists`.
 */
async function migrateLegacyAgentTokens(executor: Executor): Promise<void> {
  const statements = [
    `insert into agent_connections (user_id, name, server_url, is_default, created_at, updated_at)
     select t.user_id, 'Основной CRM', '', 1, t.created_at, t.created_at
     from agent_tokens t
     where not exists (select 1 from agent_connections c where c.user_id = t.user_id)`,
    `insert into agent_connection_tokens (connection_id, user_id, name, token, created_at, last_used_at)
     select c.id, t.user_id, 'Основной', t.token, t.created_at, null
     from agent_tokens t
     join agent_connections c on c.user_id = t.user_id
     where not exists (select 1 from agent_connection_tokens x where x.token = t.token)`,
  ];
  for (const statement of statements) {
    try {
      await executor.exec(statement);
    } catch (error) {
      // Старой таблицы может не быть (свежая база) — это нормально.
      const message = (error as Error).message ?? "";
      if (!/no such table|does not exist/i.test(message)) throw error;
    }
  }
}

/**
 * Однократное наполнение `messages.content_lower` и
 * `message_attachments.name_lower` для записей, созданных до появления поиска.
 * Дальше запрос ничего не находит и стоит копейки.
 */
async function backfillMessageSearch(executor: Executor): Promise<void> {
  for (let batch = 0; batch < 20; batch += 1) {
    const rows = await executor.all<{ id: number; content: string }>(sql`
      select id, content from messages
      where (content_lower is null or content_lower = '') and content <> ''
      limit 200`);
    if (rows.length) {
      for (const row of rows) {
        await executor.all(sql`update messages set content_lower = ${String(row.content).toLowerCase()} where id = ${row.id}`);
      }
      continue;
    }
    break;
  }

  // То же для имён вложений — по ним тоже ищем.
  for (let batch = 0; batch < 20; batch += 1) {
    const rows = await executor.all<{ id: number; name: string }>(sql`
      select id, name from message_attachments
      where (name_lower is null or name_lower = '') and name <> ''
      limit 200`);
    if (rows.length === 0) return;
    for (const row of rows) {
      await executor.all(sql`update message_attachments set name_lower = ${String(row.name).toLowerCase()} where id = ${row.id}`);
    }
  }
}

export function getDb(): Promise<Executor> {
  if (!globalForDb.__crmDatabase) {
    globalForDb.__crmDatabase = init().catch((error) => {
      globalForDb.__crmDatabase = undefined;
      throw error;
    });
  }
  return globalForDb.__crmDatabase;
}

/** Run a query and return all rows. Works on both dialects. */
export async function q<T = Record<string, unknown>>(query: SQL): Promise<T[]> {
  const db = await getDb();
  return db.all<T>(query);
}

/** Run a query and return the first row or null. */
export async function q1<T = Record<string, unknown>>(query: SQL): Promise<T | null> {
  const rows = await q<T>(query);
  return rows[0] ?? null;
}

export async function getDialect(): Promise<DbDialect> {
  return (await getDb()).dialect;
}

export async function getDialectLabel(): Promise<string> {
  return (await getDb()).label;
}

export async function getDbInfo(): Promise<{ dialect: DbDialect; label: string; target: string }> {
  const db = await getDb();
  return {
    dialect: db.dialect,
    label: db.label,
    target: db.dialect === "sqlite" ? sqliteFile() : "PostgreSQL (DATABASE_URL)",
  };
}

export async function pingDb(): Promise<void> {
  const db = await getDb();
  await db.ping();
}
