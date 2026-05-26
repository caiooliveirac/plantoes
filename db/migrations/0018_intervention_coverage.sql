-- Intervention coverage: lets a late arrival on an intervention base be marked
-- as COBERTURA so the late delta is recorded factually but not debited from the
-- doctor's bank_hours. Scope is intentionally limited to intervention — regulation
-- has its own continuity/role rules and is not in scope for this feature.

alter table operations_v2.intervention_occupancies
    add column if not exists coverage_kind varchar(32),
    add column if not exists coverage_note text,
    add column if not exists coverage_marked_by_user_id uuid references operations_v2.users(id),
    add column if not exists coverage_marked_at timestamptz;

create index if not exists intervention_occupancies_coverage_idx
    on operations_v2.intervention_occupancies(coverage_kind)
    where coverage_kind is not null;
