-- Madrugada: médico que cobre temporariamente o horário de outro na noite
-- (23:00–03:00 ou 03:00–07:00). Ver docs/madrugada.md.
--
-- 1) Ramais 2266–2270: cinco ramais novos. Eventuais (on_demand, como o 4091):
--    só aparecem no quadro com médico dentro e nunca contam como vaga
--    descoberta (pagamento, auditoria de slot, "ramais sem aviso").
-- 2) Coluna de cobertura na ocupação de regulação. Ocupação com
--    madrugada_cobre_ocupacao_id preenchida é de QUEM COBRE: aparece no quadro
--    e deixa o médico "de plantão" (Mesa/Tabela), mas fica fora do pagamento e
--    do banco de horas. A ocupação coberta (a do titular) não muda nada — segue
--    paga e no banco dele — e só some do quadro enquanto a cobertura vale.
--    `on delete set null` NÃO serve: tornaria a cobertura pagável. A marca
--    booleana é que exclui do pagamento; o id é só para achar o coberto.
--
-- Aplicar ANTES do deploy (o código novo lê a coluna).

insert into operations_v2.regulation_posts (code, label, default_role, sort_order, is_active, on_demand)
values
    ('2266', 'Ramal 2266', null, 224, true, true),
    ('2267', 'Ramal 2267', null, 224, true, true),
    ('2268', 'Ramal 2268', null, 224, true, true),
    ('2269', 'Ramal 2269', null, 224, true, true),
    ('2270', 'Ramal 2270', null, 224, true, true)
on conflict (code) do update
set label = excluded.label,
    default_role = excluded.default_role,
    sort_order = excluded.sort_order,
    is_active = excluded.is_active,
    on_demand = excluded.on_demand;

alter table operations_v2.regulation_occupancies
    add column if not exists madrugada_cobertura boolean not null default false,
    add column if not exists madrugada_cobre_ocupacao_id uuid
        references operations_v2.regulation_occupancies (id) on delete set null;

create index if not exists regulation_occupancies_madrugada_cobre_idx
    on operations_v2.regulation_occupancies (madrugada_cobre_ocupacao_id)
    where madrugada_cobre_ocupacao_id is not null;
