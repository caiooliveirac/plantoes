# ADR-002: Operational History Navigates by Shift, Not Calendar Day

## Status
Accepted

## Context
SAMU operates in 12-hour shifts: SD (07:00-19:00) and SN (19:00-07:00).
The night shift (SN) spans two calendar days. Users expect to navigate
operations by shift, not by date.

## Decision
- All board views are scoped to a **shift window** (start/end timestamps),
  not a calendar date.
- `resolveOperationalShiftWindow(date, shiftLabel)` returns the canonical
  window for any given shift, considering São Paulo timezone.
- The operational history timeline is organized by shift boundaries.
- P-shifts (plantão extra) extend beyond the main shift boundary but are
  attributed to the shift they started in.

## Consequences
- Queries must always use shift windows, never raw dates
- Night shift data appears under the date of the shift START (e.g., SN
  starting Apr 4 19:00 shows under Apr 4, even though it ends Apr 5 07:00)
- P-shift occupancies inherit the main shift's bank-hours calculation window
- Frontend shift navigation increments by shift, not by day
