import assert from "node:assert/strict";
import test from "node:test";
import {
    applyMealBreakContinuityStarts,
    applyMealBreakReply,
    buildMealBreakConsistencyAdminReply,
    buildMealBreakPriorityReply,
    buildMealBreakPriorityReplyMessages,
    buildMealBreakRoster,
    buildMealBreakStageKeyboard,
    createMealBreakSession,
    getCurrentMealBreakPriorityView,
    isTelegramMealBreakCommandText,
    isTelegramMealBreakExcludeCommandText,
    isTelegramMealBreakPriorityCommandText,
    parseTelegramMealBreakCommand,
    parseTelegramMealBreakExcludeCommand,
    parseTelegramMealBreakPriorityCommand,
    resolveMealBreakContinuityStartedAt,
    resolveMealBreakLunchCapacities,
    reconcileMealBreakSessionRamalsWithBoard,
    resolveMealBreakEligibilityExclusions,
    reconcileNightMealBreakSessionWithBoard,
    resolveMealBreakTurnNudgeAction,
    shouldPreferMealBreakReplyForSession,
    syncDaySessionState,
} from "@/modules/telegram/meal-breaks";

function makeBoard(): Parameters<typeof buildMealBreakRoster>[0] {
    return {
        generatedAt: "2026-03-29T12:05:00.000Z",
        regulation: [
            {
                postId: 1,
                occupancyId: "reg-2031",
                postCode: "2031",
                postLabel: "2031",
                defaultRole: "MR",
                doctorId: "doc-chief",
                doctorName: "Bruno Chefe",
                displayName: "Bruno",
                startedAt: "2026-03-29T10:00:00.000Z",
                boardStartedAt: "2026-03-29T10:00:00.000Z",
                scheduledEndAt: "2026-03-29T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: "MR",
                ramalLabel: "2031",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 2,
                occupancyId: "reg-2032",
                postCode: "2032",
                postLabel: "2032",
                defaultRole: "MRV",
                doctorId: "doc-mrv-1",
                doctorName: "Marina Costa",
                displayName: "Marina",
                startedAt: "2026-03-29T10:01:00.000Z",
                boardStartedAt: "2026-03-29T10:01:00.000Z",
                scheduledEndAt: "2026-03-29T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: "MRV",
                ramalLabel: "2032",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 3,
                occupancyId: "reg-2151",
                postCode: "2151",
                postLabel: "2151",
                defaultRole: "MRV",
                doctorId: "doc-mrv-2",
                doctorName: "Carlos Melo",
                displayName: "Carlos",
                startedAt: "2026-03-29T10:02:00.000Z",
                boardStartedAt: "2026-03-29T10:02:00.000Z",
                scheduledEndAt: "2026-03-29T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: "MRV",
                ramalLabel: "2151",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 4,
                occupancyId: "reg-2035",
                postCode: "2035",
                postLabel: "2035",
                defaultRole: "MR",
                doctorId: "doc-2035",
                doctorName: "Renata Lima",
                displayName: "Renata",
                startedAt: "2026-03-29T10:03:00.000Z",
                boardStartedAt: "2026-03-29T10:03:00.000Z",
                scheduledEndAt: "2026-03-29T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: null,
                ramalLabel: "2035",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 6,
                occupancyId: "reg-2036",
                postCode: "2036",
                postLabel: "2036",
                defaultRole: "MR",
                doctorId: "doc-2036",
                doctorName: "Beatriz Rocha",
                displayName: "Bia",
                startedAt: "2026-03-29T10:04:00.000Z",
                boardStartedAt: "2026-03-29T10:04:00.000Z",
                scheduledEndAt: "2026-03-29T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: null,
                ramalLabel: "2036",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 7,
                occupancyId: "reg-2037",
                postCode: "2037",
                postLabel: "2037",
                defaultRole: "MR",
                doctorId: "doc-2037",
                doctorName: "Marcos Prado",
                displayName: "Marcos",
                startedAt: "2026-03-29T10:05:00.000Z",
                boardStartedAt: "2026-03-29T10:05:00.000Z",
                scheduledEndAt: "2026-03-29T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: null,
                ramalLabel: "2037",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 8,
                occupancyId: "reg-2038",
                postCode: "2038",
                postLabel: "2038",
                defaultRole: "MR",
                doctorId: "doc-2038",
                doctorName: "Igor Teixeira",
                displayName: "Igor",
                startedAt: "2026-03-29T10:06:00.000Z",
                boardStartedAt: "2026-03-29T10:06:00.000Z",
                scheduledEndAt: "2026-03-29T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: null,
                ramalLabel: "2038",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 9,
                occupancyId: "reg-2039",
                postCode: "2039",
                postLabel: "2039",
                defaultRole: "MR",
                doctorId: "doc-2039",
                doctorName: "Patricia Paiva",
                displayName: "Patricia",
                startedAt: "2026-03-29T10:07:00.000Z",
                boardStartedAt: "2026-03-29T10:07:00.000Z",
                scheduledEndAt: "2026-03-29T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: null,
                ramalLabel: "2039",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 5,
                occupancyId: "reg-night",
                postCode: "2040",
                postLabel: "2040",
                defaultRole: "MR",
                doctorId: "doc-night",
                doctorName: "Noite Fora",
                displayName: "Noite",
                startedAt: "2026-03-29T08:30:00.000Z",
                boardStartedAt: "2026-03-29T08:30:00.000Z",
                scheduledEndAt: "2026-03-29T10:00:00.000Z",
                shiftLabel: "SN",
                roleLabel: "MR",
                ramalLabel: "2040",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
        ],
        intervention: [
            {
                baseId: 1,
                occupancyId: "int-pp20",
                baseCode: "PP20",
                baseLabel: "PP20",
                doctorId: "doc-recip",
                doctorName: "Paula Pires",
                displayName: "Paula",
                startedAt: "2026-03-29T10:03:00.000Z",
                boardStartedAt: "2026-03-29T10:03:00.000Z",
                scheduledEndAt: "2026-03-29T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: null,
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                baseId: 2,
                occupancyId: "int-br05",
                baseCode: "BR05",
                baseLabel: "BR05",
                doctorId: "doc-br05",
                doctorName: "Beatriz Rocha",
                displayName: "Bia",
                startedAt: "2026-03-29T10:04:00.000Z",
                boardStartedAt: "2026-03-29T10:04:00.000Z",
                scheduledEndAt: "2026-03-29T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: null,
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                baseId: 3,
                occupancyId: "int-pm04",
                baseCode: "PM04",
                baseLabel: "PM04",
                doctorId: "doc-pm04",
                doctorName: "Marcos Prado",
                displayName: "Marcos",
                startedAt: "2026-03-29T10:05:00.000Z",
                boardStartedAt: "2026-03-29T10:05:00.000Z",
                scheduledEndAt: "2026-03-29T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: null,
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                baseId: 4,
                occupancyId: "int-it30",
                baseCode: "IT30",
                baseLabel: "IT30",
                doctorId: "doc-it30",
                doctorName: "Igor Teixeira",
                displayName: "Igor",
                startedAt: "2026-03-29T10:06:00.000Z",
                boardStartedAt: "2026-03-29T10:06:00.000Z",
                scheduledEndAt: "2026-03-29T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: null,
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                baseId: 5,
                occupancyId: "int-pp30",
                baseCode: "PP30",
                baseLabel: "PP30",
                doctorId: "doc-pp30",
                doctorName: "Patricia Paiva",
                displayName: "Patricia",
                startedAt: "2026-03-29T10:07:00.000Z",
                boardStartedAt: "2026-03-29T10:07:00.000Z",
                scheduledEndAt: "2026-03-29T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: null,
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
        ],
    };
}

function makeNightBoard(): Parameters<typeof buildMealBreakRoster>[0] {
    return {
        generatedAt: "2026-03-29T23:05:00.000Z",
        regulation: [
            {
                postId: 1,
                occupancyId: "reg-night-2031",
                postCode: "2031",
                postLabel: "2031",
                defaultRole: "MR",
                doctorId: "doc-night-chief",
                doctorName: "Bruno Chefe",
                displayName: "Bruno",
                startedAt: "2026-03-29T23:50:00.000Z",
                boardStartedAt: "2026-03-29T23:50:00.000Z",
                scheduledEndAt: "2026-03-30T11:00:00.000Z",
                shiftLabel: "SN",
                roleLabel: "CP",
                ramalLabel: "2031",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 2,
                occupancyId: "reg-night-2032",
                postCode: "2032",
                postLabel: "2032",
                defaultRole: "MR",
                doctorId: "doc-night-2032",
                doctorName: "Marina Costa",
                displayName: "Marina",
                startedAt: "2026-03-29T12:00:00.000Z",
                boardStartedAt: "2026-03-29T12:00:00.000Z",
                scheduledEndAt: "2026-03-30T11:00:00.000Z",
                shiftLabel: "P",
                roleLabel: "MRV",
                ramalLabel: "2032",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 3,
                occupancyId: "reg-night-2033",
                postCode: "2033",
                postLabel: "2033",
                defaultRole: "MR",
                doctorId: "doc-night-2033",
                doctorName: "Carlos Melo",
                displayName: "Carlos",
                startedAt: "2026-03-29T12:01:00.000Z",
                boardStartedAt: "2026-03-29T12:01:00.000Z",
                scheduledEndAt: "2026-03-30T11:00:00.000Z",
                shiftLabel: "P",
                roleLabel: null,
                ramalLabel: "2033",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 4,
                occupancyId: "reg-night-2034",
                postCode: "2034",
                postLabel: "2034",
                defaultRole: "MR",
                doctorId: "doc-night-2034",
                doctorName: "Renata Lima",
                displayName: "Renata",
                startedAt: "2026-03-29T23:00:00.000Z",
                boardStartedAt: "2026-03-29T23:00:00.000Z",
                scheduledEndAt: "2026-03-30T11:00:00.000Z",
                shiftLabel: "SN",
                roleLabel: null,
                ramalLabel: "2034",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 5,
                occupancyId: "reg-night-2035",
                postCode: "2035",
                postLabel: "2035",
                defaultRole: "MR",
                doctorId: "doc-night-2035",
                doctorName: "Beatriz Rocha",
                displayName: "Bia",
                startedAt: "2026-03-29T23:01:00.000Z",
                boardStartedAt: "2026-03-29T23:01:00.000Z",
                scheduledEndAt: "2026-03-30T11:00:00.000Z",
                shiftLabel: "SN",
                roleLabel: null,
                ramalLabel: "2035",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 6,
                occupancyId: "reg-night-2036",
                postCode: "2036",
                postLabel: "2036",
                defaultRole: "MR",
                doctorId: "doc-night-2036",
                doctorName: "Marcos Prado",
                displayName: "Marcos",
                startedAt: "2026-03-29T23:02:00.000Z",
                boardStartedAt: "2026-03-29T23:02:00.000Z",
                scheduledEndAt: "2026-03-30T11:00:00.000Z",
                shiftLabel: "SN",
                roleLabel: null,
                ramalLabel: "2036",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 7,
                occupancyId: "reg-night-2037",
                postCode: "2037",
                postLabel: "2037",
                defaultRole: "MR",
                doctorId: "doc-night-2037",
                doctorName: "Igor Teixeira",
                displayName: "Igor",
                startedAt: "2026-03-29T23:03:00.000Z",
                boardStartedAt: "2026-03-29T23:03:00.000Z",
                scheduledEndAt: "2026-03-30T11:00:00.000Z",
                shiftLabel: "SN",
                roleLabel: null,
                ramalLabel: "2037",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 8,
                occupancyId: "reg-night-2038",
                postCode: "2038",
                postLabel: "2038",
                defaultRole: "MR",
                doctorId: "doc-night-2038",
                doctorName: "Patricia Paiva",
                displayName: "Patricia",
                startedAt: "2026-03-29T23:04:00.000Z",
                boardStartedAt: "2026-03-29T23:04:00.000Z",
                scheduledEndAt: "2026-03-30T11:00:00.000Z",
                shiftLabel: "SN",
                roleLabel: null,
                ramalLabel: "2038",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 9,
                occupancyId: "reg-night-2039",
                postCode: "2039",
                postLabel: "2039",
                defaultRole: "MR",
                doctorId: "doc-night-2039",
                doctorName: "Paula Pires",
                displayName: "Paula",
                startedAt: "2026-03-29T23:05:00.000Z",
                boardStartedAt: "2026-03-29T23:05:00.000Z",
                scheduledEndAt: "2026-03-30T11:00:00.000Z",
                shiftLabel: "SN",
                roleLabel: null,
                ramalLabel: "2039",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 10,
                occupancyId: "reg-day-2040",
                postCode: "2040",
                postLabel: "2040",
                defaultRole: "MR",
                doctorId: "doc-day-2040",
                doctorName: "Fora do fluxo",
                displayName: "Fora",
                startedAt: "2026-03-29T15:00:00.000Z",
                boardStartedAt: "2026-03-29T15:00:00.000Z",
                scheduledEndAt: "2026-03-29T23:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: null,
                ramalLabel: "2040",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
        ],
        intervention: [],
    };
}

test("resolveMealBreakLunchCapacities segue a distribuicao proporcional esperada", () => {
    assert.deepEqual(resolveMealBreakLunchCapacities(11), { "11:30": 4, "12:30": 3, "13:30": 4 });
    assert.deepEqual(resolveMealBreakLunchCapacities(10), { "11:30": 4, "12:30": 3, "13:30": 3 });
    assert.deepEqual(resolveMealBreakLunchCapacities(8), { "11:30": 3, "12:30": 2, "13:30": 3 });
    assert.deepEqual(resolveMealBreakLunchCapacities(5), { "11:30": 2, "12:30": 1, "13:30": 2 });
});

test("parseTelegramMealBreakCommand reconhece o comando e o reinicio", () => {
    assert.equal(isTelegramMealBreakCommandText("/almoco"), true);
    assert.equal(isTelegramMealBreakCommandText("/almoço"), true);
    assert.equal(isTelegramMealBreakCommandText("/almoco reiniciar"), true);
    assert.equal(isTelegramMealBreakCommandText("/almoço reiniciar"), true);
    assert.equal(isTelegramMealBreakCommandText("/jantar"), true);
    assert.deepEqual(parseTelegramMealBreakCommand("/almoco"), {
        name: "meal_break",
        mode: "day",
        forceRestart: false,
        rawBody: "",
    });
    assert.deepEqual(parseTelegramMealBreakCommand("/almoço"), {
        name: "meal_break",
        mode: "day",
        forceRestart: false,
        rawBody: "",
    });
    assert.deepEqual(parseTelegramMealBreakCommand("/almoco reiniciar"), {
        name: "meal_break",
        mode: "day",
        forceRestart: true,
        rawBody: "reiniciar",
    });
    assert.deepEqual(parseTelegramMealBreakCommand("/almoço reiniciar"), {
        name: "meal_break",
        mode: "day",
        forceRestart: true,
        rawBody: "reiniciar",
    });
    assert.deepEqual(parseTelegramMealBreakCommand("/jantar reiniciar"), {
        name: "meal_break",
        mode: "night",
        forceRestart: true,
        rawBody: "reiniciar",
    });
    assert.equal(parseTelegramMealBreakCommand("/almoco agora"), null);
});

test("parseTelegramMealBreakPriorityCommand reconhece singular e plural", () => {
    assert.equal(isTelegramMealBreakPriorityCommandText("/prioridade"), true);
    assert.equal(isTelegramMealBreakPriorityCommandText("/prioridades"), true);
    assert.deepEqual(parseTelegramMealBreakPriorityCommand("/prioridade"), {
        name: "meal_break_priority",
        rawBody: "",
    });
    assert.deepEqual(parseTelegramMealBreakPriorityCommand("/prioridades"), {
        name: "meal_break_priority",
        rawBody: "",
    });
    assert.equal(parseTelegramMealBreakPriorityCommand("/prioridades agora"), null);
});

test("buildMealBreakPriorityReply resume motivos apenas quando fogem da ordem simples", () => {
    const reply = buildMealBreakPriorityReply({
        mode: "night",
        operationalDate: "2026-03-29",
        updatedAt: "2026-03-29T23:10:00.000Z",
        chiefRamal: "2031",
        mrvRamals: ["2032", "2151"],
        warnings: [],
        entries: [
            {
                rank: 1,
                automaticRank: 1,
                ramal: "2033",
                name: "Leo Marins",
                roleLabel: null,
                shiftLabel: "P",
                actualStartedAt: "2026-03-29T22:00:00.000Z",
                continuityStartedAt: "2026-03-29T10:00:00.000Z",
                priorityStartedAt: "2026-03-29T10:00:00.000Z",
                automaticReasons: ["continua desde 07:00 em outro plantao"],
                manualJustification: null,
                explanation: "continua desde 07:00 em outro plantao",
            },
            {
                rank: 2,
                automaticRank: 2,
                ramal: "1361",
                name: "Remoto Fixo",
                roleLabel: "RMT",
                shiftLabel: "P",
                actualStartedAt: "2026-03-29T22:00:00.000Z",
                continuityStartedAt: null,
                priorityStartedAt: "2026-03-29T22:15:00.000Z",
                automaticReasons: ["RMT fixo, entra como 19:15"],
                manualJustification: {
                    notes: "mantido abaixo dos presenciais",
                    actorUserId: "chief-1",
                    updatedAt: "2026-03-29T23:11:00.000Z",
                },
                explanation: "chefia: mantido abaixo dos presenciais; RMT fixo, entra como 19:15",
            },
            {
                rank: 3,
                automaticRank: 3,
                ramal: "2036",
                name: "Chegada Simples",
                roleLabel: null,
                shiftLabel: "SN",
                actualStartedAt: "2026-03-30T02:05:00.000Z",
                continuityStartedAt: null,
                priorityStartedAt: "2026-03-30T02:05:00.000Z",
                automaticReasons: [],
                manualJustification: null,
                explanation: null,
            },
        ],
    });

    assert.match(reply, /1\. Leo Marins \| 2033 \| 07:00 \| continua desde 07:00 em outro plantao/);
    assert.match(reply, /2\. Remoto Fixo \| 1361 \| 19:15 \| chefia: mantido abaixo dos presenciais; RMT fixo, entra como 19:15/);
    assert.match(reply, /3\. Chegada Simples \| 2036 \| 23:05/);
    assert.doesNotMatch(reply, /3\. Chegada Simples .*\| .*chefia:/);
});

test("buildMealBreakPriorityReplyMessages quebra a fila longa em blocos menores para o Telegram", () => {
    const messages = buildMealBreakPriorityReplyMessages({
        mode: "day",
        operationalDate: "2026-03-29",
        updatedAt: "2026-03-29T23:10:00.000Z",
        chiefRamal: "2031",
        mrvRamals: ["2032", "2151"],
        warnings: [],
        entries: Array.from({ length: 80 }, (_, index) => ({
            rank: index + 1,
            automaticRank: index + 1,
            ramal: String(1300 + index),
            name: `Medico de Teste ${index + 1} Sobrenome Grande`,
            roleLabel: index % 3 === 0 ? "RMT" : null,
            shiftLabel: "SD" as const,
            actualStartedAt: "2026-03-29T10:00:00.000Z",
            continuityStartedAt: null,
            priorityStartedAt: "2026-03-29T10:00:00.000Z",
            automaticReasons: [],
            manualJustification: null,
            explanation: `linha longa ${index + 1} com justificativa operacional extensa para forcar a quebra do texto e nao estourar o limite do Telegram`,
        })),
    }, 700);

    assert.ok(messages.length > 1);
    for (const message of messages) {
        assert.ok(message.length <= 700);
        assert.match(message, /PRIORIDADES DO ALMOÇO/);
    }
});

test("buildMealBreakRoster monta a fila do diurno sem chefia e sem noturno", () => {
    const roster = buildMealBreakRoster(makeBoard(), new Date("2026-03-29T09:05:00-03:00"));

    assert.equal(roster.chiefRamal, "2031");
    assert.deepEqual(roster.mrvRamals, ["2032", "2151"]);
    assert.deepEqual(roster.roster.map((doctor) => doctor.ramal), ["2032", "2151", "2035", "2036", "2037", "2038", "2039"]);
    assert.equal(roster.roster.find((doctor) => doctor.ramal === "2032")?.roleLabel, "MRV");
    assert.equal(roster.roster.find((doctor) => doctor.ramal === "2032")?.name, "Marina");
    assert.equal(roster.roster.find((doctor) => doctor.ramal === "2036")?.name, "Bia");
    assert.equal(roster.roster.some((doctor) => doctor.ramal === "PP20"), false);
});

test("buildMealBreakRoster deixa ramal remoto sem funcao quando vazio e respeita override explicito", () => {
    const board = makeBoard();
    board.regulation[7] = {
        ...board.regulation[7]!,
        occupancyId: "reg-1361",
        postCode: "1361",
        postLabel: "1361",
        doctorId: "doc-1361",
        doctorName: "Leila Remota",
        displayName: "Leila",
        ramalLabel: "1361",
        roleLabel: null,
    };

    const blankRoster = buildMealBreakRoster(board, new Date("2026-03-29T09:05:00-03:00"));
    assert.equal(blankRoster.roster.find((doctor) => doctor.ramal === "1361")?.roleLabel, null);

    board.regulation[7]!.roleLabel = "RMT";
    const remoteRoster = buildMealBreakRoster(board, new Date("2026-03-29T09:05:00-03:00"));
    assert.equal(remoteRoster.roster.find((doctor) => doctor.ramal === "1361")?.roleLabel, "RMT");

    board.regulation[7]!.roleLabel = "IES";
    const iesRoster = buildMealBreakRoster(board, new Date("2026-03-29T09:05:00-03:00"));
    assert.equal(iesRoster.roster.find((doctor) => doctor.ramal === "1361")?.roleLabel, "IES");
});

test("getCurrentMealBreakPriorityView usa so o quadro atual e aplica piso remoto de 07:15", async () => {
    const board = makeBoard();
    board.regulation[3] = {
        ...board.regulation[3]!,
        startedAt: "2026-03-29T10:10:00.000Z",
        boardStartedAt: "2026-03-29T10:10:00.000Z",
    };
    board.regulation[4] = {
        ...board.regulation[4]!,
        startedAt: "2026-03-29T10:16:00.000Z",
        boardStartedAt: "2026-03-29T10:16:00.000Z",
    };
    board.regulation[7] = {
        ...board.regulation[7]!,
        occupancyId: "reg-1361",
        postCode: "1361",
        postLabel: "1361",
        doctorId: "doc-1361",
        doctorName: "Leila Remota",
        displayName: "Leila",
        startedAt: "2026-03-29T10:01:00.000Z",
        boardStartedAt: "2026-03-29T10:01:00.000Z",
        ramalLabel: "1361",
        roleLabel: "RMT",
    };

    const view = await getCurrentMealBreakPriorityView({
        referenceAt: new Date("2026-03-29T09:05:00-03:00"),
        board,
    });

    const orderedRamals = view.entries.map((entry) => entry.ramal);
    assert.ok(orderedRamals.indexOf("2035") < orderedRamals.indexOf("1361"));
    assert.ok(orderedRamals.indexOf("1361") < orderedRamals.indexOf("2036"));

    const remote = view.entries.find((entry) => entry.ramal === "1361");
    assert.equal(remote?.continuityStartedAt, null);
    assert.equal(remote?.priorityStartedAt, "2026-03-29T10:15:00.000Z");
    assert.deepEqual(remote?.automaticReasons, ["RMT fixo, entra como 07:15"]);
    assert.equal(view.entries.some((entry) => entry.automaticReasons.some((reason) => reason.includes("continua desde"))), false);
});

test("getCurrentMealBreakPriorityView avisa duplicidade e mantem uma unica ocorrencia na fila", async () => {
    const board = makeBoard();
    board.regulation[4] = {
        ...board.regulation[4]!,
        occupancyId: "reg-2036-dup",
        doctorId: "doc-2035",
        doctorName: "Renata Lima",
        displayName: "Renata",
        startedAt: "2026-03-29T10:20:00.000Z",
    };

    const view = await getCurrentMealBreakPriorityView({
        referenceAt: new Date("2026-03-29T09:05:00-03:00"),
        board,
    });

    assert.equal(view.entries.filter((entry) => ["2035", "2036"].includes(entry.ramal)).length, 1);
    assert.equal(view.warnings.length, 1);
    assert.match(view.warnings[0]?.message ?? "", /Renata aparece em mais de um ramal ativo: 2035, 2036\./);
    assert.match(view.warnings[0]?.message ?? "", /A fila vai considerar 2035\./);

    const reply = buildMealBreakPriorityReply(view);
    assert.match(reply, /⚠️ Renata aparece em mais de um ramal ativo: 2035, 2036\. A fila vai considerar 2035\./);
});

test("applyMealBreakReply orders blank remote ramal by normal arrival instead of RMT penalty", () => {
    const board = makeBoard();
    board.regulation[3]!.startedAt = "2026-03-29T10:00:00.000Z";
    board.regulation[3]!.boardStartedAt = "2026-03-29T10:00:00.000Z";
    board.regulation[4]!.startedAt = "2026-03-29T10:10:00.000Z";
    board.regulation[4]!.boardStartedAt = "2026-03-29T10:10:00.000Z";
    board.regulation[5]!.startedAt = "2026-03-29T10:16:00.000Z";
    board.regulation[5]!.boardStartedAt = "2026-03-29T10:16:00.000Z";
    board.regulation[7]!.startedAt = "2026-03-29T10:01:00.000Z";
    board.regulation[7]!.boardStartedAt = "2026-03-29T10:01:00.000Z";
    board.regulation[7]!.roleLabel = null;

    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);

    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    const mrv = applyMealBreakReply({
        session: recip!.session,
        text: "2032",
        senderTelegramId: "101",
        referenceAt,
    });

    assert.deepEqual(mrv?.session.lunchQueue, ["2039", "2038", "2036", "2037"]);
    assert.equal(mrv?.session.roster.find((doctor) => doctor.ramal === "2039")?.roleLabel, null);
});

test("reconcileMealBreakSessionRamalsWithBoard: o horario de almoco segue o medico ao trocar de ramal", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(makeBoard(), referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    // Um plantonista comum (fora de chefia/recip/mrv) com almoco definido no ramal antigo.
    const target = session.roster.find(
        (doctor) => doctor.ramal !== session.chiefRamal && !session.mrvRamals.includes(doctor.ramal),
    )!;
    const oldRamal = target.ramal;
    const withAssignment = {
        ...session,
        lunchAssignments: { ...session.lunchAssignments, [oldRamal]: "12:30" as const },
        restExcludedRamals: [...session.restExcludedRamals, oldRamal],
    };

    // O board ao vivo mostra o mesmo medico (doctorId) num ramal novo: remanejamento.
    const newRamal = "2099";
    const board = makeBoard();
    const movedRow = board.regulation.find((row) => row.doctorId === target.doctorId)!;
    movedRow.postCode = newRamal;
    movedRow.postLabel = newRamal;
    movedRow.ramalLabel = newRamal;

    const reconciled = reconcileMealBreakSessionRamalsWithBoard({ session: withAssignment, board });

    assert.equal(reconciled.lunchAssignments[newRamal], "12:30", "almoco migrou para o ramal novo");
    assert.equal(reconciled.lunchAssignments[oldRamal], undefined, "almoco nao ficou preso ao ramal antigo");
    assert.equal(
        reconciled.roster.find((doctor) => doctor.doctorId === target.doctorId)?.ramal,
        newRamal,
        "o roster passou a refletir o ramal novo do medico",
    );
    assert.equal(
        reconciled.roster.some((doctor) => doctor.ramal === oldRamal),
        false,
        "ninguem ficou no ramal antigo",
    );
    assert.equal(
        reconciled.restExcludedRamals.includes(newRamal),
        true,
        "a exclusao de descanso tambem seguiu para o ramal novo",
    );
    assert.equal(
        reconciled.restExcludedRamals.includes(oldRamal),
        false,
        "a exclusao nao ficou presa ao ramal antigo",
    );
});

test("resolveMealBreakEligibilityExclusions: v2 segue o medico (doctorId) ao trocar de ramal", () => {
    // Exclusao gravada quando o medico estava no 2035; agora ele esta no 2099 (remanejamento).
    const ramalByDoctorId = new Map([["doc-x", "2099"], ["doc-y", "2036"]]);
    const overrides = {
        kind: "telegram_meal_break_eligibility_overrides" as const,
        version: 2 as const,
        mode: "day" as const,
        operationalDate: "2026-03-29",
        lunchExcludedDoctorIds: ["doc-x"],
        restExcludedDoctorIds: ["doc-y"],
        lunchExcludedRamals: ["2035"], // snapshot antigo: deve ser ignorado em favor do doctorId
        restExcludedRamals: ["2036"],
        updatedAt: "2026-03-29T12:00:00.000Z",
    };

    const resolved = resolveMealBreakEligibilityExclusions(overrides, ramalByDoctorId);
    assert.deepEqual(resolved.lunchExcludedRamals, ["2099"], "exclusao de almoco seguiu o medico para o ramal novo");
    assert.deepEqual(resolved.restExcludedRamals, ["2036"], "exclusao de descanso resolvida pelo doctorId");
});

test("resolveMealBreakEligibilityExclusions: doctorId fora do board vivo some da exclusao", () => {
    const ramalByDoctorId = new Map([["doc-y", "2036"]]); // doc-x nao esta mais ativo
    const overrides = {
        kind: "telegram_meal_break_eligibility_overrides" as const,
        version: 2 as const,
        mode: "day" as const,
        operationalDate: "2026-03-29",
        lunchExcludedDoctorIds: ["doc-x", "doc-y"],
        restExcludedDoctorIds: [],
        lunchExcludedRamals: [],
        restExcludedRamals: [],
        updatedAt: "2026-03-29T12:00:00.000Z",
    };

    const resolved = resolveMealBreakEligibilityExclusions(overrides, ramalByDoctorId);
    assert.deepEqual(resolved.lunchExcludedRamals, ["2036"], "apenas medicos ativos no board entram na exclusao");
});

test("resolveMealBreakEligibilityExclusions: registro v1 (legado) devolve os ramais como estao", () => {
    const overrides = {
        kind: "telegram_meal_break_eligibility_overrides" as const,
        version: 1 as const,
        mode: "day" as const,
        operationalDate: "2026-03-29",
        lunchExcludedRamals: ["2035", "2036"],
        restExcludedRamals: ["2037"],
        updatedAt: "2026-03-29T12:00:00.000Z",
    };

    const resolved = resolveMealBreakEligibilityExclusions(overrides, new Map());
    assert.deepEqual(resolved.lunchExcludedRamals, ["2035", "2036"]);
    assert.deepEqual(resolved.restExcludedRamals, ["2037"]);
});

test("resolveMealBreakEligibilityExclusions: sem registro devolve listas vazias", () => {
    const resolved = resolveMealBreakEligibilityExclusions(null, new Map());
    assert.deepEqual(resolved, { lunchExcludedRamals: [], restExcludedRamals: [] });
});

test("reconcileMealBreakSessionRamalsWithBoard: sem troca de ramal devolve a mesma sessao", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(makeBoard(), referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    const reconciled = reconcileMealBreakSessionRamalsWithBoard({ session, board: makeBoard() });
    assert.equal(reconciled, session, "sem remanejamento, a sessao e retornada sem mudancas");
});

test("createMealBreakSession recalcula vagas quando ha ramais dispensados do almoco e do descanso", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(makeBoard(), referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
        lunchExcludedRamals: ["2036"],
        restExcludedRamals: ["2037", "2038"],
    });

    assert.deepEqual(session.lunchCapacities, { "11:30": 2, "12:30": 2, "13:30": 2 });
    assert.deepEqual(session.lunchExcludedRamals, ["2036"]);
    assert.deepEqual(session.restExcludedRamals, ["2037", "2038"]);
});

