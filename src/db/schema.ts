/**
 * Canonical PostgreSQL schema (used by `drizzle-kit` and type generation).
 *
 * SQL migrations in `drizzle/*.sql` are the single SQL source applied by
 * `src/db/migrate.mjs` across both PostgreSQL and SQLite at runtime.
 */
import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
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
  isBot: boolean("is_bot").notNull().default(false),
  canUseAgent: boolean("can_use_agent").notNull().default(false),
  canUseOperator: boolean("can_use_operator").notNull().default(false),
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
    /** Хранится только SHA-256 хеш токена (`sha256:...`). */
    token: text("token").notNull().unique(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
    ip: text("ip").notNull().default(""),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("sessions_user_idx").on(t.userId),
    index("sessions_user_revoked_idx").on(t.userId, t.revokedAt, t.expiresAt),
  ],
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

export type ChatRoomKind = "group" | "shared";

export const chatRooms = pgTable(
  "chat_rooms",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    kind: text("kind").$type<ChatRoomKind>().notNull().default("group"),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_rooms_created_by_idx").on(t.createdBy)],
);

export const chatRoomMembers = pgTable(
  "chat_room_members",
  {
    id: serial("id").primaryKey(),
    roomId: integer("room_id")
      .notNull()
      .references(() => chatRooms.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addedBy: integer("added_by").references(() => users.id, { onDelete: "set null" }),
    role: text("role").$type<"owner" | "member">().notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("chat_room_members_room_user_uq").on(t.roomId, t.userId),
    index("chat_room_members_user_idx").on(t.userId),
  ],
);

export const chatRoomReads = pgTable(
  "chat_room_reads",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roomId: integer("room_id")
      .notNull()
      .references(() => chatRooms.id, { onDelete: "cascade" }),
    lastReadId: integer("last_read_id").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("chat_room_reads_user_room_uq").on(t.userId, t.roomId)],
);

export const chatGeneralBots = pgTable("chat_general_bots", {
  id: serial("id").primaryKey(),
  botUserId: integer("bot_user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  addedBy: integer("added_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiBotConfigs = pgTable("ai_bot_configs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("local"),
  baseUrl: text("base_url").notNull().default(""),
  /** Хранится зашифрованным (`enc1:...`). */
  apiKey: text("api_key").notNull().default(""),
  model: text("model").notNull().default(""),
  systemPrompt: text("system_prompt").notNull().default(""),
  paramsJson: text("params_json").notNull().default("{}"),
  replyMode: text("reply_mode").$type<"mention" | "always">().notNull().default("mention"),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiUserSettings = pgTable("ai_user_settings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  baseUrl: text("base_url").notNull().default(""),
  apiKeyEncrypted: text("api_key_encrypted").notNull().default(""),
  apiKeyHint: text("api_key_hint").notNull().default(""),
  model: text("model").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    roomId: integer("room_id").references(() => chatRooms.id, {
      onDelete: "cascade",
    }),
    content: text("content").notNull(),
    contentLower: text("content_lower").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("messages_created_idx").on(t.createdAt),
    index("messages_room_idx").on(t.roomId, t.id),
    index("messages_sender_recipient_id_idx").on(t.senderId, t.recipientId, t.id),
    index("messages_recipient_sender_id_idx").on(t.recipientId, t.senderId, t.id),
  ],
);

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

/** Вложение сообщения: файл в файловом хранилище (`storage_key`), поле `data` сохранено для старых записей. */
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
    storageKey: text("storage_key").notNull().default(""),
    data: text("data").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("message_attachments_message_idx").on(t.messageId)],
);

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

export const aiUsageEvents = pgTable(
  "ai_usage_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    chatId: integer("chat_id").notNull().default(0),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    month: text("month").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("ai_usage_events_user_month_idx").on(t.userId, t.month)],
);

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
    contentLower: text("content_lower").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("task_messages_task_idx").on(t.taskId, t.id)],
);

export const agentConnections = pgTable(
  "agent_connections",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    serverUrl: text("server_url").notNull().default(""),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_connections_user_name_idx").on(t.userId, t.name),
    index("agent_connections_user_idx").on(t.userId),
  ],
);

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
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("agent_connection_tokens_conn_idx").on(t.connectionId)],
);

