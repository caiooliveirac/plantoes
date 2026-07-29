-- 0037: remove as tabelas da implementação órfã de escala/trocas.
--
-- Escala e trocas são o produto do escala.mnrs.com.br (repo
-- escalas-e-trocas-samu); o plantões consome aquele sistema via
-- ESCALA_API_URL. O que existia aqui era uma segunda implementação, nunca
-- usada: as quatro tabelas estavam com ZERO linhas em produção, nenhuma
-- tabela remanescente as referencia por chave estrangeira e o código que as
-- lia saiu no commit anterior.
--
-- doctor_fixed_shifts NÃO entra aqui: apesar de vazia, é lida por
-- doctor-admin.service (preferências do médico no admin).
--
-- Ordem obedece as FKs internas do conjunto: bids -> offers -> swaps ->
-- scheduled_shifts. As funções de trigger do append-only de shift_swaps
-- ficam órfãs com o DROP TABLE e saem junto (só as de operations_v2 — as
-- homônimas do schema mgl não são tocadas).

drop table if exists operations_v2.shift_offer_bids;
drop table if exists operations_v2.shift_offers;
drop table if exists operations_v2.shift_swaps;
drop table if exists operations_v2.scheduled_shifts;

drop function if exists operations_v2.shift_swaps_forbid_delete();
drop function if exists operations_v2.shift_swaps_guard_update();
