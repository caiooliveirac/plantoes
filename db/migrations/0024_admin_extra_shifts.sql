-- Plantões extra adicionados manualmente pelo admin (Tom/Dora) na tela de
-- fechamento de pagamento. NÃO são ocupações reais do quadro operacional: vivem
-- numa tabela própria e entram apenas no board do payment-closing, em verde,
-- contando para o valor a pagar do médico. Um extra não amarra a ramal/base —
-- o admin escolhe livremente dia + turno (SD/SN) e um rótulo curto opcional.
create table if not exists operations_v2.admin_extra_shifts (
    id uuid primary key default gen_random_uuid(),
    doctor_id uuid not null references operations_v2.doctors (id),
    operational_date date not null,
    shift_label varchar(2) not null,
    label varchar(40),
    created_by_user_id uuid references operations_v2.users (id),
    created_at timestamptz not null default now()
);

create index if not exists admin_extra_shifts_doctor_idx
    on operations_v2.admin_extra_shifts (doctor_id);

create index if not exists admin_extra_shifts_date_idx
    on operations_v2.admin_extra_shifts (operational_date);