export const agentTokens = pgTable("agent_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentConversations = pgTable(
  "agent_conversations",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"plan" | "agent">().notNull(),
    title: text("title").notNull().default("Новый чат"),
    systemPrompt: text("system_prompt").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_conversations_user_kind_idx").on(t.userId, t.kind, t.updatedAt)],
);

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

export const agentTasks = pgTable(
  "agent_tasks",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    status: text("status").notNull().default("queued"),
    maxSteps: integer("max_steps").notNull().default(15),
    steps: integer("steps").notNull().default(0),
    summary: text("summary").notNull().default(""),
    trustLevel: text("trust_level").notNull().default("verified"),
    taskMode: text("task_mode").notNull().default("autonomous"),
    source: text("source").notNull().default("operator"),
    coachMode: text("coach_mode").notNull().default("after_step"),
    guidanceNote: text("guidance_note").notNull().default(""),
    pendingApproval: text("pending_approval").notNull().default(""),
    approvalResponse: text("approval_response").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_tasks_status_idx").on(t.status, t.id)],
);

export const agentTranscripts = pgTable(
  "agent_transcripts",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: integer("conversation_id").notNull().default(0),
    title: text("title").notNull().default("Переписка агента"),
    summary: text("summary").notNull().default(""),
    fileName: text("file_name").notNull(),
    content: text("content").notNull(),
    chars: integer("chars").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_transcripts_user_idx").on(t.userId, t.id)],
);

export const agentEvents = pgTable(
  "agent_events",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => agentTasks.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    text: text("text").notNull().default(""),
    action: text("action").notNull().default(""),
    fileName: text("file_name").notNull().default(""),
    fileMime: text("file_mime").notNull().default(""),
    fileSize: integer("file_size").notNull().default(0),
    storageKey: text("storage_key").notNull().default(""),
    fileData: text("file_data").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_events_task_idx").on(t.taskId, t.id)],
);

export const agentUsageEvents = pgTable(
  "agent_usage_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"agent" | "operator">().notNull(),
    refId: integer("ref_id").notNull().default(0),
    model: text("model").notNull().default(""),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    month: text("month").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_usage_events_user_kind_month_idx").on(t.userId, t.kind, t.month)],
);

export const githubConnections = pgTable("github_connections", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  githubUserId: integer("github_user_id").notNull().default(0),
  login: text("login").notNull(),
  name: text("name").notNull().default(""),
  email: text("email").notNull().default(""),
  avatarUrl: text("avatar_url").notNull().default(""),
  tokenEncrypted: text("token_encrypted").notNull(),
  tokenHint: text("token_hint").notNull().default(""),
  scopes: text("scopes").notNull().default(""),
  selectedOwner: text("selected_owner").notNull().default(""),
  selectedRepo: text("selected_repo").notNull().default(""),
  selectedBranch: text("selected_branch").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type GithubConnection = typeof githubConnections.$inferSelect;
export type AiUserSettingsRow = typeof aiUserSettings.$inferSelect;
export type Counterparty = typeof counterparties.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ChatRoom = typeof chatRooms.$inferSelect;
export type ChatRoomMember = typeof chatRoomMembers.$inferSelect;
export type AiBotConfig = typeof aiBotConfigs.$inferSelect;
export type AgentUsageEvent = typeof agentUsageEvents.$inferSelect;
export type TaskMessage = typeof taskMessages.$inferSelect;
export type AgentTask = typeof agentTasks.$inferSelect;
export type AgentEvent = typeof agentEvents.$inferSelect;
export type AgentTranscript = typeof agentTranscripts.$inferSelect;
export type AgentConversation = typeof agentConversations.$inferSelect;
export type AgentConversationMessage = typeof agentConversationMessages.$inferSelect;
export type TaskExport = typeof taskExports.$inferSelect;
export type AiRagFolder = typeof aiRagFolders.$inferSelect;
export type AiChat = typeof aiChats.$inferSelect;
export type AiChatMessage = typeof aiChatMessages.$inferSelect;
export type AiUsageEvent = typeof aiUsageEvents.$inferSelect;
export type AiQuotaOverride = typeof aiQuotaOverrides.$inferSelect;
