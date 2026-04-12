"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { ChiefPayableBoardModel } from "@/modules/reporting/payable-shifts";

interface Props {
    board: ChiefPayableBoardModel;
}

type PaymentStatusFilter = "all" | "ready_for_payment" | "needs_review";
type ShiftFilter = "all" | "SD" | "SN";
type DomainFilter = "all" | "regulation" | "intervention";
type SortMode = "name" | "total" | "pending" | "sd" | "sn";

const TARGET_PRIORITY_NUMBERS = [1, 2, 3, 4, 5, 10, 20] as const;

function parseTargetPriority(code: string) {
    const match = code.match(/(\d{1,2})(?!.*\d)/);
    if (!match) {
        return Number.POSITIVE_INFINITY;
    }

    const value = Number(match[1]);
    if (!Number.isFinite(value)) {
        return Number.POSITIVE_INFINITY;
    }

    return value;
}

function targetCodeRank(code: string) {
    const numeric = parseTargetPriority(code);
    const priorityIndex = TARGET_PRIORITY_NUMBERS.findIndex((entry) => entry === numeric);

    return {
        priorityIndex: priorityIndex === -1 ? Number.POSITIVE_INFINITY : priorityIndex,
        numeric,
    };
}

function targetComparator(
    left: { targetCode: string; targetLabel: string },
    right: { targetCode: string; targetLabel: string },
) {
    const leftRank = targetCodeRank(left.targetCode);
    const rightRank = targetCodeRank(right.targetCode);

    if (leftRank.priorityIndex !== rightRank.priorityIndex) {
        return leftRank.priorityIndex - rightRank.priorityIndex;
    }

    if (leftRank.numeric !== rightRank.numeric) {
        return leftRank.numeric - rightRank.numeric;
    }

    return left.targetCode.localeCompare(right.targetCode, "pt-BR") || left.targetLabel.localeCompare(right.targetLabel, "pt-BR");
}

function normalize(value: string) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

function cellAuditLink(monthKey: string, day: string, shift: "SD" | "SN") {
    return `/admin/payment-attestation/audit?date=${monthKey}-${day}&shift=${shift}`;
}

