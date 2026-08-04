"use client";

import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { modalBackdrop, modalPanel } from "@/lib/board/motion";
import { classifyEarlyDeparture, isEarlyDepartureEligible } from "@/modules/operational/early-departure";
import { buildEarlyDepartureCreditNote, buildEarlyDepartureSummary } from "@/modules/operational/early-departure-copy";

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
}

const CHIEF_KICK_DEFAULT_NOTE = "Saída por encerramento de turno (retirada pelo chefe)";

function isoNowLocal(): string {
    const date = new Date();
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function localToIso(value: string): string {
    return new Date(value).toISOString();
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
}: DepartureDialogProps) {
    const router = useRouter();
    const [endedAt, setEndedAt] = useState(isoNowLocal());
    const [reason, setReason] = useState("");
    const [submitting, setSubmitting] = useState(false);

    // Preview da régua de retirada antecipada: mesma classificação que o servidor
    // vai aplicar (modules/operational/early-departure.ts), recalculada a cada
    // mudança do horário. O texto é o oficial da coordenação.
    const earlyDeparturePreview = useMemo(() => {
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
        return {
            summary: buildEarlyDepartureSummary(classification.outcome, { name: doctorName }),
            creditNote: buildEarlyDepartureCreditNote(classification),
            outcome: classification.outcome,
        };
    }, [chiefKick, endedAt, roleLabel, scheduledStartAt, scheduledEndAt, startedAt, doctorName]);

    useEffect(() => {
        if (open) {
            setEndedAt(isoNowLocal());
            setReason("");
        }
    }, [open]);

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
            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    endedAt: iso,
                    actualEndedAt: iso,
                    notes: reason.trim() || (chiefKick ? CHIEF_KICK_DEFAULT_NOTE : null),
                    ...(chiefKick ? { chiefKick: true } : {}),
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
                    <Dialog.Portal forceMount>
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

                                <div className="board-modal-warning danger">
                                    <strong>Hora vai para o banco{chiefKick ? " e para o grupo" : ""}</strong>
                                    <p>
                                        {chiefKick
                                            ? `Essa hora conta para o banco de horas de ${doctorName} e é a que o grupo do Telegram vai ver no aviso de retirada. Confirme com cuidado.`
                                            : `Essa hora é a que vai contar para o banco de horas de ${doctorName}. Confirme com cuidado antes de salvar.`}
                                    </p>
                                </div>

                                {earlyDeparturePreview && (
                                    <div className="board-modal-warning">
                                        <strong>O que esta retirada significa</strong>
                                        <p>
                                            {earlyDeparturePreview.summary}
                                            {earlyDeparturePreview.creditNote ? ` ${earlyDeparturePreview.creditNote}` : ""}
                                        </p>
                                    </div>
                                )}

                                <div className="board-modal-fields">
                                    <label className="board-modal-field">
                                        <span>Hora da saída</span>
                                        <input
                                            type="datetime-local"
                                            value={endedAt}
                                            onChange={(event) => setEndedAt(event.target.value)}
                                            step={60}
                                        />
                                    </label>
                                    <label className="board-modal-field">
                                        <span>Observação (opcional)</span>
                                        <textarea
                                            value={reason}
                                            onChange={(event) => setReason(event.target.value)}
                                            rows={2}
                                            placeholder="Ex.: saiu antes para resolver continuidade"
                                        />
                                    </label>
                                </div>

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
                                        disabled={submitting}
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
