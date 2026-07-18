# Refactoring Plan — For AI Agents

> Pragmatic, executable, behavior-preserving.
> Priority order: highest-risk extractions first.

---

## Progress Summary (Updated)

| Step | Status | Details |
|------|--------|---------|
| Step 1: Protection tests corrections.ts | ✅ DONE | 16 tests in `tests/operational-corrections.test.ts` |
| Step 4: Extract departure-flow.ts | ✅ DONE | ~300 lines extracted, re-exports in service.ts |
| Steps 2,3,5-8: Remaining extractions | ⏸ DEFERRED | DB coupling makes clean extraction complex |
| Step 9: Module READMEs | ✅ DONE | READMEs for telegram/, operational/, services/, bank-hours/ |
| Step 10: ADRs | ✅ DONE | 5 ADRs in docs/adr/ |
| Header comments on critical files | ✅ DONE | service.ts, corrections.ts, board.service.ts, meal-breaks.ts, schema.ts |

**Test baseline: 216 tests passing (200 original + 16 new protection tests)**

---

## Guiding Principles
1. Extract, don't rewrite. Move existing code into new files with re-exports.
2. Preserve all function signatures. Existing callers must not change.
3. Add re-exports from original file so external imports keep working.
4. Write protection tests BEFORE moving code in risky areas.
5. Each extraction is independently verifiable via existing tests.

---

## Step 1: Protection Tests for `corrections.ts` (P0) ✅ DONE

**Why first:** 794 lines of untested admin mutation code. Must be covered before any refactoring in this area.

**Why first:** 794 lines of untested admin mutation code. Must be covered before any refactoring in this area.

**Create:** `tests/operational-corrections.test.ts`
**Test cases:**
- Correct regulation occupancy time → bank hours recalculated
- Correct intervention occupancy time → bank hours recalculated
- Transfer occupancy between regulation posts
- Remove occupancy
- Edge: correct to time before arrival → error

---

## Step 2: Extract `telegram/pending-state.ts` from service.ts

**Lines moved:** ~300 lines (4208–4500 approx.)
**Functions extracted:**
- `findPendingNameSelection()`
- `findPendingDepartureJustification()`
- `findPendingDepartureCorrection()`
- `supersedePendingDepartureJustification()`
- `supersedePendingDepartureCorrection()`
- `isPendingResolutionData()`
- `isPendingDepartureJustificationData()`
- `isPendingDepartureCorrectionData()`
- `queuePendingDepartureJustification()`
- `queuePendingDepartureCorrection()`
- `queuePendingNameSelection()`

**Re-exports from service.ts:** Yes — all exports preserved.
**Tests affected:** `telegram-commands.test.ts` (imports already go through service.ts).
**Risk:** Low — these are self-contained DB operations.

---

## Step 3: Extract `telegram/doctor-resolution.ts` from service.ts

**Lines moved:** ~200 lines (1285–1412 approx.)
**Functions extracted:**
- `resolveContinuationWithoutBase()`
- `resolveDoctorId()`
- `listDirectoryEntries()`
- `resolveDoctorWithFallback()`
- `isExactDoctorMatch()`
- `resolveTelegramDoctorSurfaceName()`
- `buildApproximateMatchHint()`

**Re-exports from service.ts:** Yes for exported functions.
**Risk:** Low — self-contained lookup logic.

---

## Step 4: Extract `telegram/departure-flow.ts` from service.ts

**Lines moved:** ~400 lines
**Functions extracted:**
- `resolveTelegramEligibleLateDepartureReason()`
- `matchesTelegramLateDepartureReason()`
- `matchesTelegramLateDepartureKeyword()`
- `computeLevenshteinDistance()`
- `normalizeTelegramReasonText()`
- `stripTelegramOperationalFragments()`
- `parseTelegramStandaloneTime()`
- `pickLikelyDepartureCorrectionCandidate()`
- `compareDepartureCorrectionCandidates()`
- `listRecentDepartureCorrectionCandidates()`
- `requiresTelegramDepartureAdjustmentJustification()`
- `resolveDepartureCorrectionReferenceAt()`
- `resolveDepartureJustificationPromptKind()`
- `getPendingDepartureJustificationAttemptCount()`
- Related types and constants

