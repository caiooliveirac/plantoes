"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AdminBarNavMenu } from "@/components/admin-bar-nav-menu";
import type { BankHoursDoctorHistory, BankHoursHistoryModel, BankHoursHistoryShift } from "@/modules/reporting/bank-hours-history";
import {
    describeLateDepartureReason,
    translateBankHoursRuleCode,
    translateOccupancyAuditAction,
} from "@/modules/reporting/bank-hours-labels";
import { resolveBankHoursSettlementBalance } from "@/modules/reporting/bank-hours-settlement-rule";
import { formatMinutesForHumans } from "@/modules/reporting/monthly-report";

const SAO_PAULO_TIME_ZONE = "America/Sao_Paulo";

function formatDateTime(value: string | null) {
    if (!value) {
        return "--";
    }

    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: SAO_PAULO_TIME_ZONE,
    }).format(new Date(value));
}

function formatTime(value: string | null) {
    if (!value) {
        return "--";
    }

    return new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: SAO_PAULO_TIME_ZONE,
    }).format(new Date(value));
}

function formatShortDate(value: string | null) {
    if (!value) {
        return "--";
    }

    return new Intl.DateTimeFormat("pt-BR", {
        weekday: "short",
        day: "2-digit",
        month: "2-digit",
        timeZone: SAO_PAULO_TIME_ZONE,
    }).format(new Date(value));
}

function formatDomain(domain: BankHoursHistoryShift["domain"]) {
    return domain === "regulation" ? "Regulação" : "Intervenção";
}

