/* Decisão de chegada sem I/O (modules/telegram/arrival-classification.ts).
   Uma tabela por decisão, um caso por ramo. Os mesmos cenários de ponta a ponta
   estão em tests/telegram-arrival-characterization.test.ts. */

import assert from "node:assert/strict";
import test from "node:test";

import {
    arrivalWantsBoard,
    classifyArrivalRoute,
    classifyTargetArrival,
    resolveInitialArrivalShiftType,
    shouldDisplaceOnRetroactiveArrival,
    shouldUseTelegramContinuitySource,
    type ArrivalParsedEntry,
} from "@/modules/telegram/arrival-classification";

function at(iso: string) {
    return new Date(`${iso}-03:00`);
}

function entry(overrides: Partial<ArrivalParsedEntry> = {}): ArrivalParsedEntry {
    return {
        sector: "REGULATION",
        baseCode: "2153",
        arrivalTime: null,
        shiftType: "SD",
        roleFunction: null,
        isShadow: false,
        isDeparture: false,
        isContinuation: false,
        isReassignment: false,
        ...overrides,
    };
}

const activeSdOn2151 = {
    sector: "REGULATION" as const,
    baseCode: "2151",
    shiftLabel: "SD",
    scheduledEndAt: at("2026-09-14T19:15:00"),
};

test("classifyArrivalRoute: um caso por ramo", () => {
    const cases: Array<[string, Parameters<typeof classifyArrivalRoute>[0], ReturnType<typeof classifyArrivalRoute>]> = [
        ["chegada sem plantão aberto segue para o alvo",
            { parsed: entry(), activeOcc: null, eventAt: at("2026-09-14T07:05:00") },
            { kind: "on_target" }],
        ["D12: 'remanejado' sem plantão aberto vira chegada",
            { parsed: entry({ isReassignment: true }), activeOcc: null, eventAt: at("2026-09-14T07:20:00") },
            { kind: "reassignment_as_arrival" }],
        ["D12: 'remanejado' para onde já está vira chegada",
            { parsed: entry({ baseCode: "2151", isReassignment: true }), activeOcc: activeSdOn2151, eventAt: at("2026-09-14T10:00:00") },
            { kind: "reassignment_as_arrival" }],
        ["remanejo explícito dentro do turno",
            { parsed: entry({ isReassignment: true }), activeOcc: activeSdOn2151, eventAt: at("2026-09-14T10:00:00") },
            { kind: "reassignment", implicit: false }],
        ["chegada em outro alvo com plantão aberto do mesmo turno é remanejo implícito",
            { parsed: entry(), activeOcc: activeSdOn2151, eventAt: at("2026-09-14T10:00:00") },
            { kind: "reassignment", implicit: true }],
        ["remanejo implícito também cruza domínio (ramal → base)",
            { parsed: entry({ sector: "INTERVENTION", baseCode: "PM04", shiftType: null }), activeOcc: activeSdOn2151, eventAt: at("2026-09-14T10:00:00") },
            { kind: "reassignment", implicit: true }],
        ["turno concreto diferente do aberto (SD → SN) é chegada nova",
            { parsed: entry({ shiftType: "SN" }), activeOcc: activeSdOn2151, eventAt: at("2026-09-14T18:50:00") },
            { kind: "on_target" }],
        ["remanejo depois do fim do SD de origem vira chegada SN",
            { parsed: entry({ isReassignment: true, shiftType: null }), activeOcc: activeSdOn2151, eventAt: at("2026-09-14T19:40:00") },
            { kind: "cross_turno_arrival", shiftType: "SN" }],
        ["chegada implícita em outro alvo depois do fim do SD também vira SN",
            { parsed: entry({ shiftType: null }), activeOcc: activeSdOn2151, eventAt: at("2026-09-14T19:40:00") },
            { kind: "cross_turno_arrival", shiftType: "SN" }],
        ["P segue P: remanejo depois do fim previsto continua remanejo",
            { parsed: entry({ isReassignment: true }), activeOcc: { ...activeSdOn2151, shiftLabel: "P" }, eventAt: at("2026-09-14T19:40:00") },
            { kind: "reassignment", implicit: false }],
        ["sombra em outro alvo não move o plantão aberto",
            { parsed: entry({ isShadow: true }), activeOcc: activeSdOn2151, eventAt: at("2026-09-14T10:00:00") },
            { kind: "on_target" }],
        ["continuação em outro alvo segue para o alvo (cadeia de continuidade)",
            { parsed: entry({ isContinuation: true, shiftType: "SN" }), activeOcc: activeSdOn2151, eventAt: at("2026-09-14T19:05:00") },
            { kind: "on_target" }],
        ["saída segue para o alvo",
            { parsed: entry({ isDeparture: true }), activeOcc: null, eventAt: at("2026-09-14T19:10:00") },
            { kind: "on_target" }],
    ];
    for (const [name, input, expected] of cases) {
        assert.deepEqual(classifyArrivalRoute(input), expected, name);
    }
});

