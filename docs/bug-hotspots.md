# Bug Hotspots — Risk-Prioritized Analysis

> Derived from git history, conversation-tracked bug fixes, file churn, and structural inspection.
> Priority: P0 = risk of incorrect data/payment, P1 = maintenance drag, P2 = readability.
>
> Números de linhas e churn atualizados em 27/09/2026 (`origin/main` fd17452). As evidências "Session N" são da análise original.

---

## Priority Matrix

| ID | File(s) | Priority | Issue | Evidence |
|----|---------|----------|-------|----------|
| H1 | `modules/telegram/service.ts` | **P0** | ~14.5k-line god file (14.508 em 27/09, após extrair a decisão de chegada para `arrival-classification.ts`) mixing 10+ responsibilities; 47 commits in the last 90 days (highest churn). Every feature/fix touches this file. | Session 1–6 fixes all touched this file. |
| H2 | `services/board.service.ts` | **P0** | ~4.9k lines (4.937), 20 commits in 90 days. Hidden business rules in payment allocation (candidate ranking, noise filtering, closure logic). Read-model calls mutations before reading. | Session 4: P-shift bleeding via regulation buffer. |
| H3 | `modules/telegram/shift-report.ts` | **P0** | Shift status resolution missed null `shiftLabel` (29% of occupancies). False carryover reports. | Session 6: false pending fix. |
| H4 | `modules/regulation/service.ts` | **P0** | Ramal switch didn't close occupancy on old ramal → overlapping occupancies. 19 historical overlaps found. | Session 5: ramal switch auto-close. |
| H5 | `modules/operational/rules.ts` | **P0** | P-shift boundary tolerance missing → payment-allocation gaps for 6 doctors. | Session 3: `P_SHIFT_PRE_BOUNDARY_TOLERANCE_MS` fix. |
| H6 | `modules/operational/corrections.ts` | **P1** | 1.855 lines, 18 commits in 90 days. Handles admin corrections, transfers, removals with bank hours sync. | Tests now exist (`operational-corrections`, `correcao-auditavel`, `half-shift-role-change`, …), but the file more than doubled. |
| H7 | `app/operational-board-client.tsx` | **P1** | 5.414-line monolith mixing data fetching, state, drawers, grids, domain rules. 22 commits in 90 days. | Third highest churn (90 days). |
| H8 | `modules/telegram/meal-breaks.ts` | **P1** | ~7.7k lines (7.735), 17 commits in 90 days. Self-contained but oversized. Meal-break session state + Telegram + DB in one file. | Session fix: meal-break consuming arrival messages. |
| H9 | `modules/telegram/parser.ts` | **P1** | 708 lines. Parser contains keyword stoplists that look like business rules. | Repeated fixes to parsing edge cases. |
| H10 | `services/board.service.ts` (closure) | **P0** | Occupancy closure logic (`resolveCandidateEffectiveEndedAt`) embeds rules about successor handoff, implicit expiry, departure evidence detection via regex on notes. | Session 4 fix was in this exact area. |
| H11 | `modules/telegram/service.ts` (applyParsedEntry) | **P0** | Long function mixing DB queries, continuation chain resolution, and persistence. The arrival-type decisions now live in `modules/telegram/arrival-classification.ts` (pure, table-tested). | Sessions 1, 3, 5 all modified this function. |
| H12 | `modules/telegram/service.ts` (handleTelegramCommand) | **P1** | ~1600-line command dispatcher with inline permission checks, DB queries, and reply formatting per command. | Growing with each new command. |
| H13 | `modules/telegram/service.ts` (processTelegramUpdate) | **P1** | ~450-line main entry with 10+ code paths, each fetching pending state from DB. | Every Telegram flow change forces reading this. |
| H14 | `services/auth.service.ts` | **P2** | No dedicated tests (240 lines). | Low churn but security-sensitive. |
| H15 | `services/chief-access.service.ts` | **P2** | No dedicated tests (450 lines). | Low churn, access control logic. |

---

## Churn — últimos 90 dias

`git log origin/main --since=2026-06-29 --no-merges --name-only`, arquivos `.ts/.tsx` fora de `tests/` (266 commits no período):

