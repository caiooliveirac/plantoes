create extension if not exists unaccent;

insert into doctors (
  id,
  external_code,
  full_name,
  display_name,
  normalized_name,
  is_active,
  metadata,
  created_at,
  updated_at
)
with legacy_users as (
  select
    u.id as legacy_user_id,
    u.name,
    coalesce(nullif(dp.display_name_override, ''), u.name) as display_name,
    trim(regexp_replace(upper(unaccent(coalesce(nullif(dp.display_name_override, ''), u.name))), '[^A-Z\s'']', ' ', 'g')) as normalized_name,
    coalesce(u.is_active, true) as is_active,
    coalesce(u.created_at, now()) as created_at,
    coalesce(u.updated_at, now()) as updated_at
  from public.users u
  left join public.doctor_profiles dp on dp.user_id = u.id
  where coalesce(u.name, '') <> ''
), ranked_users as (
  select
    *,
    row_number() over (
      partition by normalized_name
      order by is_active desc, updated_at desc, created_at desc, legacy_user_id asc
    ) as row_rank
  from legacy_users
)
select
  gen_random_uuid(),
  null,
  ranked_users.name,
  ranked_users.display_name,
  ranked_users.normalized_name,
  ranked_users.is_active,
  jsonb_build_object('legacyUserId', ranked_users.legacy_user_id::text),
  ranked_users.created_at,
  ranked_users.updated_at
from ranked_users
where ranked_users.row_rank = 1
on conflict (normalized_name) do update
set full_name = excluded.full_name,
    display_name = excluded.display_name,
    is_active = excluded.is_active,
    metadata = excluded.metadata,
    updated_at = excluded.updated_at;