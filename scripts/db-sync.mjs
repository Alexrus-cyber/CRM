#!/usr/bin/env node
/**
 * Перенос данных CRM между PostgreSQL и SQLite с сохранением единой схемы миграций.
 *
 *   node scripts/db-sync.mjs status        # показать количество строк в обоих движках
 *   node scripts/db-sync.mjs pg2sqlite     # скопировать PostgreSQL -> SQLite
 *   node scripts/db-sync.mjs sqlite2pg     # скопировать SQLite -> PostgreSQL
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import Database from "better-sqlite3";
import { SCHEMA_TABLES, runMigrations, wrapPgPool, wrapSqliteDb } from "../src/db/migrate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (fs.existsSync(path.join(root, ".env"))) {
  for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(root, "data", "crm.sqlite");

const BOOLEAN_COLS = new Set([
  "is_bot",
  "can_use_agent",
  "can_use_operator",
  "is_active",
  "is_default",
  "enabled",
]);

const INT_COLS = new Set([
  "id",
  "user_id",
  "chat_id",
  "folder_id",
  "chunk_id",
  "created_by",
  "monthly_limit",
  "tokens_prompt",
  "tokens_completion",
  "tokens",
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
  "room_id",
  "added_by",
  "bot_user_id",
  "peer_id",
  "last_read_id",
  "message_id",
  "connection_id",
  "conversation_id",
  "size",
  "file_size",
  "task_id",
  "max_steps",
  "steps",
  "ref_id",
  "github_user_id",
]);

function normaliseValue(column, value, targetDialect) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return column === "deadline" ? value.toISOString().slice(0, 10) : value.toISOString();
  }
  if (BOOLEAN_COLS.has(column)) {
    const truthy = value === true || value === 1 || value === "1" || value === "t" || value === "true";
    return targetDialect === "postgres" ? truthy : truthy ? 1 : 0;
  }
  if (INT_COLS.has(column)) return Number(value);
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

async function withSqlite(fn) {
  fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
  const db = new Database(SQLITE_PATH);
  db.pragma("foreign_keys = ON");
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

async function getPgColumns(pool, table) {
  const res = await pool.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = $1 and column_name <> 'search_vector'
     order by ordinal_position asc`,
    [table],
  );
  return res.rows.map((r) => r.column_name);
}

function getSqliteColumns(db, table) {
  return db.prepare(`pragma table_info(${table})`).all().map((c) => c.name);
}

async function dumpPg(pool) {
  await runMigrations(wrapPgPool(pool));
  const data = {};
  for (const table of SCHEMA_TABLES) {
    const cols = await getPgColumns(pool, table);
    const res = await pool.query(`select ${cols.join(", ")} from ${table} order by id asc`);
    data[table] = { columns: cols, rows: res.rows };
  }
  return data;
}

async function dumpSqlite(db) {
  await runMigrations(wrapSqliteDb(db));
  const data = {};
  for (const table of SCHEMA_TABLES) {
    const cols = getSqliteColumns(db, table);
    const rows = db.prepare(`select ${cols.join(", ")} from ${table} order by id asc`).all();
    data[table] = { columns: cols, rows };
  }
  return data;
}

async function writePg(pool, data) {
  await runMigrations(wrapPgPool(pool));
  const client = await pool.connect();
  try {
    await client.query("begin");
    const reverseList = [...SCHEMA_TABLES].reverse().join(", ");
    await client.query(`truncate table ${reverseList} restart identity cascade`);
    for (const table of SCHEMA_TABLES) {
      const targetCols = await getPgColumns(pool, table);
      const source = data[table] ?? { columns: targetCols, rows: [] };
      const sourceSet = new Set(source.columns);
      const cols = targetCols.filter((c) => sourceSet.has(c));
      if (cols.length === 0) continue;
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const insertSql = `insert into ${table} (${cols.join(", ")}) values (${placeholders})`;
      for (const row of source.rows) {
        const values = cols.map((c) => normaliseValue(c, row[c], "postgres"));
        await client.query(insertSql, values);
      }
      await client.query(
        `select setval(pg_get_serial_sequence('${table}', 'id'), coalesce((select max(id) from ${table}), 1))`,
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

async function writeSqlite(db, data) {
  await runMigrations(wrapSqliteDb(db));
  db.pragma("foreign_keys = OFF");
  const tx = db.transaction(() => {
    for (const table of [...SCHEMA_TABLES].reverse()) {
      db.prepare(`delete from ${table}`).run();
    }
    for (const table of SCHEMA_TABLES) {
      const targetCols = getSqliteColumns(db, table);
      const source = data[table] ?? { columns: targetCols, rows: [] };
      const sourceSet = new Set(source.columns);
      const cols = targetCols.filter((c) => sourceSet.has(c));
      if (cols.length === 0) continue;
      const insert = db.prepare(
        `insert into ${table} (${cols.join(", ")}) values (${cols.map(() => "?").join(", ")})`,
      );
      for (const row of source.rows) {
        insert.run(...cols.map((c) => normaliseValue(c, row[c], "sqlite")));
      }
    }
  });
  tx();
  db.pragma("foreign_keys = ON");
}

function report(data) {
  for (const table of SCHEMA_TABLES) {
    console.log(`  ${table.padEnd(28)} ${String((data[table]?.rows ?? []).length).padStart(5)}`);
  }
}

const command = process.argv[2] ?? "status";

if (command === "pg2sqlite") {
  const data = await withPg(dumpPg);
  await withSqlite((db) => writeSqlite(db, data));
  console.log(`Copied PostgreSQL -> SQLite (${SQLITE_PATH})`);
  report(data);
} else if (command === "sqlite2pg") {
  const data = await withSqlite(dumpSqlite);
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
    const data = await withSqlite(dumpSqlite);
    console.log(`SQLite (${SQLITE_PATH}):`);
    report(data);
  } catch (error) {
    console.log("SQLite: unavailable —", error.message);
  }
} else {
  console.log("Usage: node scripts/db-sync.mjs [status|pg2sqlite|sqlite2pg]");
  process.exit(1);
}
