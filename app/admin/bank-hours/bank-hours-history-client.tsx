"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AdminBarNavMenu } from "@/components/admin-bar-nav-menu";
import { ABAS_ADMIN, KairosTopo } from "@/components/kairos-topo";
import type {
    BankHoursDoctorHistory,
    BankHoursEmploymentType,
    BankHoursHistoryModel,
    BankHoursHistoryShift,
    BankHoursSettlementSummary,
} from "@/modules/reporting/bank-hours-history";
import {
    describeLateDepartureReason,
    translateBankHoursRuleCode,
    translateOccupancyAuditAction,
} from "@/modules/reporting/bank-hours-labels";
import { buildBankHoursStory } from "@/modules/reporting/bank-hours-story";
import { resolveBankHoursSettlementBalance } from "@/modules/reporting/bank-hours-settlement-rule";
import {
    formatSignedHours,
    resolveBankHoursPendingAction,
    type BankHoursPendingAction,
} from "@/modules/bank-hours/pending-actions";
import {
    formatPayrollMinutes,
    resolvePayrollDeductionForDoctorMonth,
    type PayrollDeductionForMonth,
} from "@/modules/bank-hours/payroll";
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

/** "junho de 2026" a partir de "2026-06". */
function formatMonthLabel(monthKey: string) {
    const [year, month] = monthKey.split("-").map(Number);
    if (!year || !month) {
        return monthKey;
    }

    return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" })
        .format(new Date(Date.UTC(year, month - 1, 1)));
}

/** "jun/2026" — cabeçalho curto de grupo. */
function formatMonthShort(monthKey: string) {
    const [year, month] = monthKey.split("-").map(Number);
    if (!year || !month) {
        return monthKey;
    }

    return new Intl.DateTimeFormat("pt-BR", { month: "short", year: "numeric", timeZone: "UTC" })
        .format(new Date(Date.UTC(year, month - 1, 1)))
        .replace(".", "");
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

function formatEmploymentType(employmentType: BankHoursEmploymentType) {
    return employmentType === "estatutario" ? "Estatutário" : "PJ";
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

/**
 * Pendência acionável do médico (múltiplos de ±12h da régua de elegibilidade),
 * derivada do mesmo saldo que os botões de acerto usam.
 *
 * Estatutário não tem "plantão vermelho": saldo negativo dele é abatido em
 * folha, mês a mês (modules/bank-hours/payroll.ts). Então a direção "penalty"
 * não existe para ele — só o bônus (crédito ≥ +12h vira plantão extra).
 */
function resolveDoctorPendingAction(doctor: BankHoursDoctorHistory): BankHoursPendingAction {
    const balance = resolveBankHoursSettlementBalance({
        oldMinutes: doctor.legacy?.preMay2025Minutes ?? 0,
        recentMinutes: (doctor.legacy?.spreadsheetPeriodMinutes ?? 0) + doctor.applicationBalanceMinutes,
    });
    const action = resolveBankHoursPendingAction({
        bonusEligibleMinutes: balance.bonusEligibleMinutes,
        penaltyEligibleMinutes: balance.penaltyEligibleMinutes,
        settlementDeltaMinutes: doctor.settlements.reduce((sum, settlement) => sum + settlement.deltaMinutes, 0),
    });
    if (doctor.employmentType === "estatutario" && action.direction === "penalty") {
        return { direction: null, pendingUnits: 0, residualMinutes: balance.penaltyEligibleMinutes, inconsistency: false };
    }
    return action;
}

type PendingFilter = "all" | "bonus" | "penalty" | "payroll" | "inconsistency" | "settled";
type EmploymentFilter = "all" | BankHoursEmploymentType;

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
        formatEmploymentType(doctor.employmentType),
        ...doctor.shifts.flatMap((shift) => [shift.targetCode, shift.targetLabel]),
    ].join(" "));
}

function shiftKey(shift: BankHoursHistoryShift) {
    return `${shift.domain}:${shift.occupancyId}`;
}

function shiftAnchorId(shift: BankHoursHistoryShift) {
    return `shift-${shift.domain}-${shift.occupancyId}`;
}

function monthAnchorId(doctorId: string, monthKey: string) {
    return `month-${doctorId}-${monthKey}`;
}

function countBonusShifts(doctor: BankHoursDoctorHistory) {
    return doctor.shifts.filter((shift) => (shift.creditedOvertimeMinutes ?? 0) > 0).length;
}

/**
 * Diagrama do abatimento em folha do estatutário: cascata prévio → créditos →
 * débitos (absorvido pelo banco vs. folha). Regra e decisão do "débito que
 * cruza o zero" em modules/bank-hours/payroll.ts (PAYROLL_SPLIT_CROSSING_DEBIT).
 */
