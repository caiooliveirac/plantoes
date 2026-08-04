-- Desfecho de pagamento da retirada/saída antecipada decidida pela chefia.
--
-- Regra (medida a partir da JANELA do turno, não da chegada do médico):
--   'bank_only'  -> saiu antes de completar 6h de janela: não assina o plantão;
--                   as horas trabalhadas viram crédito no banco de horas.
--   'half_shift' -> completou 6h mas saiu faltando mais de 2h para o fim:
--                   assina MEIO plantão; o excedente de 6h vira crédito.
--   'full_shift' -> saiu faltando 2h ou menos: assina o plantão inteiro
--                   (registro só de auditoria, sem efeito em pagamento/banco).
--
-- NULL = ocupação sem decisão de retirada antecipada (comportamento normal).
--
-- Independente do meio plantão declarado na chegada (role_label MEIO_PLANTAO,
-- janela 11:30–17:00): aquele é uma função; este é um desfecho decidido na
-- saída. Fonte da régua: modules/operational/early-departure.ts.

alter table operations_v2.regulation_occupancies
    add column if not exists early_departure_outcome varchar(10);

alter table operations_v2.intervention_occupancies
    add column if not exists early_departure_outcome varchar(10);
