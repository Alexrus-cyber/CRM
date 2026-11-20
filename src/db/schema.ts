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

export type Role = "super_admin" | "admin" | "developer" | "manager" | "consultant" | "user";
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
    /**
     * Текст в нижнем регистре для поиска по чату: `lower()` в SQLite не знает
     * кириллицу, поэтому нормализуем строку в приложении при вставке.
     */
    contentLower: text("content_lower").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("messages_created_idx").on(t.createdAt)],
);

/**
 * Курсор прочтения переписки: до какого сообщения человек дочитал.
 * `peerId = 0` — общий чат, иначе — id собеседника.
 */
export const chatReads = pgTable(
  "chat_reads",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    peerId: integer("peer_id").notNull().default(0),
    lastReadId: integer("last_read_id").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("chat_reads_user_peer_uq").on(t.userId, t.peerId)],
);

/** Вложение сообщения: файл или картинка (base64 в БД). */
export const messageAttachments = pgTable(
  "message_attachments",
  {
    id: serial("id").primaryKey(),
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nameLower: text("name_lower").notNull().default(""),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    data: text("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("message_attachments_message_idx").on(t.messageId)],
);

/** Чат с ИИ: сессия пользователя со своим счётчиком токенов. */
export const aiChats = pgTable(
  "ai_chats",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("Новый чат"),
    tokensPrompt: integer("tokens_prompt").notNull().default(0),
    tokensCompletion: integer("tokens_completion").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("ai_chats_user_idx").on(t.userId, t.updatedAt)],
);

/** Сообщение чата с ИИ: текст, размышления и метаданные вложений. */
export const aiChatMessages = pgTable(
  "ai_chat_messages",
  {
    id: serial("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => aiChats.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull().default(""),
    reasoning: text("reasoning").notNull().default(""),
    /** JSON-массив {name, kind, size, note}. */
    attachments: text("attachments").notNull().default("[]"),
    tokens: integer("tokens").notNull().default(0),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("ai_chat_messages_chat_idx").on(t.chatId)],
);

/** Журнал расхода токенов: месячные лимиты и общий счётчик аккаунта. */
export const aiUsageEvents = pgTable(
  "ai_usage_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Чат-источник; без FK, чтобы удаление чата не стирало историю аккаунта. */
    chatId: integer("chat_id").notNull().default(0),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    /** Месяц в формате YYYY-MM — по нему считаются квоты. */
    month: text("month").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("ai_usage_events_user_month_idx").on(t.userId, t.month)],
);

/** Расширение месячного лимита ИИ, которое выдаёт администратор. */
export const aiQuotaOverrides = pgTable(
  "ai_quota_overrides",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    monthlyLimit: integer("monthly_limit").notNull(),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("ai_quota_overrides_user_month_uq").on(t.userId, t.month)],
);

/** RAG-папка пользователя для блока «Чат с ИИ» (хранится в базе, без лимита). */
export const aiRagFolders = pgTable(
  "ai_rag_folders",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    filesCount: integer("files_count").notNull().default(0),
    chunksCount: integer("chunks_count").notNull().default(0),
    chars: integer("chars").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("ai_rag_folders_user_idx").on(t.userId)],
);

