/**
 * Classificação das pendências que a tela de fechamento antecipa. O que não pode
 * quebrar em silêncio: razão vazio não pode ser lido como contrato estourado, e
 * teto ausente não pode ser lido como zero (docs/saldo-contrato/README.md).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    resolveDoctorPendencies,
    type PendencyContractInput,
    type PendencyDoctorInput,
} from "@/modules/reporting/payment-closing-pendencies";

function contrato(overrides: Partial<PendencyContractInput> = {}): PendencyContractInput {
    return {
        cycleEnd: "2027-01-23",
        ceilingCents: 16_573_200,
        balanceCents: 2_103_670,
        paceIndex: 1,
        awaitingOpeningBalance: false,
        ...overrides,
    };
}

function medico(overrides: Partial<PendencyDoctorInput> = {}): PendencyDoctorInput {
    return { contractBalances: [contrato()], ...overrides };
}

describe("pendências do fechamento", () => {
    it("médico em dia não gera pendência", () => {
        assert.deepEqual(resolveDoctorPendencies(medico()), []);
    });

    it("banco de horas só aciona no gatilho de ±12h", () => {
        assert.deepEqual(resolveDoctorPendencies(medico({ bankHoursRecentMinutes: 719 })), []);
        assert.deepEqual(resolveDoctorPendencies(medico({ bankHoursRecentMinutes: 720 })), ["bank_bonus"]);
        assert.deepEqual(resolveDoctorPendencies(medico({ bankHoursRecentMinutes: -720 })), ["bank_penalty"]);
    });

    it("dívida anterior a mai/2025 amortiza antes de virar bônus", () => {
        const pendencias = resolveDoctorPendencies(medico({ bankHoursOldMinutes: -400, bankHoursRecentMinutes: 800 }));
        assert.deepEqual(pendencias, []);
    });

    it("razão vazio é falta de lançamento, nunca saldo estourado", () => {
        const pendencias = resolveDoctorPendencies(medico({
            contractBalances: [contrato({ balanceCents: 0, awaitingOpeningBalance: true })],
            contractPendingRenewal: { kind: "sem_saldo_de_abertura" },
        }));
        assert.deepEqual(pendencias, ["contract_missing"]);
    });

    it("saldo zerado com razão preenchido é contrato estourado", () => {
        assert.deepEqual(
            resolveDoctorPendencies(medico({ contractBalances: [contrato({ balanceCents: -1_000 })] })),
            ["contract_depleted"],
        );
    });

    it("teto ausente pede lançamento mesmo sem renovação vencida", () => {
        assert.deepEqual(
            resolveDoctorPendencies(medico({ contractBalances: [contrato({ ceilingCents: null, paceIndex: null })] })),
            ["contract_missing"],
        );
    });

    it("teto ausente olha o contrato mais recente, não o velho", () => {
        const pendencias = resolveDoctorPendencies(medico({
            contractBalances: [
                contrato({ cycleEnd: "2026-01-23", ceilingCents: null, paceIndex: null }),
                contrato({ cycleEnd: "2027-01-23" }),
            ],
        }));
        assert.deepEqual(pendencias, []);
    });

    it("novato sem nenhum contrato pede lançamento", () => {
        assert.deepEqual(resolveDoctorPendencies({ contractBalances: [] }), ["contract_missing"]);
    });

    it("renovação vencida pede lançamento", () => {
        assert.deepEqual(
            resolveDoctorPendencies(medico({ contractPendingRenewal: { kind: "vencido" } })),
            ["contract_missing"],
        );
    });

    it("acima do ritmo só conta com saldo restante", () => {
        assert.deepEqual(
            resolveDoctorPendencies(medico({ contractBalances: [contrato({ paceIndex: 1.2 })] })),
            ["contract_pace"],
        );
        assert.deepEqual(
            resolveDoctorPendencies(medico({ contractBalances: [contrato({ paceIndex: 1.2, balanceCents: 0 })] })),
            ["contract_depleted"],
        );
    });

    it("banco e contrato acumulam no mesmo médico", () => {
        const pendencias = resolveDoctorPendencies(medico({
            bankHoursRecentMinutes: 900,
            contractBalances: [contrato({ paceIndex: 1.5 })],
        }));
        assert.deepEqual(pendencias, ["bank_bonus", "contract_pace"]);
    });
});
