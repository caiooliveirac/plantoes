"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { modalBackdrop, modalPanel, tapFeedback } from "@/lib/board/motion";
import { calculateGuardedBankHours } from "@/modules/bank-hours/calculator";
import type { PendingChiefExit } from "@/services/board.service";

export interface ChiefExitGateProps {
    pendingChiefExits: PendingChiefExit[];
}

function toTimeInputValue(iso: string) {
    const date = new Date(iso);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatHourMinute(iso: string | null) {
    if (!iso) return "--:--";
    return toTimeInputValue(iso);
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
    const body = hours > 0 ? `${hours}h${String(rest).padStart(2, "0")}` : `${rest}min`;
    return `${sign}${body}`;
}

/**
 * Pergunta obrigatória: a que horas o chefe anterior da 2031 saiu.
 *
 * O chefe de plantão só sai quando o substituto chega. A rendição fecha a
 * ocupação dele sem horário real, e essa saída nunca aparecia na fila comum —
 * o banco de horas dele fechava calado na fronteira do turno. Aqui a pergunta
 * trava o quadro até ser respondida, e já mostra o crédito que a resposta gera,
 * com a MESMA régua do servidor (janela do banco, tolerância de 15 min,
 * excedente em dobro quando a chegada foi no horário).
 *
 * "Não sei dizer" não é saída: avisa a coordenação, registra, e volta a
 * perguntar em 30 minutos — nunca some.
 */
export function ChiefExitGate({ pendingChiefExits }: ChiefExitGateProps) {
    const router = useRouter();
    const [, startTransition] = useTransition();
    const [submitting, setSubmitting] = useState(false);
    const [snoozedUntil, setSnoozedUntil] = useState<Record<string, number>>({});
    const [exitTime, setExitTime] = useState("");

    const target = useMemo(() => {
        const now = Date.now();
        return pendingChiefExits.find((item) => (snoozedUntil[item.occupancyId] ?? 0) < now) ?? null;
    }, [pendingChiefExits, snoozedUntil]);

    useEffect(() => {
        if (target) {
            setExitTime(toTimeInputValue(target.handoffAt));
        }
    }, [target]);

    const preview = useMemo(() => {
        if (!target?.bankScheduledStartAt || !target?.bankScheduledEndAt) return null;
        const end = combineWithLocalDate(target.handoffAt, exitTime);
        if (!end) return null;
        const startedAt = new Date(target.startedAt);
        if (end.getTime() < startedAt.getTime()) return null;
        try {
            return {
                end,
                calc: calculateGuardedBankHours({
                    scheduledStartAt: target.bankScheduledStartAt,
                    scheduledEndAt: target.bankScheduledEndAt,
                    actualStartAt: target.startedAt,
                    actualEndAt: end,
                }),
            };
        } catch {
            return null;
        }
    }, [target, exitTime]);

    const doctorLabel = target ? (target.displayName || target.doctorName) : "";

    const confirmExit = async () => {
        if (!target || !preview) {
            toast.error("Informe um horário de saída válido (não pode ser antes da chegada).");
            return;
        }
        setSubmitting(true);
        try {
            const response = await fetch(`/api/regulation/occupancies/${target.occupancyId}/confirm-departure`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ actualEndedAt: preview.end.toISOString() }),
            });
            const payload = await response.json().catch(() => ({})) as { error?: string };
            if (!response.ok) {
                throw new Error(payload.error || "Falha ao registrar a saída do chefe.");
            }
            toast.success(`${doctorLabel}: saída registrada às ${exitTime}.`);
            startTransition(() => router.refresh());
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Falha ao registrar a saída do chefe.");
        } finally {
            setSubmitting(false);
        }
    };

    const reportUnknown = async () => {
        if (!target) return;
        setSubmitting(true);
        try {
            const response = await fetch(`/api/regulation/occupancies/${target.occupancyId}/chief-exit-unknown`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            });
            if (!response.ok) {
                const payload = await response.json().catch(() => ({})) as { error?: string };
                throw new Error(payload.error || "Falha ao avisar a coordenação.");
            }
            toast.warning("Coordenação avisada. Volto a perguntar em 30 minutos.");
            setSnoozedUntil((current) => ({ ...current, [target.occupancyId]: Date.now() + 30 * 60_000 }));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Falha ao avisar a coordenação.");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog.Root open={target !== null}>
            <AnimatePresence>
                {target && (
                    <Dialog.Portal forceMount>
                        <Dialog.Overlay asChild>
                            <motion.div className="board-modal-backdrop" {...modalBackdrop} />
                        </Dialog.Overlay>
                        <Dialog.Content
                            asChild
                            onEscapeKeyDown={(event) => event.preventDefault()}
                            onPointerDownOutside={(event) => event.preventDefault()}
                            onInteractOutside={(event) => event.preventDefault()}
                        >
                            <motion.div className="board-modal chief-exit-gate" {...modalPanel}>
                                <Dialog.Title className="board-modal-title">
                                    Que horas {doctorLabel} saiu da {target.targetCode}?
                                </Dialog.Title>
                                <Dialog.Description className="board-modal-subtitle">
                                    Chefia de plantão só sai quando o substituto chega
                                    {target.successorName
                                        ? ` — ${target.successorName} chegou ${formatHourMinute(target.successorStartedAt)}`
                                        : ""}
                                    . A rendição foi registrada às {formatHourMinute(target.handoffAt)}, mas ninguém
                                    informou a hora real da saída. Sem essa resposta o banco de horas dele fica travado.
                                </Dialog.Description>

                                <div className="board-modal-warning danger">
                                    <strong>Hora vai direto para o banco de horas</strong>
                                    <p>
                                        Chegou {formatHourMinute(target.startedAt)}; previsto até{" "}
                                        {formatHourMinute(target.scheduledEndAt)}. Informe a hora real da saída — ela é
                                        a que conta.
                                    </p>
                                </div>

                                <label className="board-modal-field">
                                    <span>Saída real</span>
                                    <input
                                        type="time"
                                        value={exitTime}
                                        step={60}
                                        onChange={(event) => setExitTime(event.target.value)}
                                    />
                                </label>

                                {preview && (
                                    <div className="board-modal-warning">
                                        <strong>
                                            Banco de horas: {formatSignedMinutes(preview.calc.balanceMinutes)}
                                            {preview.calc.overtimeMultiplier === 2 && preview.calc.overtimeMinutes > 0
                                                ? " (excedente em dobro)"
                                                : ""}
                                        </strong>
                                        <p>{preview.calc.explanation}</p>
                                    </div>
                                )}

                                <div className="board-modal-actions">
                                    <motion.button
                                        type="button"
                                        className="board-modal-button confirm"
                                        disabled={submitting || !preview}
                                        onClick={() => void confirmExit()}
                                        {...tapFeedback}
                                    >
                                        {submitting ? "Registrando…" : `Registrar saída ${exitTime}`}
                                    </motion.button>
                                    <motion.button
                                        type="button"
                                        className="board-modal-button reject"
                                        disabled={submitting}
                                        onClick={() => void reportUnknown()}
                                        {...tapFeedback}
                                    >
                                        Não sei dizer — avisar coordenação
                                    </motion.button>
                                </div>
                            </motion.div>
                        </Dialog.Content>
                    </Dialog.Portal>
                )}
            </AnimatePresence>
        </Dialog.Root>
    );
}
