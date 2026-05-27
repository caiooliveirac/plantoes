-- Departure confirmation: chief/admin must validate verbalized departures
-- before bank hours credit is awarded.
--
-- Anti-fraud workflow: when a doctor reports /saiu in the Telegram bot, the
-- system records actual_ended_at but leaves departure_confirmed_at NULL. The
-- chief reviews the verbalized time, optionally corrects it, then confirms —
-- triggering bank-hours sync. Until confirmed, no credit accumulates.
--
-- Paths that bypass the hold (auto-confirmed at save time):
--   - Chief/admin actions via web (/end, /report-departure, PATCH)
--   - Chief actions via bot (/retirar — chief-kick)
--   - System auto-close (board takeover, stale shadow expiry, PIAM)
--
-- Existing data is backfilled with departure_confirmed_at = updated_at and
-- departure_confirmed_by_user_id = updated_by_user_id, marking all historical
-- closures as already confirmed. departure_confirmed_by_user_id is NULL only
-- when no user was recorded — interpret as "system or pre-feature".

alter table operations_v2.regulation_occupancies
    add column if not exists departure_confirmed_at timestamptz,
    add column if not exists departure_confirmed_by_user_id uuid references operations_v2.users(id),
    add column if not exists departure_confirmed_note text;

alter table operations_v2.intervention_occupancies
    add column if not exists departure_confirmed_at timestamptz,
    add column if not exists departure_confirmed_by_user_id uuid references operations_v2.users(id),
    add column if not exists departure_confirmed_note text;

update operations_v2.regulation_occupancies
    set departure_confirmed_at = coalesce(updated_at, actual_ended_at, ended_at),
        departure_confirmed_by_user_id = updated_by_user_id
    where actual_ended_at is not null
      and departure_confirmed_at is null;

update operations_v2.intervention_occupancies
    set departure_confirmed_at = coalesce(updated_at, actual_ended_at, ended_at),
        departure_confirmed_by_user_id = updated_by_user_id
    where actual_ended_at is not null
      and departure_confirmed_at is null;

create index if not exists regulation_occupancies_pending_departure_idx
    on operations_v2.regulation_occupancies(actual_ended_at)
    where actual_ended_at is not null and departure_confirmed_at is null;

create index if not exists intervention_occupancies_pending_departure_idx
    on operations_v2.intervention_occupancies(actual_ended_at)
    where actual_ended_at is not null and departure_confirmed_at is null;
