# Domain Map — SAMU Operational Board

> Source of truth for how the system is organized.
> Written for AI agents and human maintainers.

## System Purpose

Operational board for São Paulo SAMU (emergency medical service).
Tracks doctor presence at intervention bases and regulation posts across 12-hour shifts (SD 07:00–19:00, SN 19:00–07:00 local São Paulo UTC-3).
Ingests messages from Telegram groups; renders a real-time board via Next.js; generates payment reports, audits, and alerts.

---

## Bounded Contexts (Internal Modules)

### 1. Telegram Ingestion & Parsing
**Files:** `modules/telegram/parser.ts`, `modules/telegram/commands.ts`, sub-command files (`shift-report-commands.ts`, `departure-report-commands.ts`, `bank-hours-commands.ts`, `payment-commands.ts`, `slot-audit-commands.ts`, `summary-report-commands.ts`, `admin-commands.ts`, `departure-priority.ts`)
**Responsibility:** Parse raw Telegram messages into structured operational entries (arrival, departure, continuation, command).
**Source of truth:** `parser.ts` determines intent; command files determine command routing.
**Boundary:** Pure functions — no DB, no side-effects.

### 2. Telegram Orchestration (⚠️ God Module)
**Files:** `modules/telegram/service.ts` (5976 lines)
**Responsibility:** Routes parsed messages to domain services; manages stateful pending interactions (name selection, justification, correction, batch confirmation); formats replies; dispatches notifications.
**Problem:** Mixes parsing helpers, business rules, DB queries, reply formatting, admin commands, and state machine routing in a single 6K-line file. Highest churn in the project (16 commits).
**Source of truth for:** Telegram webhook processing order & pending interaction state.

### 3. Telegram Reports & Replies
**Files:** `modules/telegram/shift-report.ts`, `modules/telegram/departure-report.ts`, `modules/telegram/summary-report.ts`, `modules/telegram/replies.ts`, `modules/telegram/reminders.ts`
**Responsibility:** Build read-only text reports from board data. No mutations.
**Source of truth:** Report format and content rules.

### 4. Telegram Meal Breaks
**Files:** `modules/telegram/meal-breaks.ts` (3723 lines)
**Responsibility:** Meal-break session state machine (queue, prompt, start, end, priority rotation).
**Problem:** Large file but well-scoped. Contains its own DB access and Telegram API calls.

### 5. Operational Time & Shift Rules
**Files:** `modules/operational/board-rules.ts`, `modules/operational/rules.ts`
**Responsibility:** Pure shift window resolution (SD/SN boundaries), scheduled start/end inference, verification boundaries, overtime thresholds, implicit occupancy expiry.
**Source of truth for:** What shift label applies at any given UTC timestamp. What "on time" means.
**Invariants:**
- SD: 07:00–19:00 São Paulo (UTC-3, offset -180min)
- SN: 19:00–07:00 São Paulo
- Pre-shift tolerance: 60 minutes (arrival at 06:00 → counts as SD)
- Verification grace: 15 minutes past shift boundary
- Overtime justification: 15 minutes past boundary

### 6. Operational Corrections
**Files:** `modules/operational/corrections.ts` (794 lines)
**Responsibility:** Admin corrections to occupancies (update times, transfer between targets, remove occupancies, trigger bank hours recalculation).
**Problem:** No dedicated tests. Called from both Telegram service and API routes.

### 7. Regulation Occupancy Lifecycle
**Files:** `modules/regulation/service.ts` (580 lines)
**Responsibility:** Start, continue, end, expire regulation occupancies. Post deactivation/reactivation.
**Source of truth for:** Active occupancy state at a regulation post.
**Key invariant:** One active occupancy per post. Starting new occupancy auto-closes previous (same doctor on different post too — added in Session 5).

### 8. Intervention Occupancy Lifecycle
**Files:** `modules/intervention/service.ts` (560 lines)
**Responsibility:** Start, continue, end intervention occupancies. Base deactivation/reactivation.
**Source of truth for:** Active occupancy state at an intervention base.
**Key invariant:** One active occupancy per base. Disabled status is domain state, not absence.

### 9. Bank Hours
**Files:** `modules/bank-hours/calculator.ts` (pure), `modules/bank-hours/continuity.ts` (pure), `modules/bank-hours/service.ts` (DB sync)
**Responsibility:** Calculate arrival delay, overtime, balance. Handle continuity groups (P shifts spanning 2 slots). Persist bank-hours entries.
**Source of truth for:** Doctor's time credit/debit per occupancy.
**Key invariant:** Bank hours are keyed by occupancy_id, recalculated on any time change.

