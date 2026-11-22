-- Baseline CRM schema (PostgreSQL canonical DDL; translated for SQLite by src/db/migrate.mjs)

create table if not exists users (
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
  is_bot boolean not null default false,
  can_use_agent boolean not null default false,
  can_use_operator boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sessions (
  id serial primary key,
  token text not null unique,
  user_id integer not null references users(id) on delete cascade,
  label text not null default '',
  user_agent text not null default '',
  ip text not null default '',
  last_seen_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions (user_id);

create table if not exists counterparties (
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
);

create table if not exists tasks (
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
);
create index if not exists tasks_assignee_idx on tasks (assignee_id);
create index if not exists tasks_author_idx on tasks (author_id);
create index if not exists tasks_deadline_idx on tasks (deadline);

create table if not exists chat_rooms (
  id serial primary key,
  name text not null,
  description text not null default '',
  kind text not null default 'group',
  created_by integer references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists chat_rooms_created_by_idx on chat_rooms (created_by);

create table if not exists chat_room_members (
  id serial primary key,
  room_id integer not null references chat_rooms(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  added_by integer references users(id) on delete set null,
  role text not null default 'member',
  created_at timestamptz not null default now()
);
create unique index if not exists chat_room_members_room_user_uq on chat_room_members (room_id, user_id);
create index if not exists chat_room_members_user_idx on chat_room_members (user_id);

create table if not exists chat_room_reads (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  room_id integer not null references chat_rooms(id) on delete cascade,
  last_read_id integer not null default 0,
  updated_at timestamptz not null default now()
);
create unique index if not exists chat_room_reads_user_room_uq on chat_room_reads (user_id, room_id);

create table if not exists chat_general_bots (
  id serial primary key,
  bot_user_id integer not null unique references users(id) on delete cascade,
  added_by integer references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists ai_bot_configs (
  id serial primary key,
  user_id integer not null unique references users(id) on delete cascade,
  provider text not null default 'local',
  base_url text not null default '',
  api_key text not null default '',
  model text not null default '',
  system_prompt text not null default '',
  params_json text not null default '{}',
  reply_mode text not null default 'mention',
  is_active boolean not null default true,
  created_by integer references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id serial primary key,
  sender_id integer not null references users(id) on delete cascade,
  recipient_id integer references users(id) on delete cascade,
  room_id integer references chat_rooms(id) on delete cascade,
  content text not null,
  content_lower text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists messages_created_idx on messages (created_at);
create index if not exists messages_room_idx on messages (room_id, id);

create table if not exists chat_reads (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  peer_id integer not null default 0,
  last_read_id integer not null default 0,
  updated_at timestamptz not null default now()
);
create unique index if not exists chat_reads_user_peer_uq on chat_reads (user_id, peer_id);

create table if not exists message_attachments (
  id serial primary key,
  message_id integer not null references messages(id) on delete cascade,
  name text not null,
  name_lower text not null default '',
  mime text not null,
  size integer not null,
  storage_key text not null default '',
  data text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists message_attachments_message_idx on message_attachments (message_id);

create table if not exists task_exports (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  task_id integer not null references tasks(id) on delete cascade,
  created_at timestamptz not null default now()
);
create unique index if not exists task_exports_user_task_uq on task_exports (user_id, task_id);

create table if not exists task_messages (
  id serial primary key,
  task_id integer not null references tasks(id) on delete cascade,
  author_id integer not null references users(id) on delete cascade,
  content text not null,
  content_lower text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists task_messages_task_idx on task_messages (task_id, id);

create table if not exists agent_connections (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  name text not null,
  server_url text not null default '',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists agent_connections_user_name_idx on agent_connections (user_id, name);
create index if not exists agent_connections_user_idx on agent_connections (user_id);

create table if not exists agent_connection_tokens (
  id serial primary key,
  connection_id integer not null references agent_connections(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  name text not null default '',
  token text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists agent_connection_tokens_conn_idx on agent_connection_tokens (connection_id);

create table if not exists agent_tokens (
  id serial primary key,
  user_id integer not null unique references users(id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists agent_conversations (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  kind text not null,
  title text not null default 'Новый чат',
  system_prompt text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_conversations_user_kind_idx on agent_conversations (user_id, kind, updated_at);

create table if not exists agent_conversation_messages (
  id serial primary key,
  conversation_id integer not null references agent_conversations(id) on delete cascade,
  role text not null,
  content text not null default '',
  reasoning text not null default '',
  attachments text not null default '[]',
  actions text not null default '[]',
  files text not null default '[]',
  error text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists agent_conversation_messages_conversation_idx on agent_conversation_messages (conversation_id);

create table if not exists agent_tasks (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  prompt text not null,
  status text not null default 'queued',
  max_steps integer not null default 15,
  steps integer not null default 0,
  summary text not null default '',
  trust_level text not null default 'verified',
  task_mode text not null default 'autonomous',
  source text not null default 'operator',
  coach_mode text not null default 'after_step',
  guidance_note text not null default '',
  pending_approval text not null default '',
  approval_response text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_tasks_status_idx on agent_tasks (status, id);

create table if not exists agent_transcripts (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  conversation_id integer not null default 0,
  title text not null default 'Переписка агента',
  summary text not null default '',
  file_name text not null,
  content text not null,
  chars integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists agent_transcripts_user_idx on agent_transcripts (user_id, id);

create table if not exists agent_events (
  id serial primary key,
  task_id integer not null references agent_tasks(id) on delete cascade,
  kind text not null,
  text text not null default '',
  action text not null default '',
  file_name text not null default '',
  file_mime text not null default '',
  file_size integer not null default 0,
  storage_key text not null default '',
  file_data text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists agent_events_task_idx on agent_events (task_id, id);

create table if not exists ai_chats (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  title text not null default 'Новый чат',
  tokens_prompt integer not null default 0,
  tokens_completion integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_chats_user_idx on ai_chats (user_id, updated_at);

create table if not exists ai_chat_messages (
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
);
create index if not exists ai_chat_messages_chat_idx on ai_chat_messages (chat_id);

create table if not exists ai_usage_events (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  chat_id integer not null default 0,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  total_tokens integer not null default 0,
  month text not null,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_events_user_month_idx on ai_usage_events (user_id, month);

create table if not exists ai_quota_overrides (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  month text not null,
  monthly_limit integer not null,
  created_by integer references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists ai_quota_overrides_user_month_uq on ai_quota_overrides (user_id, month);

create table if not exists ai_rag_folders (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  name text not null,
  files_count integer not null default 0,
  chunks_count integer not null default 0,
  chars integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_rag_folders_user_idx on ai_rag_folders (user_id);

create table if not exists ai_rag_chunks (
  id serial primary key,
  folder_id integer not null references ai_rag_folders(id) on delete cascade,
  path text not null,
  chunk_index integer not null default 0,
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists ai_rag_chunks_folder_idx on ai_rag_chunks (folder_id);

create table if not exists ai_rag_terms (
  id serial primary key,
  folder_id integer not null references ai_rag_folders(id) on delete cascade,
  term text not null,
  chunk_id integer not null references ai_rag_chunks(id) on delete cascade,
  tf integer not null default 1
);
create index if not exists ai_rag_terms_lookup_idx on ai_rag_terms (folder_id, term);

create table if not exists agent_usage_events (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  kind text not null,
  ref_id integer not null default 0,
  model text not null default '',
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  total_tokens integer not null default 0,
  month text not null,
  created_at timestamptz not null default now()
);
create index if not exists agent_usage_events_user_kind_month_idx on agent_usage_events (user_id, kind, month);

create table if not exists github_connections (
  id serial primary key,
  user_id integer not null unique references users(id) on delete cascade,
  github_user_id integer not null default 0,
  login text not null,
  name text not null default '',
  email text not null default '',
  avatar_url text not null default '',
  token_encrypted text not null,
  token_hint text not null default '',
  scopes text not null default '',
  selected_owner text not null default '',
  selected_repo text not null default '',
  selected_branch text not null default '',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
