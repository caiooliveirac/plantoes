-- Saldo inicial do contrato, separado do teto.
--
-- Caso real: médico que começou a usar a aplicação em maio já tinha parte do
-- teto consumida antes. A fórmula "teto - pagamentos desde seed_month" parte do
-- valor errado. Com opening_balance_brl o admin informa o saldo que valia no
-- início do seed_month e o cálculo passa a ser
-- "saldo_inicial - pagamentos desde seed_month". Nulo = comportamento antigo
-- (parte do teto).
alter table operations_v2.doctor_contracts
    add column if not exists opening_balance_brl numeric(12, 2);
