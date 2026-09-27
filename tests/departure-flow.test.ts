import assert from "node:assert/strict";
import test from "node:test";
import { resolveOvertimeJustificationThreshold } from "@/modules/operational/board-rules";
import {
    computeLevenshteinDistance,
    deserializeDepartureCorrectionCandidate,
    getPendingDepartureJustificationAttemptCount,
    pickLikelyDepartureCorrectionCandidate,
    requiresTelegramDepartureAdjustmentJustification,
    resolveDepartureJustificationPromptKind,
    resolveTelegramDepartureAdjustmentThreshold,
    serializeDepartureCorrectionCandidate,
    type TelegramDepartureCorrectionCandidate,
} from "@/modules/telegram/departure-flow";

/**
 * Funções puras de modules/telegram/departure-flow.ts que ainda não tinham
 * teste direto (motivo/nº de ocorrência, lote e o caso base de
 * pickLikelyDepartureCorrectionCandidate já estão em telegram-commands.test.ts).
 */

const MIN = 60 * 1000;

test("limiar de ajuste de saída: intervenção tem 15 min de tolerância, regulação nenhuma", () => {
    const scheduledEndAt = "2026-05-10T22:00:00.000Z";
    assert.equal(
        resolveTelegramDepartureAdjustmentThreshold({ domain: "INTERVENTION", startedAt: null, scheduledEndAt })?.toISOString(),
        "2026-05-10T22:15:00.000Z",
    );
    assert.equal(
        resolveTelegramDepartureAdjustmentThreshold({ domain: "REGULATION", startedAt: null, scheduledEndAt })?.toISOString(),
        scheduledEndAt,
    );
    // Sem fim escalado, cai na regra do quadro (a partir do início).
    const startedAt = "2026-05-10T10:00:00.000Z";
    assert.deepEqual(
        resolveTelegramDepartureAdjustmentThreshold({ domain: "REGULATION", startedAt }),
        resolveOvertimeJustificationThreshold(startedAt),
    );
});

test("justificativa de saída: só quando o evento passa da rendição E do limiar", () => {
    const base = {
        domain: "INTERVENTION" as const,
        startedAt: "2026-05-10T10:00:00.000Z",
        scheduledEndAt: "2026-05-10T22:00:00.000Z",
        endedAt: "2026-05-10T22:00:00.000Z",
    };
    const at = (minutes: number) => new Date(Date.parse(base.scheduledEndAt) + minutes * MIN).toISOString();

    assert.equal(requiresTelegramDepartureAdjustmentJustification({ ...base, eventAt: at(14) }), false, "dentro da tolerância");
    assert.equal(requiresTelegramDepartureAdjustmentJustification({ ...base, eventAt: at(15) }), true, "no limiar já pede");
    assert.equal(requiresTelegramDepartureAdjustmentJustification({ ...base, eventAt: at(60) }), true);
    assert.equal(requiresTelegramDepartureAdjustmentJustification({ ...base, eventAt: at(60), hasSuccessorOccupancy: false }), false, "sem sucessor não há quem esperar");
    assert.equal(requiresTelegramDepartureAdjustmentJustification({ ...base, eventAt: at(60), endedAt: at(90) }), false, "evento antes da rendição");
    assert.equal(requiresTelegramDepartureAdjustmentJustification({ ...base, eventAt: null }), false);
    assert.equal(requiresTelegramDepartureAdjustmentJustification({ ...base, eventAt: at(60), endedAt: null }), false);
    assert.equal(requiresTelegramDepartureAdjustmentJustification({ ...base, domain: "REGULATION", eventAt: at(1) }), true, "regulação não tem tolerância");
});

