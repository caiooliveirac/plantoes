# ADR-001: isActive/disabled is Domain State, Not Soft Delete

## Status
Accepted

## Context
The system has `isActive` flags on `doctors`, `regulationPosts`, and `interventionBases`.
Early assumptions treated these as soft deletes, but they represent real operational state.

## Decision
- `isActive = false` on a **doctor** means the doctor is no longer part of the active roster.
  They may still have historical occupancies and bank-hours entries.
- `isActive = false` on a **post/base** means that position is temporarily deactivated
  (e.g., CRU-1366 deactivated for the night shift). It appears on the board as "DSV"
  (desativada) and affects payment allocation.
- Deactivations are tracked in `regulationPostDeactivations` / `interventionBaseDeactivations`
  with start/end timestamps and shift scope.

## Consequences
- Never filter out `isActive = false` records from queries that need historical data
- Disabled posts/bases MUST appear on the operational board (as "DSV")
- Payment allocation treats disabled slots as explicitly covered (no vacancy)
- Reactivation must check for stale deactivation records and clean them up