test("resolveInitialArrivalShiftType: um caso por ramo", () => {
    const cases: Array<[string, Parameters<typeof resolveInitialArrivalShiftType>[0], string | null]> = [
        ["rótulo declarado vale",
            { parsed: entry({ shiftType: "SD" }), eventAt: at("2026-09-14T07:05:00"), referenceAt: at("2026-09-14T07:05:00") },
            "SD"],
        ["continuação usa o turno em que chega (nunca P), de dia",
            { parsed: entry({ shiftType: "P", isContinuation: true }), eventAt: at("2026-09-14T10:00:00"), referenceAt: at("2026-09-14T10:00:00") },
            "SD"],
        ["continuação perto da virada já conta para o turno seguinte",
            { parsed: entry({ shiftType: null, isContinuation: true }), eventAt: at("2026-09-14T18:50:00"), referenceAt: at("2026-09-14T18:50:00") },
            "SN"],
        ["sem rótulo, chegada até 60 min antes da virada e aviso no turno seguinte → turno do aviso",
            { parsed: entry({ shiftType: null }), eventAt: at("2026-09-14T18:30:00"), referenceAt: at("2026-09-14T20:06:00") },
            "SN"],
        ["sem rótulo, chegada a mais de 60 min da virada → sem rótulo",
            { parsed: entry({ shiftType: null }), eventAt: at("2026-09-14T17:30:00"), referenceAt: at("2026-09-14T20:06:00") },
            null],
        ["sem rótulo, mesmo turno → sem rótulo",
            { parsed: entry({ shiftType: null }), eventAt: at("2026-09-14T10:00:00"), referenceAt: at("2026-09-14T10:05:00") },
            null],
        ["saída não ganha rótulo",
            { parsed: entry({ shiftType: null, isDeparture: true }), eventAt: at("2026-09-14T18:30:00"), referenceAt: at("2026-09-14T20:06:00") },
            null],
    ];
    for (const [name, input, expected] of cases) {
        assert.equal(resolveInitialArrivalShiftType(input), expected, name);
    }
});

