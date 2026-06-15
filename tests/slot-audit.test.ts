import assert from "node:assert/strict";
import test from "node:test";
import { buildTelegramSlotAuditMessages } from "@/modules/telegram/slot-audit-report";
import { isTelegramSlotAuditCommandText, parseTelegramSlotAuditCommand } from "@/modules/telegram/slot-audit-commands";
import { buildOperationalSlotAuditReport } from "@/services/slot-audit.service";
import { buildOperationalSlotPresenceBoardModel, type OperationalSlotPresenceBoard } from "@/services/board.service";

function makeBoard(overrides: Partial<OperationalSlotPresenceBoard> = {}): OperationalSlotPresenceBoard {
    return {
        generatedAt: "2026-04-03T11:00:00.000Z",
        operationalDate: "2026-04-02T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-04-02T10:00:00.000Z",
        endedAt: "2026-04-02T22:00:00.000Z",
        summary: {
            totalTargets: 9,
            occupiedCount: 3,
            emptyCount: 5,
            disabledCount: 1,
        },
        regulation: [
            {
                domain: "regulation",
                status: "occupied",
                targetCode: "1324",
                targetLabel: "1324",
                sortOrder: 1,
                defaultRole: "MR",
                doctorId: "doc-reg-2",
                doctorName: "Elisabeth Martinez",
                displayName: null,
                doctorLabel: "Elisabeth Martinez",
                occupantLabels: ["Elisabeth Martinez"],
                occupancyIds: ["reg-2"],
                occupancyCount: 1,
            },
            {
                domain: "regulation",
                status: "occupied",
                targetCode: "2031",
                targetLabel: "2031",
                sortOrder: 1,
                defaultRole: "MR",
                doctorId: "doc-reg-1",
                doctorName: "Bruno Lima",
                displayName: "Bruno",
                doctorLabel: "Bruno",
                occupantLabels: ["Bruno"],
                occupancyIds: ["reg-1"],
                occupancyCount: 1,
            },
            {
                domain: "regulation",
                status: "empty",
                targetCode: "1322",
                targetLabel: "1322",
                sortOrder: 2,
                defaultRole: "MR",
                doctorId: null,
                doctorName: null,
                displayName: null,
                doctorLabel: "Sem medico",
                occupantLabels: [],
                occupancyIds: [],
                occupancyCount: 0,
            },
            {
                domain: "regulation",
                status: "empty",
                targetCode: "PIAM",
                targetLabel: "PIAM",
                sortOrder: 98,
                defaultRole: "MR",
                doctorId: null,
                doctorName: null,
                displayName: null,
                doctorLabel: "Sem medico",
                occupantLabels: [],
                occupancyIds: [],
                occupancyCount: 0,
            },
            {
                domain: "regulation",
                status: "empty",
                targetCode: "NUCLEO",
                targetLabel: "NUCLEO",
                sortOrder: 99,
                defaultRole: "MR",
                doctorId: null,
                doctorName: null,
                displayName: null,
                doctorLabel: "Sem medico",
                occupantLabels: [],
                occupancyIds: [],
                occupancyCount: 0,
            },
        ],
        intervention: [
            {
                domain: "intervention",
                status: "occupied",
                targetCode: "BR05",
                targetLabel: "BR05",
                sortOrder: 1,
                defaultRole: null,
                doctorId: "doc-int-1",
                doctorName: "Fulano Auditor",
                displayName: null,
                doctorLabel: "Fulano Auditor",
                occupantLabels: ["Fulano Auditor"],
                occupancyIds: ["int-1"],
                occupancyCount: 1,
            },
            {
                domain: "intervention",
                status: "empty",
                targetCode: "NUCLEO",
                targetLabel: "Nucleo",
                sortOrder: 10,
                defaultRole: null,
                doctorId: null,
                doctorName: null,
                displayName: null,
                doctorLabel: "Sem medico",
                occupantLabels: [],
                occupancyIds: [],
                occupancyCount: 0,
            },
            {
                domain: "intervention",
                status: "empty",
                targetCode: "CZ50",
                targetLabel: "CZ50",
                sortOrder: 11,
                defaultRole: null,
                doctorId: null,
                doctorName: null,
                displayName: null,
                doctorLabel: "Sem medico",
                occupantLabels: [],
                occupancyIds: [],
                occupancyCount: 0,
            },
            {
                domain: "intervention",
                status: "disabled",
                targetCode: "PIAM",
                targetLabel: "PIAM",
                sortOrder: 12,
                defaultRole: null,
                disabledEntireShift: true,
                disabledDuringShift: true,
                disabledAt: "2026-04-02T09:40:00.000Z",
                disabledReason: "Manutencao",
                doctorId: null,
                doctorName: null,
                displayName: null,
                doctorLabel: "Base desativada",
                occupantLabels: [],
                occupancyIds: [],
                occupancyCount: 0,
            },
        ],
        ...overrides,
    };
}

