import assert from "node:assert/strict";
import test from "node:test";
import {
    isValidOverrideNote,
    triagePendingDeparture,
} from "@/modules/operational/departure-triage";

function iso(value: string) {
    return new Date(value).toISOString();
}

// Janela SD 07:00–19:00, horário de São Paulo.
const SD = {
    scheduledStartAt: iso("2026-08-03T07:00:00-03:00"),
    scheduledEndAt: iso("2026-08-03T19:00:00-03:00"),
};

test("saída antes de 6h de janela pede decisão (early_bank_only)", () => {
    const result = triagePendingDeparture({
        ...SD,
        startedAt: iso("2026-08-03T07:00:00-03:00"),
        actualEndedAt: iso("2026-08-03T12:00:00-03:00"),
        delayMinutes: -420,
    });
    assert.equal(result.kind, "early_bank_only");
    assert.equal(result.attention, true);
    assert.equal(result.classification?.outcome, "bank_only");
    assert.match(result.headline, /6h/);
});

test("saída na faixa 6h–10h pede decisão de MEIO plantão (early_half)", () => {
    // Chegou 09:00, saiu 17:00: 10h de janela decorridas (>=6h), faltam 2h...
    // faltam exatamente 120min => full_shift. Usa 16:00 (faltam 3h) para a faixa.
    const result = triagePendingDeparture({
        ...SD,
        startedAt: iso("2026-08-03T09:00:00-03:00"),
        actualEndedAt: iso("2026-08-03T16:00:00-03:00"),
        delayMinutes: -180,
    });
    assert.equal(result.kind, "early_half");
    assert.equal(result.attention, true);
    assert.equal(result.classification?.outcome, "half_shift");
    // 7h trabalhadas => excedente de 1h.
    assert.equal(result.classification?.bankCreditMinutes, 60);
});

test("saída tardia com bônus acima de 1h vira late_credit", () => {
    const result = triagePendingDeparture({
        ...SD,
        startedAt: iso("2026-08-03T07:00:00-03:00"),
        actualEndedAt: iso("2026-08-03T20:10:00-03:00"),
        delayMinutes: 70,
    });
    assert.equal(result.kind, "late_credit");
    assert.equal(result.attention, true);
});

test("bônus menor que 1h é rotina — confirma em lote, sem clique individual", () => {
    const result = triagePendingDeparture({
        ...SD,
        startedAt: iso("2026-08-03T07:00:00-03:00"),
        actualEndedAt: iso("2026-08-03T19:40:00-03:00"),
        delayMinutes: 40,
    });
    assert.equal(result.kind, "routine");
    assert.equal(result.attention, false);
});

test("rendido (reasonCode handoff) nunca entra na régua de MEIO+banco", () => {
    // Atrasou 1h e foi rendido 1h antes das 19h: 10h de janela — a régua diria
    // early_full, mas rendição é evento padrão.
    const result = triagePendingDeparture({
        ...SD,
        startedAt: iso("2026-08-03T08:00:00-03:00"),
        actualEndedAt: iso("2026-08-03T18:00:00-03:00"),
        delayMinutes: -60,
        reasonCode: "handoff",
    });
    assert.equal(result.kind, "routine");
    assert.equal(result.attention, false);
});

test("rendido na faixa de MEIO também fica silencioso", () => {
    const result = triagePendingDeparture({
        ...SD,
        startedAt: iso("2026-08-03T07:00:00-03:00"),
        actualEndedAt: iso("2026-08-03T15:00:00-03:00"),
        delayMinutes: -240,
        reasonCode: "handoff",
    });
    assert.equal(result.kind, "routine");
});

test("saída no horário exato é rotina", () => {
    const result = triagePendingDeparture({
        ...SD,
        startedAt: iso("2026-08-03T07:02:00-03:00"),
        actualEndedAt: iso("2026-08-03T19:00:00-03:00"),
        delayMinutes: 0,
    });
    assert.equal(result.kind, "routine");
});

test("saída faltando ≤2h (10h–12h de janela) pede decisão inteiro/MEIO (early_full)", () => {
    const result = triagePendingDeparture({
        ...SD,
        startedAt: iso("2026-08-03T07:00:00-03:00"),
        actualEndedAt: iso("2026-08-03T17:30:00-03:00"),
        delayMinutes: -90,
    });
    assert.equal(result.kind, "early_full");
    assert.equal(result.attention, true);
    assert.equal(result.classification?.outcome, "full_shift");
    assert.equal(result.classification?.remainingMinutes, 90);
});

test("saída até 15min antes do fim é rotina (não vira clique)", () => {
    const result = triagePendingDeparture({
        ...SD,
        startedAt: iso("2026-08-03T07:00:00-03:00"),
        actualEndedAt: iso("2026-08-03T18:50:00-03:00"),
        delayMinutes: -10,
    });
    assert.equal(result.kind, "routine");
    assert.equal(result.classification?.outcome, "full_shift");
});

test("saída minutos após a chegada é anomalia (caso Yngra), não saída a confirmar", () => {
    // Ocupação encerrada 17min depois da chegada por conflito de posto.
    const result = triagePendingDeparture({
        ...SD,
        startedAt: iso("2026-08-13T07:00:00-03:00"),
        actualEndedAt: iso("2026-08-13T07:17:00-03:00"),
        delayMinutes: -703,
    });
    assert.equal(result.kind, "short_anomaly");
    assert.equal(result.attention, true);
    assert.match(result.headline, /conflito|erro/i);
});

test("ocorrência sem número pede atenção mesmo com saída pontual", () => {
    const result = triagePendingDeparture({
        ...SD,
        startedAt: iso("2026-08-03T07:00:00-03:00"),
        actualEndedAt: iso("2026-08-03T19:05:00-03:00"),
        delayMinutes: 5,
        occurrenceNumberMissing: true,
    });
    assert.equal(result.kind, "occurrence_missing");
    assert.equal(result.attention, true);
});

