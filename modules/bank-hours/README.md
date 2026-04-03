# Bank Hours Module

Calculates and manages bank hours (overtime/undertime) for SAMU doctors.

## Files

| File | Purpose | Test coverage |
|------|---------|---------------|
| `calculator.ts` | Core bank hours calculation logic | `bank-hours.test.ts` |
| `continuity.ts` | Continuity group span builder | `bank-hours-continuity.test.ts` |
| `service.ts` | Sync operations (write bank hours entries to DB) | `bank-hours.test.ts` |

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

## Invariants

- Bank hours entries are always tied to an occupancy (occupancyId + domain)
- Continuity groups span at most 2 consecutive shifts
- Sync operations are idempotent (same input → same bank hours entry)
- P-shift occupancies contribute to bank hours of the main shift they extend
