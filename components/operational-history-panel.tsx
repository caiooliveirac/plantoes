"use client";

import { useDeferredValue, useEffect, useEffectEvent, useRef, useState, useTransition } from "react";
import type {
    HistoricalOperationalBoard,
    HistoricalOperationalRow,
    HistoricalShiftLabel,
    HistoricalTargetOption,
} from "@/services/operational-history.service";

type UserRole = "admin" | "chief";
type OperationalDomain = "regulation" | "intervention";
type EditorMode = "create" | "update";

interface DoctorOption {
    id: string;
    fullName: string;
    displayName: string | null;
}

interface SessionSummary {
    email: string;
    roles: UserRole[];
    mustChangePassword: boolean;
    canManage: boolean;
}

interface Props {
    session: SessionSummary | null;
    doctors: DoctorOption[];
    onReturnLive: () => void;
}

interface EditorState {
    targetId: string;
    doctorId: string;
    arrivalAt: string;
    departureAt: string;
    notes: string;
}

function formatShiftDateLabel(dateKey: string) {
    return new Intl.DateTimeFormat("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        timeZone: "America/Sao_Paulo",
    }).format(new Date(`${dateKey}T12:00:00.000Z`));
}

function formatBoardTime(value: string | null) {
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

function normalizeSearchValue(value: string) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

function doctorOptionLabel(doctor: DoctorOption) {
    return doctor.displayName ? `${doctor.displayName} - ${doctor.fullName}` : doctor.fullName;
}

function matchesDoctorQuery(doctor: DoctorOption, query: string) {
    const normalizedQuery = normalizeSearchValue(query);
    if (!normalizedQuery) {
        return false;
    }

    const haystack = normalizeSearchValue([doctor.fullName, doctor.displayName ?? ""].join(" "));
    return normalizedQuery
        .split(/\s+/)
        .filter(Boolean)
        .every((token) => haystack.includes(token));
}

function toLocalDateTimeValue(value?: string | null) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) {
        return "";
    }

    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function toIsoDateTime(value: string) {
    return new Date(value).toISOString();
}

