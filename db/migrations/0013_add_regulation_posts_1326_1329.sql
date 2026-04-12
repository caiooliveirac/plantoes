insert into regulation_posts (code, label, default_role, sort_order, is_active)
values
  ('1326', 'Ramal 1326', null, 55, true),
  ('1327', 'Ramal 1327', null, 56, true),
  ('1328', 'Ramal 1328', null, 57, true),
  ('1329', 'Ramal 1329', null, 58, true)
on conflict (code) do update
set label = excluded.label,
    default_role = excluded.default_role,
    sort_order = excluded.sort_order,
    is_active = excluded.is_active;