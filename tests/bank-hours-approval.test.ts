import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    resolveBankHoursApproval,
    type BankHoursApprovalInput,
} from "@/modules/reporting/bank-hours-approval";

function entrada(overrides: Partial<BankHoursApprovalInput> = {}): BankHoursApprovalInput {
    return {
        creditedOvertimeMinutes: 90,
        actualEndedAt: "2026-07-10T22:30:00Z",
        handoffEndedAt: "2026-07-10T21:00:00Z",
        departureConfirmedAt: null,
        departureConfirmedByName: null,
        departureConfirmedNote: null,
        lateDeparture: { reasonCode: "occurrence", occurrenceNumber: "123456" },
        chiefOnDutyAtDeparture: "Dra. Fulana",
        corrections: [],
        departureReducedByCorrection: false,
        overtimeMinutes: 90,
        ruleCode: "LATE_SIMPLE_OVERTIME",
        ...overrides,
    };
}

describe("resolveBankHoursApproval — sem pendência", () => {
    it("saiu no horário e sem crédito: não há o que validar", () => {
        const r = resolveBankHoursApproval(entrada({
            creditedOvertimeMinutes: 0,
            lateDeparture: null,
            actualEndedAt: "2026-07-10T21:00:00Z",
        }));
        assert.equal(r.state, "sem_pendencia");
        assert.equal(r.tone, "neutral");
    });

    it("saiu ANTES do previsto também é sem pendência", () => {
        const r = resolveBankHoursApproval(entrada({
            creditedOvertimeMinutes: 0,
            lateDeparture: null,
            actualEndedAt: "2026-07-10T20:00:00Z",
        }));
        assert.equal(r.state, "sem_pendencia");
    });
});

describe("resolveBankHoursApproval — aguardando a chefia", () => {
    const r = resolveBankHoursApproval(entrada());

    it("saída tardia sem confirmação fica pendente", () => {
        assert.equal(r.state, "aguardando_chefia");
        assert.equal(r.tone, "pending");
    });

    it("nomeia quem estava na 2031 no horário da saída", () => {
        assert.equal(r.chiefName, "Dra. Fulana");
        assert.match(r.detail, /Dra\. Fulana/);
        assert.match(r.detail, /2031/);
    });

    it("diz claramente quando não dá para identificar a chefia", () => {
        const semChefe = resolveBankHoursApproval(entrada({ chiefOnDutyAtDeparture: null }));
        assert.equal(semChefe.chiefName, null);
        assert.match(semChefe.detail, /não foi possível identificar/i);
    });

    it("crédito zero mas com justificativa registrada ainda é pendência", () => {
        const r2 = resolveBankHoursApproval(entrada({ creditedOvertimeMinutes: 0 }));
        assert.equal(r2.state, "aguardando_chefia");
    });

    it("sem justificativa registrada, a saída depois do previsto ainda conta", () => {
        const r2 = resolveBankHoursApproval(entrada({
            creditedOvertimeMinutes: 0,
            lateDeparture: null,
        }));
        assert.equal(r2.state, "aguardando_chefia");
    });
});

describe("resolveBankHoursApproval — validado", () => {
    const r = resolveBankHoursApproval(entrada({
        departureConfirmedAt: "2026-07-11T09:00:00Z",
        departureConfirmedByName: "chefe@samu.local",
        departureConfirmedNote: "conferido no espelho da ocorrência",
    }));

    it("confirmação da chefia vence tudo", () => {
        assert.equal(r.state, "validado");
        assert.equal(r.tone, "ok");
        assert.equal(r.chiefName, "chefe@samu.local");
        assert.equal(r.note, "conferido no espelho da ocorrência");
    });

    it("cita a razão declarada com o número da ocorrência", () => {
        assert.match(r.detail, /ocorrência 123456/);
    });

    it("confirmado vence até correção que reduziu o horário", () => {
        const r2 = resolveBankHoursApproval(entrada({
            departureConfirmedAt: "2026-07-11T09:00:00Z",
            departureReducedByCorrection: true,
        }));
        assert.equal(r2.state, "validado");
    });
});

