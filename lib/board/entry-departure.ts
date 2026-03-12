import type { PreviousOperationalEntry } from "@/services/board.service";

export interface EntryDeparture {
    /** Effective departure time to display: actual_ended_at when verbalized, ended_at as handoff fallback, null if open. */
    time: string | null;
    /**
     * True when the departure time comes from a handoff closure only — ended_at is set but
     * actual_ended_at is null because the doctor has not verbalized the departure yet.
     * The UI should visually distinguish this from a real reported departure.
     */
    isHandoffOnly: boolean;
}

export function resolveEntryDeparture(
    entry: Pick<PreviousOperationalEntry, "actualEndedAt" | "endedAt">,
): EntryDeparture {
    return {
        time: entry.actualEndedAt ?? entry.endedAt,
        isHandoffOnly: entry.actualEndedAt === null && entry.endedAt !== null,
    };
}