test("PIAM fica fora da divisao do almoco, das vagas e das escolhas", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const board = makeBoard();
    board.regulation.push({
        postId: 10,
        occupancyId: "reg-piam",
        postCode: "PIAM",
        postLabel: "PIAM",
        defaultRole: null,
        doctorId: "doc-piam",
        doctorName: "Paulo Piam",
        displayName: "Paulo",
        startedAt: "2026-03-29T10:08:00.000Z",
        boardStartedAt: "2026-03-29T10:08:00.000Z",
        scheduledEndAt: "2026-03-29T22:00:00.000Z",
        shiftLabel: "SD",
        roleLabel: null,
        ramalLabel: "PIAM",
        status: "active",
        liveSource: "operations_v2",
        liveUpdatedAt: null,
    });

    const roster = buildMealBreakRoster(board, referenceAt);
    assert.equal(roster.roster.some((doctor) => doctor.ramal === "PIAM"), false);

    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    assert.equal(session.roster.some((doctor) => doctor.ramal === "PIAM"), false);
    assert.deepEqual(session.lunchCapacities, { "11:30": 3, "12:30": 2, "13:30": 2 });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);

    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(recip);

    const mrv = applyMealBreakReply({
        session: recip.session,
        text: "2032",
        senderTelegramId: "101",
        referenceAt,
    });
    assert.ok(mrv);
    assert.equal(mrv.session.lunchQueue.includes("PIAM"), false);
    assert.equal(mrv.session.restQueue.includes("PIAM"), false);
});