function PayrollWaterfall({ payroll }: { payroll: PayrollDeductionForMonth }) {
    const scale = Math.max(
        Math.abs(payroll.openingBalanceMinutes),
        Math.abs(payroll.availableMinutes),
        payroll.creditMinutes,
        -payroll.negativeMinutes,
        1,
    );
    const pct = (minutes: number) => `${Math.max(0, Math.min(100, (Math.abs(minutes) / scale) * 100))}%`;
    const openingClass = payroll.openingBalanceMinutes < 0 ? "negative" : "positive";
    const availableClass = payroll.availableMinutes < 0 ? "negative" : "positive";
    const closingClass = payroll.closingBankMinutes < 0 ? "negative" : payroll.closingBankMinutes > 0 ? "positive" : "neutral";
    const isEmpty = payroll.creditMinutes === 0 && payroll.negativeMinutes === 0;
    return (
        <section className="hours-payroll-flow" aria-label="Como o mês foi acertado entre banco e folha">
            <p className="reports-summary-label">Banco × folha neste mês</p>
            <div className="hours-payroll-cells">
                <div className="hours-payroll-cell">
                    <span>Saldo prévio</span>
                    <strong className={`hours-balance-pill ${openingClass}`}>{formatSignedMinutes(payroll.openingBalanceMinutes)}</strong>
                </div>
                <div className="hours-payroll-cell credit">
                    <span>Créditos do mês · {payroll.creditShiftCount}</span>
                    <strong className="hours-balance-pill positive">{formatSignedMinutes(payroll.creditMinutes)}</strong>
                </div>
                <div className="hours-payroll-cell">
                    <span>Disponível no banco</span>
                    <strong className={`hours-balance-pill ${availableClass}`}>{formatSignedMinutes(payroll.availableMinutes)}</strong>
                </div>
                <div className="hours-payroll-cell debit">
                    <span>Débitos do mês · {payroll.negativeShiftCount}</span>
                    <strong className="hours-balance-pill negative">{formatSignedMinutes(payroll.negativeMinutes)}</strong>
                </div>
                <div className="hours-payroll-cell absorbed">
                    <span>Absorvido pelo banco</span>
                    <strong className="hours-balance-pill absorbed">{formatSignedMinutes(-payroll.absorbedMinutes)}</strong>
                </div>
                <div className="hours-payroll-cell payroll">
                    <span>Vai à folha</span>
                    <strong className="hours-balance-pill payroll">{formatPayrollMinutes(payroll.payrollMinutes)}</strong>
                </div>
                <div className="hours-payroll-cell">
                    <span>Banco depois</span>
                    <strong className={`hours-balance-pill ${closingClass}`}>{formatSignedMinutes(payroll.closingBankMinutes)}</strong>
                </div>
            </div>

            {isEmpty ? null : (
                <div className="hours-payroll-bars">
                    <div className="hours-payroll-bar-row">
                        <span className="hours-payroll-bar-label">Banco</span>
                        <div className="hours-payroll-bar">
                            <span className={`hours-payroll-seg opening ${openingClass}`} style={{ width: pct(payroll.openingBalanceMinutes) }} title={`Saldo prévio ${formatSignedMinutes(payroll.openingBalanceMinutes)}`} />
                            <span className="hours-payroll-seg credit" style={{ width: pct(payroll.creditMinutes) }} title={`Créditos do mês ${formatSignedMinutes(payroll.creditMinutes)}`} />
                        </div>
                    </div>
                    <div className="hours-payroll-bar-row">
                        <span className="hours-payroll-bar-label">Débitos</span>
                        <div className="hours-payroll-bar">
                            <span className="hours-payroll-seg absorbed" style={{ width: pct(payroll.absorbedMinutes) }} title={`Absorvido pelo banco ${formatPayrollMinutes(payroll.absorbedMinutes)}`} />
                            <span className="hours-payroll-seg payroll" style={{ width: pct(payroll.payrollMinutes) }} title={`Vai à folha ${formatPayrollMinutes(payroll.payrollMinutes)}`} />
                        </div>
                    </div>
                    <ul className="hours-payroll-legend">
                        <li><i className="opening positive" /> prévio positivo</li>
                        <li><i className="opening negative" /> prévio negativo (fica no banco, nunca vai à folha)</li>
                        <li><i className="credit" /> créditos do mês</li>
                        <li><i className="absorbed" /> débito absorvido pelo banco</li>
                        <li><i className="payroll" /> débito que vai à folha</li>
                    </ul>
                </div>
            )}

            {isEmpty ? null : (
                <ol className="hours-payroll-steps">
                    <li className="opening">
                        <span className="hours-payroll-step-when">Prévio</span>
                        <span className="hours-payroll-step-text">saldo que veio dos meses anteriores</span>
                        <span className={`hours-balance-pill ${openingClass}`}>{formatSignedMinutes(payroll.openingBalanceMinutes)}</span>
                    </li>
                    {payroll.creditSteps.map((step, index) => (
                        <li key={`c-${step.startedAt ?? index}`} className="credit">
                            <span className="hours-payroll-step-when">{step.startedAt ? formatShortDate(step.startedAt) : `crédito ${index + 1}`}</span>
                            <span className="hours-payroll-step-bank">banco {formatSignedMinutes(step.bankBeforeMinutes)}</span>
                            <span className="hours-balance-pill positive">{formatSignedMinutes(step.balanceMinutes)}</span>
                            <span className="hours-payroll-step-split"><em className="credit">entra no banco</em></span>
                            <span className="hours-payroll-step-after">→ banco {formatSignedMinutes(step.bankAfterMinutes)}</span>
                        </li>
                    ))}
                    <li className="available">
                        <span className="hours-payroll-step-when">Disponível</span>
                        <span className="hours-payroll-step-text">
                            {payroll.creditSteps.length > 0
                                ? `prévio + ${formatPayrollMinutes(payroll.creditMinutes)} de crédito, antes de qualquer débito`
                                : "sem crédito neste mês — o banco entra nos débitos como estava"}
                        </span>
                        <span className={`hours-balance-pill ${availableClass}`}>{formatSignedMinutes(payroll.availableMinutes)}</span>
                    </li>
                    {payroll.steps.map((step, index) => (
                        <li key={`d-${step.startedAt ?? index}`} className={`debit ${step.crossedZero ? "crossed" : ""}`.trim()}>
                            <span className="hours-payroll-step-when">{step.startedAt ? formatShortDate(step.startedAt) : `débito ${index + 1}`}</span>
                            <span className="hours-payroll-step-bank">banco {formatSignedMinutes(step.bankBeforeMinutes)}</span>
                            <span className="hours-balance-pill negative">{formatSignedMinutes(step.balanceMinutes)}</span>
                            <span className="hours-payroll-step-split">
                                {step.bankMinutes > 0 ? <em className="absorbed">{formatPayrollMinutes(step.bankMinutes)} do banco</em> : null}
                                {step.payrollMinutes > 0 ? <em className="payroll">{formatPayrollMinutes(step.payrollMinutes)} na folha</em> : null}
                                {step.crossedZero ? <small>cruzou o zero</small> : null}
                            </span>
                            <span className="hours-payroll-step-after">→ banco {formatSignedMinutes(step.bankAfterMinutes)}</span>
                        </li>
                    ))}
                    <li className="closing">
                        <span className="hours-payroll-step-when">Depois</span>
                        <span className="hours-payroll-step-text">
                            {payroll.payrollMinutes > 0
                                ? `banco fecha o mês assim; ${formatPayrollMinutes(payroll.payrollMinutes)} vão à folha`
                                : "banco fecha o mês assim; nada vai à folha"}
                        </span>
                        <span className={`hours-balance-pill ${closingClass}`}>{formatSignedMinutes(payroll.closingBankMinutes)}</span>
                    </li>
                </ol>
            )}
        </section>
    );
}

function compareShiftsAsc(left: BankHoursHistoryShift, right: BankHoursHistoryShift) {
    return new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime();
}

interface MonthGroup {
    monthKey: string;
    shifts: BankHoursHistoryShift[];
    balanceMinutes: number;
    delayCount: number;
    bonusCount: number;
}

/** Plantões do médico agrupados por mês operacional, meses e plantões em ordem crescente. */
function groupShiftsByMonth(shifts: BankHoursHistoryShift[]): MonthGroup[] {
    const groups = new Map<string, MonthGroup>();
    for (const shift of shifts.slice().sort(compareShiftsAsc)) {
        const group = groups.get(shift.monthKey) ?? {
            monthKey: shift.monthKey,
            shifts: [],
            balanceMinutes: 0,
            delayCount: 0,
            bonusCount: 0,
        };
        group.shifts.push(shift);
        group.balanceMinutes += shift.balanceMinutes ?? 0;
        if ((shift.arrivalDelayMinutes ?? 0) > 0) group.delayCount += 1;
        if ((shift.creditedOvertimeMinutes ?? 0) > 0) group.bonusCount += 1;
        groups.set(shift.monthKey, group);
    }
    return Array.from(groups.values()).sort((left, right) => left.monthKey.localeCompare(right.monthKey));
}

type SaldoEventTone = "credit" | "debit" | "warn" | "neutral";

interface SaldoEvent {
    key: string;
    anchorId: string | null;
    /** ISO para ordenar cronologicamente (plantões e acertos misturados). */
    sortKey: string;
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
    const sortKey = shift.startedAt;
    const dateLabel = formatShortDate(shift.startedAt);
    const place = shift.targetCode;
    const delay = shift.arrivalDelayMinutes ?? 0;
    const overtime = shift.overtimeMinutes ?? 0;
    const credited = shift.creditedOvertimeMinutes ?? 0;

    if (shift.ruleCode === "MANUAL_BANK_OVERRIDE") {
        events.push({
            key: `${anchorId}-override`,
            anchorId,
            sortKey,
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
            sortKey,
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
            sortKey,
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
                sortKey,
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
                sortKey,
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
            sortKey,
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
            sortKey,
            dateLabel,
            placeLabel: place,
            tone: "warn",
            deltaMinutes: null,
            text: `Chegada/saída deste plantão foi corrigida pela chefia${lastCorrection?.chiefOnDutyName ? ` (${lastCorrection.chiefOnDutyName} estava na 2031)` : ""} — detalhes no card abaixo.`,
        });
    }

    return events;
}

function describeSettlementEvent(settlement: BankHoursSettlementSummary) {
    if (settlement.kind === "payroll") {
        return settlement.deltaMinutes < 0
            ? `Estorno do abatimento em folha de ${settlement.monthKey}: os atrasos daquele mês voltam a contar no banco.`
            : `Abatido em folha (${settlement.monthKey}): ${formatPayrollMinutes(settlement.deltaMinutes)} de atraso do mês descontados na folha de pagamento/ponto; o banco devolve essas horas.`;
    }
    if (settlement.kind === "bonus") {
        return `Acerto do fechamento ${settlement.monthKey}: crédito pago como plantão verde; o saldo devolve 12 h.`;
    }
    return `Acerto do fechamento ${settlement.monthKey}: punição descontada como plantão vermelho; o saldo recebe 12 h de volta.`;
}

function settlementTone(settlement: BankHoursSettlementSummary): SaldoEventTone {
    if (settlement.kind === "payroll") {
        return "warn";
    }
    return settlement.kind === "bonus" ? "credit" : "debit";
}

function settlementTag(settlement: BankHoursSettlementSummary, isReversal: boolean) {
    if (isReversal) return "Estorno";
    if (settlement.kind === "payroll") return "Folha";
    return settlement.kind === "bonus" ? "Bônus" : "Punição";
}

