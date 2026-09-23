update operations_v2.bank_hours_legacy_balances
set
    pre_may_2025_minutes = pre_may_2025_minutes - 2880,
    total_minutes = total_minutes - 2880,
    notes = nullif(trim(both E'\n' from replace(coalesce(notes, ''), 'Ajuste coordenação ago/2026: +48h (+2880 min) no saldo até 30/abr/2025 (migration 0043).', '')), '')
where spreadsheet_name = 'LUCAS ALBUQUERQUE'
  and pre_may_2025_minutes = 1035
  and total_minutes = 2925;