test("NUCLEO fica fora de qualquer meal break — não participa de almoço nem descanso", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const board = makeBoard();
    board.regulation.push({
        postId: 20,
        occupancyId: "reg-nucleo",
        postCode: "NUCLEO",
        postLabel: "Nucleo",
        defaultRole: null,
        doctorId: "doc-nucleo",
        doctorName: "Maria Nucleo",
        displayName: "Maria",
        startedAt: "2026-03-29T11:00:00.000Z",
        boardStartedAt: "2026-03-29T11:00:00.000Z",
        scheduledEndAt: "2026-03-29T22:15:00.000Z",
        shiftLabel: "SD",
        roleLabel: null,
        ramalLabel: "NUCLEO",
        status: "active",
        liveSource: "operations_v2",
        liveUpdatedAt: null,
    });

    const roster = buildMealBreakRoster(board, referenceAt);
    assert.equal(roster.roster.some((doctor) => doctor.ramal === "NUCLEO"), false,
        "NUCLEO should not appear in the meal break roster");
});

test("applyMealBreakReply pula ramais dispensados na fila e no descanso", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(makeBoard(), referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
        lunchExcludedRamals: ["2039"],
        restExcludedRamals: ["2037"],
    });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);

    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    const mrv = applyMealBreakReply({
        session: recip!.session,
        text: "2032",
        senderTelegramId: "101",
        referenceAt,
    });

    assert.ok(mrv);
    assert.equal(mrv.session.lunchQueue.includes("2039"), false);

    let currentSession = mrv.session;
    for (const ramal of [...currentSession.lunchQueue]) {
        const next = applyMealBreakReply({
            session: currentSession,
            text: `${ramal} 11:30`,
            senderTelegramId: "102",
            referenceAt,
        });
        assert.ok(next);
        currentSession = next.session;
    }

    assert.equal(currentSession.restAssignments["2037"], undefined);
    assert.equal(currentSession.restQueue.includes("2037"), false);
});

test("PSIQ fica fora da divisao do almoco e recebe 12:30 e 18:00 fixos", async () => {
    const board = makeBoard();
    const psiqIndex = board.regulation.findIndex((entry) => entry.postCode === "2039");
    assert.notEqual(psiqIndex, -1);
    board.regulation[psiqIndex] = {
        ...board.regulation[psiqIndex]!,
        roleLabel: "PSIQ",
        defaultRole: "PSIQ",
    };

    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    assert.equal(roster.roster.find((doctor) => doctor.ramal === "2039")?.roleLabel, "PSIQ");
    assert.deepEqual(session.lunchCapacities, { "11:30": 2, "12:30": 2, "13:30": 2 });
    assert.equal(session.lunchAssignments["2039"], "12:30");
    assert.equal(session.restAssignments["2039"], "18:00");

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);

    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(recip);

    const mrv = applyMealBreakReply({
        session: recip.session,
        text: "2032",
        senderTelegramId: "101",
        referenceAt,
    });
    assert.ok(mrv);
    assert.equal(mrv.session.lunchQueue.includes("2039"), false);
    assert.equal(mrv.session.restQueue.includes("2039"), false);

    const view = await getCurrentMealBreakPriorityView({
        referenceAt,
        board,
    });
    assert.equal(view.entries.some((entry) => entry.ramal === "2039"), false);
});

test("PSIQ nao consome a vaga 12:30 dos demais", () => {
    const board = makeBoard();
    const psiqIndex = board.regulation.findIndex((entry) => entry.postCode === "2039");
    assert.notEqual(psiqIndex, -1);
    board.regulation[psiqIndex] = {
        ...board.regulation[psiqIndex]!,
        roleLabel: "PSIQ",
        defaultRole: "PSIQ",
    };

    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);

    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(recip);

    const mrv = applyMealBreakReply({
        session: recip.session,
        text: "2032",
        senderTelegramId: "101",
        referenceAt,
    });
    assert.ok(mrv);

    const keyboard = buildMealBreakStageKeyboard(mrv.session);
    assert.deepEqual(keyboard, {
        keyboard: [[
            { text: "2036 11:30" },
            { text: "2036 12:30" },
            { text: "2036 13:30" },
        ], [
            { text: "↩️ Desfazer" },
        ]],
        resize_keyboard: true,
        one_time_keyboard: true,
    });
});

test("CP fica a criterio e sai da fila pendente do almoco", async () => {
    const board = makeBoard();
    const cpIndex = board.regulation.findIndex((entry) => entry.postCode === "2039");
    assert.notEqual(cpIndex, -1);
    board.regulation[cpIndex] = {
        ...board.regulation[cpIndex]!,
        roleLabel: "CP",
        defaultRole: "CP",
    };

    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    assert.equal(roster.roster.some((doctor) => doctor.ramal === "2039"), false);

    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);

    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(recip);

    const mrv = applyMealBreakReply({
        session: recip.session,
        text: "2032",
        senderTelegramId: "101",
        referenceAt,
    });
    assert.ok(mrv);
    assert.equal(mrv.session.lunchQueue.includes("2039"), false);

    const view = await getCurrentMealBreakPriorityView({
        referenceAt,
        board,
    });
    assert.equal(view.entries.some((entry) => entry.ramal === "2039"), false);
});

