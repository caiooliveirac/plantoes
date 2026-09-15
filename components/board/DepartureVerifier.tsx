"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { EventTimeline } from "@/components/board/EventTimeline";
import { modalBackdrop, modalPanel, tapFeedback } from "@/lib/board/motion";
import type { PendingDepartureConfirmation } from "@/services/board.service";
import { calculateGuardedBankHours } from "@/modules/bank-hours/calculator";
import { resolveDayOffsetLabel } from "@/lib/board/day-offset";
import { describeDepartureOrigin } from "@/modules/operational/departure-origin";
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
 * O verificador de saídas.
 *
 * Uma pergunta e três respostas, sempre as mesmas:
 *
 *   "Fulano saiu do 2152 às 07:16?"
 *     1. Saiu às 07:16        — confirma; a régua (inteiro/meio/banco) aplica
 *                               sozinha e aparece numa linha. Desvio fica atrás
 *                               do link "pagar diferente", com justificativa.
 *     2. Saiu em outra hora   — corrige chegada/saída e confirma.
 *     3. Não saiu, ainda está — reabre o mesmo registro. Só aparece quando é
 *                               possível: sem chegada posterior em outro alvo.
 *
 * Antes da pergunta, a tela diz DE ONDE veio a saída (avisou / outro assumiu /
 * janela venceu / sistema), porque a maioria das saídas da fila ninguém
 * declarou: outro médico chegou e o registro foi encerrado naquela hora. O
 * chefe julgava "07:05→07:16" como se o médico tivesse dito isso.
 *
 * O que saiu daqui de propósito: "foi para outro posto" (é remanejamento, feito
 * no quadro; com chegada registrada lá a saída aconteceu e o botão 3 some),
 * "não sei dizer" (não é resposta) e os cinco botões de pagamento por faixa.
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
    // decide  = a pergunta e as três respostas
    // adjust  = "hora errada": corrigir chegada/saída
    // contest = "ainda está aqui": confirmar a reabertura
    // other   = "pagar diferente": desvios da régua, com justificativa
    const [view, setView] = useState<"decide" | "adjust" | "contest" | "other">("decide");
    // Desvio escolhido que exige justificativa — o textarea aparece e o envio
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
    // Janela do BANCO, não a do quadro: na regulação o previsto termina 07:15/19:15
    // (a rendição), mas o banco conta desde 07:00/19:00. Usar a do quadro mostrava
    // 15 min de excedente a menos do que o sistema credita de fato.
    const bankScheduledStartAt = target?.bankScheduledStartAt ?? target?.scheduledStartAt ?? null;
    const bankScheduledEndAt = target?.bankScheduledEndAt ?? target?.scheduledEndAt ?? null;

    // Atraso da CHEGADA contra a janela do quadro — o número que o chefe procura
    // primeiro e que o modal só mostrava indiretamente, dentro da frase de triagem.
    // "chegou 07:00 → saiu 07:00" em dias diferentes não se lê sem esta marca.
    const dayOffset = useMemo(
        () => (target ? resolveDayOffsetLabel(target.startedAt, target.actualEndedAt) : null),
        [target],
    );

    const arrivalDeltaMinutes = useMemo(() => {
        if (!target?.scheduledStartAt) return null;
        const scheduled = new Date(target.scheduledStartAt).getTime();
        const started = new Date(target.startedAt).getTime();
        if (Number.isNaN(scheduled) || Number.isNaN(started)) return null;
        return Math.round((started - scheduled) / 60000);
    }, [target]);

    const standardBalance = useMemo(() => {
        if (!target || !bankScheduledStartAt || !bankScheduledEndAt) return null;
        try {
            return calculateGuardedBankHours({
                scheduledStartAt: bankScheduledStartAt,
                scheduledEndAt: bankScheduledEndAt,
                actualStartAt: target.startedAt,
                actualEndAt: target.actualEndedAt,
            });
        } catch {
            return null;
        }
    }, [target, bankScheduledStartAt, bankScheduledEndAt]);

    const adjustPreview = useMemo(() => {
        if (view !== "adjust" || !target || !bankScheduledStartAt || !bankScheduledEndAt) return null;
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
                calc: calculateGuardedBankHours({
                    scheduledStartAt: bankScheduledStartAt,
                    scheduledEndAt: bankScheduledEndAt,
                    actualStartAt: start,
                    actualEndAt: end,
                }),
            };
        } catch {
            return null;
        }
    }, [view, target, adjustStart, adjustEnd, bankScheduledStartAt, bankScheduledEndAt]);

    const submit = async (body: {
        actualEndedAt?: string;
        startedAt?: string;
        note?: string | null;
        outcome?: "bank_only" | "half_shift" | "full_shift";
        contestDeparture?: { continuation: "same_target" };
    }, successLabel: string) => {
        if (!target) return;
        setSubmitting(true);
        try {
            const response = await fetch(`/api/${target.domain}/occupancies/${target.occupancyId}/confirm-departure`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const payload = await response.json().catch(() => ({})) as
                { error?: string; outOfBoardReason?: string | null };
            if (!response.ok) {
                throw new Error(payload.error || "Falha ao confirmar saída.");
            }
            toast.success(`${target.displayName ?? target.doctorName}: ${successLabel}`);
            // A contestação nunca derruba quem está no quadro — quando sobra
            // conflito, o chefe precisa VER de quem é a chegada a corrigir.
            if (payload.outOfBoardReason) {
                toast.warning(payload.outOfBoardReason, { duration: 12000 });
            }
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

    /**
     * A resposta "saiu às HH:MM" aplica a régua sozinha. O chefe não escolhe
     * inteiro/meio/banco na primeira tela: vê a consequência numa linha e, se
     * discordar, abre "pagar diferente".
     */
    const decision = useMemo<{ action: DecisionAction; consequence: string; alternatives: DecisionButton[] }>(() => {
        if (!target || !triage) {
            return { action: { kind: "confirm" }, consequence: "", alternatives: [] };
        }
        const worked = triage.classification?.workedMinutes ?? 0;
        const credit = triage.classification?.bankCreditMinutes ?? 0;
        const balance = standardBalance?.balanceMinutes ?? null;

        if (triage.kind === "early_bank_only") {
            return {
                action: { kind: "outcome", outcome: "bank_only", requiresNote: false },
                consequence: `Fez ${formatMinutesShort(worked)} da janela: não assina o plantão; as horas viram banco (${formatMinutesShort(credit)}).`,
                alternatives: [
                    { label: "Pagar MEIO plantão", hint: "Acima da régua: pede justificativa.", className: "edit", action: { kind: "outcome", outcome: "half_shift", requiresNote: true } },
                    { label: "Pagar plantão INTEIRO", hint: "Acima da régua: pede justificativa.", className: "edit", action: { kind: "outcome", outcome: "full_shift", requiresNote: true } },
                ],
            };
        }
        if (triage.kind === "early_half") {
            return {
                action: { kind: "outcome", outcome: "half_shift", requiresNote: false },
                consequence: `Fez ${formatMinutesShort(worked)} da janela: assina MEIO plantão`
                    + `${credit > 0 ? `; ${formatMinutesShort(credit)} viram banco` : ""}.`,
                alternatives: [
                    { label: "Pagar plantão inteiro", hint: "Decisão corriqueira nesta faixa; sem justificativa.", className: "edit", action: { kind: "outcome", outcome: "full_shift", requiresNote: false } },
                    { label: "Lançar só para o banco de horas", hint: "Abaixo da régua: pede justificativa.", className: "edit", action: { kind: "outcome", outcome: "bank_only", requiresNote: true } },
                ],
            };
        }
        if (triage.kind === "early_full") {
            return {
                action: { kind: "outcome", outcome: "full_shift", requiresNote: false },
                consequence: `Saiu faltando ${formatMinutesShort(triage.classification?.remainingMinutes ?? 0)}: assina o plantão inteiro; atraso e saída contam no banco.`,
                alternatives: [
                    { label: "Pagar MEIO plantão", hint: "Abaixo da régua: pede justificativa.", className: "edit", action: { kind: "outcome", outcome: "half_shift", requiresNote: true } },
                    { label: "Lançar só para o banco de horas", hint: "Abaixo da régua: pede justificativa.", className: "edit", action: { kind: "outcome", outcome: "bank_only", requiresNote: true } },
                ],
            };
        }
        if (triage.kind === "late_credit") {
            return {
                action: { kind: "confirm" },
                consequence: balance !== null && balance > 0
                    ? `Paga o plantão e credita ${formatMinutesShort(balance)} no banco de horas.`
                    : (standardBalance?.explanation ?? "Paga o plantão."),
                alternatives: [
                    { label: "Recusar o crédito no banco", hint: "Paga até o fim da janela, sem crédito. Pede justificativa.", className: "edit", action: { kind: "reject_credit" } },
                ],
            };
        }
        if (triage.kind === "extended_stay") {
            return { action: { kind: "confirm" }, consequence: standardBalance?.explanation ?? "Emendou turno: a folha assina o plantão.", alternatives: [] };
        }
        if (triage.kind === "short_anomaly") {
            return {
                action: { kind: "confirm" },
                consequence: "Saída minutos depois da chegada. Se foi real, confirme; se foi erro, corrija a hora.",
                alternatives: [],
            };
        }
        return {
            action: { kind: "confirm" },
            consequence: balance !== null && balance !== 0
                ? `Paga o plantão. Banco: ${formatSignedMinutes(balance)}.`
                : "Paga o plantão. Nada muda no banco de horas.",
            alternatives: [],
        };
    }, [target, triage, standardBalance]);

    const originLine = useMemo(() => (target
        ? describeDepartureOrigin({
            origin: target.origin,
            doctorName: target.displayName ?? target.doctorName,
            targetCode: target.targetCode,
            actualEndedAt: target.actualEndedAt,
            successorName: target.successorName,
        })
        : ""), [target]);

    // "Ainda está aqui" só existe quando é possível: sem chegada posterior do
    // médico em outro alvo. Com chegada, a saída aconteceu e o botão some — o
    // servidor recusa de qualquer forma (describeContestBlockedByLaterArrival).
    const canContest = Boolean(target && !target.laterArrivalCode);
    const confirmLabel = target?.origin === "successor" && target.successorName
        ? `Saiu às ${formatLocalHourMinute(verbalizedMs)}, rendido por ${target.successorName.split(" ")[0]}`
        : `Saiu às ${formatLocalHourMinute(verbalizedMs)}`;

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
                                                {/* A hora da saída não se repete aqui: ela é o segundo
                                                    número grande do bloco de fatos, logo abaixo. */}
                                                <span>
                                                    {target.targetCode} · {target.shiftLabel ?? "—"}{target.roleLabel ? ` · ${target.roleLabel}` : ""}
                                                </span>
                                            </Dialog.Description>
                                        </div>
                                        <Dialog.Close asChild>
                                            <button type="button" className="departure-verifier-close" aria-label="Fechar verificador">Fechar (esc)</button>
                                        </Dialog.Close>
                                    </header>

                                    <div className="departure-verifier-body">
                                        <div className="departure-verifier-body__col">
                                            {/* Os dois horários que decidem tudo, antes de qualquer régua. */}
                                            <div className="departure-verifier-facts">
                                                <div className="departure-verifier-fact">
                                                    <span className="departure-verifier-fact__label">Chegou</span>
                                                    <strong className="departure-verifier-fact__value">
                                                        {formatLocalHourMinute(new Date(target.startedAt).getTime())}
                                                    </strong>
                                                    {arrivalDeltaMinutes !== null && (
                                                        <span className="departure-verifier-fact__delta" data-off={arrivalDeltaMinutes > 15}>
                                                            {arrivalDeltaMinutes === 0 ? "no horário" : `${formatSignedMinutes(arrivalDeltaMinutes)} vs previsto`}
                                                        </span>
                                                    )}
                                                    {target.arrivalCorrectedInTelegram && (
                                                        <span className="departure-verifier-fact__badge" title="Esta chegada já foi corrigida no Telegram (/corrigir). É a hora que vale.">
                                                            corrigida no /corrigir
                                                        </span>
                                                    )}
                                                </div>
                                                <span className="departure-verifier-facts__arrow" aria-hidden="true">→</span>
                                                <div className="departure-verifier-fact">
                                                    <span className="departure-verifier-fact__label">Saiu</span>
                                                    <strong className="departure-verifier-fact__value">
                                                        {formatLocalHourMinute(verbalizedMs)}
                                                        {dayOffset && <i className="departure-verifier-fact__day">{dayOffset}</i>}
                                                    </strong>
                                                    {typeof target.delayMinutes === "number" && (
                                                        <span className="departure-verifier-fact__delta" data-off={Math.abs(target.delayMinutes) > 15}>
                                                            {target.delayMinutes === 0 ? "no horário" : `${formatSignedMinutes(target.delayMinutes)} vs previsto`}
                                                        </span>
                                                    )}
                                                </div>
                                                {target.scheduledStartAt && target.scheduledEndAt && (
                                                    <span className="departure-verifier-facts__window">
                                                        previsto {formatLocalHourMinute(new Date(target.scheduledStartAt).getTime())}
                                                        {" — "}{formatLocalHourMinute(new Date(target.scheduledEndAt).getTime())}
                                                    </span>
                                                )}
                                            </div>
                                            <p className="departure-verifier-headline">{originLine}</p>

                                            {view === "decide" && (
                                                <div className="departure-verifier-decisions">
                                                    <p className="departure-verifier-question">
                                                        {target.displayName ?? target.doctorName} saiu do {target.targetCode} às {formatLocalHourMinute(verbalizedMs)}?
                                                    </p>
                                                    <div className="departure-verifier-decision">
                                                        <motion.button
                                                            type="button"
                                                            className={`departure-verifier-action ${triage.kind === "short_anomaly" ? "reject" : "confirm"}`}
                                                            onClick={() => { void runAction(decision.action, null); }}
                                                            whileTap={tapFeedback}
                                                            disabled={submitting}
                                                        >
                                                            {confirmLabel}
                                                        </motion.button>
                                                        <span className="departure-verifier-decision__hint">
                                                            {decision.consequence}
                                                            {decision.alternatives.length > 0 && (
                                                                <>
                                                                    {" "}
                                                                    <button type="button" className="departure-verifier-link" onClick={() => setView("other")} disabled={submitting}>
                                                                        pagar diferente
                                                                    </button>
                                                                </>
                                                            )}
                                                        </span>
                                                    </div>
                                                    {canAdjust && (
                                                        <div className="departure-verifier-decision">
                                                            <motion.button
                                                                type="button"
                                                                className="departure-verifier-action edit"
                                                                onClick={() => setView("adjust")}
                                                                whileTap={tapFeedback}
                                                                disabled={submitting}
                                                            >
                                                                Saiu em outra hora
                                                            </motion.button>
                                                            <span className="departure-verifier-decision__hint">
                                                                Corrige chegada e saída; a régua recalcula na tela.
                                                            </span>
                                                        </div>
                                                    )}
                                                    {canContest && (
                                                        <div className="departure-verifier-decision">
                                                            <motion.button
                                                                type="button"
                                                                className="departure-verifier-action reject"
                                                                onClick={() => { setView("contest"); setNoteText(""); }}
                                                                whileTap={tapFeedback}
                                                                disabled={submitting}
                                                            >
                                                                Não saiu, ainda está no {target.targetCode}
                                                            </motion.button>
                                                            <span className="departure-verifier-decision__hint">
                                                                O plantão continua aberto neste mesmo registro.
                                                            </span>
                                                        </div>
                                                    )}
                                                </div>
                                            )}

                                            {view === "other" && (
                                                <div className="departure-verifier-decisions">
                                                    <p className="departure-verifier-question">Pagar diferente da régua</p>
                                                    {decision.alternatives.map((button) => (
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
                                                    {pendingAction !== null && (
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
                                                            <motion.button
                                                                type="button"
                                                                className="departure-verifier-action confirm"
                                                                onClick={() => { void runAction(pendingAction, noteText.trim()); }}
                                                                whileTap={tapFeedback}
                                                                disabled={submitting || !noteValid}
                                                            >
                                                                Confirmar decisão
                                                            </motion.button>
                                                        </div>
                                                    )}
                                                    <motion.button
                                                        type="button"
                                                        className="departure-verifier-action edit"
                                                        onClick={() => { setView("decide"); setPendingAction(null); setNoteText(""); }}
                                                        whileTap={tapFeedback}
                                                        disabled={submitting}
                                                    >
                                                        Voltar
                                                    </motion.button>
                                                </div>
                                            )}

                                            {view === "contest" && (
                                                <div className="departure-verifier-note">
                                                    <p style={{ fontSize: "0.85rem", fontWeight: 600, margin: 0 }}>
                                                        {target.displayName ?? target.doctorName} ainda está no {target.targetCode}: a saída das {formatLocalHourMinute(verbalizedMs)} não aconteceu.
                                                    </p>
                                                    <span className="departure-verifier-decision__hint">
                                                        Reabre este mesmo plantão. Se outro médico assumiu o {target.targetCode}, ele fica no quadro
                                                        e a tela diz de quem é a chegada a corrigir. Fora do quadro, fecha sozinho no fim da janela
                                                        {scheduledEndMs !== null ? ` (${formatLocalHourMinute(scheduledEndMs)})` : ""}.
                                                    </span>
                                                    <textarea
                                                        value={noteText}
                                                        onChange={(event) => setNoteText(event.target.value)}
                                                        rows={2}
                                                        placeholder="O que aconteceu (opcional) — vai para a auditoria."
                                                        style={{ width: "100%", resize: "vertical", fontSize: "0.85rem", padding: 8 }}
                                                    />
                                                    <div style={{ display: "flex", gap: 8 }}>
                                                        <motion.button
                                                            type="button"
                                                            className="departure-verifier-action reject"
                                                            whileTap={tapFeedback}
                                                            disabled={submitting}
                                                            onClick={() => {
                                                                void submit({
                                                                    contestDeparture: { continuation: "same_target" },
                                                                    note: noteText.trim().length > 0 ? noteText.trim() : null,
                                                                }, "plantão reaberto — ainda está no alvo.");
                                                            }}
                                                        >
                                                            Confirmar: ainda está no {target.targetCode}
                                                        </motion.button>
                                                        <motion.button
                                                            type="button"
                                                            className="departure-verifier-action edit"
                                                            whileTap={tapFeedback}
                                                            disabled={submitting}
                                                            onClick={() => { setView("decide"); setNoteText(""); }}
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