### 10. Board Read Model (⚠️ Complex)
**Files:** `services/board.service.ts` (2496 lines)
**Responsibility:** Build current operational board, previous (historical) board, and payment allocation board from raw occupancies.
**Problem:** Contains hidden business rules (candidate ranking, noise filtering, legacy merge, occupancy closure logic, micro-coverage thresholds). Mixes read-model construction with mutation side-effects (`expireInterventionBaseDeactivations` called before reads).
**Source of truth for:** What the board shows right now. Payment allocation decisions.

### 11. Operational History
**Files:** `services/operational-history.service.ts`, `components/operational-history-panel.tsx`
**Responsibility:** Historical view navigable by operational date + shift label.
**Source of truth for:** Past shift summaries including bank hours.

### 12. Payment Attestation
**Files:** `services/payment-attestation.service.ts` (502 lines)
**Responsibility:** Slot lifecycle for payment certification (preview → draft → approved). Snapshot building.

### 13. Slot Audit
**Files:** `services/slot-audit.service.ts` (267 lines)
**Responsibility:** Audit report: which slots were occupied, vacant, or disabled in a date range.

### 14. Auth & Access Control
**Files:** `services/auth.service.ts`, `services/chief-access.service.ts`, `modules/auth/password-policy.ts`, `lib/auth/`
**Responsibility:** Password-based auth, session tokens, chief invite/bootstrap workflow.
**Roles:** admin (full write), chief (read + limited operations), doctor (Telegram only).

### 15. Doctor Directory
**Files:** `modules/doctors/service.ts`, `modules/doctors/importer.ts`, `modules/doctors/directory.ts`
**Responsibility:** Doctor CRUD, CSV import, name resolution, display name formatting.

### 16. Reporting
**Files:** `modules/reporting/monthly-report.ts`, `modules/reporting/monthly-report-xlsx.ts`, `modules/reporting/bank-hours-history.ts`, `services/monthly-report.service.ts`
**Responsibility:** Monthly admin audit, XLSX export, bank hours history view.

### 17. UI — Operational Board
**Files:** `app/operational-board-client.tsx` (3727 lines), `app/page.tsx`
**Responsibility:** Real-time operational board with drawer-based editing.
**Problem:** 3.7K lines mixing data fetching, state management, drawer logic, grid rendering, and domain rules.

### 18. UI — Admin Pages
**Files:** `app/admin/payment-allocation/`, `app/admin/payment-attestation/`, `app/admin/bank-hours/`, `app/admin/reports/`, `app/admin/chief-access/`, `app/admin/slot-audit/`
**Responsibility:** Admin-only views for payment, attestation, bank hours, reports.

---

## Database Schema (operations_v2)

| Table | Purpose |
|-------|---------|
| `doctors` | Doctor directory |
| `users` | App users (admin/chief) |
| `user_roles` | Role assignments |
| `password_reset_tokens` | Password reset lifecycle |
| `chief_invites` | Chief invitation tokens |
| `chief_access_requests` | Chief onboarding workflow |
| `regulation_posts` | Regulation ramal definitions |
| `intervention_bases` | Intervention base definitions |
| `regulation_occupancies` | Active/historical regulation shifts |
| `intervention_occupancies` | Active/historical intervention shifts |
| `regulation_post_deactivations` | Post disabled periods |
| `intervention_base_deactivations` | Base disabled periods |
| `shift_events` | Audit log of operational mutations |
| `bank_hours_entries` | Calculated bank hours per occupancy |
| `bank_hours_balance_overrides` | Manual bank hours adjustments |
| `payment_attestation_slots` | Payment certification slots |
| `payment_attestation_slot_entries` | Entries within attestation slots |
| `telegram_ingested_messages` | All Telegram messages + resolution data |
| `telegram_bot_notices` | Scheduled notice dedup |
| `audit_logs` | App-level audit trail |

---

## Critical Data Flows

### Telegram Arrival → Board
```
Telegram webhook → processTelegramUpdate() → parseTelegramMessage()
→ resolveDoctorCandidate() → applyParsedEntry()
→ startRegulationOccupancy() / startInterventionOccupancy()
→ board.service.ts reads updated state
→ SSE stream pushes to UI
```

### Payment Allocation
```
getPaymentAllocationBoard() → query occupancies ± 1 day
→ mapLogicalShiftCandidate() → collapseLogicalShiftCandidates()
→ filterTargetPaymentCandidates() → rankPaymentAllocationCandidate()
→ resolvePaymentAllocationTargetChoices() → buildChosenPaymentAllocationRow()
```

### Shift Report (/plantao)
```
parseTelegramShiftReportCommand() → getOperationalBoard()
→ buildTelegramShiftReport() → resolveInterventionShiftStatus() / resolveRegulationShiftStatus()
→ format confirmed / awaiting / waiting / disabled sections
```
