/**
 * Banco de horas visto pelo MÉDICO (Painel do médico, /banco-de-horas/...).
 *
 * As queixas vinham de médicos: o saldo aparecia sem a conta, 30 cartões iguais
 * com jargão ("saída no cálculo") e um "aguardando a chefia" que nunca mudava.
 * Este módulo transforma o histórico do banco num modelo de leitura em
 * português, na segunda pessoa, que a tela só desenha:
 *
 * - a CONTA do saldo, parcela por parcela, que sempre fecha (resíduo vira
 *   "ajustes da coordenação");
 * - os meses, com o que mexeu no saldo e o saldo ao fim de cada um;
 * - só os plantões que importam (mexeram no saldo, tiveram rendição ou saída a
 *   validar); o resto vira "N plantões sem alteração";
 * - a validação da saída no PASSADO: a chefia de plantão tem 12h depois da
 *   saída para validar. Passou disso, a frase diz quem estava na chefia e que
 *   não validou — ninguém volta ao passado para validar. O saldo já reflete
 *   isso: sem confirmação, o banco conta só até a rendição/fim previsto
 *   (resolveCountedEndAt em bank-hours-history.ts).
 *
 * Puro: recebe o histórico e o "agora"; sem I/O.
 */
import { resolvePayrollLedger } from "@/modules/bank-hours/payroll";
import type {
    BankHoursDoctorHistory,
    BankHoursHistoryShift,
    BankHoursSettlementSummary,
} from "@/modules/reporting/bank-hours-history";

const TZ = "America/Sao_Paulo";
const DOZE_HORAS_MS = 12 * 60 * 60 * 1000;
const TROCA_MINUTOS = 12 * 60;

export type DoctorShiftFilter = "atraso" | "alem";

export interface DoctorShiftValidationView {
    tone: "ok" | "warn" | "neutral";
    /** Texto curto na linha fechada; null = sem selo. */
    chip: string | null;
    sentence: string;
    /** Rótulo da caixa da saída que valeu no final. */
    finalLabel: string;
}

export interface DoctorShiftView {
    id: string;
    dayLabel: string;
    weekday: string;
    shiftLabel: string;
    place: string;
    /** "chegou 19:22 · saiu 07:05" — o que o médico fez, em texto. */
    summary: string;
    scheduled: string | null;
    arrivedAt: string | null;
    declaredExitLabel: string;
    declaredExit: string | null;
    finalExit: string | null;
    handoff: { name: string | null; at: string } | null;
    delayMinutes: number;
    /** Minutos que ficou além do fim previsto (relógio, antes da regra). */
    extraMinutes: number;
    creditedMinutes: number;
    doubled: boolean;
    balanceMinutes: number;
    story: string[];
    validation: DoctorShiftValidationView | null;
}

export interface DoctorSettlementView {
    id: string;
    dayLabel: string;
    text: string;
    detail: string;
    deltaMinutes: number;
    reversed: boolean;
}

export interface DoctorMonthView {
    monthKey: string;
    label: string;
    shiftCount: number;
    delayCount: number;
    extraCount: number;
    movedMinutes: number;
    closingMinutes: number;
    /** Estatutário: atraso do mês que foi para a folha (não fica no banco). */
    payrollMinutes: number;
    shifts: DoctorShiftView[];
    quietDays: string[];
    settlements: DoctorSettlementView[];
}

export interface DoctorCompositionTerm {
    key: string;
    label: string;
    detail: string;
    minutes: number;
    filter: DoctorShiftFilter | null;
}

export interface DoctorHeadline {
    tone: "verde" | "neutra" | "ambar";
    title: string;
    detail: string;
    /** Leva ao bloco de troca/retirada. */
    showAction: boolean;
    actionLabel: string | null;
}

