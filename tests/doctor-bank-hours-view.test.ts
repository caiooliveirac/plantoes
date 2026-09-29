import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    buildDoctorBankHoursView,
    resolveDoctorShiftValidation,
} from "@/modules/reporting/doctor-bank-hours-view";
import type {
    BankHoursApproval,
    BankHoursDoctorHistory,
    BankHoursHistoryShift,
    BankHoursSettlementSummary,
} from "@/modules/reporting/bank-hours-history";

const SEM_PENDENCIA: BankHoursApproval = {
    state: "sem_pendencia", tone: "neutral", label: "Sem pendência", detail: "", chiefName: null, at: null, note: null,
};
const AGUARDANDO: BankHoursApproval = {
    state: "aguardando_chefia", tone: "pending", label: "Aguardando a chefia", detail: "", chiefName: "Rodrigo", at: null, note: null,
};

// SN de 12/09/2026: 19:00–07:00 em São Paulo = 22:00Z–10:00Z.
function plantao(overrides: Partial<BankHoursHistoryShift> = {}): BankHoursHistoryShift {
    return {
        occupancyId: "occ-1",
        domain: "regulation",
        monthKey: "2026-09",
        shiftLabel: "SN",
        targetCode: "2266",
        targetLabel: "2266",
        source: "telegram",
        startedAt: "2026-09-12T22:22:00Z",
        countedStartAt: "2026-09-12T22:22:00Z",
        bankScheduledStartAt: "2026-09-12T22:00:00Z",
        bankScheduledEndAt: "2026-09-13T10:00:00Z",
        actualEndedAt: "2026-09-13T10:05:00Z",
        countedEndAt: "2026-09-13T10:05:00Z",
        arrivalDelayMinutes: 22,
        overtimeMinutes: 0,
        creditedOvertimeMinutes: 0,
        balanceMinutes: -22,
        ruleCode: "LATE_ARRIVAL",
        manualBalanceMinutes: null,
        successorDoctorName: null,
        successorTookOverAt: null,
        lateDeparture: null,
        approval: SEM_PENDENCIA,
        ...overrides,
    } as unknown as BankHoursHistoryShift;
}

// Saiu 07:40 dizendo que estava em ocorrência; sem validação o banco contou até 07:00.
function saidaNaoValidada(overrides: Partial<BankHoursHistoryShift> = {}) {
    return plantao({
        startedAt: "2026-09-12T22:00:00Z",
        countedStartAt: "2026-09-12T22:00:00Z",
        actualEndedAt: "2026-09-13T10:40:00Z",
        countedEndAt: "2026-09-13T10:00:00Z",
        arrivalDelayMinutes: 0,
        balanceMinutes: 0,
        lateDeparture: { reasonCode: "occurrence", occurrenceNumber: "123" },
        approval: AGUARDANDO,
        ...overrides,
    } as Partial<BankHoursHistoryShift>);
}

function medico(overrides: Partial<BankHoursDoctorHistory> = {}): BankHoursDoctorHistory {
    return {
        doctorId: "d1",
        doctorName: "Mariana Teixeira",
        displayName: null,
        employmentType: "pj",
        balanceMinutes: 0,
        applicationBalanceMinutes: 0,
        legacy: null,
        shifts: [],
        settlements: [],
        ...overrides,
    } as unknown as BankHoursDoctorHistory;
}

function acerto(overrides: Partial<BankHoursSettlementSummary>): BankHoursSettlementSummary {
    return {
        id: "s1",
        monthKey: "2026-09",
        kind: "bonus",
        deltaMinutes: -720,
        operationalDate: "2026-09-20",
        notes: "plantão extra declarado (autoatendimento, 2026-09-20 SD)",
        createdAt: "2026-09-20T12:00:00Z",
        ...overrides,
    };
}

const DEPOIS_DE_12H = new Date("2026-09-14T12:00:00Z");
const ANTES_DE_12H = new Date("2026-09-13T12:00:00Z");

