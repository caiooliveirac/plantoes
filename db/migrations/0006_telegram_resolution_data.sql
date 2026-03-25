alter table telegram_ingested_messages
    add column if not exists resolution_data jsonb not null default '{}'::jsonb;
