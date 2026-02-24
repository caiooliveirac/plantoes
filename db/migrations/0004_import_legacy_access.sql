insert into users (
  id,
  doctor_id,
  email,
  password_hash,
  is_active,
  created_at,
  updated_at
)
select
  legacy.id,
  d.id,
  legacy.email,
  legacy.password_hash,
  coalesce(legacy.is_active, true),
  coalesce(legacy.created_at, now()),
  coalesce(legacy.updated_at, now())
from public.users legacy
left join doctors d on d.metadata ->> 'legacyUserId' = legacy.id::text
where coalesce(legacy.email, '') <> ''
on conflict (email) do update
set doctor_id = excluded.doctor_id,
    password_hash = excluded.password_hash,
    is_active = excluded.is_active,
    updated_at = excluded.updated_at;

insert into user_roles (user_id, role, created_at)
select distinct
  legacy_roles.user_id,
  case
    when legacy_roles.role = 'ADMIN' then 'admin'::user_role
    when legacy_roles.role in ('COORDINATOR', 'SHIFT_LEADER') then 'chief'::user_role
    else null
  end,
  now()
from public.user_roles legacy_roles
where legacy_roles.role in ('ADMIN', 'COORDINATOR', 'SHIFT_LEADER')
on conflict (user_id, role) do nothing;