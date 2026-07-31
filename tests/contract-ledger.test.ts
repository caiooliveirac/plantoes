import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    closingSourceKey,
    planLedgerSync,
    type LiveLedgerState,
} from "@/services/contract-ledger.service";

const EMPTY: LiveLedgerState = { amountCents: 0, weekdayShifts: 0, weekendShifts: 0, nextRevision: 0 };

/** Um mês de R$ 24.878,60 com 11,5 plantões de semana e 6 de fim de semana. */
const MES = { amountCents: 2487860, weekdayShifts: 11.5, weekendShifts: 6 };

/** Estado do razão depois que esse mês foi lançado (consumo entra negativo). */
const LANCADO: LiveLedgerState = {
    amountCents: -2487860,
    weekdayShifts: 11.5,
    weekendShifts: 6,
    nextRevision: 1,
};

describe("planLedgerSync — primeiro lançamento", () => {
    const plan = planLedgerSync({ live: EMPTY, current: MES, attested: true });

    it("lança o consumo com sinal negativo", () => {
        assert.equal(plan.shouldWrite, true);
        assert.equal(plan.deltaCents, -2487860);
        assert.equal(plan.entryType, "invoice");
        assert.equal(plan.outcome, "lancado");
        assert.equal(plan.revision, 0);
    });

    it("leva os plantões decompostos", () => {
        assert.equal(plan.deltaWeekdayShifts, 11.5);
        assert.equal(plan.deltaWeekendShifts, 6);
    });
});

describe("planLedgerSync — idempotência", () => {
    it("não escreve nada quando o mês não mudou", () => {
        const plan = planLedgerSync({ live: LANCADO, current: MES, attested: true });
        assert.equal(plan.shouldWrite, false);
        assert.equal(plan.outcome, "sem_alteracao");
        assert.equal(plan.deltaCents, 0);
    });

    it("continua sem escrever depois de várias passadas da varredura", () => {
        for (let round = 0; round < 5; round++) {
            assert.equal(planLedgerSync({ live: LANCADO, current: MES, attested: true }).shouldWrite, false);
        }
    });
});

describe("planLedgerSync — o admin mexe no valor depois de atestar", () => {
    it("admin adiciona um plantão extra: lança só a diferença, como consumo", () => {
        const plan = planLedgerSync({
            live: LANCADO,
            current: { amountCents: 2487860 + 138110, weekdayShifts: 11.5, weekendShifts: 7 },
            attested: true,
        });
        assert.equal(plan.deltaCents, -138110);
        assert.equal(plan.deltaWeekendShifts, 1);
        assert.equal(plan.deltaWeekdayShifts, 0);
        assert.equal(plan.entryType, "invoice");
        assert.equal(plan.outcome, "reajustado");
        assert.equal(plan.revision, 1);
    });

    it("admin remove um plantão: devolve saldo, e o tipo vira estorno", () => {
        const plan = planLedgerSync({
            live: LANCADO,
            current: { amountCents: 2487860 - 124487, weekdayShifts: 10.5, weekendShifts: 6 },
            attested: true,
        });
        assert.equal(plan.deltaCents, 124487);
        assert.equal(plan.deltaWeekdayShifts, -1);
        assert.equal(plan.entryType, "invoice_reversal");
        assert.equal(plan.outcome, "reajustado");
    });

    it("meio plantão a mais anda de 0,5 em 0,5", () => {
        const plan = planLedgerSync({
            live: LANCADO,
            current: { amountCents: 2487860 + 62244, weekdayShifts: 12, weekendShifts: 6 },
            attested: true,
        });
        assert.equal(plan.deltaWeekdayShifts, 0.5);
    });

    it("cada reajuste consome a próxima revisão — o unique do banco não colide", () => {
        const primeiro = planLedgerSync({ live: LANCADO, current: { ...MES, amountCents: 2500000 }, attested: true });
        const segundo = planLedgerSync({
            live: { ...LANCADO, nextRevision: 2 },
            current: { ...MES, amountCents: 2600000 },
            attested: true,
        });
        assert.equal(primeiro.revision, 1);
        assert.equal(segundo.revision, 2);
    });
});

describe("planLedgerSync — atestação desfeita", () => {
    const plan = planLedgerSync({ live: LANCADO, current: MES, attested: false });

    it("devolve o valor inteiro ao saldo", () => {
        assert.equal(plan.deltaCents, 2487860);
        assert.equal(plan.entryType, "invoice_reversal");
        assert.equal(plan.outcome, "estornado");
    });

    it("devolve os plantões NEGATIVOS — senão a view conta duas vezes", () => {
        assert.equal(plan.deltaWeekdayShifts, -11.5);
        assert.equal(plan.deltaWeekendShifts, -6);
    });

    it("zera de verdade: somar o lançado com o estorno dá zero", () => {
        assert.equal(LANCADO.amountCents + plan.deltaCents, 0);
        assert.equal(LANCADO.weekdayShifts + plan.deltaWeekdayShifts, 0);
        assert.equal(LANCADO.weekendShifts + plan.deltaWeekendShifts, 0);
    });

    it("desassinar duas vezes não escreve de novo", () => {
        const zerado: LiveLedgerState = { amountCents: 0, weekdayShifts: 0, weekendShifts: 0, nextRevision: 2 };
        assert.equal(planLedgerSync({ live: zerado, current: MES, attested: false }).shouldWrite, false);
    });
});

describe("planLedgerSync — reatestar depois de desassinar", () => {
    it("lança o valor de novo, na revisão seguinte", () => {
        const zerado: LiveLedgerState = { amountCents: 0, weekdayShifts: 0, weekendShifts: 0, nextRevision: 2 };
        const plan = planLedgerSync({ live: zerado, current: MES, attested: true });
        assert.equal(plan.deltaCents, -2487860);
        assert.equal(plan.revision, 2);
        assert.equal(plan.outcome, "reajustado");
    });
});

describe("planLedgerSync — bordas", () => {
    it("mês sem nada a pagar não escreve lançamento", () => {
        const plan = planLedgerSync({
            live: EMPTY,
            current: { amountCents: 0, weekdayShifts: 0, weekendShifts: 0 },
            attested: true,
        });
        assert.equal(plan.shouldWrite, false);
    });

    it("plantão vermelho pode deixar o mês negativo — vira crédito de saldo", () => {
        const plan = planLedgerSync({
            live: EMPTY,
            current: { amountCents: -124487, weekdayShifts: -1, weekendShifts: 0 },
            attested: true,
        });
        assert.equal(plan.deltaCents, 124487);
        assert.equal(plan.entryType, "invoice_reversal");
    });
});

describe("closingSourceKey", () => {
    it("é estável: a atestação some ao desassinar, a chave não", () => {
        assert.equal(closingSourceKey("abc", "2026-06"), "abc|2026-06");
    });
});
