insert into regulation_posts (code, label, default_role, sort_order, is_active)
values ('1476', 'Ramal 1476', null, 135, true)
on conflict (code) do update
set label = excluded.label,
    default_role = excluded.default_role,
    sort_order = excluded.sort_order,
    is_active = excluded.is_active;