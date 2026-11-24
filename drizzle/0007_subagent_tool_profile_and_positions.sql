alter table agent_subagents
  add column if not exists tool_profile text not null default 'restricted';
alter table agent_subagents
  add column if not exists pos_x real;
alter table agent_subagents
  add column if not exists pos_y real;

alter table ai_user_settings
  add column if not exists orchestrator_pos_x real;
alter table ai_user_settings
  add column if not exists orchestrator_pos_y real;
