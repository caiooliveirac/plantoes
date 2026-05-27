"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { TimeScrubber } from "@/components/board/TimeScrubber";
import { EventTimeline } from "@/components/board/EventTimeline";
import { modalBackdrop, modalPanel, tapFeedback } from "@/lib/board/motion";
import type { PendingDepartureConfirmation } from "@/services/board.service";

export interface DepartureVerifierProps {
    target: PendingDepartureConfirmation | null;
    onClose: () => void;
}

function formatLocalHourMinute(ms: number) {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * The anti-fraud verifier. Opens with a magic-move from the audit-rail card.
 *
 * Three decisions:
 *   - Confirmar: keeps actualEndedAt as is (or scrubber-adjusted) and marks confirmed.
 *   - Editar para janela: snaps to scheduledEndAt and confirms. One-click reject of overtime.
 *   - Recusar: same as edit-to-window but with a chief note that signals the
 *     verbalized late-departure was deemed unjustified.
 *
 * The endpoint /confirm-departure already handles both flows — it accepts an
 * optional actualEndedAt override.
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
    const minMs = useMemo(() => {
        if (!target) return 0;
        return new Date(target.scheduledStartAt ?? target.startedAt).getTime();
    }, [target]);
    const maxMs = useMemo(() => {
        if (!target) return 0;
        // Allow up to 4h past scheduled end, or 2h past verbalized — whichever is later.
        const ceilings = [verbalizedMs + 2 * 3600000];
        if (scheduledEndMs !== null) ceilings.push(scheduledEndMs + 4 * 3600000);
        return Math.max(...ceilings);
    }, [target, verbalizedMs, scheduledEndMs]);

    const [valueMs, setValueMs] = useState(verbalizedMs);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        // Reset when target changes (modal opens for a new card).
        if (target) {
            setValueMs(new Date(target.actualEndedAt).getTime());
        }
    }, [target]);

    const suspect = useMemo(() => {
        if (!target) return false;
        return (target.delayMinutes ?? 0) >= 60 || target.reasonOccurrenceCount30d >= 3;
    }, [target]);

    const submit = async (action: "confirm" | "edit-window" | "reject") => {
        if (!target) return;
        setSubmitting(true);
        try {
            let actualEndedAt: string | undefined;
            let note: string | null = null;

            if (action === "confirm") {
                const edited = valueMs !== verbalizedMs;
                actualEndedAt = edited ? new Date(valueMs).toISOString() : undefined;
            } else if (action === "edit-window") {
                if (scheduledEndMs === null) {
                    toast.error("Esta ocupação não tem fim de janela definido para reposicionar automaticamente.");
                    setSubmitting(false);
                    return;
                }
                actualEndedAt = new Date(scheduledEndMs).toISOString();
                note = "Editado para o fim da janela paga.";
            } else {
                if (scheduledEndMs === null) {
                    toast.error("Esta ocupação não tem fim de janela definido para registrar a recusa.");
                    setSubmitting(false);
                    return;
                }
                actualEndedAt = new Date(scheduledEndMs).toISOString();
                note = "Saída tardia recusada pelo chefe — paga até o fim da janela.";
            }

            const response = await fetch(`/api/${target.domain}/occupancies/${target.occupancyId}/confirm-departure`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ actualEndedAt, note }),
            });
            if (!response.ok) {
                const body = await response.json().catch(() => ({})) as { error?: string };
                throw new Error(body.error || "Falha ao confirmar saída.");
            }

            const finalLabel = formatLocalHourMinute(actualEndedAt ? new Date(actualEndedAt).getTime() : verbalizedMs);
            const verb = action === "confirm" ? "Confirmada" : action === "edit-window" ? "Editada" : "Recusada";
            toast.success(`${verb}: ${target.displayName ?? target.doctorName} às ${finalLabel}.`);

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

    return (
        <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
            <AnimatePresence>
                {open && target && (
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
                                            <span className="departure-verifier-body__label">Horário da saída</span>
                                            <TimeScrubber
                                                valueMs={valueMs}
                                                minMs={minMs}
                                                maxMs={maxMs}
                                                verbalizedMs={verbalizedMs}
                                                scheduledEndMs={scheduledEndMs}
                                                suspect={suspect}
                                                onChange={setValueMs}
                                            />
                                            <div style={{ fontSize: "0.82rem", color: "var(--muted-strong)", display: "flex", flexDirection: "column", gap: 4 }}>
                                                {target.scheduledStartAt && target.scheduledEndAt && (
                                                    <span>Janela paga: {formatLocalHourMinute(new Date(target.scheduledStartAt).getTime())} — {formatLocalHourMinute(new Date(target.scheduledEndAt).getTime())}</span>
                                                )}
                                                {typeof target.delayMinutes === "number" && (
                                                    <span>Atraso versus fim de janela (verbalizado): {target.delayMinutes > 0 ? "+" : ""}{target.delayMinutes}min</span>
                                                )}
                                            </div>
                                        </div>

                                        <div className="departure-verifier-body__col">
                                            <span className="departure-verifier-body__label">Eventos correlacionados</span>
                                            <EventTimeline pending={target} />
                                        </div>
                                    </div>

                                    <footer className="departure-verifier-footer">
                                        <motion.button
                                            type="button"
                                            className="departure-verifier-action confirm"
                                            onClick={() => submit("confirm")}
                                            whileTap={tapFeedback}
                                            disabled={submitting}
                                        >
                                            Confirmar {formatLocalHourMinute(valueMs)}
                                        </motion.button>
                                        <motion.button
                                            type="button"
                                            className="departure-verifier-action edit"
                                            onClick={() => submit("edit-window")}
                                            whileTap={tapFeedback}
                                            disabled={submitting || scheduledEndMs === null}
                                            title="Editar para o fim da janela paga"
                                        >
                                            Editar p/ janela{scheduledEndMs !== null ? ` (${formatLocalHourMinute(scheduledEndMs)})` : ""}
                                        </motion.button>
                                        <motion.button
                                            type="button"
                                            className="departure-verifier-action reject"
                                            onClick={() => submit("reject")}
                                            whileTap={tapFeedback}
                                            disabled={submitting || scheduledEndMs === null}
                                            title="Recusar saída tardia"
                                        >
                                            Recusar
                                        </motion.button>
                                    </footer>
                                </motion.div>
                            </div>
                        </Dialog.Content>
                    </Dialog.Portal>
                )}
            </AnimatePresence>
        </Dialog.Root>
    );
}
