-- Atraso desconsiderado pela chefia.
--
-- A chefia pode marcar que o atraso de chegada de uma ocupação não conta:
-- banco de horas e pagamento tratam o médico como pontual (atraso 0, excedente
-- em dobro). started_at / board_started_at NÃO mudam — prioridade de refeição
-- e de saída seguem pela hora real de chegada. Auditado (audit_logs +
-- shift_events) e desfazível pelo undo operacional.
--
-- Não reaproveita late_arrival_acknowledged_* (aposentadas, outra regra).
-- Aplicar ANTES do deploy (o código novo lê as colunas).

alter table operations_v2.regulation_occupancies
    add column if not exists arrival_delay_waived_at timestamptz null,
    add column if not exists arrival_delay_waived_by_user_id uuid null references operations_v2.users (id),
    add column if not exists arrival_delay_waiver_note text null;

alter table operations_v2.intervention_occupancies
    add column if not exists arrival_delay_waived_at timestamptz null,
    add column if not exists arrival_delay_waived_by_user_id uuid null references operations_v2.users (id),
    add column if not exists arrival_delay_waiver_note text null;
