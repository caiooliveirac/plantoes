"use client";

import { useMemo, useState } from "react";

interface InterventionLateArrivalPanelProps {
    occupancyId: string;
    baseCode: string;
    doctorLabel: string;
    shiftLabel: string | null;
    startedAt: string | null;
    lateArrivalAcknowledgedAt: string | null;
    lateArrivalAcknowledgedNote: string | null;
    onSuccess: () => void;
}

const CUTOFF_HOUR = 9;
const PAY_START_HOUR = 13;

function bahiaHourOf(value: string | null): number {
    if (!value) return -1;
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Bahia",
        hour: "2-digit",
        hour12: false,
    }).formatToParts(new Date(value));
    const hour = parts.find((p) => p.type === "hour")?.value ?? "-1";
    return Number(hour);
}

function carryoverMinutesFrom(startedAt: string | null): number {
    if (!startedAt) return 0;
    const date = new Date(startedAt);
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Bahia",
        hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(date);
    const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const minutesSinceMidnight = hh * 60 + mm;
    return Math.max(0, PAY_START_HOUR * 60 - minutesSinceMidnight);
}

function formatCarryover(minutes: number): string {
    if (minutes <= 0) return "sem carryover";
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) return `${m} min`;
    if (m === 0) return h === 1 ? "1 hora" : `${h} horas`;
    return `${h}h${String(m).padStart(2, "0")}min`;
}

function formatLocalTime(value: string | null): string {
    if (!value) return "—";
    return new Date(value).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bahia" });
}

export function InterventionLateArrivalPanel(props: InterventionLateArrivalPanelProps) {
    const [note, setNote] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);

    const arrivedHour = useMemo(() => bahiaHourOf(props.startedAt), [props.startedAt]);
    const carryoverMinutes = useMemo(() => carryoverMinutesFrom(props.startedAt), [props.startedAt]);
    const isAcknowledged = Boolean(props.lateArrivalAcknowledgedAt);
    // Janela diurna: 9h–18h Bahia. Apos 18h provavelmente e SN/P e a regra nao se aplica.
    const isEligible = arrivedHour >= CUTOFF_HOUR && arrivedHour < 18;

    async function patchAcknowledgement(action: "acknowledge" | "revert") {
        setIsSubmitting(true);
        setFeedback(null);
        try {
            const response = await fetch(`/api/intervention/occupancies/${props.occupancyId}/acknowledge-late-arrival`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    acknowledged: action === "acknowledge",
                    note: action === "acknowledge" ? (note.trim() || null) : null,
                }),
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data?.error ?? "Falha ao atualizar reconhecimento.");
            }
            setFeedback({
                kind: "success",
                message: action === "acknowledge"
                    ? "Reconhecido como meio plantao por atraso — carryover creditado no banco e aviso publicado nos grupos."
                    : "Reconhecimento revertido — pagamento e debito voltam ao calculo normal.",
            });
            setNote("");
            props.onSuccess();
        } catch (error) {
            setFeedback({
                kind: "error",
                message: error instanceof Error ? error.message : "Falha ao atualizar reconhecimento.",
            });
        } finally {
            setIsSubmitting(false);
        }
    }

    if (isAcknowledged) {
        return (
            <section className="chief-drawer-section">
                <div
                    className="chief-verification-strip"
                    style={{
                        background: "linear-gradient(135deg, #fef3c7, #fde68a)",
                        borderLeft: "4px solid #f59e0b",
                    }}
                >
                    <div>
                        <p className="ops-column-kicker">⚠️ MEIO PLANTAO RECONHECIDO POR ATRASO</p>
                        <strong>{props.doctorLabel} em {props.baseCode} — pagamento 13:00–19:00.</strong>
                        <span style={{ display: "block", marginTop: 4 }}>
                            Chegada efetiva {formatLocalTime(props.startedAt)} · carryover banco: {formatCarryover(carryoverMinutes)}
                        </span>
                        <span style={{ display: "block", marginTop: 4 }}>
                            Reconhecido em {formatLocalTime(props.lateArrivalAcknowledgedAt)}.
                        </span>
                        {props.lateArrivalAcknowledgedNote && (
                            <span style={{ display: "block", marginTop: 4, fontStyle: "italic", opacity: 0.8 }}>
                                Motivo: {props.lateArrivalAcknowledgedNote}
                            </span>
                        )}
                    </div>
                    <div className="chief-action-grid" style={{ marginTop: 12 }}>
                        <button
                            type="button"
                            className="chief-action-button danger"
                            onClick={() => patchAcknowledgement("revert")}
                            disabled={isSubmitting}
                        >
                            {isSubmitting ? "Revertendo..." : "Reverter reconhecimento"}
                        </button>
                    </div>
                    {feedback && (
                        <div className={`chief-flash ${feedback.kind}`} style={{ marginTop: 8 }}>
                            {feedback.message}
                        </div>
                    )}
                </div>
            </section>
        );
    }

    if (!isEligible) {
        return null;
    }

    return (
        <section className="chief-drawer-section">
            <div
                className="chief-verification-strip"
                style={{
                    background: "linear-gradient(135deg, #fef3c7, #fde68a)",
                    borderLeft: "4px solid #f59e0b",
                }}
            >
                <div>
                    <p className="ops-column-kicker">Chegada apos 9h detectada</p>
                    <strong>{props.doctorLabel} chegou em {props.baseCode} as {formatLocalTime(props.startedAt)}.</strong>
                    <span style={{ display: "block", marginTop: 4 }}>
                        Pela regra da coordenacao, plantoes SD com chegada apos as 9h sao reconhecidos como <strong>MEIO PLANTAO</strong> (paga 13–19).
                    </span>
                    <span style={{ display: "block", marginTop: 4 }}>
                        Carryover estimado para o banco: <strong>{formatCarryover(carryoverMinutes)}</strong>.
                    </span>
                </div>
                <label className="chief-field full-width">
                    <span>Observacao (opcional)</span>
                    <textarea
                        className="chief-input chief-textarea compact"
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="Ex.: titular comunicou ausencia, troca acertada com chefia, etc."
                        maxLength={500}
                    />
                </label>
                <div className="chief-action-grid">
                    <button
                        type="button"
                        className="chief-action-button primary"
                        onClick={() => patchAcknowledgement("acknowledge")}
                        disabled={isSubmitting}
                    >
                        {isSubmitting ? "Reconhecendo..." : "Reconhecer como MEIO PLANTAO por atraso"}
                    </button>
                </div>
                {feedback && (
                    <div className={`chief-flash ${feedback.kind}`} style={{ marginTop: 8 }}>
                        {feedback.message}
                    </div>
                )}
            </div>
        </section>
    );
}
