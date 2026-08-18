import assert from "node:assert/strict";
import test from "node:test";
import { HALF_SHIFT_ROLE_LABEL } from "@/modules/operational/half-shift";
import {
    dropHalfShiftFromMealBreakSession,
    syncDaySessionState,
    type MealBreakDoctor,
    type MealBreakLunchSlot,
    type MealBreakRestSlot,
    type MealBreakSession,
} from "@/modules/telegram/meal-breaks";

// Estado real da produção em 04/08/2026: a divisão de 9 médicos foi restaurada,
// mas o roster PERSISTIDO ainda carregava a retardatária de MEIO plantão (1361),
// montado antes da regra que a tira da divisão. Sem almoço, ela trava a fase —
// e o sync apaga todo descanso que não seja 18:00 fixo.
const ROSTER: Array<MealBreakDoctor & { lunch?: MealBreakLunchSlot; rest?: MealBreakRestSlot }> = [
    { ...doctor("1368", "COI"), lunch: "13:30", rest: "14:30" },
    { ...doctor("2151", "MRV"), lunch: "13:30", rest: "18:00" },
    { ...doctor("1322", "IES"), lunch: "13:30", rest: "14:30" },
    { ...doctor("2153", "RECIP"), lunch: "11:30", rest: "18:00" },
    { ...doctor("2152", null), lunch: "11:30", rest: "15:30" },
    { ...doctor("1362", "RMT"), lunch: "11:30", rest: "16:30" },
    { ...doctor("1367", "COI"), lunch: "12:30", rest: "16:30" },
    { ...doctor("2154", "MRV"), lunch: "12:30", rest: "18:00" },
    { ...doctor("1363", "RMT"), lunch: "12:30", rest: "15:30" },
    { ...doctor("1361", HALF_SHIFT_ROLE_LABEL) },
];

function doctor(ramal: string, roleLabel: string | null): MealBreakDoctor {
    return {
        doctorId: `doc-${ramal}`,
        ramal,
        name: `Medico ${ramal}`,
        domain: "regulation",
        startedAt: "2026-08-04T10:00:00.000Z",
        shiftLabel: "SD",
        roleLabel,
    };
}

function sessionWith(members: typeof ROSTER): MealBreakSession {
    const lunchAssignments: Record<string, MealBreakLunchSlot> = {};
    const restAssignments: Record<string, MealBreakRestSlot> = {};
    for (const member of members) {
        if (member.lunch) lunchAssignments[member.ramal] = member.lunch;
        if (member.rest) restAssignments[member.ramal] = member.rest;
    }

    return {
        kind: "telegram_meal_break_session",
        version: 1,
        mode: "day",
        operationalDate: "2026-08-04",
        stage: "awaiting_rest_choice",
        trigger: "manual",
        roster: members.map(({ lunch: _l, rest: _r, ...rest }) => rest),
        chiefRamal: "2031",
        recipRamal: "2153",
        mrvRamals: ["2154", "2151"],
        mrvLunch1230Ramal: "2154",
        lunchCapacities: { "11:30": 4, "12:30": 3, "13:30": 3 },
        lunchAssignments,
        lunchExcludedRamals: [],
        restAssignments,
        restExcludedRamals: [],
        restChoiceCapacities: { "15:30": 2, "16:30": 2 },
        lunchQueue: [],
        restQueue: [],
        nightWorkCapacities: { "23:00": 0, "03:00": 0 },
        nightWorkAssignments: {},
        dinnerAssignments: {},
        dinnerDurationAssignments: {},
        dinnerChoiceCapacities: { "20:30": 0, "21:00": 0, "21:30": 0 },
        nightWorkQueue: [],
        dinnerQueue: [],
        undoSnapshots: [],
        createdAt: "2026-08-04T12:00:00.000Z",
        updatedAt: "2026-08-04T12:00:00.000Z",
        events: [],
    };
}

test("MEIO plantão no roster trava a fase de almoço e o sync apaga os descansos", () => {
    // Documenta o estrago observado em produção — é a razão de a restauração
    // ter que remover o meio plantão do roster antes de gravar.
    const synced = syncDaySessionState(sessionWith(ROSTER));

    assert.deepEqual(synced.lunchQueue, ["1361"]);
    assert.equal(synced.stage, "awaiting_lunch_choice");
    // Sobra só o 18:00 fixo de RECIP/MRV; 14:30, 15:30 e 16:30 somem.
    assert.deepEqual(
        Object.entries(synced.restAssignments).sort(),
        [["2151", "18:00"], ["2153", "18:00"], ["2154", "18:00"]],
    );
});

