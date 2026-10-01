-- Enfermeiros(as) do plantão: mais de um por turno.
--
-- O índice único parcial (turno_data, turno) onde substituido_em is null
-- limitava a uma linha ativa por turno. Passa a ser índice comum: registrar
-- acrescenta (sem duplicar a mesma pessoa), remover marca substituido_em só
-- da linha escolhida. Nenhum dado muda. Aplicar ANTES do deploy (o código novo
-- insere uma segunda linha ativa).

drop index if exists operations_v2.enfermeiros_plantao_ativo_idx;

create index if not exists enfermeiros_plantao_ativo_idx
    on operations_v2.enfermeiros_plantao (turno_data, turno)
    where substituido_em is null;
