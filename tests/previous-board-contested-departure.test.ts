import test from "node:test";
import assert from "node:assert/strict";

import {
    isEligiblePresenceCandidate,
    isEligibleTitularityCandidate,
    type LogicalShiftCandidate,
} from "@/services/board.service";

// Intervenção reaberta pelo modal "NÃO SAIU" da chefia: o board é zerado de
// propósito (outro médico já ocupa a base ao vivo), mas a titularidade do turno
// auditado continua sendo dela — caso Murilo Damasceno, PR03, 21/08/2026.
function buildInterventionCandidate(overrides: Partial<LogicalShiftCandidate> = {}) {
    return {
        occupancyId: "occ-1",
        domain: "intervention",
        targetCode: "PR03",
        doctorId: "doc-1",
        startedAt: "2026-08-21T09:59:36.000Z",
        boardStartedAt: null,
        endedAt: null,
        actualEndedAt: null,
        scheduledStartAt: "2026-08-21T10:00:00.000Z",
        scheduledEndAt: "2026-08-21T22:00:00.000Z",
        shiftLabel: "SD",
        notes: null,
        logicalSlotStart: "2026-08-21T10:00:00.000Z",
        logicalSlot: "SD",
        effectiveEndedAt: null,
        invalidTimeline: false,
        isShadow: false,
        duplicateConflict: false,
        durationMinutes: null,
        isLikelyNoise: false,
        ...overrides,
    } as unknown as LogicalShiftCandidate;
}

test("intervenção sem board segue fora do plantão anterior (sombra)", () => {
    assert.equal(isEligibleTitularityCandidate(buildInterventionCandidate()), false);
});

test("saída contestada pela chefia mantém o médico no plantão anterior", () => {
    const candidate = buildInterventionCandidate({
        notes: "Murilo Damasceno na PR03 p\n[NÃO SAIU] chefia contestou a saída registrada às 07:01: seguiu no mesmo posto/base. Registro reaberto — nenhuma ocupação nova foi criada.",
    });
    assert.equal(isEligibleTitularityCandidate(candidate), true);
});

// O pagamento usa outro filtro (isEligiblePresenceCandidate) com a MESMA regra
// de board nulo: consertar só o Plantão Anterior deixava a folha errada — foi
// assim que o plantão do Murilo sumiu do pagamento depois do "NÃO SAIU".
test("saída contestada mantém o médico no pagamento, não só na tela", () => {
    assert.equal(isEligiblePresenceCandidate(buildInterventionCandidate()), false);
    assert.equal(
        isEligiblePresenceCandidate(buildInterventionCandidate({
            notes: "Murilo Damasceno na PR03 p\n[NÃO SAIU] chefia contestou a saída registrada às 07:01: seguiu no mesmo posto/base.",
        })),
        true,
    );
});
