-- Reverter os pedidos do médico. Pedidos pendentes somem; continuações já
-- aceitas ficam (viraram ocupação normal, criadas por continue*Occupancy).
drop table if exists operations_v2.pedidos_do_medico;