describe("validação da saída — no passado depois de 12h", () => {
    it("ramal: a chefia não validou essa saída com bônus", () => {
        const v = resolveDoctorShiftValidation(saidaNaoValidada(), DEPOIS_DE_12H)!;
        assert.equal(v.tone, "warn");
        assert.equal(v.chip, "saída não validada");
        assert.match(v.sentence, /^A chefia era Rodrigo e não validou essa saída com bônus\. O banco contou até 07:00\.$/);
    });

    it("base: a chefia não aprovou esse bônus", () => {
        const v = resolveDoctorShiftValidation(saidaNaoValidada({ domain: "intervention" }), DEPOIS_DE_12H)!;
        assert.match(v.sentence, /^A chefia era Rodrigo e não aprovou esse bônus\./);
    });

    it("rendido: quem assumiu e que a chefia não validou a ocorrência", () => {
        const v = resolveDoctorShiftValidation(saidaNaoValidada({
            successorDoctorName: "Paulo",
            successorTookOverAt: "2026-09-13T10:00:00Z",
        }), DEPOIS_DE_12H)!;
        assert.match(v.sentence, /^Paulo assumiu seu posto às 07:00, e a chefia \(Rodrigo\) não validou que você estava em ocorrência\./);
    });

    it("sem nome na 2031: fala da chefia de plantão", () => {
        const v = resolveDoctorShiftValidation(saidaNaoValidada({ approval: { ...AGUARDANDO, chiefName: null } }), DEPOIS_DE_12H)!;
        assert.match(v.sentence, /^A chefia de plantão não validou essa saída com bônus\./);
    });

    it("dentro das 12h: ainda pode validar, sem 'aguardando'", () => {
        const v = resolveDoctorShiftValidation(saidaNaoValidada(), ANTES_DE_12H)!;
        assert.equal(v.tone, "neutral");
        assert.match(v.sentence, /pode validar essa saída até 13\/set às 19:40/);
        assert.doesNotMatch(v.sentence, /aguardando|esperando/i);
    });

    it("validada pela chefia vira a saída que vale", () => {
        const v = resolveDoctorShiftValidation(saidaNaoValidada({
            approval: { ...AGUARDANDO, state: "validado", tone: "ok", label: "Validado pela chefia" },
        }), DEPOIS_DE_12H)!;
        assert.equal(v.finalLabel, "Validada pela chefia");
        assert.equal(v.chip, null);
    });

    it("saiu no horário: nada a validar", () => {
        assert.equal(resolveDoctorShiftValidation(plantao(), DEPOIS_DE_12H), null);
    });
});

describe("linha do plantão", () => {
    it("mostra o que o médico fez em texto: chegou e saiu", () => {
        const view = buildDoctorBankHoursView({
            doctor: medico({ shifts: [plantao()], balanceMinutes: -22, applicationBalanceMinutes: -22 }),
            bonusEligibleMinutes: -22,
            penaltyEligibleMinutes: -22,
            competenciaAberta: true,
            monthKey: "2026-09",
            now: DEPOIS_DE_12H,
        });
        const linha = view.months[0].shifts[0];
        assert.equal(linha.summary, "chegou 19:22 · saiu 07:05");
        assert.equal(linha.declaredExitLabel, "Saída que você avisou ao bot");
        assert.equal(linha.dayLabel, "12/set");
    });

    it("plantão sem nada vira dia 'sem alteração'", () => {
        const view = buildDoctorBankHoursView({
            doctor: medico({ shifts: [plantao({ arrivalDelayMinutes: 0, balanceMinutes: 0, countedStartAt: "2026-09-12T22:00:00Z", startedAt: "2026-09-12T22:00:00Z", actualEndedAt: "2026-09-13T10:00:00Z", countedEndAt: "2026-09-13T10:00:00Z" })] }),
            bonusEligibleMinutes: 0,
            penaltyEligibleMinutes: 0,
            competenciaAberta: true,
            monthKey: "2026-09",
            now: DEPOIS_DE_12H,
        });
        assert.equal(view.months[0].shifts.length, 0);
        assert.deepEqual(view.months[0].quietDays, ["12"]);
    });
});

