-- Reverter o atraso desconsiderado. Ao sumir a marca, o próximo sync do banco
-- de horas volta a debitar o atraso dessas ocupações.
alter table operations_v2.regulation_occupancies
    drop column if exists arrival_delay_waiver_note,
    drop column if exists arrival_delay_waived_by_user_id,
    drop column if exists arrival_delay_waived_at;
alter table operations_v2.intervention_occupancies
    drop column if exists arrival_delay_waiver_note,
    drop column if exists arrival_delay_waived_by_user_id,
    drop column if exists arrival_delay_waived_at;
