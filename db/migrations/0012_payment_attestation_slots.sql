create type operations_v2.payment_attestation_slot_status as enum ('draft', 'approved');

create table operations_v2.payment_attestation_slots (
    id uuid primary key default gen_random_uuid(),
    operational_date timestamptz not null,
    shift_label varchar(8) not null,
    started_at timestamptz not null,
    ended_at timestamptz not null,
    snapshot_generated_at timestamptz not null,
    status operations_v2.payment_attestation_slot_status not null default 'draft',
    total_targets integer not null default 0,
    ready_count integer not null default 0,
    needs_review_count integer not null default 0,
    unassigned_count integer not null default 0,
    disabled_count integer not null default 0,
    last_refreshed_by_user_id uuid references operations_v2.users(id),
    approved_by_user_id uuid references operations_v2.users(id),
    approved_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index payment_attestation_slots_operational_shift_idx
    on operations_v2.payment_attestation_slots(operational_date, shift_label);

create index payment_attestation_slots_status_idx
    on operations_v2.payment_attestation_slots(status, operational_date, started_at);

create table operations_v2.payment_attestation_slot_entries (
    id uuid primary key default gen_random_uuid(),
    slot_id uuid not null references operations_v2.payment_attestation_slots(id) on delete cascade,
    domain varchar(32) not null,
    target_code varchar(32) not null,
    target_label varchar(255) not null,
    sort_order integer not null default 0,
    default_role varchar(100),
    disabled_at timestamptz,
    disabled_reason text,
    disabled_during_shift boolean not null default false,
    disabled_entire_shift boolean not null default false,
    occupancy_id uuid,
    doctor_id uuid references operations_v2.doctors(id),
    doctor_name varchar(255),
    display_name varchar(255),
    started_at timestamptz,
    ended_at timestamptz,
    actual_ended_at timestamptz,
    scheduled_start_at timestamptz,
    scheduled_end_at timestamptz,
    shift_label varchar(100),
    role_label varchar(100),
    ramal_label varchar(50),
    source operations_v2.occupancy_source,
    candidate_count integer not null default 0,
    payment_status varchar(32) not null,
    issues jsonb not null default '[]'::jsonb,
    arrival_delay_minutes integer,
    overtime_minutes integer,
    credited_overtime_minutes integer,
    balance_minutes integer,
    rule_code varchar(100),
    bank_hours_explanation text,
    created_at timestamptz not null default now()
);

create unique index payment_attestation_slot_entries_target_idx
    on operations_v2.payment_attestation_slot_entries(slot_id, domain, target_code);

create index payment_attestation_slot_entries_slot_idx
    on operations_v2.payment_attestation_slot_entries(slot_id, sort_order);

create index payment_attestation_slot_entries_doctor_idx
    on operations_v2.payment_attestation_slot_entries(doctor_id, created_at);