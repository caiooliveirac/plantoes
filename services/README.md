# Services

Application-level services that compose domain modules into higher-level operations.

## Files

| File | Lines | Purpose | Test coverage |
|------|-------|---------|---------------|
| `board.service.ts` | ~2496 | Operational board read model, payment allocation | `operational-board-display.test.ts`, `payment-allocation.test.ts` |
| `auth.service.ts` | — | User authentication, session management | `auth-token.test.ts` |
| `bank-hours-history.service.ts` | — | Bank hours historical log queries | `bank-hours-history.test.ts` |
| `chief-access.service.ts` | — | Chief UI operations (correct, transfer, remove) | — |
| `monthly-report.service.ts` | — | Monthly shift report generation | `monthly-report.test.ts` |
| `operational-history.service.ts` | — | Operation history timeline queries | `operational-history.test.ts` |
| `payment-attestation.service.ts` | — | Payment attestation management | `payment-attestation.test.ts` |
| `slot-audit.service.ts` | — | Slot audit report generation | `slot-audit.test.ts` |

## board.service.ts

The largest service file. Builds the operational board view from raw occupancy data.

### Key Functions

- `getOperationalBoard(shiftWindow)` — Returns regulation + intervention board rows
  for a given shift window, with bank-hours balances and continuity groups.

- `getPaymentAllocationBoard(operationalDate, shiftLabel)` — Returns payment-focused
  view with automatic candidate ranking based on arrival time, bank-hours balance,
  and historical patterns.

### Hidden Business Rules

1. **Implicit expiry**: Regulation occupancies without explicit end are expired based
   on shift boundaries and configurable tolerance windows.

2. **Payment candidate ranking**: Multi-factor heuristic considering arrival precedence,
   scheduled coverage, and manual overrides.

3. **Continuity group resolution**: Links consecutive occupancies by the same doctor
   across shift transitions for accurate bank-hours calculation.

4. **Nucleo special handling**: Regulation posts marked as `isNucleo` get different
   pending-label logic (shows "aguardando" instead of "vago").