/** Фрагмент текста из файла папки — единица поиска и контекста. */
export const aiRagChunks = pgTable(
  "ai_rag_chunks",
  {
    id: serial("id").primaryKey(),
    folderId: integer("folder_id")
      .notNull()
      .references(() => aiRagFolders.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    chunkIndex: integer("chunk_index").notNull().default(0),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("ai_rag_chunks_folder_idx").on(t.folderId)],
);

/** Обратный индекс: основа слова → фрагмент и её частота (для BM25-поиска). */
export const aiRagTerms = pgTable(
  "ai_rag_terms",
  {
    id: serial("id").primaryKey(),
    folderId: integer("folder_id")
      .notNull()
      .references(() => aiRagFolders.id, { onDelete: "cascade" }),
    term: text("term").notNull(),
    chunkId: integer("chunk_id")
      .notNull()
      .references(() => aiRagChunks.id, { onDelete: "cascade" }),
    tf: integer("tf").notNull().default(1),
  },
  (t) => [index("ai_rag_terms_lookup_idx").on(t.folderId, t.term)],
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

/**
 * Быстрая переписка по задаче: короткие сообщения участников, а не большой
 * чат. Живёт вместе с задачей (удаление задачи удаляет и обсуждение).
 */
export const taskMessages = pgTable(
  "task_messages",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    authorId: integer("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    /** Нижний регистр — для поиска без `lower()` (SQLite не знает кириллицу). */
    contentLower: text("content_lower").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("task_messages_task_idx").on(t.taskId, t.id)],
);

/**
 * Подключение бота-оператора: адрес CRM. У пользователя их может быть несколько
 * («свой сервер», «тестовый», «у заказчика»), токенов на каждое — сколько нужно.
 */
export const agentConnections = pgTable(
  "agent_connections",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    serverUrl: text("server_url").notNull().default(""),
    /** 1 — подключение по умолчанию (для интерфейса и старых клиентов). */
    isDefault: integer("is_default").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_connections_user_name_idx").on(t.userId, t.name),
    index("agent_connections_user_idx").on(t.userId),
  ],
);

/** Токены подключения: по одному на машину/оператора, отзываются по отдельности. */
export const agentConnectionTokens = pgTable(
  "agent_connection_tokens",
  {
    id: serial("id").primaryKey(),
    connectionId: integer("connection_id")
      .notNull()
      .references(() => agentConnections.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull().default(""),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Когда токен последний раз обращался к CRM — видно в списке. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("agent_connection_tokens_conn_idx").on(t.connectionId)],
);

/** Старые токены (один на пользователя). Оставлены для совместимости и миграции. */
export const agentTokens = pgTable("agent_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** История двух чатов: планировщик «Оператора» и интерактивный «Агент». */
export const agentConversations = pgTable(
  "agent_conversations",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"plan" | "agent">().notNull(),
    title: text("title").notNull().default("Новый чат"),
    /** Настраиваемый отдельно для каждого план-чата; для агента пусто. */
    systemPrompt: text("system_prompt").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_conversations_user_kind_idx").on(t.userId, t.kind, t.updatedAt)],
);

/** Текст истории и только метаданные вложений/созданных файлов (без их байтов). */
export const agentConversationMessages = pgTable(
  "agent_conversation_messages",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => agentConversations.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull().default(""),
    reasoning: text("reasoning").notNull().default(""),
    attachments: text("attachments").notNull().default("[]"),
    actions: text("actions").notNull().default("[]"),
    files: text("files").notNull().default("[]"),
    error: text("error").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_conversation_messages_conversation_idx").on(t.conversationId)],
);

/** Задание для агента-оператора: ставится в CRM, забирается ботом. */
export const agentTasks = pgTable(
  "agent_tasks",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    /** queued | running | done | failed | cancelled */
    status: text("status").notNull().default("queued"),
    maxSteps: integer("max_steps").notNull().default(15),
    steps: integer("steps").notNull().default(0),
    summary: text("summary").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_tasks_status_idx").on(t.status, t.id)],
);

/** Журнал шагов агента и файлы, которые он вернул в чат. */
export const agentEvents = pgTable(
  "agent_events",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => agentTasks.id, { onDelete: "cascade" }),
    /** thought | action | result | file | error | info */
    kind: text("kind").notNull(),
    text: text("text").notNull().default(""),
    action: text("action").notNull().default(""),
    fileName: text("file_name").notNull().default(""),
    fileMime: text("file_mime").notNull().default(""),
    fileSize: integer("file_size").notNull().default(0),
    fileData: text("file_data").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_events_task_idx").on(t.taskId, t.id)],
);

export type User = typeof users.$inferSelect;
export type Counterparty = typeof counterparties.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type TaskMessage = typeof taskMessages.$inferSelect;
export type AgentTask = typeof agentTasks.$inferSelect;
export type AgentEvent = typeof agentEvents.$inferSelect;
export type AgentConversation = typeof agentConversations.$inferSelect;
export type AgentConversationMessage = typeof agentConversationMessages.$inferSelect;
export type TaskExport = typeof taskExports.$inferSelect;
export type AiRagFolder = typeof aiRagFolders.$inferSelect;
export type AiChat = typeof aiChats.$inferSelect;
export type AiChatMessage = typeof aiChatMessages.$inferSelect;
export type AiUsageEvent = typeof aiUsageEvents.$inferSelect;
export type AiQuotaOverride = typeof aiQuotaOverrides.$inferSelect;