describe("resolveBankHoursApproval — recusa na prática", () => {
    const r = resolveBankHoursApproval(entrada({
        departureReducedByCorrection: true,
        corrections: [
            { chiefOnDutyName: "Dr. Antigo", createdAt: "2026-07-11T08:00:00Z", undone: true },
            { chiefOnDutyName: "Dr. Recente", createdAt: "2026-07-11T10:00:00Z", undone: false },
        ],
    }));

    it("correção que encurtou a saída aparece como horário corrigido", () => {
        assert.equal(r.state, "corrigido_pela_chefia");
        assert.equal(r.tone, "warn");
    });

    it("usa a última correção NÃO desfeita para nomear a chefia", () => {
        assert.equal(r.chiefName, "Dr. Recente");
        assert.equal(r.at, "2026-07-11T10:00:00Z");
    });

    it("caindo para a chefia da saída quando todas as correções foram desfeitas", () => {
        const r2 = resolveBankHoursApproval(entrada({
            departureReducedByCorrection: true,
            corrections: [{ chiefOnDutyName: "Dr. Antigo", createdAt: "2026-07-11T08:00:00Z", undone: true }],
        }));
        assert.equal(r2.chiefName, "Dra. Fulana");
    });
});

describe("resolveBankHoursApproval — crédito retido por anomalia", () => {
    // O caso mais comum de "meu bônus não entrou": a chefia até confirmou a
    // saída, mas a regra de anomalia zerou o crédito à espera de revisão.
    const r = resolveBankHoursApproval(entrada({
        overtimeMinutes: 600,
        creditedOvertimeMinutes: 0,
        ruleCode: "ANOMALY_EXCESSIVE_OVERTIME",
        departureConfirmedAt: "2026-07-11T09:00:00Z",
        departureConfirmedByName: "chefe@samu.local",
    }));

    it("vence o 'validado' — confirmar saída não é liberar crédito", () => {
        assert.equal(r.state, "credito_retido_para_revisao");
        assert.equal(r.tone, "warn");
    });

    it("deixa claro que está parado, não recusado", () => {
        assert.match(r.detail, /não foi recusado/i);
    });

    it("crédito zerado sem anomalia não cai nesse estado", () => {
        const r2 = resolveBankHoursApproval(entrada({
            overtimeMinutes: 600,
            creditedOvertimeMinutes: 0,
            ruleCode: "LATE_NO_OVERTIME",
            departureConfirmedAt: "2026-07-11T09:00:00Z",
        }));
        assert.equal(r2.state, "validado");
    });

    it("anomalia com crédito concedido também não", () => {
        const r2 = resolveBankHoursApproval(entrada({
            overtimeMinutes: 600,
            creditedOvertimeMinutes: 600,
            ruleCode: "ANOMALY_EXCESSIVE_OVERTIME",
            departureConfirmedAt: "2026-07-11T09:00:00Z",
        }));
        assert.equal(r2.state, "validado");
    });
});

describe("resolveBankHoursApproval — ocorrência sem número", () => {
    const r = resolveBankHoursApproval(entrada({
        lateDeparture: { reasonCode: "occurrence", occurrenceNumber: null },
    }));

    it("é destacado separadamente do simples 'aguardando'", () => {
        assert.equal(r.state, "ocorrencia_nao_informada");
        assert.equal(r.tone, "warn");
    });

    it("explica que sem o número a chefia não tem como conferir", () => {
        assert.match(r.detail, /não passou o número/i);
    });

    it("outras razões sem número não caem nesse estado", () => {
        const r2 = resolveBankHoursApproval(entrada({
            lateDeparture: { reasonCode: "hygienization", occurrenceNumber: null },
        }));
        assert.equal(r2.state, "aguardando_chefia");
    });
});
