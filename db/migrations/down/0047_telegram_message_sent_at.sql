-- Reversão de 0047_telegram_message_sent_at.sql. Reverter o código antes: a versão
-- que lê a coluna quebra sem ela.
alter table operations_v2.telegram_ingested_messages
    drop column if exists message_sent_at;
