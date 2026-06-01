"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeftRight } from "lucide-react";
import { fadeRise, staggerList } from "@/lib/board/motion";
import type { RecentHandoff } from "@/services/board.service";

export interface RecentHandoffsRailProps {
    recentHandoffs: RecentHandoff[];
}

function formatHandoffTime(iso: string) {
    const date = new Date(iso);
    return date.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Sao_Paulo",
    });
}

/**
 * Informational rail telling the chefe that a rendição happened: "B rendeu A na BR60".
 * Purely awareness — NO confirm/finalize affordance. The predecessor's exit was already
 * closed at the handoff time and the bank credited; a late occurrence notice from the
 * predecessor will reopen it through the normal "Saídas a confirmar" path. Each card is
 * dismissible locally (chefe acknowledges) without touching any occupancy state.
 */
export function RecentHandoffsRail({ recentHandoffs }: RecentHandoffsRailProps) {
    const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

    const visible = useMemo(
        () => recentHandoffs.filter((item) => !dismissedIds.has(item.occupancyId)),
        [recentHandoffs, dismissedIds],
    );

    if (visible.length === 0) {
        return null;
    }

    const dismiss = (occupancyId: string) =>
        setDismissedIds((current) => new Set(current).add(occupancyId));

    return (
        <motion.aside
            className="board-handoff-rail"
            variants={fadeRise}
            initial="initial"
            animate="animate"
            aria-label="Rendições recentes"
        >
            <header className="board-handoff-rail__header">
                <span className="board-handoff-rail__title">
                    <ArrowLeftRight size={14} strokeWidth={2.2} />
                    Rendições recentes
                </span>
                <span className="board-handoff-rail__count">{visible.length}</span>
            </header>

            <motion.ul
                className="board-handoff-rail__list"
                variants={staggerList}
                initial="initial"
                animate="animate"
            >
                <AnimatePresence initial={false}>
                    {visible.map((item) => {
                        const successor = item.successorDisplayName ?? item.successorName;
                        const predecessor = item.predecessorDisplayName ?? item.predecessorName;
                        return (
                            <motion.li
                                key={item.occupancyId}
                                className="board-handoff-rail__item"
                                variants={fadeRise}
                                exit={{ opacity: 0, height: 0 }}
                            >
                                <div className="board-handoff-rail__line">
                                    <strong>{successor}</strong> rendeu <strong>{predecessor}</strong>
                                    {" "}na {item.targetCode}
                                </div>
                                <div className="board-handoff-rail__meta">
                                    <span>{formatHandoffTime(item.handoffAt)}</span>
                                    <button
                                        type="button"
                                        className="board-handoff-rail__ack"
                                        onClick={() => dismiss(item.occupancyId)}
                                    >
                                        Ok, ciente
                                    </button>
                                </div>
                            </motion.li>
                        );
                    })}
                </AnimatePresence>
            </motion.ul>
        </motion.aside>
    );
}
