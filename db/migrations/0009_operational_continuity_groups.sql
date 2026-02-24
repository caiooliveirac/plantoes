alter table regulation_occupancies
  add column if not exists continuity_group_id uuid;

update regulation_occupancies
set continuity_group_id = id
where continuity_group_id is null;

alter table regulation_occupancies
  alter column continuity_group_id set not null;

create index if not exists regulation_occupancies_continuity_idx
  on regulation_occupancies(doctor_id, continuity_group_id, started_at);

alter table intervention_occupancies
  add column if not exists continuity_group_id uuid;

update intervention_occupancies
set continuity_group_id = id
where continuity_group_id is null;

alter table intervention_occupancies
  alter column continuity_group_id set not null;

create index if not exists intervention_occupancies_continuity_idx
  on intervention_occupancies(doctor_id, continuity_group_id, started_at);