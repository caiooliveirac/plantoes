"use client";

import { motion } from "framer-motion";
import { Check, PencilLine } from "lucide-react";
import { PatternBadge } from "@/components/board/PatternBadge";
import { staggerChild, pulseAttention, tapFeedback } from "@/lib/board/motion";
import type { PendingDepartureConfirmation, TelegramLateDepartureReasonCode } from "@/services/board.service";

const REASON_SHORT: Record<TelegramLateDepartureReasonCode, string> = {
    occurrence: "OCORRÊNCIA",
    hygienization: "HIGIENIZAÇÃO",
    chief_release: "CHEFIA",
    handoff: "RENDIÇÃO",
};

function formatHourMinute(iso: string) {
    const date = new Date(iso);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDayHourMinute(iso: string) {
    const date = new Date(iso);
    return date.toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function formatDelay(minutes: number | null) {
    if (minutes === null) return null;
    if (minutes === 0) return { label: "no horário", className: "zero" as const };
    const sign = minutes > 0 ? "+" : "−";
    const magnitude = Math.abs(minutes);
    const hours = Math.floor(magnitude / 60);
    const mins = magnitude % 60;
    const time = hours > 0 ? `${hours}h${String(mins).padStart(2, "0")}` : `${mins}min`;
    return {
        label: `${sign}${time}`,
        className: magnitude >= 60 ? "suspect" as const : "" as const,
    };
}

export interface PendingDepartureCardProps {
    pending: PendingDepartureConfirmation;
    onOpenVerifier: (pending: PendingDepartureConfirmation) => void;
    onQuickConfirm: (pending: PendingDepartureConfirmation) => Promise<void> | void;
    /** Pulses (attention loop) for items that arrived after first render. */
    isFresh?: boolean;
    busy?: boolean;
}

export function PendingDepartureCard({ pending, onOpenVerifier, onQuickConfirm, isFresh, busy }: PendingDepartureCardProps) {
    const delay = formatDelay(pending.delayMinutes);
    const suspect = (pending.delayMinutes ?? 0) >= 60 || pending.reasonOccurrenceCount30d >= 3;

    return (
        <motion.li
            layoutId={`pending-${pending.occupancyId}`}
            variants={staggerChild}
            initial="initial"
            animate={isFresh ? { ...pulseAttention, opacity: 1, y: 0, scale: 1 } : "animate"}
            exit={{ opacity: 0, x: 40, transition: { duration: 0.22 } }}
            className="pending-departure-card"
            data-suspect={suspect}
        >
            <button
                type="button"
                className="pending-departure-card__head"
                style={{ all: "unset", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, cursor: "pointer", width: "100%" }}
                onClick={() => onOpenVerifier(pending)}
                aria-label={`Auditar saída verbalizada de ${pending.displayName ?? pending.doctorName}`}
            >
                <div className="pending-departure-card__id">
                    <strong>{pending.displayName ?? pending.doctorName}</strong>
                    <span>{pending.targetCode} · {pending.shiftLabel ?? "—"} · saiu {formatHourMinute(pending.actualEndedAt)}</span>
                </div>
                {delay && (
                    <span className={`pending-departure-card__delay ${delay.className}`}>{delay.label}</span>
                )}
            </button>

            <div className="pending-departure-card__meta">
                {pending.reasonCode && (
                    <span className="pending-departure-card__reason">
                        {REASON_SHORT[pending.reasonCode]}
                        {pending.reasonCode === "occurrence" && pending.occurrenceNumber ? ` Nº ${pending.occurrenceNumber}` : ""}
                    </span>
                )}
                {pending.occurrenceNumberMissing && (
                    <span className="pending-departure-card__reason-warn" title="O médico alegou ocorrência mas não informou o número (4 dígitos).">
                        SEM Nº DE OCORRÊNCIA
                    </span>
                )}
                <PatternBadge count={pending.reasonOccurrenceCount30d} reasonCode={pending.reasonCode} />
            </div>

            {pending.sourceMessage ? (
                <figure className="pending-departure-card__source">
                    <figcaption className="pending-departure-card__source-meta">
                        Telegram · {formatDayHourMinute(pending.sourceMessage.createdAt)}
                    </figcaption>
                    <blockquote className="pending-departure-card__source-text">
                        “{pending.sourceMessage.rawText.trim()}”
                    </blockquote>
                </figure>
            ) : (
                <p className="pending-departure-card__source pending-departure-card__source--empty">
                    Sem mensagem de Telegram vinculada a esta saída.
                </p>
            )}

            <div className="pending-departure-card__actions">
                <motion.button
                    type="button"
                    className="pending-departure-card__btn primary"
                    onClick={(event) => { event.stopPropagation(); void onQuickConfirm(pending); }}
                    whileTap={tapFeedback}
                    disabled={busy}
                    aria-label={`Confirmar saída às ${formatHourMinute(pending.actualEndedAt)}`}
                >
                    <Check size={14} strokeWidth={2.6} style={{ marginRight: 6, verticalAlign: "-2px" }} />
                    Confirmar {formatHourMinute(pending.actualEndedAt)}
                </motion.button>
                <motion.button
                    type="button"
                    className="pending-departure-card__btn"
                    onClick={(event) => { event.stopPropagation(); onOpenVerifier(pending); }}
                    whileTap={tapFeedback}
                    disabled={busy}
                    aria-label="Abrir verificador para editar horário"
                >
                    <PencilLine size={14} strokeWidth={2.4} style={{ marginRight: 6, verticalAlign: "-2px" }} />
                    Editar
                </motion.button>
            </div>
        </motion.li>
    );
}