| # | Arquivo | Commits | Linhas |
|---|---------|---------|--------|
| 1 | `modules/telegram/service.ts` | 47 | 14.508 |
| 2 | `app/admin/payment-attestation/chief-payment-view-client.tsx` | 24 | 3.264 |
| 3 | `app/operational-board-client.tsx` | 22 | 5.414 |
| 4 | `services/board.service.ts` | 20 | 4.937 |
| 5 | `app/admin/bank-hours/bank-hours-history-client.tsx` | 19 | 2.000 |
| 6 | `modules/reporting/payable-shifts.ts` | 18 | 1.320 |
| 7 | `modules/operational/corrections.ts` | 18 | 1.855 |
| 8 | `modules/intervention/service.ts` | 18 | 1.688 |
| 9 | `modules/telegram/meal-breaks.ts` | 17 | 7.735 |
| 10 | `modules/regulation/service.ts` | 17 | 1.529 |
| 11 | `app/banco-de-horas/[medicoId]/[ano]/[mes]/page.tsx` | 15 | 490 |
| 12 | `services/payable-shifts.service.ts` | 14 | 863 |
| 13 | `modules/reporting/bank-hours-history.ts` | 14 | 1.105 |

---

## Recurring Bug Patterns

### Pattern 1: Null/Missing Shift Label
**Files:** `shift-report.ts`, `board.service.ts`, `rules.ts`
**Root cause:** Doctors often don't say SD/SN explicitly. `shiftLabel` is null in 29% of regulation occupancies.
**Recurrence:** Session 6 (false carryover in /plantao). Likely to recur in any new code that branches on `shiftLabel`.
**Prevention:** Always handle null shiftLabel as a first-class case. Use `boardStartedAt` timing as fallback.

### Pattern 2: P-Shift Boundary Confusion
**Files:** `rules.ts`, `board.service.ts`, `service.ts`
**Root cause:** P shifts span two slots. Code that checks shift boundaries must handle the 07:00/19:00 crossover.
**Recurrence:** Session 3 (payment gaps), Session 4 (regulation buffer bleeding).
**Prevention:** Centralize P-shift boundary logic. The `resolvePShiftAwareBaseShiftLabel()` function was created for this.

### Pattern 3: Occupancy Overlap
**Files:** `regulation/service.ts`, `intervention/service.ts`
**Root cause:** Starting a new occupancy didn't always close the old one (especially cross-ramal).
**Recurrence:** Session 5 (19 historical overlaps from ramal switches).
**Prevention:** Always close all active occupancies for a doctor before opening a new one. Test with multi-target scenarios.

### Pattern 4: Read-Model Calling Mutations
**Files:** `board.service.ts`
**Root cause:** `getOperationalBoard()` and `getPaymentAllocationBoard()` call `expireInterventionBaseDeactivations()` as side-effect.
**Risk:** Makes read queries non-idempotent. Complicates testing and caching. Could cause unexpected state changes during read operations.
**Prevention:** Move expiry to a scheduled job or explicit pre-read step.

### Pattern 5: Continuation Semantics Confusion
**Files:** `telegram/service.ts` (multiple functions)
**Root cause:** "Continuation" means different things: same doctor extending shift, P-shift rollover, explicit `/continuar` command. Logic spread across `shouldTreatTelegramArrivalAsContinuation`, `resolveTelegramContinuationMode`, `findTelegramContinuityContext`, `closeTelegramActiveContinuityOccupancies`.
**Recurrence:** Sessions 1, 3 fixes. 3 commits with "continuation" in message.
**Prevention:** Document the 3 continuation modes. Extract to dedicated module.

---

## Files Requiring Tests Before Any Change

| File | Lines | Test Coverage | Risk |
|------|-------|---------------|------|
| `services/payable-shifts.service.ts` | 863 | **None** for the service (pure rules in `modules/reporting/payable-shifts.ts` are tested); 14 commits in 90 days | Payment closing, monthly consumption for the contract ledger |
| `services/auth.service.ts` | 240 | **Minimal** (password policy only) | Authentication, session management |
| `services/chief-access.service.ts` | 450 | **None** | Access control provisioning |
| `services/board.service.ts` (closure logic) | ~300 lines | **Indirect** (via payment-allocation tests) | Occupancy closure rules, noise filtering |

---

## Dangerous Refactoring Zones

1. **`applyParsedEntry()` in telegram/service.ts** — Touching this function has caused 3+ Sessions of bug fixes. Any split must preserve the exact ordering of: occupancy lookup → continuation check → start/end/continue decision → bank hours sync.

2. **`collapseLogicalShiftCandidates()` + ranking in board.service.ts** — Payment correctness depends on subtle scoring weights. Changes here can silently shift which doctor gets paid for a slot.

3. **`processTelegramUpdate()` routing order** — The 10-step priority chain (command → meal break → batch → correction → justification → name selection → batch → continuation → smalltalk → fresh parse) must be preserved exactly.

4. **Regulation/Intervention symmetry** — These two domains are structurally identical but implemented separately. Any fix in one must be checked in the other (Session 5 fix was regulation-only initially).
