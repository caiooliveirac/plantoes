with ranked_regulation as (
  select
    current_state.*, 
    row_number() over (
      partition by current_state.ramal
      order by current_state.arrival_time desc, current_state.updated_at desc, current_state.shift_instance_id asc
    ) as row_rank
  from public.shift_current_state current_state
  where current_state.status = 'CONFIRMED'
    and current_state.departure_time is null
    and current_state.ramal is not null
)
insert into regulation_occupancies (
  id,
  doctor_id,
  post_id,
  scheduled_start_at,
  scheduled_end_at,
  started_at,
  board_started_at,
  ended_at,
  actual_ended_at,
  shift_label,
  role_label,
  ramal_label,
  source,
  notes,
  created_by_user_id,
  updated_by_user_id,
  created_at,
  updated_at
)
select
  gen_random_uuid(),
  app_user.doctor_id,
  post_ref.id,
  shift_ref.scheduled_start_at,
  shift_ref.scheduled_end_at,
  current_state.arrival_time,
  current_state.arrival_time,
  null,
  null,
  current_state.declared_shift_type,
  shift_ref.role_function,
  current_state.ramal,
  'import'::occupancy_source,
  'Imported from legacy shift_current_state',
  null,
  null,
  now(),
  now()
from ranked_regulation current_state
inner join public.shift_instances shift_ref on shift_ref.id = current_state.shift_instance_id
inner join users app_user on app_user.id = current_state.executor_user_id
inner join regulation_posts post_ref on post_ref.code = current_state.ramal
where current_state.row_rank = 1
  and app_user.doctor_id is not null
  and not exists (select 1 from regulation_occupancies);

with ranked_intervention as (
  select
    current_state.*, 
    legacy_base.code as legacy_base_code,
    row_number() over (
      partition by legacy_base.code
      order by current_state.arrival_time desc, current_state.updated_at desc, current_state.shift_instance_id asc
    ) as row_rank
  from public.shift_current_state current_state
  inner join public.shift_instances shift_ref on shift_ref.id = current_state.shift_instance_id
  inner join public.bases legacy_base on legacy_base.id = shift_ref.base_id
  where current_state.status = 'CONFIRMED'
    and current_state.departure_time is null
    and current_state.ramal is null
    and legacy_base.sector = 'INTERVENTION'
)
insert into intervention_occupancies (
  id,
  doctor_id,
  base_id,
  scheduled_start_at,
  scheduled_end_at,
  started_at,
  board_started_at,
  ended_at,
  actual_ended_at,
  shift_label,
  role_label,
  source,
  notes,
  created_by_user_id,
  updated_by_user_id,
  created_at,
  updated_at
)
select
  gen_random_uuid(),
  app_user.doctor_id,
  base_ref.id,
  shift_ref.scheduled_start_at,
  shift_ref.scheduled_end_at,
  current_state.arrival_time,
  current_state.arrival_time,
  null,
  null,
  current_state.declared_shift_type,
  shift_ref.role_function,
  'import'::occupancy_source,
  'Imported from legacy shift_current_state',
  null,
  null,
  now(),
  now()
from ranked_intervention current_state
inner join public.shift_instances shift_ref on shift_ref.id = current_state.shift_instance_id
inner join users app_user on app_user.id = current_state.executor_user_id
inner join intervention_bases base_ref on base_ref.code = current_state.legacy_base_code
where current_state.row_rank = 1
  and app_user.doctor_id is not null
  and not exists (select 1 from intervention_occupancies);