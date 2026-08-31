"use client";

import { useMemo, useState } from "react";
import { ABAS_ADMIN, KairosTopo } from "@/components/kairos-topo";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, ChevronLeft, ChevronRight, Filter, Search } from "lucide-react";
import { PreviousShiftList } from "@/components/board/PreviousShiftList";
import { DepartureVerifier } from "@/components/board/DepartureVerifier";
import { fadeRise } from "@/lib/board/motion";
import type {
    PendingDepartureConfirmation,
    PreviousOperationalBoard,
    PreviousOperationalBucket,
    PreviousOperationalEntry,
} from "@/services/board.service";

type StatusFilter = "all" | "with-delta" | "pending" | "suspect";
type DomainFilter = "all" | "regulation" | "intervention";
type BucketFilter = "all" | PreviousOperationalBucket;

/** Filtros de turno englobam P: quem cobriu P invertido ou P estava no SD E no SN.
 *  Clicar SD revela todos que estavam no SD do plantão (inclui P e P invertido). */
function bucketMatchesFilter(filter: BucketFilter, bucket: PreviousOperationalBucket): boolean {
    if (filter === "all") return true;
    if (filter === bucket) return true;
    if (filter === "SD" && (bucket === "P" || bucket === "P_INVERTIDO")) return true;
    if (filter === "SN" && (bucket === "P" || bucket === "P_INVERTIDO")) return true;
    return false;
}

export function PreviousShiftGanttPage({
    board,
    pending,
}: {
    board: PreviousOperationalBoard;
    pending: PendingDepartureConfirmation[];
}) {
    const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
    const [domainFilter, setDomainFilter] = useState<DomainFilter>("all");
    const [bucketFilter, setBucketFilter] = useState<BucketFilter>("all");
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
            if (domainFilter !== "all" && entry.domain !== domainFilter) return false;
            if (!bucketMatchesFilter(bucketFilter, entry.bucket)) return false;
            if (needle.length > 0) {
                const haystack = `${entry.displayName ?? ""} ${entry.doctorName} ${entry.targetCode} ${entry.targetLabel} ${entry.roleLabel ?? ""}`.toLowerCase();
                if (!haystack.includes(needle)) return false;
            }
            const delta = entry.balanceMinutes ?? 0;
            const isPending = pendingByOccupancyId.has(entry.occupancyId);
            const suspect = isPending && (pendingByOccupancyId.get(entry.occupancyId)!.delayMinutes ?? 0) >= 60;
            switch (statusFilter) {
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
    }, [board.sections, statusFilter, domainFilter, bucketFilter, search, pendingByOccupancyId]);

    const stats = useMemo(() => ({
        total: board.totalEntries,
        pending: pending.length,
        suspect: pending.filter((p) => (p.delayMinutes ?? 0) >= 60).length,
    }), [board.totalEntries, pending]);

    return (
        <div className="pagina-kairos">
        <KairosTopo titulo="Turno anterior" abas={ABAS_ADMIN} />
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
                    <p>{resolveContextCopy(board)}</p>
                    {board.currentShiftLabel === "SN" && (
                        board.mode === "back-sn" ? (
                            <Link href="/historico/turno-anterior" className="historico-gantt-nav-pill">
                                <ChevronRight size={14} strokeWidth={2.2} /> Voltar para o SD recém-fechado
                            </Link>
                        ) : (
                            <Link href="/historico/turno-anterior?back=1" className="historico-gantt-nav-pill">
                                <ChevronLeft size={14} strokeWidth={2.2} /> Voltar 1 dia (SN editável)
                            </Link>
                        )
                    )}
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
            </section>

            <section className="historico-filter-rows">
                <div className="historico-filter-row" role="tablist" aria-label="Filtrar por domínio">
                    <span className="historico-filter-row__label">
                        <Filter size={12} strokeWidth={2.2} /> Setor
                    </span>
                    {([
                        { key: "all", label: "Todos" },
                        { key: "regulation", label: "Regulação" },
                        { key: "intervention", label: "Intervenção" },
                    ] as const).map((option) => (
                        <button
                            key={option.key}
                            type="button"
                            role="tab"
                            aria-selected={domainFilter === option.key}
                            className={`historico-gantt-filter-pill ${domainFilter === option.key ? "active" : ""}`.trim()}
                            onClick={() => setDomainFilter(option.key)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>

                <div className="historico-filter-row" role="tablist" aria-label="Filtrar por turno">
                    <span className="historico-filter-row__label">Turno</span>
                    {([
                        { key: "all", label: "Todos", title: "Todos os turnos" },
                        { key: "SD", label: "SD", title: "Quem cobriu o SD (inclui P e P invertido)" },
                        { key: "SN", label: "SN", title: "Quem cobriu o SN (inclui P e P invertido)" },
                        { key: "P", label: "P", title: "Quem atravessou SD e SN" },
                        { key: "P_INVERTIDO", label: "P inv", title: "Quem atravessou SN e SD seguinte" },
                    ] as const).map((option) => (
                        <button
                            key={option.key}
                            type="button"
                            role="tab"
                            aria-selected={bucketFilter === option.key}
                            title={option.title}
                            className={`historico-gantt-filter-pill ${bucketFilter === option.key ? "active" : ""}`.trim()}
                            onClick={() => setBucketFilter(option.key)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>

                <div className="historico-filter-row" role="tablist" aria-label="Filtrar por situação">
                    <span className="historico-filter-row__label">Situação</span>
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
                            aria-selected={statusFilter === option.key}
                            className={`historico-gantt-filter-pill ${statusFilter === option.key ? "active" : ""}`.trim()}
                            onClick={() => setStatusFilter(option.key)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </section>

            <PreviousShiftList
                entries={filteredEntries}
                pendingByOccupancyId={pendingByOccupancyId}
                onPendingClick={(_entry, pending) => setVerifierTarget(pending)}
            />

            <DepartureVerifier
                target={verifierTarget}
                onClose={() => setVerifierTarget(null)}
            />
        </main>
        </div>
    );
}

function formatOperationalDateLabel(operationalDate: string) {
    const match = /(\d{4})-(\d{2})-(\d{2})/.exec(operationalDate);
    if (!match) return operationalDate;
    const [, year, month, day] = match;
    return `${day}/${month}/${year}`;
}

function resolveContextCopy(board: PreviousOperationalBoard) {
    if (board.mode === "sd-only-current") {
        return "SN em curso — auditando o SD que acabou de fechar. Clique em chegada ou saída para corrigir (motivo obrigatório).";
    }
    if (board.mode === "back-sn") {
        return "Revendo o dia anterior. Apenas o SN aceita edição — SD, P e P invertido são contexto somente-leitura.";
    }
    return "Auditoria do fechamento. Clique em chegada ou saída para corrigir — um motivo é exigido.";
}
