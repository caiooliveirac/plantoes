-- Posição de cada enfermeiro(a) do plantão (ERS): ADM (ramal 4091), DISP
-- (4092) ou FLUXO (fluxista, 3005). A chefia escolhe ao registrar; uma pessoa
-- por posição no turno. Linhas antigas ficam null ("sem posição"). Só
-- acrescenta coluna: aplicar ANTES do deploy.
alter table operations_v2.enfermeiros_plantao
    add column if not exists posicao text
    check (posicao is null or posicao in ('ADM', 'DISP', 'FLUXO'));