/** Tudo que mexeu no saldo, em ordem cronológica crescente (plantões e acertos juntos). */
function buildDoctorEvents(doctor: BankHoursDoctorHistory): SaldoEvent[] {
    const shiftEvents = doctor.shifts.flatMap(buildShiftEvents);
    const settlementEvents: SaldoEvent[] = doctor.settlements.map((settlement) => ({
        key: `settlement-${settlement.id}`,
        anchorId: null,
        sortKey: settlement.operationalDate ? `${settlement.operationalDate}T12:00:00.000Z` : settlement.createdAt,
        dateLabel: formatShortDate(settlement.operationalDate ?? settlement.createdAt),
        placeLabel: settlement.kind === "payroll" ? `folha ${settlement.monthKey}` : `fechamento ${settlement.monthKey}`,
        tone: settlementTone(settlement),
        deltaMinutes: settlement.deltaMinutes,
        text: describeSettlementEvent(settlement),
    }));

    return [...shiftEvents, ...settlementEvents].sort((left, right) => left.sortKey.localeCompare(right.sortKey));
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

/** Valor do seletor de mês que mostra a vida inteira (padrão). */
const ALL_MONTHS = "all";

interface Props {
    history: BankHoursHistoryModel;
    canManageOverrides: boolean;
    settlementMonths: SettlementMonthOption[];
    /** Foco inicial do seletor do topo: "all" (vida inteira) ou AAAA-MM vindo de ?month=. */
    initialMonthKey: string;
    /** Mês corrente (AAAA-MM): padrão do abatimento em folha. */
    currentMonthKey: string;
}

interface DoctorRowsView {
    /** Meses visíveis no card (todos, ou só o mês em foco), em ordem crescente. */
    groups: MonthGroup[];
    shiftCount: number;
    delayCount: number;
    bonusCount: number;
    balanceMinutes: number;
    /** Abatimento em folha pendente (estatutário), somado nos meses visíveis. */
    payrollPendingMinutes: number;
    payrollPendingMonths: string[];
}

/** Meses que podem ter atraso a abater: os com plantão + os com acerto de folha. */
function payrollMonthsOf(doctor: BankHoursDoctorHistory) {
    const months = new Set<string>();
    for (const shift of doctor.shifts) months.add(shift.monthKey);
    for (const settlement of doctor.settlements) {
        if (settlement.kind === "payroll") months.add(settlement.monthKey);
    }
    return Array.from(months).sort();
}

export function BankHoursHistoryClient({ history, canManageOverrides, settlementMonths, initialMonthKey, currentMonthKey }: Props) {
    const router = useRouter();
    const [search, setSearch] = useState("");
    const deferredSearch = useDeferredValue(search);
    // Foco opcional de mês: "all" mostra a vida inteira (padrão); um AAAA-MM
    // restringe as linhas dos cards, os KPIs e o filtro "abater em folha".
    const [monthKey, setMonthKey] = useState(initialMonthKey);
    const focusedMonth = monthKey === ALL_MONTHS ? null : monthKey;
    // Mês do abatimento em folha no detalhe do estatutário.
    const [payrollMonth, setPayrollMonth] = useState(focusedMonth ?? currentMonthKey);
    const [employmentFilter, setEmploymentFilter] = useState<EmploymentFilter>("all");
    // Nenhum médico aberto por padrão: o histórico dilata muito a página, então
    // ele só abre por clique e pode ser fechado em vários pontos (X, fim, Esc).
    const [selectedDoctorId, setSelectedDoctorId] = useState<string | null>(null);
    const [overrideMinutesByShift, setOverrideMinutesByShift] = useState<Record<string, string>>({});
    const [overrideNotesByShift, setOverrideNotesByShift] = useState<Record<string, string>>({});
    const [overrideErrorsByShift, setOverrideErrorsByShift] = useState<Record<string, string>>({});
    const [savingShiftKey, setSavingShiftKey] = useState<string | null>(null);
    const [isSaving, startSavingTransition] = useTransition();
    const [settlementMonth, setSettlementMonth] = useState(
        settlementMonths.some((month) => month.key === currentMonthKey) ? currentMonthKey : (settlementMonths[0]?.key ?? ""),
    );
    const [pendingFilter, setPendingFilter] = useState<PendingFilter>("all");
    const [reversingSettlementId, setReversingSettlementId] = useState<string | null>(null);
    const [payrollBusyDoctorId, setPayrollBusyDoctorId] = useState<string | null>(null);
    const [payrollError, setPayrollError] = useState<string | null>(null);
    // Gaveta "Como ler" da faixa de comando (absorveu o herói e os princípios).
    const [guideOpen, setGuideOpen] = useState(false);
    const detailPanelRef = useRef<HTMLElement | null>(null);
    const directoryRef = useRef<HTMLDivElement | null>(null);

    // Meses com plantão no histórico + meses do fechamento + o corrente, do
    // mais recente para o mais antigo (sem a opção "vida inteira").
    const monthKeys = useMemo(() => {
        const keys = new Set<string>([currentMonthKey]);
        if (focusedMonth) keys.add(focusedMonth);
        for (const month of settlementMonths) keys.add(month.key);
        for (const doctor of history.doctors) {
            for (const shift of doctor.shifts) keys.add(shift.monthKey);
        }
        return Array.from(keys)
            .filter((key) => /^\d{4}-\d{2}$/.test(key))
            .sort((left, right) => right.localeCompare(left));
    }, [currentMonthKey, focusedMonth, history.doctors, settlementMonths]);

    const monthOptions = useMemo(
        () => [{ key: ALL_MONTHS, label: "Toda a vida" }, ...monthKeys.map((key) => ({ key, label: formatMonthLabel(key) }))],
        [monthKeys],
    );

    const monthIndex = monthOptions.findIndex((month) => month.key === monthKey);
    const newerMonth = monthIndex > 0 ? monthOptions[monthIndex - 1]?.key ?? null : null;
    const olderMonth = monthIndex >= 0 && monthIndex < monthOptions.length - 1 ? monthOptions[monthIndex + 1]?.key ?? null : null;

    // Focar um mês arrasta o mês do acerto (PJ) e o da folha (estatutário).
    useEffect(() => {
        if (!focusedMonth) return;
        setPayrollMonth(focusedMonth);
        if (settlementMonths.some((month) => month.key === focusedMonth)) {
            setSettlementMonth(focusedMonth);
        }
    }, [focusedMonth, settlementMonths]);

    function selectMonth(nextMonthKey: string) {
        setMonthKey(nextMonthKey);
        setPayrollError(null);
        // Mantém o link compartilhável (?month=) sem recarregar a página.
        const url = new URL(window.location.href);
        if (nextMonthKey === ALL_MONTHS) url.searchParams.delete("month");
        else url.searchParams.set("month", nextMonthKey);
        window.history.replaceState(window.history.state, "", url.toString());
    }

    // Em layout empilhado (≤1180px) o detalhe fica ABAIXO da lista inteira de
    // médicos — sem isso o admin precisa arrastar a página toda após o clique.
    function selectDoctor(doctorId: string) {
        // Clicar de novo no médico já aberto fecha o histórico.
        if (doctorId === selectedDoctorId) {
            closeDoctor();
            return;
        }

        setSelectedDoctorId(doctorId);
        setPayrollError(null);
        if (window.matchMedia("(max-width: 1180px)").matches) {
            // Timeout curto: espera o React commitar o novo detalhe antes de rolar.
            // behavior "auto" (salto): o smooth era abortado pelo re-render do painel.
            window.setTimeout(() => {
                detailPanelRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
            }, 80);
        }
    }

    /** Abre o médico direto num plantão da lista do mês (clique numa linha do card). */
    function openDoctorAtShift(doctorId: string, anchorId: string) {
        if (doctorId !== selectedDoctorId) {
            setSelectedDoctorId(doctorId);
            setPayrollError(null);
        }
        window.setTimeout(() => {
            document.getElementById(anchorId)?.scrollIntoView({ behavior: "auto", block: "start" });
        }, 120);
    }

    function closeDoctor() {
        setSelectedDoctorId(null);
        // O painel some e a página encolhe; sem isso o scroll fica perdido no
        // fim do documento. Volta para a lista de médicos.
        window.setTimeout(() => {
            directoryRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
        }, 40);
    }

    // O header sticky do detalhe precisa grudar ABAIXO do admin-bar (que também
    // é sticky e tem altura variável — no mobile a busca/KPIs quebram linha).
    useEffect(() => {
        function updateStickyOffset() {
            const frame = document.querySelector(".admin-bar-frame.standalone");
            const height = frame instanceof HTMLElement ? frame.offsetHeight + 8 : 0;
            document.documentElement.style.setProperty("--admin-bar-offset", `${height}px`);
        }

        updateStickyOffset();
        window.addEventListener("resize", updateStickyOffset);
        return () => window.removeEventListener("resize", updateStickyOffset);
    }, []);

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

    const pendingByDoctor = useMemo(() => {
        const map = new Map<string, BankHoursPendingAction>();
        for (const doctor of history.doctors) {
            map.set(doctor.doctorId, resolveDoctorPendingAction(doctor));
        }
        return map;
    }, [history.doctors]);

    // As linhas de cada card: a vida inteira (ou só o mês em foco), mês a mês em
    // ordem crescente, + o atraso ainda não abatido em folha (estatutário).
    const rowsByDoctor = useMemo(() => {
        const map = new Map<string, DoctorRowsView>();
        for (const doctor of history.doctors) {
            const allGroups = groupShiftsByMonth(doctor.shifts);
            const groups = focusedMonth ? allGroups.filter((group) => group.monthKey === focusedMonth) : allGroups;
            const view: DoctorRowsView = {
                groups,
                shiftCount: 0,
                delayCount: 0,
                bonusCount: 0,
                balanceMinutes: 0,
                payrollPendingMinutes: 0,
                payrollPendingMonths: [],
            };
            for (const group of groups) {
                view.shiftCount += group.shifts.length;
                view.delayCount += group.delayCount;
                view.bonusCount += group.bonusCount;
                view.balanceMinutes += group.balanceMinutes;
            }
            if (doctor.employmentType === "estatutario") {
                const months = focusedMonth ? [focusedMonth] : payrollMonthsOf(doctor);
                for (const month of months) {
                    const payroll = resolvePayrollDeductionForDoctorMonth({ monthKey: month, legacyMinutes: doctor.legacy?.totalMinutes ?? 0, shifts: doctor.shifts, settlements: doctor.settlements });
                    if (payroll.pending) {
                        view.payrollPendingMinutes += -payroll.remainingMinutes;
                        view.payrollPendingMonths.push(month);
                    }
                }
            }
            map.set(doctor.doctorId, view);
        }
        return map;
    }, [focusedMonth, history.doctors]);

    const pendingTotals = useMemo(() => {
        let bonusDoctors = 0;
        let penaltyDoctors = 0;
        let bonusUnits = 0;
        let penaltyUnits = 0;
        let inconsistencies = 0;
        let payrollDoctors = 0;
        let payrollMinutes = 0;
        for (const doctor of history.doctors) {
            const action = pendingByDoctor.get(doctor.doctorId);
            if (action?.direction === "bonus") {
                bonusDoctors += 1;
                bonusUnits += action.pendingUnits;
            } else if (action?.direction === "penalty") {
                penaltyDoctors += 1;
                penaltyUnits += action.pendingUnits;
            }
            if (action?.inconsistency) inconsistencies += 1;
            const rows = rowsByDoctor.get(doctor.doctorId);
            if (rows && rows.payrollPendingMinutes > 0) {
                payrollDoctors += 1;
                payrollMinutes += rows.payrollPendingMinutes;
            }
        }
        return { bonusDoctors, penaltyDoctors, bonusUnits, penaltyUnits, inconsistencies, payrollDoctors, payrollMinutes };
    }, [history.doctors, pendingByDoctor, rowsByDoctor]);

    const employmentCounts = useMemo(() => {
        let pj = 0;
        let estatutario = 0;
        for (const doctor of history.doctors) {
            if (doctor.employmentType === "estatutario") estatutario += 1;
            else pj += 1;
        }
        return { pj, estatutario };
    }, [history.doctors]);

    const filteredDoctors = useMemo(() => {
        const normalized = normalizeSearch(deferredSearch);
        let doctors = history.doctors;
        if (employmentFilter !== "all") {
            doctors = doctors.filter((doctor) => doctor.employmentType === employmentFilter);
        }
        if (pendingFilter !== "all") {
            doctors = doctors.filter((doctor) => {
                const action = pendingByDoctor.get(doctor.doctorId);
                if (pendingFilter === "settled") return doctor.settlements.length > 0;
                if (pendingFilter === "inconsistency") return action?.inconsistency === true;
                if (pendingFilter === "payroll") return (rowsByDoctor.get(doctor.doctorId)?.payrollPendingMinutes ?? 0) > 0;
                return action?.direction === pendingFilter;
            });
        }
        if (!normalized) {
            return doctors;
        }

        return doctors.filter((doctor) => summarizeDoctorSearch(doctor).includes(normalized));
    }, [deferredSearch, employmentFilter, history.doctors, pendingByDoctor, pendingFilter, rowsByDoctor]);

    // KPIs do que está visível (vida inteira ou mês em foco), sobre os médicos filtrados.
    const monthTotals = useMemo(() => {
        let shiftCount = 0;
        let delayCount = 0;
        let bonusCount = 0;
        let balanceMinutes = 0;
        for (const doctor of filteredDoctors) {
            const view = rowsByDoctor.get(doctor.doctorId);
            if (!view) continue;
            shiftCount += view.shiftCount;
            delayCount += view.delayCount;
            bonusCount += view.bonusCount;
            balanceMinutes += view.balanceMinutes;
        }
        return { shiftCount, delayCount, bonusCount, balanceMinutes };
    }, [filteredDoctors, rowsByDoctor]);

    // Sem fallback automático: null = fechado de propósito, e fica fechado.
    const selectedDoctor = selectedDoctorId
        ? history.doctors.find((doctor) => doctor.doctorId === selectedDoctorId) ?? null
        : null;

    // Busca vai direto ao médico: sobrou UM resultado -> abre na hora; com
    // vários resultados num layout empilhado, fecha o detalhe aberto para a
    // lista filtrada aparecer sem rolagem.
    useEffect(() => {
        if (!normalizeSearch(deferredSearch)) {
            return;
        }

        if (filteredDoctors.length === 1) {
            const only = filteredDoctors[0]!;
            if (only.doctorId !== selectedDoctorId) {
                setSelectedDoctorId(only.doctorId);
                if (window.matchMedia("(max-width: 1180px)").matches) {
                    window.setTimeout(() => {
                        detailPanelRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
                    }, 80);
                }
            }
            return;
        }

        if (
            selectedDoctorId
            && window.matchMedia("(max-width: 1180px)").matches
            && !filteredDoctors.some((doctor) => doctor.doctorId === selectedDoctorId)
        ) {
            setSelectedDoctorId(null);
        }
    }, [deferredSearch, filteredDoctors, selectedDoctorId]);

    // Esc fecha o histórico aberto de qualquer ponto da página.
    useEffect(() => {
        if (!selectedDoctorId) {
            return;
        }

        function onKeyDown(event: KeyboardEvent) {
            if (event.key === "Escape") {
                setSelectedDoctorId(null);
                window.setTimeout(() => {
                    directoryRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
                }, 40);
            }
        }

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [selectedDoctorId]);

    const selectedDoctorEvents = useMemo(
        () => (selectedDoctor ? buildDoctorEvents(selectedDoctor) : []),
        [selectedDoctor],
    );
    const selectedDoctorTotals = useMemo(
        () => (selectedDoctor ? buildDoctorEventTotals(selectedDoctor) : null),
        [selectedDoctor],
    );
    // A vida inteira do médico, mês a mês em ordem crescente.
    const selectedDoctorMonths = useMemo(
        () => (selectedDoctor ? groupShiftsByMonth(selectedDoctor.shifts) : []),
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

    async function reverseSettlement(settlementId: string) {
        const reason = window.prompt("Justificativa do estorno (obrigatória, mín. 3 caracteres):")?.trim();
        if (!reason || reason.length < 3) {
            return;
        }
        if (!window.confirm("Confirmar estorno? Um lançamento compensatório será criado no mesmo mês — nada é apagado, e o médico será avisado.")) {
            return;
        }
        setReversingSettlementId(settlementId);
        try {
            const response = await fetch("/api/admin/payment-closing/bank-hours-settlement/reverse", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ settlementId, reason }),
            });
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                window.alert(body?.error || "Não foi possível estornar o acerto.");
                return;
            }
            router.refresh();
        } finally {
            setReversingSettlementId(null);
        }
    }

    /**
     * Abater em folha (estatutário): o servidor recalcula quanto o mês deve; o
     * cliente só diz QUAL médico e QUAL mês.
     */
    async function submitPayrollSettlement(doctor: BankHoursDoctorHistory, payroll: PayrollDeductionForMonth) {
        const amount = formatPayrollMinutes(-payroll.remainingMinutes);
        if (!window.confirm(`Abater em folha ${amount} de atraso de ${doctor.doctorName} em ${formatMonthLabel(payroll.monthKey)}?\n\nO desconto é lançado na folha de pagamento/ponto por fora; aqui fica registrado que o banco não cobra mais essas horas. O médico será avisado.`)) {
            return;
        }
        setPayrollBusyDoctorId(doctor.doctorId);
        setPayrollError(null);
        try {
            const response = await fetch("/api/admin/bank-hours/payroll-settlement", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ doctorId: doctor.doctorId, monthKey: payroll.monthKey }),
            });
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                setPayrollError(body?.error || "Não foi possível abater em folha.");
                return;
            }
            router.refresh();
        } finally {
            setPayrollBusyDoctorId(null);
        }
    }

    const monthLabel = focusedMonth ? formatMonthLabel(focusedMonth) : "toda a vida";
    const scopeLabel = focusedMonth ? `em ${formatMonthShort(focusedMonth)}` : "na vida";

    return (
        // Tela migrada ao Kairós: o wrapper dá tokens, fundo e tema (docs/kairos.md).
        <div className="pagina-kairos">
        <KairosTopo titulo="Banco de horas" abas={ABAS_ADMIN} />
        <main className="hours-shell">
            {/* Faixa de comando compacta: mês + busca + KPIs do mês + gaveta "Como ler" + navegação ••• */}
            <section className="admin-bar-frame standalone">
                <header className="admin-bar">
                    <span className="admin-bar-kicker">Banco de horas</span>
                    <div className="hours-month-picker" role="group" aria-label="Mês em foco">
                        <button
                            type="button"
                            className="hours-month-step"
                            onClick={() => olderMonth && selectMonth(olderMonth)}
                            disabled={!olderMonth}
                            aria-label="Mês anterior"
                            title="Mês anterior"
                        >
                            ‹
                        </button>
                        <select
                            className="admin-bar-month"
                            value={monthKey}
                            onChange={(event) => selectMonth(event.target.value)}
                            aria-label="Mês em foco"
                        >
                            {monthOptions.map((month) => (
                                <option key={month.key} value={month.key}>{month.label}</option>
                            ))}
                        </select>
                        <button
                            type="button"
                            className="hours-month-step"
                            onClick={() => newerMonth && selectMonth(newerMonth)}
                            disabled={!newerMonth}
                            aria-label="Mês seguinte"
                            title="Mês seguinte"
                        >
                            ›
                        </button>
                    </div>
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
                        <div className="admin-bar-kpi" title="Médicos que passaram nos filtros / no histórico">
                            <strong>{filteredDoctors.length}</strong>
                            <span>de {history.summary.doctorCount} médicos</span>
                        </div>
                        <div className="admin-bar-kpi" title={`Plantões ${scopeLabel} (médicos filtrados)`}>
                            <strong>{monthTotals.shiftCount}</strong>
                            <span>plantões {scopeLabel}</span>
                        </div>
                        <div className="admin-bar-kpi danger" title={`Plantões ${scopeLabel} com chegada fora da tolerância de 15 min`}>
                            <strong>{monthTotals.delayCount}</strong>
                            <span>com desconto</span>
                        </div>
                        <div className="admin-bar-kpi" title={`Plantões ${scopeLabel} com permanência além do previsto creditada`}>
                            <strong>{monthTotals.bonusCount}</strong>
                            <span>com bônus</span>
                        </div>
                        <div className={`admin-bar-kpi ${monthTotals.balanceMinutes < 0 ? "danger" : monthTotals.balanceMinutes > 0 ? "ok" : ""}`.trim()} title={`Soma do saldo dos plantões ${scopeLabel} (médicos filtrados, sem planilha e acertos)`}>
                            <strong>{formatSignedMinutes(monthTotals.balanceMinutes)}</strong>
                            <span>saldo dos plantões</span>
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
                                    <p>Cada médico já traz, sem clique, todos os plantões em linhas curtas — data, turno, base e o saldo de cada um — com uma tag por mês. O seletor do topo é só um foco opcional (um mês por vez). Clique no nome para abrir a prova completa, ou numa linha para cair direto naquele plantão.</p>
                                </div>
                                <div className="admin-bar-drawer-group">
                                    <span>PJ × estatutário</span>
                                    <p>O PJ acerta o banco em plantões de 12h no fechamento (verde paga crédito, vermelho desconta débito). O estatutário é pago pela folha da prefeitura: o atraso do mês é <strong>abatido em folha</strong>, plantão a plantão; só o crédito ≥ 12h vira plantão extra.</p>
                                </div>
                                <div className="admin-bar-drawer-group">
                                    <span>Atraso desconta · excedente credita</span>
                                    <p>Chegada até 15 min após o previsto não desconta. Permanência além de 15 min do fim credita — em dobro se a chegada foi no horário, simples se atrasou.</p>
                                </div>
                                <div className="admin-bar-drawer-group">
                                    <span>Rendição encerra a contagem</span>
                                    <p>Quando alguém assume o posto antes da saída física, o banco para na rendição. A tela nomeia quem assumiu e mantém a saída física como prova.</p>
                                </div>
                            </div>
                        </div>
                    </div>
                ) : null}
            </section>

            {/* Filtros de cara: vínculo + pendência. Quem já formou múltiplos de ±12h, quem tem atraso a abater no mês. */}
            <section className="hours-settlements hours-pending-strip">
                <div className="hours-filter-row">
                    <span className="hours-filter-label">Vínculo</span>
                    <div className="hours-events-chips" role="group" aria-label="Filtrar médicos por vínculo">
                        {([
                            ["all", `Todos · ${history.summary.doctorCount}`],
                            ["pj", `PJ · ${employmentCounts.pj}`],
                            ["estatutario", `Estatutários · ${employmentCounts.estatutario}`],
                        ] as Array<[EmploymentFilter, string]>).map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                className={`admin-bar-filters-toggle ${employmentFilter === value ? "open" : ""}`.trim()}
                                aria-pressed={employmentFilter === value}
                                onClick={() => setEmploymentFilter(value)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="hours-filter-row">
                    <span className="hours-filter-label">Pendência</span>
                    <div className="hours-events-chips" role="group" aria-label="Filtrar médicos por pendência">
                        {([
                            ["all", "Todas"],
                            ["bonus", `Pagar plantão · ${pendingTotals.bonusDoctors}`],
                            ["penalty", `Descontar plantão (PJ) · ${pendingTotals.penaltyDoctors}`],
                            ["payroll", `Abater em folha · ${pendingTotals.payrollDoctors}`],
                            ["inconsistency", `Revisão necessária · ${pendingTotals.inconsistencies}`],
                            ["settled", "Já ajustados"],
                        ] as Array<[PendingFilter, string]>).map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                className={`admin-bar-filters-toggle ${pendingFilter === value ? "open" : ""}`.trim()}
                                aria-pressed={pendingFilter === value}
                                onClick={() => setPendingFilter(value)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="hours-events-chips">
                    <span className="reports-badge ok" title="Médicos com saldo elegível ≥ +12h">
                        {pendingTotals.bonusDoctors} a pagar · {pendingTotals.bonusUnits} plantões verdes
                    </span>
                    <span className="reports-badge danger" title="PJ com saldo elegível ≤ -12h">
                        {pendingTotals.penaltyDoctors} a descontar · {pendingTotals.penaltyUnits} plantões vermelhos
                    </span>
                    <span className="reports-badge warn" title={`Estatutários com atraso ${scopeLabel} ainda não abatido em folha`}>
                        {pendingTotals.payrollDoctors} a abater em folha · {formatPayrollMinutes(pendingTotals.payrollMinutes)} {scopeLabel}
                    </span>
                    {pendingTotals.inconsistencies > 0 && (
                        <span className="reports-badge warn" title="Saldo mudou na direção contrária a acertos já lançados">
                            {pendingTotals.inconsistencies} para revisar
                        </span>
                    )}
                </div>
            </section>

            <section className={`hours-grid ${selectedDoctor ? "detail-open" : "list-only"}`.trim()}>
                <div className="hours-directory-column" ref={directoryRef}>
                    <header className="hours-directory-header">
                        <div>
                            <p className="reports-kicker">Médicos · A–Z</p>
                            <span className="hours-directory-month">{monthLabel}</span>
                        </div>
                        <span className="reports-badge neutral">{filteredDoctors.length} resultados</span>
                    </header>

                    {filteredDoctors.length === 0 ? (
                        <article className="hours-empty-state">
                            <strong>Nenhum médico encontrado.</strong>
                            <span>Ajuste a busca ou os filtros para abrir outro histórico.</span>
                        </article>
                    ) : filteredDoctors.map((doctor) => {
                        const bonusShifts = countBonusShifts(doctor);
                        const pending = pendingByDoctor.get(doctor.doctorId);
                        const rows = rowsByDoctor.get(doctor.doctorId);
                        const isSelected = selectedDoctor?.doctorId === doctor.doctorId;
                        return (
                            <article
                                key={doctor.doctorId}
                                className={`hours-doctor-card ${isSelected ? "selected" : ""} ${doctor.employmentType}`.trim()}
                            >
                                <button
                                    type="button"
                                    className="hours-doctor-card-open"
                                    onClick={() => selectDoctor(doctor.doctorId)}
                                    aria-expanded={isSelected}
                                    title={isSelected ? "Fechar histórico" : "Abrir histórico completo"}
                                >
                                    <div className="hours-doctor-card-head">
                                        <div>
                                            <strong>{doctor.doctorName}</strong>
                                            {doctor.displayName && doctor.displayName !== doctor.doctorName ? (
                                                <span>{doctor.displayName}</span>
                                            ) : null}
                                        </div>
                                        <span className={`hours-balance-pill ${shiftBalanceClass(doctor.balanceMinutes)}`} title="Saldo total do banco (efetivo)">
                                            {formatSignedMinutes(doctor.balanceMinutes)}
                                        </span>
                                    </div>

                                    <div className="hours-doctor-badges">
                                        <span className={`reports-badge ${doctor.employmentType === "estatutario" ? "warn" : "neutral"}`}>
                                            {formatEmploymentType(doctor.employmentType)}
                                        </span>
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
                                        {pending?.direction === "bonus" && (
                                            <span className="reports-badge ok">pagar {pending.pendingUnits}×12h</span>
                                        )}
                                        {pending?.direction === "penalty" && (
                                            <span className="reports-badge danger">descontar {pending.pendingUnits}×12h</span>
                                        )}
                                        {rows && rows.payrollPendingMinutes > 0 && (
                                            <span className="reports-badge warn" title={`Meses com atraso a abater: ${rows.payrollPendingMonths.map(formatMonthShort).join(", ")}`}>
                                                abater em folha {formatPayrollMinutes(rows.payrollPendingMinutes)}
                                            </span>
                                        )}
                                        {pending?.inconsistency && (
                                            <span className="reports-badge warn">revisar</span>
                                        )}
                                    </div>
                                </button>

                                {/* Plantão a plantão, sem abrir o médico: data · turno · base · saldo,
                                    em linhas curtas, com uma tag por mês (crescente). */}
                                <div className="hours-month-strip">
                                    {!rows || rows.groups.length === 0 ? (
                                        <p className="hours-month-strip-empty">
                                            {focusedMonth ? `Sem plantão em ${monthLabel}.` : "Sem plantão apurado pela aplicação."}
                                        </p>
                                    ) : (
                                        <ul className="hours-month-shifts">
                                            {rows.groups.map((group) => (
                                                <li key={group.monthKey} className="hours-month-block">
                                                    <div className="hours-month-divider" title={`${group.shifts.length} ${group.shifts.length === 1 ? "plantão" : "plantões"}${group.delayCount > 0 ? ` · ${group.delayCount} ${group.delayCount === 1 ? "atraso" : "atrasos"}` : ""}${group.bonusCount > 0 ? ` · ${group.bonusCount} bônus` : ""}`}>
                                                        <span className="hours-month-strip-title">{formatMonthShort(group.monthKey)}</span>
                                                        <span className="hours-month-strip-meta">{group.shifts.length} {group.shifts.length === 1 ? "plantão" : "plantões"}</span>
                                                        <span className={`hours-balance-pill ${shiftBalanceClass(group.balanceMinutes)}`} title="Saldo dos plantões do mês">
                                                            {formatSignedMinutes(group.balanceMinutes)}
                                                        </span>
                                                    </div>
                                                    <ul className="hours-month-shifts">
                                                        {group.shifts.map((shift) => (
                                                            <li key={shiftKey(shift)}>
                                                                <button
                                                                    type="button"
                                                                    className={`hours-month-shift-row ${shiftBalanceClass(shift.balanceMinutes)}`}
                                                                    onClick={() => openDoctorAtShift(doctor.doctorId, shiftAnchorId(shift))}
                                                                    title={`${formatTime(shift.countedStartAt)}–${formatTime(shift.countedEndAt)}${(shift.arrivalDelayMinutes ?? 0) > 0 ? ` · atraso ${formatMinutesForHumans(shift.arrivalDelayMinutes ?? 0)}` : ""}${(shift.creditedOvertimeMinutes ?? 0) > 0 ? ` · crédito ${formatMinutesForHumans(shift.creditedOvertimeMinutes ?? 0)}` : ""}${shift.flags.hasOpenShift ? " · em aberto" : ""} — abrir no histórico`}
                                                                >
                                                                    <span className="hours-month-shift-date">{formatShortDate(shift.startedAt)}</span>
                                                                    <span className="hours-month-shift-turn">{shift.shiftLabel ?? "—"}</span>
                                                                    <span className="hours-month-shift-place">{shift.targetCode}</span>
                                                                    <span className={`hours-balance-pill ${shiftBalanceClass(shift.balanceMinutes)}`}>
                                                                        {shift.balanceMinutes === null ? "--" : formatSignedMinutes(shift.balanceMinutes)}
                                                                    </span>
                                                                </button>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            </article>
                        );
                    })}
                </div>

                {selectedDoctor ? (
                <aside className="hours-detail-panel" ref={detailPanelRef}>
                        <>
                            <header className="hours-detail-header sticky">
                                <div>
                                    <p className="reports-kicker">Histórico do médico · {formatEmploymentType(selectedDoctor.employmentType)}</p>
                                    <h2>{selectedDoctor.doctorName}</h2>
                                    {selectedDoctor.displayName && selectedDoctor.displayName !== selectedDoctor.doctorName ? (
                                        <p>{selectedDoctor.displayName}</p>
                                    ) : null}
                                </div>
                                <div className="hours-detail-header-actions">
                                    <span className={`hours-balance-pill large ${shiftBalanceClass(selectedDoctor.balanceMinutes)}`}>{formatMinutesForHumans(selectedDoctor.balanceMinutes)}</span>
                                    <button
                                        type="button"
                                        className="hours-close-button"
                                        onClick={closeDoctor}
                                        aria-label={`Fechar histórico de ${selectedDoctor.doctorName}`}
                                        title="Fechar histórico (Esc)"
                                    >
                                        ✕
                                    </button>
                                </div>
                            </header>

                            <details className="hours-events-panel">
                                <summary className="hours-events-header">
                                    <span className="hours-proof-label">O que mexeu no saldo <small>· clique para expandir</small></span>
                                    {selectedDoctorTotals ? (
                                        <div className="hours-events-chips">
                                            {selectedDoctorTotals.delayCount > 0 && (
                                                <span className="hours-chip debit">{selectedDoctorTotals.delayCount} {selectedDoctorTotals.delayCount === 1 ? "atraso" : "atrasos"} · −{formatMinutesForHumans(selectedDoctorTotals.delayMinutes)}</span>
                                            )}
                                            {selectedDoctorTotals.bonusCount > 0 && (
                                                <span className="hours-chip credit">{selectedDoctorTotals.bonusCount} bônus · +{formatMinutesForHumans(selectedDoctorTotals.bonusMinutes)}</span>
                                            )}
                                            {selectedDoctorTotals.settlementCount > 0 && (
                                                <span className="hours-chip neutral">{selectedDoctorTotals.settlementCount} {selectedDoctorTotals.settlementCount === 1 ? "acerto" : "acertos"}</span>
                                            )}
                                            {selectedDoctorTotals.overrideCount > 0 && (
                                                <span className="hours-chip warn">{selectedDoctorTotals.overrideCount} {selectedDoctorTotals.overrideCount === 1 ? "ajuste manual" : "ajustes manuais"}</span>
                                            )}
                                            {selectedDoctor.legacy && (
                                                <span className="hours-chip neutral">planilha: {formatSignedMinutes(selectedDoctor.legacy.totalMinutes)}</span>
                                            )}
                                        </div>
                                    ) : null}
                                </summary>

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
                            </details>

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
                                    <p className="reports-summary-label">Acertos lançados</p>
                                    <ul className="hours-settlements-list">
                                        {(() => {
                                            // Estornos referenciam o acerto original em notes ("reversal:<id> — motivo").
                                            const reversedIds = new Set(
                                                selectedDoctor.settlements
                                                    .filter((settlement) => settlement.notes.startsWith("reversal:"))
                                                    .map((settlement) => settlement.notes.slice("reversal:".length).split(" ")[0]),
                                            );
                                            return selectedDoctor.settlements.map((settlement) => {
                                                const isReversal = settlement.notes.startsWith("reversal:");
                                                const isReversed = reversedIds.has(settlement.id);
                                                return (
                                                    <li
                                                        key={settlement.id}
                                                        className={`hours-settlement-row ${settlement.kind}`}
                                                    >
                                                        <span className="hours-settlement-tag">
                                                            {settlementTag(settlement, isReversal)}
                                                        </span>
                                                        <span className="hours-settlement-month">{settlement.monthKey}</span>
                                                        <span className="hours-settlement-delta">
                                                            {settlement.deltaMinutes > 0 ? "+" : ""}
                                                            {formatMinutesForHumans(settlement.deltaMinutes)}
                                                        </span>
                                                        <span className="hours-settlement-notes" title={settlement.notes}>{settlement.notes}</span>
                                                        {isReversed ? (
                                                            <span className="reports-badge warn">estornado</span>
                                                        ) : null}
                                                        {canManageOverrides && !isReversal && !isReversed ? (
                                                            <button
                                                                type="button"
                                                                className="admin-bar-filters-toggle"
                                                                disabled={reversingSettlementId === settlement.id}
                                                                onClick={() => void reverseSettlement(settlement.id)}
                                                                title="Cria um lançamento compensatório (nada é apagado) e avisa o médico"
                                                            >
                                                                {reversingSettlementId === settlement.id ? "Estornando…" : "Estornar"}
                                                            </button>
                                                        ) : null}
                                                    </li>
                                                );
                                            });
                                        })()}
                                    </ul>
                                    <p className="hours-settlement-hint">
                                        Acerto de ±12h gera um plantão <strong>verde</strong> (bônus) ou <strong>vermelho</strong> (punição) no fechamento daquele mês.
                                        Abatimento em <strong>folha</strong> (estatutário) só devolve ao banco os minutos de atraso já descontados na folha de pagamento/ponto.
                                    </p>
                                </section>
                            ) : null}

                            {canManageOverrides && selectedDoctor.employmentType === "estatutario" ? (() => {
                                // Estatutário: atraso do mês vai para a folha, não para plantão vermelho.
                                const payroll = resolvePayrollDeductionForDoctorMonth({
                                    monthKey: payrollMonth,
                                    legacyMinutes: selectedDoctor.legacy?.totalMinutes ?? 0,
                                    shifts: selectedDoctor.shifts,
                                    settlements: selectedDoctor.settlements,
                                });
                                const negativeShifts = selectedDoctor.shifts
                                    .filter((shift) => shift.monthKey === payrollMonth && (shift.balanceMinutes ?? 0) < 0)
                                    .sort(compareShiftsAsc);
                                const pendingMonths = rowsByDoctor.get(selectedDoctor.doctorId)?.payrollPendingMonths ?? [];
                                const settleBalance = resolveBankHoursSettlementBalance({
                                    oldMinutes: selectedDoctor.legacy?.preMay2025Minutes ?? 0,
                                    recentMinutes: (selectedDoctor.legacy?.spreadsheetPeriodMinutes ?? 0) + selectedDoctor.applicationBalanceMinutes,
                                });
                                const pending = pendingByDoctor.get(selectedDoctor.doctorId);
                                const busy = payrollBusyDoctorId === selectedDoctor.doctorId;
                                return (
                                    <section className="hours-settlements hours-settlement-action hours-payroll-action">
                                        <p className="reports-summary-label">Abater em folha · estatutário</p>
                                        <p className="hours-settlement-hint">
                                            O estatutário é pago pela folha da prefeitura. O banco positivo é o primeiro colchão do atraso: entram primeiro os créditos do mês, depois cada débito consome o banco enquanto ele está acima de zero. Só o que passa do zero vai à folha de pagamento/ponto. Saldo prévio negativo nunca vai à folha — os créditos só o atenuam. Ao abater, o banco devolve exatamente os minutos levados à folha.
                                        </p>

                                        <label className="hours-settlement-month-field">
                                            <span>Mês da folha</span>
                                            <select
                                                value={payrollMonth}
                                                onChange={(event) => { setPayrollMonth(event.target.value); setPayrollError(null); }}
                                            >
                                                {monthKeys.map((key) => (
                                                    <option key={key} value={key}>
                                                        {formatMonthLabel(key)}{pendingMonths.includes(key) ? " · atraso a abater" : ""}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                        {pendingMonths.length > 0 && !pendingMonths.includes(payrollMonth) ? (
                                            <p className="hours-settlement-hint">
                                                Atraso a abater em: {pendingMonths.map((key) => (
                                                    <button key={key} type="button" className="hours-inline-link" onClick={() => setPayrollMonth(key)}>{formatMonthShort(key)}</button>
                                                ))}
                                            </p>
                                        ) : null}

                                        {negativeShifts.length > 0 ? (
                                            <ul className="hours-payroll-list">
                                                {negativeShifts.map((shift) => (
                                                    <li key={shiftKey(shift)}>
                                                        <button type="button" className="hours-payroll-row" onClick={() => scrollToShift(shiftAnchorId(shift))}>
                                                            <span className="hours-month-shift-date">{formatShortDate(shift.startedAt)}</span>
                                                            <span className="hours-month-shift-turn">{shift.shiftLabel ?? "—"}</span>
                                                            <span className="hours-month-shift-place">
                                                                {shift.targetCode}
                                                                <small>chegou {formatTime(shift.countedStartAt)}, previsto {formatTime(shift.bankScheduledStartAt)}</small>
                                                            </span>
                                                            <span className="hours-balance-pill negative">{formatSignedMinutes(shift.balanceMinutes ?? 0)}</span>
                                                        </button>
                                                    </li>
                                                ))}
                                                <li className="hours-payroll-total">
                                                    <span>Débitos de {formatMonthLabel(payrollMonth)}</span>
                                                    <span className="hours-balance-pill negative">{formatSignedMinutes(payroll.negativeMinutes)}</span>
                                                </li>
                                            </ul>
                                        ) : (
                                            <p className="hours-settlement-hint">Sem atraso em {formatMonthLabel(payrollMonth)} — nada a abater em folha.</p>
                                        )}

                                        <PayrollWaterfall payroll={payroll} />

                                        {payroll.abatedMinutes !== 0 ? (
                                            <p className="hours-settlement-hint">
                                                Já abatido em folha neste mês: <strong>{formatPayrollMinutes(payroll.abatedMinutes)}</strong>
                                                {payroll.pending ? ` — falta ${formatPayrollMinutes(-payroll.remainingMinutes)}.` : "."}
                                            </p>
                                        ) : null}

                                        {payrollError ? <div className="hours-override-error">{payrollError}</div> : null}

                                        {payroll.pending ? (
                                            <button
                                                type="button"
                                                className="payment-button bank-payroll"
                                                disabled={busy}
                                                onClick={() => void submitPayrollSettlement(selectedDoctor, payroll)}
                                            >
                                                {busy ? "Abatendo…" : `Abater em folha ${formatPayrollMinutes(-payroll.remainingMinutes)} de ${formatMonthShort(payrollMonth)}`}
                                            </button>
                                        ) : negativeShifts.length > 0 ? (
                                            <p className="hours-settlement-hint">Atraso deste mês já abatido em folha. Para desfazer, estorne o lançamento na lista de acertos.</p>
                                        ) : null}

                                        {settleBalance.bonusEligibleMinutes >= BANK_HOURS_SETTLEMENT_MINUTES ? (
                                            <>
                                                {pending?.direction === "bonus" ? (
                                                    <p className="hours-settlement-hint">
                                                        Crédito elegível: {pending.pendingUnits} {pending.pendingUnits === 1 ? "plantão de 12h disponível" : "plantões de 12h disponíveis"} para pagar
                                                        {" — sobra "}{formatSignedHours(pending.residualMinutes)} após aplicar tudo.
                                                    </p>
                                                ) : null}
                                                <a
                                                    className="payment-button bank-bonus"
                                                    href={`/admin/payment-closing?month=${encodeURIComponent(settlementMonth)}&doctor=${encodeURIComponent(selectedDoctor.doctorId)}`}
                                                >
                                                    Lançar bônus (+1 plantão extra) no fechamento →
                                                </a>
                                            </>
                                        ) : null}
                                    </section>
                                );
                            })() : null}

                            {canManageOverrides && selectedDoctor.employmentType !== "estatutario" ? (
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
                                        const pending = pendingByDoctor.get(selectedDoctor.doctorId);
                                        const pendingSummary = pending?.direction ? (
                                            <p className="hours-settlement-hint">
                                                {pending.direction === "bonus"
                                                    ? `${pending.pendingUnits} ${pending.pendingUnits === 1 ? "plantão de 12h disponível" : "plantões de 12h disponíveis"} para pagar`
                                                    : `${pending.pendingUnits} ${pending.pendingUnits === 1 ? "plantão de 12h a descontar" : "plantões de 12h a descontar"}`}
                                                {" — sobra "}{formatSignedHours(pending.residualMinutes)} após aplicar tudo.
                                                {pending.inconsistency
                                                    ? " ⚠️ O saldo anda na direção CONTRÁRIA aos acertos já lançados — revise antes de aplicar (um plantão pode ter sido invalidado depois do acerto)."
                                                    : ""}
                                            </p>
                                        ) : null;
                                        if (settleBalance.bonusEligibleMinutes >= BANK_HOURS_SETTLEMENT_MINUTES) {
                                            return (<>
                                                {pendingSummary}
                                                <a
                                                    className="payment-button bank-bonus"
                                                    href={`/admin/payment-closing?month=${encodeURIComponent(settlementMonth)}&doctor=${encodeURIComponent(selectedDoctor.doctorId)}`}
                                                >
                                                    Lançar bônus (+1 plantão verde) no fechamento →
                                                </a>
                                            </>);
                                        }
                                        if (settleBalance.penaltyEligibleMinutes <= -BANK_HOURS_SETTLEMENT_MINUTES) {
                                            return (<>
                                                {pendingSummary}
                                                <a
                                                    className="payment-button bank-penalty"
                                                    href={`/admin/payment-closing?month=${encodeURIComponent(settlementMonth)}&doctor=${encodeURIComponent(selectedDoctor.doctorId)}`}
                                                >
                                                    Lançar punição (1 plantão vermelho) no fechamento →
                                                </a>
                                            </>);
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

                            {/* A vida inteira, mês a mês, do mais antigo ao mais recente. */}
                            <div className="hours-shift-list">
                                {selectedDoctorMonths.length === 0 ? (
                                    <article className="hours-empty-state">
                                        <strong>Nenhum plantão apurado pela aplicação.</strong>
                                        <span>O saldo deste médico vem só de planilha e acertos.</span>
                                    </article>
                                ) : null}
                                {selectedDoctorMonths.map((group) => (
                                    <section
                                        key={group.monthKey}
                                        id={monthAnchorId(selectedDoctor.doctorId, group.monthKey)}
                                        className={`hours-month-group ${group.monthKey === focusedMonth ? "current" : ""}`.trim()}
                                    >
                                        <header className="hours-month-group-header">
                                            <div>
                                                <h3>{formatMonthLabel(group.monthKey)}</h3>
                                                <span>
                                                    {group.shifts.length} {group.shifts.length === 1 ? "plantão" : "plantões"}
                                                    {group.delayCount > 0 ? ` · ${group.delayCount} ${group.delayCount === 1 ? "atraso" : "atrasos"}` : ""}
                                                    {group.bonusCount > 0 ? ` · ${group.bonusCount} bônus` : ""}
                                                </span>
                                            </div>
                                            <div className="hours-month-group-actions">
                                                {group.monthKey !== focusedMonth ? (
                                                    <button type="button" className="admin-bar-filters-toggle" onClick={() => selectMonth(group.monthKey)} title="Focar este mês na tela toda">
                                                        focar mês
                                                    </button>
                                                ) : (
                                                    <button type="button" className="admin-bar-filters-toggle open" onClick={() => selectMonth(ALL_MONTHS)} title="Voltar a ver toda a vida">
                                                        mês em foco ✕
                                                    </button>
                                                )}
                                                <span className={`hours-balance-pill ${shiftBalanceClass(group.balanceMinutes)}`}>{formatSignedMinutes(group.balanceMinutes)}</span>
                                            </div>
                                        </header>

                                        {group.shifts.map((shift) => {
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

                                            {(() => {
                                                // O plantão contado em português: chegada, saída, quem rendeu,
                                                // por que virou crédito. O passo a passo técnico continua logo
                                                // abaixo, recolhido, para quem precisar conferir hora a hora.
                                                const story = buildBankHoursStory({
                                                    doctorName: shift.displayName ?? shift.doctorName,
                                                    targetCode: shift.targetCode,
                                                    shiftLabel: shift.shiftLabel,
                                                    notes: shift.notes,
                                                    scheduledStartAt: shift.bankScheduledStartAt,
                                                    scheduledEndAt: shift.bankScheduledEndAt,
                                                    startedAt: shift.startedAt,
                                                    actualEndedAt: shift.actualEndedAt,
                                                    handoffEndedAt: shift.handoffEndedAt,
                                                    countedEndAt: shift.countedEndAt,
                                                    arrivalDelayMinutes: shift.arrivalDelayMinutes,
                                                    overtimeMinutes: shift.overtimeMinutes,
                                                    creditedOvertimeMinutes: shift.creditedOvertimeMinutes,
                                                    balanceMinutes: shift.balanceMinutes,
                                                    lateDeparture: shift.lateDeparture ?? null,
                                                    successorDoctorName: shift.successorDoctorName,
                                                    successorTookOverAt: shift.successorTookOverAt,
                                                    approvalLabel: shift.approval.label,
                                                    approvalPending: shift.approval.tone === "pending" || shift.approval.tone === "warn",
                                                });
                                                return (
                                                    <section className="hours-story-box">
                                                        <p className="hours-story-text">{story.sentences.join(" ")}</p>
                                                    </section>
                                                );
                                            })()}

                                            <details className="hours-detail-toggle">
                                                <summary>Ver o cálculo passo a passo</summary>
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
                                            </details>

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
                                    </section>
                                ))}
                            </div>

                            <button type="button" className="hours-close-footer" onClick={closeDoctor}>
                                Fechar histórico de {selectedDoctor.doctorName} ✕
                            </button>
                        </>
                </aside>
                ) : null}
            </section>
        </main>
        </div>
    );
}