test("sem o MEIO plantão no roster a divisão volta inteira e fecha", () => {
    const synced = syncDaySessionState(sessionWith(ROSTER.filter((member) => member.ramal !== "1361")));

    assert.deepEqual(synced.lunchQueue, []);
    assert.deepEqual(synced.restQueue, []);
    assert.equal(synced.stage, "completed");
    assert.deepEqual(
        Object.entries(synced.restAssignments).sort(),
        [
            ["1322", "14:30"],
            ["1362", "16:30"],
            ["1363", "15:30"],
            ["1367", "16:30"],
            ["1368", "14:30"],
            ["2151", "18:00"],
            ["2152", "15:30"],
            ["2153", "18:00"],
            ["2154", "18:00"],
        ],
    );
    // Almoços intactos, exatamente como o balão do grupo.
    assert.deepEqual(
        Object.entries(synced.lunchAssignments).sort(),
        [
            ["1322", "13:30"],
            ["1362", "11:30"],
            ["1363", "12:30"],
            ["1367", "12:30"],
            ["1368", "13:30"],
            ["2151", "13:30"],
            ["2152", "11:30"],
            ["2153", "11:30"],
            ["2154", "12:30"],
        ],
    );
});

// A regra fixa também precisa alcançar a sessão JÁ PERSISTIDA: o roster fica
// gravado no payload e não é recalculado, então o deploy da regra sozinho não
// tira o meio plantão de uma divisão em curso (foi o que manteve a 1361 na
// enquete depois do redeploy de 04/08/2026).
function boardRow(ramal: string, roleLabel: string | null) {
    return {
        postId: Number(ramal.replace(/\D/g, "")) || 1,
        occupancyId: `reg-${ramal}`,
        postCode: ramal,
        postLabel: ramal,
        defaultRole: "MR",
        doctorId: `doc-${ramal}`,
        doctorName: `Medico ${ramal}`,
        displayName: `Medico ${ramal}`,
        startedAt: "2026-08-04T10:00:00.000Z",
        boardStartedAt: "2026-08-04T10:00:00.000Z",
        scheduledEndAt: "2026-08-04T22:00:00.000Z",
        shiftLabel: "SD" as const,
        roleLabel,
        ramalLabel: ramal,
        status: "active" as const,
        liveSource: "operations_v2" as const,
        liveUpdatedAt: null,
    };
}

test("dropHalfShiftFromMealBreakSession destrava a divisão em curso", () => {
    const board = {
        generatedAt: "2026-08-04T19:00:00.000Z",
        regulation: ROSTER.map((member) => boardRow(member.ramal, member.roleLabel)),
        intervention: [],
    };

    const cleaned = dropHalfShiftFromMealBreakSession({ session: sessionWith(ROSTER), board });

    assert.equal(cleaned.roster.some((doctor) => doctor.ramal === "1361"), false);
    assert.deepEqual(cleaned.lunchQueue, []);
    assert.equal(cleaned.stage, "completed");
    // Os descansos do balão sobrevivem porque a fase de almoço fechou.
    assert.equal(Object.keys(cleaned.restAssignments).length, 9);
});

test("papel vivo do quadro tem precedência: função virou MEIO no painel durante o turno", () => {
    // No roster o 2152 é regulador comum; no quadro a chefia já trocou para MEIO.
    const board = {
        generatedAt: "2026-08-04T19:00:00.000Z",
        regulation: ROSTER.map((member) => boardRow(
            member.ramal,
            member.ramal === "2152" ? HALF_SHIFT_ROLE_LABEL : member.roleLabel,
        )),
        intervention: [],
    };

    const cleaned = dropHalfShiftFromMealBreakSession({ session: sessionWith(ROSTER), board });
    assert.equal(cleaned.roster.some((doctor) => doctor.ramal === "2152"), false);
    assert.equal(cleaned.lunchAssignments["2152"], undefined);
});