export interface DoctorBankHoursView {
    isStatutory: boolean;
    saldoMinutes: number;
    /** PJ: crédito anterior a mai/2025 fica fora do saldo mostrado (não vira troca). */
    hiddenOldCreditMinutes: number;
    headline: DoctorHeadline;
    composition: DoctorCompositionTerm[];
    months: DoctorMonthView[];
    defaultOpenMonthKey: string | null;
}

// ---------- formatação ----------

export function formatDuration(minutes: number) {
    const abs = Math.abs(Math.round(minutes));
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    if (h === 0) return `${m}min`;
    return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

export function formatSignedDuration(minutes: number) {
    if (minutes === 0) return "0";
    return `${minutes > 0 ? "+" : "−"}${formatDuration(minutes)}`;
}

function hora(iso: string | null) {
    if (!iso) return null;
    return new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function diaMes(date: Date) {
    const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "short" }).formatToParts(date);
    const dia = parts.find((p) => p.type === "day")?.value ?? "";
    const mes = (parts.find((p) => p.type === "month")?.value ?? "").replace(".", "");
    return `${dia}/${mes}`;
}

function diaMesDeData(operationalDate: string) {
    // AAAA-MM-DD sem fuso: meio-dia UTC cai no mesmo dia em São Paulo.
    return diaMes(new Date(`${operationalDate}T12:00:00Z`));
}

function diaSemana(iso: string) {
    return new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "short" })
        .format(new Date(iso))
        .replace(".", "");
}

function diaEHora(date: Date) {
    return `${diaMes(date)} às ${hora(date.toISOString())}`;
}

export function formatMonthLabel(monthKey: string) {
    const [ano, mes] = monthKey.split("-").map(Number);
    const nome = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", month: "long" }).format(new Date(Date.UTC(ano, mes - 1, 15)));
    return `${nome} de ${ano}`;
}

function minutosEntre(inicio: string | null, fim: string | null) {
    if (!inicio || !fim) return 0;
    return Math.round((new Date(fim).getTime() - new Date(inicio).getTime()) / 60000);
}

// ---------- validação da saída ----------

const ATIVIDADE_POR_MOTIVO: Record<string, string> = {
    occurrence: "em ocorrência",
    hygienization: "na higienização da viatura",
    chief_release: "liberado pela chefia",
    handoff: "esperando a rendição",
};

function chefia(nome: string | null) {
    return nome ? `a chefia (${nome})` : "a chefia de plantão";
}

