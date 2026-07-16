insert into regulation_posts (code, label, default_role, sort_order, is_active)
values ('2376', 'Ramal 2376', null, 225, true)
on conflict (code) do update
set label = excluded.label,
    default_role = excluded.default_role,
    sort_order = excluded.sort_order,
    is_active = excluded.is_active;
