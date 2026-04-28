"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Clock3, Flame, History, ListChecks, Stethoscope, Truck } from "lucide-react";
import { fadeRise } from "@/lib/board/motion";

interface BoardHeroProps {
    shiftLabel: string;
    generatedAt: string;
    regulationOccupied: number;
    regulationFree: number;
    interventionActive: number;
    interventionWaiting: number;
    criticalCount: number;
    pendingDeparturesCount: number;
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

function nextBoundaryIso(reference: Date): { iso: string; label: "07:00" | "19:00" } {
    const local = new Date(reference.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const hour = local.getHours();
    const target = new Date(local);
    if (hour < 7) {
        target.setHours(7, 0, 0, 0);
        return { iso: target.toISOString(), label: "07:00" };
    }
    if (hour < 19) {
        target.setHours(19, 0, 0, 0);
        return { iso: target.toISOString(), label: "19:00" };
    }
    target.setDate(target.getDate() + 1);
    target.setHours(7, 0, 0, 0);
    return { iso: target.toISOString(), label: "07:00" };
}

function useCountdown(targetIso: string) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const handle = window.setInterval(() => setNow(Date.now()), 30000);
        return () => window.clearInterval(handle);
    }, []);
    const diffMs = new Date(targetIso).getTime() - now;
    if (diffMs <= 0) return "iminente";
    const minutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours > 0) return `${hours}h${String(mins).padStart(2, "0")}`;
    return `${mins}min`;
}

export function BoardHero({
    shiftLabel,
    generatedAt,
    regulationOccupied,
    regulationFree,
    interventionActive,
    interventionWaiting,
    criticalCount,
    pendingDeparturesCount,
    canManage,
    onOpenCriticalQueue,
}: BoardHeroProps) {
    const boundary = useMemo(() => nextBoundaryIso(new Date(generatedAt)), [generatedAt]);
    const countdown = useCountdown(boundary.iso);
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
                {canManage && (
                    <article className={`board-hero__stat ${pendingDeparturesCount > 0 ? "is-warn" : ""}`.trim()}>
                        <ListChecks size={14} strokeWidth={2.2} />
                        <strong>{pendingDeparturesCount}</strong>
                        <span>a confirmar</span>
                    </article>
                )}
                <article className="board-hero__stat board-hero__stat--countdown">
                    <Clock3 size={14} strokeWidth={2.2} />
                    <strong>{countdown}</strong>
                    <span>até {boundary.label}</span>
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
