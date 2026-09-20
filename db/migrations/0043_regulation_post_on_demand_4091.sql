-- Ramal "eventual" (on_demand): não é uma posição fixa da regulação. Só aparece
-- no quadro enquanto tem médico ativo nele e nunca conta como vaga descoberta
-- (pagamento, auditoria de slot, lembretes de "ramal sem aviso"). Também fica
-- fora da divisão de almoço/jantar por regra fixa, como PIAM/NUCLEO.
-- Ver listRegulationBoard em services/board.service.ts e
-- shouldIncludePaymentAllocationTarget para os pontos que leem a flag.
alter table operations_v2.regulation_posts
    add column if not exists on_demand boolean not null default false;

insert into operations_v2.regulation_posts (code, label, default_role, sort_order, is_active, on_demand)
values ('4091', 'Ramal 4091', null, 235, true, true)
on conflict (code) do update
set label = excluded.label,
    default_role = excluded.default_role,
    sort_order = excluded.sort_order,
    is_active = excluded.is_active,
    on_demand = excluded.on_demand;
