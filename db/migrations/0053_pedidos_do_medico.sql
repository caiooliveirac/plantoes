-- Pedidos do próprio médico pela web, decididos pela chefia.
--
-- Hoje só `continuar`: o médico em turno avisa que vai prolongar para o turno
-- seguinte; o pedido fica `pendente` até admin/chief aceitar (a continuação é
-- criada pelo mesmo caminho do bot) ou recusar. Um pendente por ocupação.
-- Aplicar ANTES do deploy (o código novo escreve na tabela).

create table if not exists operations_v2.pedidos_do_medico (
    id uuid primary key default gen_random_uuid(),
    doctor_id uuid not null references operations_v2.doctors (id),
    kind varchar(32) not null,
    domain varchar(16) not null,
    occupancy_id uuid not null,
    status varchar(16) not null default 'pendente',
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    decided_at timestamptz null,
    decided_by_user_id uuid null references operations_v2.users (id),
    decision_note text null,
    constraint pedidos_do_medico_kind_check check (kind in ('continuar')),
    constraint pedidos_do_medico_domain_check check (domain in ('regulation', 'intervention')),
    constraint pedidos_do_medico_status_check check (status in ('pendente', 'aceito', 'recusado'))
);

create index if not exists pedidos_do_medico_status_idx
    on operations_v2.pedidos_do_medico (status, created_at);

create unique index if not exists pedidos_do_medico_pendente_idx
    on operations_v2.pedidos_do_medico (occupancy_id, kind)
    where status = 'pendente';
