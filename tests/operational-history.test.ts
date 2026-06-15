import assert from "node:assert/strict";
import test from "node:test";
import type { HistoricalOperationalPresenceBoard, HistoricalOperationalPresenceRow } from "@/services/board.service";
import {
    buildHistoricalOperationalBoardModel,
    resolveHistoricalOperationalRequest,
    stepHistoricalShiftSlot,
} from "@/services/operational-history.service";

function makeRow(overrides: Partial<HistoricalOperationalPresenceRow> & Pick<HistoricalOperationalPresenceRow, "domain" | "targetCode" | "targetLabel">): HistoricalOperationalPresenceRow {
    return {
        domain: overrides.domain,
        targetId: overrides.targetId ?? 1,
        targetCode: overrides.targetCode,
        targetLabel: overrides.targetLabel,
        sortOrder: overrides.sortOrder ?? 1,
        defaultRole: overrides.defaultRole ?? null,
        disabledAt: overrides.disabledAt ?? null,
        disabledReason: overrides.disabledReason ?? null,
        disabledDuringShift: overrides.disabledDuringShift ?? false,
        disabledEntireShift: overrides.disabledEntireShift ?? false,
        status: overrides.status ?? (overrides.occupancyId ? "occupied" : (overrides.disabledEntireShift ? "disabled" : "empty")),
        occupancyId: overrides.occupancyId ?? null,
        doctorId: overrides.doctorId ?? null,
        doctorName: overrides.doctorName ?? null,
        displayName: overrides.displayName ?? null,
        doctorLabel: overrides.doctorLabel ?? (overrides.occupancyId ? (overrides.displayName ?? overrides.doctorName ?? "Medico") : (overrides.disabledEntireShift ? (overrides.domain === "regulation" ? "Ramal desativado" : "Base desativada") : "Sem medico")),
        occupantLabels: overrides.occupantLabels ?? (overrides.occupancyId ? [overrides.displayName ?? overrides.doctorName ?? "Medico"] : []),
        occupancyIds: overrides.occupancyIds ?? (overrides.occupancyId ? [overrides.occupancyId] : []),
        occupancyCount: overrides.occupancyCount ?? (overrides.occupancyId ? 1 : 0),
        startedAt: overrides.startedAt ?? null,
        endedAt: overrides.endedAt ?? null,
        actualEndedAt: overrides.actualEndedAt ?? null,
        scheduledStartAt: overrides.scheduledStartAt ?? null,
        scheduledEndAt: overrides.scheduledEndAt ?? null,
        shiftLabel: overrides.shiftLabel ?? null,
        roleLabel: overrides.roleLabel ?? null,
        ramalLabel: overrides.ramalLabel ?? null,
        source: overrides.source ?? null,
        notes: overrides.notes ?? null,
        issues: overrides.issues ?? [],
        arrivalDelayMinutes: overrides.arrivalDelayMinutes ?? null,
    } satisfies HistoricalOperationalPresenceRow;
}

function makeBoard(overrides: Partial<HistoricalOperationalPresenceBoard> = {}): HistoricalOperationalPresenceBoard {
    return {
        generatedAt: "2026-04-03T11:00:00.000Z",
        operationalDate: "2026-04-02T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-04-02T10:00:00.000Z",
        endedAt: "2026-04-02T22:00:00.000Z",
        summary: {
            totalTargets: 8,
            occupiedCount: 3,
            emptyCount: 4,
            disabledCount: 1,
        },
        regulation: overrides.regulation ?? [],
        intervention: overrides.intervention ?? [],
    } satisfies HistoricalOperationalPresenceBoard;
}

test("stepHistoricalShiftSlot respeita a cronologia SD/SN", () => {
    assert.deepEqual(
        stepHistoricalShiftSlot({ operationalDate: "2026-04-02", shiftLabel: "SD" }, "next"),
        { operationalDate: "2026-04-02", shiftLabel: "SN" },
    );

    assert.deepEqual(
        stepHistoricalShiftSlot({ operationalDate: "2026-04-02", shiftLabel: "SN" }, "next"),
        { operationalDate: "2026-04-03", shiftLabel: "SD" },
    );

    assert.deepEqual(
        stepHistoricalShiftSlot({ operationalDate: "2026-04-02", shiftLabel: "SN" }, "previous"),
        { operationalDate: "2026-04-02", shiftLabel: "SD" },
    );

    assert.deepEqual(
        stepHistoricalShiftSlot({ operationalDate: "2026-04-02", shiftLabel: "SD" }, "previous"),
        { operationalDate: "2026-04-01", shiftLabel: "SN" },
    );
});

test("resolveHistoricalOperationalRequest aponta por padrão para o turno fechado imediatamente anterior", () => {
    assert.deepEqual(
        resolveHistoricalOperationalRequest({ reference: new Date("2026-04-03T23:30:00.000Z") }),
        { operationalDate: "2026-04-03", shiftLabel: "SD" },
    );

    assert.deepEqual(
        resolveHistoricalOperationalRequest({ reference: new Date("2026-04-03T14:30:00.000Z") }),
        { operationalDate: "2026-04-02", shiftLabel: "SN" },
    );
});