function trimToNull(value: string) {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function rowStateLabel(row: HistoricalOperationalRow) {
    if (row.state === "occupied") {
        return "Ocupado";
    }

    if (row.state === "disabled") {
        return "Desativado";
    }

    return "Vago";
}

function domainLabel(domain: OperationalDomain) {
    return domain === "regulation" ? "Regulação" : "Intervenção";
}

function targetTypeLabel(domain: OperationalDomain) {
    return domain === "regulation" ? "Ramal" : "Base";
}

function targetColumnLabel(domain: OperationalDomain) {
    return domain === "regulation" ? "Ramal" : "Base";
}

function targetStatusHint(option: HistoricalTargetOption) {
    if (option.state === "disabled") {
        return "Desativado";
    }

    if (option.state === "occupied") {
        return "Já consolidado no turno";
    }

    return "Disponível";
}

function slotKey(date: string, shift: HistoricalShiftLabel) {
    return `${date}:${shift}`;
}

function resolveFirstAvailableTargetId(options: HistoricalTargetOption[]) {
    const target = options.find((option) => !option.disabled && option.state !== "occupied" && Number.isFinite(option.targetId ?? Number.NaN));
    return target?.targetId ? String(target.targetId) : "";
}

function formatPendingPriorityLabel(priority: "critical" | "warning") {
    return priority === "critical" ? "Crítico" : "Atenção";
}

export function OperationalHistoryPanel({ session, doctors, onReturnLive }: Props) {
    const canViewHistory = Boolean(session?.canManage && !session.mustChangePassword);
    const canEditHistory = Boolean(session?.roles.includes("admin") && !session.mustChangePassword);
    const cacheRef = useRef<Map<string, HistoricalOperationalBoard>>(new Map());
    const latestRequestRef = useRef(0);
    const [isTransitionPending, startTransition] = useTransition();
    const [board, setBoard] = useState<HistoricalOperationalBoard | null>(null);
    const [slotSelection, setSlotSelection] = useState<{ date: string; shift: HistoricalShiftLabel }>({
        date: "",
        shift: "SD",
    });
    const [loadingSlotKey, setLoadingSlotKey] = useState<string | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [selectedRow, setSelectedRow] = useState<HistoricalOperationalRow | null>(null);
    const [editorMode, setEditorMode] = useState<EditorMode>("create");
    const [editorDomain, setEditorDomain] = useState<OperationalDomain>("regulation");
    const [formState, setFormState] = useState<EditorState>({
        targetId: "",
        doctorId: "",
        arrivalAt: "",
        departureAt: "",
        notes: "",
    });
    const [doctorQuery, setDoctorQuery] = useState("");
    const deferredDoctorQuery = useDeferredValue(doctorQuery);

    const loadBoard = useEffectEvent(async (
        params?: { date?: string; shift?: HistoricalShiftLabel },
        options?: { preferCache?: boolean },
    ) => {
        if (!canViewHistory) {
            return;
        }

        const requestedDate = params?.date ?? null;
        const requestedShift = params?.shift ?? null;
        const requestedKey = requestedDate && requestedShift ? slotKey(requestedDate, requestedShift) : null;

        if (requestedKey && options?.preferCache) {
            const cachedBoard = cacheRef.current.get(requestedKey) ?? null;
            if (cachedBoard) {
                setLoadError(null);
                startTransition(() => {
                    setBoard(cachedBoard);
                });
                setSlotSelection({ date: cachedBoard.dateKey, shift: cachedBoard.shiftLabel });
                return;
            }
        }

        const requestId = latestRequestRef.current + 1;
        latestRequestRef.current = requestId;

        try {
            setIsLoading(true);
            setLoadingSlotKey(requestedKey);
            setLoadError(null);

            const query = new URLSearchParams();
            if (requestedDate && requestedShift) {
                query.set("date", requestedDate);
                query.set("shift", requestedShift);
            }

            const response = await fetch(`/api/board/history${query.size > 0 ? `?${query.toString()}` : ""}`, {
                method: "GET",
                cache: "no-store",
            });
            const body = await response.json().catch(() => null) as HistoricalOperationalBoard | { error?: string } | null;
            if (!response.ok) {
                throw new Error(body && typeof body === "object" && "error" in body ? body.error || "Falha ao carregar histórico." : "Falha ao carregar histórico.");
            }

            if (requestId !== latestRequestRef.current) {
                return;
            }

            const nextBoard = body as HistoricalOperationalBoard;
            cacheRef.current.set(slotKey(nextBoard.dateKey, nextBoard.shiftLabel), nextBoard);
            startTransition(() => {
                setBoard(nextBoard);
            });
            setSlotSelection({ date: nextBoard.dateKey, shift: nextBoard.shiftLabel });
        } catch (error) {
            if (requestId !== latestRequestRef.current) {
                return;
            }

            setLoadError(error instanceof Error ? error.message : "Falha ao carregar histórico.");
        } finally {
            if (requestId === latestRequestRef.current) {
                setIsLoading(false);
                setLoadingSlotKey(null);
            }
        }
    });

    useEffect(() => {
        if (!canViewHistory) {
            return;
        }

        void loadBoard();
    }, [canViewHistory, loadBoard]);

    const selectedTargetOptions = board?.targetOptions[editorDomain] ?? [];
    const selectedTarget = selectedTargetOptions.find((option) => String(option.targetId ?? "") === formState.targetId) ?? null;
    const selectedDoctor = doctors.find((doctor) => doctor.id === formState.doctorId) ?? null;
    const filteredDoctors = doctors
        .filter((doctor) => matchesDoctorQuery(doctor, deferredDoctorQuery))
        .slice(0, 8);
    const doctorSelectionLocked = Boolean(selectedDoctor && doctorQuery.trim() === doctorOptionLabel(selectedDoctor));
    const displayedSlotKey = board ? slotKey(board.dateKey, board.shiftLabel) : null;
    const showSkeletonOverlay = Boolean(board && isLoading && loadingSlotKey && loadingSlotKey !== displayedSlotKey);
    const isBusy = isLoading || isTransitionPending;
    const areNavigationControlsDisabled = isLoading;

    function syncSelectedDoctorLabel(doctorId: string | null | undefined) {
        const doctor = doctors.find((entry) => entry.id === doctorId) ?? null;
        setDoctorQuery(doctor ? doctorOptionLabel(doctor) : "");
    }

    function closeDrawer() {
        setDrawerOpen(false);
        setSelectedRow(null);
        setSaveError(null);
        setDoctorQuery("");
    }

    function openCreateDrawer(domain: OperationalDomain) {
        if (!board || !canEditHistory) {
            return;
        }

        const targetId = resolveFirstAvailableTargetId(board.targetOptions[domain]);
        setSelectedRow(null);
        setEditorMode("create");
        setEditorDomain(domain);
        setFormState({
            targetId,
            doctorId: "",
            arrivalAt: toLocalDateTimeValue(board.startedAt),
            departureAt: "",
            notes: "",
        });
        setDoctorQuery("");
        setSaveError(null);
        setDrawerOpen(true);
    }

    function openRowDrawer(row: HistoricalOperationalRow) {
        if (!board || !canEditHistory || row.state === "disabled") {
            return;
        }

        setSelectedRow(row);
        setEditorMode(row.occupancyId ? "update" : "create");
        setEditorDomain(row.domain);
        setFormState({
            targetId: String(row.targetId ?? ""),
            doctorId: row.doctorId ?? "",
            arrivalAt: toLocalDateTimeValue(row.arrivalAt ?? board.startedAt),
            departureAt: row.departureAt ? toLocalDateTimeValue(row.departureAt) : "",
            notes: "",
        });
        syncSelectedDoctorLabel(row.doctorId ?? null);
        setSaveError(null);
        setDrawerOpen(true);
    }

    async function reloadCurrentHistoricalSlot() {
        if (!board) {
            return;
        }

        await loadBoard({ date: board.dateKey, shift: board.shiftLabel });
    }

    async function handleNavigate(date: string, shift: HistoricalShiftLabel) {
        setSlotSelection({ date, shift });
        setFeedbackMessage(null);
        setLoadError(null);
        await loadBoard({ date, shift }, { preferCache: true });
    }

    async function handleJumpToSelectedSlot() {
        if (!slotSelection.date) {
            setLoadError("Selecione data e turno para abrir o histórico direto.");
            return;
        }

        setFeedbackMessage(null);
        setLoadError(null);
        await loadBoard({ date: slotSelection.date, shift: slotSelection.shift }, { preferCache: true });
    }

    async function handleDirectShiftSelection(shift: HistoricalShiftLabel) {
        const targetDate = slotSelection.date || board?.dateKey || "";

        setSlotSelection((current) => ({
            ...current,
            date: targetDate || current.date,
            shift,
        }));

        if (!targetDate) {
            return;
        }

        if (board && board.dateKey === targetDate && board.shiftLabel === shift) {
            return;
        }

        await handleNavigate(targetDate, shift);
    }

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();

        if (!board || !canEditHistory) {
            return;
        }

        const targetId = Number(formState.targetId);
        const notes = trimToNull(formState.notes);
        if (!formState.doctorId) {
            setSaveError("Selecione o médico antes de salvar a correção histórica.");
            return;
        }
        if (!formState.arrivalAt) {
            setSaveError("Informe a chegada para registrar o lançamento histórico.");
            return;
        }
        if (!notes) {
            setSaveError("Descreva a justificativa da auditoria antes de salvar.");
            return;
        }

        const arrivalIso = toIsoDateTime(formState.arrivalAt);
        const departureIso = formState.departureAt ? toIsoDateTime(formState.departureAt) : null;
        if (departureIso && new Date(departureIso).getTime() < new Date(arrivalIso).getTime()) {
            setSaveError("A saída não pode ficar antes da chegada.");
            return;
        }

        try {
            setIsSaving(true);
            setSaveError(null);
            setLoadError(null);
            setFeedbackMessage(null);

            const normalizedNotes = `[historico] ${notes}`;

            if (editorMode === "update" && selectedRow?.occupancyId) {
                const endpoint = selectedRow.domain === "regulation"
                    ? `/api/regulation/occupancies/${selectedRow.occupancyId}`
                    : `/api/intervention/occupancies/${selectedRow.occupancyId}`;
                const response = await fetch(endpoint, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        doctorId: formState.doctorId,
                        startedAt: arrivalIso,
                        boardStartedAt: arrivalIso,
                        endedAt: departureIso,
                        actualEndedAt: departureIso,
                        notes: normalizedNotes,
                    }),
                });
                const body = await response.json().catch(() => null) as { error?: string } | null;
                if (!response.ok) {
                    throw new Error(body?.error || "Não foi possível corrigir o lançamento histórico.");
                }
            } else {
                if (!Number.isFinite(targetId) || targetId <= 0 || !selectedTarget || selectedTarget.disabled || selectedTarget.state === "occupied") {
                    setSaveError("Escolha um alvo disponível para adicionar o lançamento histórico.");
                    return;
                }

                const endpoint = editorDomain === "regulation"
                    ? "/api/regulation/occupancies"
                    : "/api/intervention/occupancies";
                const payload = editorDomain === "regulation"
                    ? {
                        doctorId: formState.doctorId,
                        postId: targetId,
                        startedAt: arrivalIso,
                        boardStartedAt: arrivalIso,
                        scheduledStartAt: null,
                        scheduledEndAt: null,
                        shiftLabel: board.shiftLabel,
                        roleLabel: selectedTarget.roleLabel,
                        ramalLabel: selectedTarget.targetCode,
                        source: "admin_correction",
                        notes: normalizedNotes,
                    }
                    : {
                        doctorId: formState.doctorId,
                        baseId: targetId,
                        startedAt: arrivalIso,
                        boardStartedAt: arrivalIso,
                        scheduledStartAt: null,
                        scheduledEndAt: null,
                        shiftLabel: board.shiftLabel,
                        roleLabel: selectedTarget.roleLabel,
                        source: "admin_correction",
                        notes: normalizedNotes,
                    };

                const response = await fetch(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                const body = await response.json().catch(() => null) as {
                    error?: string;
                    occupancy?: { id: string };
                } | null;
                if (!response.ok || !body?.occupancy?.id) {
                    throw new Error(body?.error || "Não foi possível criar o lançamento histórico.");
                }

                if (departureIso) {
                    const patchEndpoint = editorDomain === "regulation"
                        ? `/api/regulation/occupancies/${body.occupancy.id}`
                        : `/api/intervention/occupancies/${body.occupancy.id}`;
                    const patchResponse = await fetch(patchEndpoint, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            endedAt: departureIso,
                            actualEndedAt: departureIso,
                            notes: normalizedNotes,
                        }),
                    });
                    const patchBody = await patchResponse.json().catch(() => null) as { error?: string } | null;
                    if (!patchResponse.ok) {
                        throw new Error(patchBody?.error || "Não foi possível fechar o lançamento histórico recém-criado.");
                    }
                }
            }

            await reloadCurrentHistoricalSlot();
            closeDrawer();
            setFeedbackMessage(editorMode === "update"
                ? "Correção histórica salva e painel recalculado."
                : "Lançamento histórico incluído e painel recalculado.");
        } catch (error) {
            setSaveError(error instanceof Error ? error.message : "Falha operacional inesperada.");
        } finally {
            setIsSaving(false);
        }
    }

    if (!canViewHistory) {
        return (
            <section className="ops-retro-empty-state">
                <div>
                    <p className="ops-kicker">Histórico operacional</p>
                    <h2>Autentique uma sessão de chefia ou admin para auditar turnos passados.</h2>
                    <p className="ops-subtitle">A leitura retrospectiva fica protegida, mas o quadro atual continua disponível em modo leitura.</p>
                </div>
                <button type="button" className="chief-secondary-button" onClick={onReturnLive}>Voltar ao quadro atual</button>
            </section>
        );
    }

    if (!board && isLoading) {
        return (
            <section className="ops-retro-empty-state loading">
                <div>
                    <p className="ops-kicker">Histórico operacional</p>
                    <h2>Carregando turno para auditoria.</h2>
                    <p className="ops-subtitle">Preparando régua de cobertura, pendências relevantes e sequência oficial do turno.</p>
                </div>
            </section>
        );
    }

    if (!board) {
        return (
            <section className="ops-retro-empty-state error">
                <div>
                    <p className="ops-kicker">Histórico operacional</p>
                    <h2>Não foi possível montar o turno retrospectivo.</h2>
                    <p className="ops-subtitle">{loadError ?? "Tente novamente em alguns instantes."}</p>
                </div>
                <div className="ops-retro-empty-actions">
                    <button type="button" className="chief-secondary-button" onClick={() => { void loadBoard(); }} disabled={isBusy}>Recarregar</button>
                    <button type="button" className="chief-primary-button" onClick={onReturnLive}>Voltar ao quadro atual</button>
                </div>
            </section>
        );
    }

    return (
        <>
            <section className={`ops-retro-shell ${showSkeletonOverlay ? "loading" : ""}`.trim()}>
                <header className="ops-retro-header">
                    <div className="ops-retro-heading">
                        <p className="ops-kicker">Histórico operacional</p>
                        <strong className="ops-retro-inline-title">Cobertura retrospectiva</strong>
                        <p className="ops-retro-inline-summary">
                            {board.summary.relevantPending.totalItems} pendências relevantes
                            {` • `}
                            Regulação {board.summary.relevantPending.regulationOccupiedCount}/{board.summary.relevantPending.regulationExpectedCount}
                            {` • `}
                            Intervenção {board.summary.relevantPending.interventionOccupiedCount}/{board.summary.relevantPending.interventionExpectedCount}
                        </p>
                    </div>

                    <div className="ops-retro-controls">
                        <div className="ops-retro-nav" aria-label="Navegação histórica por turno">
                            <button
                                type="button"
                                className="ops-retro-nav-button"
                                onClick={() => { void handleNavigate(board.previousSlot.operationalDate, board.previousSlot.shiftLabel); }}
                                disabled={areNavigationControlsDisabled}
                            >
                                Anterior
                            </button>

                            <div className="ops-retro-nav-current">
                                <span className="ops-retro-mode-pill">Histórico</span>
                                <strong>{formatShiftDateLabel(board.dateKey)} • {board.shiftLabel}</strong>
                                <span>Janela auditada {formatBoardTime(board.startedAt)} - {formatBoardTime(board.endedAt)}</span>
                                {isLoading && loadingSlotKey && slotSelection.date && (
                                    <small>Carregando {formatShiftDateLabel(slotSelection.date)} • {slotSelection.shift}</small>
                                )}
                            </div>

                            <button
                                type="button"
                                className="ops-retro-nav-button"
                                onClick={() => { void handleNavigate(board.nextSlot.operationalDate, board.nextSlot.shiftLabel); }}
                                disabled={areNavigationControlsDisabled}
                            >
                                Próximo
                            </button>
                        </div>

                        <div className="ops-retro-toolbar">
                            <form
                                className="ops-retro-jump"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void handleJumpToSelectedSlot();
                                }}
                            >
                                <label className="ops-retro-jump-field date">
                                    <span>Data</span>
                                    <input
                                        type="date"
                                        value={slotSelection.date}
                                        onChange={(event) => setSlotSelection((current) => ({
                                            ...current,
                                            date: event.target.value,
                                        }))}
                                    />
                                </label>

                                <div className="ops-retro-shift-switch" role="group" aria-label="Turno histórico direto">
                                    {(["SD", "SN"] as const).map((shift) => (
                                        <button
                                            key={shift}
                                            type="button"
                                            className={`ops-retro-shift-button ${slotSelection.shift === shift ? "active" : ""}`.trim()}
                                            onClick={() => { void handleDirectShiftSelection(shift); }}
                                            disabled={areNavigationControlsDisabled}
                                        >
                                            {shift}
                                        </button>
                                    ))}
                                </div>

                                <button type="submit" className="ops-retro-apply-button" disabled={areNavigationControlsDisabled || !slotSelection.date}>
                                    Abrir
                                </button>
                            </form>

                            <button type="button" className="chief-secondary-button" onClick={onReturnLive}>Agora operacional</button>
                        </div>
                    </div>
                </header>

                {(loadError || feedbackMessage) && (
                    <div className={`chief-flash ${loadError ? "error" : "success"}`.trim()}>
                        {loadError || feedbackMessage}
                    </div>
                )}

                <section className="ops-retro-board-grid">
                    {(["regulation", "intervention"] as const).map((domain) => {
                        const rows = domain === "regulation" ? board.regulation : board.intervention;

                        return (
                            <section key={domain} className={`ops-retro-domain-panel ${domain}`.trim()}>
                                <header className="ops-retro-domain-header">
                                    <div>
                                        <p className="ops-section-eyebrow">{domain === "regulation" ? "Cobertura telefônica" : "Bases e viaturas"}</p>
                                        <h2>{domainLabel(domain)}</h2>
                                    </div>

                                    <div className="ops-retro-domain-actions">
                                        <span className="ops-retro-domain-count">{rows.length} linhas esperadas</span>
                                        {canEditHistory && (
                                            <button type="button" className="ops-action-chip" onClick={() => openCreateDrawer(domain)}>
                                                Adicionar lançamento
                                            </button>
                                        )}
                                    </div>
                                </header>

                                <div className="ops-retro-table" role="table" aria-label={`Auditoria histórica de ${domainLabel(domain)}`}>
                                    <div className="ops-retro-row header" role="row">
                                        <div role="columnheader">Chegada</div>
                                        <div role="columnheader">{targetColumnLabel(domain)}</div>
                                        <div role="columnheader">Nome</div>
                                        <div role="columnheader">Saída</div>
                                    </div>

                                    <div className="ops-retro-body" role="rowgroup">
                                        {rows.map((row) => {
                                            const clickable = canEditHistory && row.state !== "disabled";
                                            return (
                                                <div
                                                    key={`${row.domain}:${row.targetCode}`}
                                                    role="row"
                                                    className={`ops-retro-row ${row.state} ${clickable ? "clickable" : ""}`.trim()}
                                                    onClick={clickable ? () => openRowDrawer(row) : undefined}
                                                    onKeyDown={clickable ? (event) => {
                                                        if (event.key === "Enter" || event.key === " ") {
                                                            event.preventDefault();
                                                            openRowDrawer(row);
                                                        }
                                                    } : undefined}
                                                    tabIndex={clickable ? 0 : undefined}
                                                >
                                                    <div role="cell" className="ops-retro-cell time">{row.state === "occupied" ? formatBoardTime(row.arrivalAt) : "--:--"}</div>
                                                    <div role="cell" className="ops-retro-cell code">{row.targetCode}</div>
                                                    <div role="cell" className="ops-retro-cell name">
                                                        <strong>{row.doctorLabel}</strong>
                                                        <span className="ops-retro-cell-meta">{rowStateLabel(row)}</span>
                                                        {row.contextHints.length > 0 && (
                                                            <div className="ops-retro-cell-hints">
                                                                {row.contextHints.map((hint) => (
                                                                    <span key={`${row.targetCode}:${hint}`} className="ops-retro-context-pill">{hint}</span>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div role="cell" className="ops-retro-cell time">{row.state === "occupied" ? formatBoardTime(row.departureAt) : "--:--"}</div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>

                                {showSkeletonOverlay && (
                                    <div className="ops-retro-panel-skeleton" aria-hidden="true">
                                        {Array.from({ length: 4 }).map((_, index) => (
                                            <div key={`${domain}:skeleton:${index}`} className="ops-retro-skeleton-row" />
                                        ))}
                                    </div>
                                )}
                            </section>
                        );
                    })}
                </section>

                <section className="ops-retro-pending-panel">
                    <header className="ops-retro-pending-header">
                        <div>
                            <p className="ops-section-eyebrow">Conferência prioritária</p>
                            <h2>⚠️ Pendências relevantes</h2>
                        </div>
                        <span className="ops-retro-pending-count">{board.summary.relevantPending.totalItems}</span>
                    </header>

                    <p className="ops-retro-pending-summary">
                        Regulação {board.summary.relevantPending.regulationOccupiedCount}/{board.summary.relevantPending.regulationExpectedCount}
                        {` • `}
                        Intervenção {board.summary.relevantPending.interventionOccupiedCount}/{board.summary.relevantPending.interventionExpectedCount}
                    </p>

                    {board.summary.relevantPending.items.length > 0 ? (
                        <div className="ops-retro-pending-list">
                            {board.summary.relevantPending.items.map((item) => (
                                <article
                                    key={`${item.domain}:${item.targetCode}:${item.message}`}
                                    className={`ops-retro-pending-item ${item.priority} ${item.domain}`.trim()}
                                >
                                    <div className="ops-retro-pending-copy">
                                        <span className="ops-retro-pending-domain">{domainLabel(item.domain)}</span>
                                        <strong>{item.targetCode === "REGULACAO" ? item.targetLabel : item.targetCode}</strong>
                                        <p>{item.message}</p>
                                    </div>
                                    <span className={`ops-retro-priority-pill ${item.priority}`.trim()}>
                                        {formatPendingPriorityLabel(item.priority)}
                                    </span>
                                </article>
                            ))}
                        </div>
                    ) : (
                        <p className="ops-retro-pending-empty">Nenhuma pendência crítica para este turno.</p>
                    )}
                </section>
            </section>

            <div className={`chief-drawer-backdrop ${drawerOpen ? "open" : ""}`.trim()} onClick={closeDrawer} />
            <aside className={`chief-drawer ${drawerOpen ? "open" : ""}`.trim()} aria-hidden={!drawerOpen}>
                <header className="chief-drawer-header">
                    <div>
                        <p className="ops-column-kicker">Correção histórica</p>
                        <h2>{editorMode === "update" ? "Ajustar lançamento consolidado" : "Adicionar lançamento ao turno"}</h2>
                    </div>
                    <button type="button" className="chief-close-button" onClick={closeDrawer}>Fechar</button>
                </header>

                {selectedRow && (
                    <section className="chief-drawer-section focus">
                        <div className="chief-context-card">
                            <strong>{targetTypeLabel(selectedRow.domain)} {selectedRow.targetCode}</strong>
                            <span>{domainLabel(selectedRow.domain)} • {rowStateLabel(selectedRow)}</span>
                            {selectedRow.contextHints[0] && <small>{selectedRow.contextHints[0]}</small>}
                        </div>
                    </section>
                )}

                {saveError && (
                    <div className="chief-flash error">{saveError}</div>
                )}

                <form className="chief-drawer-section chief-action-form" onSubmit={handleSubmit}>
                    {!selectedRow && (
                        <label className="chief-field full-width">
                            <span>{targetTypeLabel(editorDomain)}</span>
                            <select
                                className="chief-input chief-select"
                                value={formState.targetId}
                                onChange={(event) => setFormState((current) => ({ ...current, targetId: event.target.value }))}
                            >
                                <option value="">Selecione o alvo</option>
                                {selectedTargetOptions.map((option) => (
                                    <option
                                        key={`${editorDomain}:${option.targetCode}`}
                                        value={String(option.targetId ?? "")}
                                        disabled={option.disabled || option.state === "occupied"}
                                    >
                                        {option.targetCode} • {targetStatusHint(option)}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}

                    <label className="chief-field full-width">
                        <span>Médico</span>
                        <div className="chief-doctor-picker">
                            <input
                                type="text"
                                className="chief-input"
                                value={doctorQuery}
                                onChange={(event) => {
                                    setDoctorQuery(event.target.value);
                                    setFormState((current) => ({ ...current, doctorId: "" }));
                                }}
                                placeholder="Buscar por nome ou nome de guerra"
                            />

                            {selectedDoctor && (
                                <div className="chief-doctor-selection">
                                    <div>
                                        <strong>{doctorOptionLabel(selectedDoctor)}</strong>
                                        <span>{selectedDoctor.fullName}</span>
                                    </div>
                                    <button
                                        type="button"
                                        className="chief-selection-clear"
                                        onClick={() => {
                                            setFormState((current) => ({ ...current, doctorId: "" }));
                                            setDoctorQuery("");
                                        }}
                                    >
                                        Limpar
                                    </button>
                                </div>
                            )}

                            {!doctorSelectionLocked && doctorQuery.trim().length > 0 && filteredDoctors.length > 0 && (
                                <div className="chief-doctor-suggestions">
                                    {filteredDoctors.map((doctor) => (
                                        <button
                                            key={doctor.id}
                                            type="button"
                                            className="chief-doctor-option"
                                            onClick={() => {
                                                setFormState((current) => ({ ...current, doctorId: doctor.id }));
                                                setDoctorQuery(doctorOptionLabel(doctor));
                                            }}
                                        >
                                            <strong>{doctorOptionLabel(doctor)}</strong>
                                            <span>{doctor.fullName}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </label>

                    <label className="chief-field">
                        <span>Chegada</span>
                        <input
                            type="datetime-local"
                            className="chief-input"
                            value={formState.arrivalAt}
                            onChange={(event) => setFormState((current) => ({ ...current, arrivalAt: event.target.value }))}
                        />
                    </label>

                    <label className="chief-field">
                        <span>Saída</span>
                        <input
                            type="datetime-local"
                            className="chief-input"
                            value={formState.departureAt}
                            onChange={(event) => setFormState((current) => ({ ...current, departureAt: event.target.value }))}
                        />
                    </label>

                    <label className="chief-field full-width">
                        <span>Justificativa da auditoria</span>
                        <textarea
                            className="chief-input chief-textarea compact"
                            value={formState.notes}
                            onChange={(event) => setFormState((current) => ({ ...current, notes: event.target.value }))}
                            placeholder="Explique a correção, a lacuna encontrada ou a origem do ajuste retroativo."
                        />
                    </label>

                    <div className="chief-form-actions">
                        <button type="button" className="chief-secondary-button" onClick={closeDrawer} disabled={isSaving}>Cancelar</button>
                        <button type="submit" className="chief-primary-button" disabled={isSaving || isBusy}>
                            {isSaving ? "Salvando..." : editorMode === "update" ? "Salvar correção" : "Adicionar lançamento"}
                        </button>
                    </div>
                </form>
            </aside>
        </>
    );
}