test("resumo final mostra CP com almoco e descanso a criterio", () => {
    const board = makeBoard();
    const cpIndex = board.regulation.findIndex((entry) => entry.postCode === "2039");
    assert.notEqual(cpIndex, -1);
    board.regulation[cpIndex] = {
        ...board.regulation[cpIndex]!,
        roleLabel: "CP",
        defaultRole: "CP",
    };

    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);
    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(recip);
    const mrv = applyMealBreakReply({
        session: recip.session,
        text: "2032",
        senderTelegramId: "101",
        referenceAt,
    });
    assert.ok(mrv);
    const lunch1 = applyMealBreakReply({
        session: mrv.session,
        text: "2036 11:30",
        senderTelegramId: "102",
        referenceAt,
    });
    assert.ok(lunch1);
    const lunch2 = applyMealBreakReply({
        session: lunch1.session,
        text: "2037 12:30",
        senderTelegramId: "103",
        referenceAt,
    });
    assert.ok(lunch2);
    const rest1 = applyMealBreakReply({
        session: lunch2.session,
        text: "2036 15:30",
        senderTelegramId: "105",
        referenceAt,
    });
    assert.ok(rest1);
    assert.equal(rest1.status, "completed");

    assert.match(rest1.messages[1] ?? "", /👑 CHEFIA/);
    assert.match(rest1.messages[1] ?? "", /• Almoço a critério/);
    assert.match(rest1.messages[1] ?? "", /• Descanso a critério/);
});

test("resumo final mostra PSIQ fixo em 12:30 e 18:00", () => {
    const board = makeBoard();
    const psiqIndex = board.regulation.findIndex((entry) => entry.postCode === "2039");
    assert.notEqual(psiqIndex, -1);
    board.regulation[psiqIndex] = {
        ...board.regulation[psiqIndex]!,
        roleLabel: "PSIQ",
        defaultRole: "PSIQ",
    };

    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);
    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(recip);
    const mrv = applyMealBreakReply({
        session: recip.session,
        text: "2032",
        senderTelegramId: "101",
        referenceAt,
    });
    assert.ok(mrv);
    const lunch1 = applyMealBreakReply({
        session: mrv.session,
        text: "2036 11:30",
        senderTelegramId: "102",
        referenceAt,
    });
    assert.ok(lunch1);
    const lunch2 = applyMealBreakReply({
        session: lunch1.session,
        text: "2037 12:30",
        senderTelegramId: "103",
        referenceAt,
    });
    assert.ok(lunch2);
    const rest1 = applyMealBreakReply({
        session: lunch2.session,
        text: "2036 15:30",
        senderTelegramId: "105",
        referenceAt,
    });
    assert.ok(rest1);
    assert.equal(rest1.status, "completed");

    assert.match(rest1.messages[1] ?? "", /12:30\n(?:.*\n)*• Patricia \(PSIQ\)/);
    assert.match(rest1.messages[1] ?? "", /18:00\n(?:.*\n)*• Patricia \(PSIQ\)/);
});

test("buildMealBreakRoster monta a fila do noturno com continuistas priorizados e sem CP", () => {
    const roster = buildMealBreakRoster(makeNightBoard(), new Date("2026-03-29T20:05:00-03:00"), "night");

    assert.equal(roster.chiefRamal, "2031");
    assert.deepEqual(roster.roster.map((doctor) => doctor.ramal), ["2032", "2033", "2034", "2035", "2036", "2037", "2038", "2039"]);
    assert.equal(roster.roster.some((doctor) => doctor.ramal === "2031"), false);
    assert.equal(roster.roster.some((doctor) => doctor.ramal === "2040"), false);
    assert.equal(roster.roster[0]?.shiftLabel, "P");
});

test("buildMealBreakRoster inclui ocupacao ativa sem shiftLabel quando ela comecou no plantao noturno corrente", () => {
    const board = makeNightBoard();
    board.regulation[1]!.shiftLabel = null;

    const roster = buildMealBreakRoster(board, new Date("2026-03-29T20:05:00-03:00"), "night");
    const matheus = roster.roster.find((doctor) => doctor.ramal === "2032") ?? null;

    assert.ok(matheus);
    assert.equal(matheus?.shiftLabel, "P");

    board.regulation[3]!.shiftLabel = null;
    const rosterWithFreshNight = buildMealBreakRoster(board, new Date("2026-03-29T20:05:00-03:00"), "night");
    const freshNight = rosterWithFreshNight.roster.find((doctor) => doctor.ramal === "2034") ?? null;

    assert.ok(freshNight);
    assert.equal(freshNight?.shiftLabel, "SN");
});

test("jantar noturno dá 30min para chegada antecipada da SN mesmo sem shiftLabel", () => {
    const referenceAt = new Date("2026-03-29T20:05:00-03:00");
    const board = makeNightBoard();

    board.regulation[1] = {
        ...board.regulation[1]!,
        startedAt: "2026-03-29T20:00:00.000Z",
        boardStartedAt: "2026-03-29T20:00:00.000Z",
        shiftLabel: null,
    };

    const roster = buildMealBreakRoster(board, referenceAt, "night");
    const earlyNightDoctor = roster.roster.find((doctor) => doctor.ramal === "2032") ?? null;
    assert.ok(earlyNightDoctor);
    assert.equal(earlyNightDoctor?.shiftLabel, "SN");

    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        mode: "night",
        trigger: "manual",
        restarted: false,
        actorTelegramId: "900",
    });

    assert.equal(session.dinnerDurationAssignments["2032"], "half_hour");
});

test("jantar noturno usa chegada real para duração mesmo com prioridade herdada", () => {
    const referenceAt = new Date("2026-03-29T20:05:00-03:00");
    const session = createMealBreakSession({
        roster: [
            {
                doctorId: "doc-luiza",
                ramal: "2032",
                name: "Luiza",
                domain: "regulation",
                arrivalStartedAt: "2026-03-29T21:47:00.000Z", // 18:47 local: chegada para SN
                startedAt: "2026-03-29T10:00:00.000Z", // horario herdado para ordenacao da fila
                shiftLabel: "P",
                roleLabel: null,
            },
        ],
        chiefRamal: null,
        mrvRamals: [],
        referenceAt,
        mode: "night",
        trigger: "manual",
        restarted: false,
        actorTelegramId: "900",
    });

    assert.equal(session.dinnerDurationAssignments["2032"], "half_hour");
});

test("sessao noturna legada corrige 1h indevida ao reconciliar com quadro ativo", () => {
    const board = makeNightBoard();
    board.regulation[1] = {
        ...board.regulation[1]!,
        startedAt: "2026-03-29T21:47:00.000Z", // 18:47 local SN
        boardStartedAt: "2026-03-29T12:00:00.000Z", // ancora antiga usada na fila
        shiftLabel: "P",
    };

    const session = createMealBreakSession({
        roster: [
            {
                doctorId: "doc-luiza",
                ramal: "2032",
                name: "Luiza",
                domain: "regulation",
                startedAt: "2026-03-29T12:00:00.000Z",
                shiftLabel: "P",
                roleLabel: null,
            },
        ],
        chiefRamal: null,
        mrvRamals: [],
        referenceAt: new Date("2026-03-29T20:05:00-03:00"),
        mode: "night",
        trigger: "manual",
        restarted: false,
        actorTelegramId: "900",
    });

    assert.equal(session.dinnerDurationAssignments["2032"], "one_hour");

    const reconciled = reconcileNightMealBreakSessionWithBoard({
        session,
        board,
    });

    assert.equal(reconciled.dinnerDurationAssignments["2032"], "half_hour");
});

test("resolveMealBreakContinuityStartedAt herda a chegada do plantao anterior mesmo com troca de base", () => {
    const continuityStartedAt = resolveMealBreakContinuityStartedAt({
        currentOccupancyId: "reg-current",
        occupancies: [
            {
                occupancyId: "int-morning",
                doctorId: "doc-leo",
                continuityGroupId: "cg-morning",
                startedAt: "2026-03-29T10:00:00.000Z",
                endedAt: "2026-03-29T22:00:00.000Z",
                actualEndedAt: "2026-03-29T22:00:00.000Z",
            },
            {
                occupancyId: "reg-current",
                doctorId: "doc-leo",
                continuityGroupId: null,
                startedAt: "2026-03-29T22:00:00.000Z",
                endedAt: null,
                actualEndedAt: null,
            },
        ],
    });

    assert.equal(continuityStartedAt, "2026-03-29T10:00:00.000Z");
});

test("applyMealBreakContinuityStarts preserva prioridade do presencial continuo sobre RMT fixo", () => {
    const ranked = applyMealBreakContinuityStarts({
        roster: [
            {
                doctorId: "doc-leo",
                ramal: "2033",
                name: "Leo Marins",
                domain: "regulation",
                startedAt: "2026-03-29T22:00:00.000Z",
                shiftLabel: "SN",
                roleLabel: null,
            },
            {
                doctorId: "doc-remote",
                ramal: "1361",
                name: "Remoto Fixo",
                domain: "regulation",
                startedAt: "2026-03-29T10:00:00.000Z",
                shiftLabel: "P",
                roleLabel: "RMT",
            },
        ],
        continuityStartedAtByRamal: {
            "2033": "2026-03-29T10:00:00.000Z",
        },
        referenceAt: new Date("2026-03-29T20:05:00-03:00"),
    });

    assert.deepEqual(ranked.map((doctor) => doctor.ramal), ["2033", "1361"]);
});

test("applyMealBreakReply empurra RMT para o corte de 07:15 na fila do almoco", () => {
    const board = makeBoard();
    board.regulation[3]!.startedAt = "2026-03-29T10:00:00.000Z";
    board.regulation[3]!.boardStartedAt = "2026-03-29T10:00:00.000Z";
    board.regulation[4]!.startedAt = "2026-03-29T10:10:00.000Z";
    board.regulation[4]!.boardStartedAt = "2026-03-29T10:10:00.000Z";
    board.regulation[5]!.startedAt = "2026-03-29T10:16:00.000Z";
    board.regulation[5]!.boardStartedAt = "2026-03-29T10:16:00.000Z";
    board.regulation[7]!.startedAt = "2026-03-29T10:01:00.000Z";
    board.regulation[7]!.boardStartedAt = "2026-03-29T10:01:00.000Z";
    board.regulation[7]!.roleLabel = "RMT";

    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);

    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    const mrv = applyMealBreakReply({
        session: recip!.session,
        text: "2032",
        senderTelegramId: "101",
        referenceAt,
    });

    assert.deepEqual(mrv?.session.lunchQueue, ["2038", "2036", "2039", "2037"]);
    assert.equal(mrv?.session.roster.find((doctor) => doctor.ramal === "2039")?.roleLabel, "RMT");
});

test("applyMealBreakReply respeita a ordem manual recebida para a fila do almoco", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(makeBoard(), referenceAt);
    const session = createMealBreakSession({
        roster: [
            roster.roster[0]!,
            roster.roster[1]!,
            roster.roster[2]!,
            roster.roster[5]!,
            roster.roster[3]!,
            roster.roster[4]!,
            roster.roster[6]!,
        ],
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);

    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    const mrv = applyMealBreakReply({
        session: recip!.session,
        text: "2032",
        senderTelegramId: "101",
        referenceAt,
    });

    assert.deepEqual(mrv?.session.lunchQueue, ["2038", "2036", "2037", "2039"]);
});

