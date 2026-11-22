export const SCHEMA_TABLES: string[];

export interface MigrationExecutor {
  dialect: "postgres" | "sqlite";
  exec(statement: string): Promise<void>;
  queryRaw(sqlText: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

export function splitSqlStatements(sqlText: string): string[];
export function pgStatementToSqlite(statement: string): string;
export function runMigrations(executor: MigrationExecutor): Promise<void>;
export function wrapPgPool(pool: unknown): MigrationExecutor;
export function wrapSqliteDb(database: unknown): MigrationExecutor;