test("parseTelegramSlotAuditCommand reconhece o comando sem argumentos", () => {
    assert.equal(isTelegramSlotAuditCommandText("/slots"), true);
    assert.deepEqual(parseTelegramSlotAuditCommand("/slots"), {
        name: "slot_audit",
        startDate: null,
        endDate: null,
        shiftLabel: null,
        rawBody: "",
    });
});

test("parseTelegramSlotAuditCommand aceita data unica, faixa e turno", () => {
    assert.deepEqual(parseTelegramSlotAuditCommand("/slots 2026-04-02"), {
        name: "slot_audit",
        startDate: "2026-04-02",
        endDate: "2026-04-02",
        shiftLabel: null,
        rawBody: "2026-04-02",
    });

    assert.deepEqual(parseTelegramSlotAuditCommand("/slots 2026-04-02 SD"), {
        name: "slot_audit",
        startDate: "2026-04-02",
        endDate: "2026-04-02",
        shiftLabel: "SD",
        rawBody: "2026-04-02 SD",
    });

    assert.deepEqual(parseTelegramSlotAuditCommand("/slots 2026-04-01 2026-04-03 SN"), {
        name: "slot_audit",
        startDate: "2026-04-01",
        endDate: "2026-04-03",
        shiftLabel: "SN",
        rawBody: "2026-04-01 2026-04-03 SN",
    });
});

test("buildOperationalSlotAuditReport separa ocupados, vazios e desativados", () => {
    const report = buildOperationalSlotAuditReport({
        startDate: "2026-04-02",
        endDate: "2026-04-02",
        shiftLabel: null,
        boards: [makeBoard()],
    });

    assert.equal(report.summary.slotCount, 1);
    assert.equal(report.summary.occupiedCount, 3);
    assert.equal(report.summary.emptyCount, 5);
    assert.equal(report.summary.disabledCount, 1);
    assert.equal(report.slots[0]?.regulation[0]?.doctorLabel, "Elisabeth Martinez");
    assert.equal(report.slots[0]?.regulation[2]?.doctorLabel, "Sem medico");
    assert.equal(report.slots[0]?.intervention[3]?.doctorLabel, "Base desativada");
});

test("buildTelegramSlotAuditMessages monta um quadro de auditoria por turno com blocos e resumos", () => {
    const report = buildOperationalSlotAuditReport({
        startDate: "2026-04-02",
        endDate: "2026-04-02",
        shiftLabel: null,
        boards: [makeBoard()],
    });

    const messages = buildTelegramSlotAuditMessages(report);
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? "", /🧭 Slots/);
    assert.match(messages[0] ?? "", /Turnos 1 \| postos 9 \| alocados 3 \| vazios 5/);
    assert.match(messages[0] ?? "", /☎️ Vazios Regulação: 3/);
    assert.match(messages[0] ?? "", /🚑 Vazios Intervenção: 2/);
    assert.match(messages[0] ?? "", /🕐 SD \| 02\/04\/2026/);
    assert.match(messages[0] ?? "", /☎️ Regulação/);
    assert.match(messages[0] ?? "", /✅ Com médico \(2\)/);
    assert.match(messages[0] ?? "", /⚪ Sem médico \(3\)/);
    assert.match(messages[0] ?? "", /🚑 Intervenção/);
    assert.match(messages[0] ?? "", /✅ Com médico \(1\)/);
    assert.match(messages[0] ?? "", /🚨 Sem médico \(2\)/);
    assert.match(messages[0] ?? "", /⚫ DESATIVADAS \(1\)/);
    assert.match(messages[0] ?? "", /2031 \| Bruno/);
    assert.match(messages[0] ?? "", /1324 \| Elisabeth Martinez/);
    assert.match(messages[0] ?? "", /• 1322/);
    assert.match(messages[0] ?? "", /• PIAM/);
    assert.match(messages[0] ?? "", /• NUCLEO/);
    assert.match(messages[0] ?? "", /🚑✅ BR05 \| Fulano Auditor/);
    assert.match(messages[0] ?? "", /🚨🚑 CZ50/);
    assert.match(messages[0] ?? "", /🚨🚑 NUCLEO/);
    assert.match(messages[0] ?? "", /⚫ PIAM \| DESATIVADA \(Manutencao\)/);
    assert.match(messages[0] ?? "", /Resumo SD:/);
    assert.match(messages[0] ?? "", /- Regulação ocupados: 2/);
    assert.match(messages[0] ?? "", /- Regulação vazios: 3/);
    assert.match(messages[0] ?? "", /- Intervenção ocupados: 1/);
    assert.match(messages[0] ?? "", /- Intervenção vazios: 2/);

    const text = messages[0] ?? "";
    assert.ok(text.indexOf("• 1322") < text.indexOf("• PIAM"));
    assert.ok(text.indexOf("• PIAM") < text.indexOf("• NUCLEO"));
    assert.ok(text.indexOf("🚑✅ BR05") < text.indexOf("🚨🚑 CZ50"));
});