test("applyMealBreakReply conduz almoco e descanso ate o fechamento", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(makeBoard(), referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);

    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(recip);
    assert.equal(recip?.session.recipRamal, "2035");
    assert.equal(recip?.session.lunchAssignments["2035"], "11:30");
    assert.equal(recip?.session.restAssignments["2035"], "18:00");
    assert.equal(recip?.session.stage, "awaiting_mrv_lunch");

    const mrv = applyMealBreakReply({
        session: recip!.session,
        text: "2032",
        senderTelegramId: "101",
        referenceAt,
    });
    assert.ok(mrv);
    assert.equal(mrv?.session.lunchAssignments["2032"], "12:30");
    assert.equal(mrv?.session.lunchAssignments["2151"], "13:30");
    assert.deepEqual(mrv?.session.lunchQueue, ["2036", "2037", "2038", "2039"]);
    assert.equal(mrv?.session.stage, "awaiting_lunch_choice");

    const outOfTurn = applyMealBreakReply({
        session: mrv!.session,
        text: "2037 11:30",
        senderTelegramId: "999",
        referenceAt,
    });
    assert.ok(outOfTurn);
    assert.equal(outOfTurn?.status, "invalid");
    assert.match(outOfTurn?.messages[0] ?? "", /chamado atual é para o ramal 2036/i);

    const lunch1 = applyMealBreakReply({
        session: mrv!.session,
        text: "2036 11:30",
        senderTelegramId: "102",
        referenceAt,
    });
    const lunch2 = applyMealBreakReply({
        session: lunch1!.session,
        text: "2037 11:30",
        senderTelegramId: "103",
        referenceAt,
    });
    const lunch3 = applyMealBreakReply({
        session: lunch2!.session,
        text: "2038 12:30",
        senderTelegramId: "104",
        referenceAt,
    });
    assert.ok(lunch3);
    assert.equal(lunch3?.session.stage, "awaiting_rest_choice");
    assert.equal(lunch3?.session.lunchAssignments["2039"], "13:30");
    assert.equal(lunch3?.session.restAssignments["2039"], "14:30");
    assert.equal(lunch3?.session.restAssignments["2035"], "18:00");
    assert.equal(lunch3?.session.restAssignments["2032"], "18:00");
    assert.equal(lunch3?.session.restAssignments["2151"], "18:00");
    assert.deepEqual(lunch3?.session.restQueue, ["2036", "2037", "2038"]);

    const rest1 = applyMealBreakReply({
        session: lunch3!.session,
        text: "2036 15:30",
        senderTelegramId: "106",
        referenceAt,
    });
    assert.ok(rest1);
    assert.equal(rest1?.session.stage, "awaiting_rest_choice");

    const rest2 = applyMealBreakReply({
        session: rest1!.session,
        text: "2037 16:30",
        senderTelegramId: "107",
        referenceAt,
    });
    assert.ok(rest2);
    assert.equal(rest2?.session.stage, "awaiting_rest_choice");
    assert.equal(rest2?.session.restAssignments["2038"], undefined);

    const rest3 = applyMealBreakReply({
        session: rest2!.session,
        text: "2038 16:30",
        senderTelegramId: "108",
        referenceAt,
    });
    assert.ok(rest3);
    assert.equal(rest3?.session.stage, "completed");
    assert.equal(rest3?.session.restAssignments["2038"], "16:30");
    assert.match(rest3?.messages[1] ?? "", /🍽️ ALMOÇO/);
    assert.match(rest3?.messages[1] ?? "", /14:30\n• Patricia/);
    assert.match(rest3?.messages[1] ?? "", /18:00\n• Marina \(MRV\)\n• Carlos \(MRV\)\n• Renata \(RECIP\)/);
});

test("applyMealBreakReply fecha o almoco automaticamente quando sobra uma unica opcao", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(makeBoard(), referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);

    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(recip);

    const mrv = applyMealBreakReply({
        session: recip.session,
        text: "2032",
        senderTelegramId: "101",
        referenceAt,
    });
    assert.ok(mrv);

    const lunch1 = applyMealBreakReply({
        session: mrv.session,
        text: "2036 11:30",
        senderTelegramId: "102",
        referenceAt,
    });
    assert.ok(lunch1);
    const lunch2 = applyMealBreakReply({
        session: lunch1.session,
        text: "2037 11:30",
        senderTelegramId: "103",
        referenceAt,
    });
    assert.ok(lunch2);
    const lunch3 = applyMealBreakReply({
        session: lunch2.session,
        text: "2038 12:30",
        senderTelegramId: "104",
        referenceAt,
    });
    assert.ok(lunch3);
    assert.equal(lunch3.session.stage, "awaiting_rest_choice");
    assert.equal(lunch3.session.lunchAssignments["2039"], "13:30");
    assert.deepEqual(lunch3.session.lunchQueue, []);
});

test("buildMealBreakStageKeyboard mantem as duas opcoes para o ultimo descanso impar", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(makeBoard(), referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);

    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(recip);

    const mrv = applyMealBreakReply({
        session: recip.session,
        text: "2032",
        senderTelegramId: "101",
        referenceAt,
    });
    assert.ok(mrv);

    const lunch1 = applyMealBreakReply({
        session: mrv.session,
        text: "2036 11:30",
        senderTelegramId: "102",
        referenceAt,
    });
    assert.ok(lunch1);
    const lunch2 = applyMealBreakReply({
        session: lunch1.session,
        text: "2037 11:30",
        senderTelegramId: "103",
        referenceAt,
    });
    assert.ok(lunch2);
    const lunch3 = applyMealBreakReply({
        session: lunch2.session,
        text: "2038 12:30",
        senderTelegramId: "104",
        referenceAt,
    });
    assert.ok(lunch3);
    const rest1 = applyMealBreakReply({
        session: lunch3.session,
        text: "2036 15:30",
        senderTelegramId: "105",
        referenceAt,
    });
    assert.ok(rest1);
    const rest2 = applyMealBreakReply({
        session: rest1.session,
        text: "2037 16:30",
        senderTelegramId: "106",
        referenceAt,
    });
    assert.ok(rest2);

    const keyboard = buildMealBreakStageKeyboard(rest2.session);
    assert.deepEqual(keyboard, {
        keyboard: [[
            { text: "2038 15:30" },
            { text: "2038 16:30" },
        ], [
            { text: "↩️ Desfazer" },
        ]],
        resize_keyboard: true,
        one_time_keyboard: true,
    });
});

test("applyMealBreakReply ignora conversa casual fora do formato", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(makeBoard(), referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    assert.equal(applyMealBreakReply({
        session,
        text: "Bom dia equipe",
        senderTelegramId: "100",
        referenceAt,
    }), null);
});

test("shouldPreferMealBreakReplyForSession prioriza respostas da divisao sem confundir chegada operacional", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(makeBoard(), referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);
    assert.equal(shouldPreferMealBreakReplyForSession(confirmed.session, "2035"), true);
    assert.equal(shouldPreferMealBreakReplyForSession(confirmed.session, "Renata"), true);
    assert.equal(shouldPreferMealBreakReplyForSession(confirmed.session, "2035 Renata 10:00"), false);
    // Bug fix: name NOT in roster should still be intercepted so stage can reply "Nao reconheci"
    // instead of falling through to operational arrival parsing.
    assert.equal(shouldPreferMealBreakReplyForSession(confirmed.session, "Nome Inexistente"), true);
    assert.equal(shouldPreferMealBreakReplyForSession(confirmed.session, "Fulano de Tal"), true);
    // Arrival cues or ramal codes must still bail out to operational parsing:
    assert.equal(shouldPreferMealBreakReplyForSession(confirmed.session, "1234 SD chegou"), false);
    assert.equal(shouldPreferMealBreakReplyForSession(confirmed.session, "Medica SD"), false);

    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(recip);
    assert.equal(shouldPreferMealBreakReplyForSession(recip.session, "2032"), true);
    assert.equal(shouldPreferMealBreakReplyForSession(recip.session, "Marina"), true);
    assert.equal(shouldPreferMealBreakReplyForSession(recip.session, "2032 Marina 10:00"), false);
    // Bug fix: name NOT in mrvRamals should be intercepted (stage handler shows "Nao reconheci")
    assert.equal(shouldPreferMealBreakReplyForSession(recip.session, "Nome Nao MRV"), true);

    const mrv = applyMealBreakReply({
        session: recip.session,
        text: "2032",
        senderTelegramId: "101",
        referenceAt,
    });
    assert.ok(mrv);
    assert.equal(shouldPreferMealBreakReplyForSession(mrv.session, "2036 11:30"), true);
    assert.equal(shouldPreferMealBreakReplyForSession(mrv.session, "2036 Renata Lima 12:30"), true);
    assert.equal(shouldPreferMealBreakReplyForSession(mrv.session, "2036 Renata 10:00"), false);
    assert.equal(shouldPreferMealBreakReplyForSession(mrv.session, "2036 Renata 12:30 SD"), false);
});

test("shouldPreferMealBreakReplyForSession trata caso Thainara como almoço quando o ramal atual da fila e confirmado", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(makeBoard(), referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);

    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(recip);

    const mrv = applyMealBreakReply({
        session: recip.session,
        text: "2032",
        senderTelegramId: "101",
        referenceAt,
    });
    assert.ok(mrv);

    const currentRamal = mrv.session.lunchQueue[0];
    assert.ok(currentRamal);
    const currentDoctor = mrv.session.roster.find((doctor) => doctor.ramal === currentRamal);
    assert.ok(currentDoctor);

    const thainaraLikeText = `${currentRamal} ${currentDoctor.name} 12:30`;
    assert.equal(shouldPreferMealBreakReplyForSession(mrv.session, thainaraLikeText), true);
});

test("shouldPreferMealBreakReplyForSession mantem chegada como padrao quando o alvo nao esta na vez", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(makeBoard(), referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);

    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(recip);

    const mrv = applyMealBreakReply({
        session: recip.session,
        text: "2032",
        senderTelegramId: "101",
        referenceAt,
    });
    assert.ok(mrv);

    const currentRamal = mrv.session.lunchQueue[0];
    assert.ok(currentRamal);
    const otherDoctor = mrv.session.roster.find((doctor) => doctor.ramal !== currentRamal && !mrv.session.mrvRamals.includes(doctor.ramal) && doctor.ramal !== mrv.session.recipRamal);
    assert.ok(otherDoctor);

    const likelyArrivalText = `${otherDoctor.ramal} ${otherDoctor.name} 11:30`;
    assert.equal(shouldPreferMealBreakReplyForSession(mrv.session, likelyArrivalText), false);
});

test("applyMealBreakReply aceita formato ramal+nome+horario durante fila ativa", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(makeBoard(), referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);

    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(recip);

    const mrv = applyMealBreakReply({
        session: recip.session,
        text: "2032",
        senderTelegramId: "101",
        referenceAt,
    });
    assert.ok(mrv);

    const lunch = applyMealBreakReply({
        session: mrv.session,
        text: "2036 Renata Lima 12:30",
        senderTelegramId: "101",
        referenceAt,
    });

    assert.ok(lunch);
    assert.equal(lunch?.status, "updated");
    assert.equal(lunch?.session.lunchAssignments["2036"], "12:30");
});

test("applyMealBreakReply aceita nome do MRV na escolha do almoco 12:30", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(makeBoard(), referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);

    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(recip);

    const mrv = applyMealBreakReply({
        session: recip.session,
        text: "Marina",
        senderTelegramId: "101",
        referenceAt,
    });
    assert.ok(mrv);
    assert.equal(mrv?.session.mrvLunch1230Ramal, "2032");
    assert.equal(mrv?.session.lunchAssignments["2032"], "12:30");
    assert.equal(mrv?.session.lunchAssignments["2151"], "13:30");
    assert.equal(mrv?.session.stage, "awaiting_lunch_choice");
});

test("applyMealBreakReply conduz trabalho e jantar da noite ate o fechamento", () => {
    const referenceAt = new Date("2026-03-29T20:05:00-03:00");
    const roster = buildMealBreakRoster(makeNightBoard(), referenceAt, "night");
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        mode: "night",
        trigger: "manual",
        restarted: false,
        actorTelegramId: "900",
    });

    assert.equal(session.stage, "awaiting_confirmation");

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "900",
        referenceAt,
    });
    assert.ok(confirmed);

    assert.equal(confirmed.session.stage, "awaiting_night_work_choice");
    assert.deepEqual(confirmed.session.nightWorkCapacities, { "23:00": 4, "03:00": 4 });
    assert.deepEqual(confirmed.session.nightWorkQueue, ["2032", "2033", "2034", "2035", "2036", "2037", "2038", "2039"]);

    const work1 = applyMealBreakReply({
        session: confirmed.session,
        text: "2032 03:00",
        senderTelegramId: "901",
        referenceAt,
    });
    assert.ok(work1);
    assert.equal(work1?.session.nightWorkAssignments["2032"], "03:00");
    assert.equal(work1?.session.dinnerAssignments["2032"], "22:00");

    const work2 = applyMealBreakReply({
        session: work1!.session,
        text: "2033 03:00",
        senderTelegramId: "902",
        referenceAt,
    });
    const work3 = applyMealBreakReply({
        session: work2!.session,
        text: "2034 03:00",
        senderTelegramId: "903",
        referenceAt,
    });
    const work4 = applyMealBreakReply({
        session: work3!.session,
        text: "2035 03:00",
        senderTelegramId: "904",
        referenceAt,
    });
    assert.ok(work4);
    assert.equal(work4?.session.dinnerAssignments["2034"], "22:30");
    assert.equal(work4?.session.dinnerAssignments["2035"], "22:30");

    assert.equal(work4?.session.nightWorkAssignments["2036"], "23:00");
    assert.equal(work4?.session.nightWorkAssignments["2037"], "23:00");
    assert.equal(work4?.session.nightWorkAssignments["2038"], "23:00");
    assert.equal(work4?.session.nightWorkAssignments["2039"], "23:00");
    assert.equal(work4?.session.stage, "awaiting_dinner_choice");
    assert.deepEqual(work4?.session.dinnerChoiceCapacities, { "20:30": 2, "21:00": 1, "21:30": 1 });
    assert.deepEqual(work4?.session.dinnerQueue, ["2036", "2037", "2038", "2039"]);

    const dinner1 = applyMealBreakReply({
        session: work4!.session,
        text: "2036 20:30",
        senderTelegramId: "909",
        referenceAt,
    });
    const dinner2 = applyMealBreakReply({
        session: dinner1!.session,
        text: "2037 20:30",
        senderTelegramId: "910",
        referenceAt,
    });
    const dinner3 = applyMealBreakReply({
        session: dinner2!.session,
        text: "2038 21:00",
        senderTelegramId: "911",
        referenceAt,
    });

    assert.ok(dinner3);
    assert.equal(dinner3?.session.stage, "completed");
    assert.equal(dinner3?.session.dinnerAssignments["2039"], "21:30");
    assert.match(dinner3?.messages[1] ?? "", /🍽️ JANTAR/);
    assert.match(dinner3?.messages[1] ?? "", /22:00\n• Marina \(MRV\) - 1h/);
    assert.match(dinner3?.messages[1] ?? "", /22:30\n• Renata - 30min/);
    assert.match(dinner3?.messages[1] ?? "", /🌙 TRABALHO\n23:00/);
    assert.match(dinner3?.messages[1] ?? "", /03:00\n• Marina \(MRV\)/);
});

