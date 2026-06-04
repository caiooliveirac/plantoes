import assert from "node:assert/strict";
import test from "node:test";
import {
    isRegulationShadowOccupancyNotes,
    resolveRegulationArrivalBoardPolicy,
    shouldCloseRegulationOccupantOnArrival,
} from "@/modules/regulation/service";
import { buildOperationalSlotPresenceBoardModel } from "@/services/board.service";

// Regression: Yngra entrou de "sombra" no ramal 2152 onde Indira já estava ativa.
// O login da sombra NUNCA deve fechar o titular ativo (e vice-versa). Espelha a
// regra já existente no domínio de intervenção.

test("isRegulationShadowOccupancyNotes reconhece o marcador do Telegram e a palavra solta", () => {
    assert.equal(
        isRegulationShadowOccupancyNotes("[telegram sombra] Yngra 2152 07:10 sombra"),
        true,
    );
    assert.equal(isRegulationShadowOccupancyNotes("Yngra sombra 2152"), true);
    assert.equal(isRegulationShadowOccupancyNotes("Indira 2152 07:00"), false);
    assert.equal(isRegulationShadowOccupancyNotes(null), false);
});

test("shouldCloseRegulationOccupantOnArrival: sombra NÃO retira a titular ativa (caso Yngra→Indira na 2152)", () => {
    assert.equal(
        shouldCloseRegulationOccupantOnArrival({
            currentOccupantDoctorId: "doc-indira",
            arrivingDoctorId: "doc-yngra",
            arrivingIsShadow: true,
            currentOccupantNotes: "Indira 2152 07:00",
        }),
        false,
    );
});

test("shouldCloseRegulationOccupantOnArrival: titular real NÃO retira uma sombra ativa", () => {
    assert.equal(
        shouldCloseRegulationOccupantOnArrival({
            currentOccupantDoctorId: "doc-yngra",
            arrivingDoctorId: "doc-indira",
            arrivingIsShadow: false,
            currentOccupantNotes: "[telegram sombra] Yngra 2152 07:10 sombra",
        }),
        false,
    );
});

test("shouldCloseRegulationOccupantOnArrival: rendição normal entre titulares ainda fecha o anterior", () => {
    assert.equal(
        shouldCloseRegulationOccupantOnArrival({
            currentOccupantDoctorId: "doc-a",
            arrivingDoctorId: "doc-b",
            arrivingIsShadow: false,
            currentOccupantNotes: "Medico A 2152 07:00",
        }),
        true,
    );
});

test("shouldCloseRegulationOccupantOnArrival: mesma médica re-enviando não fecha a si mesma", () => {
    assert.equal(
        shouldCloseRegulationOccupantOnArrival({
            currentOccupantDoctorId: "doc-indira",
            arrivingDoctorId: "doc-indira",
            arrivingIsShadow: false,
            currentOccupantNotes: "Indira 2152 07:00",
        }),
        false,
    );
});

test("resolveRegulationArrivalBoardPolicy: sombra com titular presente NÃO toma o board (coexiste com board nulo)", () => {
    assert.deepEqual(
        resolveRegulationArrivalBoardPolicy({ source: "telegram", isShadow: true, hasCurrentBoardCarrier: true }),
        { shouldTakeBoardImmediately: false },
    );
});

test("resolveRegulationArrivalBoardPolicy: sombra em posto vazio toma o board (vira o ocupante visível)", () => {
    assert.deepEqual(
        resolveRegulationArrivalBoardPolicy({ source: "telegram", isShadow: true, hasCurrentBoardCarrier: false }),
        { shouldTakeBoardImmediately: true },
    );
});

test("resolveRegulationArrivalBoardPolicy: titular real sempre toma o board", () => {
    assert.deepEqual(
        resolveRegulationArrivalBoardPolicy({ source: "telegram", isShadow: false, hasCurrentBoardCarrier: true }),
        { shouldTakeBoardImmediately: true },
    );
});

test("buildOperationalSlotPresenceBoardModel mantém a 2152 com Indira titular e Yngra como sombra", () => {
    const board = buildOperationalSlotPresenceBoardModel({
        targets: [{
            domain: "regulation",
            targetId: 2152,
            targetCode: "2152",
            targetLabel: "Ramal 2152",
            sortOrder: 200,
            defaultRole: null,
        }],
        rawRows: [
            {
                occupancyId: "occ-indira",
                domain: "regulation",
                targetCode: "2152",
                targetLabel: "Ramal 2152",
                doctorId: "doc-indira",
                doctorName: "Indira",
                displayName: null,
                startedAt: "2026-04-28T10:00:00.000Z",
                boardStartedAt: "2026-04-28T10:00:00.000Z",
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: "2026-04-28T10:00:00.000Z",
                scheduledEndAt: "2026-04-28T22:00:00.000Z",
                continuityGroupId: "cg-indira",
                shiftLabel: "SD",
                roleLabel: null,
                ramalLabel: "2152",
                arrivalDelayMinutes: null,
                overtimeMinutes: null,
                creditedOvertimeMinutes: null,
                balanceMinutes: null,
                ruleCode: null,
                bankHoursExplanation: null,
                source: "telegram",
                notes: "Indira 2152 07:00",
                createdAt: null,
            },
            {
                occupancyId: "occ-yngra",
                domain: "regulation",
                targetCode: "2152",
                targetLabel: "Ramal 2152",
                doctorId: "doc-yngra",
                doctorName: "Yngra",
                displayName: null,
                startedAt: "2026-04-28T10:10:00.000Z",
                boardStartedAt: null,
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: "2026-04-28T10:00:00.000Z",
                scheduledEndAt: "2026-04-28T22:00:00.000Z",
                continuityGroupId: "cg-yngra",
                shiftLabel: "SD",
                roleLabel: null,
                ramalLabel: "2152",
                arrivalDelayMinutes: null,
                overtimeMinutes: null,
                creditedOvertimeMinutes: null,
                balanceMinutes: null,
                ruleCode: null,
                bankHoursExplanation: null,
                source: "telegram",
                notes: "[telegram sombra] Yngra 2152 07:10 sombra",
                createdAt: null,
            },
        ],
        operationalDate: "2026-04-28T12:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-04-28T10:00:00.000Z",
        endedAt: "2026-04-28T22:00:00.000Z",
    });

    const row = board.regulation[0];
    // Indira permanece como titular (primária) e Yngra coexiste rotulada como sombra
    // — antes do fix, a chegada da sombra truncava a Indira e a fazia sumir do quadro.
    assert.equal(row?.doctorName, "Indira");
    assert.deepEqual(row?.occupantLabels, ["Indira", "Yngra (sombra)"]);
    assert.equal(row?.occupancyCount, 2);
});
