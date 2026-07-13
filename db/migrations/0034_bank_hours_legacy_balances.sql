-- Saldos legados do banco de horas (planilha da coordenação, digitalizada e
-- auditada em jul/2026). Duas parcelas por plantonista, sempre em minutos
-- inteiros assinados (positivo = crédito do plantonista):
--   pre_may_2025_minutes        -> saldo acumulado até 30/abr/2025
--   spreadsheet_period_minutes  -> saldo apurado pela planilha mai/2025 -> mai/2026
-- total_minutes é a soma; o CHECK garante a invariante no próprio banco.
-- Sem updated_at de propósito: registro nunca sofre UPDATE após a importação —
-- correção futura é nova migração explícita. doctor_id só é preenchido com
-- matching de nome aprovado manualmente (status = matched); registros
-- unmatched não entram em nenhuma visão por médico.
create table if not exists operations_v2.bank_hours_legacy_balances (
    id uuid primary key default gen_random_uuid(),
    doctor_id uuid references operations_v2.doctors (id),
    spreadsheet_name varchar(255) not null,
    pre_may_2025_minutes integer not null,
    spreadsheet_period_minutes integer not null,
    total_minutes integer not null,
    source text not null,
    notes text,
    status varchar(10) not null,
    created_at timestamptz not null default now(),
    constraint bank_hours_legacy_balances_total_check
        check (total_minutes = pre_may_2025_minutes + spreadsheet_period_minutes),
    constraint bank_hours_legacy_balances_status_check
        check (status in ('matched', 'unmatched')),
    constraint bank_hours_legacy_balances_matched_doctor_check
        check ((status = 'matched') = (doctor_id is not null))
);

create unique index if not exists bank_hours_legacy_balances_name_idx
    on operations_v2.bank_hours_legacy_balances (spreadsheet_name);

-- Um médico carrega no máximo um saldo legado (parcial: unmatched ficam fora).
create unique index if not exists bank_hours_legacy_balances_doctor_idx
    on operations_v2.bank_hours_legacy_balances (doctor_id)
    where doctor_id is not null;
