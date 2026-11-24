-- Режим маршрутизации дерева субагентов (linear | layered) и настройки агента-Надсмотрщика.
alter table ai_user_settings add column if not exists subagent_routing_mode text not null default 'linear';
alter table ai_user_settings add column if not exists overseer_enabled boolean not null default true;
alter table ai_user_settings add column if not exists overseer_mode text not null default 'strict';
alter table ai_user_settings add column if not exists overseer_system_prompt text not null default '';
alter table ai_user_settings add column if not exists overseer_unlock_api boolean not null default false;
alter table ai_user_settings add column if not exists overseer_provider text not null default 'custom';
alter table ai_user_settings add column if not exists overseer_base_url text not null default '';
alter table ai_user_settings add column if not exists overseer_model text not null default '';
alter table ai_user_settings add column if not exists overseer_api_key_encrypted text not null default '';
alter table ai_user_settings add column if not exists overseer_api_key_hint text not null default '';