test("repetição de justificativa (>=3 em 30 dias) pede atenção", () => {
    const result = triagePendingDeparture({
        ...SD,
        startedAt: iso("2026-08-03T07:00:00-03:00"),
        actualEndedAt: iso("2026-08-03T19:05:00-03:00"),
        delayMinutes: 5,
        reasonOccurrenceCount30d: 3,
    });
    assert.equal(result.kind, "pattern");
    assert.equal(result.attention, true);
});

test("meio plantão declarado na chegada não entra na régua de saída antecipada", () => {
    const result = triagePendingDeparture({
        scheduledStartAt: iso("2026-08-03T11:30:00-03:00"),
        scheduledEndAt: iso("2026-08-03T17:00:00-03:00"),
        startedAt: iso("2026-08-03T11:30:00-03:00"),
        actualEndedAt: iso("2026-08-03T15:00:00-03:00"),
        roleLabel: "MEIO_PLANTAO",
        delayMinutes: -120,
    });
    assert.equal(result.classification, null);
    // Sem régua e sem crédito tardio, cai em rotina.
    assert.equal(result.kind, "routine");
});

test("nota de override: 8+ caracteres, espaços internos contam, bordas aparadas", () => {
    assert.equal(isValidOverrideNote(null), false);
    assert.equal(isValidOverrideNote(""), false);
    assert.equal(isValidOverrideNote("curta"), false);
    assert.equal(isValidOverrideNote("        "), false);
    assert.equal(isValidOverrideNote("ok razao"), true);
    assert.equal(isValidOverrideNote("  a b c d  "), false);
    assert.equal(isValidOverrideNote("liberado por mim"), true);
});

// ─── Permanência longa: o caso Felipe Carneiro ──────────────────────────────
//
// Ficar 6h ou mais além da janela é emendar o turno seguinte — um "P". A folha
// assina o plantão pelo slot ocupado; o banco de horas fica com o resto abaixo
// de 6h (applyAnomalyGuard). Antes disto a fila mandava o caso para late_credit
// e oferecia ao chefe "confirmar Nh de banco de horas", número que a gravação
// nunca produzia, e o P não aparecia em lugar nenhum da tela.

test("permanência de 6h+ além da janela é P a assinar, não crédito de banco", () => {
    const result = triagePendingDeparture({
        ...SD,
        startedAt: iso("2026-08-03T07:00:00-03:00"),
        actualEndedAt: iso("2026-08-04T02:00:00-03:00"),
        delayMinutes: 7 * 60,
    });
    assert.equal(result.kind, "extended_stay");
    assert.equal(result.attention, true);
    assert.equal(result.extendedStay?.halfShifts, 1);
    assert.equal(result.extendedStay?.fullShifts, 0);
    assert.equal(result.extendedStay?.bankMinutes, 0);
    assert.match(result.headline, /P\)/);
    assert.match(result.headline, /MEIO plantão/);
    assert.doesNotMatch(result.headline, /crédito/i);
});

test("turno inteiro emendado propõe plantão INTEIRO e não fala em banco", () => {
    // Carneiro: entrou no SD e só saiu no fim do SN seguinte — 12h de sobra.
    const result = triagePendingDeparture({
        ...SD,
        startedAt: iso("2026-08-03T07:00:00-03:00"),
        actualEndedAt: iso("2026-08-04T07:00:00-03:00"),
        delayMinutes: 12 * 60,
    });
    assert.equal(result.kind, "extended_stay");
    assert.equal(result.extendedStay?.fullShifts, 1);
    assert.match(result.headline, /1 plantão INTEIRO a assinar/);
    // A frase precisa NEGAR o banco, não oferecê-lo.
    assert.match(result.headline, /não banco de horas/);
});

test("sobra de 14h assina um inteiro e deixa só o resto (<6h) no banco", () => {
    const result = triagePendingDeparture({
        ...SD,
        startedAt: iso("2026-08-03T07:00:00-03:00"),
        actualEndedAt: iso("2026-08-04T09:00:00-03:00"),
        delayMinutes: 14 * 60,
    });
    assert.equal(result.kind, "extended_stay");
    assert.equal(result.extendedStay?.fullShifts, 1);
    assert.equal(result.extendedStay?.bankMinutes, 120);
    assert.match(result.headline, /Sobram 2h para o banco/);
});

test("permanência de 5h59 continua sendo crédito de banco (late_credit)", () => {
    // O limite é o mesmo dos 6h da régua de saída antecipada: um minuto abaixo
    // ainda é bônus, não plantão.
    const result = triagePendingDeparture({
        ...SD,
        startedAt: iso("2026-08-03T07:00:00-03:00"),
        actualEndedAt: iso("2026-08-04T00:59:00-03:00"),
        delayMinutes: (5 * 60) + 59,
    });
    assert.equal(result.kind, "late_credit");
    assert.equal(result.extendedStay, null);
    assert.match(result.headline, /banco de horas/);
});

test("permanência longa sobrevive à rendição — quem ficou o turno prestou o plantão", () => {
    // reasonCode handoff desliga a régua de saída ANTECIPADA; não tem nada a
    // dizer sobre quem ficou tempo demais.
    const result = triagePendingDeparture({
        ...SD,
        startedAt: iso("2026-08-03T07:00:00-03:00"),
        actualEndedAt: iso("2026-08-04T07:00:00-03:00"),
        delayMinutes: 12 * 60,
        reasonCode: "handoff",
    });
    assert.equal(result.kind, "extended_stay");
    assert.equal(result.attention, true);
});
