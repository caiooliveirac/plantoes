-- Replace the COBERTURA columns added in 0018 with the
-- LATE ARRIVAL ACKNOWLEDGEMENT mechanism.
--
-- New coordination rule: when a SD intervention doctor arrives at 9h or later,
-- the chefe/admin can acknowledge the case and the system converts the
-- occupancy to a half-shift (paid 13:00-19:00). The hours worked before the
-- half-shift start become a carryover credit on the bank of hours.
--
-- The COBERTURA short-lived feature shipped earlier today is removed: the
-- columns are dropped to keep the schema clean, and any data is dropped with
-- them (the only real-world record had been already reverted before this
-- migration runs).

alter table operations_v2.intervention_occupancies
    drop column if exists coverage_kind,
    drop column if exists coverage_note,
    drop column if exists coverage_marked_by_user_id,
    drop column if exists coverage_marked_at;

drop index if exists operations_v2.intervention_occupancies_coverage_idx;

alter table operations_v2.intervention_occupancies
    add column if not exists late_arrival_acknowledged_at timestamptz,
    add column if not exists late_arrival_acknowledged_by_user_id uuid references operations_v2.users(id),
    add column if not exists late_arrival_acknowledged_note text;

create index if not exists intervention_occupancies_late_arrival_idx
    on operations_v2.intervention_occupancies(late_arrival_acknowledged_at)
    where late_arrival_acknowledged_at is not null;
