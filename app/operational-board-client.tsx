"use client";

import { useDeferredValue, useEffect, useEffectEvent, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
    getSaoPauloParts,
    resolveContinuationBadgeLabel,
    shouldHighlightInterventionVerification,
} from "@/modules/operational/board-rules";
import type { InterventionBoardRow, RegulationBoardRow } from "@/services/board.service";

type UserRole = "admin" | "chief";
type ActionMode = "correct" | "end" | "start";
type PriorityLevel = "critical" | "high" | "elevated" | "steady";

const COI_CODES = new Set(["1366", "1367", "1368"]);
const MRV_DAY_CODES = new Set(["2032", "2151"]);

interface DoctorOption {
    id: string;
    fullName: string;
    displayName: string | null;
}

interface SessionSummary {
    email: string;
    roles: UserRole[];
    canManage: boolean;
}

interface RegulationCard extends RegulationBoardRow {
    domain: "regulation";
}

interface InterventionCard extends InterventionBoardRow {
    domain: "intervention";
}

type BoardCard = RegulationCard | InterventionCard;

interface OperationalBoardClientProps {
    generatedAt: string;
    shiftLabel: string;
    regulation: RegulationBoardRow[];
    intervention: InterventionBoardRow[];
    doctors: DoctorOption[];
    session: SessionSummary | null;
}

interface FormState {
    doctorId: string;
    startedAt: string;
    endedAt: string;
    roleLabel: string;
    ramalLabel: string;
    notes: string;
}

function formatBoardTime(value: string | null) {
    if (!value) {
        return "--:--";
    }

    return new Date(value).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    });
}

function formatSectionTimestamp(value: string) {
    return new Date(value).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    });
}

function formatShiftMeta(value: string) {
    if (value === "SD") {
        return "Diurno";
    }
    if (value === "SN") {
        return "Noturno";
    }
    if (value === "P") {
        return "Plantao";
    }

    return value || "Operacao";
}

