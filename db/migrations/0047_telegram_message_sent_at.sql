-- Hora da MENSAGEM do Telegram (`message.date`) no log de ingestão
-- (docs/chegada.md §1.3: vale a hora do aviso). `created_at` é a hora em que o
-- servidor recebeu o update: igual em operação normal, diverge em fila do webhook,
-- retentativa ou reprocessamento. A 1ª tentativa de chegada e a janela de 30 min da
-- tomada passam a medir por esta coluna (coalesce com created_at nas linhas antigas).
-- Só coluna nova e nula: o código antigo não a lê; aplicar ANTES do deploy.
alter table operations_v2.telegram_ingested_messages
    add column if not exists message_sent_at timestamptz;
