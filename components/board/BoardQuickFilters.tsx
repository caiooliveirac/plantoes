"use client";

import { Search, X } from "lucide-react";

export type BoardRoleFilter = "all" | "regulation" | "intervention";
export type BoardStatusFilter = "all" | "waiting";

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

const DOMAIN_OPTIONS: { key: Exclude<BoardRoleFilter, "all">; label: string }[] = [
    { key: "regulation", label: "Regulação" },
    { key: "intervention", label: "Intervenção" },
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
                    <Search size={13} strokeWidth={2.2} />
                    <input
                        type="search"
                        value={search}
                        onChange={(event) => onSearchChange(event.target.value)}
                        placeholder="Buscar médico, ramal ou base"
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
                {DOMAIN_OPTIONS.map((option) => (
                    <button
                        key={option.key}
                        type="button"
                        role="tab"
                        aria-selected={roleFilter === option.key}
                        className={`board-filters__chip ${roleFilter === option.key ? "active" : ""}`.trim()}
                        onClick={() => onRoleFilterChange(roleFilter === option.key ? "all" : option.key)}
                    >
                        {option.label}
                    </button>
                ))}
                <button
                    type="button"
                    role="tab"
                    title="Ramais ou bases vagos"
                    aria-selected={statusFilter === "waiting"}
                    className={`board-filters__chip ${statusFilter === "waiting" ? "active" : ""}`.trim()}
                    onClick={() => onStatusFilterChange(statusFilter === "waiting" ? "all" : "waiting")}
                >
                    Sem cobertura
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={!hasActiveFilter}
                    className={`board-filters__chip ${!hasActiveFilter ? "active" : ""}`.trim()}
                    onClick={() => {
                        onRoleFilterChange("all");
                        onStatusFilterChange("all");
                        onSearchChange("");
                    }}
                >
                    Tudo
                </button>
                <span className="board-filters__match" aria-live="polite">
                    {hasActiveFilter ? `${matchedCount} de ${totalCount}` : `${totalCount} no quadro`}
                </span>
            </div>
        </section>
    );
}