function toLocalDateTimeValue(value?: string | null) {
    const date = value ? new Date(value) : new Date();
    const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
    const local = new Date(safeDate.getTime() - safeDate.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function toIsoDateTime(value: string) {
    return new Date(value).toISOString();
}

function trimToNull(value: string) {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function displayDoctorName(card: BoardCard) {
    if (card.domain === "intervention" && card.status === "waiting") {
        return "Aguardando cobertura";
    }

    return card.displayName || card.doctorName || "Aguardando confirmação";
}

function canEditActiveCard(card: BoardCard) {
    return Boolean(card.occupancyId);
}

function minutesSince(referenceIso: string, value: string | null) {
    if (!value) {
        return null;
    }

    const diffMs = new Date(referenceIso).getTime() - new Date(value).getTime();
    if (Number.isNaN(diffMs)) {
        return null;
    }

    return Math.max(0, Math.floor(diffMs / 60000));
}

function formatMinutesLabel(minutes: number | null) {
    if (minutes === null) {
        return "Sem marcação";
    }

    if (minutes < 60) {
        return `${minutes} min`;
    }

    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder === 0 ? `${hours} h` : `${hours} h ${remainder} min`;
}

function resolvePriority(card: BoardCard, generatedAt: string): PriorityLevel {
    if (card.status === "waiting") {
        return "critical";
    }

    const ageMinutes = minutesSince(generatedAt, card.startedAt);
    if (ageMinutes !== null && ageMinutes >= 720) {
        return "high";
    }
    if (ageMinutes !== null && ageMinutes >= 300) {
        return "elevated";
    }
    return "steady";
}

function priorityLabel(priority: PriorityLevel) {
    if (priority === "critical") {
        return "critico";
    }
    if (priority === "high") {
        return "vigiar";
    }
    if (priority === "elevated") {
        return "atencao";
    }
    return "estavel";
}

function priorityCopy(card: BoardCard, generatedAt: string) {
    const priority = resolvePriority(card, generatedAt);
    if (priority === "critical") {
        return "Sem cobertura confirmada. Chefia precisa agir agora.";
    }
    if (priority === "high") {
        return `Cobertura longa em curso: ${formatMinutesLabel(minutesSince(generatedAt, card.startedAt))}.`;
    }
    if (priority === "elevated") {
        return `Em acompanhamento ha ${formatMinutesLabel(minutesSince(generatedAt, card.startedAt))}.`;
    }
    return "Cobertura dentro do ritmo atual da operacao.";
}

function buildInitialForm(card: BoardCard) {
    return {
        doctorId: card.doctorId ?? "",
        startedAt: toLocalDateTimeValue(card.startedAt),
        endedAt: toLocalDateTimeValue(),
        roleLabel: card.roleLabel ?? (card.domain === "regulation" ? card.defaultRole ?? "" : ""),
        ramalLabel: card.domain === "regulation" ? card.ramalLabel ?? card.postCode : "",
        notes: "",
    } satisfies FormState;
}

function cardCode(card: BoardCard) {
    return card.domain === "regulation" ? card.postCode : card.baseCode;
}

function cardLabel(card: BoardCard) {
    return card.domain === "regulation" ? card.postLabel : card.baseLabel;
}

function extractTrailingNumber(value: string) {
    const match = value.match(/(\d+)$/);
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function regulationSortRank(code: string, shiftLabel: string) {
    if (code === "2031") {
        return 0;
    }

    if (shiftLabel === "SD" && code === "2151") {
        return 1;
    }

    if (shiftLabel === "SD" && code === "2032") {
        return 2;
    }

    if (code.startsWith("1")) {
        return 4;
    }

    return 3;
}

function compareRegulationCards(left: RegulationCard, right: RegulationCard, shiftLabel: string) {
    const leftRank = regulationSortRank(left.postCode, shiftLabel);
    const rightRank = regulationSortRank(right.postCode, shiftLabel);
    if (leftRank !== rightRank) {
        return leftRank - rightRank;
    }

    return Number(left.postCode) - Number(right.postCode);
}

function isInterventionAwaitingNews(card: BoardCard, generatedAt: string) {
    return card.domain === "intervention"
        && card.status === "active"
        && shouldHighlightInterventionVerification(card.startedAt, generatedAt);
}

function rowEmphasisClass(card: BoardCard, shiftLabel: string, generatedAt: string) {
    if (card.domain === "intervention" && card.status === "waiting") {
        return "emphasis-waiting";
    }

    if (isInterventionAwaitingNews(card, generatedAt)) {
        return "emphasis-verification";
    }

    if (card.domain !== "regulation") {
        return "";
    }

    if (COI_CODES.has(card.postCode)) {
        return "emphasis-coi";
    }

    if (shiftLabel === "SD" && MRV_DAY_CODES.has(card.postCode)) {
        return "emphasis-mrv-day";
    }

    return "";
}

function rowAccentLabel(card: BoardCard, shiftLabel: string, generatedAt: string) {
    if (isInterventionAwaitingNews(card, generatedAt)) {
        return "Verificar";
    }

    if (card.domain !== "regulation") {
        return null;
    }

    if (COI_CODES.has(card.postCode)) {
        return "COI";
    }

    if (shiftLabel === "SD" && MRV_DAY_CODES.has(card.postCode)) {
        return "MRV";
    }

    return null;
}

function actionTitle(mode: ActionMode, card: BoardCard) {
    if (mode === "start") {
        return `Abrir cobertura em ${cardCode(card)}`;
    }
    if (mode === "end") {
        return `Encerrar cobertura em ${cardCode(card)}`;
    }
    return `Corrigir quadro de ${cardCode(card)}`;
}

type BoardSnapshot = {
    generatedAt?: string;
};

export function OperationalBoardClient(props: OperationalBoardClientProps) {
    const { generatedAt, shiftLabel, regulation, intervention, doctors, session } = props;
    const router = useRouter();
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [selectedCard, setSelectedCard] = useState<BoardCard | null>(null);
    const [actionMode, setActionMode] = useState<ActionMode | null>(null);
    const [formState, setFormState] = useState<FormState>({
        doctorId: "",
        startedAt: toLocalDateTimeValue(),
        endedAt: toLocalDateTimeValue(),
        roleLabel: "",
        ramalLabel: "",
        notes: "",
    });
    const [doctorQuery, setDoctorQuery] = useState("");
    const deferredDoctorQuery = useDeferredValue(doctorQuery);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isRefreshing, startRefresh] = useTransition();
    const latestGeneratedAtRef = useRef(generatedAt);

    useEffect(() => {
        latestGeneratedAtRef.current = generatedAt;
    }, [generatedAt]);

    const refreshIfBoardChanged = useEffectEvent(async () => {
        if (drawerOpen || isSubmitting || isRefreshing) {
            return;
        }

        try {
            const response = await fetch("/api/board", {
                cache: "no-store",
                headers: { "Accept": "application/json" },
            });

            if (!response.ok) {
                return;
            }

            const snapshot = await response.json() as BoardSnapshot;
            if (!snapshot.generatedAt || snapshot.generatedAt === latestGeneratedAtRef.current) {
                return;
            }

            startRefresh(() => {
                router.refresh();
            });
        } catch {
            return;
        }
    });

    useEffect(() => {
        const intervalId = window.setInterval(() => {
            void refreshIfBoardChanged();
        }, 5000);

        return () => {
            window.clearInterval(intervalId);
        };
    }, [refreshIfBoardChanged]);

    const regulationCards: RegulationCard[] = regulation.map((row) => ({ ...row, domain: "regulation" }));
    const interventionCards: InterventionCard[] = intervention.map((row) => ({ ...row, domain: "intervention" }));
    const visibleRegulationCards = regulationCards
        .filter((card) => card.status === "active" && Boolean(card.doctorId))
        .sort((left, right) => compareRegulationCards(left, right, shiftLabel));
    const visibleInterventionCards = interventionCards
        .filter((card) => (card.status === "active" && Boolean(card.doctorId)) || card.status === "waiting")
        .sort((left, right) => extractTrailingNumber(left.baseCode) - extractTrailingNumber(right.baseCode));
    const allCards: BoardCard[] = [...visibleRegulationCards, ...visibleInterventionCards];
    const interventionWaitingCount = visibleInterventionCards.filter((card) => card.status === "waiting").length;
    const interventionActiveCount = visibleInterventionCards.length - interventionWaitingCount;
    const criticalCards = allCards.filter((card) => resolvePriority(card, generatedAt) === "critical");
    const watchCards = allCards.filter((card) => resolvePriority(card, generatedAt) === "high");
    const filteredDoctors = doctors
        .filter((doctor) => {
            const query = deferredDoctorQuery.trim().toLowerCase();
            if (!query) {
                return true;
            }

            const display = doctor.displayName?.toLowerCase() ?? "";
            return doctor.fullName.toLowerCase().includes(query) || display.includes(query);
        })
        .slice(0, 80);

    function resetDrawerFeedback() {
        setErrorMessage(null);
        setSuccessMessage(null);
    }

    function openDrawer(card?: BoardCard) {
        setDrawerOpen(true);
        if (card) {
            setSelectedCard(card);
            setActionMode(card.status === "waiting" ? "start" : canEditActiveCard(card) ? "correct" : null);
            if (card.status === "waiting" || canEditActiveCard(card)) {
                setFormState(buildInitialForm(card));
            }
        }
        resetDrawerFeedback();
    }

    function openAction(card: BoardCard, mode: ActionMode) {
        if (mode !== "start" && !canEditActiveCard(card)) {
            setSelectedCard(card);
            setActionMode(null);
            setDrawerOpen(true);
            resetDrawerFeedback();
            return;
        }

        setSelectedCard(card);
        setActionMode(mode);
        setFormState(buildInitialForm(card));
        setDoctorQuery("");
        setDrawerOpen(true);
        resetDrawerFeedback();
    }

    function closeDrawer() {
        setDrawerOpen(false);
        setActionMode(null);
        setSelectedCard(null);
        setDoctorQuery("");
    }

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();

        if (!selectedCard || !actionMode) {
            return;
        }
        if (!session?.canManage) {
            setErrorMessage("Entre com perfil chief ou admin para operar correções e encerramentos.");
            return;
        }

        try {
            setIsSubmitting(true);
            setErrorMessage(null);
            setSuccessMessage(null);

            let endpoint = "";
            let method = "POST";
            let payload: Record<string, unknown> = {};

            if (actionMode === "correct") {
                if (!selectedCard.occupancyId) {
                    throw new Error("Nao existe ocupacao ativa para corrigir neste card.");
                }

                endpoint = selectedCard.domain === "regulation"
                    ? `/api/regulation/occupancies/${selectedCard.occupancyId}`
                    : `/api/intervention/occupancies/${selectedCard.occupancyId}`;
                method = "PATCH";
                payload = {
                    doctorId: formState.doctorId || undefined,
                    startedAt: toIsoDateTime(formState.startedAt),
                    boardStartedAt: toIsoDateTime(formState.startedAt),
                    roleLabel: trimToNull(formState.roleLabel),
                    notes: trimToNull(formState.notes),
                    ...(selectedCard.domain === "regulation" ? { ramalLabel: trimToNull(formState.ramalLabel) } : {}),
                };
            }

            if (actionMode === "end") {
                if (!selectedCard.occupancyId) {
                    throw new Error("Nao existe ocupacao ativa para encerrar neste card.");
                }

                endpoint = selectedCard.domain === "regulation"
                    ? `/api/regulation/occupancies/${selectedCard.occupancyId}/end`
                    : `/api/intervention/occupancies/${selectedCard.occupancyId}/end`;
                payload = {
                    endedAt: toIsoDateTime(formState.endedAt),
                    actualEndedAt: toIsoDateTime(formState.endedAt),
                };
            }

            if (actionMode === "start") {
                if (!formState.doctorId) {
                    throw new Error("Selecione um medico para abrir a cobertura.");
                }

                endpoint = selectedCard.domain === "regulation"
                    ? "/api/regulation/occupancies"
                    : "/api/intervention/occupancies";
                payload = selectedCard.domain === "regulation"
                    ? {
                        doctorId: formState.doctorId,
                        postId: selectedCard.postId,
                        startedAt: toIsoDateTime(formState.startedAt),
                        scheduledStartAt: null,
                        scheduledEndAt: null,
                        shiftLabel,
                        roleLabel: trimToNull(formState.roleLabel),
                        ramalLabel: trimToNull(formState.ramalLabel) ?? selectedCard.postCode,
                        source: "admin_correction",
                        notes: trimToNull(formState.notes),
                    }
                    : {
                        doctorId: formState.doctorId,
                        baseId: selectedCard.baseId,
                        startedAt: toIsoDateTime(formState.startedAt),
                        scheduledStartAt: null,
                        scheduledEndAt: null,
                        shiftLabel,
                        roleLabel: trimToNull(formState.roleLabel),
                        source: "admin_correction",
                        notes: trimToNull(formState.notes),
                    };
            }

            const response = await fetch(endpoint, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            const responseBody = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(responseBody?.error || "Falha ao aplicar a acao operacional.");
            }

            setSuccessMessage(actionMode === "end" ? "Cobertura encerrada e quadro atualizado." : "Acao aplicada. Atualizando o quadro operacional.");
            setActionMode(null);
            setSelectedCard(null);
            startRefresh(() => {
                router.refresh();
            });
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "Falha operacional inesperada.");
        } finally {
            setIsSubmitting(false);
        }
    }

    function renderTableRow(card: BoardCard) {
        const emphasisClass = rowEmphasisClass(card, shiftLabel, generatedAt);
        const accentLabel = rowAccentLabel(card, shiftLabel, generatedAt);
        const isClickable = Boolean(session?.canManage);
        const isWaitingIntervention = card.domain === "intervention" && card.status === "waiting";
        const isAwaitingNews = isInterventionAwaitingNews(card, generatedAt);
        const continuationLabel = resolveContinuationBadgeLabel({
            startedAt: card.startedAt,
            shiftLabel: card.shiftLabel,
            reference: generatedAt,
        });
        const isSaoPauloNightShift = getSaoPauloParts(generatedAt).hour >= 19 || getSaoPauloParts(generatedAt).hour < 7;

        return (
            <tr
                key={`${card.domain}-${cardCode(card)}`}
                className={`ops-table-row ${emphasisClass} ${isClickable ? "clickable" : ""}`.trim()}
                onClick={isClickable ? () => openDrawer(card) : undefined}
            >
                <td className="ops-cell code">
                    <div className="ops-code-stack">
                        <strong>{cardCode(card)}</strong>
                        {accentLabel && <span className={`ops-code-accent ${emphasisClass}`}>{accentLabel}</span>}
                    </div>
                </td>
                <td className="ops-cell doctor">
                    <div className="ops-doctor-stack">
                        <div className="ops-doctor-line">
                            <strong>{displayDoctorName(card)}</strong>
                            {isAwaitingNews && <span className="ops-doctor-note">Aguardando noticias</span>}
                            {continuationLabel && <span className={`ops-doctor-note continuation ${isSaoPauloNightShift ? "night" : "day"}`.trim()}>{continuationLabel}</span>}
                        </div>
                    </div>
                </td>
                <td className="ops-cell time">
                    <span className={`ops-time-pill ${isWaitingIntervention ? "waiting" : ""} ${isAwaitingNews ? "verification" : ""}`.trim()}>
                        <strong>{isWaitingIntervention ? "Livre" : formatBoardTime(card.startedAt)}</strong>
                    </span>
                </td>
            </tr>
        );
    }

    function renderSection(cards: BoardCard[], options: { domain: "regulation" | "intervention" }) {
        const isRegulation = options.domain === "regulation";
        const title = isRegulation ? "Regulação" : "Intervenção";
        const eyebrow = isRegulation ? "Mesa central" : "Bases em campo";

        return (
            <section className={`ops-table-shell ${options.domain}`}>
                <header className="ops-section-header">
                    <div className="ops-section-title-block">
                        <p className="ops-section-eyebrow">{eyebrow}</p>
                        <h2>{title}</h2>
                    </div>
                    <div className="ops-section-meta">
                        <span className="ops-section-shift">{formatShiftMeta(shiftLabel)}</span>
                        <span className="ops-section-count">{isRegulation ? `${cards.length} ativos` : `${interventionActiveCount} ativos`}</span>
                        {!isRegulation && interventionWaitingCount > 0 && (
                            <span className="ops-section-waiting">{interventionWaitingCount} aguardando</span>
                        )}
                        <span className="ops-section-updated">Atualizado {formatSectionTimestamp(generatedAt)}</span>
                    </div>
                </header>
                <div className="ops-table-wrap">
                    <table className="ops-table">
                        <thead>
                            <tr>
                                <th>{isRegulation ? "Ramal" : "Base"}</th>
                                <th>Nome</th>
                                <th>Chegada</th>
                            </tr>
                        </thead>
                        <tbody>{cards.map((card) => renderTableRow(card))}</tbody>
                    </table>
                </div>
            </section>
        );
    }

    return (
        <>
            <main className="ops-shell">
                <section className="ops-table-grid plain">
                    {renderSection(visibleInterventionCards, { domain: "intervention" })}
                    {renderSection(visibleRegulationCards, { domain: "regulation" })}
                </section>
            </main>

            <div className={`chief-drawer-backdrop ${drawerOpen ? "open" : ""}`} onClick={closeDrawer} />
            <aside className={`chief-drawer ${drawerOpen ? "open" : ""}`} aria-hidden={!drawerOpen}>
                <header className="chief-drawer-header">
                    <div>
                        <p className="ops-column-kicker">Comando de chefia</p>
                        <h2>Fila critica e correcao rapida</h2>
                    </div>
                    <button type="button" className="chief-close-button" onClick={closeDrawer}>Fechar</button>
                </header>

                {(successMessage || errorMessage) && (
                    <div className={`chief-flash ${errorMessage ? "error" : "success"}`}>
                        {errorMessage || successMessage}
                    </div>
                )}

                {!session?.canManage && (
                    <div className="chief-auth-warning">
                        Esta mesa esta em leitura. Entre com perfil chief ou admin para habilitar abertura, correcao e encerramento.
                    </div>
                )}

                <section className="chief-drawer-section">
                    <div className="chief-stat-grid">
                        <article className="chief-stat-card critical">
                            <span className="ops-summary-label">Pendencias imediatas</span>
                            <strong>{criticalCards.length}</strong>
                        </article>
                        <article className="chief-stat-card watch">
                            <span className="ops-summary-label">Coberturas sob vigia</span>
                            <strong>{watchCards.length}</strong>
                        </article>
                    </div>
                </section>

                <section className="chief-drawer-section">
                    <div className="chief-section-heading">
                        <h3>Vazios que pedem acao</h3>
                        <span>{criticalCards.length}</span>
                    </div>
                    <div className="chief-queue-list">
                        {criticalCards.length === 0 && <p className="chief-empty-copy">Nenhum vazio operacional neste instante.</p>}
                        {criticalCards.map((card) => (
                            <button key={`critical-${card.domain}-${cardCode(card)}`} type="button" className="chief-queue-item critical" onClick={() => openAction(card, "start")}>
                                <strong>{cardCode(card)}</strong>
                                <span>{cardLabel(card)}</span>
                                <small>Abrir cobertura agora</small>
                            </button>
                        ))}
                    </div>
                </section>

                <section className="chief-drawer-section">
                    <div className="chief-section-heading">
                        <h3>Tempo sob vigilância</h3>
                        <span>{watchCards.length}</span>
                    </div>
                    <div className="chief-queue-list">
                        {watchCards.length === 0 && <p className="chief-empty-copy">Nenhuma cobertura longa exigindo vigia especial.</p>}
                        {watchCards.map((card) => (
                            <button key={`watch-${card.domain}-${cardCode(card)}`} type="button" className="chief-queue-item watch" onClick={() => openAction(card, "correct")} disabled={!canEditActiveCard(card)}>
                                <strong>{cardCode(card)}</strong>
                                <span>{displayDoctorName(card)}</span>
                                <small>{canEditActiveCard(card) ? `${formatMinutesLabel(minutesSince(generatedAt, card.startedAt))} em curso` : "Leitura ao vivo sem ocupacao v2"}</small>
                            </button>
                        ))}
                    </div>
                </section>

                <section className="chief-drawer-section focus">
                    {!selectedCard || !actionMode ? (
                        <div className="chief-focus-empty">
                            <h3>Selecione um card para acao rapida</h3>
                            <p>Use os chips do quadro ou as filas deste drawer para abrir cobertura, corrigir medico ou horario e encerrar registro.</p>
                        </div>
                    ) : (
                        <div className="chief-focus-panel">
                            <div className="chief-focus-header">
                                <div>
                                    <p className="ops-column-kicker">Ação ativa</p>
                                    <h3>{actionTitle(actionMode, selectedCard)}</h3>
                                </div>
                                <span className={`ops-priority-tag ${resolvePriority(selectedCard, generatedAt)}`}>{priorityLabel(resolvePriority(selectedCard, generatedAt))}</span>
                            </div>

                            <div className="chief-context-card">
                                <strong>{displayDoctorName(selectedCard)}</strong>
                                <span>{cardLabel(selectedCard)}</span>
                                <small>{selectedCard.status === "waiting" ? "Sem confirmacao ativa no quadro" : `Marcado desde ${formatBoardTime(selectedCard.startedAt)}`}</small>
                            </div>

                            <form className="chief-action-form" onSubmit={handleSubmit}>
                                {(actionMode === "correct" || actionMode === "start") && (
                                    <>
                                        <label className="chief-field">
                                            <span>Buscar medico</span>
                                            <input
                                                className="chief-input"
                                                value={doctorQuery}
                                                onChange={(event) => setDoctorQuery(event.target.value)}
                                                placeholder="Digite nome ou sobrenome"
                                            />
                                        </label>

                                        <label className="chief-field">
                                            <span>Medico</span>
                                            <select
                                                className="chief-input"
                                                value={formState.doctorId}
                                                onChange={(event) => setFormState((current) => ({ ...current, doctorId: event.target.value }))}
                                            >
                                                <option value="">Selecione um medico</option>
                                                {filteredDoctors.map((doctor) => (
                                                    <option key={doctor.id} value={doctor.id}>
                                                        {doctor.displayName ? `${doctor.displayName} - ${doctor.fullName}` : doctor.fullName}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>

                                        <label className="chief-field">
                                            <span>{actionMode === "start" ? "Horario de abertura" : "Horario corrigido"}</span>
                                            <input
                                                type="datetime-local"
                                                className="chief-input"
                                                value={formState.startedAt}
                                                onChange={(event) => setFormState((current) => ({ ...current, startedAt: event.target.value }))}
                                            />
                                        </label>

                                        <label className="chief-field">
                                            <span>Função</span>
                                            <input
                                                className="chief-input"
                                                value={formState.roleLabel}
                                                onChange={(event) => setFormState((current) => ({ ...current, roleLabel: event.target.value }))}
                                                placeholder="Ex.: regulador, intervenção, base operacional"
                                            />
                                        </label>

                                        {selectedCard.domain === "regulation" && (
                                            <label className="chief-field">
                                                <span>Ramal</span>
                                                <input
                                                    className="chief-input"
                                                    value={formState.ramalLabel}
                                                    onChange={(event) => setFormState((current) => ({ ...current, ramalLabel: event.target.value }))}
                                                    placeholder="1321"
                                                />
                                            </label>
                                        )}
                                    </>
                                )}

                                {actionMode === "end" && (
                                    <label className="chief-field">
                                        <span>Horario de encerramento</span>
                                        <input
                                            type="datetime-local"
                                            className="chief-input"
                                            value={formState.endedAt}
                                            onChange={(event) => setFormState((current) => ({ ...current, endedAt: event.target.value }))}
                                        />
                                    </label>
                                )}

                                <label className="chief-field full-width">
                                    <span>Notas operacionais</span>
                                    <textarea
                                        className="chief-input chief-textarea"
                                        value={formState.notes}
                                        onChange={(event) => setFormState((current) => ({ ...current, notes: event.target.value }))}
                                        placeholder="Contexto rapido de chefia, motivo da correcao ou observacao operacional"
                                    />
                                </label>

                                <div className="chief-form-actions full-width">
                                    <button type="button" className="chief-secondary-button" onClick={() => setActionMode(null)}>
                                        Voltar
                                    </button>
                                    <button type="submit" className="chief-primary-button" disabled={isSubmitting || isRefreshing || !session?.canManage}>
                                        {isSubmitting || isRefreshing ? "Aplicando..." : actionMode === "start" ? "Abrir cobertura" : actionMode === "end" ? "Encerrar registro" : "Salvar correcao"}
                                    </button>
                                </div>
                            </form>
                        </div>
                    )}
                </section>
            </aside>
        </>
    );
}