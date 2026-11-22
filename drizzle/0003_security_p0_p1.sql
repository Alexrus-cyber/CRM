-- Security & hardening migration (P0-2, P1-4, P1-14, P1-16, P1-17, P1-18)

alter table users add column if not exists deleted_at timestamptz;
alter table users add column if not exists must_change_password boolean not null default false;
alter table users add column if not exists totp_secret_encrypted text not null default '';
alter table users add column if not exists totp_enabled boolean not null default false;
alter table users add column if not exists pending_email text;
alter table users add column if not exists pending_email_token_hash text;
alter table users add column if not exists pending_email_expires_at timestamptz;

alter table agent_connection_tokens add column if not exists token_hash text not null default '';
alter table agent_connection_tokens add column if not exists token_hint text not null default '';
alter table agent_connection_tokens add column if not exists expires_at timestamptz;
alter table agent_connection_tokens add column if not exists revoked_at timestamptz;

create index if not exists users_deleted_at_idx on users (deleted_at);
create index if not exists users_pending_email_hash_idx on users (pending_email_token_hash);
create index if not exists agent_connection_tokens_hash_idx on agent_connection_tokens (token_hash);