test("buildHistoricalOperationalBoardModel exibe linhas esperadas, destaca pendências relevantes e mantém o catálogo completo", () => {
    const board = makeBoard({
        regulation: [
            makeRow({
                domain: "regulation",
                targetId: 2031,
                targetCode: "2031",
                targetLabel: "2031",
                occupancyId: "reg-2031",
                doctorId: "doc-2031",
                doctorName: "Chefia Dia",
                startedAt: "2026-04-02T10:00:00.000Z",
                actualEndedAt: "2026-04-02T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: "CP",
                ramalLabel: "2031",
                source: "telegram",
            }),
            makeRow({
                domain: "regulation",
                targetId: 1366,
                targetCode: "1366",
                targetLabel: "1366",
                occupancyId: "reg-1366",
                doctorId: "doc-1366",
                doctorName: "Bruno Lima",
                displayName: "Bruno",
                startedAt: "2026-04-02T10:05:00.000Z",
                actualEndedAt: "2026-04-02T20:00:00.000Z",
                disabledAt: "2026-04-02T18:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: "COI",
                ramalLabel: "1366",
                source: "admin_correction",
                notes: "Remanejado de 2031 para 1366. Motivo: cobertura redistribuida.",
                issues: ["Lancamento manual ou corrigido manualmente"],
            }),
            makeRow({
                domain: "regulation",
                targetId: 1322,
                targetCode: "1322",
                targetLabel: "1322",
                ramalLabel: "1322",
                status: "empty",
            }),
            makeRow({
                domain: "regulation",
                targetId: 9001,
                targetCode: "PIAM",
                targetLabel: "PIAM",
                ramalLabel: "PIAM",
                status: "empty",
            }),
            makeRow({
                domain: "regulation",
                targetId: 9002,
                targetCode: "NUCLEO",
                targetLabel: "NUCLEO",
                ramalLabel: "NUCLEO",
                status: "empty",
            }),
            makeRow({
                domain: "regulation",
                targetId: 2032,
                targetCode: "2032",
                targetLabel: "2032",
                ramalLabel: "2032",
                disabledAt: "2026-04-02T10:00:00.000Z",
                disabledReason: "Manutenção",
                disabledDuringShift: true,
                disabledEntireShift: true,
                status: "disabled",
            }),
        ],
        intervention: [
            makeRow({
                domain: "intervention",
                targetId: 1,
                targetCode: "BR05",
                targetLabel: "BR05",
                occupancyId: "int-05",
                doctorId: "doc-int-05",
                doctorName: "Fulano Auditor",
                startedAt: "2026-04-02T10:00:00.000Z",
                actualEndedAt: "2026-04-02T20:00:00.000Z",
                shiftLabel: "SD",
                source: "telegram",
            }),
            makeRow({
                domain: "intervention",
                targetId: 2,
                targetCode: "BR06",
                targetLabel: "BR06",
                status: "empty",
            }),
            makeRow({
                domain: "intervention",
                targetId: 3,
                targetCode: "BR07",
                targetLabel: "BR07",
                disabledAt: "2026-04-02T10:00:00.000Z",
                disabledReason: "Viatura fora de linha",
                disabledDuringShift: true,
                disabledEntireShift: true,
                status: "disabled",
            }),
        ],
    });

    const model = buildHistoricalOperationalBoardModel(board);

    assert.deepEqual(
        model.regulation.map((row) => row.targetCode),
        ["2031", "2032", "1322", "1366", "PIAM", "NUCLEO"],
    );
    assert.deepEqual(
        model.intervention.map((row) => row.targetCode),
        ["BR05", "BR06", "BR07"],
    );
    assert.equal(model.regulation.find((row) => row.targetCode === "1322")?.state, "vacant");
    assert.equal(model.regulation.find((row) => row.targetCode === "1322")?.doctorLabel, "Sem medico");
    assert.equal(model.targetOptions.regulation.some((row) => row.targetCode === "1322"), true);
    assert.equal(model.summary.regulation.chiefStatus, "ok");
    assert.equal(model.summary.regulation.nucleoStatus, "vacant");
    assert.equal(model.summary.regulation.piamStatus, "vacant");
    assert.deepEqual(model.summary.regulation.pendingRequiredCodes, ["PIAM", "NUCLEO"]);
    assert.equal(model.summary.intervention.occupiedCount, 1);
    assert.equal(model.summary.intervention.vacantCount, 1);
    assert.equal(model.summary.intervention.disabledCount, 1);
    assert.deepEqual(model.summary.pending.vacantReview, ["1322", "PIAM", "NUCLEO", "BR06"]);
    assert.ok(model.summary.pending.vacantReview.includes("PIAM"));
    assert.ok(model.summary.pending.coverageIssues.some((issue) => issue.startsWith("1366:")));
    assert.equal(model.regulation.find((row) => row.targetCode === "1366")?.isRelocated, true);
    assert.equal(model.regulation.find((row) => row.targetCode === "2032")?.doctorLabel, "Ramal desativado");
    assert.deepEqual(
        model.regulation.find((row) => row.targetCode === "1366")?.contextHints,
        ["Desativado às 15:00", "Remanejado 2031 -> 1366", "Correção manual"],
    );
    assert.equal(model.summary.relevantPending.totalItems, 4);
    assert.equal(model.summary.relevantPending.regulationBelowExpected, true);
    assert.equal(model.summary.relevantPending.interventionBelowExpected, true);
    assert.deepEqual(
        model.summary.relevantPending.items.map((item) => `${item.priority}:${item.targetCode}`),
        ["critical:BR06", "warning:REGULACAO", "warning:PIAM", "warning:NUCLEO"],
    );
});