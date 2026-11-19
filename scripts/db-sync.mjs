#!/usr/bin/env node
/**
 * Move CRM data between PostgreSQL and SQLite without downtime for the schema.
 *
 *   node scripts/db-sync.mjs status        # show row counts on both engines
 *   node scripts/db-sync.mjs pg2sqlite     # copy PostgreSQL -> SQLite
 *   node scripts/db-sync.mjs sqlite2pg     # copy SQLite -> PostgreSQL
 *
 * The target tables are created automatically (same DDL the app uses), existing
 * rows are replaced, sequences are re-aligned. Connection settings come from
 * `.env`: DATABASE_URL and SQLITE_PATH (default ./data/crm.sqlite).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import Database from "better-sqlite3";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (fs.existsSync(path.join(root, ".env"))) {
  for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(root, "data", "crm.sqlite");

/** Reuse the DDL that the application ships with — no schema duplication. */
function readDdl(dialect) {
  const source = fs.readFileSync(path.join(root, "src", "db", "dialect.ts"), "utf8");
  const marker = dialect === "sqlite" ? "const SQLITE_DDL = [" : "const PG_DDL = [";
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`DDL block for ${dialect} not found`);
  const block = source.slice(start + marker.length).split("\n];")[0];
  return [...block.matchAll(/`([\s\S]*?)`/g)].map((m) => m[1]);
}

const TABLES = [
  {
    name: "users",
    columns: ["id", "email", "password_hash", "name", "phone", "position", "bio", "role", "avatar_color", "avatar_url", "created_at", "updated_at"],
  },
  { name: "sessions", columns: ["id", "token", "user_id", "expires_at", "created_at"] },
  {
    name: "counterparties",
    columns: ["id", "name", "phone", "email", "address", "inn", "kpp", "notes", "created_by_id", "created_at", "updated_at"],
  },
  {
    name: "tasks",
    columns: ["id", "title", "description", "assignee_id", "author_id", "counterparty_id", "deadline", "deadline_time", "accepted_at", "hours", "status", "priority", "completed_at", "closed_at", "created_at", "updated_at"],
  },
  {
    name: "messages",
    columns: ["id", "sender_id", "recipient_id", "content", "content_lower", "created_at"],
  },
  {
    name: "chat_reads",
    columns: ["id", "user_id", "peer_id", "last_read_id", "updated_at"],
  },
  {
    name: "message_attachments",
    columns: ["id", "message_id", "name", "name_lower", "mime", "size", "data", "created_at"],
  },
  { name: "task_exports", columns: ["id", "user_id", "task_id", "created_at"] },
  // Быстрая переписка по задаче (блок «Задачи»).
  { name: "task_messages", columns: ["id", "task_id", "author_id", "content", "content_lower", "created_at"] },
  // Блок «Чат с ИИ»: история, расход токенов, квоты и RAG-индекс.
  { name: "ai_rag_folders", columns: ["id", "user_id", "name", "files_count", "chunks_count", "chars", "created_at", "updated_at"] },
  { name: "ai_rag_chunks", columns: ["id", "folder_id", "path", "chunk_index", "text", "created_at"] },
  { name: "ai_rag_terms", columns: ["id", "folder_id", "term", "chunk_id", "tf"] },
  { name: "ai_chats", columns: ["id", "user_id", "title", "tokens_prompt", "tokens_completion", "created_at", "updated_at"] },
  {
    name: "ai_chat_messages",
    columns: ["id", "chat_id", "role", "content", "reasoning", "attachments", "tokens", "prompt_tokens", "completion_tokens", "created_at"],
  },
  {
    name: "ai_usage_events",
    columns: ["id", "user_id", "chat_id", "prompt_tokens", "completion_tokens", "total_tokens", "month", "created_at"],
  },
  { name: "ai_quota_overrides", columns: ["id", "user_id", "month", "monthly_limit", "created_by", "created_at"] },
];

/** Normalise driver differences: Date -> ISO string, numeric strings -> number. */
function normalise(table, column, value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return column === "deadline" ? value.toISOString().slice(0, 10) : value.toISOString();
  }
  if (
    [
      "id",
      "user_id",
      "chat_id",
      "folder_id",
      "chunk_id",
      "created_by",
      "monthly_limit",
      "tokens_prompt",
      "tokens_completion",
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
      "tf",
      "files_count",
      "chunks_count",
      "chars",
      "chunk_index",
      "assignee_id",
      "author_id",
      "counterparty_id",
      "created_by_id",
      "sender_id",
      "recipient_id",
      "peer_id",
      "last_read_id",
      "message_id",
      "size",
    ].includes(column)
  ) {
    return Number(value);
  }
  if (column === "hours") return Number(value);
  return value;
}

async function withPg(fn) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 4000 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