export function ChiefPaymentViewClient({ board }: Props) {
    const [search, setSearch] = useState("");
    const [targetSearch, setTargetSearch] = useState("");
    const [status, setStatus] = useState<PaymentStatusFilter>("all");
    const [shiftFilter, setShiftFilter] = useState<ShiftFilter>("all");
    const [domainFilter, setDomainFilter] = useState<DomainFilter>("all");
    const [targetFilter, setTargetFilter] = useState("all");
    const [sortMode, setSortMode] = useState<SortMode>("pending");
    const [manualDraft, setManualDraft] = useState<{
        domain: "regulation" | "intervention";
        targetCode: string;
        targetLabel: string;
        day: string;
        shiftLabel: "SD" | "SN";
        sourceType: "disabled" | "uncovered";
        reason: string | null;
    } | null>(null);
    const [manualDoctorName, setManualDoctorName] = useState("");
    const [manualBusy, setManualBusy] = useState(false);
    const [manualError, setManualError] = useState<string | null>(null);
    const [manualFeedback, setManualFeedback] = useState<string | null>(null);
    const normalized = normalize(search);
    const normalizedTarget = normalize(targetSearch);

    const targetPills = useMemo(() => {
        const filtered = board.targetOptions.filter((target) => {
            if (domainFilter !== "all" && target.domain !== domainFilter) {
                return false;
            }

            if (!normalizedTarget) {
                return true;
            }

            const haystack = normalize([target.targetCode, target.targetLabel].join(" "));
            return haystack.includes(normalizedTarget);
        });

        return filtered;
    }, [board.targetOptions, domainFilter, normalizedTarget]);

    const targetSectors = useMemo(() => {
        const base = targetPills
            .map((target) => ({
                ...target,
                isUsa: normalize(`${target.targetCode} ${target.targetLabel}`).includes("usa"),
            }))
            .sort(targetComparator);

        const usa = base.filter((target) => target.isUsa);
        const regulation = base.filter((target) => target.domain === "regulation" && !target.isUsa);
        const intervention = base.filter((target) => target.domain === "intervention" && !target.isUsa);

        return [
            { key: "usa", title: "USA", tone: "usa", targets: usa },
            { key: "regulation", title: "Regulação", tone: "regulation", targets: regulation },
            { key: "intervention", title: "Intervenção", tone: "intervention", targets: intervention },
        ].filter((sector) => sector.targets.length > 0);
    }, [targetPills]);

    const filterSummary = useMemo(() => {
        const readyDoctors = board.doctors.filter((doctor) => doctor.paymentStatus === "ready_for_payment").length;
        const reviewDoctors = board.doctors.length - readyDoctors;
        const sdCount = board.payableShifts.filter((shift) => shift.shiftLabel === "SD").length;
        const snCount = board.payableShifts.filter((shift) => shift.shiftLabel === "SN").length;
        const regulationCount = board.payableShifts.filter((shift) => shift.domain === "regulation").length;
        const interventionCount = board.payableShifts.filter((shift) => shift.domain === "intervention").length;

        return {
            readyDoctors,
            reviewDoctors,
            sdCount,
            snCount,
            regulationCount,
            interventionCount,
        };
    }, [board.doctors, board.payableShifts]);

    const dayLoad = useMemo(() => {
        const counts = new Map<string, number>();
        for (const shift of board.payableShifts) {
            const day = shift.operationalDate.slice(8, 10);
            counts.set(day, (counts.get(day) ?? 0) + 1);
        }

        return board.days.map((day) => ({ day, count: counts.get(day) ?? 0 }));
    }, [board.days, board.payableShifts]);

    const visibleDisabledTargets = useMemo(() => board.disabledTargets.filter((item) => {
        if (shiftFilter !== "all" && item.shiftLabel !== shiftFilter) {
            return false;
        }

        if (domainFilter !== "all" && item.domain !== domainFilter) {
            return false;
        }

        if (targetFilter !== "all") {
            const [targetDomain, targetCode] = targetFilter.split("|");
            if (item.domain !== targetDomain || item.targetCode !== targetCode) {
                return false;
            }
        }

        if (!normalizedTarget) {
            return true;
        }

        const haystack = normalize([item.targetCode, item.targetLabel, item.disabledReason ?? ""].join(" "));
        return haystack.includes(normalizedTarget);
    }), [board.disabledTargets, domainFilter, normalizedTarget, shiftFilter, targetFilter]);

    const disabledByDay = useMemo(() => {
        const map = new Map<string, typeof visibleDisabledTargets>();
        for (const item of visibleDisabledTargets) {
            const key = item.day;
            const bucket = map.get(key) ?? [];
            bucket.push(item);
            map.set(key, bucket);
        }

        return map;
    }, [visibleDisabledTargets]);

    const visibleUncoveredTargets = useMemo(() => board.uncoveredTargets.filter((item) => {
        if (shiftFilter !== "all" && item.shiftLabel !== shiftFilter) {
            return false;
        }

        if (domainFilter !== "all" && item.domain !== domainFilter) {
            return false;
        }

        if (targetFilter !== "all") {
            const [targetDomain, targetCode] = targetFilter.split("|");
            if (item.domain !== targetDomain || item.targetCode !== targetCode) {
                return false;
            }
        }

        if (!normalizedTarget) {
            return true;
        }

        const haystack = normalize([item.targetCode, item.targetLabel, item.reason ?? ""].join(" "));
        return haystack.includes(normalizedTarget);
    }), [board.uncoveredTargets, domainFilter, normalizedTarget, shiftFilter, targetFilter]);

    const uncoveredByDay = useMemo(() => {
        const map = new Map<string, typeof visibleUncoveredTargets>();
        for (const item of visibleUncoveredTargets) {
            const key = item.day;
            const bucket = map.get(key) ?? [];
            bucket.push(item);
            map.set(key, bucket);
        }

        return map;
    }, [visibleUncoveredTargets]);

    const peakDay = useMemo(() => {
        if (dayLoad.length === 0) {
            return null;
        }

        return [...dayLoad].sort((left, right) => right.count - left.count)[0] ?? null;
    }, [dayLoad]);

    const maxDayLoad = useMemo(() => Math.max(...dayLoad.map((entry) => entry.count), 1), [dayLoad]);

    const filteredDoctors = useMemo(() => {
        const doctors = board.doctors
            .map((doctor) => {
                const nextCells = doctor.cells.map((cell) => ({
                    ...cell,
                    shifts: cell.shifts.filter((shift) => {
                        if (shiftFilter !== "all" && shift.shiftLabel !== shiftFilter) {
                            return false;
                        }

                        if (domainFilter !== "all" && shift.domain !== domainFilter) {
                            return false;
                        }

                        if (targetFilter !== "all") {
                            const [targetDomain, targetCode] = targetFilter.split("|");
                            if (shift.domain !== targetDomain || shift.targetCode !== targetCode) {
                                return false;
                            }
                        }

                        if (!normalizedTarget) {
                            return true;
                        }

                        const targetHaystack = normalize([shift.targetCode, shift.targetLabel, shift.tagCode].join(" "));
                        return targetHaystack.includes(normalizedTarget);
                    }),
                }));

                const visibleShifts = nextCells.flatMap((cell) => cell.shifts);
                const totalSD = visibleShifts.filter((shift) => shift.shiftLabel === "SD").length;
                const totalSN = visibleShifts.filter((shift) => shift.shiftLabel === "SN").length;
                const total = visibleShifts.length;
                const pendingCount = visibleShifts.filter((shift) => shift.paymentStatus === "needs_review").length;

                return {
                    ...doctor,
                    cells: nextCells,
                    totalSD,
                    totalSN,
                    total,
                    pendingCount,
                };
            })
            .filter((doctor) => {
                if (status !== "all" && doctor.paymentStatus !== status) {
                    return false;
                }

                if (normalized) {
                    const haystack = normalize([doctor.doctorName, doctor.displayName ?? ""].join(" "));
                    if (!haystack.includes(normalized)) {
                        return false;
                    }
                }

                return doctor.total > 0;
            });

        const sorted = [...doctors].sort((left, right) => {
            if (sortMode === "name") {
                return left.doctorName.localeCompare(right.doctorName, "pt-BR");
            }

            if (sortMode === "total") {
                return right.total - left.total || left.doctorName.localeCompare(right.doctorName, "pt-BR");
            }

            if (sortMode === "sd") {
                return right.totalSD - left.totalSD || left.doctorName.localeCompare(right.doctorName, "pt-BR");
            }

            if (sortMode === "sn") {
                return right.totalSN - left.totalSN || left.doctorName.localeCompare(right.doctorName, "pt-BR");
            }

            return right.pendingCount - left.pendingCount || right.total - left.total || left.doctorName.localeCompare(right.doctorName, "pt-BR");
        });

        return sorted;
    }, [board.doctors, domainFilter, normalized, normalizedTarget, shiftFilter, sortMode, status, targetFilter]);

    async function submitManualCorrection() {
        if (!manualDraft) {
            return;
        }

        const trimmedDoctor = manualDoctorName.trim();
        if (trimmedDoctor.length < 3) {
            setManualError("Informe ao menos 3 caracteres no nome do médico.");
            return;
        }

        const selectedDoctor = board.allDoctorNames.find((name) => normalize(name) === normalize(trimmedDoctor));
        if (!selectedDoctor) {
            setManualError("Selecione um médico válido na lista de sugestões.");
            return;
        }

        setManualBusy(true);
        setManualError(null);
        setManualFeedback(null);

        try {
            const date = `${board.monthKey}-${manualDraft.day}`;
            const response = await fetch("/api/admin/payment-attestation/slot", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    action: "manual_assign",
                    date,
                    shift: manualDraft.shiftLabel,
                    domain: manualDraft.domain,
                    targetCode: manualDraft.targetCode,
                    doctorName: selectedDoctor,
                }),
            });

            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(body?.error ?? "Não foi possível aplicar a correção manual.");
            }

            setManualFeedback("Correção salva. Atualizando fechamento mensal...");
            setManualDraft(null);
            setManualDoctorName("");
            window.location.reload();
        } catch (error) {
            setManualError(error instanceof Error ? error.message : "Falha ao salvar correção manual.");
        } finally {
            setManualBusy(false);
        }
    }

    return (
        <main className="chief-payable-shell">
            <section className="chief-payable-hero">
                <div>
                    <p className="reports-kicker">Fechamento mensal do chefe</p>
                    <h1>Unidades pagáveis por médico e por dia</h1>
                    <p className="chief-payable-subtitle">
                        Esta visão mostra apenas o que vira pagamento. Resíduos técnicos, fragmentos e duplicações ficam na auditoria detalhada.
                    </p>
                </div>

                <div className="chief-payable-peak-day" aria-live="polite">
                    <span>Pico operacional do mês</span>
                    <strong>{peakDay ? `${peakDay.day} · ${peakDay.count} unidades` : "sem dados"}</strong>
                    <small>Use os filtros para refinar o fechamento por turno e domínio.</small>
                </div>

                <div className="chief-payable-hero-actions">
                    <a className="reports-primary-link" href={`/api/admin/reports/export?month=${board.monthKey}`}>
                        Exportar XLSX (payable shifts)
                    </a>
                    <a className="reports-secondary-link" href="/admin/payment-attestation/audit">
                        Abrir auditoria técnica
                    </a>
                    <a className="reports-secondary-link" href="/admin/reports">
                        Abrir relatório mensal técnico
                    </a>
                </div>
            </section>

            <section className="reports-presets">
                {board.presetMonths.map((preset) => (
                    <a
                        key={preset.key}
                        href={`/admin/payment-attestation?month=${preset.key}`}
                        className={`reports-month-chip ${preset.key === board.monthKey ? "active" : ""}`.trim()}
                    >
                        {preset.label}
                    </a>
                ))}
            </section>

            <section className="chief-payable-summary">
                <article className="chief-payable-summary-card">
                    <span>Unidades pagáveis</span>
                    <strong>{board.summary.payableShiftCount}</strong>
                </article>
                <article className="chief-payable-summary-card ready">
                    <span>Prontas</span>
                    <strong>{board.summary.readyCount}</strong>
                </article>
                <button className="chief-payable-summary-card review actionable" type="button" onClick={() => setStatus("needs_review")}>
                    <span>Revisão</span>
                    <strong>{board.summary.needsReviewCount}</strong>
                </button>
                <article className="chief-payable-summary-card">
                    <span>Médicos</span>
                    <strong>{board.summary.doctorCount}</strong>
                </article>
                <article className="chief-payable-summary-card">
                    <span>Desativadas</span>
                    <strong>{visibleDisabledTargets.length}</strong>
                </article>
                <article className="chief-payable-summary-card warning-strong">
                    <span>Sem médico</span>
                    <strong>{visibleUncoveredTargets.length}</strong>
                </article>
            </section>

            <section className="chief-payable-load-strip" aria-label="Ritmo mensal de unidades pagáveis">
                {dayLoad.map((entry) => {
                    const ratio = Math.max(entry.count / maxDayLoad, 0.12);
                    return (
                        <div key={entry.day} className="chief-payable-load-item" title={`Dia ${entry.day}: ${entry.count} unidades`}>
                            <span>{entry.day}</span>
                            <i style={{ transform: `scaleY(${ratio.toFixed(4)})` }} />
                            <strong>{entry.count}</strong>
                        </div>
                    );
                })}
            </section>

            <section className="chief-payable-control-grid">
                <article className="chief-payable-control-card chief-payable-control-card-priority">
                    <h3>Turno e domínio</h3>
                    <div className="chief-payable-chip-row chief-payable-chip-row-priority">
                        <button type="button" className={`chief-payable-chip ${shiftFilter === "all" ? "active" : ""}`.trim()} onClick={() => setShiftFilter("all")}>
                            SD + SN ({board.summary.payableShiftCount})
                        </button>
                        <button type="button" className={`chief-payable-chip day ${shiftFilter === "SD" ? "active" : ""}`.trim()} onClick={() => setShiftFilter("SD")}>
                            SD ({filterSummary.sdCount})
                        </button>
                        <button type="button" className={`chief-payable-chip night ${shiftFilter === "SN" ? "active" : ""}`.trim()} onClick={() => setShiftFilter("SN")}>
                            SN ({filterSummary.snCount})
                        </button>
                        <button type="button" className={`chief-payable-chip ${domainFilter === "all" ? "active" : ""}`.trim()} onClick={() => setDomainFilter("all")}>
                            Regulação + Intervenção
                        </button>
                        <button type="button" className={`chief-payable-chip ${domainFilter === "regulation" ? "active" : ""}`.trim()} onClick={() => setDomainFilter("regulation")}>
                            Regulação ({filterSummary.regulationCount})
                        </button>
                        <button type="button" className={`chief-payable-chip ${domainFilter === "intervention" ? "active" : ""}`.trim()} onClick={() => setDomainFilter("intervention")}>
                            Intervenção ({filterSummary.interventionCount})
                        </button>
                    </div>

                    <div className="chief-payable-chip-row chief-payable-chip-row-priority">
                        <button
                            type="button"
                            className={`chief-payable-chip ${normalizedTarget === "usa" ? "active" : ""}`.trim()}
                            onClick={() => setTargetSearch(normalizedTarget === "usa" ? "" : "USA")}
                        >
                            USA ({board.targetOptions.filter((target) => normalize([target.targetCode, target.targetLabel].join(" ")).includes("usa")).length})
                        </button>
                        <button type="button" className={`chief-payable-chip ${targetFilter === "all" ? "active" : ""}`.trim()} onClick={() => setTargetFilter("all")}>
                            Todas as bases/ramais ({targetPills.length})
                        </button>
                    </div>

                    <div className="chief-payable-order-legend" aria-label="Ordem operacional prioritária">
                        <span>Ordem rápida</span>
                        <strong>01 · 02 · 03 · 04 · 05 · 10 · 20</strong>
                    </div>

                    <div className="chief-payable-target-sectors">
                        {targetSectors.map((sector) => (
                            <section key={sector.key} className={`chief-payable-target-sector ${sector.tone}`.trim()}>
                                <header>
                                    <h4>{sector.title}</h4>
                                    <small>{sector.targets.length} unidades</small>
                                </header>

                                <div className="chief-payable-chip-row chief-payable-target-pills">
                                    {sector.targets.map((target) => {
                                        const value = `${target.domain}|${target.targetCode}`;
                                        return (
                                            <button
                                                type="button"
                                                key={value}
                                                className={`chief-payable-chip ${targetFilter === value ? "active" : ""}`.trim()}
                                                onClick={() => setTargetFilter(value)}
                                                title={`${target.targetCode} · ${target.targetLabel}`}
                                            >
                                                {target.targetCode}
                                            </button>
                                        );
                                    })}
                                </div>
                            </section>
                        ))}
                    </div>
                </article>
            </section>

            <section className="chief-payable-filter-bar">
                <div className="chief-payable-inline-status" aria-label="Status de médicos">
                    <span>Status</span>
                    <div className="chief-payable-chip-row chief-payable-chip-row-inline">
                        <button type="button" className={`chief-payable-chip ${status === "all" ? "active" : ""}`.trim()} onClick={() => setStatus("all")}>
                            Todos ({board.summary.doctorCount})
                        </button>
                        <button type="button" className={`chief-payable-chip ${status === "ready_for_payment" ? "active" : ""}`.trim()} onClick={() => setStatus("ready_for_payment")}>
                            Prontos ({filterSummary.readyDoctors})
                        </button>
                        <button type="button" className={`chief-payable-chip warning ${status === "needs_review" ? "active" : ""}`.trim()} onClick={() => setStatus("needs_review")}>
                            Revisão ({filterSummary.reviewDoctors})
                        </button>
                    </div>
                </div>

                <label className="chief-payable-filter-field chief-payable-search">
                    <span>Filtrar médico</span>
                    <input
                        type="search"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Digite nome ou apelido"
                    />
                </label>

                <label className="chief-payable-filter-field chief-payable-target-search">
                    <span>Filtrar alvo</span>
                    <input
                        type="search"
                        value={targetSearch}
                        onChange={(event) => setTargetSearch(event.target.value)}
                        placeholder="Ex.: BR60, PM04, CRU"
                    />
                </label>

                <label className="chief-payable-filter-field compact">
                    <span>Ordenar por</span>
                    <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
                        <option value="pending">Pendências</option>
                        <option value="total">Total</option>
                        <option value="sd">Total SD</option>
                        <option value="sn">Total SN</option>
                        <option value="name">Nome</option>
                    </select>
                </label>

                <label className="chief-payable-filter-field compact">
                    <span>Base/Ramal</span>
                    <select value={targetFilter} onChange={(event) => setTargetFilter(event.target.value)}>
                        <option value="all">Todos</option>
                        {board.targetOptions.map((target) => (
                            <option key={`${target.domain}|${target.targetCode}`} value={`${target.domain}|${target.targetCode}`}>
                                {target.targetCode} · {target.domain === "regulation" ? "Regulação" : "Intervenção"}
                            </option>
                        ))}
                    </select>
                </label>
            </section>

            {(manualError || manualFeedback) ? (
                <section className={`payment-inline-banner ${manualError ? "danger" : "ok"}`.trim()}>
                    <strong>{manualError ? "Falha na correção" : "Correção manual"}</strong>
                    <span>{manualError ?? manualFeedback}</span>
                </section>
            ) : null}

            <section className="chief-payable-table-shell">
                <div className="chief-payable-table-scroll">
                    <table className="chief-payable-table">
                        <thead>
                            <tr>
                                <th className="sticky-col doctor">Médico</th>
                                {board.days.map((day) => <th key={day}>{day}</th>)}
                                <th>Total SD</th>
                                <th>Total SN</th>
                                <th>Total</th>
                                <th>Pend.</th>
                            </tr>
                        </thead>

                        <tbody>
                            <AnimatePresence mode="popLayout">
                                <motion.tr
                                    key="disabled-row"
                                    layout
                                    initial={{ opacity: 0, y: 6 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -6 }}
                                    transition={{ duration: 0.16 }}
                                    className="chief-payable-disabled-row"
                                >
                                    <td className="sticky-col doctor">
                                        <strong>Desativadas</strong>
                                        <span>Fontes sem médico por desativação do turno</span>
                                    </td>

                                    {board.days.map((day) => (
                                        <td key={`disabled-${day}`}>
                                            <div className="chief-payable-cell-tags">
                                                {(disabledByDay.get(day) ?? []).map((item) => (
                                                    <button
                                                        type="button"
                                                        key={item.snapshotId}
                                                        className={`chief-payable-tag disabled ${item.shiftLabel === "SD" ? "sd" : "sn"}`.trim()}
                                                        title={`${item.targetCode} ${item.shiftLabel}${item.disabledReason ? ` · ${item.disabledReason}` : ""}`}
                                                        onClick={() => {
                                                            setManualDraft({
                                                                domain: item.domain,
                                                                targetCode: item.targetCode,
                                                                targetLabel: item.targetLabel,
                                                                day: item.day,
                                                                shiftLabel: item.shiftLabel,
                                                                sourceType: "disabled",
                                                                reason: item.disabledReason ?? null,
                                                            });
                                                            setManualDoctorName("");
                                                            setManualError(null);
                                                        }}
                                                    >
                                                        {item.targetCode}{item.shiftLabel}
                                                    </button>
                                                ))}
                                            </div>
                                        </td>
                                    ))}

                                    <td>-</td>
                                    <td>-</td>
                                    <td>{visibleDisabledTargets.length}</td>
                                    <td>-</td>
                                </motion.tr>

                                <motion.tr
                                    key="uncovered-row"
                                    layout
                                    initial={{ opacity: 0, y: 6 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -6 }}
                                    transition={{ duration: 0.16 }}
                                    className="chief-payable-uncovered-row"
                                >
                                    <td className="sticky-col doctor">
                                        <strong>Sem médico</strong>
                                        <span>Sem cobertura e sem desativação no turno</span>
                                    </td>

                                    {board.days.map((day) => (
                                        <td key={`uncovered-${day}`}>
                                            <div className="chief-payable-cell-tags">
                                                {(uncoveredByDay.get(day) ?? []).map((item) => (
                                                    <button
                                                        type="button"
                                                        key={item.snapshotId}
                                                        className={`chief-payable-tag uncovered ${item.shiftLabel === "SD" ? "sd" : "sn"}`.trim()}
                                                        title={`${item.targetCode} ${item.shiftLabel}${item.reason ? ` · ${item.reason}` : ""}`}
                                                        onClick={() => {
                                                            setManualDraft({
                                                                domain: item.domain,
                                                                targetCode: item.targetCode,
                                                                targetLabel: item.targetLabel,
                                                                day: item.day,
                                                                shiftLabel: item.shiftLabel,
                                                                sourceType: "uncovered",
                                                                reason: item.reason ?? null,
                                                            });
                                                            setManualDoctorName("");
                                                            setManualError(null);
                                                        }}
                                                    >
                                                        {item.targetCode}{item.shiftLabel}
                                                    </button>
                                                ))}
                                            </div>
                                        </td>
                                    ))}

                                    <td>-</td>
                                    <td>-</td>
                                    <td>{visibleUncoveredTargets.length}</td>
                                    <td>!</td>
                                </motion.tr>

                                {filteredDoctors.map((doctor, index) => (
                                    <motion.tr
                                        key={doctor.doctorId}
                                        layout
                                        initial={{ opacity: 0, y: 6 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -6 }}
                                        transition={{ duration: 0.2, delay: Math.min(index * 0.018, 0.18) }}
                                    >
                                        <td className="sticky-col doctor">
                                            <strong>{doctor.doctorName}</strong>
                                            <span>{doctor.pendingCount > 0 ? "Revisar" : "Pronto"}</span>
                                        </td>

                                        {doctor.cells.map((cell) => (
                                            <td key={`${doctor.doctorId}-${cell.day}`}>
                                                <div className="chief-payable-cell-tags">
                                                    {cell.shifts.map((shift) => (
                                                        <motion.a
                                                            key={shift.payableShiftId}
                                                            href={cellAuditLink(board.monthKey, cell.day, shift.shiftLabel)}
                                                            className={`chief-payable-tag ${shift.shiftLabel === "SD" ? "sd" : "sn"}`.trim()}
                                                            title={`${shift.targetCode}${shift.shiftLabel} · ${shift.doctorName}`}
                                                            initial={{ opacity: 0, scale: 0.92 }}
                                                            animate={{ opacity: 1, scale: 1 }}
                                                            transition={{ duration: 0.15 }}
                                                        >
                                                            {shift.tagCode}
                                                        </motion.a>
                                                    ))}
                                                </div>
                                            </td>
                                        ))}

                                        <td>{doctor.totalSD}</td>
                                        <td>{doctor.totalSN}</td>
                                        <td>{doctor.total}</td>
                                        <td>{doctor.pendingCount}</td>
                                    </motion.tr>
                                ))}

                                {filteredDoctors.length === 0 ? (
                                    <motion.tr
                                        key="empty"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                    >
                                        <td className="chief-payable-empty" colSpan={board.days.length + 5}>
                                            Nenhum médico encontrado com os filtros atuais.
                                        </td>
                                    </motion.tr>
                                ) : null}
                            </AnimatePresence>
                        </tbody>
                    </table>
                </div>
            </section>

            {manualDraft ? (
                <section className="payment-detail-card" style={{ marginTop: "1rem" }}>
                    <span className="payment-eyebrow">Correção manual de pagamento</span>
                    <strong>{manualDraft.targetCode} · {manualDraft.targetLabel} · {board.monthKey}-{manualDraft.day} · {manualDraft.shiftLabel}</strong>
                    <p>
                        Origem: {manualDraft.sourceType === "disabled" ? "Desativada" : "Sem médico"}
                        {manualDraft.reason ? ` · ${manualDraft.reason}` : ""}
                    </p>
                    <div className="chief-payable-filter-bar" style={{ marginTop: "0.75rem" }}>
                        <label className="chief-payable-filter-field chief-payable-search" style={{ minWidth: "320px" }}>
                            <span>Médico para pagamento</span>
                            <input
                                type="text"
                                list="chief-payment-doctor-names"
                                value={manualDoctorName}
                                onChange={(event) => setManualDoctorName(event.target.value)}
                                placeholder="Digite o nome do médico"
                            />
                            </label>
                        <datalist id="chief-payment-doctor-names">
                            {board.allDoctorNames.map((name) => (
                                <option key={name} value={name} />
                            ))}
                        </datalist>

                        <div className="payment-filter-actions">
                            <button type="button" className="payment-button primary" onClick={() => void submitManualCorrection()} disabled={manualBusy}>
                                {manualBusy ? "Salvando..." : "Salvar correção"}
                            </button>
                            <button
                                type="button"
                                className="payment-button"
                                onClick={() => {
                                    setManualDraft(null);
                                    setManualDoctorName("");
                                    setManualError(null);
                                }}
                                disabled={manualBusy}
                            >
                                Cancelar
                            </button>
                        </div>
                    </div>
                </section>
            ) : null}
        </main>
    );
}
