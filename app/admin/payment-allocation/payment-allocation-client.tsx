"use client";

import { useDeferredValue, useEffect, useEffectEvent, useMemo, useState, useTransition } from "react";
import type { PaymentAllocationBoard, PaymentAllocationRow } from "@/services/board.service";

interface DoctorOption {
    id: string;
    fullName: string;
    displayName: string | null;
}

interface Props {
    initialBoard: PaymentAllocationBoard;
    doctors: DoctorOption[];
}

function normalizeSearch(value: string) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
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

function domainLabel(domain: PaymentAllocationRow["domain"]) {
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

function rowKey(row: PaymentAllocationRow) {
    return `${row.domain}:${row.targetCode}`;
}

function rowSearchIndex(row: PaymentAllocationRow) {
    return normalizeSearch([
        row.targetCode,
        row.targetLabel,
        row.doctorName ?? "",
        row.displayName ?? "",
        domainLabel(row.domain),
        row.roleLabel ?? "",
    ].join(" "));
}

function statusTone(status: PaymentAllocationRow["paymentStatus"], hasOccupancy: boolean) {
    if (!hasOccupancy) {
        return "empty" as const;
    }

    return status === "ready_for_payment" ? "ready" as const : "review" as const;
}

function statusLabel(row: PaymentAllocationRow) {
    if (!row.occupancyId) {
        return "Vazio";
    }

    return row.paymentStatus === "ready_for_payment" ? "Pronto" : "Revisar";
}

function primaryDoctorLabel(row: PaymentAllocationRow) {
    if (!row.occupancyId) {
        return "Sem ocupação consolidada";
    }

    return row.displayName ?? row.doctorName ?? "Médico não identificado";
}

function summarizeIssues(row: PaymentAllocationRow) {
    if (row.issues.length === 0) {
        return "Sem pendência operacional para pagamento.";
    }

    return row.issues.slice(0, 2).join(" • ");
}

function candidateSummary(row: PaymentAllocationRow) {
    if (!row.occupancyId) {
        return row.candidateCount > 0 ? `${row.candidateCount} candidato${row.candidateCount === 1 ? "" : "s"} bloqueado${row.candidateCount === 1 ? "" : "s"}` : "sem titular";
    }

    return row.candidateCount > 1 ? `${row.candidateCount} candidatos` : "1 titular";
}

export function PaymentAllocationClient({ initialBoard, doctors }: Props) {
    const [board, setBoard] = useState(initialBoard);
    const [selectedKey, setSelectedKey] = useState(() => {
        const firstReview = [...initialBoard.regulation, ...initialBoard.intervention].find((row) => row.paymentStatus === "needs_review");
        const firstRow = firstReview ?? initialBoard.regulation[0] ?? initialBoard.intervention[0] ?? null;
        return firstRow ? rowKey(firstRow) : null;
    });
    const [search, setSearch] = useState("");
    const deferredSearch = useDeferredValue(search);
    const [dateInput, setDateInput] = useState(boardDateInputValue(initialBoard.operationalDate));
    const [shiftInput, setShiftInput] = useState<"SD" | "SN">(initialBoard.shiftLabel);
    const [selectedDoctorId, setSelectedDoctorId] = useState<string>("");
    const [correctionNote, setCorrectionNote] = useState("");
    const [loadError, setLoadError] = useState<string | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
    const [isRefreshing, startRefreshTransition] = useTransition();
    const [isSaving, startSaveTransition] = useTransition();

    const combinedRows = useMemo(
        () => [...board.regulation, ...board.intervention],
        [board.intervention, board.regulation],
    );

    const filteredRows = useMemo(() => {
        const normalized = normalizeSearch(deferredSearch);
        if (!normalized) {
            return combinedRows;
        }

        return combinedRows.filter((row) => rowSearchIndex(row).includes(normalized));
    }, [combinedRows, deferredSearch]);

    const selectedRow = filteredRows.find((row) => rowKey(row) === selectedKey)
        ?? combinedRows.find((row) => rowKey(row) === selectedKey)
        ?? filteredRows[0]
        ?? combinedRows[0]
        ?? null;

    useEffect(() => {
        if (!selectedRow) {
            return;
        }

        if (selectedKey !== rowKey(selectedRow)) {
            setSelectedKey(rowKey(selectedRow));
        }
    }, [selectedKey, selectedRow]);

    useEffect(() => {
        setSelectedDoctorId(selectedRow?.doctorId ?? "");
        setCorrectionNote("");
        setSaveError(null);
    }, [selectedRow?.doctorId, selectedRow?.occupancyId]);

    const loadBoard = useEffectEvent(async (params?: { date?: string | null; shift?: "SD" | "SN" | null }) => {
        setLoadError(null);
        setFeedbackMessage(null);

        const query = new URLSearchParams();
        if (params?.date && params?.shift) {
            query.set("date", params.date);
            query.set("shift", params.shift);
        }

        const response = await fetch(`/api/board/payment-allocation${query.size > 0 ? `?${query.toString()}` : ""}`, {
            method: "GET",
            cache: "no-store",
        });
        const body = await response.json().catch(() => null) as PaymentAllocationBoard | { error?: string } | null;
        if (!response.ok) {
            throw new Error(body && typeof body === "object" && "error" in body ? body.error || "Falha ao carregar painel." : "Falha ao carregar painel.");
        }

        const nextBoard = body as PaymentAllocationBoard;
        startRefreshTransition(() => {
            setBoard(nextBoard);
            setDateInput(boardDateInputValue(nextBoard.operationalDate));
            setShiftInput(nextBoard.shiftLabel);
        });
    });

    const applyFilters = useEffectEvent(async () => {
        try {
            await loadBoard({ date: dateInput, shift: shiftInput });
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : "Falha ao carregar alocação de pagamento.");
        }
    });

    const resetToCurrentShift = useEffectEvent(async () => {
        try {
            await loadBoard();
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : "Falha ao carregar turno atual.");
        }
    });

    const submitCorrection = useEffectEvent(async () => {
        if (!selectedRow?.occupancyId || !selectedDoctorId || selectedDoctorId === selectedRow.doctorId) {
            return;
        }

        setSaveError(null);
        setFeedbackMessage(null);

        const endpoint = selectedRow.domain === "regulation"
            ? `/api/regulation/occupancies/${selectedRow.occupancyId}`
            : `/api/intervention/occupancies/${selectedRow.occupancyId}`;
        const response = await fetch(endpoint, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                doctorId: selectedDoctorId,
                ...(correctionNote.trim() ? { notes: `[payment-allocation] ${correctionNote.trim()}` } : {}),
            }),
        });
        const body = await response.json().catch(() => null) as { error?: string } | null;
        if (!response.ok) {
            throw new Error(body?.error || "Não foi possível aplicar a correção.");
        }

        await loadBoard({ date: dateInput, shift: shiftInput });
        setFeedbackMessage(`Alocação de ${selectedRow.targetCode} atualizada e reavaliada para pagamento.`);
    });

    const canSubmitCorrection = Boolean(
        selectedRow?.occupancyId
        && selectedDoctorId
        && selectedDoctorId !== selectedRow.doctorId,
    );

    return (
        <main className="payment-shell">
            <section className="payment-hero">
                <div>
                    <p className="reports-kicker">Pagamento operacional</p>
                    <h1>Quem fecha o turno no banco por base ou ramal, com revisão pronta para o admin.</h1>
                    <p className="payment-subtitle">
                        Esta leitura pega o turno operacional, escolhe o ocupante que efetivamente vai para pagamento em cada entidade e separa o que já está limpo do que ainda precisa conferência humana.
                    </p>
                </div>

                <div className="payment-hero-actions">
                    <a className="reports-secondary-link" href="/admin/reports">Abrir auditoria mensal</a>
                    <a className="reports-secondary-link" href="/admin/bank-hours">Abrir banco de horas</a>
                    <a className="reports-secondary-link" href="/">Voltar ao quadro</a>
                </div>
            </section>

            <section className="payment-summary-grid">
                <article className="payment-summary-card">
                    <span className="reports-summary-label">Alvos no turno</span>
                    <strong>{board.summary.totalTargets}</strong>
                    <span>{formatDateLabel(board.operationalDate)} · {board.shiftLabel}</span>
                </article>
                <article className="payment-summary-card ready">
                    <span className="reports-summary-label">Prontos</span>
                    <strong>{board.summary.readyForPaymentCount}</strong>
                    <span>sem pendência operacional de pagamento</span>
                </article>
                <article className="payment-summary-card review">
                    <span className="reports-summary-label">Em revisão</span>
                    <strong>{board.summary.needsReviewCount}</strong>
                    <span>com atraso, conflito, vazio ou correção manual</span>
                </article>
                <article className="payment-summary-card empty">
                    <span className="reports-summary-label">Sem ocupação</span>
                    <strong>{board.summary.unassignedCount}</strong>
                    <span>alvos que não fecharam com titular identificado</span>
                </article>
            </section>

            <section className="payment-filter-bar">
                <label className="payment-filter-field">
                    <span>Data operacional</span>
                    <input
                        type="date"
                        value={dateInput}
                        onChange={(event) => setDateInput(event.target.value)}
                    />
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
                    <button type="button" className="payment-button primary" onClick={() => void applyFilters()} disabled={isRefreshing || isSaving}>
                        {isRefreshing ? "Atualizando..." : "Conferir"}
                    </button>
                    <button type="button" className="payment-button" onClick={() => void resetToCurrentShift()} disabled={isRefreshing || isSaving}>
                        Turno atual
                    </button>
                </div>
            </section>

            {(loadError || feedbackMessage) && (
                <section className={`payment-inline-banner ${loadError ? "danger" : "ok"}`.trim()}>
                    <strong>{loadError ? "Falha na leitura" : "Painel atualizado"}</strong>
                    <span>{loadError ?? feedbackMessage}</span>
                </section>
            )}

            <section className="payment-grid">
                <div className="payment-directory-column">
                    <header className="payment-directory-header">
                        <div>
                            <p className="reports-kicker">Entidades do turno</p>
                            <h2>Escolha a base ou o ramal que precisa fechar para pagamento.</h2>
                        </div>
                        <span className="reports-badge neutral">{filteredRows.length} linhas</span>
                    </header>

                    <div className="payment-target-list">
                        {filteredRows.length === 0 ? (
                            <article className="payment-empty-state">
                                <strong>Nenhum alvo encontrado.</strong>
                                <span>Ajuste a busca ou carregue outra data operacional.</span>
                            </article>
                        ) : filteredRows.map((row) => {
                            const tone = statusTone(row.paymentStatus, Boolean(row.occupancyId));
                            return (
                                <button
                                    key={rowKey(row)}
                                    type="button"
                                    className={`payment-target-card ${selectedRow && rowKey(selectedRow) === rowKey(row) ? "selected" : ""}`.trim()}
                                    onClick={() => setSelectedKey(rowKey(row))}
                                >
                                    <div className="payment-target-card-topline">
                                        <span className={`payment-status-pill ${tone}`.trim()}>{statusLabel(row)}</span>
                                        <span className={`payment-domain-pill ${row.domain}`.trim()}>{domainLabel(row.domain)}</span>
                                    </div>

                                    <div>
                                        <strong>{row.targetCode}</strong>
                                        <span>{row.targetLabel}</span>
                                    </div>

                                    <p className="payment-target-primary">{primaryDoctorLabel(row)}</p>
                                    <p className="payment-target-summary">{summarizeIssues(row)}</p>

                                    <div className="payment-target-meta">
                                        <span>{sourceLabel(row.source)}</span>
                                        <span>{row.occupancyId ? formatTime(row.startedAt) : "sem início"}</span>
                                        <span>{candidateSummary(row)}</span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <aside className="payment-detail-panel">
                    {selectedRow ? (
                        <>
                            <header className="payment-detail-header">
                                <div>
                                    <p className="reports-kicker">Alocação escolhida</p>
                                    <h2>{selectedRow.targetCode} · {selectedRow.targetLabel}</h2>
                                    <p>{domainLabel(selectedRow.domain)} · {formatDateLabel(board.operationalDate)} · {board.shiftLabel}</p>
                                </div>
                                <span className={`payment-status-pill large ${statusTone(selectedRow.paymentStatus, Boolean(selectedRow.occupancyId))}`.trim()}>
                                    {statusLabel(selectedRow)}
                                </span>
                            </header>

                            <section className="payment-detail-card emphasis">
                                <span className="payment-eyebrow">Titular que fecha no banco</span>
                                <strong>{primaryDoctorLabel(selectedRow)}</strong>
                                <p>
                                    {selectedRow.occupancyId
                                        ? `Fonte ${sourceLabel(selectedRow.source)} · início ${formatDateTime(selectedRow.startedAt)} · saída considerada ${formatDateTime(selectedRow.endedAt)}.`
                                        : "Sem ocupação consolidada para este alvo neste turno. Primeiro é preciso acertar a operação antes de fechar o pagamento."}
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
                                        <li>Role no alvo: {selectedRow.roleLabel ?? selectedRow.defaultRole ?? "sem função declarada"}</li>
                                        <li>Ramal/base exibido: {selectedRow.ramalLabel ?? selectedRow.targetCode}</li>
                                        <li>Shift salvo: {selectedRow.shiftLabel ?? board.shiftLabel}</li>
                                        <li>Regra do banco: {selectedRow.ruleCode ?? "não calculada"}</li>
                                    </ul>
                                </article>

                                <article className="payment-detail-card">
                                    <span className="payment-eyebrow">Por que ficou assim</span>
                                    <p>{selectedRow.bankHoursExplanation ?? "Ainda não existe explicação de banco de horas para esta linha."}</p>
                                </article>
                            </section>

                            <section className={`payment-detail-card issues ${selectedRow.issues.length === 0 ? "ready" : "review"}`.trim()}>
                                <span className="payment-eyebrow">Pendências deste alvo</span>
                                {selectedRow.issues.length === 0 ? (
                                    <p>Sem pendência aberta. Esta linha já está coerente para pagamento do turno.</p>
                                ) : (
                                    <ul className="payment-detail-list">
                                        {selectedRow.issues.map((issue) => <li key={issue}>{issue}</li>)}
                                    </ul>
                                )}
                            </section>

                            <section className={`payment-detail-card correction ${selectedRow.occupancyId ? "enabled" : "disabled"}`.trim()}>
                                <div className="payment-correction-header">
                                    <div>
                                        <span className="payment-eyebrow">Correção do médico alocado</span>
                                        <strong>Ajuste manual só para admin</strong>
                                    </div>
                                    <span className="reports-badge neutral">occupancy {selectedRow.occupancyId ?? "--"}</span>
                                </div>

                                {selectedRow.occupancyId ? (
                                    <>
                                        <label className="payment-field">
                                            <span>Médico que deve fechar para pagamento</span>
                                            <select
                                                value={selectedDoctorId}
                                                onChange={(event) => setSelectedDoctorId(event.target.value)}
                                                disabled={isSaving || isRefreshing}
                                            >
                                                <option value="">Selecione o médico</option>
                                                {doctors.map((doctor) => (
                                                    <option key={doctor.id} value={doctor.id}>
                                                        {doctor.displayName ? `${doctor.displayName} - ${doctor.fullName}` : doctor.fullName}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>

                                        <label className="payment-field">
                                            <span>Motivo operacional</span>
                                            <textarea
                                                value={correctionNote}
                                                onChange={(event) => setCorrectionNote(event.target.value)}
                                                rows={4}
                                                placeholder="Ex.: cobertura confirmada pela chefia após conferência do turno"
                                                disabled={isSaving || isRefreshing}
                                            />
                                        </label>

                                        {saveError && (
                                            <div className="payment-inline-note danger">{saveError}</div>
                                        )}

                                        <div className="payment-actions">
                                            <button
                                                type="button"
                                                className="payment-button primary"
                                                disabled={!canSubmitCorrection || isSaving || isRefreshing}
                                                onClick={() => {
                                                    startSaveTransition(() => {
                                                        void submitCorrection().catch((error) => {
                                                            setSaveError(error instanceof Error ? error.message : "Falha ao corrigir alocação.");
                                                        });
                                                    });
                                                }}
                                            >
                                                {isSaving ? "Aplicando..." : "Corrigir médico alocado"}
                                            </button>
                                        </div>
                                    </>
                                ) : (
                                    <p>Sem occupancy identificada. Este alvo ainda não pode ser corrigido por aqui porque o problema está antes da etapa de pagamento.</p>
                                )}
                            </section>
                        </>
                    ) : (
                        <article className="payment-empty-state standalone">
                            <strong>Nenhuma linha disponível para este filtro.</strong>
                            <span>Troque a data operacional ou o turno para recuperar a leitura de pagamento.</span>
                        </article>
                    )}
                </aside>
            </section>
        </main>
    );
}