test("tentativas de justificativa: contador saneado e tipo do prompt", () => {
    assert.equal(getPendingDepartureJustificationAttemptCount({}), 0);
    assert.equal(getPendingDepartureJustificationAttemptCount({ invalidJustificationAttempts: 2.7 }), 2);
    assert.equal(getPendingDepartureJustificationAttemptCount({ invalidJustificationAttempts: -1 }), 0);
    assert.equal(getPendingDepartureJustificationAttemptCount({ invalidJustificationAttempts: Number.NaN }), 0);
    assert.equal(resolveDepartureJustificationPromptKind(0), "departure_justification_required");
    assert.equal(resolveDepartureJustificationPromptKind(1), "departure_justification_retry");
});

test("distância de Levenshtein", () => {
    assert.equal(computeLevenshteinDistance("", ""), 0);
    assert.equal(computeLevenshteinDistance("", "ABC"), 3);
    assert.equal(computeLevenshteinDistance("ABC", ""), 3);
    assert.equal(computeLevenshteinDistance("OCORRENCIA", "OCORRENCIA"), 0);
    assert.equal(computeLevenshteinDistance("OCORENCIA", "OCORRENCIA"), 1);
    assert.equal(computeLevenshteinDistance("KITTEN", "SITTING"), 3);
    assert.equal(computeLevenshteinDistance("HIGIENE", "HIGENIE"), 2);
});

function candidate(overrides: Partial<TelegramDepartureCorrectionCandidate>): TelegramDepartureCorrectionCandidate {
    return {
        occupancyId: "occ",
        domain: "INTERVENTION",
        targetCode: "BR05",
        shiftLabel: "SD",
        roleLabel: null,
        startedAt: new Date("2026-05-10T10:00:00.000Z"),
        endedAt: new Date("2026-05-10T22:00:00.000Z"),
        actualEndedAt: null,
        isActive: false,
        ...overrides,
    };
}

test("candidato de correção: serializa e volta igual (estado pendente do bot)", () => {
    const original = candidate({ actualEndedAt: new Date("2026-05-10T22:40:00.000Z"), roleLabel: "MED" });
    const roundTrip = deserializeDepartureCorrectionCandidate(serializeDepartureCorrectionCandidate(original));
    assert.deepEqual(roundTrip, original);
    const open = candidate({ endedAt: null, isActive: true });
    assert.deepEqual(deserializeDepartureCorrectionCandidate(serializeDepartureCorrectionCandidate(open)), open);
});

test("candidato de correção: mesmo posto/turno não é ambíguo; 6 h de folga desempata", () => {
    const recente = candidate({ occupancyId: "recente", endedAt: new Date("2026-05-10T22:00:00.000Z") });
    const mesmoSlotAntes = candidate({ occupancyId: "antes", endedAt: new Date("2026-05-10T20:00:00.000Z") });
    assert.equal(pickLikelyDepartureCorrectionCandidate({ candidates: [mesmoSlotAntes, recente] }).candidate?.occupancyId, "recente");

    const outroPostoPerto = candidate({ occupancyId: "perto", targetCode: "SM01", endedAt: new Date("2026-05-10T17:00:00.000Z") });
    const ambiguous = pickLikelyDepartureCorrectionCandidate({ candidates: [outroPostoPerto, recente] });
    assert.equal(ambiguous.candidate, null);
    assert.deepEqual(ambiguous.ambiguousCandidates.map((item) => item.occupancyId), ["recente", "perto"]);

    const outroPostoLonge = candidate({ occupancyId: "longe", targetCode: "SM01", endedAt: new Date("2026-05-10T16:00:00.000Z") });
    assert.equal(pickLikelyDepartureCorrectionCandidate({ candidates: [outroPostoLonge, recente] }).candidate?.occupancyId, "recente");

    // Código explícito filtra sem olhar ambiguidade, sem diferenciar caixa.
    assert.equal(
        pickLikelyDepartureCorrectionCandidate({ candidates: [outroPostoPerto, recente], targetCode: " sm01 " }).candidate?.occupancyId,
        "perto",
    );
    assert.deepEqual(pickLikelyDepartureCorrectionCandidate({ candidates: [recente], targetCode: "XX99" }), {
        candidate: null,
        ambiguousCandidates: [],
    });
});
