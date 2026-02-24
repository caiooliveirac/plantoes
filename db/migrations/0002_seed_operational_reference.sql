create extension if not exists unaccent;

insert into regulation_posts (code, label, default_role, sort_order, is_active)
values
  ('1321', 'Ramal 1321', 'RMT', 10, true),
  ('1322', 'Ramal 1322', 'RMT', 20, true),
  ('1323', 'Ramal 1323', 'RMT', 30, true),
  ('1324', 'Ramal 1324', 'RMT', 40, true),
  ('1325', 'Ramal 1325', 'RMT', 50, true),
  ('1361', 'Ramal 1361', 'RMT', 60, true),
  ('1362', 'Ramal 1362', 'RMT', 70, true),
  ('1363', 'Ramal 1363', 'RMT', 80, true),
  ('1364', 'Ramal 1364', 'RMT', 90, true),
  ('1365', 'Ramal 1365', 'RMT', 100, true),
  ('1366', 'Ramal 1366', null, 110, true),
  ('1367', 'Ramal 1367', null, 120, true),
  ('1368', 'Ramal 1368', null, 130, true),
  ('2031', 'Ramal 2031', null, 140, true),
  ('2032', 'Ramal 2032', null, 150, true),
  ('2033', 'Ramal 2033', null, 160, true),
  ('2034', 'Ramal 2034', null, 170, true),
  ('2035', 'Ramal 2035', null, 180, true),
  ('2151', 'Ramal 2151', null, 190, true),
  ('2152', 'Ramal 2152', null, 200, true),
  ('2153', 'Ramal 2153', null, 210, true),
  ('2154', 'Ramal 2154', null, 220, true),
  ('2377', 'Ramal 2377', null, 230, true),
  ('PIAM', 'PIAM', null, 240, true),
  ('NUCLEO', 'Nucleo', null, 250, true)
on conflict (code) do update
set label = excluded.label,
    default_role = excluded.default_role,
    sort_order = excluded.sort_order,
    is_active = excluded.is_active;

insert into intervention_bases (code, label, sort_order, is_active)
values
  ('SM01', 'SM01', 10, true),
  ('CB02', 'CB02', 20, true),
  ('PR03', 'PR03', 30, true),
  ('PM04', 'PM04', 40, true),
  ('BR05', 'BR05', 50, true),
  ('CN10', 'CN10', 60, true),
  ('PP20', 'PP20', 70, true),
  ('IT30', 'IT30', 80, true),
  ('PM40', 'PM40', 90, true),
  ('CZ50', 'CZ50', 100, true),
  ('BR60', 'BR60', 110, true),
  ('CC70', 'CC70', 120, true)
on conflict (code) do update
set label = excluded.label,
    sort_order = excluded.sort_order,
    is_active = excluded.is_active;