export function resolveDoctorShiftValidation(
    shift: BankHoursHistoryShift,
    now: Date,
): DoctorShiftValidationView | null {
    const approval = shift.approval;
    if (approval.state === "sem_pendencia") return null;
    const contou = hora(shift.countedEndAt);
    const nome = approval.chiefName;

    if (approval.state === "validado") {
        if (approval.label.includes("automaticamente")) {
            return {
                tone: "ok",
                chip: null,
                sentence: "O sistema confirmou sua saída automaticamente: ela bateu com o seu aviso ou com a chegada de quem assumiu.",
                finalLabel: "Confirmada pelo sistema",
            };
        }
        return {
            tone: "ok",
            chip: null,
            sentence: nome ? `${nome}, da chefia, validou sua saída.` : "A chefia validou sua saída.",
            finalLabel: "Validada pela chefia",
        };
    }

    if (approval.state === "corrigido_pela_chefia") {
        return {
            tone: "warn",
            chip: "saída corrigida",
            sentence: `${nome ? `${nome}, da chefia,` : "A chefia"} corrigiu sua saída para ${contou ?? "um horário anterior"}. O banco contou até esse horário.`,
            finalLabel: "Corrigida pela chefia",
        };
    }

    if (approval.state === "credito_retido_para_revisao") {
        return {
            tone: "warn",
            chip: "retido para revisão",
            sentence: "O tempo além do horário saiu fora do padrão e ficou retido até a coordenação revisar. Ele não foi recusado.",
            finalLabel: "Saída que valeu",
        };
    }

    // aguardando_chefia / ocorrencia_nao_informada: a chefia de plantão tem 12h.
    const saida = shift.actualEndedAt ? new Date(shift.actualEndedAt) : null;
    const prazo = saida ? new Date(saida.getTime() + DOZE_HORAS_MS) : null;
    const semNumero = approval.state === "ocorrencia_nao_informada";

    if (prazo && now.getTime() < prazo.getTime()) {
        return {
            tone: "neutral",
            chip: `validação até ${hora(prazo.toISOString())}`,
            sentence: `${nome ? `A chefia de plantão (${nome})` : "A chefia de plantão"} pode validar essa saída até ${diaEHora(prazo)}.`
                + (semNumero ? " Falta você informar o número da ocorrência." : "")
                + (contou ? ` Sem validação, o banco conta só até ${contou}.` : ""),
            finalLabel: "Saída que vale por enquanto",
        };
    }

    let sentence: string;
    if (shift.successorDoctorName) {
        const atividade = ATIVIDADE_POR_MOTIVO[shift.lateDeparture?.reasonCode ?? "occurrence"] ?? "em atividade";
        const as = hora(shift.successorTookOverAt ?? shift.countedEndAt);
        sentence = `${shift.successorDoctorName} assumiu seu posto${as ? ` às ${as}` : ""}, e ${chefia(nome)} não validou que você estava ${atividade}.`;
    } else if (shift.domain === "regulation") {
        sentence = nome
            ? `A chefia era ${nome} e não validou essa saída com bônus.`
            : "A chefia de plantão não validou essa saída com bônus.";
    } else {
        sentence = nome
            ? `A chefia era ${nome} e não aprovou esse bônus.`
            : "A chefia de plantão não aprovou esse bônus.";
    }
    if (semNumero) sentence = `Você não informou o número da ocorrência. ${sentence}`;
    if (contou) sentence += ` O banco contou até ${contou}.`;
    return { tone: "warn", chip: "saída não validada", sentence, finalLabel: "Saída que valeu" };
}

// ---------- plantão ----------

