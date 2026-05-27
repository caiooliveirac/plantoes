"use client";

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { modalBackdrop, modalPanel } from "@/lib/board/motion";

interface DepartureDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    domain: "regulation" | "intervention";
    occupancyId: string;
    targetCode: string;
    doctorName: string;
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

export function DepartureDialog({
    open,
    onOpenChange,
    domain,
    occupancyId,
    targetCode,
    doctorName,
    onSaved,
}: DepartureDialogProps) {
    const router = useRouter();
    const [endedAt, setEndedAt] = useState(isoNowLocal());
    const [reason, setReason] = useState("");
    const [submitting, setSubmitting] = useState(false);

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
                    notes: reason.trim() || null,
                }),
            });
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(body?.error || "Falha ao registrar saída.");
            }
            toast.success(`Saída registrada: ${doctorName} às ${endedAt.slice(11, 16)}.`);
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
                                            <h2>Declarar saída</h2>
                                        </Dialog.Title>
                                        <Dialog.Description asChild>
                                            <p>{doctorName} · {targetCode}</p>
                                        </Dialog.Description>
                                    </div>
                                </header>

                                <div className="board-modal-warning danger">
                                    <strong>Hora vai para o banco</strong>
                                    <p>
                                        Essa hora é a que vai contar para o banco de horas de {doctorName}.
                                        Confirme com cuidado antes de salvar.
                                    </p>
                                </div>

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
                                        {submitting ? "Registrando…" : "Registrar saída"}
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
