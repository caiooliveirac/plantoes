"use client";

import type { PendingDepartureConfirmation } from "@/services/board.service";

type EventKind = "schedule" | "bot" | "chief";

interface TimelineEvent {
    ms: number;
    kind: EventKind;
    text: string;
}

function formatLocalHourMinute(ms: number) {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Builds a timeline of events correlated with the pending occupancy, sorted
 * descending (most recent first — chefe reads top-down to spot anomalies).
 *
 *   - schedule: scheduled start / end of the paid window
 *   - bot: verbalized arrival, messages from the bot ingest, verbalized departure
 *   - chief: any user-driven action (placeholder; expand when auditLogs are wired)
 */
export function EventTimeline({ pending }: { pending: PendingDepartureConfirmation }) {
    const events: TimelineEvent[] = [];

    if (pending.scheduledStartAt) {
        events.push({
            ms: new Date(pending.scheduledStartAt).getTime(),
            kind: "schedule",
            text: "Início da janela paga",
        });
    }
    events.push({
        ms: new Date(pending.startedAt).getTime(),
        kind: "bot",
        text: "Chegada registrada (operacional)",
    });
    if (pending.scheduledEndAt) {
        events.push({
            ms: new Date(pending.scheduledEndAt).getTime(),
            kind: "schedule",
            text: "Fim da janela paga",
        });
    }
    for (const message of pending.recentMessages) {
        events.push({
            ms: new Date(message.createdAt).getTime(),
            kind: "bot",
            text: `Mensagem (${message.parsedAction ?? "—"}): "${message.rawText.trim()}"`,
        });
    }
    events.push({
        ms: new Date(pending.actualEndedAt).getTime(),
        kind: "bot",
        text: "Saída verbalizada (actualEndedAt)",
    });

    events.sort((a, b) => b.ms - a.ms);

    return (
        <div className="departure-verifier-event-timeline" role="list">
            {events.map((event, index) => (
                <div key={`${event.ms}-${index}`} className="departure-verifier-event" data-kind={event.kind} role="listitem">
                    <span className="departure-verifier-event__time">{formatLocalHourMinute(event.ms)}</span>
                    <span className="departure-verifier-event__text">{event.text}</span>
                </div>
            ))}
        </div>
    );
}