test("buildOperationalSlotAuditReport mantém ocupação real do slot mesmo com mais de um médico no alvo", () => {
    const report = buildOperationalSlotAuditReport({
        startDate: "2026-04-02",
        endDate: "2026-04-02",
        shiftLabel: "SD",
        boards: [makeBoard({
            intervention: [
                {
                    domain: "intervention",
                    status: "occupied",
                    targetCode: "PM04",
                    targetLabel: "PM04",
                    sortOrder: 4,
                    defaultRole: null,
                    doctorId: "doc-a",
                    doctorName: "Ana Souza",
                    displayName: "Ana",
                    doctorLabel: "Ana -> Bruno",
                    occupantLabels: ["Ana", "Bruno"],
                    occupancyIds: ["occ-a", "occ-b"],
                    occupancyCount: 2,
                },
            ],
            regulation: [],
            summary: {
                totalTargets: 1,
                occupiedCount: 1,
                emptyCount: 0,
                disabledCount: 0,
            },
        })],
    });

    assert.equal(report.summary.occupiedCount, 1);
    assert.equal(report.slots[0]?.intervention[0]?.doctorLabel, "Ana -> Bruno");
});

test("buildOperationalSlotPresenceBoardModel mantém a PM40 ativa com Leonardo Prado Faben como sombra", () => {
    const board = buildOperationalSlotPresenceBoardModel({
        targets: [{
            domain: "intervention",
            targetId: 40,
            targetCode: "PM40",
            targetLabel: "PM40",
            sortOrder: 40,
            defaultRole: null,
        }],
        rawRows: [
            {
                occupancyId: "occ-titular",
                domain: "intervention",
                targetCode: "PM40",
                targetLabel: "PM40",
                doctorId: "doc-titular",
                doctorName: "Titular PM40",
                displayName: null,
                startedAt: "2026-04-28T10:00:00.000Z",
                boardStartedAt: "2026-04-28T10:00:00.000Z",
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: "2026-04-28T10:00:00.000Z",
                scheduledEndAt: "2026-04-28T22:00:00.000Z",
                continuityGroupId: "cg-titular",
                shiftLabel: "SD",
                roleLabel: null,
                ramalLabel: null,
                arrivalDelayMinutes: null,
                overtimeMinutes: null,
                creditedOvertimeMinutes: null,
                balanceMinutes: null,
                ruleCode: null,
                bankHoursExplanation: null,
                source: "telegram",
                notes: "Titular PM40 07:00",
                createdAt: null,
            },
            {
                occupancyId: "occ-shadow",
                domain: "intervention",
                targetCode: "PM40",
                targetLabel: "PM40",
                doctorId: "doc-shadow",
                doctorName: "Leonardo Prado Faben",
                displayName: null,
                startedAt: "2026-04-28T10:10:00.000Z",
                boardStartedAt: null,
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: "2026-04-28T10:00:00.000Z",
                scheduledEndAt: "2026-04-28T22:00:00.000Z",
                continuityGroupId: "cg-shadow",
                shiftLabel: "SD",
                roleLabel: null,
                ramalLabel: null,
                arrivalDelayMinutes: null,
                overtimeMinutes: null,
                creditedOvertimeMinutes: null,
                balanceMinutes: null,
                ruleCode: null,
                bankHoursExplanation: null,
                source: "telegram",
                notes: "[telegram sombra] Leonardo Prado Faben PM40 07:10 sombra",
                createdAt: null,
            },
        ],
        operationalDate: "2026-04-28T12:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-04-28T10:00:00.000Z",
        endedAt: "2026-04-28T22:00:00.000Z",
    });

    assert.equal(board.intervention[0]?.doctorName, "Titular PM40");
    assert.deepEqual(board.intervention[0]?.occupantLabels, ["Titular PM40", "Leonardo Prado Faben (sombra)"]);
    assert.equal(board.intervention[0]?.occupancyCount, 2);
});

