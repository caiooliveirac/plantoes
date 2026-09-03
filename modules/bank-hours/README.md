# Bank Hours Module

Calculates and manages bank hours (overtime/undertime) for SAMU doctors.

## Files

| File | Purpose | Test coverage |
|------|---------|---------------|
| `calculator.ts` | Core bank hours calculation logic | `bank-hours.test.ts` |
| `continuity.ts` | Continuity group span builder | `bank-hours-continuity.test.ts` |
| `service.ts` | Sync operations (write bank hours entries to DB) | `bank-hours.test.ts` |
| `pending-actions.ts` | Pendências acionáveis de ±12h (PJ) e resumo diário | `bank-hours-pending-actions.test.ts` |
| `payroll.ts` | Abatimento em folha do estatutário (atraso do mês) | `bank-hours-payroll.test.ts` |

## Key Concepts

### Calculation
```
bankHours = actualEndedAt - startedAt - scheduledDuration
```
- Positive = overtime (doctor stayed longer than scheduled)
- Negative = undertime (doctor left early)
- Zero = exact match

### Continuity Groups
When a doctor continues across a shift boundary (SD→SN or vice versa),
their occupancies are linked into a **continuity group**. Bank hours
for the group are calculated as a single span, not per-occupancy.

### Balance Overrides
Manual adjustments applied via admin UI. Each override has a rule code
and explanation. Overrides are additive to the calculated balance.

### Teto de 6h (permanência não é banco)

Excedente de **6h ou mais** além do previsto nunca vira crédito: pela régua de
`modules/operational/extended-stay.ts` (espelho de `classifyEarlyDeparture`) ele
vira plantão a assinar na folha — MEIO entre 6h e 10h, INTEIRO de 10h em diante,
e só o resto abaixo de 6h continua no banco. Consequência: nenhum plantão
credita mais que 12h (6h brutas em dobro), por construção e não por exceção.
`npm run audit:extended-stay` lista as permanências que ainda não viraram plantão.

### PJ × estatutário: dois acertos diferentes

O vínculo mora em `doctors.metadata.employmentType` (`resolveDoctorEmploymentType`,
default `pj`) e chega ao histórico como `BankHoursDoctorHistory.employmentType`.

- **PJ** acerta em plantões de 12h no fechamento (`pending-actions.ts` +
  `services/bank-hours-settlements.service.ts`): saldo elegível ≥ +12h vira
  plantão **verde** (bônus, `deltaMinutes = -720`), ≤ -12h vira plantão
  **vermelho** (punição, `+720`). Cada acerto fica casado a um `adminExtraShifts`.
- **Estatutário** é pago pela folha da prefeitura, então saldo negativo não vira
  plantão vermelho: o atraso de cada plantão é descontado na folha de
  pagamento/ponto, plantão a plantão, **por mês**. `payroll.ts` soma só os
  plantões negativos do mês (`resolvePayrollDeductionForMonth`) e o admin clica
  "Abater em folha" em `/admin/bank-hours`: nasce um `bankHoursSettlements` com
  `kind = "payroll"`, `deltaMinutes = +minutos abatidos`, **sem** plantão extra
  (`adminExtraShiftId = null`). O crédito (hora extra) continua acumulando e
  vira plantão extra pela régua normal de +12h. Estorno cria o settlement
  oposto, mesmo `kind`, mesmo mês.
- O mês do plantão (`BankHoursHistoryShift.monthKey`) segue a janela programada
  do banco em São Paulo — um SN que começou à 1h do dia 1º pertence ao mês
  anterior, como no fechamento.

## Invariants

- Bank hours entries are always tied to an occupancy (occupancyId + domain)
- Continuity groups span at most 2 consecutive shifts
- Sync operations are idempotent (same input → same bank hours entry)
- P-shift occupancies contribute to bank hours of the main shift they extend
