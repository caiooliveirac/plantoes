alter table regulation_occupancies
  add column if not exists board_started_at timestamptz,
  add column if not exists actual_ended_at timestamptz;

update regulation_occupancies
set board_started_at = started_at
where board_started_at is null;

alter table regulation_occupancies
  alter column board_started_at set not null;

alter table intervention_occupancies
  add column if not exists board_started_at timestamptz,
  add column if not exists actual_ended_at timestamptz;

update intervention_occupancies
set board_started_at = started_at
where board_started_at is null and ended_at is null;

drop index if exists regulation_occupancies_one_active_per_post_idx;
create unique index regulation_occupancies_one_active_board_per_post_idx
  on regulation_occupancies(post_id)
  where ended_at is null and board_started_at is not null;

drop index if exists intervention_occupancies_one_active_per_base_idx;
create unique index intervention_occupancies_one_active_board_per_base_idx
  on intervention_occupancies(base_id)
  where ended_at is null and board_started_at is not null;

drop index if exists bank_hours_entries_regulation_idx;
create unique index bank_hours_entries_regulation_idx
  on bank_hours_entries(regulation_occupancy_id)
  where regulation_occupancy_id is not null;

drop index if exists bank_hours_entries_intervention_idx;
create unique index bank_hours_entries_intervention_idx
  on bank_hours_entries(intervention_occupancy_id)
  where intervention_occupancy_id is not null;

create table if not exists telegram_ingested_messages (
  id uuid primary key default gen_random_uuid(),
  telegram_update_id integer,
  telegram_message_id integer not null,
  chat_id varchar(32) not null,
  sender_telegram_id varchar(32),
  sender_name varchar(255),
  raw_text text not null,
  parsed_domain varchar(32),
  parsed_target_code varchar(64),
  parsed_action varchar(32),
  parsed_doctor_name varchar(255),
  related_occupancy_id uuid,
  status varchar(32) not null default 'pending',
  error_message text,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists telegram_ingested_messages_msg_idx
  on telegram_ingested_messages(chat_id, telegram_message_id);

create index if not exists telegram_ingested_messages_status_idx
  on telegram_ingested_messages(status, created_at);