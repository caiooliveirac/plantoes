"use client";

import { fetchMesa } from "@/lib/board/fetch-mesa";
import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { modalBackdrop, modalPanel } from "@/lib/board/motion";
import { useModalPortalContainer } from "@/lib/board/use-modal-portal-container";
import {
    EARLY_DEPARTURE_HALF_THRESHOLD_MINUTES,
    classifyEarlyDeparture,
    isEarlyDepartureEligible,
    validateChiefWithdrawalChoice,
    type StoredEarlyDepartureOutcome,
} from "@/modules/operational/early-departure";
import { OVERRIDE_NOTE_MIN_LENGTH, isValidOverrideNote } from "@/modules/operational/departure-triage";

interface DepartureDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    domain: "regulation" | "intervention";
    occupancyId: string;
    targetCode: string;
    doctorName: string;
    onSaved?: () => void;
    /**
     * When true, this is a chief "Retirar" (kick): the departure is announced to
     * the Telegram group and a default note is applied if none is given. The time
     * still defaults to "now" and stays editable — the chosen time is what goes to
     * the bank AND to the group alert.
     */
    chiefKick?: boolean;
    /** Dados da ocupação para o preview da régua de saída antecipada (chiefKick). */
    startedAt?: string | null;
    scheduledStartAt?: string | null;
    scheduledEndAt?: string | null;
    roleLabel?: string | null;
    /** Ocupação fora do quadro (deslocado). Muda o texto e o horário padrão. */
    displaced?: boolean;
}

const CHIEF_KICK_DEFAULT_NOTE = "Saída por encerramento de turno (retirada pelo chefe)";

