create table if not exists telegram_bot_notices (
  id uuid primary key default gen_random_uuid(),
  notice_key varchar(255) not null,
  chat_id varchar(32) not null,
  stage varchar(32) not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists telegram_bot_notices_key_idx
  on telegram_bot_notices (notice_key);

create index if not exists telegram_bot_notices_chat_stage_idx
  on telegram_bot_notices (chat_id, stage, created_at);