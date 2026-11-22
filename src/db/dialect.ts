/**
 * Dual-database layer: PostgreSQL (primary) + SQLite (portable fallback).
 *
 * Selection order:
 *   1. DB_DIALECT=postgres | sqlite  — explicit choice
 *   2. otherwise: if DATABASE_URL is reachable -> PostgreSQL, else -> SQLite
 *
 * Schema creation & migrations live in `drizzle/*.sql` + `src/db/migrate.mjs`.
 */
import fs from "node:fs";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { Pool } from "pg";
import Database from "better-sqlite3";
import { runMigrations } from "./migrate.mjs";

export type DbDialect = "postgres" | "sqlite";

type Executor = {
  dialect: DbDialect;
  label: string;
  all<T>(query: SQL): Promise<T[]>;
  exec(statement: string): Promise<void>;
  queryRaw(sqlText: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  ping(): Promise<void>;
};

const globalForDb = globalThis as typeof globalThis & {
  __crmDatabase?: Promise<Executor>;
  __crmPool?: Pool;
  __crmSqlite?: Database.Database;
};

/* ------------------------------------------------------------------ */
/* Value normalisation (PostgreSQL may return Date / bigint / boolean) */
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

export function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "t" || value === "true";
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
    async queryRaw(sqlText: string, params: unknown[] = []) {
      const res = await pool.query(sqlText, params);
      return res.rows as Record<string, unknown>[];
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
  database.pragma("busy_timeout = 5000");
  database.pragma("synchronous = NORMAL");
  database.pragma("foreign_keys = ON");
  database.pragma("cache_size = -16000");
  database.pragma("wal_autocheckpoint = 1000");
  globalForDb.__crmSqlite = database;
  const dialect = new SQLiteSyncDialect();

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
          /* brief synchronous retry for WAL contention */
        }
      }
    }
    throw lastError;
  };

  return {
    dialect: "sqlite",
    label: "SQLite",
    async all<T>(query: SQL): Promise<T[]> {
      const { sql: text, params } = dialect.sqlToQuery(query);
      const args = sqliteParams(params);
      const statement = database.prepare(text);
      if (!statement.reader) {
        attempt(() => statement.run(...args));
        return [];
      }
      return attempt(() => statement.all(...args)) as T[];
    },
    async exec(statement: string) {
      database.exec(statement);
    },
    async queryRaw(sqlText: string, params: unknown[] = []) {
      const args = sqliteParams(params);
      const statement = database.prepare(sqlText);
      if (!statement.reader) {
        attempt(() => statement.run(...args));
        return [];
      }
      return attempt(() => statement.all(...args)) as Record<string, unknown>[];
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
    try {
      executor = await buildPostgres();
    } catch (error) {
      console.warn("[db] PostgreSQL is unavailable, using SQLite instead:", (error as Error).message);
      executor = await buildSqlite();
    }
  }

  await runMigrations(executor);
  await backfillMessageSearch(executor);
  console.info(`[db] connected: ${executor.label}${executor.dialect === "sqlite" ? ` (${sqliteFile()})` : ""}`);
  return executor;
}

/**
 * Однократное наполнение `messages.content_lower` и `message_attachments.name_lower`
 * для записей, созданных до появления поиска.
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
