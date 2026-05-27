"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Shield } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { PendingDepartureCard } from "@/components/board/PendingDepartureCard";
import { fadeRise, staggerList } from "@/lib/board/motion";
import type { PendingDepartureConfirmation } from "@/services/board.service";

export interface AuditRailProps {
    pendingDepartures: PendingDepartureConfirmation[];
    onOpenVerifier: (pending: PendingDepartureConfirmation) => void;
}

/**
 * Glassmorphic side rail surfacing departures that the chefe still needs to
 * confirm. New items pulse until interacted with; quick-confirm fires a POST
 * with optimistic removal and a sonner toast (no undo here — the dedicated
 * verifier modal handles edits).
 *
 * Visibility: caller must already have gated on session.canManage.
 */
export function AuditRail({ pendingDepartures, onOpenVerifier }: AuditRailProps) {
    const router = useRouter();
    const [, startTransition] = useTransition();
    const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
    const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
    const seenIdsRef = useRef<Set<string>>(new Set());
    const [freshIds, setFreshIds] = useState<Set<string>>(new Set());

    // Mark items that appeared after the first render as "fresh" so they pulse.
    // First render: everything is just baseline state, no pulse.
    useEffect(() => {
        const seen = seenIdsRef.current;
        if (seen.size === 0) {
            for (const item of pendingDepartures) {
                seen.add(item.occupancyId);
            }
            return;
        }
        const nextFresh = new Set<string>();
        for (const item of pendingDepartures) {
            if (!seen.has(item.occupancyId)) {
                nextFresh.add(item.occupancyId);
                seen.add(item.occupancyId);
            }
        }
        if (nextFresh.size > 0) {
            setFreshIds((current) => new Set([...current, ...nextFresh]));
            // Decay the "fresh" state after one pulse cycle so it doesn't loop forever.
            const handle = window.setTimeout(() => {
                setFreshIds((current) => {
                    const next = new Set(current);
                    for (const id of nextFresh) next.delete(id);
                    return next;
                });
            }, 6000);
            return () => window.clearTimeout(handle);
        }
    }, [pendingDepartures]);

    const visible = useMemo(
        () => pendingDepartures.filter((item) => !hiddenIds.has(item.occupancyId)),
        [pendingDepartures, hiddenIds],
    );

    const handleQuickConfirm = useCallback(async (pending: PendingDepartureConfirmation) => {
        setBusyIds((current) => new Set(current).add(pending.occupancyId));
        // Optimistic removal — re-add on failure.
        setHiddenIds((current) => new Set(current).add(pending.occupancyId));

        try {
            const response = await fetch(`/api/${pending.domain}/occupancies/${pending.occupancyId}/confirm-departure`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            });
            if (!response.ok) {
                const body = await response.json().catch(() => ({})) as { error?: string };
                throw new Error(body.error || "Falha ao confirmar saída.");
            }
            toast.success(`Saída de ${pending.displayName ?? pending.doctorName} confirmada às ${new Date(pending.actualEndedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.`);
            startTransition(() => {
                router.refresh();
            });
        } catch (error) {
            // Rollback the optimistic hide.
            setHiddenIds((current) => {
                const next = new Set(current);
                next.delete(pending.occupancyId);
                return next;
            });
            toast.error(error instanceof Error ? error.message : "Falha ao confirmar saída.");
        } finally {
            setBusyIds((current) => {
                const next = new Set(current);
                next.delete(pending.occupancyId);
                return next;
            });
        }
    }, [router, startTransition]);

    return (
        <motion.aside
            className="board-audit-rail"
            variants={fadeRise}
            initial="initial"
            animate="animate"
            aria-label="Saídas verbalizadas pendentes de confirmação"
        >
            <header className="board-audit-rail__header">
                <span className="board-audit-rail__title">
                    <Shield size={14} strokeWidth={2.2} />
                    Saídas a confirmar
                </span>
                <span className={`board-audit-rail__count ${visible.length === 0 ? "zero" : ""}`.trim()}>
                    {visible.length}
                </span>
            </header>

            {visible.length === 0 ? (
                <div className="board-audit-rail__empty">
                    Nenhuma saída verbalizada aguardando revisão. Crédito flui automaticamente quando o sistema fecha por boundary ou você encerra direto.
                </div>
            ) : (
                <motion.ul
                    className="board-audit-rail__list"
                    variants={staggerList}
                    initial="initial"
                    animate="animate"
                >
                    <AnimatePresence initial={false}>
                        {visible.map((pending) => (
                            <PendingDepartureCard
                                key={pending.occupancyId}
                                pending={pending}
                                onOpenVerifier={onOpenVerifier}
                                onQuickConfirm={handleQuickConfirm}
                                isFresh={freshIds.has(pending.occupancyId)}
                                busy={busyIds.has(pending.occupancyId)}
                            />
                        ))}
                    </AnimatePresence>
                </motion.ul>
            )}
        </motion.aside>
    );
}
