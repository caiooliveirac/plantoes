-- Atestação por médico/mês no fechamento de pagamento: registra que o admin já
-- conferiu e assinou a produtividade daquele plantonista naquele mês. Serve só de
-- controle visual ("já assinei este") — uma linha por (médico, mês). Toggle.
create table if not exists operations_v2.payment_closing_attestations (
    id uuid primary key default gen_random_uuid(),
    doctor_id uuid not null references operations_v2.doctors (id),
    month_key varchar(7) not null,
    attested_by_user_id uuid references operations_v2.users (id),
    attested_at timestamptz not null default now()
);

create unique index if not exists payment_closing_attestations_doctor_month_idx
    on operations_v2.payment_closing_attestations (doctor_id, month_key);
