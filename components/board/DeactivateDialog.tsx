"use client";

import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { modalBackdrop, modalPanel } from "@/lib/board/motion";
import { classifyEarlyDeparture, isEarlyDepartureEligible } from "@/modules/operational/early-departure";
import { buildEarlyDepartureCreditNote, buildEarlyDepartureSummary } from "@/modules/operational/early-departure-copy";

interface DeactivateDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    domain: "regulation" | "intervention";
    targetId: number;
    targetCode: string;
    targetLabel: string;
    occupantName: string | null;
    /** Dados da ocupação ativa para o preview da régua de saída antecipada. */
    occupantStartedAt?: string | null;
    occupantScheduledStartAt?: string | null;
    occupantScheduledEndAt?: string | null;
    occupantRoleLabel?: string | null;
    isReactivate: boolean;
    onSaved?: () => void;
}

function isoNowLocal(): string {
    const date = new Date();
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function localToIso(value: string): string {
    return new Date(value).toISOString();
}

export function DeactivateDialog({
    open,
    onOpenChange,
    domain,
    targetId,
    targetCode,
    targetLabel,
    occupantName,
    occupantStartedAt = null,
    occupantScheduledStartAt = null,
    occupantScheduledEndAt = null,
    occupantRoleLabel = null,
    isReactivate,
    onSaved,
}: DeactivateDialogProps) {
    const router = useRouter();
    const [effectiveAt, setEffectiveAt] = useState(isoNowLocal());
    const [reason, setReason] = useState("");
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (open) {
            setEffectiveAt(isoNowLocal());
            setReason("");
        }
    }, [open]);

    const subject = domain === "regulation" ? "ramal" : "USA";
    const action = isReactivate ? "Reativar" : "Desativar";

    // Desativar com ocupante é uma retirada: preview da mesma régua que o
    // servidor aplica (early-departure.ts), com o texto oficial da coordenação.
    const earlyDeparturePreview = useMemo(() => {
        if (isReactivate || !occupantName || !effectiveAt || !isEarlyDepartureEligible({ roleLabel: occupantRoleLabel })) {
            return null;
        }
        const departureAt = new Date(effectiveAt);
        if (Number.isNaN(departureAt.getTime())) {
            return null;
        }
        const classification = classifyEarlyDeparture({
            departureAt,
            scheduledStartAt: occupantScheduledStartAt,
            scheduledEndAt: occupantScheduledEndAt,
            startedAt: occupantStartedAt,
        });
        return {
            summary: buildEarlyDepartureSummary(classification.outcome, { name: occupantName }),
            creditNote: buildEarlyDepartureCreditNote(classification),
        };
    }, [isReactivate, occupantName, effectiveAt, occupantRoleLabel, occupantScheduledStartAt, occupantScheduledEndAt, occupantStartedAt]);

    const submit = async () => {
        if (!effectiveAt) {
            toast.error("Informe o horário efetivo.");
            return;
        }
        const trimmed = reason.trim();
        if (!isReactivate && trimmed.length < 8) {
            toast.error("Motivo obrigatório (≥ 8 caracteres) para desativar.");
            return;
        }
        setSubmitting(true);
        try {
            const endpoint = domain === "regulation"
                ? `/api/regulation/posts/${targetId}/state`
                : `/api/intervention/bases/${targetId}/state`;
            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: isReactivate ? "reactivate" : "deactivate",
                    effectiveAt: localToIso(effectiveAt),
                    notes: trimmed || null,
                }),
            });
            const body = await response.json().catch(() => null) as { error?: string; closedOccupancyIds?: string[] } | null;
            if (!response.ok) {
                throw new Error(body?.error || `Falha ao ${action.toLowerCase()} ${subject}.`);
            }
            const message = isReactivate
                ? `${targetCode} reativad${domain === "regulation" ? "o" : "a"}.`
                : body?.closedOccupancyIds?.length
                    ? `${targetCode} desativad${domain === "regulation" ? "o" : "a"}. Cobertura encerrada com auditoria.`
                    : `${targetCode} desativad${domain === "regulation" ? "o" : "a"}.`;
            toast.success(message);
            onOpenChange(false);
            onSaved?.();
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : `Falha ao ${action.toLowerCase()} ${subject}.`);
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
                                    <div className={`board-modal-icon ${isReactivate ? "info" : "warn"}`.trim()}>
                                        <AlertTriangle size={18} strokeWidth={2.2} />
                                    </div>
                                    <div>
                                        <Dialog.Title asChild>
                                            <h2>{action} {subject} {targetCode}</h2>
                                        </Dialog.Title>
                                        <Dialog.Description asChild>
                                            <p>{targetLabel}{occupantName ? ` · ${occupantName}` : ""}</p>
                                        </Dialog.Description>
                                    </div>
                                </header>

                                {!isReactivate && occupantName && (
                                    <div className="board-modal-warning">
                                        <strong>Atenção ao horário</strong>
                                        <p>
                                            Esta hora é a que vai para o <strong>banco de horas</strong> de {occupantName}.
                                            Se a saída foi antes ou depois, ajuste agora — depois fica como auditoria.
                                        </p>
                                    </div>
                                )}

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
                                        <span>{isReactivate ? "Horário da reativação" : "Horário da desativação"}</span>
                                        <input
                                            type="datetime-local"
                                            value={effectiveAt}
                                            onChange={(event) => setEffectiveAt(event.target.value)}
                                            step={60}
                                        />
                                    </label>
                                    <label className="board-modal-field">
                                        <span>Motivo {isReactivate ? "(opcional)" : "(obrigatório)"}</span>
                                        <textarea
                                            value={reason}
                                            onChange={(event) => setReason(event.target.value)}
                                            rows={3}
                                            placeholder={isReactivate
                                                ? "Ex.: ramal reaberto após manutenção"
                                                : "Ex.: ramal fechado por queda de sistema"}
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
                                        className={`board-modal-confirm ${isReactivate ? "info" : "warn"}`.trim()}
                                        onClick={submit}
                                        disabled={submitting}
                                    >
                                        {submitting ? "Aplicando…" : `Confirmar ${action.toLowerCase()}`}
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