test("buildMealBreakRoster detecta MRVs por roleLabel em postos nao-padrao", () => {
    const board = makeBoard();
    // Move MRV from 2032 to 2153
    board.regulation[1] = {
        ...board.regulation[1]!,
        postCode: "2153",
        postLabel: "2153",
        defaultRole: "MR",
        roleLabel: "MRV",
        ramalLabel: "2153",
    };

    const roster = buildMealBreakRoster(board, new Date("2026-03-29T09:05:00-03:00"));
    assert.deepEqual(roster.mrvRamals, ["2153", "2151"]);
    assert.equal(roster.roster.find((d) => d.ramal === "2153")?.roleLabel, "MRV");
    assert.equal(roster.roster.find((d) => d.ramal === "2151")?.roleLabel, "MRV");
});

test("applyMealBreakReply conduz almoco com MRVs em postos nao-padrao (2151+2153)", () => {
    const board = makeBoard();
    board.regulation[1] = {
        ...board.regulation[1]!,
        postCode: "2153",
        postLabel: "2153",
        defaultRole: "MR",
        roleLabel: "MRV",
        ramalLabel: "2153",
    };

    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    assert.deepEqual(roster.mrvRamals, ["2153", "2151"]);

    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);

    const recip = applyMealBreakReply({
        session: confirmed.session,
        text: "2035",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(recip);
    assert.equal(recip?.session.stage, "awaiting_mrv_lunch");

    const mrv = applyMealBreakReply({
        session: recip!.session,
        text: "2153",
        senderTelegramId: "101",
        referenceAt,
    });
    assert.ok(mrv);
    assert.equal(mrv?.session.lunchAssignments["2153"], "12:30");
    assert.equal(mrv?.session.lunchAssignments["2151"], "13:30");
    assert.deepEqual(mrv?.session.lunchQueue, ["2036", "2037", "2038", "2039"]);
    assert.equal(mrv?.session.stage, "awaiting_lunch_choice");
});

test("parseTelegramMealBreakExcludeCommand aceita /excluir e /incluir com ramal", () => {
    const excluir = parseTelegramMealBreakExcludeCommand("/excluir 2041");
    assert.deepEqual(excluir, { name: "meal_break_exclude", ramal: "2041" });

    const incluir = parseTelegramMealBreakExcludeCommand("/incluir 2041");
    assert.deepEqual(incluir, { name: "meal_break_exclude", ramal: "2041" });

    const withBot = parseTelegramMealBreakExcludeCommand("/excluir@SamuBot 2036");
    assert.deepEqual(withBot, { name: "meal_break_exclude", ramal: "2036" });

    assert.equal(parseTelegramMealBreakExcludeCommand("/excluir"), null);
    assert.equal(parseTelegramMealBreakExcludeCommand("/excluir abc"), null);
    assert.equal(parseTelegramMealBreakExcludeCommand("/excluir 20"), null);
    assert.equal(parseTelegramMealBreakExcludeCommand("/excluir 2041 extra"), null);
});

test("isTelegramMealBreakExcludeCommandText reconhece /excluir e /incluir", () => {
    assert.ok(isTelegramMealBreakExcludeCommandText("/excluir 2041"));
    assert.ok(isTelegramMealBreakExcludeCommandText("/incluir 2041"));
    assert.ok(isTelegramMealBreakExcludeCommandText("/excluir"));
    assert.ok(isTelegramMealBreakExcludeCommandText("/incluir@SamuBot 2036"));
    assert.ok(!isTelegramMealBreakExcludeCommandText("/almoco"));
    assert.ok(!isTelegramMealBreakExcludeCommandText("excluir 2041"));
});

test("createMealBreakSession auto-detecta RECIP do roster quando roleLabel ja esta definido", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const board = makeBoard();
    board.regulation[3]!.roleLabel = "RECIP";

    const roster = buildMealBreakRoster(board, referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    assert.equal(session.recipRamal, "2035");
    assert.equal(session.lunchAssignments["2035"], "11:30");
    assert.equal(session.restAssignments["2035"], "18:00");

    const confirmed = applyMealBreakReply({
        session,
        text: "✅ Confirmar",
        senderTelegramId: "100",
        referenceAt,
    });
    assert.ok(confirmed);
    assert.notEqual(confirmed.session.stage, "awaiting_recip");
});

test("createMealBreakSession auto-detecta RECIP quando 2032/2151 recebem RECIP explicitamente", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const board = makeBoard();
    board.regulation[1]!.roleLabel = "RECIP";

    const roster = buildMealBreakRoster(board, referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    assert.equal(session.recipRamal, "2032");
});

test("createMealBreakSession respeita lunchExcluded ao auto-detectar RECIP", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const board = makeBoard();
    board.regulation[3]!.roleLabel = "RECIP";

    const roster = buildMealBreakRoster(board, referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
        lunchExcludedRamals: ["2035"],
    });

    assert.equal(session.recipRamal, "2035");
    assert.equal(session.lunchAssignments["2035"], undefined);
    assert.equal(session.restAssignments["2035"], "18:00");
});

test("descanso completa sem erro de vagas quando todos os medicos escolhem em sequencia", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(makeBoard(), referenceAt);
    let session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    session = applyMealBreakReply({ session, text: "✅ Confirmar", senderTelegramId: "100", referenceAt })!.session;
    session = applyMealBreakReply({ session, text: "2035", senderTelegramId: "100", referenceAt })!.session;
    session = applyMealBreakReply({ session, text: "2032", senderTelegramId: "100", referenceAt })!.session;

    const lunchSlots = ["11:30", "12:30", "13:30"] as const;
    while (session.stage === "awaiting_lunch_choice") {
        const ramal = session.lunchQueue[0]!;
        const assigned = Object.values(session.lunchAssignments);
        const slot = lunchSlots.find((s) => {
            const used = assigned.filter((a) => a === s).length;
            return used < (session.lunchCapacities as Record<string, number>)[s]!;
        }) ?? "12:30";
        session = applyMealBreakReply({ session, text: `${ramal} ${slot}`, senderTelegramId: "100", referenceAt })!.session;
    }

    if (session.stage !== "awaiting_rest_choice") {
        assert.equal(session.stage, "completed");
        return;
    }

    while (session.stage === "awaiting_rest_choice") {
        const ramal = session.restQueue[0]!;
        const assigned1530 = Object.values(session.restAssignments).filter((s) => s === "15:30").length;
        const assigned1630 = Object.values(session.restAssignments).filter((s) => s === "16:30").length;
        const remaining1530 = session.restChoiceCapacities["15:30"] - assigned1530;
        const remaining1630 = session.restChoiceCapacities["16:30"] - assigned1630;
        assert.ok(remaining1530 + remaining1630 >= session.restQueue.length,
            `Vagas (${remaining1530}+${remaining1630}) devem cobrir fila (${session.restQueue.length}) antes de ${ramal} escolher`);

        const slot = remaining1530 > 0 ? "15:30" : "16:30";
        const result = applyMealBreakReply({ session, text: `${ramal} ${slot}`, senderTelegramId: "100", referenceAt });
        assert.ok(result, `Escolha de ${ramal} para ${slot} nao deve falhar`);
        assert.notEqual(result.status, "invalid", `${ramal} nao pode receber erro de vagas`);
        session = result.session;
    }

    assert.equal(session.stage, "completed");
});

test("syncDaySessionState preserva capacidades de descanso quando ha escolhas 15:30/16:30 ja feitas", () => {
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(makeBoard(), referenceAt);
    let session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    session = applyMealBreakReply({ session, text: "✅ Confirmar", senderTelegramId: "100", referenceAt })!.session;
    session = applyMealBreakReply({ session, text: "2035", senderTelegramId: "100", referenceAt })!.session;
    session = applyMealBreakReply({ session, text: "2032", senderTelegramId: "100", referenceAt })!.session;

    const lunchSlots = ["11:30", "12:30", "13:30"] as const;
    while (session.stage === "awaiting_lunch_choice") {
        const ramal = session.lunchQueue[0]!;
        const assigned = Object.values(session.lunchAssignments);
        const slot = lunchSlots.find((s) => {
            const used = assigned.filter((a) => a === s).length;
            return used < (session.lunchCapacities as Record<string, number>)[s]!;
        }) ?? "12:30";
        session = applyMealBreakReply({ session, text: `${ramal} ${slot}`, senderTelegramId: "100", referenceAt })!.session;
    }

    if (session.stage !== "awaiting_rest_choice") {
        return;
    }

    const totalRestQueue = session.restQueue.length;
    assert.ok(totalRestQueue > 0, "restQueue deve ter medicos");

    // Fazer metade das escolhas de descanso
    const halfChoices = Math.floor(totalRestQueue / 2);
    for (let i = 0; i < halfChoices; i++) {
        const ramal = session.restQueue[0]!;
        session = applyMealBreakReply({ session, text: `${ramal} 15:30`, senderTelegramId: "100", referenceAt })!.session;
    }

    if (session.stage !== "awaiting_rest_choice") {
        return;
    }

    const queueBeforeSync = session.restQueue.length;
    assert.ok(queueBeforeSync > 0, "ainda deve ter medicos na fila");

    // Simular resync identico ao que updateDayMealBreakEligibility faz
    const resynced = syncDaySessionState(session);

    assert.equal(resynced.stage, "awaiting_rest_choice");
    assert.equal(resynced.restQueue.length, queueBeforeSync);

    const assigned1530 = Object.values(resynced.restAssignments).filter((s) => s === "15:30").length;
    const assigned1630 = Object.values(resynced.restAssignments).filter((s) => s === "16:30").length;
    const remaining1530 = resynced.restChoiceCapacities["15:30"] - assigned1530;
    const remaining1630 = resynced.restChoiceCapacities["16:30"] - assigned1630;

    assert.ok(
        remaining1530 + remaining1630 >= resynced.restQueue.length,
        `Apos resync: vagas (${remaining1530}+${remaining1630}=${remaining1530 + remaining1630}) devem cobrir fila (${resynced.restQueue.length}). ` +
        `Capacidades: ${JSON.stringify(resynced.restChoiceCapacities)}, atribuidos: 15:30=${assigned1530}, 16:30=${assigned1630}`,
    );
});

// ─── COI shared-position conflict prevention ───────────────────────────────

function makeBoardWithCOI() {
    const board = makeBoard();
    // Add two COI posts (1367 and 1368)
    board.regulation.push(
        {
            postId: 20,
            occupancyId: "reg-1367",
            postCode: "1367",
            postLabel: "1367",
            defaultRole: "MR",
            doctorId: "doc-coi-1",
            doctorName: "Lilian Barros",
            displayName: "Lilian",
            startedAt: "2026-03-29T10:08:00.000Z",
            boardStartedAt: "2026-03-29T10:08:00.000Z",
            scheduledEndAt: "2026-03-29T22:00:00.000Z",
            shiftLabel: "SD",
            roleLabel: "COI",
            ramalLabel: "1367",
            status: "active",
            liveSource: "operations_v2",
            liveUpdatedAt: null,
        },
        {
            postId: 21,
            occupancyId: "reg-1368",
            postCode: "1368",
            postLabel: "1368",
            defaultRole: "MR",
            doctorId: "doc-coi-2",
            doctorName: "Claudio Azoubel",
            displayName: "Claudio",
            startedAt: "2026-03-29T10:09:00.000Z",
            boardStartedAt: "2026-03-29T10:09:00.000Z",
            scheduledEndAt: "2026-03-29T22:00:00.000Z",
            shiftLabel: "SD",
            roleLabel: "COI",
            ramalLabel: "1368",
            status: "active",
            liveSource: "operations_v2",
            liveUpdatedAt: null,
        },
    );
    return board;
}