function buildShiftView(shift: BankHoursHistoryShift, now: Date): DoctorShiftView & { relevant: boolean; monthKey: string } {
    const delay = shift.arrivalDelayMinutes ?? 0;
    const overtime = shift.overtimeMinutes ?? 0;
    const credited = shift.creditedOvertimeMinutes ?? 0;
    const balance = shift.balanceMinutes ?? 0;
    const doubled = credited > overtime && overtime > 0;
    const arrived = hora(shift.countedStartAt ?? shift.startedAt);
    const declared = hora(shift.actualEndedAt);
    const final = hora(shift.countedEndAt);
    const open = !shift.actualEndedAt && !shift.countedEndAt;
    const prevIni = hora(shift.bankScheduledStartAt);
    const prevFim = hora(shift.bankScheduledEndAt);
    const saidaDiferente = Boolean(declared && final && shift.actualEndedAt && shift.countedEndAt
        && new Date(shift.actualEndedAt).getTime() !== new Date(shift.countedEndAt).getTime());
    const handoff = saidaDiferente && final
        ? { name: shift.successorDoctorName, at: hora(shift.successorTookOverAt) ?? final }
        : null;
    const extraMinutes = Math.max(0, minutosEntre(shift.bankScheduledEndAt, shift.countedEndAt));
    const validation = resolveDoctorShiftValidation(shift, now);

    const story: string[] = [];
    if (arrived) {
        if (delay > 0) story.push(`Você chegou às ${arrived}, ${formatDuration(delay)} depois das ${prevIni ?? "hora prevista"}.`);
        else if (prevIni && minutosEntre(shift.bankScheduledStartAt, shift.countedStartAt ?? shift.startedAt) > 0) story.push(`Você chegou às ${arrived}, dentro da tolerância de 15 min.`);
        else story.push(`Você chegou às ${arrived}, no horário.`);
    }
    if (open) {
        story.push("O plantão ainda está aberto: ninguém registrou a saída.");
    } else if (handoff && validation && validation.tone !== "ok") {
        // A frase da validação já diz quem assumiu e até onde o banco contou.
        story.push(`Você avisou a saída às ${declared}.`);
    } else if (handoff) {
        story.push(handoff.name
            ? `Você avisou a saída às ${declared}, mas ${handoff.name} assumiu o posto às ${handoff.at}. O banco conta até a rendição.`
            : `Você avisou a saída às ${declared}. O banco contou até ${final}.`);
    } else if (extraMinutes > 0 && final) {
        story.push(`Você saiu às ${final}, ${formatDuration(extraMinutes)} depois do fim previsto (${prevFim}).`);
    } else if (final) {
        story.push(`Você saiu às ${final}.`);
    }
    if (shift.manualBalanceMinutes !== null) {
        story.push(`A coordenação ajustou o saldo deste plantão para ${formatSignedDuration(balance)}.`);
    } else if (shift.ruleCode?.startsWith("ANOMALY") && credited === 0 && balance === 0) {
        story.push("O cálculo saiu fora do padrão e este plantão ficou em 0 até a coordenação revisar.");
    } else if (credited > 0 && doubled) {
        story.push(`Como chegou no horário, o tempo além do horário conta em dobro: +${formatDuration(credited)}.`);
    } else if (credited > 0 && delay > 0) {
        story.push(`Como chegou atrasado, o tempo além do horário conta simples: +${formatDuration(credited)}, menos ${formatDuration(delay)} do atraso. Fica ${formatSignedDuration(balance)}.`);
    } else if (credited > 0) {
        story.push(`Tempo além do horário: +${formatDuration(credited)}.`);
    } else if (delay > 0) {
        story.push(`Sem tempo além do horário, fica só o atraso: −${formatDuration(delay)}.`);
    } else if (!open) {
        story.push("Nada a somar nem a descontar neste plantão.");
    }

    const summary = [
        arrived ? `chegou ${arrived}` : null,
        open ? "ainda em plantão" : declared ? `saiu ${declared}` : final ? `saiu ${final}` : null,
    ].filter(Boolean).join(" · ");

    const relevant = delay > 0 || credited > 0 || balance !== 0 || Boolean(handoff) || Boolean(validation) || open;

    return {
        id: `${shift.domain}-${shift.occupancyId}`,
        monthKey: shift.monthKey,
        dayLabel: diaMes(new Date(shift.startedAt)),
        weekday: diaSemana(shift.startedAt),
        shiftLabel: shift.shiftLabel ?? "—",
        place: shift.targetLabel && shift.targetLabel !== shift.targetCode
            ? `${shift.targetCode} · ${shift.targetLabel}`
            : shift.targetCode,
        summary,
        scheduled: prevIni && prevFim ? `${prevIni} – ${prevFim}` : null,
        arrivedAt: arrived,
        declaredExitLabel: shift.source === "telegram" ? "Saída que você avisou ao bot" : "Saída registrada",
        declaredExit: declared,
        finalExit: final,
        handoff: handoff && handoff.name ? handoff : null,
        delayMinutes: delay,
        extraMinutes,
        creditedMinutes: credited,
        doubled,
        balanceMinutes: balance,
        story,
        validation,
        relevant,
    };
}

// ---------- acertos ----------

const REVERSAL_PREFIX = "reversal:";

function settlementBaseText(settlement: BankHoursSettlementSummary) {
    const dia = settlement.operationalDate ? ` no dia ${settlement.operationalDate.slice(8, 10)}` : "";
    if (settlement.kind === "bonus") return { text: `Plantão extra${dia}`, detail: "trocou 12h do saldo" };
    if (settlement.kind === "penalty") return { text: `Plantão${dia} retirado da folha`, detail: "devolveu 12h ao saldo" };
    return { text: "Atraso abatido na folha", detail: "descontado na folha de ponto" };
}