function isoNowLocal(): string {
    const date = new Date();
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function isoToLocalValue(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return isoNowLocal();
    }
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function defaultEndedAtLocal(scheduledEndAt?: string | null) {
    if (scheduledEndAt) {
        const scheduled = new Date(scheduledEndAt);
        if (!Number.isNaN(scheduled.getTime()) && scheduled.getTime() < Date.now()) {
            return isoToLocalValue(scheduledEndAt);
        }
    }
    return isoNowLocal();
}

function localToIso(value: string): string {
    return new Date(value).toISOString();
}

function formatWorked(minutes: number) {
    const safe = Math.max(0, minutes);
    const hours = Math.floor(safe / 60);
    const rest = safe % 60;
    if (hours === 0) return `${rest} min`;
    return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}`;
}

// Ordem de leitura: do que menos paga para o que mais paga. "Sem saldo" em
// primeiro — é o caso de quem nem estava no plantão (erro de chefia, madrugada
// antes de existir o comando) e tem de ser um clique.
const WITHDRAWAL_CHOICES: Array<{ outcome: StoredEarlyDepartureOutcome; title: string }> = [
    { outcome: "no_balance", title: "Remover sem saldo" },
    { outcome: "bank_only", title: "Saldo para o banco de horas" },
    { outcome: "half_shift", title: "Pagar meio plantão" },
    { outcome: "full_shift", title: "Pagar plantão inteiro" },
];

function describeWithdrawalChoice(outcome: StoredEarlyDepartureOutcome, workedMinutes: number) {
    switch (outcome) {
        case "no_balance":
            return "Não recebe este plantão e não gera banco de horas.";
        case "bank_only":
            return `Não recebe o plantão; crédito de ${formatWorked(workedMinutes)} no banco.`;
        case "half_shift": {
            const credit = workedMinutes - EARLY_DEPARTURE_HALF_THRESHOLD_MINUTES;
            return credit > 0
                ? `Recebe meio plantão e crédito de ${formatWorked(credit)} no banco.`
                : "Recebe meio plantão.";
        }
        case "full_shift":
            return "Recebe o plantão inteiro.";
    }
}

export function DepartureDialog({
    open,
    onOpenChange,
    domain,
    occupancyId,
    targetCode,
    doctorName,
    onSaved,
    chiefKick = false,
    startedAt = null,
    scheduledStartAt = null,
    scheduledEndAt = null,
    roleLabel = null,
    displaced = false,
}: DepartureDialogProps) {
    const router = useRouter();
    const portalContainer = useModalPortalContainer();
    const [endedAt, setEndedAt] = useState(() => defaultEndedAtLocal(scheduledEndAt));
    const [reason, setReason] = useState("");
    const [chosenOutcome, setChosenOutcome] = useState<StoredEarlyDepartureOutcome | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const scheduledEndIsPast = Boolean(
        scheduledEndAt && !Number.isNaN(new Date(scheduledEndAt).getTime()) && new Date(scheduledEndAt).getTime() < Date.now(),
    );

    // Retirar: a chefia escolhe o desfecho; a régua (a mesma do servidor,
    // modules/operational/early-departure.ts) só sugere e pré-seleciona.
    const withdrawal = useMemo(() => {
        if (!chiefKick || !endedAt || !isEarlyDepartureEligible({ roleLabel })) {
            return null;
        }
        const departureAt = new Date(endedAt);
        if (Number.isNaN(departureAt.getTime())) {
            return null;
        }
        const classification = classifyEarlyDeparture({
            departureAt,
            scheduledStartAt,
            scheduledEndAt,
            startedAt,
        });
        const choices = WITHDRAWAL_CHOICES.map((choice) => ({
            ...choice,
            hint: describeWithdrawalChoice(choice.outcome, classification.workedMinutes),
            suggested: choice.outcome === classification.outcome,
            ...validateChiefWithdrawalChoice(choice.outcome, classification),
        }));
        const chosen = choices.find((choice) => choice.outcome === chosenOutcome && choice.allowed)
            ?? choices.find((choice) => choice.suggested)!;
        return { choices, chosen, notEarly: choices.some((choice) => !choice.allowed) };
    }, [chiefKick, endedAt, roleLabel, scheduledStartAt, scheduledEndAt, startedAt, chosenOutcome]);

    const justificationMissing = Boolean(withdrawal?.chosen.requiresNote) && !isValidOverrideNote(reason);

    useEffect(() => {
        if (open) {
            setEndedAt(defaultEndedAtLocal(scheduledEndAt));
            setReason("");
            setChosenOutcome(null);
        }
    }, [open, occupancyId, scheduledEndAt]);

    const submit = async () => {
        if (!endedAt) {
            toast.error("Informe a hora da saída.");
            return;
        }
        setSubmitting(true);
        try {
            const iso = localToIso(endedAt);
            const endpoint = domain === "regulation"
                ? `/api/regulation/occupancies/${occupancyId}/end`
                : `/api/intervention/occupancies/${occupancyId}/end`;
            const response = await fetchMesa(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    endedAt: iso,
                    actualEndedAt: iso,
                    notes: reason.trim() || (chiefKick ? CHIEF_KICK_DEFAULT_NOTE : null),
                    ...(chiefKick ? { chiefKick: true } : {}),
                    ...(withdrawal ? { earlyDepartureOutcome: withdrawal.chosen.outcome, justification: reason.trim() || null } : {}),
                }),
            });
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(body?.error || (chiefKick ? "Falha ao retirar plantonista." : "Falha ao registrar saída."));
            }
            toast.success(chiefKick
                ? `Plantonista retirado: ${doctorName} às ${endedAt.slice(11, 16)}. Grupo notificado.`
                : `Saída registrada: ${doctorName} às ${endedAt.slice(11, 16)}.`);
            onOpenChange(false);
            onSaved?.();
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Falha ao registrar saída.");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <AnimatePresence>
                {open && (
                    <Dialog.Portal forceMount container={portalContainer}>
                        <Dialog.Overlay asChild>
                            <motion.div
                                className="board-modal-backdrop"
                                variants={modalBackdrop}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                            />
                        </Dialog.Overlay>
                        <Dialog.Content asChild>
                            <motion.div
                                className="board-modal-panel"
                                variants={modalPanel}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                            >
                                <header className="board-modal-header">
                                    <div className="board-modal-icon danger">
                                        <LogOut size={18} strokeWidth={2.2} />
                                    </div>
                                    <div>
                                        <Dialog.Title asChild>
                                            <h2>{chiefKick ? "Retirar plantonista" : "Declarar saída"}</h2>
                                        </Dialog.Title>
                                        <Dialog.Description asChild>
                                            <p>{doctorName} · {targetCode}</p>
                                        </Dialog.Description>
                                    </div>
                                </header>

                                {!chiefKick && (
                                    <div className="board-modal-warning danger">
                                        <strong>Hora vai para o banco</strong>
                                        <p>
                                            {displaced
                                                ? `${doctorName} está fora do quadro neste posto. Encerrar fecha a ocupação deslocada — não tira o titular. Se o plantão já virou, use o horário real da saída, não agora.`
                                                : `Essa hora é a que vai contar para o banco de horas de ${doctorName}. Confirme com cuidado antes de salvar.`}
                                        </p>
                                    </div>
                                )}

                                {(displaced || scheduledEndIsPast) && (
                                    <div className="board-modal-warning">
                                        <strong>{displaced ? "Deslocado" : "Plantão previsto já passou"}</strong>
                                        <p>
                                            {scheduledEndIsPast
                                                ? "O horário padrão é o fim previsto do plantão, não o instante atual. Ajuste se a saída real foi outra."
                                                : "Está fora do quadro. Retirar tira só esta ocupação — o titular do ramal fica."}
                                        </p>
                                    </div>
                                )}

                                <label className="board-modal-field">
                                    <span>{chiefKick ? "Hora da saída — vai no aviso do grupo" : "Hora da saída"}</span>
                                    <input
                                        type="datetime-local"
                                        value={endedAt}
                                        onChange={(event) => setEndedAt(event.target.value)}
                                        step={60}
                                    />
                                </label>

                                {withdrawal && (
                                    <fieldset className="board-modal-choices" disabled={submitting}>
                                        <legend>Pagamento e banco de horas</legend>
                                        {withdrawal.choices.map((choice) => (
                                            <label
                                                key={choice.outcome}
                                                className={choice.outcome === withdrawal.chosen.outcome ? "board-modal-choice selected" : "board-modal-choice"}
                                            >
                                                <input
                                                    type="radio"
                                                    name="withdrawal-outcome"
                                                    value={choice.outcome}
                                                    checked={choice.outcome === withdrawal.chosen.outcome}
                                                    disabled={!choice.allowed}
                                                    onChange={() => setChosenOutcome(choice.outcome)}
                                                />
                                                <span className="board-modal-choice-body">
                                                    <span className="board-modal-choice-title">
                                                        {choice.title}
                                                        {choice.suggested ? <em className="board-modal-choice-tag">régua</em> : null}
                                                    </span>
                                                    <span className="board-modal-choice-hint">
                                                        {choice.hint}
                                                        {choice.allowed && choice.requiresNote ? " Pede justificativa." : ""}
                                                    </span>
                                                </span>
                                            </label>
                                        ))}
                                        {withdrawal.notEarly && (
                                            <p className="board-modal-choice-hint">Saída no fim do turno: só cabe o plantão inteiro.</p>
                                        )}
                                    </fieldset>
                                )}

                                <label className="board-modal-field">
                                    <span>
                                        {withdrawal?.chosen.requiresNote
                                            ? `Justificativa — obrigatória (mín. ${OVERRIDE_NOTE_MIN_LENGTH} caracteres)`
                                            : "Observação (opcional)"}
                                    </span>
                                    <textarea
                                        value={reason}
                                        onChange={(event) => setReason(event.target.value)}
                                        rows={2}
                                        placeholder={chiefKick ? "Ex.: não estava no plantão; madrugada" : "Ex.: saiu antes para resolver continuidade"}
                                    />
                                </label>

                                <footer className="board-modal-actions">
                                    <Dialog.Close asChild>
                                        <button type="button" className="board-modal-cancel" disabled={submitting}>
                                            Cancelar
                                        </button>
                                    </Dialog.Close>
                                    <button
                                        type="button"
                                        className="board-modal-confirm danger"
                                        onClick={submit}
                                        disabled={submitting || justificationMissing}
                                    >
                                        {submitting
                                            ? (chiefKick ? "Retirando…" : "Registrando…")
                                            : (chiefKick ? "Retirar" : "Registrar saída")}
                                    </button>
                                </footer>
                            </motion.div>
                        </Dialog.Content>
                    </Dialog.Portal>
                )}
            </AnimatePresence>
        </Dialog.Root>
    );
}