function advanceToRestPhase(startSession: ReturnType<typeof createMealBreakSession>, referenceAt: Date) {
    let session = startSession;
    // Confirm
    session = applyMealBreakReply({ session, text: "✅ Confirmar", senderTelegramId: "100", referenceAt })!.session;
    // RECIP
    session = applyMealBreakReply({ session, text: "2035", senderTelegramId: "100", referenceAt })!.session;
    // MRV
    session = applyMealBreakReply({ session, text: "2032", senderTelegramId: "100", referenceAt })!.session;
    // Advance through lunch queue until rest phase
    while (session.stage === "awaiting_lunch_choice") {
        const ramal = session.lunchQueue[0]!;
        // Pick first available slot
        const remaining = {
            "11:30": session.lunchCapacities["11:30"] - Object.values(session.lunchAssignments).filter((s) => s === "11:30").length,
            "12:30": session.lunchCapacities["12:30"] - Object.values(session.lunchAssignments).filter((s) => s === "12:30").length,
            "13:30": session.lunchCapacities["13:30"] - Object.values(session.lunchAssignments).filter((s) => s === "13:30").length,
        };
        const slot = (["11:30", "12:30", "13:30"] as const).find((s) => remaining[s] > 0)!;
        const result = applyMealBreakReply({ session, text: `${ramal} ${slot}`, senderTelegramId: "100", referenceAt });
        assert.ok(result, `Lunch reply failed for ${ramal} ${slot}`);
        session = result.session;
    }
    return session;
}

test("COI: rejeita escolha de descanso quando outro COI ja esta nesse horario", () => {
    const board = makeBoardWithCOI();
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const initial = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    let session = advanceToRestPhase(initial, referenceAt);
    assert.equal(session.stage, "awaiting_rest_choice");

    // Find the two COI ramais in the rest queue
    const coiInQueue = session.restQueue.filter((r) => r === "1367" || r === "1368");

    if (coiInQueue.length < 2) {
        // One or both COI may have been auto-assigned 14:30 (if they lunched at 13:30).
        // Force a scenario: manually set restAssignments to put first COI at 15:30
        const firstCoi = session.roster.find((d) => d.ramal === "1367" || d.ramal === "1368")!;
        const secondCoi = session.roster.find((d) => (d.ramal === "1367" || d.ramal === "1368") && d.ramal !== firstCoi.ramal)!;
        session = {
            ...session,
            restAssignments: { ...session.restAssignments, [firstCoi.ramal]: "15:30" },
            restQueue: [secondCoi.ramal, ...session.restQueue.filter((r) => r !== firstCoi.ramal && r !== secondCoi.ramal)],
        };
    }

    // Now whichever COI is first in queue, try to pick the same slot as its peer
    const firstCoiRamal = session.restQueue.find((r) => r === "1367" || r === "1368")!;
    const otherCoiRamal = firstCoiRamal === "1367" ? "1368" : "1367";
    const peerSlot = session.restAssignments[otherCoiRamal] as string;
    assert.ok(peerSlot, `Peer COI ${otherCoiRamal} should have a rest assignment`);

    const result = applyMealBreakReply({
        session,
        text: `${firstCoiRamal} ${peerSlot}`,
        senderTelegramId: "100",
        referenceAt,
    });

    assert.ok(result);
    assert.equal(result.status, "invalid", `COI ${firstCoiRamal} nao deveria conseguir escolher ${peerSlot} (mesmo slot que ${otherCoiRamal})`);
    assert.ok(result.messages.some((m) => m.includes("COI")), "Mensagem deve mencionar COI");
});

test("COI: rejeita escolha de almoco quando outro COI ja esta nesse horario", () => {
    const board = makeBoardWithCOI();
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const initial = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    let session = initial;
    session = applyMealBreakReply({ session, text: "✅ Confirmar", senderTelegramId: "100", referenceAt })!.session;
    session = applyMealBreakReply({ session, text: "2035", senderTelegramId: "100", referenceAt })!.session;
    session = applyMealBreakReply({ session, text: "2032", senderTelegramId: "100", referenceAt })!.session;
    assert.equal(session.stage, "awaiting_lunch_choice");

    // Advance until a COI ramal is at front of queue
    while (session.stage === "awaiting_lunch_choice" && session.lunchQueue[0] !== "1367" && session.lunchQueue[0] !== "1368") {
        const ramal = session.lunchQueue[0]!;
        const result = applyMealBreakReply({ session, text: `${ramal} 11:30`, senderTelegramId: "100", referenceAt });
        if (!result || result.status === "invalid") {
            // Slot full, try another
            const r2 = applyMealBreakReply({ session, text: `${ramal} 12:30`, senderTelegramId: "100", referenceAt });
            if (!r2 || r2.status === "invalid") {
                session = applyMealBreakReply({ session, text: `${ramal} 13:30`, senderTelegramId: "100", referenceAt })!.session;
            } else {
                session = r2.session;
            }
        } else {
            session = result.session;
        }
    }

    if (session.stage !== "awaiting_lunch_choice") return;

    const firstCoi = session.lunchQueue[0]!;
    assert.ok(firstCoi === "1367" || firstCoi === "1368");

    // Assign this COI to 12:30
    const r1 = applyMealBreakReply({ session, text: `${firstCoi} 12:30`, senderTelegramId: "100", referenceAt });
    if (!r1 || r1.status === "invalid") return; // slot full, skip test
    session = r1.session;

    // Now find the second COI in queue
    const secondCoiIdx = session.lunchQueue.indexOf(firstCoi === "1367" ? "1368" : "1367");
    if (secondCoiIdx < 0 || session.stage !== "awaiting_lunch_choice") return;

    // Advance non-COI doctors before the second COI
    while (session.stage === "awaiting_lunch_choice" && session.lunchQueue[0] !== "1367" && session.lunchQueue[0] !== "1368") {
        const ramal = session.lunchQueue[0]!;
        const trySlot = Object.entries({
            "11:30": session.lunchCapacities["11:30"],
            "13:30": session.lunchCapacities["13:30"],
        }).find(([, cap]) => cap > 0)?.[0] ?? "11:30";
        const result = applyMealBreakReply({ session, text: `${ramal} ${trySlot}`, senderTelegramId: "100", referenceAt });
        if (!result || result.status === "invalid") {
            session = applyMealBreakReply({ session, text: `${ramal} 13:30`, senderTelegramId: "100", referenceAt })!.session;
        } else {
            session = result.session;
        }
    }

    if (session.stage !== "awaiting_lunch_choice") return;

    const secondCoi = session.lunchQueue[0]!;
    // Try to pick 12:30 (same as first COI)
    const result = applyMealBreakReply({
        session,
        text: `${secondCoi} 12:30`,
        senderTelegramId: "100",
        referenceAt,
    });

    assert.ok(result);
    assert.equal(result.status, "invalid", `COI ${secondCoi} nao deveria conseguir 12:30 (mesmo slot que ${firstCoi})`);
    assert.ok(result.messages.some((m) => m.includes("COI")), "Mensagem deve mencionar COI");
});

test("COI: auto-assign de descanso desvia COI para slot alternativo quando unico slot restante conflita", () => {
    const board = makeBoardWithCOI();
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const initial = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    let session = advanceToRestPhase(initial, referenceAt);
    assert.equal(session.stage, "awaiting_rest_choice");

    // Force scenario: COI-1 already at 16:30, COI-2 is in queue, and only 16:30 has capacity
    session = {
        ...session,
        restAssignments: {
            ...session.restAssignments,
            "1368": "16:30",
        },
        restQueue: ["1367"],
        restChoiceCapacities: { "15:30": 0, "16:30": 1 },
        stage: "awaiting_rest_choice",
    };

    // autoAssignRemainingRestIfSingleOption should fire through syncDaySessionState
    // but let's just test via applyMealBreakReply — since there's only 1 in queue and 1 slot,
    // auto-assign fires. But the COI conflict should redirect 1367 to 15:30.
    const resynced = syncDaySessionState(session);

    // Verify 1367 did NOT get 16:30 (same as 1368)
    assert.notEqual(
        resynced.restAssignments["1367"],
        resynced.restAssignments["1368"],
        `COI 1367 (${resynced.restAssignments["1367"]}) e 1368 (${resynced.restAssignments["1368"]}) nao podem ter o mesmo descanso`,
    );
});

test("COI: syncDaySessionState nao coloca dois COI no mesmo 14:30 quando ambos almocam 13:30", () => {
    const board = makeBoardWithCOI();
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const initial = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    // Set up: both COI lunched at 13:30, all lunches done, entering rest phase
    let session: ReturnType<typeof createMealBreakSession> = {
        ...initial,
        stage: "awaiting_rest_choice",
        lunchAssignments: {
            ...initial.lunchAssignments,
            "1367": "13:30",
            "1368": "13:30",
        },
        lunchQueue: [],
        recipRamal: "2035",
        mrvLunch1230Ramal: "2032",
    };

    const synced = syncDaySessionState(session);

    const rest1367 = synced.restAssignments["1367"];
    const rest1368 = synced.restAssignments["1368"];

    // At least one should be 14:30 (auto from 13:30 lunch), but NOT both
    const both1430 = rest1367 === "14:30" && rest1368 === "14:30";
    assert.ok(!both1430, `Ambos COI nao podem descansar as 14:30. 1367=${rest1367}, 1368=${rest1368}`);

    // If both have assignments, they must differ
    if (rest1367 && rest1368) {
        assert.notEqual(rest1367, rest1368, `COI 1367 (${rest1367}) e 1368 (${rest1368}) nao podem ter o mesmo descanso`);
    }

    // syncDaySessionState should also fix the lunch conflict
    assert.notEqual(
        synced.lunchAssignments["1367"],
        synced.lunchAssignments["1368"],
        `COI 1367 (lunch=${synced.lunchAssignments["1367"]}) e 1368 (lunch=${synced.lunchAssignments["1368"]}) nao podem almocar no mesmo horario`,
    );
});

test("COI: syncDaySessionState separa almocos e descansos duplicados quando ambos ja estao atribuidos", () => {
    const board = makeBoardWithCOI();
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const initial = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    // Both COI at 13:30 lunch → both would auto-get 14:30 rest, but sync must separate both
    let session: ReturnType<typeof createMealBreakSession> = {
        ...initial,
        stage: "completed",
        lunchAssignments: {
            "2035": "11:30",
            "2036": "11:30",
            "2037": "11:30",
            "2032": "12:30",
            "2038": "12:30",
            "2039": "12:30",
            "2151": "13:30",
            "1367": "13:30",
            "1368": "13:30",
        },
        restAssignments: {
            "2035": "18:00",
            "2032": "18:00",
            "2151": "18:00",
            "1367": "15:30",
            "1368": "15:30",
        },
        restQueue: [],
        lunchQueue: [],
        recipRamal: "2035",
        mrvLunch1230Ramal: "2032",
    };

    const synced = syncDaySessionState(session);

    assert.notEqual(
        synced.lunchAssignments["1367"],
        synced.lunchAssignments["1368"],
        `Almoco: 1367=${synced.lunchAssignments["1367"]}, 1368=${synced.lunchAssignments["1368"]} nao podem coincidir`,
    );

    // At least one COI gets 14:30 (auto from 13:30 lunch) — they can't both be 14:30 or both be flex
    const rest1367 = synced.restAssignments["1367"];
    const rest1368 = synced.restAssignments["1368"];
    if (rest1367 && rest1368) {
        assert.notEqual(rest1367, rest1368,
            `Descanso: 1367=${rest1367}, 1368=${rest1368} nao podem coincidir`,
        );
    }
});

test("COI: quando COI e o ultimo e unica vaga conflita, sistema forca horario alternativo no almoco", () => {
    const board = makeBoardWithCOI();
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const initial = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    // Simulate: COI-1 already at 12:30, COI-2 is next in queue, and only 12:30 has capacity
    let session: ReturnType<typeof createMealBreakSession> = {
        ...initial,
        stage: "awaiting_lunch_choice",
        lunchAssignments: {
            ...initial.lunchAssignments,
            "1368": "12:30",
        },
        lunchQueue: ["1367"],
        recipRamal: "2035",
        mrvLunch1230Ramal: "2032",
        lunchCapacities: { "11:30": 0, "12:30": 1, "13:30": 0 },
    };

    // COI-2 tries 12:30 (the only slot with capacity) — should be auto-diverted, not stuck
    const result = applyMealBreakReply({
        session,
        text: "1367 12:30",
        senderTelegramId: "100",
        referenceAt,
    });

    assert.ok(result);
    assert.notEqual(result.status, "invalid", "Nao deve travar — deve forcar horario alternativo");
    assert.notEqual(
        result.session.lunchAssignments["1367"],
        result.session.lunchAssignments["1368"],
        `Almoco COI-2 nao pode ser igual ao COI-1`,
    );
});

