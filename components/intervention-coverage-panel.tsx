"use client";

import { useMemo, useState } from "react";

interface InterventionCoveragePanelProps {
    occupancyId: string;
    baseCode: string;
    doctorLabel: string;
    scheduledStartAt: string | null;
    startedAt: string | null;
    coverageKind: string | null;
    coverageNote: string | null;
    coverageMarkedAt: string | null;
    onSuccess: () => void;
}

function diffMinutes(scheduled: string | null, started: string | null): number {
    if (!scheduled || !started) return 0;
    const ms = new Date(started).getTime() - new Date(scheduled).getTime();
    return Math.max(0, Math.trunc(ms / 60000));
}

function formatDelay(minutes: number): string {
    if (minutes <= 0) return "sem atraso";
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

export function InterventionCoveragePanel(props: InterventionCoveragePanelProps) {
    const [note, setNote] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);

    const delayMinutes = useMemo(
        () => diffMinutes(props.scheduledStartAt, props.startedAt),
        [props.scheduledStartAt, props.startedAt],
    );
    const isCoverage = Boolean(props.coverageKind);
    const showCoverageSuggestion = !isCoverage && delayMinutes >= 120;

    async function patchCoverage(coverageKind: "COBERTURA" | null) {
        setIsSubmitting(true);
        setFeedback(null);
        try {
            const response = await fetch(`/api/intervention/occupancies/${props.occupancyId}/coverage`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    coverageKind,
                    note: coverageKind === "COBERTURA" ? (note.trim() || null) : null,
                }),
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data?.error ?? "Falha ao atualizar cobertura.");
            }
            setFeedback({
                kind: "success",
                message: coverageKind === "COBERTURA"
                    ? "Marcado como COBERTURA — atraso nao sera debitado do banco. Aviso publicado nos grupos."
                    : "Cobertura removida — o atraso volta a contar normalmente no banco.",
            });
            setNote("");
            props.onSuccess();
        } catch (error) {
            setFeedback({
                kind: "error",
                message: error instanceof Error ? error.message : "Falha ao atualizar cobertura.",
            });
        } finally {
            setIsSubmitting(false);
        }
    }

    if (isCoverage) {
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
                        <p className="ops-column-kicker">⚠️ COBERTURA registrada</p>
                        <strong>Atraso de {formatDelay(delayMinutes)} NAO sera descontado do banco de horas.</strong>
                        <span style={{ display: "block", marginTop: 4 }}>
                            {props.doctorLabel} em {props.baseCode}. Marcada em {formatLocalTime(props.coverageMarkedAt)}.
                        </span>
                        {props.coverageNote && (
                            <span style={{ display: "block", marginTop: 4, fontStyle: "italic", opacity: 0.8 }}>
                                Motivo: {props.coverageNote}
                            </span>
                        )}
                    </div>
                    <div className="chief-action-grid" style={{ marginTop: 12 }}>
                        <button
                            type="button"
                            className="chief-action-button danger"
                            onClick={() => patchCoverage(null)}
                            disabled={isSubmitting}
                        >
                            {isSubmitting ? "Removendo..." : "Remover marcacao de cobertura"}
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

    if (!showCoverageSuggestion) {
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
                    <p className="ops-column-kicker">Atraso longo detectado</p>
                    <strong>{props.doctorLabel} chegou em {props.baseCode} com {formatDelay(delayMinutes)} de atraso.</strong>
                    <span style={{ display: "block", marginTop: 4 }}>
                        Escala prevista: {formatLocalTime(props.scheduledStartAt)} · chegada: {formatLocalTime(props.startedAt)}.
                    </span>
                </div>
                <p className="chief-bank-hours-copy" style={{ marginTop: 12 }}>
                    Se este plantao for uma <strong>COBERTURA</strong> (titular nao pode estar), marque abaixo — o atraso fica registrado no historico mas <strong>NAO</strong> sera debitado do banco de horas.
                </p>
                <label className="chief-field full-width">
                    <span>Motivo da cobertura (opcional)</span>
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
                        onClick={() => patchCoverage("COBERTURA")}
                        disabled={isSubmitting}
                    >
                        {isSubmitting ? "Marcando..." : "Marcar como COBERTURA"}
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
