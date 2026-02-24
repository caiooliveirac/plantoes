create table operations_v2.regulation_post_deactivations (
    id uuid primary key default gen_random_uuid(),
    post_id integer not null references operations_v2.regulation_posts(id) on delete cascade,
    deactivated_at timestamptz not null,
    reactivated_at timestamptz,
    notes text,
    created_by_user_id uuid references operations_v2.users(id),
    updated_by_user_id uuid references operations_v2.users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index regulation_post_deactivations_post_idx
    on operations_v2.regulation_post_deactivations(post_id, deactivated_at);

create index regulation_post_deactivations_active_idx
    on operations_v2.regulation_post_deactivations(post_id, reactivated_at);
