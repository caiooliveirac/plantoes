# ADR-003: Telegram Message Processing Order

## Status
Accepted

## Context
The Telegram bot receives messages from group chats where multiple TARMs/chiefs
post arrival/departure information. Messages can arrive out of order, and users
may reply to pending prompts with new operational messages instead.

## Decision
The processing pipeline follows this priority order:

1. **Pending state resolution first**: Check if the sender has a pending
   `name_selection`, `departure_justification`, or `departure_correction`.
   If so, try to resolve it with the new message.

2. **Defer check**: If the reply text looks like a fresh operational message
   (contains base codes, times, or operational keywords), defer the pending
   state and process as a new message instead. This prevents operational
   data loss when users don't realize they're "replying" to a prompt.

3. **Command processing**: Handle explicit commands (`/plantao`, `/corrigir`, etc.)

4. **Free-text parsing**: Parse the message as an arrival/departure/continuation.

5. **Meal break routing**: If the message matches meal break patterns, route
   to the meal break handler.

## Consequences
- `shouldDefer*ToFreshParsing()` functions are critical safety valves
- Pending states can be superseded by new messages from the same sender
- Each message gets exactly one final status (never processed twice)
- The `telegramIngestedMessages` table serves as both audit log and state machine
