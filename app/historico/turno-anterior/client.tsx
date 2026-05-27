"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, Filter, Search } from "lucide-react";
import { PreviousShiftGantt } from "@/components/board/PreviousShiftGantt";
import { DepartureVerifier } from "@/components/board/DepartureVerifier";
import { fadeRise } from "@/lib/board/motion";
import type {
    PendingDepartureConfirmation,
    PreviousOperationalBoard,
    PreviousOperationalEntry,
} from "@/services/board.service";

type FilterMode = "all" | "with-delta" | "pending" | "suspect";

export function PreviousShiftGanttPage({
    board,
    pending,
}: {
    board: PreviousOperationalBoard;
    pending: PendingDepartureConfirmation[];
}) {
    const [filter, setFilter] = useState<FilterMode>("all");
    const [search, setSearch] = useState("");
    const [verifierTarget, setVerifierTarget] = useState<PendingDepartureConfirmation | null>(null);

    const pendingByOccupancyId = useMemo(() => {
        const map = new Map<string, PendingDepartureConfirmation>();
        for (const item of pending) {
            map.set(item.occupancyId, item);
        }
        return map;
    }, [pending]);

    const filteredEntries = useMemo(() => {
        const allEntries: PreviousOperationalEntry[] = board.sections.flatMap((section) => section.entries);
        const needle = search.trim().toLowerCase();
        return allEntries.filter((entry) => {
            if (needle.length > 0) {
                const haystack = `${entry.displayName ?? ""} ${entry.doctorName} ${entry.targetCode} ${entry.targetLabel} ${entry.roleLabel ?? ""}`.toLowerCase();
                if (!haystack.includes(needle)) return false;
            }
            const delta = entry.balanceMinutes ?? 0;
            const isPending = pendingByOccupancyId.has(entry.occupancyId);
            const suspect = isPending && (pendingByOccupancyId.get(entry.occupancyId)!.delayMinutes ?? 0) >= 60;
            switch (filter) {
                case "with-delta":
                    return Math.abs(delta) >= 5;
                case "pending":
                    return isPending;
                case "suspect":
                    return suspect;
                default:
                    return true;
            }
        });
    }, [board.sections, filter, search, pendingByOccupancyId]);

    const stats = useMemo(() => ({
        total: board.totalEntries,
        pending: pending.length,
        suspect: pending.filter((p) => (p.delayMinutes ?? 0) >= 60).length,
    }), [board.totalEntries, pending]);

    return (
        <main className="historico-gantt-shell">
            <motion.header
                className="historico-gantt-hero"
                variants={fadeRise}
                initial="initial"
                animate="animate"
            >
                <div className="historico-gantt-hero__copy">
                    <Link href="/" className="historico-gantt-back">
                        <ArrowLeft size={14} strokeWidth={2.2} /> Voltar ao quadro
                    </Link>
                    <h1>Plantão anterior · {formatOperationalDateLabel(board.operationalDate)}</h1>
                    <p>Auditoria temporal das saídas e chegadas. Cada barra é uma ocupação fechada; clique para revisar.</p>
                </div>
                <div className="historico-gantt-hero__stats">
                    <div>
                        <strong>{stats.total}</strong>
                        <span>ocupações</span>
                    </div>
                    <div className={stats.pending > 0 ? "warn" : ""}>
                        <strong>{stats.pending}</strong>
                        <span>a confirmar</span>
                    </div>
                    <div className={stats.suspect > 0 ? "fraud" : ""}>
                        <strong>{stats.suspect}</strong>
                        <span>suspeitas (≥60min)</span>
                    </div>
                </div>
            </motion.header>

            <section className="historico-gantt-controls">
                <label className="historico-gantt-search">
                    <Search size={16} strokeWidth={2.2} />
                    <input
                        type="search"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Buscar médico, ramal, base, função..."
                        aria-label="Buscar no plantão anterior"
                    />
                </label>
                <div className="historico-gantt-filters" role="tablist" aria-label="Filtros">
                    <Filter size={14} strokeWidth={2.2} style={{ color: "var(--muted)", marginRight: 4 }} />
                    {([
                        { key: "all", label: "Todos" },
                        { key: "with-delta", label: "Com diferença" },
                        { key: "pending", label: "A confirmar" },
                        { key: "suspect", label: "Suspeitas" },
                    ] as const).map((option) => (
                        <button
                            key={option.key}
                            type="button"
                            role="tab"
                            aria-selected={filter === option.key}
                            className={`historico-gantt-filter-pill ${filter === option.key ? "active" : ""}`.trim()}
                            onClick={() => setFilter(option.key)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </section>

            <PreviousShiftGantt
                entries={filteredEntries}
                pendingByOccupancyId={pendingByOccupancyId}
                onEntryClick={(entry) => {
                    const pending = pendingByOccupancyId.get(entry.occupancyId);
                    if (pending) {
                        setVerifierTarget(pending);
                    }
                }}
            />

            <DepartureVerifier
                target={verifierTarget}
                onClose={() => setVerifierTarget(null)}
            />
        </main>
    );
}

function formatOperationalDateLabel(operationalDate: string) {
    const match = /(\d{4})-(\d{2})-(\d{2})/.exec(operationalDate);
    if (!match) return operationalDate;
    const [, year, month, day] = match;
    return `${day}/${month}/${year}`;
}
