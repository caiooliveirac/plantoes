"use client";

import { AlertOctagon, Repeat } from "lucide-react";
import type { TelegramLateDepartureReasonCode } from "@/services/board.service";

const REASON_LABEL: Record<TelegramLateDepartureReasonCode, string> = {
    occurrence: "OCORRÊNCIA",
    hygienization: "HIGIENIZAÇÃO",
    chief_release: "LIBERAÇÃO CHEFIA",
    handoff: "RENDIÇÃO",
};

/**
 * Surfaces a recurring-reason signal (e.g., "4ª OCORRÊNCIA / 30d") so the chefe
 * spots fraud-suggestive patterns without opening the verifier.
 *
 * Visibility threshold: 3+ occurrences in 30d. Below that, recurrence is noise.
 */
export function PatternBadge({
    count,
    reasonCode,
}: {
    count: number;
    reasonCode: TelegramLateDepartureReasonCode | null;
}) {
    if (count < 3 || !reasonCode) {
        return null;
    }

    const ordinal = `${count}ª`;
    const label = `${ordinal} ${REASON_LABEL[reasonCode]} / 30d`;
    const Icon = count >= 5 ? AlertOctagon : Repeat;

    return (
        <span className="pending-departure-card__pattern-badge" title={`Saídas com motivo ${REASON_LABEL[reasonCode]} nos últimos 30 dias por este médico.`}>
            <Icon size={12} strokeWidth={2.4} />
            {label}
        </span>
    );
}