describe("conta do saldo", () => {
    it("PJ: parcelas somam o saldo mostrado; crédito antigo fica fora", () => {
        const shifts = [
            plantao(),
            plantao({ occupancyId: "occ-2", arrivalDelayMinutes: 0, overtimeMinutes: 90, creditedOvertimeMinutes: 180, balanceMinutes: 180 }),
            // ajuste manual da coordenação: vai para "ajustes"
            plantao({ occupancyId: "occ-3", arrivalDelayMinutes: 0, balanceMinutes: 60, manualBalanceMinutes: 60 }),
        ];
        const settlements = [
            acerto({ id: "b1" }),
            acerto({ id: "b1r", deltaMinutes: 720, notes: "reversal:b1 — lançado errado" }),
        ];
        // 600 antigo (oculto) + 300 planilha + (−22 + 180 + 60) + (−720 + 720)
        const doctor = medico({
            employmentType: "pj",
            legacy: { preMay2025Minutes: 600, spreadsheetPeriodMinutes: 300, totalMinutes: 900 } as BankHoursDoctorHistory["legacy"],
            balanceMinutes: 1118,
            applicationBalanceMinutes: 218,
            shifts,
            settlements,
        });
        const view = buildDoctorBankHoursView({
            doctor, bonusEligibleMinutes: 518, penaltyEligibleMinutes: 518, competenciaAberta: true, monthKey: "2026-09", now: DEPOIS_DE_12H,
        });
        assert.equal(view.saldoMinutes, 518);
        assert.equal(view.hiddenOldCreditMinutes, 600);
        const soma = view.composition.reduce((t, term) => t + term.minutes, 0);
        assert.equal(soma, view.saldoMinutes);
        assert.ok(view.composition.some((term) => term.key === "ajustes" && term.minutes === 60));
        assert.equal(view.months[0].closingMinutes, view.saldoMinutes);
        const [original, estorno] = view.months[0].settlements;
        assert.equal(original.reversed, true);
        assert.match(estorno.text, /^Estorno: plantão extra no dia 20$/);
        assert.match(view.headline.title, /^Faltam 3h22 para você poder trocar/);
    });

    it("PJ com dívida até abr/2025: régua só com o saldo de mai/2025 em diante", () => {
        // −5h antes de mai/2025, +10h depois: saldo +5h, régua +10h, troca a 7h.
        const view = buildDoctorBankHoursView({
            doctor: medico({
                legacy: { preMay2025Minutes: -300, spreadsheetPeriodMinutes: 600, totalMinutes: 300 } as BankHoursDoctorHistory["legacy"],
                balanceMinutes: 300,
            }),
            bonusEligibleMinutes: 300, penaltyEligibleMinutes: 600, competenciaAberta: true, monthKey: "2026-09", now: DEPOIS_DE_12H,
        });
        // Saldo grande, régua e conta: só de mai/2025 em diante (+10h).
        assert.equal(view.saldoMinutes, 600);
        assert.equal(view.reguaMinutes, 600);
        assert.equal(view.oldDebtMinutes, -300);
        assert.ok(!view.composition.some((term) => term.key === "antigo"));
        assert.equal(view.composition.reduce((t, term) => t + term.minutes, 0), 600);
        // A troca ainda amortiza a dívida antes: faltam 7h, e a frase diz por quê.
        assert.equal(view.headline.title, "Faltam 7h para você poder trocar por 1 plantão extra.");
        assert.match(view.headline.detail, /descontada a dívida de 5h até 30\/04\/2025/);
    });

    it("PJ com dívida antiga maior que o saldo novo: falta quitar a dívida", () => {
        // −5h antes de mai/2025, +3h depois: saldo mostrado +3h, faltam 2h para quitar.
        const view = buildDoctorBankHoursView({
            doctor: medico({
                legacy: { preMay2025Minutes: -300, spreadsheetPeriodMinutes: 180, totalMinutes: -120 } as BankHoursDoctorHistory["legacy"],
                balanceMinutes: -120,
            }),
            bonusEligibleMinutes: -120, penaltyEligibleMinutes: 180, competenciaAberta: true, monthKey: "2026-09", now: DEPOIS_DE_12H,
        });
        assert.equal(view.saldoMinutes, 180);
        assert.equal(view.headline.title, "Faltam 2h para quitar a dívida até 30/04/2025.");
    });

    it("PJ com +12h elegível: pode trocar", () => {
        const view = buildDoctorBankHoursView({
            doctor: medico({ balanceMinutes: 800 }),
            bonusEligibleMinutes: 800, penaltyEligibleMinutes: 800, competenciaAberta: true, monthKey: "2026-09", now: DEPOIS_DE_12H,
        });
        assert.equal(view.headline.tone, "verde");
        assert.equal(view.headline.title, "Você pode trocar 12h por 1 plantão extra.");
        assert.equal(view.headline.showAction, true);
    });

    it("estatutário: o que passa do zero vai à folha e a conta fecha", () => {
        // +20 em agosto; em setembro −40 e −25: o banco cobre 20, 45 vão à folha.
        const shifts = [
            plantao({ occupancyId: "a1", monthKey: "2026-08", startedAt: "2026-08-19T10:00:00Z", arrivalDelayMinutes: 0, overtimeMinutes: 30, creditedOvertimeMinutes: 60, balanceMinutes: 60 }),
            plantao({ occupancyId: "a2", monthKey: "2026-08", startedAt: "2026-08-25T22:00:00Z", arrivalDelayMinutes: 40, balanceMinutes: -40 }),
            plantao({ occupancyId: "s1", monthKey: "2026-09", startedAt: "2026-09-11T10:00:00Z", arrivalDelayMinutes: 40, balanceMinutes: -40 }),
            plantao({ occupancyId: "s2", monthKey: "2026-09", startedAt: "2026-09-20T22:00:00Z", arrivalDelayMinutes: 25, balanceMinutes: -25 }),
        ];
        const view = buildDoctorBankHoursView({
            doctor: medico({ employmentType: "estatutario", shifts, balanceMinutes: 0, applicationBalanceMinutes: 0 }),
            bonusEligibleMinutes: 0, penaltyEligibleMinutes: -45, competenciaAberta: true, monthKey: "2026-09", now: DEPOIS_DE_12H,
        });
        assert.equal(view.saldoMinutes, 0);
        assert.equal(view.composition.reduce((t, term) => t + term.minutes, 0), 0);
        assert.equal(view.months[0].payrollMinutes, 45);
        assert.equal(view.headline.tone, "ambar");
        assert.match(view.headline.title, /^45min de atraso de setembro vão para a folha de ponto\.$/);
    });
});