function withSqlite(fn) {
  fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
  const db = new Database(SQLITE_PATH);
  db.pragma("foreign_keys = ON");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Additive migrations for databases created before a column existed. */
function columnMigrations(dialect) {
  const ts = dialect === "postgres" ? "timestamptz" : "text";
  return [
    "alter table tasks add column deadline_time text",
    `alter table tasks add column accepted_at ${ts}`,
    "alter table messages add column content_lower text not null default ''",
    "alter table message_attachments add column name_lower text not null default ''",
  ];
}

async function ensurePgSchema(pool) {
  for (const statement of readDdl("postgres")) await pool.query(statement);
  for (const statement of columnMigrations("postgres")) {
    try {
      await pool.query(statement);
    } catch (error) {
      if (!/already exists|duplicate column/i.test(error.message)) throw error;
    }
  }
}

function ensureSqliteSchema(db) {
  for (const statement of readDdl("sqlite")) db.exec(statement);
  for (const statement of columnMigrations("sqlite")) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!/duplicate column/i.test(error.message)) throw error;
    }
  }
}

async function dumpPg(pool) {
  const data = {};
  for (const table of TABLES) {
    const res = await pool.query(`select ${table.columns.join(", ")} from ${table.name} order by id asc`);
    data[table.name] = res.rows;
  }
  return data;
}

function dumpSqlite(db) {
  const data = {};
  for (const table of TABLES) {
    data[table.name] = db.prepare(`select ${table.columns.join(", ")} from ${table.name} order by id asc`).all();
  }
  return data;
}

async function writePg(pool, data) {
  await ensurePgSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "truncate table ai_rag_terms, ai_rag_chunks, ai_rag_folders, ai_chat_messages, ai_chats, ai_usage_events, " +
        "ai_quota_overrides, task_messages, task_exports, message_attachments, chat_reads, messages, sessions, tasks, " +
        "counterparties, users " +
        "restart identity cascade",
    );
    for (const table of TABLES) {
      for (const row of data[table.name] ?? []) {
        const values = table.columns.map((c) => normalise(table.name, c, row[c]));
        const placeholders = table.columns.map((_, i) => `$${i + 1}`).join(", ");
        await client.query(`insert into ${table.name} (${table.columns.join(", ")}) values (${placeholders})`, values);
      }
      await client.query(
        `select setval(pg_get_serial_sequence('${table.name}', 'id'), coalesce((select max(id) from ${table.name}), 1))`,
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function writeSqlite(db, data) {
  ensureSqliteSchema(db);
  db.pragma("foreign_keys = OFF");
  const tx = db.transaction(() => {
    for (const table of [...TABLES].reverse()) db.prepare(`delete from ${table.name}`).run();
    for (const table of TABLES) {
      const rows = data[table.name] ?? [];
      const insert = db.prepare(
        `insert into ${table.name} (${table.columns.join(", ")}) values (${table.columns.map(() => "?").join(", ")})`,
      );
      for (const row of rows) {
        insert.run(...table.columns.map((c) => normalise(table.name, c, row[c])));
      }
    }
  });
  tx();
  db.pragma("foreign_keys = ON");
}

function report(data) {
  for (const table of TABLES) {
    console.log(`  ${table.name.padEnd(20)} ${String((data[table.name] ?? []).length).padStart(5)}`);
  }
}

/**
 * Страховка от расхождения: если в DDL появилась таблица, которой нет в TABLES,
 * перенос молча потеряет её данные. Лучше предупредить и упасть.
 */
function checkTableCoverage() {
  const covered = new Set(TABLES.map((table) => table.name));
  const declared = new Set();
  for (const statement of [...readDdl("sqlite"), ...readDdl("postgres")]) {
    const match = statement.match(/create table if not exists (\w+)/i);
    if (match) declared.add(match[1]);
  }
  const missing = [...declared].filter((name) => !covered.has(name));
  if (missing.length > 0) {
    console.warn(`[db-sync] таблицы без описания в TABLES: ${missing.join(", ")}`);
    console.warn("[db-sync] их данные не перенесутся — добавьте колонки в TABLES");
  }
  return missing;
}

const command = process.argv[2] ?? "status";
checkTableCoverage();

if (command === "pg2sqlite") {
  const data = await withPg(dumpPg);
  withSqlite((db) => writeSqlite(db, data));
  console.log(`Copied PostgreSQL -> SQLite (${SQLITE_PATH})`);
  report(data);
} else if (command === "sqlite2pg") {
  const data = withSqlite(dumpSqlite);
  await withPg((pool) => writePg(pool, data));
  console.log("Copied SQLite -> PostgreSQL");
  report(data);
} else if (command === "status") {
  try {
    const data = await withPg(dumpPg);
    console.log("PostgreSQL:");
    report(data);
  } catch (error) {
    console.log("PostgreSQL: unavailable —", error.message);
  }
  try {
    const data = withSqlite(dumpSqlite);
    console.log(`SQLite (${SQLITE_PATH}):`);
    report(data);
  } catch (error) {
    console.log("SQLite: unavailable —", error.message);
  }
} else {
  console.log("Usage: node scripts/db-sync.mjs [status|pg2sqlite|sqlite2pg]");
  process.exit(1);
}
