# Architecture Review — Agent-Oriented Diagnosis

> For AI agents and human maintainers.
> What exists, what's confusing, what needs separation, what needs documentation first, what needs tests before change.

---

## 1. What Exists Today

### Module Structure
```
modules/
├── bank-hours/        # calculator (pure), continuity (pure), service (DB sync)
├── chiefs/            # (minimal)
├── doctors/           # directory, importer, service
├── intervention/      # service (occupancy lifecycle)
├── operational/       # board-rules (pure time), rules (scheduled inference), corrections (mutations), board-display, roles
├── regulation/        # service (occupancy lifecycle)
├── reporting/         # monthly-report, monthly-report-xlsx, bank-hours-history
└── telegram/          # service (GOD FILE), parser, replies, reminders, shift-report, departure-report, summary-report
                       # meal-breaks, name-resolution, presentation-order, commands, config, api
                       # + many sub-command parsers

services/
├── board.service.ts            # Read models (current board, history, payment)
├── operational-history.service.ts
├── auth.service.ts
├── chief-access.service.ts
├── payment-attestation.service.ts
├── slot-audit.service.ts
├── monthly-report.service.ts
└── bank-hours-history.service.ts
```

### Good Separations Already Present
- **Pure time/shift logic** in `board-rules.ts` and `rules.ts` — testable, no side-effects.
- **Bank hours calculator** — pure math function with clear inputs/outputs.
- **Telegram parser** — mostly pure, well-tested.
- **Report builders** — `shift-report.ts`, `departure-report.ts`, `summary-report.ts` are pure transforms.
- **Presentation order** — `presentation-order.ts` is pure sort logic.

### What's Confusing

#### A. `telegram/service.ts` (5976 lines) — The God File
Contains 23 distinct responsibilities that should be separate modules:
1. Pending state management (name selection, justification, correction, batch)
2. Doctor resolution (fuzzy match, fallback, directory lookup)
3. Continuation semantics (3 different modes)
4. Late departure reason parsing & validation
5. Departure correction candidate selection
6. Occupancy application (the `applyParsedEntry` 250-line function)
7. Command dispatching (~1600 lines)
8. Batch processing
9. Message logging & audit trail
10. Authorization & chat filtering
11. Group notification dispatch
12. Historical removal commands
13. Reply formatting helpers
14. UI example builders
15. Main entry point routing

#### B. `board.service.ts` (2496 lines) — Hidden Business Rules
- Occupancy closure logic (successor handoff, implicit expiry, departure evidence regex)
- Noise filtering (shadow occupancies, bot commands, micro-coverages)
- Payment candidate ranking with opaque scoring weights
- Legacy system merge logic
- Read-model functions that call mutations (`expireInterventionBaseDeactivations`)

#### C. `operational-board-client.tsx` (3727 lines) — UI Monolith
- Data fetching, WebSocket, state management, drawer logic, grid rendering all in one component.

---

## 2. What Needs Separation

### Priority Splits (P0)

#### Split 1: Extract `telegram/service.ts` → 5 focused modules
| New Module | Lines | From | Responsibility |
|-----------|-------|------|----------------|
| `telegram/pending-state.ts` | ~400 | Lines 4208–4500 | Find/queue/supersede pending interactions |
| `telegram/doctor-resolution.ts` | ~200 | Lines 1285–1412 | Doctor lookup, continuation-without-base, fallback |
| `telegram/departure-flow.ts` | ~350 | Lines 557–735, 884–1183 | Late departure reason, correction candidates, justification |
| `telegram/occupancy-application.ts` | ~300 | Lines 4492–4800 | The `applyParsedEntry` function + `sendSuccessReply` |
| `telegram/command-handlers.ts` | ~400 | Lines 2523–4150 (selected) | Individual command handler functions extracted |

