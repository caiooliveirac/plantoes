"use client";

import { useDeferredValue, useEffect, useEffectEvent, useMemo, useState, useTransition } from "react";
import type {
    PaymentAttestationEntrySnapshot,
    PaymentAttestationRecentSlot,
    PaymentAttestationSlotLifecycleStatus,
    PaymentAttestationSlotRecord,
    PaymentAttestationSlotView,
} from "@/services/payment-attestation.service";

interface Props {
    initialView: PaymentAttestationSlotView;
}

function normalizeSearch(value: string) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

function rowKey(row: PaymentAttestationEntrySnapshot) {
    return `${row.domain}:${row.targetCode}`;
}

function boardDateInputValue(operationalDateIso: string) {
    return operationalDateIso.slice(0, 10);
}

function formatDateLabel(value: string) {
    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "full",
        timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

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

function formatTime(value: string | null) {
    if (!value) {
        return "--:--";
    }

    return new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

function formatMinutes(value: number | null) {
    if (value === null) {
        return "--";
    }

    const sign = value < 0 ? "-" : "";
    const absolute = Math.abs(value);
    const hours = Math.floor(absolute / 60);
    const minutes = absolute % 60;
    if (hours === 0) {
        return `${sign}${minutes} min`;
    }

    return `${sign}${hours} h ${String(minutes).padStart(2, "0")}`;
}

function domainLabel(domain: PaymentAttestationEntrySnapshot["domain"]) {
    return domain === "regulation" ? "Regulação" : "Intervenção";
}

function sourceLabel(source: string | null) {
    if (source === "telegram") {
        return "Telegram";
    }

    if (source === "admin_correction") {
        return "Correção";
    }

    if (source === "manual") {
        return "Manual";
    }

    if (source === "import") {
        return "Importação";
    }

    return "Sem origem";
}

function isDisabledRow(row: PaymentAttestationEntrySnapshot) {
    return row.disabledEntireShift;
}

function statusTone(row: PaymentAttestationEntrySnapshot) {
    if (isDisabledRow(row)) {
        return "disabled" as const;
    }

    if (!row.occupancyId) {
        return "empty" as const;
    }

    return row.paymentStatus === "ready_for_payment" ? "ready" as const : "review" as const;
}

function statusLabel(row: PaymentAttestationEntrySnapshot) {
    if (isDisabledRow(row)) {
        return "Desativada";
    }

    if (!row.occupancyId) {
        return "Vazio";
    }

    return row.paymentStatus === "ready_for_payment" ? "Pronto" : "Revisar";
}

function primaryDoctorLabel(row: PaymentAttestationEntrySnapshot) {
    if (isDisabledRow(row)) {
        return "Base desativada para o turno";
    }

    if (!row.occupancyId) {
        return "Sem ocupação consolidada";
    }

    return row.doctorName ?? row.displayName ?? "Médico não identificado";
}

function summarizeIssues(row: PaymentAttestationEntrySnapshot) {
    if (isDisabledRow(row)) {
        const parts = [row.disabledAt ? `desativada às ${formatTime(row.disabledAt)}` : "desativada para todo o turno"];
        if (row.disabledReason?.trim()) {
            parts.push(row.disabledReason.trim());
        }
        return parts.join(" • ");
    }

    if (row.issues.length === 0) {
        return "Sem pendência operacional para pagamento.";
    }

    return row.issues.slice(0, 2).join(" • ");
}

function rowSearchIndex(row: PaymentAttestationEntrySnapshot) {
    return normalizeSearch([
        row.targetCode,
        row.targetLabel,
        row.doctorName ?? "",
        row.displayName ?? "",
        row.roleLabel ?? "",
        row.disabledReason ?? "",
    ].join(" "));
}

function slotStatusLabel(status: PaymentAttestationSlotLifecycleStatus) {
    if (status === "approved") {
        return "Aprovado";
    }

    if (status === "draft") {
        return "Snapshot salvo";
    }

    return "Preview ao vivo";
}

function slotStatusBadgeTone(status: PaymentAttestationSlotLifecycleStatus) {
    if (status === "approved") {
        return "ok";
    }

    if (status === "draft") {
        return "warn";
    }

    return "neutral";
}

function recentSlotLabel(slot: PaymentAttestationRecentSlot) {
    return `${boardDateInputValue(slot.operationalDate)} · ${slot.shiftLabel}`;
}

export function PaymentAttestationClient({ initialView }: Props) {
    const [view, setView] = useState(initialView);
    const [selectedKey, setSelectedKey] = useState(() => {
        const firstReview = initialView.slot.entries.find((row) => row.paymentStatus === "needs_review");
        const firstRow = firstReview ?? initialView.slot.entries[0] ?? null;
        return firstRow ? rowKey(firstRow) : null;
    });
    const [search, setSearch] = useState("");
    const deferredSearch = useDeferredValue(search);
    const [dateInput, setDateInput] = useState(boardDateInputValue(initialView.slot.operationalDate));
    const [shiftInput, setShiftInput] = useState<"SD" | "SN">(initialView.slot.shiftLabel);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
    const [isRefreshing, startRefreshTransition] = useTransition();
    const [isSaving, startSaveTransition] = useTransition();

    const filteredRows = useMemo(() => {
        const normalized = normalizeSearch(deferredSearch);
        if (!normalized) {
            return view.slot.entries;
        }

        return view.slot.entries.filter((row) => rowSearchIndex(row).includes(normalized));
    }, [deferredSearch, view.slot.entries]);

    const selectedRow = filteredRows.find((row) => rowKey(row) === selectedKey)
        ?? view.slot.entries.find((row) => rowKey(row) === selectedKey)
        ?? filteredRows[0]
        ?? view.slot.entries[0]
        ?? null;

    useEffect(() => {
        if (!selectedRow) {
            return;
        }

        if (selectedKey !== rowKey(selectedRow)) {
            setSelectedKey(rowKey(selectedRow));
        }
    }, [selectedKey, selectedRow]);

    const loadSlot = useEffectEvent(async (params?: { date?: string | null; shift?: "SD" | "SN" | null }) => {
        setLoadError(null);
        setActionError(null);
        setFeedbackMessage(null);

        const query = new URLSearchParams();
        if (params?.date && params?.shift) {
            query.set("date", params.date);
            query.set("shift", params.shift);
        }

        const response = await fetch(`/api/admin/payment-attestation/slot${query.size > 0 ? `?${query.toString()}` : ""}`, {
            method: "GET",
            cache: "no-store",
        });
        const body = await response.json().catch(() => null) as PaymentAttestationSlotView | { error?: string } | null;
        if (!response.ok) {
            throw new Error(body && typeof body === "object" && "error" in body ? body.error || "Falha ao carregar fechamento." : "Falha ao carregar fechamento.");
        }

        const nextView = body as PaymentAttestationSlotView;
        startRefreshTransition(() => {
            setView(nextView);
            setDateInput(boardDateInputValue(nextView.slot.operationalDate));
            setShiftInput(nextView.slot.shiftLabel);
        });
    });

    const submitAction = useEffectEvent(async (action: "refresh" | "approve" | "reopen") => {
        setLoadError(null);
        setActionError(null);
        setFeedbackMessage(null);

        const response = await fetch("/api/admin/payment-attestation/slot", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                date: dateInput,
                shift: shiftInput,
                action,
            }),
        });
        const body = await response.json().catch(() => null) as PaymentAttestationSlotView | { error?: string } | null;
        if (!response.ok) {
            throw new Error(body && typeof body === "object" && "error" in body ? body.error || "Falha ao atualizar fechamento." : "Falha ao atualizar fechamento.");
        }

        const nextView = body as PaymentAttestationSlotView;
        setView(nextView);
        setFeedbackMessage(
            action === "refresh"
                ? "Snapshot atualizado com a leitura atual do site."
                : action === "approve"
                    ? "Fechamento aprovado. A partir daqui este slot passa a valer para pagamento."
                    : "Fechamento reaberto. O slot voltou para rascunho e pode ser recalculado.",
        );
    });

    const applyFilters = useEffectEvent(async () => {
        try {
            await loadSlot({ date: dateInput, shift: shiftInput });
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : "Falha ao carregar slot informado.");
        }
    });

    const openRecentSlot = useEffectEvent(async (slot: PaymentAttestationRecentSlot) => {
        try {
            await loadSlot({ date: boardDateInputValue(slot.operationalDate), shift: slot.shiftLabel });
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : "Falha ao abrir fechamento recente.");
        }
    });

    const handleAction = useEffectEvent(async (action: "refresh" | "approve" | "reopen") => {
        try {
            await submitAction(action);
        } catch (error) {
            setActionError(error instanceof Error ? error.message : "Falha ao atualizar o fechamento.");
        }
    });

    const canApprove = view.slot.canApprove;
    const isApproved = view.slot.status === "approved";

    return (
        <main className="payment-shell">
            <section className="payment-hero">
                <div>
                    <p className="reports-kicker">Atesto de pagamento</p>
                    <h1>Congelamento diário do SD/SN para transformar o site na fonte oficial do que vale pagar.</h1>
                    <p className="payment-subtitle">
                        Primeiro você enxerga quem estava onde e por que cada alvo fechou daquele jeito. Depois congela o slot para impedir drift operacional e sustentar o fechamento mensal por médico.
                    </p>
                </div>

                <div className="payment-hero-actions">
                    <a className="reports-secondary-link" href="/admin/payment-closing">Abrir fechamento mensal</a>
                    <a className="reports-secondary-link" href="/admin/payment-allocation">Ajustar alocação</a>
                    <a className="reports-secondary-link" href="/admin/reports">Abrir auditoria mensal</a>
                    <a className="reports-secondary-link" href="/">Voltar ao quadro</a>
                </div>
            </section>

            <section className="reports-presets">
                {view.recentSlots.length === 0 ? (
                    <span className="reports-badge neutral">Nenhum fechamento salvo ainda</span>
                ) : view.recentSlots.map((slot) => {
                    const active = boardDateInputValue(slot.operationalDate) === dateInput && slot.shiftLabel === shiftInput;
                    return (
                        <button
                            key={slot.id}
                            type="button"
                            className={`reports-month-chip ${active ? "active" : ""}`.trim()}
                            onClick={() => void openRecentSlot(slot)}
                        >
                            {recentSlotLabel(slot)} · {slot.status === "approved" ? "aprovado" : "rascunho"}
                        </button>
                    );
                })}
            </section>

            <section className="payment-summary-grid">
                <article className="payment-summary-card">
                    <span className="reports-summary-label">Slot</span>
                    <strong>{view.slot.shiftLabel}</strong>
                    <span>{formatDateLabel(view.slot.operationalDate)}</span>
                </article>
                <article className="payment-summary-card ready">
                    <span className="reports-summary-label">Prontos</span>
                    <strong>{view.slot.summary.readyCount}</strong>
                    <span>{view.slot.summary.doctorCount} médicos elegíveis neste snapshot</span>
                </article>
                <article className="payment-summary-card review">
                    <span className="reports-summary-label">Em revisão</span>
                    <strong>{view.slot.summary.needsReviewCount}</strong>
                    <span>{view.slot.summary.unassignedCount} sem ocupação consolidada</span>
                </article>
                <article className="payment-summary-card empty">
                    <span className="reports-summary-label">Alvos contábeis</span>
                    <strong>{view.slot.summary.totalTargets}</strong>
                    <span>{view.slot.summary.disabledCount} desativadas fora da conta</span>
                </article>
                <article className="payment-summary-card">
                    <span className="reports-summary-label">Estado do fechamento</span>
                    <strong>{slotStatusLabel(view.slot.status)}</strong>
                    <span>{view.slot.approvedAt ? `aprovado em ${formatDateTime(view.slot.approvedAt)}` : `lido em ${formatDateTime(view.slot.snapshotGeneratedAt)}`}</span>
                </article>
            </section>

            <section className="payment-filter-bar">
                <label className="payment-filter-field">
                    <span>Data operacional</span>
                    <input type="date" value={dateInput} onChange={(event) => setDateInput(event.target.value)} />
                </label>

                <label className="payment-filter-field compact">
                    <span>Turno</span>
                    <select value={shiftInput} onChange={(event) => setShiftInput(event.target.value as "SD" | "SN")}>
                        <option value="SD">SD</option>
                        <option value="SN">SN</option>
                    </select>
                </label>

                <label className="payment-filter-field payment-filter-search">
                    <span>Buscar alvo</span>
                    <input
                        type="search"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Base, ramal ou médico"
                    />
                </label>

                <div className="payment-filter-actions">
                    <button type="button" className="payment-button" onClick={() => void applyFilters()} disabled={isRefreshing || isSaving}>
                        {isRefreshing ? "Lendo..." : "Abrir slot"}
                    </button>
                    <button type="button" className="payment-button" onClick={() => void handleAction("refresh")} disabled={isRefreshing || isSaving || isApproved}>
                        {isSaving ? "Aplicando..." : view.slot.isPersisted ? "Atualizar snapshot" : "Salvar snapshot"}
                    </button>
                    <button type="button" className="payment-button primary" onClick={() => void handleAction("approve")} disabled={isRefreshing || isSaving || !canApprove}>
                        Aprovar slot
                    </button>
                    <button type="button" className="payment-button" onClick={() => void handleAction("reopen")} disabled={isRefreshing || isSaving || !isApproved}>
                        Reabrir
                    </button>
                </div>
            </section>

            {(loadError || actionError || feedbackMessage) && (
                <section className={`payment-inline-banner ${loadError || actionError ? "danger" : "ok"}`.trim()}>
                    <strong>{loadError || actionError ? "Falha no fechamento" : "Fechamento atualizado"}</strong>
                    <span>{loadError ?? actionError ?? feedbackMessage}</span>
                </section>
            )}

            <section className="payment-grid">
                <div className="payment-directory-column">
                    <header className="payment-directory-header">
                        <div>
                            <p className="reports-kicker">Alvos do snapshot</p>
                            <h2>Escolha a base ou o ramal para ver exatamente por que ele entra ou trava o pagamento.</h2>
                        </div>
                        <span className={`reports-badge ${slotStatusBadgeTone(view.slot.status)}`.trim()}>{slotStatusLabel(view.slot.status)}</span>
                    </header>

                    <div className="payment-target-list">
                        {filteredRows.length === 0 ? (
                            <article className="payment-empty-state">
                                <strong>Nenhum alvo encontrado.</strong>
                                <span>Ajuste a busca ou abra outro slot.</span>
                            </article>
                        ) : filteredRows.map((row) => (
                            <button
                                key={rowKey(row)}
                                type="button"
                                className={`payment-target-card ${selectedRow && rowKey(selectedRow) === rowKey(row) ? "selected" : ""}`.trim()}
                                onClick={() => setSelectedKey(rowKey(row))}
                            >
                                <div className="payment-target-card-topline">
                                    <span className={`payment-status-pill ${statusTone(row)}`.trim()}>{statusLabel(row)}</span>
                                    <span className={`payment-domain-pill ${row.domain}`.trim()}>{domainLabel(row.domain)}</span>
                                </div>

                                <div>
                                    <strong>{row.targetCode}</strong>
                                    <span>{row.targetLabel}</span>
                                </div>

                                <p className="payment-target-primary">{primaryDoctorLabel(row)}</p>
                                <p className="payment-target-summary">{summarizeIssues(row)}</p>

                                <div className="payment-target-meta">
                                    <span>{isDisabledRow(row) ? "Estado operacional" : sourceLabel(row.source)}</span>
                                    <span>{row.occupancyId ? formatTime(row.startedAt) : "sem início"}</span>
                                    <span>{row.candidateCount > 1 ? `${row.candidateCount} candidatos` : row.occupancyId ? "1 titular" : "sem titular"}</span>
                                </div>
                            </button>
                        ))}
                    </div>
                </div>

                <aside className="payment-detail-panel">
                    {selectedRow ? (
                        <>
                            <header className="payment-detail-header">
                                <div>
                                    <p className="reports-kicker">Linha congelada</p>
                                    <h2>{selectedRow.targetCode} · {selectedRow.targetLabel}</h2>
                                    <p>{domainLabel(selectedRow.domain)} · {formatDateLabel(view.slot.operationalDate)} · {view.slot.shiftLabel}</p>
                                </div>
                                <span className={`payment-status-pill large ${statusTone(selectedRow)}`.trim()}>{statusLabel(selectedRow)}</span>
                            </header>

                            <section className="payment-detail-card emphasis">
                                <span className="payment-eyebrow">Quem ficou valendo neste slot</span>
                                <strong>{primaryDoctorLabel(selectedRow)}</strong>
                                <p>
                                    {isDisabledRow(selectedRow)
                                        ? `Esta base saiu completamente da conta do turno. ${selectedRow.disabledAt ? `Desativada às ${formatDateTime(selectedRow.disabledAt)}.` : "Sem horário detalhado."}`
                                        : selectedRow.occupancyId
                                            ? `Origem ${sourceLabel(selectedRow.source)} · início ${formatDateTime(selectedRow.startedAt)} · saída considerada ${formatDateTime(selectedRow.actualEndedAt ?? selectedRow.endedAt)}.`
                                            : "Este alvo ainda não fechou com titular consolidado e por isso trava a aprovação do slot."}
                                </p>
                            </section>

                            <section className="payment-kpi-grid">
                                <article className="payment-kpi-card">
                                    <span className="payment-eyebrow">Janela prevista</span>
                                    <strong>{formatTime(selectedRow.scheduledStartAt)} → {formatTime(selectedRow.scheduledEndAt)}</strong>
                                </article>
                                <article className="payment-kpi-card">
                                    <span className="payment-eyebrow">Atraso</span>
                                    <strong>{formatMinutes(selectedRow.arrivalDelayMinutes)}</strong>
                                </article>
                                <article className="payment-kpi-card">
                                    <span className="payment-eyebrow">Crédito</span>
                                    <strong>{formatMinutes(selectedRow.creditedOvertimeMinutes)}</strong>
                                </article>
                                <article className="payment-kpi-card">
                                    <span className="payment-eyebrow">Saldo</span>
                                    <strong>{formatMinutes(selectedRow.balanceMinutes)}</strong>
                                </article>
                            </section>

                            <section className="payment-detail-grid">
                                <article className="payment-detail-card">
                                    <span className="payment-eyebrow">Leitura operacional</span>
                                    <ul className="payment-detail-list">
                                        <li>Função: {selectedRow.roleLabel ?? selectedRow.defaultRole ?? "sem função declarada"}</li>
                                        <li>Ramal/base exibido: {selectedRow.ramalLabel ?? selectedRow.targetCode}</li>
                                        <li>Shift salvo: {selectedRow.shiftLabel ?? view.slot.shiftLabel}</li>
                                        <li>Regra do banco: {selectedRow.ruleCode ?? "não calculada"}</li>
                                        {selectedRow.disabledDuringShift && <li>Estado da base: desativada{selectedRow.disabledAt ? ` às ${formatTime(selectedRow.disabledAt)}` : " no turno"}</li>}
                                    </ul>
                                </article>

                                <article className="payment-detail-card">
                                    <span className="payment-eyebrow">Auditoria do fechamento</span>
                                    <ul className="payment-detail-list">
                                        <li>Snapshot gerado em {formatDateTime(view.slot.snapshotGeneratedAt)}</li>
                                        <li>Última atualização por {view.slot.lastRefreshedByEmail ?? "sistema"}</li>
                                        <li>Aprovação: {view.slot.approvedAt ? `${formatDateTime(view.slot.approvedAt)} por ${view.slot.approvedByEmail ?? "admin"}` : "ainda não aprovado"}</li>
                                    </ul>
                                </article>
                            </section>

                            <section className={`payment-detail-card issues ${selectedRow.issues.length === 0 ? "ready" : "review"}`.trim()}>
                                <span className="payment-eyebrow">Pendências desta linha</span>
                                {selectedRow.issues.length === 0 ? (
                                    <p>Sem pendência aberta. Esta linha já está coerente para pagamento do turno.</p>
                                ) : (
                                    <ul className="payment-detail-list">
                                        {selectedRow.issues.map((issue) => <li key={issue}>{issue}</li>)}
                                    </ul>
                                )}
                            </section>

                            <section className="payment-detail-card">
                                <span className="payment-eyebrow">Explicação do banco de horas</span>
                                <p>{selectedRow.bankHoursExplanation ?? "Ainda não existe explicação consolidada de banco de horas para esta linha."}</p>
                            </section>
                        </>
                    ) : (
                        <article className="payment-empty-state standalone">
                            <strong>Sem linha selecionada.</strong>
                            <span>Abra um slot ou ajuste a busca para analisar o fechamento.</span>
                        </article>
                    )}
                </aside>
            </section>
        </main>
    );
}