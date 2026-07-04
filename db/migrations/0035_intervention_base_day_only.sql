-- Bases "diurnas": operam só 07:00-19:00, nunca geram SN nem plantão contínuo
-- (P). Ver resolveDayOnlyBaseAutoCloseEndedAt em modules/intervention/service.ts.
alter table operations_v2.intervention_bases
    add column if not exists day_only boolean not null default false;

insert into operations_v2.intervention_bases (code, label, sort_order, is_active, day_only)
values ('GOA', 'GOA', 130, true, true)
on conflict (code) do update
set label = excluded.label,
    sort_order = excluded.sort_order,
    is_active = excluded.is_active,
    day_only = excluded.day_only;
