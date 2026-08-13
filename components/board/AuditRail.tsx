"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Shield } from "lucide-react";
import { PendingDepartureCard } from "@/components/board/PendingDepartureCard";
import { fadeRise, staggerList } from "@/lib/board/motion";
import { useQuickConfirmDeparture } from "@/lib/board/use-quick-confirm-departure";
import { triagePendingDeparture } from "@/modules/operational/departure-triage";
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
const AUDIT_RAIL_COLLAPSED_STORAGE_KEY = "board-audit-rail-collapsed";

export function AuditRail({ pendingDepartures, onOpenVerifier }: AuditRailProps) {
    const quickConfirm = useQuickConfirmDeparture();
    const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
    const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
    const seenIdsRef = useRef<Set<string>>(new Set());
    const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
    // Colapsado, o rail vira só a faixa "Saídas a confirmar · N" e deixa de
    // disputar espaço com o restante da tela. Preferência do chefe persiste;
    // sem preferência salva, telas estreitas começam colapsadas.
    const [collapsed, setCollapsed] = useState(false);

    useEffect(() => {
        try {
            const stored = window.localStorage.getItem(AUDIT_RAIL_COLLAPSED_STORAGE_KEY);
            if (stored !== null) {
                setCollapsed(stored === "1");
                return;
            }
        } catch {
            // localStorage indisponível (modo privado etc.) — segue o padrão.
        }

        if (window.matchMedia("(max-width: 720px)").matches) {
            setCollapsed(true);
        }
    }, []);

    function toggleCollapsed() {
        setCollapsed((previous) => {
            const next = !previous;
            try {
                window.localStorage.setItem(AUDIT_RAIL_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
            } catch {
                // Sem persistência não tem problema — só não lembra a escolha.
            }
            return next;
        });
    }

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

    // Triagem: casos com decisão de pagamento/banco em jogo vêm primeiro; o
    // resto é rotina, confirmável em lote.
    const { attention, routine } = useMemo(() => {
        const attention: PendingDepartureConfirmation[] = [];
        const routine: PendingDepartureConfirmation[] = [];
        for (const item of visible) {
            const triage = triagePendingDeparture({
                actualEndedAt: item.actualEndedAt,
                scheduledStartAt: item.scheduledStartAt,
                scheduledEndAt: item.scheduledEndAt,
                startedAt: item.startedAt,
                roleLabel: item.roleLabel,
                delayMinutes: item.delayMinutes,
                reasonCode: item.reasonCode,
                occurrenceNumberMissing: item.occurrenceNumberMissing,
                reasonOccurrenceCount30d: item.reasonOccurrenceCount30d,
            });
            (triage.attention ? attention : routine).push(item);
        }
        return { attention, routine };
    }, [visible]);

    const [confirmingAll, setConfirmingAll] = useState(false);

    const handleQuickConfirm = useCallback(async (pending: PendingDepartureConfirmation) => {
        setBusyIds((current) => new Set(current).add(pending.occupancyId));
        // Optimistic removal — re-add on failure so the chefe doesn't lose the card.
        setHiddenIds((current) => new Set(current).add(pending.occupancyId));

        const result = await quickConfirm(pending);
        if (!result.ok) {
            setHiddenIds((current) => {
                const next = new Set(current);
                next.delete(pending.occupancyId);
                return next;
            });
        }
        setBusyIds((current) => {
            const next = new Set(current);
            next.delete(pending.occupancyId);
            return next;
        });
    }, [quickConfirm]);

    // Confirma toda a rotina em sequência pelo endpoint existente. ponytail:
    // loop sequencial, sem endpoint de lote — a fila de rotina raramente passa
    // de algumas dezenas; criar API nova se virar gargalo.
    const handleConfirmAllRoutine = useCallback(async () => {
        setConfirmingAll(true);
        for (const item of routine) {
            await handleQuickConfirm(item);
        }
        setConfirmingAll(false);
    }, [routine, handleQuickConfirm]);

    return (
        <motion.aside
            className={`board-audit-rail ${collapsed ? "collapsed" : ""}`.trim()}
            variants={fadeRise}
            initial="initial"
            animate="animate"
            aria-label="Saídas verbalizadas pendentes de confirmação"
        >
            <button
                type="button"
                className="board-audit-rail__header"
                onClick={toggleCollapsed}
                aria-expanded={!collapsed}
                title={collapsed ? "Expandir saídas a confirmar" : "Recolher saídas a confirmar"}
            >
                <span className="board-audit-rail__title">
                    <Shield size={14} strokeWidth={2.2} />
                    Saídas a confirmar
                </span>
                <span className="board-audit-rail__header-end">
                    <span className={`board-audit-rail__count ${visible.length === 0 ? "zero" : ""}`.trim()}>
                        {visible.length}
                    </span>
                    <span className="board-audit-rail__chevron" aria-hidden="true">{collapsed ? "▾" : "▴"}</span>
                </span>
            </button>

            {collapsed ? null : visible.length === 0 ? (
                <div className="board-audit-rail__empty">
                    Nenhuma saída verbalizada aguardando revisão. Crédito flui automaticamente quando o sistema fecha por boundary ou você encerra direto.
                </div>
            ) : (
                <>
                    {attention.length > 0 && (
                        <>
                            <div className="board-audit-rail__section">Precisa de decisão · {attention.length}</div>
                            <motion.ul
                                className="board-audit-rail__list"
                                variants={staggerList}
                                initial="initial"
                                animate="animate"
                            >
                                <AnimatePresence initial={false}>
                                    {attention.map((pending) => (
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
                        </>
                    )}
                    {routine.length > 0 && (
                        <>
                            <div className="board-audit-rail__section board-audit-rail__section--routine">
                                <span>Rotina · {routine.length}</span>
                                <button
                                    type="button"
                                    className="board-audit-rail__confirm-all"
                                    onClick={() => { void handleConfirmAllRoutine(); }}
                                    disabled={confirmingAll}
                                    title="Confirma todas as saídas sem impacto em pagamento ou banco de horas."
                                >
                                    {confirmingAll ? "Confirmando…" : `Confirmar todas (${routine.length})`}
                                </button>
                            </div>
                            <motion.ul
                                className="board-audit-rail__list"
                                variants={staggerList}
                                initial="initial"
                                animate="animate"
                            >
                                <AnimatePresence initial={false}>
                                    {routine.map((pending) => (
                                        <PendingDepartureCard
                                            key={pending.occupancyId}
                                            pending={pending}
                                            onOpenVerifier={onOpenVerifier}
                                            onQuickConfirm={handleQuickConfirm}
                                            isFresh={freshIds.has(pending.occupancyId)}
                                            busy={busyIds.has(pending.occupancyId) || confirmingAll}
                                        />
                                    ))}
                                </AnimatePresence>
                            </motion.ul>
                        </>
                    )}
                </>
            )}
        </motion.aside>
    );
}
