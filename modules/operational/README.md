# Operational Module

Core operational rules and state management for SAMU shift operations.

## Files

| File | Lines | Purpose | Test coverage |
|------|-------|---------|---------------|
| `corrections.ts` | ~794 | Occupancy time corrections, transfers, removals | **NONE (P0)** |
| `rules.ts` | — | Shift window inference, event time resolution | `operational-rules.test.ts` |
| `board-rules.ts` | — | Shift boundaries, overtime detection, implicit expiry | `operational-rules.test.ts` |
| `board-display.ts` | — | Presentation labels, post type detection | `operational-board-display.test.ts` |
| `roles.ts` | — | Role normalization (CM, CIR, PED, etc.) | — |

## Shift System

- **SD** (Serviço Diurno): 07:00–19:00 São Paulo time
- **SN** (Serviço Noturno): 19:00–07:00 São Paulo time
- **P** (Plantão extra): Continues beyond the main shift boundary

## Key Concepts

### Occupancy Lifecycle
```
startRegulationOccupancy() → occupancy.startedAt
  ↓ (continuation possible)
continueRegulationOccupancy() → new occupancy, original arrival preserved
  ↓ (shift ends)
endRegulationOccupancy() → occupancy.endedAt (scheduled), occupancy.actualEndedAt (real)
```

### Bank Hours
- Calculated from `actualEndedAt - startedAt` minus scheduled shift duration
- Positive = overtime, negative = early departure
- Continuity groups link consecutive occupancies by same doctor for accurate calculation

### Corrections (corrections.ts)
- `correctRegulationOccupancy()` / `correctInterventionOccupancy()` — fix times, shift label, role
- `transferOperationalOccupancy()` — move occupancy to different post/base
- `removeRegulationOccupancyRecord()` / `removeInterventionOccupancyRecord()` — delete with cascades

**WARNING**: corrections.ts has zero test coverage. It handles displacement of existing
occupancies, bank-hours recalculation, and deactivation state sync. Changes here require
manual verification.

## Invariants

- `startedAt < endedAt` always (enforced by `validateChronology`)
- `actualEndedAt` tracks real departure; `endedAt` tracks scheduled handoff
- Transfers displace any open occupancy at the destination target
- All timestamps stored in UTC; São Paulo offset (-180 min) applied in application layer
