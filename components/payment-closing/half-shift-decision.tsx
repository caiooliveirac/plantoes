"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { calculateBankHours } from "@/modules/bank-hours/calculator";
import { classifyEarlyDeparture } from "@/modules/operational/early-departure";
import { isValidOverrideNote, OVERRIDE_NOTE_MIN_LENGTH } from "@/modules/operational/departure-triage";
import type { PayableShift } from "@/modules/reporting/payable-shifts";

/**
 * Botão do fechamento de pagamento que converte um plantão INTEIRO em MEIO (ou
 * o contrário) direto no modal do médico. Abre um mini-modal com os horários de
 * chegada/saída considerados (editáveis), o efeito ATUAL no banco de horas e o
 * que passa a valer após a decisão — o botão de confirmar diz o saldo exato.
 *
 * Grava via POST /api/{domain}/occupancies/{id}/confirm-departure com o
 * `outcome` explícito; o servidor valida a faixa e exige justificativa quando a
 * decisão desvia da régua (modules/operational/early-departure.ts).
 */

function toTimeValue(iso: string) {
    const date = new Date(iso);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function combineWithLocalDate(baseIso: string, timeValue: string): Date | null {
    const match = /^(\d{2}):(\d{2})$/.exec(timeValue);
    if (!match) return null;
    const combined = new Date(baseIso);
    combined.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return combined;
}

function formatSignedMinutes(minutes: number) {
    const sign = minutes >= 0 ? "+" : "−";
    const magnitude = Math.abs(minutes);
    const hours = Math.floor(magnitude / 60);
    const rest = magnitude % 60;
    const body = hours > 0 ? (rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}`) : `${rest}min`;
    return `${sign}${body}`;
}

function formatHourMinute(date: Date) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function HalfShiftDecision({ shift }: { shift: PayableShift }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState("");

    // Modo: plantão inteiro ganha "PAGAR SÓ MEIO PLANTÃO"; plantão já convertido
    // (MEIO ou só-banco) ganha o caminho de volta para INTEIRO.
    const mode: "to_half" | "to_full" = shift.earlyDepartureOutcome ? "to_full" : "to_half";

    const baseStartIso = shift.startedAt;
    const baseEndIso = shift.actualEndedAt ?? shift.endedAt ?? shift.slotEndedAt;
    const [startTime, setStartTime] = useState(() => toTimeValue(baseStartIso));
    const [endTime, setEndTime] = useState(() => toTimeValue(baseEndIso));

    const preview = useMemo(() => {
        if (!shift.scheduledStartAt || !shift.scheduledEndAt) return null;
        const start = combineWithLocalDate(baseStartIso, startTime);
        let end = combineWithLocalDate(baseEndIso, endTime);
        if (!start || !end) return null;
        if (end.getTime() < start.getTime()) {
            end = new Date(end.getTime() + 24 * 3600000);
        }
        let standard: ReturnType<typeof calculateBankHours>;
        try {
            standard = calculateBankHours({
                scheduledStartAt: shift.scheduledStartAt,
                scheduledEndAt: shift.scheduledEndAt,
                actualStartAt: start,
                actualEndAt: end,
            });
        } catch {
            return null;
        }
        const classification = classifyEarlyDeparture({
            departureAt: end,
            scheduledStartAt: shift.scheduledStartAt,
            scheduledEndAt: shift.scheduledEndAt,
            startedAt: start,
        });
        const halfCredit = Math.max(0, classification.workedMinutes - 6 * 60);
        const targetOutcome = mode === "to_half" ? "half_shift" as const : "full_shift" as const;
        // Mesma regra do servidor: desviar da régua exige nota, exceto pagar
        // inteiro na faixa de MEIO.
        const noteRequired = targetOutcome !== classification.outcome
            && !(classification.outcome === "half_shift" && targetOutcome === "full_shift");
        // Saída no fim da janela (ou depois) não tem régua — nada a converter.
        const notEarly = classification.outcome === "full_shift" && classification.remainingMinutes === 0;
        return { start, end, standard, classification, halfCredit, noteRequired, notEarly };
    }, [shift, baseStartIso, baseEndIso, startTime, endTime, mode]);

    const currentLabel = shift.earlyDepartureOutcome === "half_shift"
        ? "MEIO plantão"
        : shift.earlyDepartureOutcome === "bank_only"
            ? "só banco de horas (não assinado)"
            : "plantão INTEIRO";

    const confirm = async () => {
        if (!preview) return;
        setBusy(true);
        setError(null);
        try {
            const body: Record<string, unknown> = {
                outcome: mode === "to_half" ? "half_shift" : "full_shift",
            };
            if (preview.start.getTime() !== new Date(baseStartIso).getTime()) {
                body.startedAt = preview.start.toISOString();
            }
            if (shift.actualEndedAt === null || preview.end.getTime() !== new Date(baseEndIso).getTime()) {
                body.actualEndedAt = preview.end.toISOString();
            }
            if (note.trim()) {
                body.note = note.trim();
            }
            const response = await fetch(`/api/${shift.domain}/occupancies/${shift.occupancyId}/confirm-departure`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const payload = await response.json().catch(() => ({})) as { error?: string };
                throw new Error(payload.error || "Falha ao aplicar a decisão de pagamento.");
            }
            setOpen(false);
            router.refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Falha ao aplicar a decisão de pagamento.");
        } finally {
            setBusy(false);
        }
    };

    const confirmDisabled = busy
        || !preview
        || preview.notEarly
        || (preview.noteRequired && !isValidOverrideNote(note));

    return (
        <>
            <button
                type="button"
                className="half-shift-decision-trigger"
                onClick={() => { setOpen(true); setError(null); setNote(""); }}
                title={mode === "to_half" ? "Pagar só MEIO plantão" : "Pagar plantão inteiro"}
                aria-label={mode === "to_half" ? "Pagar só MEIO plantão" : "Pagar plantão inteiro"}
            >
                {mode === "to_half" ? "½ MEIO" : "INTEIRO"}
            </button>

            {open ? (
                <div className="half-shift-decision-backdrop" role="dialog" aria-modal="true" onClick={() => { if (!busy) setOpen(false); }}>
                    <div className="half-shift-decision-panel" onClick={(event) => event.stopPropagation()}>
                        <header>
                            <strong>{mode === "to_half" ? "Pagar só MEIO plantão" : "Pagar plantão inteiro"}</strong>
                            <span>{shift.targetCode} · {shift.shiftLabel} · {shift.operationalDate}</span>
                        </header>

                        <div className="half-shift-decision-times">
                            <label>
                                Chegou às
                                <input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} />
                            </label>
                            <label>
                                Saiu às
                                <input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} />
                            </label>
                        </div>

                        {preview ? (
                            preview.notEarly ? (
                                <p className="half-shift-decision-before">
                                    Com esses horários a saída não é antecipada (no fim da janela ou depois) — não há conversão de pagamento a fazer.
                                </p>
                            ) : (
                                <>
                                    <p className="half-shift-decision-before">
                                        Hoje: {currentLabel}, com {formatSignedMinutes(preview.standard.balanceMinutes)} no banco de horas
                                        {preview.standard.arrivalDelayMinutes > 0
                                            ? ` por ter chegado às ${formatHourMinute(preview.start)}`
                                            : ""}.
                                    </p>
                                    {preview.noteRequired ? (
                                        <label className="half-shift-decision-note">
                                            Justificativa (mínimo {OVERRIDE_NOTE_MIN_LENGTH} caracteres — a decisão desvia da régua)
                                            <textarea
                                                rows={2}
                                                value={note}
                                                onChange={(event) => setNote(event.target.value)}
                                                placeholder="Vai para a folha do médico e para a auditoria."
                                            />
                                        </label>
                                    ) : null}
                                    {error ? <p className="half-shift-decision-error">{error}</p> : null}
                                    <div className="half-shift-decision-actions">
                                        <button type="button" className="primary" onClick={() => { void confirm(); }} disabled={confirmDisabled}>
                                            {mode === "to_half"
                                                ? `Confirmar MEIO + saldo de ${formatSignedMinutes(preview.halfCredit)} para o banco de horas`
                                                : `Confirmar INTEIRO (banco volta à regra normal: ${formatSignedMinutes(preview.standard.balanceMinutes)})`}
                                        </button>
                                        <button type="button" onClick={() => setOpen(false)} disabled={busy}>Cancelar</button>
                                    </div>
                                </>
                            )
                        ) : (
                            <p className="half-shift-decision-before">Sem janela agendada nesta ocupação — não dá para calcular a conversão aqui.</p>
                        )}
                    </div>
                </div>
            ) : null}
        </>
    );
}
