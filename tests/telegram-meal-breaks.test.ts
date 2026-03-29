import assert from "node:assert/strict";
import test from "node:test";
import {
    applyMealBreakReply,
    buildMealBreakRoster,
    createMealBreakSession,
    isTelegramMealBreakCommandText,
    parseTelegramMealBreakCommand,
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

test("resolveMealBreakLunchCapacities segue a distribuicao proporcional esperada", () => {
    assert.deepEqual(resolveMealBreakLunchCapacities(11), { "11:30": 4, "12:30": 3, "13:30": 4 });
    assert.deepEqual(resolveMealBreakLunchCapacities(10), { "11:30": 4, "12:30": 3, "13:30": 3 });
    assert.deepEqual(resolveMealBreakLunchCapacities(8), { "11:30": 3, "12:30": 2, "13:30": 3 });
    assert.deepEqual(resolveMealBreakLunchCapacities(5), { "11:30": 2, "12:30": 1, "13:30": 2 });
});

test("parseTelegramMealBreakCommand reconhece o comando e o reinicio", () => {
    assert.equal(isTelegramMealBreakCommandText("/almoco"), true);
    assert.equal(isTelegramMealBreakCommandText("/almoco reiniciar"), true);
    assert.deepEqual(parseTelegramMealBreakCommand("/almoco"), {
        name: "meal_break",
        forceRestart: false,
        rawBody: "",
    });
    assert.deepEqual(parseTelegramMealBreakCommand("/almoco reiniciar"), {
        name: "meal_break",
        forceRestart: true,
        rawBody: "reiniciar",
    });
    assert.equal(parseTelegramMealBreakCommand("/almoco agora"), null);
});

test("buildMealBreakRoster monta a fila do diurno sem chefia e sem noturno", () => {
    const roster = buildMealBreakRoster(makeBoard(), new Date("2026-03-29T09:05:00-03:00"));

    assert.equal(roster.chiefRamal, "2031");
    assert.deepEqual(roster.mrvRamals, ["2032", "2151"]);
    assert.deepEqual(roster.roster.map((doctor) => doctor.ramal), ["2032", "2151", "2035", "2036", "2037", "2038", "2039"]);
    assert.equal(roster.roster.find((doctor) => doctor.ramal === "2032")?.roleLabel, "MRV");
    assert.equal(roster.roster.some((doctor) => doctor.ramal === "PP20"), false);
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
    assert.match(rest2?.messages[1] ?? "", /ALMOCO/);
    assert.match(rest2?.messages[1] ?? "", /14:30 - 2039 - Patricia Paiva/);
    assert.match(rest2?.messages[1] ?? "", /18:00 - 2032 - Marina Costa \(MRV\), 2151 - Carlos Melo \(MRV\), 2035 - Renata Lima \(RECIP \/ MR\)/);
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