-- Ajuste pontual do saldo legado de LUCAS ALBUQUERQUE, pedido pela coordenação
-- (ago/2026): somar +48h (=+2880 min) à parcela "saldo até 30/abr/2025".
-- A tabela é imutável por convenção (ver 0034) — correção é sempre migração
-- explícita como esta. Valores conferidos em produção antes do ajuste:
--   pre_may_2025_minutes = -1845 (-30h45), spreadsheet_period_minutes = +1890,
--   total_minutes = +45.
-- Depois: pre_may_2025_minutes = +1035, total_minutes = +2925.
-- O WHERE trava nos valores antigos para a migração ser idempotente e falhar
-- em silêncio (0 linhas) se o registro já tiver sido ajustado.
update operations_v2.bank_hours_legacy_balances
set
    pre_may_2025_minutes = pre_may_2025_minutes + 2880,
    total_minutes = total_minutes + 2880,
    notes = coalesce(notes || E'\n', '')
        || 'Ajuste coordenação ago/2026: +48h (+2880 min) no saldo até 30/abr/2025 (migration 0043).'
where spreadsheet_name = 'LUCAS ALBUQUERQUE'
  and pre_may_2025_minutes = -1845
  and total_minutes = 45;
