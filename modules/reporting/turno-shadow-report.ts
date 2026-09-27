/**
 * Relatório da sombra ADR-007 R4: onde a régua por turno divergiria do desfecho
 * gravado no pedaço, e quanto isso mexeria no pagamento.
 *
 * A sombra não persiste nada (só marca a linha do fechamento e loga
 * `[turno-sombra]` no pm2), então o relatório RECALCULA: roda o mesmo
 * buildPayableShiftsFromBoards do fechamento sobre o período e lê o
 * `turnoShadow` que a própria sombra anexou às linhas divergentes. Nenhuma
 * régua nova aqui — só contagem e soma.
 *
 * Impacto é por TURNO (médico × slot), não por linha: o que o fechamento paga
 * hoje é a soma das unidades das linhas do médico no slot; o que a régua por
 * turno pagaria é a unidade do desfecho do turno (inteiro 1, meio 0,5, banco 0).
 */
import {
    resolveShiftDueAmountCents,
    type DoctorEmploymentType,
    type DoctorPaymentProfile,
    type PayableShift,
} from "@/modules/reporting/payable-shifts";
import type { TurnoDivergenceKind, TurnoOutcome } from "@/modules/reporting/turno-outcome";

export const TURNO_DIVERGENCE_LABELS: Record<TurnoDivergenceKind, string> = {
    corte_em_turno_inteiro: "Corte num turno de 10h+ (por turno pagaria inteiro)",
    corte_fora_do_fim: "Corte gravado fora do último pedaço do turno",
    turno_curto_sem_corte: "Turno com menos de 6h sem corte (por turno seria só banco)",
};

const TURNO_UNIT: Record<TurnoOutcome, number> = { full_shift: 1, half_shift: 0.5, bank_only: 0 };

export interface TurnoShadowDivergence {
    kind: TurnoDivergenceKind;
    operationalDate: string;
    shiftLabel: string;
    doctorId: string;
    doctorName: string;
    targetCode: string;
    recordedOutcome: PayableShift["earlyDepartureOutcome"];
    turnoOutcome: TurnoOutcome;
    positionedMinutes: number;
    text: string;
}

export interface TurnoShadowTurnImpact {
    doctorId: string;
    doctorName: string;
    operationalDate: string;
    shiftLabel: string;
    currentUnits: number;
    shadowUnits: number;
    deltaUnits: number;
    deltaCents: number;
}

export interface TurnoShadowReport {
    divergences: TurnoShadowDivergence[];
    countsByKind: Record<TurnoDivergenceKind, number>;
    turns: TurnoShadowTurnImpact[];
    totals: { turns: number; deltaUnits: number; deltaCents: number; gainCents: number; lossCents: number };
}

export function buildTurnoShadowReport(
    shifts: PayableShift[],
    settings: { profiles: Map<string, DoctorPaymentProfile>; employmentTypes: Map<string, DoctorEmploymentType> },
): TurnoShadowReport {
    const turnKey = (shift: PayableShift) => `${shift.doctorId}|${shift.slotStartedAt}`;
    const unitsByTurn = new Map<string, number>();
    for (const shift of shifts) {
        unitsByTurn.set(turnKey(shift), (unitsByTurn.get(turnKey(shift)) ?? 0) + shift.paymentUnit);
    }

    const divergences: TurnoShadowDivergence[] = [];
    const turns = new Map<string, TurnoShadowTurnImpact>();
    for (const shift of shifts) {
        const shadow = shift.turnoShadow;
        if (!shadow?.divergenceKind || !shadow.divergence) continue;
        divergences.push({
            kind: shadow.divergenceKind,
            operationalDate: shift.operationalDate.slice(0, 10),
            shiftLabel: shift.shiftLabel,
            doctorId: shift.doctorId,
            doctorName: shift.doctorName,
            targetCode: shift.targetCode,
            recordedOutcome: shift.earlyDepartureOutcome,
            turnoOutcome: shadow.turnoOutcome,
            positionedMinutes: shadow.positionedMinutes,
            text: shadow.divergence,
        });

        const key = turnKey(shift);
        if (turns.has(key)) continue;
        // Todas as linhas do turno veem as mesmas peças: o desfecho do turno é um só.
        const currentUnits = unitsByTurn.get(key) ?? 0;
        const shadowUnits = TURNO_UNIT[shadow.turnoOutcome];
        const deltaUnits = shadowUnits - currentUnits;
        turns.set(key, {
            doctorId: shift.doctorId,
            doctorName: shift.doctorName,
            operationalDate: shift.operationalDate.slice(0, 10),
            shiftLabel: shift.shiftLabel,
            currentUnits,
            shadowUnits,
            deltaUnits,
            deltaCents: resolveShiftDueAmountCents({
                profile: settings.profiles.get(shift.doctorId) ?? "generalist",
                operationalDate: shift.operationalDate,
                paymentUnit: deltaUnits,
                employmentType: settings.employmentTypes.get(shift.doctorId) ?? "pj",
            }),
        });
    }

    const countsByKind: Record<TurnoDivergenceKind, number> = {
        corte_em_turno_inteiro: 0,
        corte_fora_do_fim: 0,
        turno_curto_sem_corte: 0,
    };
    for (const divergence of divergences) countsByKind[divergence.kind] += 1;

    const turnList = [...turns.values()].sort((left, right) => left.operationalDate.localeCompare(right.operationalDate)
        || left.doctorName.localeCompare(right.doctorName, "pt-BR"));
    const totals = { turns: turnList.length, deltaUnits: 0, deltaCents: 0, gainCents: 0, lossCents: 0 };
    for (const turn of turnList) {
        totals.deltaUnits += turn.deltaUnits;
        totals.deltaCents += turn.deltaCents;
        if (turn.deltaCents > 0) totals.gainCents += turn.deltaCents;
        if (turn.deltaCents < 0) totals.lossCents += turn.deltaCents;
    }

    return { divergences, countsByKind, turns: turnList, totals };
}

