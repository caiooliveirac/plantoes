# ADR-005: P-Shift Continuity Groups

## Status
Accepted

## Context
"P" shifts (plantão extra) occur when a doctor continues working beyond
the standard SD/SN boundary. These create continuity between shifts that
affects bank-hours calculation and board display.

## Decision
- When a doctor continues from SD to SN (or vice versa), the system
  creates a **continuity group** linking their occupancies.
- The continuation creates a NEW occupancy in the new shift, but the
  original arrival time is preserved in the continuity group metadata.
- Bank hours are calculated across the full continuity span, not per
  individual occupancy.
- P-shift occupancies are labeled with `shiftLabel = 'P'` and attributed
  to the shift they started in.

## Key Rules
- `shouldLinkTelegramArrivalToContinuitySource()` decides if an arrival
  should be linked to an existing occupancy (within 18h window).
- `shouldTreatTelegramArrivalAsContinuation()` detects continuation intent
  from message text patterns ("continuo", "fico", "emendo", etc.).
- Continuity groups span at most 2 consecutive shifts.
- P-shift boundary tolerance: arrivals within 30 minutes of shift boundary
  may be classified as P instead of the new shift.

## Consequences
- Bank-hours for P-shifts must use the full continuity span
- Board display shows P-shift doctors with special markers
- Departure from a P-shift affects the bank-hours of the original shift
- Telegram bot must detect continuation intent even without explicit "/continuo"
