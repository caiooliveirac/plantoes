-- Ramal do reforço DISP é o 4092, não o 4091 (01/10/2026). O 4091 é da ADM,
-- não é posto de médico.
--
-- 1) Nasce o posto 4092, eventual (on_demand) como era o 4091 (migration 0043),
--    na mesma vizinhança da ordenação (depois dos fixos, antes de PIAM/NUCLEO).
-- 2) A ocupação ABERTA no 4091 (ended_at null — a médica DISP do dia, que na
--    verdade está no 4092) passa para o 4092. Só ela: plantão encerrado
--    continua no 4091, o histórico não muda. Chegada, janela, grupo de
--    continuidade e banco de horas seguem os mesmos (só posto e rótulo mudam).
-- 3) O posto 4091 NÃO é desativado: is_active = false tira o ramal dos alvos do
--    fechamento de pagamento (loadPaymentAllocationSourceData filtra
--    rp.is_active) e trava correções nas ocupações antigas dele — e setembro tem
--    plantão no 4091. Ativo, eventual e vazio ele já é invisível no quadro e não
--    conta como vaga; a aposentadoria é no código: o bot troca 4091 por 4092
--    (resolveRegulationRamalAlias) e a Mesa não o oferece mais
--    (isRetiredRegulationRamal).
--
-- Aplicar ANTES do deploy: o código novo registra no 4092.

insert into operations_v2.regulation_posts (code, label, default_role, sort_order, is_active, on_demand)
values ('4092', 'Ramal 4092', null, 235, true, true)
on conflict (code) do update
set label = excluded.label,
    default_role = excluded.default_role,
    sort_order = excluded.sort_order,
    is_active = excluded.is_active,
    on_demand = excluded.on_demand;

update operations_v2.regulation_occupancies ro
set post_id = novo.id,
    ramal_label = '4092',
    updated_at = now()
from operations_v2.regulation_posts antigo, operations_v2.regulation_posts novo
where antigo.code = '4091'
  and novo.code = '4092'
  and ro.post_id = antigo.id
  and ro.ended_at is null;
