-- Custom SubAgents, Orchestrator Dependency Tree, Isolated SubAgent Chats & Per-SubAgent API Lock/Unlock

create table if not exists agent_subagents (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  slug text not null,
  name text not null,
  role_title text not null default '',
  description text not null default '',
  system_prompt text not null default '',
  color text not null default '#8b5cf6',
  is_active boolean not null default true,
  parent_subagent_id integer references agent_subagents(id) on delete set null,
  orchestrator_can_call boolean not null default true,
  allowed_callees text not null default '["*"]',
  unlock_api boolean not null default false,
  provider text not null default 'custom',
  base_url text not null default '',
  model text not null default '',
  api_key_encrypted text not null default '',
  api_key_hint text not null default '',
  reasoning_mode text not null default 'default',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists agent_subagents_user_slug_uq
  on agent_subagents (user_id, slug);
create index if not exists agent_subagents_user_active_idx
  on agent_subagents (user_id, is_active, id);

alter table agent_conversations add column if not exists subagent_id integer;
create index if not exists agent_conversations_subagent_idx
  on agent_conversations (user_id, subagent_id, updated_at);

create table if not exists agent_subagent_runs (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  subagent_id integer not null references agent_subagents(id) on delete cascade,
  agent_conversation_id integer,
  subagent_conversation_id integer not null references agent_conversations(id) on delete cascade,
  caller_kind text not null default 'orchestrator',
  caller_subagent_id integer,
  sandbox_project text not null default '',
  input_summary text not null default '',
  output_summary text not null default '',
  status text not null default 'running',
  requested_callee_slug text not null default '',
  requested_callee_task text not null default '',
  actions_count integer not null default 0,
  files_touched text not null default '[]',
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  total_tokens integer not null default 0,
  model text not null default '',
  used_custom_api boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_subagent_runs_user_idx
  on agent_subagent_runs (user_id, created_at);
create index if not exists agent_subagent_runs_subagent_idx
  on agent_subagent_runs (subagent_id, id);
create index if not exists agent_subagent_runs_conv_idx
  on agent_subagent_runs (subagent_conversation_id);
