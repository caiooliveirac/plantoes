"use client";

import { useMemo } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Flame, History, Stethoscope, Truck } from "lucide-react";
import { fadeRise } from "@/lib/board/motion";

interface BoardHeroProps {
    shiftLabel: string;
    generatedAt: string;
    regulationOccupied: number;
    regulationFree: number;
    interventionActive: number;
    interventionWaiting: number;
    criticalCount: number;
    canManage: boolean;
    onOpenCriticalQueue?: () => void;
}

function formatDateLabel(iso: string) {
    return new Date(iso).toLocaleDateString("pt-BR", {
        weekday: "long",
        day: "2-digit",
        month: "long",
        timeZone: "America/Sao_Paulo",
    });
}

export function BoardHero({
    shiftLabel,
    generatedAt,
    regulationOccupied,
    regulationFree,
    interventionActive,
    interventionWaiting,
    criticalCount,
    canManage,
    onOpenCriticalQueue,
}: BoardHeroProps) {
    const dateLabel = useMemo(() => formatDateLabel(generatedAt), [generatedAt]);

    const shiftTone = shiftLabel === "SN" ? "green" : "ice";
    const shiftLong = shiftLabel === "SN" ? "Noturno" : shiftLabel === "SD" ? "Diurno" : shiftLabel;

    return (
        <motion.section
            className="board-hero"
            variants={fadeRise}
            initial="initial"
            animate="animate"
            aria-label="Resumo do plantão atual"
        >
            <div className="board-hero__shift">
                <span className={`board-hero__chip tone-${shiftTone}`}>{shiftLabel}</span>
                <div>
                    <h1>{shiftLong} em curso</h1>
                    <p>{dateLabel}</p>
                </div>
            </div>

            <div className="board-hero__stats">
                <article className="board-hero__stat">
                    <Stethoscope size={14} strokeWidth={2.2} />
                    <strong>{regulationOccupied}</strong>
                    <span>regulação{regulationFree > 0 ? ` · ${regulationFree} livre${regulationFree > 1 ? "s" : ""}` : ""}</span>
                </article>
                <article className="board-hero__stat">
                    <Truck size={14} strokeWidth={2.2} />
                    <strong>{interventionActive}</strong>
                    <span>intervenção{interventionWaiting > 0 ? ` · ${interventionWaiting} sem cobertura` : ""}</span>
                </article>
                <article className={`board-hero__stat ${criticalCount > 0 ? "is-critical" : ""}`.trim()}>
                    <Flame size={14} strokeWidth={2.2} />
                    <strong>{criticalCount}</strong>
                    <span>crítico{criticalCount === 1 ? "" : "s"}</span>
                </article>
            </div>

            {canManage && (
                <div className="board-hero__actions">
                    {onOpenCriticalQueue && criticalCount > 0 && (
                        <button
                            type="button"
                            className="board-hero__action critical"
                            onClick={onOpenCriticalQueue}
                        >
                            <Flame size={14} strokeWidth={2.2} />
                            Fila crítica ({criticalCount})
                        </button>
                    )}
                    <Link href="/historico/turno-anterior" className="board-hero__action">
                        <History size={14} strokeWidth={2.2} />
                        Plantão anterior
                    </Link>
                </div>
            )}
        </motion.section>
    );
}
