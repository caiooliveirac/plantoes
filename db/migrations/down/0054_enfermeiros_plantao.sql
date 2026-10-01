-- Reverter o registro do enfermeiro(a) do plantão. O histórico some junto; o
-- quadro.mnrs.com.br volta a liberar só médicos de plantão, admin e Central.
drop table if exists operations_v2.enfermeiros_plantao;