function formatSource(source: BankHoursHistoryShift["source"]) {
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

function normalizeSearch(value: string) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

function formatSignedMinutes(value: number) {
    return `${value > 0 ? "+" : ""}${formatMinutesForHumans(value)}`;
}

/** Gatilho do acerto de banco de horas: ±12h em minutos. */
const BANK_HOURS_SETTLEMENT_MINUTES = 12 * 60;

function shiftBalanceClass(value: number | null) {
    if (value === null || value === 0) {
        return "neutral";
    }

    return value > 0 ? "positive" : "negative";
}

function proofToneClass(mode: BankHoursHistoryShift["proof"]["mode"]) {
    if (mode === "handoff") {
        return "warn";
    }

    if (mode === "double_overtime") {
        return "ok";
    }

    if (mode === "simple_overtime") {
        return "info";
    }

    if (mode === "debit") {
        return "danger";
    }

    return "neutral";
}

function summarizeDoctorSearch(doctor: BankHoursDoctorHistory) {
    return normalizeSearch([
        doctor.doctorName,
        doctor.displayName ?? doctor.doctorName,
        ...doctor.shifts.flatMap((shift) => [shift.targetCode, shift.targetLabel]),
    ].join(" "));
}

function shiftKey(shift: BankHoursHistoryShift) {
    return `${shift.domain}:${shift.occupancyId}`;
}

function shiftAnchorId(shift: BankHoursHistoryShift) {
    return `shift-${shift.domain}-${shift.occupancyId}`;
}

function countBonusShifts(doctor: BankHoursDoctorHistory) {
    return doctor.shifts.filter((shift) => (shift.creditedOvertimeMinutes ?? 0) > 0).length;
}

type SaldoEventTone = "credit" | "debit" | "warn" | "neutral";

interface SaldoEvent {
    key: string;
    anchorId: string | null;
    dateLabel: string;
    placeLabel: string | null;
    tone: SaldoEventTone;
    deltaMinutes: number | null;
    text: string;
}

/**
 * O coração da view: para cada plantão, só o que mexeu no saldo, explicado em
 * uma frase curta em português — com nome, hora e motivo.
 */
function buildShiftEvents(shift: BankHoursHistoryShift): SaldoEvent[] {
    if (shift.proof.mode === "pending") {
        return [];
    }

    const events: SaldoEvent[] = [];
    const anchorId = shiftAnchorId(shift);
    const dateLabel = formatShortDate(shift.startedAt);
    const place = shift.targetCode;
    const delay = shift.arrivalDelayMinutes ?? 0;
    const overtime = shift.overtimeMinutes ?? 0;
    const credited = shift.creditedOvertimeMinutes ?? 0;

    if (shift.ruleCode === "MANUAL_BANK_OVERRIDE") {
        events.push({
            key: `${anchorId}-override`,
            anchorId,
            dateLabel,
            placeLabel: place,
            tone: "neutral",
            deltaMinutes: shift.balanceMinutes,
            text: `Saldo deste plantão fixado manualmente${shift.manualBalanceActorEmail ? ` por ${shift.manualBalanceActorEmail}` : ""}${shift.manualBalanceNotes ? ` — motivo: ${shift.manualBalanceNotes}` : ""}.`,
        });
        return events;
    }

    if (shift.ruleCode?.startsWith("ANOMALY")) {
        events.push({
            key: `${anchorId}-anomaly`,
            anchorId,
            dateLabel,
            placeLabel: place,
            tone: "warn",
            deltaMinutes: null,
            text: "Janela do plantão inconsistente — saldo zerado por segurança até revisão manual.",
        });
        return events;
    }

    if (delay > 0) {
        events.push({
            key: `${anchorId}-delay`,
            anchorId,
            dateLabel,
            placeLabel: place,
            tone: "debit",
            deltaMinutes: -delay,
            text: `Chegou às ${formatTime(shift.countedStartAt)} na ${place} — o plantão começava ${formatTime(shift.bankScheduledStartAt)}. Desconto de ${formatMinutesForHumans(delay)}.`,
        });
    }

    if (credited > 0) {
        if (shift.ruleCode === "LATE_HALF_SHIFT_CARRYOVER") {
            events.push({
                key: `${anchorId}-carryover`,
                anchorId,
                dateLabel,
                placeLabel: place,
                tone: "credit",
                deltaMinutes: credited,
                text: `Chegada tardia virou meio plantão (13h–19h); o tempo trabalhado antes das 13h entrou como crédito de ${formatMinutesForHumans(credited)}.`,
            });
        } else {
            const doubled = credited > overtime;
            const reason = describeLateDepartureReason(shift.lateDeparture);
            const stayed = `Ficou até ${formatTime(shift.countedEndAt)} na ${place} — o previsto era ${formatTime(shift.bankScheduledEndAt)}`;
            const why = reason ? `, porque ${reason}` : "";
            const closing = doubled
                ? `. Como chegou no horário, os ${formatMinutesForHumans(overtime)} contam em dobro: +${formatMinutesForHumans(credited)}.`
                : `. Como a chegada atrasou, o crédito vale simples: +${formatMinutesForHumans(credited)}.`;
            events.push({
                key: `${anchorId}-credit`,
                anchorId,
                dateLabel,
                placeLabel: place,
                tone: "credit",
                deltaMinutes: credited,
                text: `${stayed}${why}${closing}`,
            });
        }
    }

    if (shift.flags.hasHandoffOverride) {
        events.push({
            key: `${anchorId}-handoff`,
            anchorId,
            dateLabel,
            placeLabel: place,
            tone: "warn",
            deltaMinutes: null,
            text: shift.successorDoctorName
                ? `${shift.successorDoctorName} assumiu a ${place} às ${formatTime(shift.countedEndAt)}; a contagem parou na rendição, não na saída física (${formatTime(shift.actualEndedAt)}).`
                : `A contagem parou na rendição das ${formatTime(shift.countedEndAt)}, não na saída física (${formatTime(shift.actualEndedAt)}).`,
        });
    }

    if (shift.corrections.some((correction) => !correction.undone)) {
        const lastCorrection = shift.corrections[shift.corrections.length - 1];
        events.push({
            key: `${anchorId}-correction`,
            anchorId,
            dateLabel,
            placeLabel: place,
            tone: "warn",
            deltaMinutes: null,
            text: `Chegada/saída deste plantão foi corrigida pela chefia${lastCorrection?.chiefOnDutyName ? ` (${lastCorrection.chiefOnDutyName} estava na 2031)` : ""} — detalhes no card abaixo.`,
        });
    }

    return events;
}

function buildDoctorEvents(doctor: BankHoursDoctorHistory): SaldoEvent[] {
    const shiftEvents = doctor.shifts.flatMap(buildShiftEvents);
    const settlementEvents: SaldoEvent[] = doctor.settlements
        .slice()
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((settlement) => ({
            key: `settlement-${settlement.id}`,
            anchorId: null,
            dateLabel: formatShortDate(settlement.operationalDate ?? settlement.createdAt),
            placeLabel: `fechamento ${settlement.monthKey}`,
            tone: settlement.kind === "bonus" ? "credit" as const : "debit" as const,
            deltaMinutes: settlement.deltaMinutes,
            text: settlement.kind === "bonus"
                ? `Acerto do fechamento ${settlement.monthKey}: crédito pago como plantão verde; o saldo devolve 12 h.`
                : `Acerto do fechamento ${settlement.monthKey}: punição descontada como plantão vermelho; o saldo recebe 12 h de volta.`,
        }));

    return [...settlementEvents, ...shiftEvents];
}

interface DoctorEventTotals {
    delayCount: number;
    delayMinutes: number;
    bonusCount: number;
    bonusMinutes: number;
    handoffCount: number;
    correctionCount: number;
    settlementCount: number;
    overrideCount: number;
}

function buildDoctorEventTotals(doctor: BankHoursDoctorHistory): DoctorEventTotals {
    const totals: DoctorEventTotals = {
        delayCount: 0,
        delayMinutes: 0,
        bonusCount: 0,
        bonusMinutes: 0,
        handoffCount: doctor.handoffOverrideCount,
        correctionCount: doctor.correctionCount,
        settlementCount: doctor.settlements.length,
        overrideCount: 0,
    };

    for (const shift of doctor.shifts) {
        const delay = shift.arrivalDelayMinutes ?? 0;
        const credited = shift.creditedOvertimeMinutes ?? 0;
        if (delay > 0) {
            totals.delayCount += 1;
            totals.delayMinutes += delay;
        }
        if (credited > 0) {
            totals.bonusCount += 1;
            totals.bonusMinutes += credited;
        }
        if (shift.manualBalanceMinutes !== null) {
            totals.overrideCount += 1;
        }
    }

    return totals;
}

interface SettlementMonthOption {
    key: string;
    label: string;
}

interface Props {
    history: BankHoursHistoryModel;
    canManageOverrides: boolean;
    settlementMonths: SettlementMonthOption[];
}

export function BankHoursHistoryClient({ history, canManageOverrides, settlementMonths }: Props) {
    const router = useRouter();
    const [search, setSearch] = useState("");
    const deferredSearch = useDeferredValue(search);
    const [selectedDoctorId, setSelectedDoctorId] = useState(history.doctors[0]?.doctorId ?? null);
    const [overrideMinutesByShift, setOverrideMinutesByShift] = useState<Record<string, string>>({});
    const [overrideNotesByShift, setOverrideNotesByShift] = useState<Record<string, string>>({});
    const [overrideErrorsByShift, setOverrideErrorsByShift] = useState<Record<string, string>>({});
    const [savingShiftKey, setSavingShiftKey] = useState<string | null>(null);
    const [isSaving, startSavingTransition] = useTransition();
    const [settlementMonth, setSettlementMonth] = useState(settlementMonths[0]?.key ?? "");
    // Gaveta "Como ler" da faixa de comando (absorveu o herói e os princípios).
    const [guideOpen, setGuideOpen] = useState(false);
    const detailPanelRef = useRef<HTMLElement | null>(null);

    // Em layout empilhado (≤1180px) o detalhe fica ABAIXO da lista inteira de
    // médicos — sem isso o admin precisa arrastar a página toda após o clique.
    function selectDoctor(doctorId: string) {
        setSelectedDoctorId(doctorId);
        if (window.matchMedia("(max-width: 1180px)").matches) {
            // Timeout curto: espera o React commitar o novo detalhe antes de rolar.
            // behavior "auto" (salto): o smooth era abortado pelo re-render do painel.
            window.setTimeout(() => {
                detailPanelRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
            }, 80);
        }
    }

    useEffect(() => {
        const nextMinutes: Record<string, string> = {};
        const nextNotes: Record<string, string> = {};

        for (const doctor of history.doctors) {
            for (const shift of doctor.shifts) {
                nextMinutes[shiftKey(shift)] = String(shift.manualBalanceMinutes ?? shift.balanceMinutes ?? 0);
                nextNotes[shiftKey(shift)] = shift.manualBalanceNotes ?? "";
            }
        }

        setOverrideMinutesByShift(nextMinutes);
        setOverrideNotesByShift(nextNotes);
        setOverrideErrorsByShift({});
        setSavingShiftKey(null);
    }, [history.generatedAt, history.doctors]);

    const filteredDoctors = useMemo(() => {
        const normalized = normalizeSearch(deferredSearch);
        if (!normalized) {
            return history.doctors;
        }

        return history.doctors.filter((doctor) => summarizeDoctorSearch(doctor).includes(normalized));
    }, [deferredSearch, history.doctors]);

    const globalTotals = useMemo(() => {
        let delayCount = 0;
        let bonusCount = 0;
        for (const doctor of history.doctors) {
            for (const shift of doctor.shifts) {
                if ((shift.arrivalDelayMinutes ?? 0) > 0) {
                    delayCount += 1;
                }
                if ((shift.creditedOvertimeMinutes ?? 0) > 0) {
                    bonusCount += 1;
                }
            }
        }
        return { delayCount, bonusCount };
    }, [history.doctors]);

    const selectedDoctor = filteredDoctors.find((doctor) => doctor.doctorId === selectedDoctorId)
        ?? history.doctors.find((doctor) => doctor.doctorId === selectedDoctorId)
        ?? filteredDoctors[0]
        ?? history.doctors[0]
        ?? null;

    useEffect(() => {
        if (!selectedDoctor && filteredDoctors[0]) {
            setSelectedDoctorId(filteredDoctors[0].doctorId);
            return;
        }

        if (selectedDoctor && selectedDoctor.doctorId !== selectedDoctorId) {
            setSelectedDoctorId(selectedDoctor.doctorId);
        }
    }, [filteredDoctors, selectedDoctor, selectedDoctorId]);

    const selectedDoctorEvents = useMemo(
        () => (selectedDoctor ? buildDoctorEvents(selectedDoctor) : []),
        [selectedDoctor],
    );
    const selectedDoctorTotals = useMemo(
        () => (selectedDoctor ? buildDoctorEventTotals(selectedDoctor) : null),
        [selectedDoctor],
    );

    function scrollToShift(anchorId: string | null) {
        if (!anchorId) {
            return;
        }

        document.getElementById(anchorId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    async function submitManualOverride(shift: BankHoursHistoryShift) {
        const key = shiftKey(shift);
        const rawMinutes = (overrideMinutesByShift[key] ?? "").trim();
        const minutes = Number(rawMinutes);
        const notes = (overrideNotesByShift[key] ?? "").trim();

        if (!Number.isInteger(minutes)) {
            throw new Error("Digite o saldo final em minutos inteiros, por exemplo 0, 30 ou -15.");
        }

        if (notes.length < 8) {
            throw new Error("Explique o motivo com pelo menos 8 caracteres.");
        }

        const response = await fetch("/api/admin/bank-hours/overrides", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                domain: shift.domain,
                occupancyId: shift.occupancyId,
                balanceMinutes: minutes,
                notes,
            }),
        });
        const body = await response.json().catch(() => null) as { error?: string } | null;
        if (!response.ok) {
            throw new Error(body?.error || "Nao foi possivel salvar o ajuste manual.");
        }

        router.refresh();
    }

    return (
        <main className="hours-shell">
            {/* Faixa de comando compacta: busca + KPIs + gaveta "Como ler" + navegação ••• */}
            <section className="admin-bar-frame standalone">
                <header className="admin-bar">
                    <span className="admin-bar-kicker">Banco de horas</span>
                    <input
                        type="search"
                        className="admin-bar-search"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Buscar médico, base ou posto"
                        aria-label="Buscar médico"
                    />
                    <span className="admin-bar-divider" aria-hidden="true" />
                    <div className="admin-bar-kpis">
                        <div className="admin-bar-kpi">
                            <strong>{history.summary.doctorCount}</strong>
                            <span>médicos</span>
                        </div>
                        <div className="admin-bar-kpi danger" title="Plantões com chegada fora da tolerância de 15 min">
                            <strong>{globalTotals.delayCount}</strong>
                            <span>com desconto</span>
                        </div>
                        <div className="admin-bar-kpi" title="Plantões com permanência além do previsto creditada">
                            <strong>{globalTotals.bonusCount}</strong>
                            <span>com bônus</span>
                        </div>
                        <div
                            className="admin-bar-kpi warn"
                            title={`${history.summary.correctionCount} correções da chefia e ${history.summary.handoffOverrideCount} rendições antes da saída física`}
                        >
                            <strong>{history.summary.correctionCount + history.summary.handoffOverrideCount}</strong>
                            <span>correções + rendições</span>
                        </div>
                    </div>
                    <div className="admin-bar-actions">
                        <button
                            type="button"
                            className={`admin-bar-filters-toggle ${guideOpen ? "open" : ""}`.trim()}
                            onClick={() => setGuideOpen((prev) => !prev)}
                            aria-expanded={guideOpen}
                        >
                            Como ler
                            <span aria-hidden="true">{guideOpen ? "▴" : "▾"}</span>
                        </button>
                        <AdminBarNavMenu current="bank-hours" />
                    </div>
                </header>

                {guideOpen ? (
                    <div className="admin-bar-drawer">
                        <div className="admin-bar-drawer-inner">
                            <div className="admin-bar-drawer-grid">
                                <div className="admin-bar-drawer-group">
                                    <span>O que a tela mostra</span>
                                    <p>Ao abrir um médico, primeiro vem só o que mexeu no saldo: cada atraso, cada bônus e cada correção, com o motivo em uma linha. Clique numa linha para pular para o plantão.</p>
                                </div>
                                <div className="admin-bar-drawer-group">
                                    <span>Atraso desconta · excedente credita</span>
                                    <p>Chegada até 15 min após o previsto não desconta. Permanência além de 15 min do fim credita — em dobro se a chegada foi no horário, simples se atrasou.</p>
                                </div>
                                <div className="admin-bar-drawer-group">
                                    <span>Rendição encerra a contagem</span>
                                    <p>Quando alguém assume o posto antes da saída física, o banco para na rendição. A tela nomeia quem assumiu e mantém a saída física como prova.</p>
                                </div>
                                <div className="admin-bar-drawer-group">
                                    <span>Correções assinadas</span>
                                    <p>Cada correção de chegada/saída aparece com quem corrigiu e quem era a chefia na 2031 naquele momento.</p>
                                </div>
                            </div>
                        </div>
                    </div>
                ) : null}
            </section>

            <section className="hours-grid">
                <div className="hours-directory-column">
                    <header className="hours-directory-header">
                        <div>
                            <p className="reports-kicker">Médicos</p>
                        </div>
                        <span className="reports-badge neutral">{filteredDoctors.length} resultados</span>
                    </header>

                    {filteredDoctors.length === 0 ? (
                        <article className="hours-empty-state">
                            <strong>Nenhum médico encontrado.</strong>
                            <span>Ajuste a busca para abrir outro histórico.</span>
                        </article>
                    ) : filteredDoctors.map((doctor) => {
                        const bonusShifts = countBonusShifts(doctor);
                        return (
                            <button
                                key={doctor.doctorId}
                                type="button"
                                className={`hours-doctor-card ${selectedDoctor?.doctorId === doctor.doctorId ? "selected" : ""}`.trim()}
                                onClick={() => selectDoctor(doctor.doctorId)}
                            >
                                <div>
                                    <strong>{doctor.doctorName}</strong>
                                    {doctor.displayName && doctor.displayName !== doctor.doctorName ? (
                                        <span>{doctor.displayName}</span>
                                    ) : null}
                                </div>

                                <div className="hours-doctor-badges">
                                    <span className={`hours-balance-pill ${shiftBalanceClass(doctor.balanceMinutes)}`}>{formatMinutesForHumans(doctor.balanceMinutes)}</span>
                                    <span className="reports-badge neutral">{doctor.shiftCount} plantões</span>
                                    {doctor.lateArrivalCount > 0 && (
                                        <span className="reports-badge danger">{doctor.lateArrivalCount} {doctor.lateArrivalCount === 1 ? "atraso" : "atrasos"}</span>
                                    )}
                                    {bonusShifts > 0 && (
                                        <span className="reports-badge ok">{bonusShifts} bônus</span>
                                    )}
                                    {doctor.correctionCount > 0 && (
                                        <span className="reports-badge warn">{doctor.correctionCount} {doctor.correctionCount === 1 ? "correção" : "correções"}</span>
                                    )}
                                </div>
                            </button>
                        );
                    })}
                </div>

                <aside className="hours-detail-panel" ref={detailPanelRef}>
                    {selectedDoctor ? (
                        <>
                            <header className="hours-detail-header">
                                <div>
                                    <p className="reports-kicker">Histórico do médico</p>
                                    <h2>{selectedDoctor.doctorName}</h2>
                                    {selectedDoctor.displayName && selectedDoctor.displayName !== selectedDoctor.doctorName ? (
                                        <p>{selectedDoctor.displayName}</p>
                                    ) : null}
                                </div>
                                <span className={`hours-balance-pill large ${shiftBalanceClass(selectedDoctor.balanceMinutes)}`}>{formatMinutesForHumans(selectedDoctor.balanceMinutes)}</span>
                            </header>

                            <section className="hours-events-panel">
                                <div className="hours-events-header">
                                    <span className="hours-proof-label">O que mexeu no saldo</span>
                                    {selectedDoctorTotals ? (
                                        <div className="hours-events-chips">
                                            {selectedDoctorTotals.delayCount > 0 && (
                                                <span className="hours-chip debit">{selectedDoctorTotals.delayCount} {selectedDoctorTotals.delayCount === 1 ? "atraso" : "atrasos"} · −{formatMinutesForHumans(selectedDoctorTotals.delayMinutes)}</span>
                                            )}
                                            {selectedDoctorTotals.bonusCount > 0 && (
                                                <span className="hours-chip credit">{selectedDoctorTotals.bonusCount} bônus · +{formatMinutesForHumans(selectedDoctorTotals.bonusMinutes)}</span>
                                            )}
                                            {selectedDoctorTotals.settlementCount > 0 && (
                                                <span className="hours-chip neutral">{selectedDoctorTotals.settlementCount} {selectedDoctorTotals.settlementCount === 1 ? "acerto" : "acertos"} de fechamento</span>
                                            )}
                                            {selectedDoctorTotals.overrideCount > 0 && (
                                                <span className="hours-chip warn">{selectedDoctorTotals.overrideCount} {selectedDoctorTotals.overrideCount === 1 ? "ajuste manual" : "ajustes manuais"}</span>
                                            )}
                                            {selectedDoctor.legacy && (
                                                <span className="hours-chip neutral">planilha: {formatSignedMinutes(selectedDoctor.legacy.totalMinutes)}</span>
                                            )}
                                        </div>
                                    ) : null}
                                </div>

                                {selectedDoctorEvents.length === 0 ? (
                                    <p className="hours-events-empty">
                                        Nenhum desconto ou bônus no período — chegadas e saídas dentro da tolerância.
                                        {selectedDoctor.legacy ? " O saldo vem da planilha da coordenação (composição abaixo)." : ""}
                                    </p>
                                ) : (
                                    <ul className="hours-events-list">
                                        {selectedDoctorEvents.map((event) => (
                                            <li key={event.key}>
                                                <button
                                                    type="button"
                                                    className={`hours-event-row ${event.tone}`}
                                                    onClick={() => scrollToShift(event.anchorId)}
                                                    disabled={!event.anchorId}
                                                >
                                                    <span className="hours-event-when">
                                                        <strong>{event.dateLabel}</strong>
                                                        {event.placeLabel ? <span>{event.placeLabel}</span> : null}
                                                    </span>
                                                    <span className="hours-event-text">{event.text}</span>
                                                    {event.deltaMinutes !== null ? (
                                                        <span className={`hours-balance-pill ${shiftBalanceClass(event.deltaMinutes)}`}>{formatSignedMinutes(event.deltaMinutes)}</span>
                                                    ) : (
                                                        <span className="hours-balance-pill neutral">prova</span>
                                                    )}
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>

                            {selectedDoctor.legacy ? (
                                <section className="hours-settlements">
                                    <p className="reports-summary-label">Composição do saldo</p>
                                    <ul className="hours-composition-list">
                                        <li className="hours-composition-row">
                                            <span className="hours-composition-label">Saldo até 30/abr/2025</span>
                                            <span className="hours-composition-origin">{selectedDoctor.legacy.source}</span>
                                            <span className={`hours-balance-pill ${shiftBalanceClass(selectedDoctor.legacy.preMay2025Minutes)}`}>{formatSignedMinutes(selectedDoctor.legacy.preMay2025Minutes)}</span>
                                        </li>
                                        <li className="hours-composition-row">
                                            <span className="hours-composition-label">Saldo mai/2025 → mai/2026</span>
                                            <span className="hours-composition-origin">{selectedDoctor.legacy.source}</span>
                                            <span className={`hours-balance-pill ${shiftBalanceClass(selectedDoctor.legacy.spreadsheetPeriodMinutes)}`}>{formatSignedMinutes(selectedDoctor.legacy.spreadsheetPeriodMinutes)}</span>
                                        </li>
                                        <li className="hours-composition-row">
                                            <span className="hours-composition-label">Saldo apurado pela aplicação (desde o corte)</span>
                                            <span className="hours-composition-origin">Registros da aplicação, incluindo acertos do fechamento</span>
                                            <span className={`hours-balance-pill ${shiftBalanceClass(selectedDoctor.applicationBalanceMinutes)}`}>{formatSignedMinutes(selectedDoctor.applicationBalanceMinutes)}</span>
                                        </li>
                                        <li className="hours-composition-row total">
                                            <span className="hours-composition-label">Saldo final</span>
                                            <span className="hours-composition-origin">Planilha ({selectedDoctor.legacy.spreadsheetName}) + aplicação</span>
                                            <span className={`hours-balance-pill ${shiftBalanceClass(selectedDoctor.balanceMinutes)}`}>{formatSignedMinutes(selectedDoctor.balanceMinutes)}</span>
                                        </li>
                                    </ul>
                                    {selectedDoctor.legacy.notes ? (
                                        <p className="hours-settlement-hint" title={selectedDoctor.legacy.notes}>
                                            Observação da auditoria da planilha: {selectedDoctor.legacy.notes}
                                        </p>
                                    ) : null}
                                </section>
                            ) : null}

                            {selectedDoctor.settlements.length > 0 ? (
                                <section className="hours-settlements">
                                    <p className="reports-summary-label">Acertos lançados no fechamento</p>
                                    <ul className="hours-settlements-list">
                                        {selectedDoctor.settlements.map((settlement) => (
                                            <li
                                                key={settlement.id}
                                                className={`hours-settlement-row ${settlement.kind === "bonus" ? "bonus" : "penalty"}`}
                                            >
                                                <span className="hours-settlement-tag">
                                                    {settlement.kind === "bonus" ? "Bônus" : "Punição"}
                                                </span>
                                                <span className="hours-settlement-month">{settlement.monthKey}</span>
                                                <span className="hours-settlement-delta">
                                                    {settlement.deltaMinutes > 0 ? "+" : ""}
                                                    {formatMinutesForHumans(settlement.deltaMinutes)}
                                                </span>
                                                <span className="hours-settlement-notes">{settlement.notes}</span>
                                            </li>
                                        ))}
                                    </ul>
                                    <p className="hours-settlement-hint">
                                        Cada acerto move o saldo 12h em direção a zero e gera um plantão {""}
                                        <strong>verde</strong> (bônus) ou <strong>vermelho</strong> (punição) no fechamento daquele mês.
                                    </p>
                                </section>
                            ) : null}

                            {canManageOverrides ? (
                                <section className="hours-settlements hours-settlement-action">
                                    <p className="reports-summary-label">Abater banco de horas (±12h)</p>
                                    <p className="hours-settlement-hint">
                                        O acerto gera um plantão <strong>verde</strong> (bônus, remunera o crédito e abate 12h do saldo) ou <strong>vermelho</strong> (punição, desconta no pagamento e devolve 12h ao saldo). Como o plantão nasce no fechamento — onde ele de fato aparece e conta no pagamento —, o lançamento é feito no <strong>payment-closing</strong>. Repita a cada 12h enquanto o saldo passar de ±12h.
                                    </p>

                                    <label className="hours-settlement-month-field">
                                        <span>Mês do fechamento (onde o plantão vai aparecer)</span>
                                        <select
                                            value={settlementMonth}
                                            onChange={(event) => setSettlementMonth(event.target.value)}
                                            disabled={settlementMonths.length === 0}
                                        >
                                            {settlementMonths.map((month) => (
                                                <option key={month.key} value={month.key}>{month.label}</option>
                                            ))}
                                        </select>
                                    </label>

                                    {(() => {
                                        // Régua do acerto: só horas desde mai/2025 pagam/punem; dívida
                                        // anterior a mai/2025 é amortizada antes de qualquer bônus.
                                        const settleBalance = resolveBankHoursSettlementBalance({
                                            oldMinutes: selectedDoctor.legacy?.preMay2025Minutes ?? 0,
                                            recentMinutes: (selectedDoctor.legacy?.spreadsheetPeriodMinutes ?? 0) + selectedDoctor.applicationBalanceMinutes,
                                        });
                                        if (settleBalance.bonusEligibleMinutes >= BANK_HOURS_SETTLEMENT_MINUTES) {
                                            return (
                                                <a
                                                    className="payment-button bank-bonus"
                                                    href={`/admin/payment-closing?month=${encodeURIComponent(settlementMonth)}&doctor=${encodeURIComponent(selectedDoctor.doctorId)}`}
                                                >
                                                    Lançar bônus (+1 plantão verde) no fechamento →
                                                </a>
                                            );
                                        }
                                        if (settleBalance.penaltyEligibleMinutes <= -BANK_HOURS_SETTLEMENT_MINUTES) {
                                            return (
                                                <a
                                                    className="payment-button bank-penalty"
                                                    href={`/admin/payment-closing?month=${encodeURIComponent(settlementMonth)}&doctor=${encodeURIComponent(selectedDoctor.doctorId)}`}
                                                >
                                                    Lançar punição (1 plantão vermelho) no fechamento →
                                                </a>
                                            );
                                        }
                                        if (settleBalance.oldMinutes < 0 && settleBalance.recentMinutes > 0) {
                                            return (
                                                <p className="hours-settlement-hint">
                                                    As horas formadas desde mai/2025 ({formatSignedMinutes(settleBalance.recentMinutes)}) ainda amortizam a dívida
                                                    anterior a mai/2025 ({formatSignedMinutes(settleBalance.oldMinutes)}) — sem bônus até quitar. Saldo elegível:{" "}
                                                    {formatSignedMinutes(settleBalance.bonusEligibleMinutes)}.
                                                </p>
                                            );
                                        }
                                        return (
                                            <p className="hours-settlement-hint">
                                                Saldo elegível (desde mai/2025) dentro de ±12h — sem acerto disponível. A parcela anterior a mai/2025 não entra na régua.
                                            </p>
                                        );
                                    })()}
                                </section>
                            ) : null}

                            <div className="hours-shift-list">
                                {selectedDoctor.shifts.map((shift) => {
                                    const delay = shift.arrivalDelayMinutes ?? 0;
                                    const overtime = shift.overtimeMinutes ?? 0;
                                    const credited = shift.creditedOvertimeMinutes ?? 0;
                                    const doubled = credited > overtime && overtime > 0;
                                    return (
                                        <article key={`${shift.domain}-${shift.occupancyId}`} id={shiftAnchorId(shift)} className="hours-shift-card">
                                            <header className="hours-shift-header">
                                                <div>
                                                    <div className="hours-shift-title">
                                                        <span className={`reports-badge ${shift.domain === "regulation" ? "warn" : "ok"}`.trim()}>{formatDomain(shift.domain)}</span>
                                                        <strong>{shift.targetCode} · {shift.targetLabel}</strong>
                                                    </div>
                                                    <span className="hours-shift-subtitle">{formatDateTime(shift.startedAt)} · {formatSource(shift.source)} · {shift.shiftLabel ?? "sem turno"}</span>
                                                </div>
                                                <span className={`hours-balance-pill ${shiftBalanceClass(shift.balanceMinutes)}`}>{formatMinutesForHumans(shift.balanceMinutes)}</span>
                                            </header>

                                            <div className="hours-metric-strip">
                                                {delay > 0 && (
                                                    <span className="hours-chip debit">Atraso −{formatMinutesForHumans(delay)}</span>
                                                )}
                                                {credited > 0 && (
                                                    <span className="hours-chip credit">Crédito +{formatMinutesForHumans(credited)}{doubled ? " (em dobro)" : ""}</span>
                                                )}
                                                {shift.flags.hasHandoffOverride && (
                                                    <span className="hours-chip warn">Rendição prevaleceu</span>
                                                )}
                                                {shift.corrections.length > 0 && (
                                                    <span className="hours-chip warn">{shift.corrections.length} {shift.corrections.length === 1 ? "correção" : "correções"}</span>
                                                )}
                                                <span className="hours-chip neutral">{translateBankHoursRuleCode(shift.ruleCode)}</span>
                                            </div>

                                            <div className="hours-evidence-grid timeline">
                                                <div className="timeline-step">
                                                    <span className="hours-evidence-label">Janela do banco</span>
                                                    <strong>{formatDateTime(shift.bankScheduledStartAt)} até {formatDateTime(shift.bankScheduledEndAt)}</strong>
                                                </div>
                                                <div className="timeline-step emphasis-start">
                                                    <span className="hours-evidence-label">Entrada contada</span>
                                                    <strong>{formatDateTime(shift.countedStartAt)}</strong>
                                                </div>
                                                <div className={`timeline-step ${shift.proof.mode === "handoff" ? "emphasis-handoff" : ""}`.trim()}>
                                                    <span className="hours-evidence-label">Rendição do quadro</span>
                                                    <strong>{formatDateTime(shift.handoffEndedAt)}</strong>
                                                    {shift.successorDoctorName ? <span className="hours-evidence-note">assumiu: {shift.successorDoctorName}</span> : null}
                                                </div>
                                                <div className="timeline-step">
                                                    <span className="hours-evidence-label">Saída física</span>
                                                    <strong>{formatDateTime(shift.actualEndedAt)}</strong>
                                                </div>
                                                <div className={`timeline-step emphasis-end ${shift.proof.mode === "handoff" ? "counted" : ""}`.trim()}>
                                                    <span className="hours-evidence-label">Saída usada no cálculo</span>
                                                    <strong>{formatDateTime(shift.countedEndAt)}</strong>
                                                </div>
                                                <div className="timeline-step meta">
                                                    <span className="hours-evidence-label">Criado por / atualizado por</span>
                                                    <strong>{shift.createdByEmail ?? "sistema"} / {shift.updatedByEmail ?? "sem editor humano"}</strong>
                                                </div>
                                            </div>

                                            <section className={`hours-proof-box ${proofToneClass(shift.proof.mode)}`.trim()}>
                                                <span className="hours-proof-label">Por que o cálculo ficou assim</span>
                                                <strong>{shift.proof.summary}</strong>
                                                <ul className="hours-proof-list">
                                                    {shift.proof.items.map((item) => <li key={item}>{item}</li>)}
                                                </ul>
                                            </section>

                                            {shift.corrections.length > 0 && (
                                                <section className="hours-corrections-box">
                                                    <span className="hours-proof-label">Correções da chefia</span>
                                                    {shift.corrections.map((correction) => (
                                                        <div className={`hours-correction-item ${correction.undone ? "undone" : ""}`.trim()} key={correction.id}>
                                                            <div className="hours-correction-meta">
                                                                <strong>{formatDateTime(correction.createdAt)}</strong>
                                                                <span>
                                                                    {correction.actorEmail ?? "sem login registrado"}
                                                                    {correction.chiefOnDutyName ? ` · chefia na 2031 nesse momento: ${correction.chiefOnDutyName}` : ""}
                                                                </span>
                                                            </div>
                                                            <ul className="hours-correction-changes">
                                                                {correction.changes.map((change) => <li key={change}>{change}</li>)}
                                                            </ul>
                                                            {correction.notes ? (
                                                                <p className="hours-correction-notes">Motivo registrado: “{correction.notes}”</p>
                                                            ) : null}
                                                        </div>
                                                    ))}
                                                </section>
                                            )}

                                            {canManageOverrides && (
                                                <section className="hours-override-box">
                                                    <div className="hours-override-header">
                                                        <div>
                                                            <span className="hours-proof-label">Ajuste manual do saldo</span>
                                                            <strong>Forçar o saldo final desse plantão em minutos</strong>
                                                        </div>
                                                        {shift.manualBalanceMinutes !== null && (
                                                            <span className="reports-badge warn">ajuste ativo</span>
                                                        )}
                                                    </div>

                                                    <p>
                                                        Use quando o plantão deve permanecer no histórico, mas o saldo final precisa ser corrigido por decisão administrativa.
                                                    </p>

                                                    <div className="hours-override-grid">
                                                        <label className="hours-override-field compact">
                                                            <span>Saldo final em minutos</span>
                                                            <input
                                                                type="number"
                                                                value={overrideMinutesByShift[shiftKey(shift)] ?? ""}
                                                                onChange={(event) => setOverrideMinutesByShift((current) => ({ ...current, [shiftKey(shift)]: event.target.value }))}
                                                                disabled={isSaving}
                                                            />
                                                        </label>

                                                        <label className="hours-override-field">
                                                            <span>Motivo operacional</span>
                                                            <textarea
                                                                value={overrideNotesByShift[shiftKey(shift)] ?? ""}
                                                                onChange={(event) => setOverrideNotesByShift((current) => ({ ...current, [shiftKey(shift)]: event.target.value }))}
                                                                rows={3}
                                                                placeholder="Ex.: saída existiu, mas esse plantão não gera banco por decisão auditada da coordenação"
                                                                disabled={isSaving}
                                                            />
                                                        </label>
                                                    </div>

                                                    {overrideErrorsByShift[shiftKey(shift)] && (
                                                        <div className="hours-override-error">{overrideErrorsByShift[shiftKey(shift)]}</div>
                                                    )}

                                                    <div className="hours-override-actions">
                                                        <button
                                                            type="button"
                                                            className="payment-button primary"
                                                            disabled={isSaving}
                                                            onClick={() => {
                                                                const key = shiftKey(shift);
                                                                setSavingShiftKey(key);
                                                                setOverrideErrorsByShift((current) => ({ ...current, [key]: "" }));
                                                                startSavingTransition(() => {
                                                                    void submitManualOverride(shift).catch((error) => {
                                                                        setOverrideErrorsByShift((current) => ({
                                                                            ...current,
                                                                            [key]: error instanceof Error ? error.message : "Falha ao salvar override do banco.",
                                                                        }));
                                                                        setSavingShiftKey(null);
                                                                    });
                                                                });
                                                            }}
                                                        >
                                                            {isSaving && savingShiftKey === shiftKey(shift) ? "Salvando..." : "Salvar saldo manual"}
                                                        </button>
                                                    </div>
                                                </section>
                                            )}

                                            {shift.auditTrail.length > 0 && (
                                                <section className="hours-audit-box">
                                                    <span className="hours-proof-label">Trilha de auditoria</span>
                                                    <div className="hours-audit-list">
                                                        {shift.auditTrail.map((entry) => (
                                                            <div className="hours-audit-item" key={entry.id}>
                                                                <div className="hours-audit-dot" />
                                                                <div>
                                                                    <strong>{translateOccupancyAuditAction(entry.action)}</strong>
                                                                    <span>{formatDateTime(entry.createdAt)} · {entry.actorEmail ?? "sistema"}</span>
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </section>
                                            )}
                                        </article>
                                    );
                                })}
                            </div>
                        </>
                    ) : (
                        <article className="hours-empty-state">
                            <strong>Selecione um médico para abrir o histórico.</strong>
                            <span>O painel da direita mostra o que mexeu no saldo e a prova plantão a plantão.</span>
                        </article>
                    )}
                </aside>
            </section>
        </main>
    );
}