test("buildOperationalSlotPresenceBoardModel prioriza o titular do slot quando ha P herdado encerrando as 07:13", () => {
    const board = buildOperationalSlotPresenceBoardModel({
        targets: [{
            domain: "regulation",
            targetId: 2031,
            targetCode: "2031",
            targetLabel: "Ramal 2031",
            sortOrder: 1,
            defaultRole: "MR",
        }],
        rawRows: [
            {
                occupancyId: "occ-cecilia-p",
                domain: "regulation",
                targetCode: "2031",
                targetLabel: "Ramal 2031",
                doctorId: "doc-cecilia",
                doctorName: "Cecilia Veiga Malheiros Gil Braz",
                displayName: null,
                startedAt: "2026-04-28T10:35:00.000Z",
                boardStartedAt: "2026-04-28T10:35:00.000Z",
                endedAt: "2026-04-29T10:13:00.000Z",
                actualEndedAt: null,
                scheduledStartAt: "2026-04-28T10:00:00.000Z",
                scheduledEndAt: "2026-04-29T10:00:00.000Z",
                continuityGroupId: "cg-cecilia",
                shiftLabel: "P",
                roleLabel: "MR",
                ramalLabel: "2031",
                arrivalDelayMinutes: 35,
                overtimeMinutes: 13,
                creditedOvertimeMinutes: 13,
                balanceMinutes: 0,
                ruleCode: "continuity_p_shift",
                bankHoursExplanation: null,
                source: "telegram",
                notes: "P herdado do dia anterior",
                createdAt: null,
            },
            {
                occupancyId: "occ-carolina-sd",
                domain: "regulation",
                targetCode: "2031",
                targetLabel: "Ramal 2031",
                doctorId: "doc-carolina",
                doctorName: "Carolina Tanajura Monteiro",
                displayName: null,
                startedAt: "2026-04-29T10:13:00.000Z",
                boardStartedAt: "2026-04-29T10:13:00.000Z",
                endedAt: "2026-04-29T22:15:00.000Z",
                actualEndedAt: null,
                scheduledStartAt: "2026-04-29T10:00:00.000Z",
                scheduledEndAt: "2026-04-29T22:00:00.000Z",
                continuityGroupId: "cg-carolina",
                shiftLabel: "SD",
                roleLabel: "MR",
                ramalLabel: "2031",
                arrivalDelayMinutes: 13,
                overtimeMinutes: 15,
                creditedOvertimeMinutes: 15,
                balanceMinutes: 0,
                ruleCode: "standard",
                bankHoursExplanation: null,
                source: "telegram",
                notes: "Titular do SD",
                createdAt: null,
            },
        ],
        operationalDate: "2026-04-29T12:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-04-29T10:00:00.000Z",
        endedAt: "2026-04-29T22:00:00.000Z",
    });

    assert.equal(board.regulation[0]?.doctorName, "Carolina Tanajura Monteiro");
    assert.equal(board.regulation[0]?.doctorLabel, "Carolina Tanajura Monteiro");
    assert.deepEqual(board.regulation[0]?.occupantLabels, ["Carolina Tanajura Monteiro"]);
    assert.equal(board.regulation[0]?.occupancyCount, 1);
});