-- Reverter o 4092: a ocupação aberta nele volta para o 4091 e o posto sai do
-- ar (não é apagado — plantão encerrado no 4092 continua apontando para ele).
-- Só faz sentido junto com o revert do código (o bot volta a aceitar 4091).
update operations_v2.regulation_occupancies ro
set post_id = antigo.id,
    ramal_label = '4091',
    updated_at = now()
from operations_v2.regulation_posts antigo, operations_v2.regulation_posts novo
where antigo.code = '4091'
  and novo.code = '4092'
  and ro.post_id = novo.id
  and ro.ended_at is null;
update operations_v2.regulation_posts set is_active = false where code = '4092';
