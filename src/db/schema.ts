/**
 * Canonical PostgreSQL schema (used by `drizzle-kit push`).
 *
 * The CRM also supports SQLite: the mirrored DDL lives in `src/db/dialect.ts`
 * and is created automatically on first connection. Runtime queries go through
 * the dialect-agnostic helpers in `src/db/dialect.ts` / `src/db/repo.ts`, so the
 * same code works on both engines. This file remains the source of TypeScript
 * types for the whole application.
 */
import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  date,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export type Role = "super_admin" | "admin" | "user";
export type TaskStatus =
  | "new"
  | "in_progress"
  | "review"
  | "done"
  | "closed"
  | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "critical";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  phone: text("phone"),
  position: text("position"),
  bio: text("bio"),
  role: text("role").$type<Role>().notNull().default("user"),
  avatarColor: text("avatar_color").notNull().default("#7c5cff"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const counterparties = pgTable("counterparties", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  inn: text("inn"),
  kpp: text("kpp"),
  notes: text("notes"),
  createdById: integer("created_by_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const tasks = pgTable(
  "tasks",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    assigneeId: integer("assignee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    authorId: integer("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    counterpartyId: integer("counterparty_id").references(
      () => counterparties.id,
      { onDelete: "set null" },
    ),
    deadline: date("deadline", { mode: "string" }).notNull(),
    /** Time slot of the task (HH:MM). Null means "no exact time". */
    deadlineTime: text("deadline_time"),
    /** When the assignee accepted the task ("взял в работу"). */
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    hours: real("hours").notNull().default(0),
    status: text("status").$type<TaskStatus>().notNull().default("new"),
    priority: text("priority").$type<TaskPriority>().notNull().default("medium"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("tasks_assignee_idx").on(t.assigneeId),
    index("tasks_author_idx").on(t.authorId),
    index("tasks_deadline_idx").on(t.deadline),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    senderId: integer("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recipientId: integer("recipient_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("messages_created_idx").on(t.createdAt)],
);

/**
 * Per-user export journal: each closed task is downloaded once per person.
 * A unique (user_id, task_id) pair makes the "new only" export idempotent.
 */
export const taskExports = pgTable(
  "task_exports",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("task_exports_user_task_uq").on(t.userId, t.taskId)],
);

export type User = typeof users.$inferSelect;
export type Counterparty = typeof counterparties.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type TaskExport = typeof taskExports.$inferSelect;