**Re-exports:** Yes for all currently-exported functions.
**Risk:** Low — mostly pure functions + DB lookups.

---

## Step 5: Extract `telegram/occupancy-application.ts` from service.ts

**Lines moved:** ~300 lines (4492–4800)
**Functions extracted:**
- `applyParsedEntry()`
- `sendSuccessReply()`
- `formatTelegramReplyTime()`

**Re-exports:** Internal-only (not in public API).
**Risk:** **Medium** — `applyParsedEntry` is the most bug-prone function in the entire codebase. Extraction must be exact.
**Safety:** All existing telegram-commands tests cover this function's behavior.

---

## Step 6: Extract `telegram/message-logging.ts` from service.ts

**Lines moved:** ~80 lines
**Functions extracted:**
- `logTelegramMessage()`
- `markTelegramProcessed()`
- `buildResolutionData()`
- `markTelegramTrainingCandidate()`

**Risk:** Very low — pure DB inserts.

---

## Step 7: Extract `telegram/authorization.ts` from service.ts

**Lines moved:** ~80 lines
**Functions extracted:**
- `resolveTelegramCommandActor()`
- `isTelegramMessageAllowed()`

**Risk:** Low.

---

## Step 8: Extract `telegram/group-announcements.ts` from service.ts

**Lines moved:** ~60 lines
**Functions extracted:**
- `announcePrivateCorrectionToGroups()`
- `announcePrivateBatchToGroups()`
- `sendPrivateAdminAlert()`
- `sendTelegramReplyBatch()`

**Risk:** Very low.

---

## Step 9: Module-Level Documentation

**Create README.md in:**
- `modules/telegram/`
- `modules/operational/`
- `modules/regulation/`
- `modules/intervention/`
- `modules/bank-hours/`
- `services/`

**Create header comments in:**
- `modules/telegram/service.ts` (after extraction: purpose = orchestration only)
- `services/board.service.ts`
- `modules/operational/board-rules.ts`
- `modules/operational/rules.ts`
- `modules/regulation/service.ts`
- `modules/intervention/service.ts`
- `modules/bank-hours/calculator.ts`

---

## Step 10: ADRs

**Create `docs/adr/` with:**
1. `001-disabled-is-domain-state.md`
2. `002-history-navigates-by-shift.md`
3. `003-telegram-processing-order.md`
4. `004-payment-candidate-ranking.md`
5. `005-p-shift-continuity-groups.md`

---

## What Stays Unchanged

- `modules/operational/board-rules.ts` — Well-scoped, pure, well-tested.
- `modules/operational/rules.ts` — Same.
- `modules/bank-hours/calculator.ts` — Pure function, well-tested.
- `modules/bank-hours/continuity.ts` — Pure data structures.
- `modules/telegram/parser.ts` — Focused parsing, well-tested.
- `modules/telegram/replies.ts` — Pure reply builders.
- `modules/telegram/reminders.ts` — Self-contained reminder system.
- `modules/telegram/shift-report.ts` — Pure report builder.
- All report builders and presentation-order.
- All API routes (thin handlers delegating to services).
- All test files (verify correctness after extraction).

---

## Verification Strategy

After each extraction step:
1. Run `npx tsx --test tests/telegram-commands.test.ts tests/telegram-presentation-order.test.ts tests/operational-rules.test.ts tests/bank-hours.test.ts tests/payment-allocation.test.ts tests/telegram-reminders.test.ts tests/telegram-name-resolution.test.ts tests/operational-board-display.test.ts tests/intervention-base-state.test.ts`
2. Verify 200+ tests pass, 0 failures.
3. Run `npx tsc --noEmit` for type-checking.

---

## Not In Scope

- Splitting `operational-board-client.tsx` (UI refactor — separate effort)
- Splitting `meal-breaks.ts` (self-contained, low risk)
- Moving expiry out of board reads (requires careful coordination)
- Per-command handler files for `handleTelegramCommand()` (P2, future)
- Event sourcing for occupancy mutations (architectural shift, future)