test("classifyTargetArrival: um caso por ramo", () => {
    const newOcc = (assumedHalfShift: boolean, lookupContinuity: boolean) => ({ kind: "new_occupancy" as const, assumedHalfShift, lookupContinuity });
    const cases: Array<[string, Parameters<typeof classifyTargetArrival>[0], ReturnType<typeof classifyTargetArrival>]> = [
        ["posto sem ocupação do médico: nova ocupação, busca continuidade",
            { parsed: entry(), activeOnTarget: null, eventAt: at("2026-09-14T07:05:00"), effectiveShiftType: "SD" },
            newOcc(false, true)],
        ["regulação 11:10–17:00 sem ocupação: meio plantão",
            { parsed: entry({ shiftType: null }), activeOnTarget: null, eventAt: at("2026-09-14T12:05:00"), effectiveShiftType: null },
            newOcc(true, true)],
        ["intervenção nunca é meio plantão",
            { parsed: entry({ sector: "INTERVENTION", baseCode: "PM04", shiftType: null }), activeOnTarget: null, eventAt: at("2026-09-14T12:05:00"), effectiveShiftType: null },
            newOcc(false, true)],
        ["D6: reenvio à tarde de quem chegou antes das 11:10 não é meio plantão",
            { parsed: entry(), activeOnTarget: { shiftLabel: "SD", startedAt: at("2026-09-14T07:16:00") }, eventAt: at("2026-09-14T16:12:00"), effectiveShiftType: "SD" },
            newOcc(false, true)],
        ["D1: reenvio com o mesmo rótulo é nova ocupação (start*Occupancy reusa a linha)",
            { parsed: entry(), activeOnTarget: { shiftLabel: "SD", startedAt: at("2026-09-14T07:10:00") }, eventAt: at("2026-09-14T18:40:00"), effectiveShiftType: "SD" },
            newOcc(false, true)],
        ["regulação SD → SN horas depois: continua a ocupação aberta",
            { parsed: entry({ shiftType: "SN" }), activeOnTarget: { shiftLabel: "SD", startedAt: at("2026-09-14T07:00:00") }, eventAt: at("2026-09-14T18:50:00"), effectiveShiftType: "SN" },
            { kind: "continue_active" }],
        ["regulação P com SD aberto: continua",
            { parsed: entry({ shiftType: "P" }), activeOnTarget: { shiftLabel: "SD", startedAt: at("2026-09-14T07:00:00") }, eventAt: at("2026-09-14T10:00:00"), effectiveShiftType: "P" },
            { kind: "continue_active" }],
        ["D2: SD → SN segundos depois da chegada é correção: nova ocupação, SEM busca de cadeia",
            { parsed: entry({ shiftType: "SN" }), activeOnTarget: { shiftLabel: "SD", startedAt: at("2026-09-14T19:08:05") }, eventAt: at("2026-09-14T19:08:15"), effectiveShiftType: "SN" },
            newOcc(false, false)],
        ["'continua' explícito com ocupação aberta: continua",
            { parsed: entry({ shiftType: null, isContinuation: true }), activeOnTarget: { shiftLabel: "SD", startedAt: at("2026-09-14T07:00:00") }, eventAt: at("2026-09-14T18:55:00"), effectiveShiftType: "SN" },
            { kind: "continue_active" }],
        ["P aberto já vencido (stale): P de novo abre ocupação nova",
            { parsed: entry({ shiftType: "P" }), activeOnTarget: { shiftLabel: "P", startedAt: at("2026-09-13T07:00:00") }, eventAt: at("2026-09-14T08:00:00"), effectiveShiftType: "P" },
            newOcc(false, true)],
        ["P aberto já vencido, mas 'continua' explícito: continua",
            { parsed: entry({ shiftType: "P", isContinuation: true }), activeOnTarget: { shiftLabel: "P", startedAt: at("2026-09-13T07:00:00") }, eventAt: at("2026-09-14T08:00:00"), effectiveShiftType: "SD" },
            { kind: "continue_active" }],
        ["intervenção P vencido (stale da intervenção): nova ocupação",
            { parsed: entry({ sector: "INTERVENTION", baseCode: "PM04", shiftType: "P" }), activeOnTarget: { shiftLabel: "P", startedAt: at("2026-09-13T07:00:00") }, eventAt: at("2026-09-14T08:00:00"), effectiveShiftType: "P" },
            newOcc(false, true)],
        ["intervenção com rótulo diferente do aberto: continua",
            { parsed: entry({ sector: "INTERVENTION", baseCode: "PM04", shiftType: "SN" }), activeOnTarget: { shiftLabel: "SD", startedAt: at("2026-09-14T07:00:00") }, eventAt: at("2026-09-14T18:50:00"), effectiveShiftType: "SN" },
            { kind: "continue_active" }],
        ["intervenção sem rótulo com SD aberto: nova ocupação (reenvio)",
            { parsed: entry({ sector: "INTERVENTION", baseCode: "PM04", shiftType: null }), activeOnTarget: { shiftLabel: "SD", startedAt: at("2026-09-14T07:00:00") }, eventAt: at("2026-09-14T10:00:00"), effectiveShiftType: null },
            newOcc(false, true)],
        ["saída nunca continua nem busca cadeia",
            { parsed: entry({ isDeparture: true }), activeOnTarget: { shiftLabel: "SD", startedAt: at("2026-09-14T07:00:00") }, eventAt: at("2026-09-14T19:10:00"), effectiveShiftType: "SD" },
            newOcc(false, false)],
    ];
    for (const [name, input, expected] of cases) {
        assert.deepEqual(classifyTargetArrival(input), expected, name);
    }
});