#### Split 2: Extract `board.service.ts` → 2 focused modules
| New Module | Lines | From | Responsibility |
|-----------|-------|------|----------------|
| `board/occupancy-closure.ts` | ~300 | Lines 338–549, 551–689 | Closure resolution, noise filtering, candidate ranking |
| `board/payment-candidacy.ts` | ~400 | Lines 1733–1966 | Payment candidate filtering, scoring, conflict resolution |

### P1 Splits
- Extract individual command handlers from `handleTelegramCommand()` into per-command functions
- Split `operational-board-client.tsx` into container + presentation components (future)

---

## 3. What Needs Documentation First

### Invariants (Not Currently Documented)
1. One active occupancy per regulation post. One active occupancy per intervention base.
2. Starting new occupancy auto-closes previous on same target AND same doctor on different target.
3. P shifts span 2 slot boundaries. Bank hours aggregated via continuity groups.
4. "Disabled" is domain state (base/post taken offline), not same as "vacant" (waiting for doctor).
5. Payment allocation ranks candidates by coverage time, slot alignment, and source quality.
6. Occupancy closure priority: explicit departure > successor handoff > implicit slot expiry.
7. Read-model queries are NOT idempotent — they trigger expiry side-effects.
8. Telegram processing order: command → meal break → batch → correction → justification → name selection → fresh parse.

### Source of Truth Map
| Concept | Source of Truth | NOT source of truth |
|---------|----------------|---------------------|
| Doctor presence now | `regulation_occupancies` / `intervention_occupancies` (active) | Board UI (derived) |
| Shift label/window | `board-rules.ts` → `resolveOperationalShiftWindow()` | Telegram message text |
| Payment allocation | `board.service.ts` → `buildPaymentAllocationBoardModel()` | UI display |
| Bank hours | `bank_hours_entries` table | Calculator output (transient) |
| Doctor identity | `doctors` table | Telegram sender name |
| Occupancy closure time | `effectiveEndedAt` in occupancy record | `scheduledEndAt` |

---

## 4. What Needs Tests Before Change

| Area | Risk Level | Current Coverage | Test Needed |
|------|-----------|-----------------|-------------|
| `corrections.ts` | **P0** | None | Occupancy correction, transfer, removal |
| `applyParsedEntry()` | **P0** | Indirect only | Direct unit tests for arrival/departure/continuation paths |
| Occupancy closure logic | **P0** | Via payment allocation | Direct tests for successor handoff, implicit expiry |
| Auth service | **P2** | Password policy only | Login, session, reset token |
| Chief access | **P2** | None | Invite, bootstrap, review |

---

## 5. Refactoring Danger Zones

### Do NOT change without understanding:
1. **`compareTelegramContinuitySource()`** — Sorting occupancies for continuation linking. Wrong sort = wrong continuity chain = wrong bank hours.
2. **`rankPaymentAllocationCandidate()`** — Scoring weights determine who gets paid. Any change silently affects all past/future allocations.
3. **`resolveOperationalShiftWindow()`** — Foundation for all time-based decisions. Everything depends on this being correct.
4. **`processTelegramUpdate()` routing order** — Priority chain must be preserved exactly.
5. **Legacy merge in `listRegulationBoard()`** — `operations_v2` takes precedence over `public.shift_current_state`. Changing merge order breaks the board.

---

## 6. Architecture Recommendations

### Immediate (this session)
1. Extract focused modules from `telegram/service.ts` to reduce file size and clarify responsibilities.
2. Add module-level README files to critical directories.
3. Add header comments to critical files with Purpose/Invariants/Danger.
4. Add protection tests for `corrections.ts`.
5. Create ADRs for key architectural decisions.

### Future (tracked, not executed)
1. Split `operational-board-client.tsx` into container + presentation components.
2. Move expiry side-effects out of board read queries into explicit pre-read step.
3. Extract `handleTelegramCommand()` into per-command handler files.
4. Consider event sourcing for occupancy state changes (currently direct mutations).
