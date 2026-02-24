create table operations_v2.intervention_base_deactivations (
    id uuid primary key default gen_random_uuid(),
    base_id integer not null references operations_v2.intervention_bases(id) on delete cascade,
    deactivated_at timestamptz not null,
    reactivated_at timestamptz,
    notes text,
    created_by_user_id uuid references operations_v2.users(id),
    updated_by_user_id uuid references operations_v2.users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index intervention_base_deactivations_base_idx
    on operations_v2.intervention_base_deactivations(base_id, deactivated_at);

create index intervention_base_deactivations_active_idx
    on operations_v2.intervention_base_deactivations(base_id, reactivated_at);