test("shouldUseTelegramContinuitySource: um caso por ramo", () => {
    const sdSource = { shiftLabel: "SD", boardStartedAt: at("2026-09-14T07:00:00"), startedAt: at("2026-09-14T07:00:00") };
    const cases: Array<[string, Parameters<typeof shouldUseTelegramContinuitySource>[0], boolean]> = [
        ["sem fonte, sem cadeia",
            { parsed: entry(), source: null, eventAt: at("2026-09-14T19:05:00") }, false],
        ["regulação SN depois de SD: rótulo liga a cadeia",
            { parsed: entry({ shiftType: "SN" }), source: sdSource, eventAt: at("2026-09-14T19:05:00") }, true],
        ["'continua' explícito liga",
            { parsed: entry({ isContinuation: true }), source: sdSource, eventAt: at("2026-09-14T19:05:00") }, true],
        ["sem rótulo, atravessou a virada: continuidade inferida",
            { parsed: entry({ sector: "INTERVENTION", baseCode: "PM04", shiftType: null }), source: sdSource, eventAt: at("2026-09-14T19:05:00") }, true],
        ["mesmo turno da fonte, sem continuação: não liga",
            { parsed: entry(), source: sdSource, eventAt: at("2026-09-14T10:00:00") }, false],
        ["fonte sem rótulo usa o turno do início no quadro",
            { parsed: entry({ shiftType: null }), source: { ...sdSource, shiftLabel: null }, eventAt: at("2026-09-14T19:05:00") }, true],
    ];
    for (const [name, input, expected] of cases) {
        assert.equal(shouldUseTelegramContinuitySource(input), expected, name);
    }
});

test("arrivalWantsBoard: saída, continuação, sombra e alvo vazio não querem o quadro", () => {
    assert.equal(arrivalWantsBoard(entry(), false), true);
    assert.equal(arrivalWantsBoard(entry({ isReassignment: true }), false), true);
    assert.equal(arrivalWantsBoard(entry({ isDeparture: true }), false), false);
    assert.equal(arrivalWantsBoard(entry({ isContinuation: true }), false), false);
    assert.equal(arrivalWantsBoard(entry(), true), false);
    assert.equal(arrivalWantsBoard(entry({ baseCode: "" }), false), false);
});

test("shouldDisplaceOnRetroactiveArrival: só desloca titular de outro médico que não divide a base", () => {
    const previous = { doctorId: "doc-a", isShadow: false };
    assert.equal(shouldDisplaceOnRetroactiveArrival({ previous, arrivingDoctorId: "doc-b", sharesBase: false }), true);
    assert.equal(shouldDisplaceOnRetroactiveArrival({ previous: null, arrivingDoctorId: "doc-b", sharesBase: false }), false);
    assert.equal(shouldDisplaceOnRetroactiveArrival({ previous: { ...previous, isShadow: true }, arrivingDoctorId: "doc-b", sharesBase: false }), false);
    assert.equal(shouldDisplaceOnRetroactiveArrival({ previous, arrivingDoctorId: "doc-a", sharesBase: false }), false);
    assert.equal(shouldDisplaceOnRetroactiveArrival({ previous, arrivingDoctorId: "doc-b", sharesBase: true }), false);
});