function brl(cents: number) {
    return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function hours(minutes: number) {
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

function units(value: number) {
    return value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function renderTurnoShadowReportMarkdown(
    report: TurnoShadowReport,
    params: { from: string; to: string; maxExamples: number },
): string {
    const lines: string[] = [
        `# Sombra ADR-007 R4 — ${params.from} a ${params.to}`,
        "",
        "Régua por turno (presença posicionada somada no slot) contra o desfecho gravado no pedaço.",
        "Recalculado com o mesmo buildPayableShiftsFromBoards do fechamento. Nada foi gravado.",
        "",
        "## Contagem por tipo",
        "",
        "| Tipo | Linhas |",
        "|---|---:|",
    ];
    for (const [kind, label] of Object.entries(TURNO_DIVERGENCE_LABELS) as [TurnoDivergenceKind, string][]) {
        lines.push(`| ${label} | ${report.countsByKind[kind]} |`);
    }
    lines.push(`| **Total** | **${report.divergences.length}** |`, "");

    lines.push(
        "## Impacto no pagamento (estimativa por turno)",
        "",
        `Turnos afetados: **${report.totals.turns}** · saldo em plantões: **${units(report.totals.deltaUnits)}** · `
            + `saldo em valor: **${brl(report.totals.deltaCents)}** (a mais ${brl(report.totals.gainCents)}, a menos ${brl(report.totals.lossCents)})`,
        "",
        "Estatutário entra com valor zero (pago fora deste sistema).",
        "",
    );

    for (const [kind, label] of Object.entries(TURNO_DIVERGENCE_LABELS) as [TurnoDivergenceKind, string][]) {
        const examples = report.divergences.filter((item) => item.kind === kind);
        if (examples.length === 0) continue;
        lines.push(`## ${label} — ${examples.length}`, "", "| Data | Turno | Médico | Posição | Gravado | Por turno | Posicionado |", "|---|---|---|---|---|---|---:|");
        for (const item of examples.slice(0, params.maxExamples)) {
            lines.push(`| ${item.operationalDate} | ${item.shiftLabel} | ${item.doctorName} | ${item.targetCode} | ${item.recordedOutcome ?? "—"} | ${item.turnoOutcome} | ${hours(item.positionedMinutes)} |`);
        }
        if (examples.length > params.maxExamples) lines.push(`| … mais ${examples.length - params.maxExamples} | | | | | | |`);
        lines.push("");
    }

    if (report.turns.length > 0) {
        lines.push("## Turnos com mudança de valor", "", "| Data | Turno | Médico | Hoje | Por turno | Δ valor |", "|---|---|---|---:|---:|---:|");
        for (const turn of report.turns.filter((item) => item.deltaUnits !== 0).slice(0, params.maxExamples)) {
            lines.push(`| ${turn.operationalDate} | ${turn.shiftLabel} | ${turn.doctorName} | ${units(turn.currentUnits)} | ${units(turn.shadowUnits)} | ${brl(turn.deltaCents)} |`);
        }
        lines.push("");
    }

    return lines.join("\n");
}
