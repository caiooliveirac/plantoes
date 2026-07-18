# ADR-004: Payment Allocation Candidate Ranking

## Status
Accepted

## Context
Multiple doctors may be present at the same regulation post or intervention
base during a shift. Only one doctor can be paid per slot per shift. The
system needs to automatically rank candidates for payment allocation.

## Decision
Payment allocation uses a multi-factor heuristic:

1. **Manual override**: If a chief has manually assigned a doctor, that
   assignment takes absolute priority.

2. **Arrival precedence**: The first doctor to arrive at the target gets
   priority. This reflects the operational rule that the doctor who "opened"
   the shift should be paid.

3. **Scheduled coverage**: Doctors with scheduled (pre-allocated) shifts
   rank higher than walk-ins.

4. **Bank-hours balance**: In ties, the doctor with lower bank-hours balance
   is preferred (compensatory allocation).

5. **Active status**: Currently active doctors rank higher than those who
   already departed.

## Consequences
- The `getPaymentAllocationBoard()` function encodes these rules
- Chiefs can always override automatic allocation via UI
- Payment attestation (monthly report) uses the allocation board as input
- Edge cases: multiple arrivals at same time → alphabetical tiebreak