function buildSettlementViews(settlements: BankHoursSettlementSummary[]): Map<string, DoctorSettlementView[]> {
    const reversedIds = new Set(
        settlements
            .filter((s) => s.notes.startsWith(REVERSAL_PREFIX))
            .map((s) => s.notes.slice(REVERSAL_PREFIX.length).split(" ")[0]),
    );
    const byMonth = new Map<string, DoctorSettlementView[]>();
    for (const settlement of settlements) {
        const isReversal = settlement.notes.startsWith(REVERSAL_PREFIX);
        const base = settlementBaseText(settlement);
        const view: DoctorSettlementView = {
            id: settlement.id,
            dayLabel: settlement.operationalDate ? diaMesDeData(settlement.operationalDate) : diaMes(new Date(settlement.createdAt)),
            text: isReversal ? `Estorno: ${base.text.charAt(0).toLowerCase()}${base.text.slice(1)}` : base.text,
            detail: isReversal ? "desfeito pela coordenação" : base.detail,
            deltaMinutes: settlement.deltaMinutes,
            reversed: reversedIds.has(settlement.id),
        };
        const list = byMonth.get(settlement.monthKey) ?? [];
        list.push(view);
        byMonth.set(settlement.monthKey, list);
    }
    return byMonth;
}

// ---------- frase do saldo ----------

function buildHeadline(params: {
    isStatutory: boolean;
    saldoMinutes: number;
    bonusEligibleMinutes: number;
    penaltyEligibleMinutes: number;
    oldDebtMinutes: number;
    competenciaAberta: boolean;
    payrollThisMonthMinutes: number;
    monthLabel: string;
}): DoctorHeadline {
    const { isStatutory, bonusEligibleMinutes: be, penaltyEligibleMinutes: pe, competenciaAberta } = params;
    if (be >= TROCA_MINUTOS) {
        const n = Math.floor(be / TROCA_MINUTOS);
        return {
            tone: "verde",
            title: `Você pode trocar ${n === 1 ? "12h por 1 plantão extra" : `${n * 12}h por ${n} plantões extra`}.`,
            detail: competenciaAberta
                ? "Escolha um dia livre abaixo. O plantão entra na folha deste mês e o saldo cai 12h."
                : "Este mês não aceita mais lançamento. A troca fica para o mês em curso.",
            showAction: competenciaAberta,
            actionLabel: competenciaAberta ? "Registrar plantão extra" : null,
        };
    }
    if (isStatutory && params.payrollThisMonthMinutes > 0) {
        return {
            tone: "ambar",
            title: `${formatDuration(params.payrollThisMonthMinutes)} de atraso de ${params.monthLabel} vão para a folha de ponto.`,
            detail: "No estatutário, o saldo positivo cobre o atraso primeiro. Só o que passa do zero é descontado na folha e não fica no banco.",
            showAction: false,
            actionLabel: null,
        };
    }
    if (!isStatutory && pe <= -TROCA_MINUTOS) {
        return {
            tone: "ambar",
            title: "Seu saldo passou de −12h.",
            detail: competenciaAberta
                ? "Um plantão deste mês pode ser retirado da folha, e o saldo volta 12h. Escolha qual abaixo."
                : "Um plantão pode ser retirado da folha no mês em curso, e o saldo volta 12h.",
            showAction: competenciaAberta,
            actionLabel: competenciaAberta ? "Escolher o plantão" : null,
        };
    }
    const dividaAntiga = !isStatutory && params.oldDebtMinutes < 0
        ? ` A dívida até abr/2025 (${formatSignedDuration(params.oldDebtMinutes)}) já está nessa conta.`
        : "";
    if (be >= 0) {
        return {
            tone: "neutra",
            title: `Faltam ${formatDuration(TROCA_MINUTOS - be)} para você poder trocar por 1 plantão extra.`,
            detail: `A troca abre quando o saldo chega a +12h.${dividaAntiga}`,
            showAction: false,
            actionLabel: null,
        };
    }
    return {
        tone: "neutra",
        title: `Faltam ${formatDuration(-params.saldoMinutes)} para zerar seu saldo.`,
        detail: isStatutory
            ? "O atraso que passa do zero é descontado na folha de ponto."
            : `Se o saldo passar de −12h, um plantão do mês pode ser retirado da folha.${dividaAntiga}`,
        showAction: false,
        actionLabel: null,
    };
}

