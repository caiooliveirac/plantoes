# Telegram Module

Processes all Telegram bot interactions for the SAMU operational system.

## Architecture

```
webhook (api/telegram/route.ts)
  └─> service.ts::processTelegramUpdate()
        ├─> parser.ts        → text parsing (arrival/departure/continuation)
        ├─> commands.ts      → command detection (/plantao, /corrigir, etc.)
        ├─> name-resolution.ts → doctor name fuzzy matching
        ├─> departure-flow.ts → late departure reasons, correction candidates
        ├─> meal-breaks.ts   → multi-stage break scheduling
        ├─> replies.ts       → reply text generation
        └─> api.ts           → Telegram Bot API wrapper (sendMessage)
```

## Files

| File | Lines | Purpose | Test coverage |
|------|-------|---------|---------------|
| `service.ts` | ~5600 | Main processing pipeline (god module) | `telegram-commands.test.ts` |
| `meal-breaks.ts` | ~3700 | Meal break scheduling and stages | `telegram-meal-breaks.test.ts` |
| `departure-flow.ts` | ~360 | Late departure parsing, correction candidates | `telegram-commands.test.ts` |
| `parser.ts` | — | Message text → structured ParsedMessage | `telegram-commands.test.ts` |
| `name-resolution.ts` | — | Doctor name fuzzy matching (Levenshtein + phonetic) | `telegram-name-resolution.test.ts` |
| `commands.ts` | — | `/plantao`, `/corrigir`, `/pausar` detection | — |
| `admin-commands.ts` | — | `/medico` admin commands | — |
| `replies.ts` | — | Reply text templates | `telegram-commands.test.ts` |
| `reminders.ts` | — | Scheduled shift reminders | `telegram-reminders.test.ts` |
| `presentation-order.ts` | — | Operational chat ordering | `telegram-presentation-order.test.ts` |
| `config.ts` | — | Allowed chats, admin IDs | — |
| `api.ts` | — | Telegram Bot API HTTP wrapper | — |
| `contracts.ts` | — | Shared types/interfaces | — |

## Message Lifecycle

1. **Ingest**: Webhook → `telegramIngestedMessages` row (status: `processing`)
2. **Parse**: Text → `ParsedMessage` (sector, baseCode, doctorName, time, shift)
3. **Resolve**: Doctor name → `doctors.id` (exact match → fuzzy → pending selection)
4. **Apply**: Create/end/continue regulation or intervention occupancy
5. **Reply**: Send confirmation/error/prompt back to chat
6. **Status**: Row updated to `applied`, `pending_*`, `superseded`, `ignored`, or `error`

## Pending States

When the bot can't resolve a message immediately:

- `pending_name_selection` — multiple doctor candidates found, waiting for user to pick
- `pending_departure_justification` — departure after shift end, waiting for reason
- `pending_departure_correction` — `/corrigirsaida` found a candidate, waiting for corrected time

Each pending state can be **superseded** by a new message from the same sender.

## Critical Invariants

- Every message gets exactly one final status
- Continuations preserve original arrival time
- Departure corrections require justification if eventAt > scheduled shift end
- Batch processing (`/lote`) validates all lines before applying any
- Meal breaks enforce minimum coverage constraints before assigning slots
