-- Acompanhamento financeiro no modal do fechamento de pagamento.
-- Quatro peças, todas por (médico) ou (médico, mês):
--   1. payment_closing_meta     -> nº da nota fiscal e nº do processo de pagamento
--   2. doctor_contracts         -> semente do teto contratual (R$) que vira cálculo
--   3. bank_hours_settlements   -> débito/bônus do banco de horas (12h) por mês
--   4. admin_extra_shifts.kind/unit -> permite plantão VERDE (+1) ou VERMELHO (-1)

-- 1. Nota fiscal + nº do processo de pagamento, preenchidos pelo admin por mês.
create table if not exists operations_v2.payment_closing_meta (
    id uuid primary key default gen_random_uuid(),
    doctor_id uuid not null references operations_v2.doctors (id),
    month_key varchar(7) not null,
    invoice_number varchar(60),
    payment_process_number varchar(60),
    updated_by_user_id uuid references operations_v2.users (id),
    updated_at timestamptz not null default now()
);

create unique index if not exists payment_closing_meta_doctor_month_idx
    on operations_v2.payment_closing_meta (doctor_id, month_key);

-- 2. Semente do contrato: o admin informa o teto em R$ uma vez (no modal) e a
-- partir daí o saldo contratual passa a ser um cálculo (teto - pagamentos
-- acumulados desde seed_month). Uma linha por médico.
create table if not exists operations_v2.doctor_contracts (
    id uuid primary key default gen_random_uuid(),
    doctor_id uuid not null references operations_v2.doctors (id),
    ceiling_brl numeric(12, 2) not null,
    seed_month varchar(7) not null,
    created_by_user_id uuid references operations_v2.users (id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists doctor_contracts_doctor_idx
    on operations_v2.doctor_contracts (doctor_id);

-- 3. Acerto do banco de horas: quando o saldo chega a ±12h o admin pode debitar/
-- bonificar. delta_minutes move o saldo do médico em direção a zero (negativo
-- para bônus, positivo para punição). admin_extra_shift_id aponta para o plantão
-- verde/vermelho gerado, para auditoria casada. Uma ou mais por (médico, mês).
create table if not exists operations_v2.bank_hours_settlements (
    id uuid primary key default gen_random_uuid(),
    doctor_id uuid not null references operations_v2.doctors (id),
    month_key varchar(7) not null,
    delta_minutes integer not null,
    kind varchar(10) not null,
    admin_extra_shift_id uuid references operations_v2.admin_extra_shifts (id) on delete set null,
    notes text not null,
    created_by_user_id uuid references operations_v2.users (id),
    created_at timestamptz not null default now()
);

create index if not exists bank_hours_settlements_doctor_idx
    on operations_v2.bank_hours_settlements (doctor_id, month_key);

-- 4. Sinal/tipo do plantão extra: 'extra' (verde manual), 'bonus' (verde do banco
-- de horas) e 'penalty' (vermelho, unit -1, desconta um plantão do total). Os
-- registros existentes ficam 'extra'/+1 por default.
alter table operations_v2.admin_extra_shifts
    add column if not exists kind varchar(10) not null default 'extra';

alter table operations_v2.admin_extra_shifts
    add column if not exists unit integer not null default 1;
