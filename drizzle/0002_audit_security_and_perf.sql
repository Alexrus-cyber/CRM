-- Audit migration: AI user settings, session management, file storage keys, and composite message indexes

create table if not exists ai_user_settings (
  id serial primary key,
  user_id integer not null unique references users(id) on delete cascade,
  base_url text not null default '',
  api_key_encrypted text not null default '',
  api_key_hint text not null default '',
  model text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sessions_user_revoked_idx on sessions (user_id, revoked_at, expires_at);
create index if not exists messages_sender_recipient_id_idx on messages (sender_id, recipient_id, id);
create index if not exists messages_recipient_sender_id_idx on messages (recipient_id, sender_id, id);
create index if not exists ai_usage_events_user_month_idx on ai_usage_events (user_id, month);
