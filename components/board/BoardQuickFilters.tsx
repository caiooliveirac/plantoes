"use client";

import { Filter, Search, X } from "lucide-react";

export type BoardRoleFilter = "all" | "CP" | "MRV" | "RECIP" | "COI" | "IES" | "RMT" | "PSIQ" | "PIAM";
export type BoardStatusFilter = "all" | "critical" | "watch" | "waiting";

interface BoardQuickFiltersProps {
    roleFilter: BoardRoleFilter;
    onRoleFilterChange: (value: BoardRoleFilter) => void;
    statusFilter: BoardStatusFilter;
    onStatusFilterChange: (value: BoardStatusFilter) => void;
    search: string;
    onSearchChange: (value: string) => void;
    matchedCount: number;
    totalCount: number;
}

const ROLE_OPTIONS: { key: BoardRoleFilter; label: string }[] = [
    { key: "all", label: "Todos" },
    { key: "CP", label: "CP" },
    { key: "MRV", label: "MRV" },
    { key: "RECIP", label: "RECIP" },
    { key: "COI", label: "COI" },
    { key: "IES", label: "IES" },
    { key: "RMT", label: "RMT" },
    { key: "PSIQ", label: "PSIQ" },
    { key: "PIAM", label: "PIAM" },
];

const STATUS_OPTIONS: { key: BoardStatusFilter; label: string; title: string }[] = [
    { key: "all", label: "Tudo", title: "Sem filtro de status" },
    { key: "critical", label: "Críticos", title: "Sem cobertura confirmada ou ramal/base aguardando" },
    { key: "watch", label: "Vigiar", title: "Cobertura prolongada (≥12h)" },
    { key: "waiting", label: "Sem cobertura", title: "Ramais ou bases vagos" },
];

export function BoardQuickFilters({
    roleFilter,
    onRoleFilterChange,
    statusFilter,
    onStatusFilterChange,
    search,
    onSearchChange,
    matchedCount,
    totalCount,
}: BoardQuickFiltersProps) {
    const hasActiveFilter = roleFilter !== "all" || statusFilter !== "all" || search.length > 0;

    return (
        <section className="board-filters">
            <div className="board-filters__row">
                <label className="board-filters__search">
                    <Search size={14} strokeWidth={2.2} />
                    <input
                        type="search"
                        value={search}
                        onChange={(event) => onSearchChange(event.target.value)}
                        placeholder="Buscar médico, ramal ou base..."
                        aria-label="Buscar no quadro"
                    />
                    {search && (
                        <button
                            type="button"
                            className="board-filters__clear"
                            onClick={() => onSearchChange("")}
                            aria-label="Limpar busca"
                        >
                            <X size={12} strokeWidth={2.2} />
                        </button>
                    )}
                </label>

                <span className="board-filters__match" aria-live="polite">
                    {hasActiveFilter
                        ? `${matchedCount} de ${totalCount}`
                        : `${totalCount} no quadro`}
                </span>
            </div>

            <div className="board-filters__row">
                <span className="board-filters__label">
                    <Filter size={12} strokeWidth={2.2} /> Função
                </span>
                {ROLE_OPTIONS.map((option) => (
                    <button
                        key={option.key}
                        type="button"
                        role="tab"
                        aria-selected={roleFilter === option.key}
                        className={`board-filters__chip ${roleFilter === option.key ? "active" : ""}`.trim()}
                        onClick={() => onRoleFilterChange(option.key)}
                    >
                        {option.label}
                    </button>
                ))}
            </div>

            <div className="board-filters__row">
                <span className="board-filters__label">Status</span>
                {STATUS_OPTIONS.map((option) => (
                    <button
                        key={option.key}
                        type="button"
                        role="tab"
                        title={option.title}
                        aria-selected={statusFilter === option.key}
                        className={`board-filters__chip ${statusFilter === option.key ? "active" : ""}`.trim()}
                        onClick={() => onStatusFilterChange(option.key)}
                    >
                        {option.label}
                    </button>
                ))}
            </div>
        </section>
    );
}