// ---------- modelo completo ----------

export function buildDoctorBankHoursView(params: {
    doctor: BankHoursDoctorHistory;
    bonusEligibleMinutes: number;
    penaltyEligibleMinutes: number;
    competenciaAberta: boolean;
    /** Mês da página (AAAA-MM): abre por padrão e é o mês da frase da folha. */
    monthKey: string;
    now: Date;
}): DoctorBankHoursView {
    const { doctor, now } = params;
    const isStatutory = doctor.employmentType === "estatutario";
    const legacyOld = doctor.legacy?.preMay2025Minutes ?? 0;
    const legacyPeriod = doctor.legacy?.spreadsheetPeriodMinutes ?? 0;
    // PJ: crédito anterior a mai/2025 não paga nada (fora da régua) e sai da
    // visão para não inflar expectativa. Dívida antiga continua na conta. No
    // estatutário ele entra na régua do extra, então fica.
    const hiddenOldCreditMinutes = isStatutory ? 0 : Math.max(legacyOld, 0);
    const saldoMinutes = doctor.balanceMinutes - hiddenOldCreditMinutes;

    // Estatutário: o que passa do zero vai à folha e nunca entra no banco.
    const payrollByMonth = new Map<string, number>();
    if (isStatutory) {
        const ledger = resolvePayrollLedger({
            legacyMinutes: doctor.legacy?.totalMinutes ?? 0,
            shifts: doctor.shifts,
            settlements: doctor.settlements,
            throughMonthKey: params.monthKey,
        });
        for (const month of ledger.months) payrollByMonth.set(month.monthKey, month.payrollMinutes);
    }
    // Settlements "payroll" ficam fora do razão do estatutário (a cascata já cuida).
    const countedSettlements = doctor.settlements.filter((s) => !(isStatutory && s.kind === "payroll"));
    const settlementsByMonth = buildSettlementViews(countedSettlements);

    const shiftViews = doctor.shifts
        .slice()
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .map((shift) => buildShiftView(shift, now));

    // ---- conta ----
    const alem = shiftViews.reduce((t, s) => t + s.creditedMinutes, 0);
    const nAlem = shiftViews.filter((s) => s.creditedMinutes > 0).length;
    const atraso = -shiftViews.reduce((t, s) => t + s.delayMinutes, 0);
    const nAtraso = shiftViews.filter((s) => s.delayMinutes > 0).length;
    const somaKind = (kind: string) => countedSettlements.filter((s) => s.kind === kind).reduce((t, s) => t + s.deltaMinutes, 0);
    const contaKind = (kind: string) => countedSettlements.filter((s) => s.kind === kind && !s.notes.startsWith(REVERSAL_PREFIX)).length;
    const payrollTotal = Array.from(payrollByMonth.values()).reduce((t, m) => t + m, 0);
    const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

    const composition: DoctorCompositionTerm[] = [];
    const add = (term: DoctorCompositionTerm) => { if (term.minutes !== 0) composition.push(term); };
    if (isStatutory) {
        add({ key: "antigo", label: "Saldo até abr/2025", detail: "planilha da coordenação", minutes: legacyOld, filter: null });
    } else if (legacyOld < 0) {
        add({ key: "antigo", label: "Dívida até abr/2025", detail: "planilha da coordenação", minutes: legacyOld, filter: null });
    }
    add({ key: "planilha", label: "Saldo de mai/2025 a mai/2026", detail: "planilha da coordenação", minutes: legacyPeriod, filter: null });
    add({ key: "alem", label: "Tempo além do horário", detail: `${plural(nAlem, "plantão", "plantões")} · toque para ver`, minutes: alem, filter: "alem" });
    add({ key: "atraso", label: "Atrasos", detail: `${plural(nAtraso, "plantão", "plantões")} · toque para ver`, minutes: atraso, filter: "atraso" });
    add({ key: "trocas", label: "Trocas por plantão extra", detail: plural(contaKind("bonus"), "plantão extra", "plantões extra"), minutes: somaKind("bonus"), filter: null });
    add({ key: "retiradas", label: "Plantões retirados da folha", detail: plural(contaKind("penalty"), "plantão", "plantões"), minutes: somaKind("penalty"), filter: null });
    add({ key: "folha-acerto", label: "Atraso abatido na folha", detail: "lançado pela coordenação", minutes: somaKind("payroll"), filter: null });
    add({ key: "folha", label: "Atraso descontado na folha", detail: "o que passou do zero não fica no banco", minutes: payrollTotal, filter: null });
    const explicado = composition.reduce((t, term) => t + term.minutes, 0);
    add({ key: "ajustes", label: "Ajustes da coordenação", detail: "correções e revisões de plantões", minutes: saldoMinutes - explicado, filter: null });

    // ---- meses ----
    const monthKeys = new Set<string>([
        ...shiftViews.map((s) => s.monthKey),
        ...settlementsByMonth.keys(),
        ...Array.from(payrollByMonth.entries()).filter(([, m]) => m > 0).map(([k]) => k),
    ]);
    const ordered = Array.from(monthKeys).sort();
    const monthsAsc: DoctorMonthView[] = ordered.map((monthKey) => {
        const inMonth = shiftViews.filter((s) => s.monthKey === monthKey);
        const settlements = settlementsByMonth.get(monthKey) ?? [];
        const payroll = payrollByMonth.get(monthKey) ?? 0;
        const moved = inMonth.reduce((t, s) => t + s.balanceMinutes, 0)
            + settlements.reduce((t, s) => t + s.deltaMinutes, 0)
            + payroll;
        return {
            monthKey,
            label: formatMonthLabel(monthKey),
            shiftCount: inMonth.length,
            delayCount: inMonth.filter((s) => s.delayMinutes > 0).length,
            extraCount: inMonth.filter((s) => s.creditedMinutes > 0).length,
            movedMinutes: moved,
            closingMinutes: 0,
            payrollMinutes: payroll,
            shifts: inMonth.filter((s) => s.relevant).map(({ relevant: _r, monthKey: _m, ...view }) => view),
            quietDays: inMonth.filter((s) => !s.relevant).map((s) => s.dayLabel.slice(0, 2)),
            settlements,
        };
    });
    // Saldo ao fim de cada mês, de trás para frente a partir do saldo mostrado:
    // assim o último mês sempre bate com o número grande do topo.
    let running = saldoMinutes;
    for (let i = monthsAsc.length - 1; i >= 0; i--) {
        monthsAsc[i].closingMinutes = running;
        running -= monthsAsc[i].movedMinutes;
    }
    const months = monthsAsc.reverse();

    const headline = buildHeadline({
        isStatutory,
        saldoMinutes,
        bonusEligibleMinutes: params.bonusEligibleMinutes,
        penaltyEligibleMinutes: params.penaltyEligibleMinutes,
        oldDebtMinutes: legacyOld,
        competenciaAberta: params.competenciaAberta,
        payrollThisMonthMinutes: payrollByMonth.get(params.monthKey) ?? 0,
        monthLabel: formatMonthLabel(params.monthKey).split(" ")[0],
    });

    return {
        isStatutory,
        saldoMinutes,
        hiddenOldCreditMinutes,
        headline,
        composition,
        months,
        defaultOpenMonthKey: months.some((m) => m.monthKey === params.monthKey)
            ? params.monthKey
            : (months[0]?.monthKey ?? null),
    };
}
