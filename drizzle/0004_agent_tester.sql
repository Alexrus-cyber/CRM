-- Sub-agent QA Tester runs and isolated per-chat token tracking

create table if not exists agent_tester_runs (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  agent_conversation_id integer,
  tester_conversation_id integer not null references agent_conversations(id) on delete cascade,
  sandbox_project text not null default '',
  summary text not null default '',
  status text not null default 'running',
  report_summary text not null default '',
  critical_issues text not null default '[]',
  minor_issues text not null default '[]',
  checks_run text not null default '[]',
  minor_decision text not null default 'not_needed',
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  total_tokens integer not null default 0,
  model text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_tester_runs_user_idx on agent_tester_runs (user_id, created_at);
create index if not exists agent_tester_runs_conv_idx on agent_tester_runs (tester_conversation_id);
