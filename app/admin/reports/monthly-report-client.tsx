"use client";

import { useEffect, useState } from "react";
import type { MonthlyReportDoctorGroup, MonthlyReportModel, MonthlyReportPaymentStatus, MonthlyReportShift } from "@/modules/reporting/monthly-report";
import { formatMinutesForHumans } from "@/modules/reporting/monthly-report";

function formatDateTime(value: string | null) {
    if (!value) {
        return "--";
    }

    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

function formatDomain(domain: MonthlyReportShift["domain"]) {
    return domain === "regulation" ? "Regulação" : "Intervenção";
}

function formatSource(source: MonthlyReportShift["source"]) {
    if (source === "admin_correction") {
        return "Correção";
    }

    if (source === "manual") {
        return "Manual";
    }

    if (source === "telegram") {
        return "Telegram";
    }

    return "Importação";
}

function formatPaymentStatus(status: MonthlyReportPaymentStatus) {
    return status === "ready_for_payment" ? "Pronto para pagar" : "Revisar";
}

function formatAuditAction(action: string) {
    const dictionary: Record<string, string> = {
        "intervention_occupancy.started": "Plantão aberto",
        "intervention_occupancy.ended": "Plantão encerrado",
        "intervention_occupancy.corrected": "Plantão corrigido",
        "intervention_occupancy.departure_reported": "Saída reportada",
        "intervention_occupancy.continuation_confirmed": "Continuidade confirmada",
        "regulation_occupancy.started": "Plantão aberto",
        "regulation_occupancy.ended": "Plantão encerrado",
        "regulation_occupancy.corrected": "Plantão corrigido",
    };

    return dictionary[action] ?? action;
}

function extractAuditNote(details: Record<string, unknown>) {
    const notes = details.notes;
    return typeof notes === "string" && notes.trim() ? notes.trim() : null;
}

function summaryTone(count: number) {
    if (count === 0) {
        return "ok";
    }

    if (count <= 3) {
        return "warn";
    }

    return "danger";
}

interface Props {
    report: MonthlyReportModel;
}

export function MonthlyReportClient({ report }: Props) {
    const [search, setSearch] = useState("");
    const [domainFilter, setDomainFilter] = useState<"all" | MonthlyReportShift["domain"]>("all");
    const [paymentStatusFilter, setPaymentStatusFilter] = useState<"all" | MonthlyReportPaymentStatus>("all");
    const [onlyInconsistent, setOnlyInconsistent] = useState(false);
    const [expandedDoctorIds, setExpandedDoctorIds] = useState<string[]>(report.groups.slice(0, 1).map((group) => group.doctorId));
    const [selectedShiftId, setSelectedShiftId] = useState<string | null>(report.groups[0]?.shifts[0]?.occupancyId ?? null);

    const normalizedSearch = search.trim().toLocaleLowerCase("pt-BR");
    const filteredGroups = report.groups
        .map((group) => {
            const shifts = group.shifts.filter((shift) => {
                if (onlyInconsistent && shift.inconsistencies.length === 0) {
                    return false;
                }

                if (domainFilter !== "all" && shift.domain !== domainFilter) {
                    return false;
                }

                if (paymentStatusFilter !== "all" && shift.paymentStatus !== paymentStatusFilter) {
                    return false;
                }

                if (!normalizedSearch) {
                    return true;
                }

                const haystack = [
                    group.doctorName,
                    group.displayName,
                    shift.targetCode,
                    shift.targetLabel,
                    shift.notes,
                ]
                    .filter(Boolean)
                    .join(" ")
                    .toLocaleLowerCase("pt-BR");

                return haystack.includes(normalizedSearch);
            });

            return {
                ...group,
                shiftCount: shifts.length,
                workedMinutes: shifts.reduce((total, shift) => total + (shift.workedMinutes ?? 0), 0),
                balanceMinutes: shifts.reduce((total, shift) => total + (shift.balanceMinutes ?? 0), 0),
                inconsistentShiftCount: shifts.filter((shift) => shift.inconsistencies.length > 0).length,
                manualShiftCount: shifts.filter((shift) => shift.flags.hasManualSource).length,
                correctedShiftCount: shifts.filter((shift) => shift.flags.hasCorrectionHistory).length,
                paymentStatus: shifts.some((shift) => shift.paymentStatus === "needs_review") ? "needs_review" : "ready_for_payment",
                shifts,
            } satisfies MonthlyReportDoctorGroup;
        })
        .filter((group) => group.shifts.length > 0);

    const selectedShift = filteredGroups
        .flatMap((group) => group.shifts)
        .find((shift) => shift.occupancyId === selectedShiftId) ?? filteredGroups[0]?.shifts[0] ?? null;

    useEffect(() => {
        if (selectedShift && selectedShift.occupancyId !== selectedShiftId) {
            setSelectedShiftId(selectedShift.occupancyId);
        }
    }, [selectedShift, selectedShiftId]);

    function toggleDoctor(doctorId: string) {
        setExpandedDoctorIds((current) => current.includes(doctorId)
            ? current.filter((id) => id !== doctorId)
            : [...current, doctorId]);
    }

    return (
        <main className="reports-shell">
            <section className="reports-hero">
                <div>
                    <p className="reports-kicker">Auditoria mensal</p>
                    <h1>Relatório operacional para fechar nota antes do pagamento.</h1>
                    <p className="reports-subtitle">
                        A leitura principal combina quantidade real de plantões, detalhamento por médico e alertas de inconsistência para travar o que ainda precisa de revisão.
                    </p>
                </div>

                <div className="reports-hero-actions">
                    <a className="reports-primary-link" href="/admin/payment-attestation">
                        Abrir atesto diário
                    </a>
                    <a className="reports-primary-link" href="/admin/payment-closing">
                        Abrir fechamento mensal
                    </a>
                    <a className="reports-primary-link" href={`/api/admin/reports/export?month=${report.monthKey}`}>
                        Exportar XLSX
                    </a>
                    <a className="reports-secondary-link" href={`/api/admin/reports/export?month=${report.monthKey}&format=csv`}>
                        Baixar CSV
                    </a>
                    <a className="reports-secondary-link" href="/">
                        Voltar ao quadro
                    </a>
                </div>
            </section>

            <section className="reports-presets">
                {report.presetMonths.map((preset) => (
                    <a
                        key={preset.key}
                        href={`/admin/reports?month=${preset.key}`}
                        className={`reports-month-chip ${preset.key === report.monthKey ? "active" : ""}`.trim()}
                    >
                        {preset.label}
                    </a>
                ))}
            </section>

            <section className="reports-summary-grid">
                <article className="reports-summary-card">
                    <span className="reports-summary-label">Prontos para pagar</span>
                    <strong>{report.summary.readyForPaymentCount}</strong>
                    <span>{report.summary.doctorsReadyForPaymentCount} médicos liberados</span>
                </article>
                <article className="reports-summary-card">
                    <span className="reports-summary-label">Plantões em revisão</span>
                    <strong>{report.summary.needsReviewCount}</strong>
                    <span>{report.summary.doctorsNeedsReviewCount} médicos travados</span>
                </article>
                <article className={`reports-summary-card ${summaryTone(report.summary.inconsistentShiftCount)}`.trim()}>
                    <span className="reports-summary-label">Pendências de auditoria</span>
                    <strong>{report.summary.inconsistentShiftCount}</strong>
                    <span>{report.summary.openShiftCount} ainda sem saída</span>
                </article>
                <article className="reports-summary-card">
                    <span className="reports-summary-label">Volume do mês</span>
                    <strong>{report.summary.shiftCount}</strong>
                    <span>{formatMinutesForHumans(report.summary.workedMinutes)} trabalhados · saldo {formatMinutesForHumans(report.summary.balanceMinutes)}</span>
                </article>
            </section>

            <section className="reports-filter-bar">
                <label className="reports-filter-field reports-filter-search">
                    <span>Buscar</span>
                    <input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Médico, base, posto ou observação"
                    />
                </label>

                <label className="reports-filter-field">
                    <span>Escopo</span>
                    <select value={domainFilter} onChange={(event) => setDomainFilter(event.target.value as "all" | MonthlyReportShift["domain"])}>
                        <option value="all">Tudo</option>
                        <option value="regulation">Regulação</option>
                        <option value="intervention">Intervenção</option>
                    </select>
                </label>

                <label className="reports-filter-field">
                    <span>Status</span>
                    <select value={paymentStatusFilter} onChange={(event) => setPaymentStatusFilter(event.target.value as "all" | MonthlyReportPaymentStatus)}>
                        <option value="all">Tudo</option>
                        <option value="ready_for_payment">Pronto para pagar</option>
                        <option value="needs_review">Revisar</option>
                    </select>
                </label>

                <label className="reports-toggle">
                    <input
                        type="checkbox"
                        checked={onlyInconsistent}
                        onChange={(event) => setOnlyInconsistent(event.target.checked)}
                    />
                    <span>Mostrar só pendências</span>
                </label>
            </section>

            <section className="reports-grid">
                <div className="reports-groups-column">
                    {filteredGroups.length === 0 ? (
                        <article className="reports-empty-state">
                            <strong>Nenhum plantão encontrado com esse recorte.</strong>
                            <span>Ajuste busca, escopo ou filtro de inconsistência.</span>
                        </article>
                    ) : filteredGroups.map((group) => {
                        const isExpanded = expandedDoctorIds.includes(group.doctorId);
                        return (
                            <article className="reports-group-card" key={group.doctorId}>
                                <button type="button" className="reports-group-header" onClick={() => toggleDoctor(group.doctorId)}>
                                    <div>
                                        <strong>{group.doctorName}</strong>
                                        <span>{group.displayName && group.displayName !== group.doctorName ? group.displayName : "Apelido não configurado"}</span>
                                    </div>

                                    <div className="reports-group-badges">
                                        <span className={`reports-badge ${group.paymentStatus === "ready_for_payment" ? "ok" : "danger"}`.trim()}>
                                            {formatPaymentStatus(group.paymentStatus)}
                                        </span>
                                        <span className="reports-badge neutral">{group.shiftCount} plantões</span>
                                        <span className={`reports-badge ${group.inconsistentShiftCount > 0 ? "danger" : "ok"}`.trim()}>
                                            {group.inconsistentShiftCount} pendências
                                        </span>
                                        {group.correctedShiftCount > 0 && (
                                            <span className="reports-badge warn">{group.correctedShiftCount} corrigidos</span>
                                        )}
                                        {group.manualShiftCount > 0 && (
                                            <span className="reports-badge warn">{group.manualShiftCount} manuais</span>
                                        )}
                                        <span className="reports-badge neutral">{formatMinutesForHumans(group.workedMinutes)}</span>
                                    </div>
                                </button>

                                {isExpanded && (
                                    <div className="reports-shift-list">
                                        {group.shifts.map((shift) => (
                                            <button
                                                key={shift.occupancyId}
                                                type="button"
                                                className={`reports-shift-row ${selectedShift?.occupancyId === shift.occupancyId ? "selected" : ""}`.trim()}
                                                onClick={() => setSelectedShiftId(shift.occupancyId)}
                                            >
                                                <div>
                                                    <strong>{shift.targetCode} · {shift.targetLabel}</strong>
                                                    <span>{formatDateTime(shift.startedAt)} até {formatDateTime(shift.endedAt)}</span>
                                                </div>

                                                <div className="reports-shift-meta">
                                                    <span className={`reports-badge ${shift.paymentStatus === "ready_for_payment" ? "ok" : "danger"}`.trim()}>
                                                        {formatPaymentStatus(shift.paymentStatus)}
                                                    </span>
                                                    <span>{formatDomain(shift.domain)}</span>
                                                    <span>{formatSource(shift.source)}</span>
                                                    <span>{formatMinutesForHumans(shift.workedMinutes)}</span>
                                                    <span>{formatMinutesForHumans(shift.balanceMinutes)}</span>
                                                    {shift.inconsistencies.length > 0 && (
                                                        <span className="reports-inline-alert">{shift.inconsistencies.length} alerta(s)</span>
                                                    )}
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </article>
                        );
                    })}
                </div>

                <aside className="reports-detail-panel">
                    {selectedShift ? (
                        <>
                            <div className="reports-detail-header">
                                <div>
                                    <p className="reports-kicker">Drill-down</p>
                                    <h2>{selectedShift.targetCode} · {selectedShift.targetLabel}</h2>
                                </div>
                                <span className={`reports-badge ${selectedShift.inconsistencies.length > 0 ? "danger" : "ok"}`.trim()}>
                                    {formatPaymentStatus(selectedShift.paymentStatus)}
                                </span>
                            </div>

                            <div className="reports-detail-grid">
                                <div>
                                    <span className="reports-detail-label">Médico</span>
                                    <strong>{selectedShift.displayName || selectedShift.doctorName}</strong>
                                </div>
                                <div>
                                    <span className="reports-detail-label">Domínio</span>
                                    <strong>{formatDomain(selectedShift.domain)}</strong>
                                </div>
                                <div>
                                    <span className="reports-detail-label">Entrada</span>
                                    <strong>{formatDateTime(selectedShift.startedAt)}</strong>
                                </div>
                                <div>
                                    <span className="reports-detail-label">Entrada no quadro</span>
                                    <strong>{formatDateTime(selectedShift.boardStartedAt)}</strong>
                                </div>
                                <div>
                                    <span className="reports-detail-label">Saída</span>
                                    <strong>{formatDateTime(selectedShift.endedAt)}</strong>
                                </div>
                                <div>
                                    <span className="reports-detail-label">Saída efetiva</span>
                                    <strong>{formatDateTime(selectedShift.actualEndedAt)}</strong>
                                </div>
                                <div>
                                    <span className="reports-detail-label">Janela prevista</span>
                                    <strong>{formatDateTime(selectedShift.scheduledStartAt)} até {formatDateTime(selectedShift.scheduledEndAt)}</strong>
                                </div>
                                <div>
                                    <span className="reports-detail-label">Banco de horas</span>
                                    <strong>{formatMinutesForHumans(selectedShift.balanceMinutes)}</strong>
                                </div>
                            </div>

                            <div className="reports-detail-stack">
                                <article className="reports-detail-card">
                                    <span className="reports-detail-label">Rastro operacional</span>
                                    <ul className="reports-detail-list">
                                        <li>Origem: {selectedShift.source}</li>
                                        <li>Turno: {selectedShift.shiftLabel ?? "sem turno marcado"}</li>
                                        <li>Criado por: {selectedShift.createdByEmail ?? "sistema"}</li>
                                        <li>Última atualização: {formatDateTime(selectedShift.updatedAt)}</li>
                                        <li>Atualizado por: {selectedShift.updatedByEmail ?? "sem editor humano"}</li>
                                        <li>Eventos de auditoria: {selectedShift.auditTrail.length}</li>
                                    </ul>
                                </article>

                                <article className="reports-detail-card">
                                    <span className="reports-detail-label">Banco de horas</span>
                                    <ul className="reports-detail-list">
                                        <li>Atraso: {formatMinutesForHumans(selectedShift.arrivalDelayMinutes)}</li>
                                        <li>Hora extra: {formatMinutesForHumans(selectedShift.overtimeMinutes)}</li>
                                        <li>Hora creditada: {formatMinutesForHumans(selectedShift.creditedOvertimeMinutes)}</li>
                                        <li>Regra: {selectedShift.ruleCode ?? "sem regra aplicada"}</li>
                                    </ul>
                                    {selectedShift.bankHoursExplanation && (
                                        <p className="reports-detail-note">{selectedShift.bankHoursExplanation}</p>
                                    )}
                                </article>

                                <article className="reports-detail-card">
                                    <span className="reports-detail-label">Pendências para fechar a nota</span>
                                    {selectedShift.inconsistencies.length > 0 ? (
                                        <ul className="reports-detail-list alerts">
                                            {selectedShift.inconsistencies.map((item) => <li key={item}>{item}</li>)}
                                        </ul>
                                    ) : (
                                        <p className="reports-detail-note">Sem alertas automáticos neste plantão.</p>
                                    )}
                                    {selectedShift.notes && <p className="reports-detail-note">Obs: {selectedShift.notes}</p>}
                                </article>

                                <article className="reports-detail-card">
                                    <span className="reports-detail-label">Linha do tempo de auditoria</span>
                                    {selectedShift.auditTrail.length > 0 ? (
                                        <div className="reports-audit-timeline">
                                            {selectedShift.auditTrail.map((entry) => {
                                                const note = extractAuditNote(entry.details);
                                                return (
                                                    <div className="reports-audit-item" key={entry.id}>
                                                        <div className="reports-audit-dot" />
                                                        <div className="reports-audit-copy">
                                                            <strong>{formatAuditAction(entry.action)}</strong>
                                                            <span>{formatDateTime(entry.createdAt)} · {entry.actorEmail ?? "sistema"}</span>
                                                            {note && <p className="reports-detail-note">Obs: {note}</p>}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <p className="reports-detail-note">Sem eventos de auditoria vinculados a este plantão.</p>
                                    )}
                                </article>
                            </div>
                        </>
                    ) : (
                        <article className="reports-empty-state">
                            <strong>Selecione um plantão para abrir o detalhe.</strong>
                            <span>O painel lateral mostra rastro, banco de horas e alertas por registro.</span>
                        </article>
                    )}
                </aside>
            </section>
        </main>
    );
}