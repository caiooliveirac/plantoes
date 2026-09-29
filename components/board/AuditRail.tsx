"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Shield } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PendingDepartureCard } from "@/components/board/PendingDepartureCard";
import { fadeRise, staggerList } from "@/lib/board/motion";
import { useQuickConfirmDeparture } from "@/lib/board/use-quick-confirm-departure";
import { resolveDepartureAutonomy, type DepartureAutonomyResult } from "@/modules/operational/departure-autonomy";
import type { PendingDepartureConfirmation } from "@/services/board.service";
import type { SystemConfirmedDeparture } from "@/services/departure-autonomy.service";

function hourMinute(iso: string) {
    const date = new Date(iso);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

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
/** Recolhido com decisão pendente, o rail volta à frente depois disto. */
const BRING_FORWARD_AFTER_MS = 20 * 60_000;
/** Duração do destaque ao vir à frente. */
const FORWARD_HIGHLIGHT_MS = 6_000;

export function AuditRail({ pendingDepartures, onOpenVerifier }: AuditRailProps) {
    const quickConfirm = useQuickConfirmDeparture();
    const router = useRouter();
    // O que o sistema confirmou sozinho (docs/saidas-a-confirmar.md) e se o
    // automático está ligado — o rail só promete "confirma sozinho" quando está.
    const [system, setSystem] = useState<{ mode: "on" | "sombra" | "off"; items: SystemConfirmedDeparture[] } | null>(null);
    const [undoingId, setUndoingId] = useState<string | null>(null);
    const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
    const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
    const seenIdsRef = useRef<Set<string>>(new Set());
    const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
    // Colapsado, o rail vira só a faixa "Saídas a confirmar · N" e deixa de
    // disputar espaço com o restante da tela. Preferência do chefe persiste;
    // sem preferência salva, começa colapsado: expandido ele cobre a coluna de
    // intervenção inteira, e quem loga com a fila cheia não enxerga o quadro.
    const [collapsed, setCollapsed] = useState(true);
    // Vir à frente: a chefia vinha ignorando a fila recolhida. Com saída que só
    // ela decide, o rail se abre sozinho — ao chegar uma nova e de novo a cada
    // 20 min recolhido. Recolher continua valendo até lá.
    const [forward, setForward] = useState(false);
    const collapsedSinceRef = useRef(Date.now());
    const seenDecideIdsRef = useRef<Set<string>>(new Set());

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
    }, []);

    function toggleCollapsed() {
        setForward(false);
        setCollapsed((previous) => {
            const next = !previous;
            if (next) collapsedSinceRef.current = Date.now();
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

    // Três classes (modules/operational/departure-autonomy.ts): o que precisa
    // do chefe vem primeiro; depois o que tem sugestão pronta; a rotina por último.
    const { assessments, decide, glance, routine } = useMemo(() => {
        const assessments = new Map<string, DepartureAutonomyResult>();
        const decide: PendingDepartureConfirmation[] = [];
        const glance: PendingDepartureConfirmation[] = [];
        const routine: PendingDepartureConfirmation[] = [];
        for (const item of visible) {
            const assessment = resolveDepartureAutonomy(item);
            assessments.set(item.occupancyId, assessment);
            (assessment.autonomy === "decide" ? decide : assessment.autonomy === "glance" ? glance : routine).push(item);
        }
        return { assessments, decide, glance, routine };
    }, [visible]);

    const [confirmingAll, setConfirmingAll] = useState(false);

    const loadSystem = useCallback(async () => {
        try {
            const response = await fetch("/api/operational/auto-confirmed-departures");
            if (response.ok) setSystem(await response.json());
        } catch {
            // Sem a lista o rail segue funcionando; só não mostra o Desfazer.
        }
    }, []);

    useEffect(() => {
        if (!collapsed) void loadSystem();
    }, [collapsed, pendingDepartures, loadSystem]);

    const undoSystemConfirmation = useCallback(async (item: SystemConfirmedDeparture) => {
        setUndoingId(item.occupancyId);
        try {
            const response = await fetch("/api/operational/auto-confirmed-departures", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ domain: item.domain, occupancyId: item.occupancyId }),
            });
            const body = await response.json().catch(() => ({})) as { error?: string };
            if (!response.ok) throw new Error(body.error || "Falha ao desfazer.");
            toast.success(`${item.doctorName}: volta para a fila, agora com você.`);
            router.refresh();
            await loadSystem();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Falha ao desfazer.");
        } finally {
            setUndoingId(null);
        }
    }, [router, loadSystem]);

    const automatic = system?.mode === "on";

    // Aberto, o que está em "Precisa de você" conta como visto.
    useEffect(() => {
        if (collapsed) return;
        for (const item of decide) seenDecideIdsRef.current.add(item.occupancyId);
    }, [collapsed, decide]);

    useEffect(() => {
        if (!collapsed || decide.length === 0) return;
        const bringForward = () => {
            const hasUnseen = decide.some((item) => !seenDecideIdsRef.current.has(item.occupancyId));
            if (!hasUnseen && Date.now() - collapsedSinceRef.current < BRING_FORWARD_AFTER_MS) return;
            setCollapsed(false);
            setForward(true);
        };
        bringForward();
        const handle = window.setInterval(bringForward, 60_000);
        return () => window.clearInterval(handle);
    }, [collapsed, decide]);

    useEffect(() => {
        if (!forward) return;
        const handle = window.setTimeout(() => setForward(false), FORWARD_HIGHLIGHT_MS);
        return () => window.clearTimeout(handle);
    }, [forward]);

    const handleQuickConfirm = useCallback(async (pending: PendingDepartureConfirmation, outcome: "full_shift" | null = null) => {
        setBusyIds((current) => new Set(current).add(pending.occupancyId));
        // Optimistic removal — re-add on failure so the chefe doesn't lose the card.
        setHiddenIds((current) => new Set(current).add(pending.occupancyId));

        const result = await quickConfirm(pending, outcome);
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
            className={`board-audit-rail ${collapsed ? "collapsed" : ""} ${forward ? "forward" : ""}`.trim()}
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
                    <span
                        className={`board-audit-rail__count ${visible.length === 0 ? "zero" : decide.length > 0 ? "urgent" : ""}`.trim()}
                        title={decide.length > 0 ? `${decide.length} precisa(m) de você` : undefined}
                    >
                        {visible.length}
                    </span>
                    <span className="board-audit-rail__chevron" aria-hidden="true">{collapsed ? "▾" : "▴"}</span>
                </span>
            </button>

            {collapsed ? null : visible.length === 0 ? (
                <div className="board-audit-rail__empty">
                    Nenhuma saída aguardando revisão.
                </div>
            ) : (
                <>
                    {decide.length > 0 && (
                        <>
                            <div className="board-audit-rail__section">Precisa de você · {decide.length}</div>
                            <motion.ul
                                className="board-audit-rail__list"
                                variants={staggerList}
                                initial="initial"
                                animate="animate"
                            >
                                <AnimatePresence initial={false}>
                                    {decide.map((pending) => (
                                        <PendingDepartureCard
                                            key={pending.occupancyId}
                                            pending={pending}
                                            assessment={assessments.get(pending.occupancyId)!}
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
                    {glance.length > 0 && (
                        <>
                            <div className="board-audit-rail__section">
                                <span>
                                    Confira a sugestão · {glance.length}
                                    {automatic ? <span className="board-audit-rail__section-hint">aplicada sozinha após 24h</span> : null}
                                </span>
                            </div>
                            <motion.ul
                                className="board-audit-rail__list"
                                variants={staggerList}
                                initial="initial"
                                animate="animate"
                            >
                                <AnimatePresence initial={false}>
                                    {glance.map((pending) => (
                                        <PendingDepartureCard
                                            key={pending.occupancyId}
                                            pending={pending}
                                            assessment={assessments.get(pending.occupancyId)!}
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
                                <span>
                                    Rotina · {routine.length}
                                    {automatic ? <span className="board-audit-rail__section-hint">confirma sozinha na virada</span> : null}
                                </span>
                                <button
                                    type="button"
                                    className="board-audit-rail__confirm-all"
                                    onClick={() => { void handleConfirmAllRoutine(); }}
                                    disabled={confirmingAll}
                                    title="Confirma todas as saídas de rotina (avisadas pelo médico ou explicadas pela chegada de quem assumiu)."
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
                                            assessment={assessments.get(pending.occupancyId)!}
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

            {!collapsed && system && system.items.length > 0 && (
                <details className="board-audit-rail__system">
                    <summary>Confirmadas pelo sistema · {system.items.length}</summary>
                    <ul className="board-audit-rail__system-list">
                        {system.items.map((item) => (
                            <li key={item.occupancyId}>
                                <span>
                                    <strong>{item.doctorName}</strong> · {item.targetCode} · saiu {hourMinute(item.actualEndedAt)}
                                </span>
                                <button
                                    type="button"
                                    className="board-audit-rail__system-undo"
                                    onClick={() => { void undoSystemConfirmation(item); }}
                                    disabled={undoingId === item.occupancyId}
                                    title={item.note}
                                >
                                    {undoingId === item.occupancyId ? "Desfazendo…" : "Desfazer"}
                                </button>
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </motion.aside>
    );
}