test("COI: quando COI e o ultimo e unica vaga no descanso conflita, sistema forca horario alternativo", () => {
    const board = makeBoardWithCOI();
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const initial = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    // COI-1 at 16:30, COI-2 at front of queue, only 16:30 has capacity
    let session: ReturnType<typeof createMealBreakSession> = {
        ...initial,
        stage: "awaiting_rest_choice",
        restAssignments: {
            ...initial.restAssignments,
            "1368": "16:30",
        },
        restQueue: ["1367"],
        restChoiceCapacities: { "15:30": 0, "16:30": 1 },
        recipRamal: "2035",
        mrvLunch1230Ramal: "2032",
        lunchQueue: [],
    };

    // COI-2 tries 16:30 — conflicts with peer, and only 16:30 has capacity — should auto-force
    const result = applyMealBreakReply({
        session,
        text: "1367 16:30",
        senderTelegramId: "100",
        referenceAt,
    });

    assert.ok(result);
    assert.notEqual(result.status, "invalid", "Nao deve travar — deve forcar horario alternativo");
    assert.notEqual(
        result.session.restAssignments["1367"],
        result.session.restAssignments["1368"],
        `Descanso COI-2 nao pode ser igual ao COI-1`,
    );
});

// --- COI reservation: non-COI cannot take slot that would force COI conflict ---

test("COI: nao-COI redirecionado no descanso quando escolha deixaria COIs sem opcao de separacao", () => {
    const board = makeBoardWithCOI();
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const initial = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    // COI-1 at 16:30, only 1 remaining at 15:30, non-COI tries 15:30 → would block COI-2
    let session: ReturnType<typeof createMealBreakSession> = {
        ...initial,
        stage: "awaiting_rest_choice",
        restAssignments: {
            ...initial.restAssignments,
            "1368": "16:30",
        },
        restQueue: ["2036", "1367"],
        restChoiceCapacities: { "15:30": 1, "16:30": 2 },
        recipRamal: "2035",
        mrvLunch1230Ramal: "2032",
        lunchQueue: [],
    };

    // 2036 (non-COI) tries 15:30 — taking the last slot COI-2 needs
    const result = applyMealBreakReply({
        session,
        text: "2036 15:30",
        senderTelegramId: "100",
        referenceAt,
    });

    assert.ok(result);
    assert.notEqual(result.status, "invalid", "Deve redirecionar, nao rejeitar");
    assert.equal(result.session.restAssignments["2036"], "16:30", "Nao-COI deve ser desviado para 16:30");
    assert.ok(result.messages.some((m) => m.includes("COI")), "Mensagem deve mencionar separacao dos COIs");
});

test("COI: nao-COI redirecionado no almoco quando escolha deixaria COIs sem opcao de separacao", () => {
    const board = makeBoardWithCOI();
    const referenceAt = new Date("2026-03-29T09:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const initial = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    // COI-1 at 12:30, only 11:30 and 12:30 have capacity. Non-COI tries 11:30 → COI-2 can only go 12:30 = conflict
    let session: ReturnType<typeof createMealBreakSession> = {
        ...initial,
        stage: "awaiting_lunch_choice",
        lunchAssignments: {
            "1368": "12:30",
        },
        lunchQueue: ["2036", "1367"],
        recipRamal: "2035",
        mrvLunch1230Ramal: "2032",
        lunchCapacities: { "11:30": 1, "12:30": 2, "13:30": 0 },
    };

    // 2036 tries 11:30 — would leave only 12:30 for COI-2 which conflicts with COI-1
    const result = applyMealBreakReply({
        session,
        text: "2036 11:30",
        senderTelegramId: "100",
        referenceAt,
    });

    assert.ok(result);
    assert.notEqual(result.status, "invalid", "Deve redirecionar, nao rejeitar");
    assert.equal(result.session.lunchAssignments["2036"], "12:30", "Nao-COI deve ser desviado para 12:30");
    assert.ok(result.messages.some((m) => m.includes("COI")), "Mensagem deve mencionar separacao dos COIs");
});

// --- Night COI tests ---

function makeNightBoardWithCOI() {
    const board = makeNightBoard();
    board.regulation.push(
        {
            postId: 20,
            occupancyId: "reg-night-1367",
            postCode: "1367",
            postLabel: "1367",
            defaultRole: "MR",
            doctorId: "doc-night-coi-1",
            doctorName: "Lilian Barros",
            displayName: "Lilian",
            startedAt: "2026-03-29T23:06:00.000Z",
            boardStartedAt: "2026-03-29T23:06:00.000Z",
            scheduledEndAt: "2026-03-30T11:00:00.000Z",
            shiftLabel: "SN",
            roleLabel: "COI",
            ramalLabel: "1367",
            status: "active",
            liveSource: "operations_v2",
            liveUpdatedAt: null,
        },
        {
            postId: 21,
            occupancyId: "reg-night-1368",
            postCode: "1368",
            postLabel: "1368",
            defaultRole: "MR",
            doctorId: "doc-night-coi-2",
            doctorName: "Claudio Azoubel",
            displayName: "Claudio",
            startedAt: "2026-03-29T23:07:00.000Z",
            boardStartedAt: "2026-03-29T23:07:00.000Z",
            scheduledEndAt: "2026-03-30T11:00:00.000Z",
            shiftLabel: "SN",
            roleLabel: "COI",
            ramalLabel: "1368",
            status: "active",
            liveSource: "operations_v2",
            liveUpdatedAt: null,
        },
    );
    return board;
}

test("COI noturno: rejeita escolha de trabalho quando outro COI ja esta nesse horario", () => {
    const board = makeNightBoardWithCOI();
    const referenceAt = new Date("2026-03-29T20:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const initial = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    // Confirm session
    let session = applyMealBreakReply({ session: initial, text: "✅ Confirmar", senderTelegramId: "100", referenceAt })!.session;

    // COI-1 at 23:00
    session = {
        ...session,
        nightWorkAssignments: { ...session.nightWorkAssignments, "1368": "23:00" },
        nightWorkQueue: ["1367", ...session.nightWorkQueue.filter((r) => r !== "1367" && r !== "1368")],
    };

    // COI-2 tries 23:00
    const result = applyMealBreakReply({
        session,
        text: "1367 23:00",
        senderTelegramId: "100",
        referenceAt,
    });

    assert.ok(result);
    assert.ok(result.status === "invalid" || result.session.nightWorkAssignments["1367"] !== "23:00",
        "COI-2 nao deve ter 23:00 quando COI-1 tambem esta em 23:00");
});

test("COI noturno: rejeita escolha de jantar quando outro COI ja esta nesse horario", () => {
    const board = makeNightBoardWithCOI();
    const referenceAt = new Date("2026-03-29T20:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const initial = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    // Confirm session
    let session = applyMealBreakReply({ session: initial, text: "✅ Confirmar", senderTelegramId: "100", referenceAt })!.session;

    // Both work 23:00, COI-1 dinner at 20:30
    session = {
        ...session,
        stage: "awaiting_dinner_choice" as const,
        nightWorkAssignments: {
            ...session.nightWorkAssignments,
            "1367": "23:00",
            "1368": "23:00",
        },
        dinnerAssignments: { ...session.dinnerAssignments, "1368": "20:30" },
        dinnerQueue: ["1367"],
        nightWorkQueue: [],
    };

    // COI-2 tries 20:30
    const result = applyMealBreakReply({
        session,
        text: "1367 20:30",
        senderTelegramId: "100",
        referenceAt,
    });

    assert.ok(result);
    assert.ok(result.status === "invalid" || result.session.dinnerAssignments["1367"] !== "20:30",
        "COI-2 nao deve jantar 20:30 quando COI-1 tambem janta 20:30");
});

test("COI noturno: nao-COI redirecionado no trabalho quando escolha bloquearia separacao", () => {
    const board = makeNightBoardWithCOI();
    const referenceAt = new Date("2026-03-29T20:05:00-03:00");
    const roster = buildMealBreakRoster(board, referenceAt);
    const initial = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt,
        trigger: "manual",
        restarted: false,
        actorTelegramId: "100",
    });

    let session = applyMealBreakReply({ session: initial, text: "✅ Confirmar", senderTelegramId: "100", referenceAt })!.session;

    // COI-1 at 03:00, non-COI tries 23:00 which is the last slot that would allow COI-2 to not conflict
    // Remaining: 23:00=1, 03:00=0 after all others assigned
    const allRamals = session.nightWorkQueue;
    const coiRamals = ["1367", "1368"];
    const nonCoiRamals = allRamals.filter((r) => !coiRamals.includes(r));
    const lastNonCoi = nonCoiRamals[nonCoiRamals.length - 1];

    // Fill all but last non-COI and both COIs
    const assignments: Record<string, string> = { "1368": "03:00" };
    for (const r of nonCoiRamals.slice(0, -1)) {
        assignments[r] = "23:00";
    }

    session = {
        ...session,
        nightWorkAssignments: assignments,
        nightWorkQueue: [lastNonCoi!, "1367"],
        nightWorkCapacities: { "23:00": Math.ceil(session.roster.length / 2), "03:00": Math.floor(session.roster.length / 2) },
    };

    // last non-COI tries 23:00 — would use the last 23:00 slot, forcing COI-2 to 03:00 (conflict with COI-1)
    const remaining2300 = session.nightWorkCapacities["23:00"] - Object.values(session.nightWorkAssignments).filter((s) => s === "23:00").length;
    if (remaining2300 === 1) {
        const result = applyMealBreakReply({
            session,
            text: `${lastNonCoi} 23:00`,
            senderTelegramId: "100",
            referenceAt,
        });

        assert.ok(result);
        assert.notEqual(result.status, "invalid", "Deve redirecionar, nao rejeitar");
        assert.equal(result.session.nightWorkAssignments[lastNonCoi!], "03:00", "Nao-COI deve ser desviado para 03:00");
    }
});
const TWO_MIN = 2 * 60 * 1000;
const BASE_ISO = "2026-03-29T12:00:00.000Z";
const baseMs = new Date(BASE_ISO).getTime();

test("resolveMealBreakTurnNudgeAction nao cutuca em estagio sem fila ou sem alguem na vez", () => {
    assert.deepEqual(
        resolveMealBreakTurnNudgeAction({ stage: "awaiting_confirmation", queueHead: "2036", sessionUpdatedAt: BASE_ISO, previous: null, nowMs: baseMs + TWO_MIN * 5 }),
        { send: false },
    );
    assert.deepEqual(
        resolveMealBreakTurnNudgeAction({ stage: "awaiting_lunch_choice", queueHead: null, sessionUpdatedAt: BASE_ISO, previous: null, nowMs: baseMs + TWO_MIN * 5 }),
        { send: false },
    );
});

test("resolveMealBreakTurnNudgeAction cutuca quem virou a vez so depois de 2 min", () => {
    assert.deepEqual(
        resolveMealBreakTurnNudgeAction({ stage: "awaiting_lunch_choice", queueHead: "2036", sessionUpdatedAt: BASE_ISO, previous: null, nowMs: baseMs + 60_000 }),
        { send: false },
    );
    assert.deepEqual(
        resolveMealBreakTurnNudgeAction({ stage: "awaiting_lunch_choice", queueHead: "2036", sessionUpdatedAt: BASE_ISO, previous: null, nowMs: baseMs + TWO_MIN }),
        { send: true, count: 1 },
    );
});

test("resolveMealBreakTurnNudgeAction espaca cutucoes do mesmo da vez em 2 min e incrementa contagem", () => {
    const previous = { ramal: "2036", at: BASE_ISO, count: 1 };
    assert.deepEqual(
        resolveMealBreakTurnNudgeAction({ stage: "awaiting_lunch_choice", queueHead: "2036", sessionUpdatedAt: "2026-03-29T11:50:00.000Z", previous, nowMs: baseMs + 90_000 }),
        { send: false },
    );
    assert.deepEqual(
        resolveMealBreakTurnNudgeAction({ stage: "awaiting_lunch_choice", queueHead: "2036", sessionUpdatedAt: "2026-03-29T11:50:00.000Z", previous, nowMs: baseMs + TWO_MIN }),
        { send: true, count: 2 },
    );
});

test("resolveMealBreakTurnNudgeAction reinicia a contagem quando a vez passa para outro ramal", () => {
    const previous = { ramal: "2035", at: "2026-03-29T11:59:30.000Z", count: 3 };
    // novo da vez (2036) virou a vez em sessionUpdatedAt; conta a partir dali, nao do cutucao antigo
    assert.deepEqual(
        resolveMealBreakTurnNudgeAction({ stage: "awaiting_lunch_choice", queueHead: "2036", sessionUpdatedAt: BASE_ISO, previous, nowMs: baseMs + TWO_MIN }),
        { send: true, count: 1 },
    );
});
