"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { EventTimeline } from "@/components/board/EventTimeline";
import { modalBackdrop, modalPanel, tapFeedback } from "@/lib/board/motion";
import type { PendingDepartureConfirmation } from "@/services/board.service";
import { calculateBankHours } from "@/modules/bank-hours/calculator";
import {
    isValidOverrideNote,
    OVERRIDE_NOTE_MIN_LENGTH,
    triagePendingDeparture,
} from "@/modules/operational/departure-triage";

export interface DepartureVerifierProps {
    target: PendingDepartureConfirmation | null;
    onClose: () => void;
}

function formatLocalHourMinute(ms: number) {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function toTimeInputValue(iso: string) {
    const date = new Date(iso);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Recombina "HH:MM" digitado com a data local do horário original. */
function combineWithLocalDate(baseIso: string, timeValue: string): Date | null {
    const match = /^(\d{2}):(\d{2})$/.exec(timeValue);
    if (!match) return null;
    const base = new Date(baseIso);
    const combined = new Date(base);
    combined.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return combined;
}

function formatSignedMinutes(minutes: number) {
    const sign = minutes >= 0 ? "+" : "−";
    const magnitude = Math.abs(minutes);
    const hours = Math.floor(magnitude / 60);
    const rest = magnitude % 60;
    const body = hours > 0 ? `${hours}h${String(rest).padStart(2, "0")}` : `${rest}min`;
    return `${sign}${body}`;
}

function formatMinutesShort(minutes: number) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) return `${rest}min`;
    return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}`;
}

type DecisionAction =
    | { kind: "confirm" }
    | { kind: "outcome"; outcome: "bank_only" | "half_shift" | "full_shift"; requiresNote: boolean }
    | { kind: "reject_credit" };

interface DecisionButton {
    label: string;
    hint: string;
    className: "confirm" | "edit" | "reject";
    action: DecisionAction;
}

/**
 * O verificador de saídas. Mostra POR QUE o caso pede decisão (frase da
 * triagem) e oferece só os botões que fazem sentido para aquele caso:
 *
 *   - faixa MEIO (6h–10h de janela): pagar inteiro ou pagar MEIO;
 *   - saída <6h: lançar só no banco, ou pagar MEIO/INTEIRO com justificativa
 *     escrita (mínimo de 8 caracteres — espaços contam);
 *   - saída tardia: confirmar o crédito, recusar (com justificativa) ou
 *     ajustar chegada/saída num formulário simples de dois horários;
 *   - rotina: confirmar e pronto.
 */
export function DepartureVerifier({ target, onClose }: DepartureVerifierProps) {
    const router = useRouter();
    const [, startTransition] = useTransition();
    const open = target !== null;

    const verbalizedMs = useMemo(
        () => (target ? new Date(target.actualEndedAt).getTime() : 0),
        [target],
    );
    const scheduledEndMs = useMemo(
        () => (target?.scheduledEndAt ? new Date(target.scheduledEndAt).getTime() : null),
        [target],
    );

    const [submitting, setSubmitting] = useState(false);
    const [view, setView] = useState<"decide" | "adjust">("decide");
    // Ação escolhida que exige justificativa — o textarea aparece e o envio
    // fica travado até a nota ter 8+ caracteres.
    const [pendingAction, setPendingAction] = useState<DecisionAction | null>(null);
    const [noteText, setNoteText] = useState("");
    const [adjustStart, setAdjustStart] = useState("");
    const [adjustEnd, setAdjustEnd] = useState("");

    useEffect(() => {
        if (target) {
            setView("decide");
            setPendingAction(null);
            setNoteText("");
            setAdjustStart(toTimeInputValue(target.startedAt));
            setAdjustEnd(toTimeInputValue(target.actualEndedAt));
        }
    }, [target]);

    const triage = useMemo(
        () => (target
            ? triagePendingDeparture({
                actualEndedAt: target.actualEndedAt,
                scheduledStartAt: target.scheduledStartAt,
                scheduledEndAt: target.scheduledEndAt,
                startedAt: target.startedAt,
                roleLabel: target.roleLabel,
                delayMinutes: target.delayMinutes,
                reasonCode: target.reasonCode,
                occurrenceNumberMissing: target.occurrenceNumberMissing,
                reasonOccurrenceCount30d: target.reasonOccurrenceCount30d,
            })
            : null),
        [target],
    );

    // Saldo padrão de banco (atraso vs excedente) para a saída verbalizada.
    // ponytail: usa a janela da própria ocupação; cadeias P longas podem divergir
    // do cálculo por grupo de continuidade do servidor — é um preview, o número
    // final é sempre o do banco de horas gravado.
    const standardBalance = useMemo(() => {
        if (!target?.scheduledStartAt || !target?.scheduledEndAt) return null;
        try {
            return calculateBankHours({
                scheduledStartAt: target.scheduledStartAt,
                scheduledEndAt: target.scheduledEndAt,
                actualStartAt: target.startedAt,
                actualEndAt: target.actualEndedAt,
            });
        } catch {
            return null;
        }
    }, [target]);

    const adjustPreview = useMemo(() => {
        if (view !== "adjust" || !target?.scheduledStartAt || !target?.scheduledEndAt) return null;
        const start = combineWithLocalDate(target.startedAt, adjustStart);
        let end = combineWithLocalDate(target.actualEndedAt, adjustEnd);
        if (!start || !end) return null;
        // Saída digitada "antes" da chegada no mesmo dia = virada de meia-noite.
        if (end.getTime() < start.getTime()) {
            end = new Date(end.getTime() + 24 * 3600000);
        }
        try {
            return {
                start,
                end,
                calc: calculateBankHours({
                    scheduledStartAt: target.scheduledStartAt,
                    scheduledEndAt: target.scheduledEndAt,
                    actualStartAt: start,
                    actualEndAt: end,
                }),
            };
        } catch {
            return null;
        }
    }, [view, target, adjustStart, adjustEnd]);

    const submit = async (body: {
        actualEndedAt?: string;
        startedAt?: string;
        note?: string | null;
        outcome?: "bank_only" | "half_shift" | "full_shift";
    }, successLabel: string) => {
        if (!target) return;
        setSubmitting(true);
        try {
            const response = await fetch(`/api/${target.domain}/occupancies/${target.occupancyId}/confirm-departure`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const payload = await response.json().catch(() => ({})) as { error?: string };
                throw new Error(payload.error || "Falha ao confirmar saída.");
            }
            toast.success(`${target.displayName ?? target.doctorName}: ${successLabel}`);
            onClose();
            startTransition(() => {
                router.refresh();
            });
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Falha ao confirmar saída.");
        } finally {
            setSubmitting(false);
        }
    };

    const runAction = async (action: DecisionAction, note: string | null) => {
        if (!target) return;
        if (action.kind === "confirm") {
            await submit({ note }, `saída confirmada às ${formatLocalHourMinute(verbalizedMs)}.`);
            return;
        }
        if (action.kind === "reject_credit") {
            if (scheduledEndMs === null) {
                toast.error("Esta ocupação não tem fim de janela definido para registrar a recusa.");
                return;
            }
            await submit({
                actualEndedAt: new Date(scheduledEndMs).toISOString(),
                note: note ?? "Crédito de banco recusado pelo chefe — paga até o fim da janela.",
            }, "crédito recusado — saída registrada no fim da janela.");
            return;
        }
        const label = action.outcome === "bank_only"
            ? "lançado só no banco de horas (plantão não assinado)."
            : action.outcome === "half_shift"
                ? "MEIO plantão assinado — excedente de 6h vira banco."
                : "plantão INTEIRO assinado.";
        await submit({ outcome: action.outcome, note }, label);
    };

    const handleDecision = (button: DecisionButton) => {
        const requiresNote = button.action.kind === "reject_credit"
            || (button.action.kind === "outcome" && button.action.requiresNote);
        if (requiresNote) {
            setPendingAction(button.action);
            setNoteText("");
            return;
        }
        void runAction(button.action, null);
    };

    const buttons = useMemo<DecisionButton[]>(() => {
        if (!target || !triage) return [];
        const confirmLabel = `Confirmar saída ${formatLocalHourMinute(verbalizedMs)}`;

        if (triage.kind === "early_half") {
            return [
                {
                    label: "Pagar plantão inteiro",
                    hint: "Atraso e saída antecipada contam no banco de horas como sempre.",
                    className: "confirm",
                    action: { kind: "outcome", outcome: "full_shift", requiresNote: false },
                },
                {
                    label: "Pagar MEIO plantão",
                    hint: `Assina MEIO (0,5x). O que passar de 6h trabalhadas vira crédito`
                        + `${triage.classification && triage.classification.bankCreditMinutes > 0
                            ? ` (${formatMinutesShort(triage.classification.bankCreditMinutes)})`
                            : ""} — sem punição pelo atraso.`,
                    className: "edit",
                    action: { kind: "outcome", outcome: "half_shift", requiresNote: false },
                },
            ];
        }

        if (triage.kind === "short_anomaly") {
            // Anomalia: nada de botão de pagamento. Confirmar aqui seria validar
            // um registro provavelmente errado — o caminho é ajustar os horários
            // (ou tratar no /corrigir), e só confirmar se a saída for real mesmo.
            return [
                {
                    label: confirmLabel,
                    hint: "Só confirme se essa saída de poucos minutos foi real. Se foi conflito de posto ou erro, use o ajuste de horários ou o /corrigir.",
                    className: "reject",
                    action: { kind: "confirm" },
                },
            ];
        }

        if (triage.kind === "early_full") {
            const worked = triage.classification?.workedMinutes ?? 0;
            return [
                {
                    label: "Pagar plantão inteiro",
                    hint: "Assina inteiro; atraso e saída antecipada contam no banco de horas como sempre.",
                    className: "confirm",
                    action: { kind: "outcome", outcome: "full_shift", requiresNote: false },
                },
                {
                    label: "Pagar MEIO plantão",
                    hint: `Assina MEIO (0,5x); o que passar de 6h trabalhadas vira crédito`
                        + `${worked > 360 ? ` (${formatMinutesShort(worked - 360)})` : ""}.`
                        + ` Paga menos que a régua — exige justificativa de ${OVERRIDE_NOTE_MIN_LENGTH}+ caracteres.`,
                    className: "edit",
                    action: { kind: "outcome", outcome: "half_shift", requiresNote: true },
                },
                {
                    label: "Lançar só para o banco de horas",
                    hint: `Não assina; as horas trabalhadas viram crédito${worked > 0 ? ` (${formatMinutesShort(worked)})` : ""}.`
                        + ` Exige justificativa de ${OVERRIDE_NOTE_MIN_LENGTH}+ caracteres.`,
                    className: "reject",
                    action: { kind: "outcome", outcome: "bank_only", requiresNote: true },
                },
            ];
        }

        if (triage.kind === "early_bank_only") {
            const credit = triage.classification?.bankCreditMinutes ?? 0;
            return [
                {
                    label: `Lançar só para o banco de horas (${formatMinutesShort(credit)})`,
                    hint: "Plantão não é assinado; as horas trabalhadas viram crédito.",
                    className: "confirm",
                    action: { kind: "outcome", outcome: "bank_only", requiresNote: false },
                },
                {
                    label: "Pagar MEIO plantão",
                    hint: `Acima da régua (fez menos de 6h) — exige justificativa de ${OVERRIDE_NOTE_MIN_LENGTH}+ caracteres.`,
                    className: "edit",
                    action: { kind: "outcome", outcome: "half_shift", requiresNote: true },
                },
                {
                    label: "Pagar plantão INTEIRO",
                    hint: `Acima da régua — exige justificativa de ${OVERRIDE_NOTE_MIN_LENGTH}+ caracteres.`,
                    className: "reject",
                    action: { kind: "outcome", outcome: "full_shift", requiresNote: true },
                },
            ];
        }

        if (triage.kind === "late_credit") {
            const balance = standardBalance?.balanceMinutes ?? null;
            return [
                {
                    label: balance !== null && balance > 0
                        ? `Confirmar os ${formatMinutesShort(balance)} de banco de horas`
                        : confirmLabel,
                    hint: standardBalance
                        ? standardBalance.explanation
                        : "Confirma a saída verbalizada como está.",
                    className: "confirm",
                    action: { kind: "confirm" },
                },
                {
                    label: "Recusar crédito para o banco de horas",
                    hint: `Paga até o fim da janela, sem crédito — exige justificativa de ${OVERRIDE_NOTE_MIN_LENGTH}+ caracteres.`,
                    className: "reject",
                    action: { kind: "reject_credit" },
                },
            ];
        }

        return [
            {
                label: confirmLabel,
                hint: triage.headline,
                className: "confirm",
                action: { kind: "confirm" },
            },
        ];
    }, [target, triage, verbalizedMs, standardBalance]);

    const canAdjust = Boolean(target?.scheduledStartAt && target?.scheduledEndAt);
    const noteValid = isValidOverrideNote(noteText);

    return (
        <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
            <AnimatePresence>
                {open && target && triage && (
                    <Dialog.Portal forceMount>
                        <Dialog.Overlay asChild>
                            <motion.div
                                className="departure-verifier-backdrop"
                                variants={modalBackdrop}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                            />
                        </Dialog.Overlay>
                        <Dialog.Content asChild>
                            <div className="departure-verifier-shell">
                                <motion.div
                                    layoutId={`pending-${target.occupancyId}`}
                                    className="departure-verifier-panel"
                                    variants={modalPanel}
                                    initial="initial"
                                    animate="animate"
                                    exit="exit"
                                >
                                    <header className="departure-verifier-header">
                                        <div className="departure-verifier-header__title">
                                            <Dialog.Title asChild>
                                                <strong>{target.displayName ?? target.doctorName}</strong>
                                            </Dialog.Title>
                                            <Dialog.Description asChild>
                                                <span>
                                                    {target.targetCode} · {target.shiftLabel ?? "—"}{target.roleLabel ? ` · ${target.roleLabel}` : ""}
                                                    {" · saída verbalizada "}{formatLocalHourMinute(verbalizedMs)}
                                                </span>
                                            </Dialog.Description>
                                        </div>
                                        <Dialog.Close asChild>
                                            <button type="button" className="departure-verifier-close" aria-label="Fechar verificador">Fechar (esc)</button>
                                        </Dialog.Close>
                                    </header>

                                    <div className="departure-verifier-body">
                                        <div className="departure-verifier-body__col">
                                            <p className="departure-verifier-headline">{triage.headline}</p>
                                            <div style={{ fontSize: "0.82rem", color: "var(--muted-strong)", display: "flex", flexDirection: "column", gap: 4 }}>
                                                {target.scheduledStartAt && target.scheduledEndAt && (
                                                    <span>Janela paga: {formatLocalHourMinute(new Date(target.scheduledStartAt).getTime())} — {formatLocalHourMinute(new Date(target.scheduledEndAt).getTime())}</span>
                                                )}
                                                <span>Chegada registrada: {formatLocalHourMinute(new Date(target.startedAt).getTime())}</span>
                                                {typeof target.delayMinutes === "number" && (
                                                    <span>Saída versus fim de janela: {target.delayMinutes > 0 ? "+" : ""}{target.delayMinutes}min</span>
                                                )}
                                            </div>

                                            {view === "decide" && (
                                                <div className="departure-verifier-decisions">
                                                    {buttons.map((button) => (
                                                        <div key={button.label} className="departure-verifier-decision">
                                                            <motion.button
                                                                type="button"
                                                                className={`departure-verifier-action ${button.className}`}
                                                                onClick={() => handleDecision(button)}
                                                                whileTap={tapFeedback}
                                                                disabled={submitting || pendingAction !== null}
                                                            >
                                                                {button.label}
                                                            </motion.button>
                                                            <span className="departure-verifier-decision__hint">{button.hint}</span>
                                                        </div>
                                                    ))}
                                                    {(triage.kind === "late_credit" || triage.kind === "routine" || triage.kind === "occurrence_missing" || triage.kind === "pattern" || triage.kind === "short_anomaly") && canAdjust && (
                                                        <div className="departure-verifier-decision">
                                                            <motion.button
                                                                type="button"
                                                                className="departure-verifier-action edit"
                                                                onClick={() => setView("adjust")}
                                                                whileTap={tapFeedback}
                                                                disabled={submitting || pendingAction !== null}
                                                            >
                                                                Ajustar o crédito no banco de horas
                                                            </motion.button>
                                                            <span className="departure-verifier-decision__hint">
                                                                Corrigir a hora de chegada e/ou de saída — o saldo é recalculado na tela.
                                                            </span>
                                                        </div>
                                                    )}
                                                </div>
                                            )}

                                            {view === "decide" && pendingAction !== null && (
                                                <div className="departure-verifier-note">
                                                    <label htmlFor="departure-verifier-note-input" style={{ fontSize: "0.82rem", fontWeight: 600 }}>
                                                        Justificativa (mínimo {OVERRIDE_NOTE_MIN_LENGTH} caracteres)
                                                    </label>
                                                    <textarea
                                                        id="departure-verifier-note-input"
                                                        value={noteText}
                                                        onChange={(event) => setNoteText(event.target.value)}
                                                        rows={3}
                                                        autoFocus
                                                        placeholder="Explique a decisão — vai para a folha do médico e para a auditoria."
                                                        style={{ width: "100%", resize: "vertical", fontSize: "0.85rem", padding: 8 }}
                                                    />
                                                    <div style={{ display: "flex", gap: 8 }}>
                                                        <motion.button
                                                            type="button"
                                                            className="departure-verifier-action confirm"
                                                            onClick={() => { void runAction(pendingAction, noteText.trim()); }}
                                                            whileTap={tapFeedback}
                                                            disabled={submitting || !noteValid}
                                                        >
                                                            Confirmar decisão
                                                        </motion.button>
                                                        <motion.button
                                                            type="button"
                                                            className="departure-verifier-action edit"
                                                            onClick={() => { setPendingAction(null); setNoteText(""); }}
                                                            whileTap={tapFeedback}
                                                            disabled={submitting}
                                                        >
                                                            Voltar
                                                        </motion.button>
                                                    </div>
                                                </div>
                                            )}

                                            {view === "adjust" && (
                                                <div className="departure-verifier-adjust">
                                                    <div style={{ display: "flex", gap: 16 }}>
                                                        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.82rem", fontWeight: 600 }}>
                                                            Chegou às
                                                            <input
                                                                type="time"
                                                                value={adjustStart}
                                                                onChange={(event) => setAdjustStart(event.target.value)}
                                                                style={{ fontSize: "1.05rem", padding: "6px 8px" }}
                                                            />
                                                        </label>
                                                        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.82rem", fontWeight: 600 }}>
                                                            Saiu às
                                                            <input
                                                                type="time"
                                                                value={adjustEnd}
                                                                onChange={(event) => setAdjustEnd(event.target.value)}
                                                                style={{ fontSize: "1.05rem", padding: "6px 8px" }}
                                                            />
                                                        </label>
                                                    </div>
                                                    <div className="departure-verifier-adjust__balance">
                                                        {adjustPreview ? (
                                                            <>
                                                                <strong style={{ fontSize: "1.6rem" }}>
                                                                    {formatSignedMinutes(adjustPreview.calc.balanceMinutes)}
                                                                </strong>
                                                                <span style={{ fontSize: "0.8rem", color: "var(--muted-strong)" }}>
                                                                    {adjustPreview.calc.explanation}
                                                                </span>
                                                            </>
                                                        ) : (
                                                            <span style={{ fontSize: "0.85rem" }}>Horários inválidos.</span>
                                                        )}
                                                    </div>
                                                    <div style={{ display: "flex", gap: 8 }}>
                                                        <motion.button
                                                            type="button"
                                                            className="departure-verifier-action confirm"
                                                            onClick={() => {
                                                                if (!adjustPreview) return;
                                                                void submit({
                                                                    startedAt: adjustPreview.start.toISOString(),
                                                                    actualEndedAt: adjustPreview.end.toISOString(),
                                                                    note: "Horários ajustados pelo chefe na confirmação da saída.",
                                                                }, `horários ajustados (${formatLocalHourMinute(adjustPreview.start.getTime())}–${formatLocalHourMinute(adjustPreview.end.getTime())}), saldo ${formatSignedMinutes(adjustPreview.calc.balanceMinutes)}.`);
                                                            }}
                                                            whileTap={tapFeedback}
                                                            disabled={submitting || !adjustPreview}
                                                        >
                                                            Confirmar ajuste
                                                        </motion.button>
                                                        <motion.button
                                                            type="button"
                                                            className="departure-verifier-action edit"
                                                            onClick={() => setView("decide")}
                                                            whileTap={tapFeedback}
                                                            disabled={submitting}
                                                        >
                                                            Voltar
                                                        </motion.button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>

                                        <div className="departure-verifier-body__col">
                                            <span className="departure-verifier-body__label">Eventos correlacionados</span>
                                            <EventTimeline pending={target} />
                                        </div>
                                    </div>
                                </motion.div>
                            </div>
                        </Dialog.Content>
                    </Dialog.Portal>
                )}
            </AnimatePresence>
        </Dialog.Root>
    );
}
