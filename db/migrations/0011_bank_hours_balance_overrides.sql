create table operations_v2.bank_hours_balance_overrides (
    id uuid primary key default gen_random_uuid(),
    continuity_group_id uuid not null,
    doctor_id uuid not null references operations_v2.doctors(id),
    balance_minutes integer not null,
    notes text not null,
    created_by_user_id uuid references operations_v2.users(id),
    updated_by_user_id uuid references operations_v2.users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index bank_hours_balance_overrides_group_idx
    on operations_v2.bank_hours_balance_overrides(continuity_group_id);

create index bank_hours_balance_overrides_doctor_idx
    on operations_v2.bank_hours_balance_overrides(doctor_id, updated_at);