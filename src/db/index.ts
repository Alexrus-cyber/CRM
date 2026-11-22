/**
 * Public database entrypoint.
 *
 * The CRM runs on PostgreSQL or SQLite — selected at runtime by `DB_DIALECT`
 * (or automatically when PostgreSQL is unreachable). Import `q`, `q1` and the
 * helpers from here; never open a driver connection directly in app code.
 */
export {
  getDb,
  getDbInfo,
  getDialect,
  getDialectLabel,
  nowIso,
  pingDb,
  q,
  q1,
  toBool,
  toIso,
  toNum,
  toYmd,
  type DbDialect,
} from "./dialect";

export type {
  AuthUserRow,
  ChatMessage,
  CounterpartyRow,
  TaskAccessRow,
  TaskRow,
  TaskValues,
  UserLite,
} from "./repo";
