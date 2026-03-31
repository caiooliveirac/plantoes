import assert from "node:assert/strict";
import test from "node:test";
import {
    applyMealBreakContinuityStarts,
    applyMealBreakReply,
    buildMealBreakConsistencyAdminReply,
    buildMealBreakPriorityReply,
    buildMealBreakPriorityReplyMessages,
    buildMealBreakRoster,
    createMealBreakSession,
    getCurrentMealBreakPriorityView,
    isTelegramMealBreakCommandText,
    isTelegramMealBreakPriorityCommandText,
    parseTelegramMealBreakCommand,
    parseTelegramMealBreakPriorityCommand,
    resolveMealBreakContinuityStartedAt,
    resolveMealBreakLunchCapacities,
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
    assert.equal(isTelegramMealBreakCommandText("/almoco reiniciar"), true);
    assert.equal(isTelegramMealBreakCommandText("/jantar"), true);
    assert.deepEqual(parseTelegramMealBreakCommand("/almoco"), {
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
        assert.match(message, /PRIORIDADES DO ALMOCO/);
    }
});

test("buildMealBreakRoster monta a fila do diurno sem chefia e sem noturno", () => {
    const roster = buildMealBreakRoster(makeBoard(), new Date("2026-03-29T09:05:00-03:00"));

    assert.equal(roster.chiefRamal, "2031");
    assert.deepEqual(roster.mrvRamals, ["2032", "2151"]);
    assert.deepEqual(roster.roster.map((doctor) => doctor.ramal), ["2032", "2151", "2035", "2036", "2037", "2038", "2039"]);
    assert.equal(roster.roster.find((doctor) => doctor.ramal === "2032")?.roleLabel, "MRV");
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
    };
    board.regulation[4] = {
        ...board.regulation[4]!,
        startedAt: "2026-03-29T10:16:00.000Z",
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
    assert.match(view.warnings[0]?.message ?? "", /Renata Lima aparece em mais de um ramal ativo: 2035, 2036\./);
    assert.match(view.warnings[0]?.message ?? "", /A fila vai considerar 2035\./);

    const reply = buildMealBreakPriorityReply(view);
    assert.match(reply, /⚠️ Renata Lima aparece em mais de um ramal ativo: 2035, 2036\. A fila vai considerar 2035\./);
});

test("applyMealBreakReply orders blank remote ramal by normal arrival instead of RMT penalty", () => {
    const board = makeBoard();
    board.regulation[3]!.startedAt = "2026-03-29T10:00:00.000Z";
    board.regulation[4]!.startedAt = "2026-03-29T10:10:00.000Z";
    board.regulation[5]!.startedAt = "2026-03-29T10:16:00.000Z";
    board.regulation[7]!.startedAt = "2026-03-29T10:01:00.000Z";
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

    const recip = applyMealBreakReply({
        session,
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

    const recip = applyMealBreakReply({
        session,
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
    board.regulation[4]!.startedAt = "2026-03-29T10:10:00.000Z";
    board.regulation[5]!.startedAt = "2026-03-29T10:16:00.000Z";
    board.regulation[7]!.startedAt = "2026-03-29T10:01:00.000Z";
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

    const recip = applyMealBreakReply({
        session,
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

    const recip = applyMealBreakReply({
        session,
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

    const recip = applyMealBreakReply({
        session,
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
    assert.match(outOfTurn?.messages[0] ?? "", /chamado atual e para o ramal 2036/i);

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
    const lunch4 = applyMealBreakReply({
        session: lunch3!.session,
        text: "2039 13:30",
        senderTelegramId: "105",
        referenceAt,
    });

    assert.ok(lunch4);
    assert.equal(lunch4?.session.stage, "awaiting_rest_choice");
    assert.equal(lunch4?.session.restAssignments["2039"], "14:30");
    assert.equal(lunch4?.session.restAssignments["2035"], "18:00");
    assert.equal(lunch4?.session.restAssignments["2032"], "18:00");
    assert.equal(lunch4?.session.restAssignments["2151"], "18:00");
    assert.deepEqual(lunch4?.session.restQueue, ["2036", "2037", "2038"]);

    const rest1 = applyMealBreakReply({
        session: lunch4!.session,
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
    assert.equal(rest2?.session.stage, "completed");
    assert.equal(rest2?.session.restAssignments["2038"], "15:30");
    assert.match(rest2?.messages[1] ?? "", /🍽️ ALMOCO/);
    assert.match(rest2?.messages[1] ?? "", /14:30\n• Patricia Paiva/);
    assert.match(rest2?.messages[1] ?? "", /18:00\n• Marina Costa \(MRV\)\n• Carlos Melo \(MRV\)\n• Renata Lima \(RECIP\)/);
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

    assert.equal(session.stage, "awaiting_night_work_choice");
    assert.deepEqual(session.nightWorkCapacities, { "23:00": 4, "03:00": 4 });
    assert.deepEqual(session.nightWorkQueue, ["2032", "2033", "2034", "2035", "2036", "2037", "2038", "2039"]);

    const work1 = applyMealBreakReply({
        session,
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
    assert.equal(work4?.session.dinnerAssignments["2034"], "22:30");
    assert.equal(work4?.session.dinnerAssignments["2035"], "22:30");

    const work5 = applyMealBreakReply({
        session: work4!.session,
        text: "2036 23:00",
        senderTelegramId: "905",
        referenceAt,
    });
    const work6 = applyMealBreakReply({
        session: work5!.session,
        text: "2037 23:00",
        senderTelegramId: "906",
        referenceAt,
    });
    const work7 = applyMealBreakReply({
        session: work6!.session,
        text: "2038 23:00",
        senderTelegramId: "907",
        referenceAt,
    });
    const work8 = applyMealBreakReply({
        session: work7!.session,
        text: "2039 23:00",
        senderTelegramId: "908",
        referenceAt,
    });

    assert.ok(work8);
    assert.equal(work8?.session.stage, "awaiting_dinner_choice");
    assert.deepEqual(work8?.session.dinnerChoiceCapacities, { "20:30": 2, "21:00": 1, "21:30": 1 });
    assert.deepEqual(work8?.session.dinnerQueue, ["2036", "2037", "2038", "2039"]);

    const dinner1 = applyMealBreakReply({
        session: work8!.session,
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
    assert.match(dinner3?.messages[1] ?? "", /22:00\n• Marina Costa \(MRV\) - 1h/);
    assert.match(dinner3?.messages[1] ?? "", /22:30\n• Renata Lima - 30min/);
    assert.match(dinner3?.messages[1] ?? "", /🌙 TRABALHO\n23:00/);
    assert.match(dinner3?.messages[1] ?? "", /03:00\n• Marina Costa \(MRV\)/);
});