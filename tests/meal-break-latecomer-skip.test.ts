import assert from "node:assert/strict";
import test from "node:test";
import { HALF_SHIFT_ROLE_LABEL } from "@/modules/operational/half-shift";
import {
    buildMealBreakRoster,
    resolveMealBreakLatecomerSkip,
    sanitizeMealBreakRosterForMode,
    type MealBreakDoctor,
    type MealBreakSession,
    type MealBreakMode,
    type MealBreakStage,
} from "@/modules/telegram/meal-breaks";

function doctor(ramal: string, roleLabel: string | null = null): MealBreakDoctor {
    return {
        doctorId: `doc-${ramal}`,
        ramal,
        name: `Medico ${ramal}`,
        domain: "regulation",
        startedAt: "2026-08-04T10:05:00.000Z",
        shiftLabel: "SD",
        roleLabel,
    };
}

function session(params: { stage: MealBreakStage; mode?: MealBreakMode }): MealBreakSession {
    return {
        kind: "telegram_meal_break_session",
        version: 1,
        mode: params.mode ?? "day",
        operationalDate: "2026-08-04",
        stage: params.stage,
        trigger: "manual",
        roster: [doctor("2031"), doctor("2032")],
        chiefRamal: null,
        recipRamal: "2031",
        mrvRamals: [],
        mrvLunch1230Ramal: "2032",
        lunchCapacities: { "11:30": 1, "12:30": 1, "13:30": 1 },
        lunchAssignments: { "2032": "12:30" },
        lunchExcludedRamals: [],
        restAssignments: { "2032": "15:30" },
        restExcludedRamals: [],
        restChoiceCapacities: { "15:30": 1, "16:30": 1 },
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
        updatedAt: "2026-08-04T12:10:00.000Z",
        events: [],
    };
}

test("divisão fechada: retardatário não entra nem rebobina", () => {
    assert.equal(
        resolveMealBreakLatecomerSkip({ session: session({ stage: "completed" }), roleLabel: null }),
        "division_completed",
    );
});

test("divisão fechada vale também para o jantar", () => {
    assert.equal(
        resolveMealBreakLatecomerSkip({ session: session({ stage: "completed", mode: "night" }), roleLabel: null }),
        "division_completed",
    );
});

test("meio plantão não redivide o almoço em andamento", () => {
    const inProgress = session({ stage: "awaiting_lunch_choice" });
    assert.equal(
        resolveMealBreakLatecomerSkip({ session: inProgress, roleLabel: HALF_SHIFT_ROLE_LABEL }),
        "half_shift",
    );
    // Mesma regra pelas variantes de rótulo aceitas na chegada.
    assert.equal(resolveMealBreakLatecomerSkip({ session: inProgress, roleLabel: "MEIO PLANTAO" }), "half_shift");
    assert.equal(resolveMealBreakLatecomerSkip({ session: inProgress, roleLabel: "MEIO" }), "half_shift");
});

test("plantão inteiro com divisão em andamento entra normalmente", () => {
    for (const stage of ["awaiting_confirmation", "awaiting_recip", "awaiting_mrv_lunch", "awaiting_lunch_choice", "awaiting_rest_choice"] as const) {
        assert.equal(resolveMealBreakLatecomerSkip({ session: session({ stage }), roleLabel: null }), null, stage);
    }
    assert.equal(
        resolveMealBreakLatecomerSkip({ session: session({ stage: "awaiting_night_work_choice", mode: "night" }), roleLabel: "COI" }),
        null,
    );
});

test("divisão fechada prevalece sobre o motivo do meio plantão", () => {
    assert.equal(
        resolveMealBreakLatecomerSkip({ session: session({ stage: "completed" }), roleLabel: HALF_SHIFT_ROLE_LABEL }),
        "division_completed",
    );
});

type Board = Parameters<typeof buildMealBreakRoster>[0];

function regulationRow(params: { postId: number; postCode: string; name: string; roleLabel: string | null }): Board["regulation"][number] {
    return {
        postId: params.postId,
        occupancyId: `reg-${params.postCode}`,
        postCode: params.postCode,
        postLabel: params.postCode,
        defaultRole: "MR",
        doctorId: `doc-${params.postCode}`,
        doctorName: params.name,
        displayName: params.name,
        startedAt: "2026-08-04T10:00:00.000Z",
        boardStartedAt: "2026-08-04T10:00:00.000Z",
        scheduledEndAt: "2026-08-04T22:00:00.000Z",
        shiftLabel: "SD",
        roleLabel: params.roleLabel,
        ramalLabel: params.postCode,
        status: "active",
        liveSource: "operations_v2",
        liveUpdatedAt: null,
    };
}

function boardWithHalfShift(): Board {
    return {
        generatedAt: "2026-08-04T15:00:00.000Z",
        regulation: [
            regulationRow({ postId: 1, postCode: "2035", name: "Renata Lima", roleLabel: null }),
            regulationRow({ postId: 2, postCode: "2036", name: "Bia Nunes", roleLabel: null }),
            regulationRow({ postId: 3, postCode: "2037", name: "Tarde Meia", roleLabel: HALF_SHIFT_ROLE_LABEL }),
            regulationRow({ postId: 4, postCode: "PIAM", name: "Paula Piam", roleLabel: null }),
        ],
        intervention: [],
    };
}

test("MEIO plantão fica fora do roster da divisão, como PIAM/NUCLEO", () => {
    const built = buildMealBreakRoster(boardWithHalfShift(), new Date("2026-08-04T12:00:00-03:00"), "day");
    assert.deepEqual(built.roster.map((doctor) => doctor.ramal), ["2035", "2036"]);
});

test("MEIO plantão em ramal de função fixa (COI) também fica fora", () => {
    const board = boardWithHalfShift();
    board.regulation[2] = regulationRow({ postId: 3, postCode: "1367", name: "Tarde Meia", roleLabel: HALF_SHIFT_ROLE_LABEL });
    const built = buildMealBreakRoster(board, new Date("2026-08-04T12:00:00-03:00"), "day");
    assert.equal(built.roster.some((doctor) => doctor.ramal === "1367"), false);
});

// Regressão (04/08/2026): a regra do meio plantão existia só no portão do
// quadro ao vivo (mapRegulationBoardEntry). Tudo que RECONSTRÓI a sessão —
// carregar do banco, reiniciar, restaurar a partir do resumo do grupo — passa
// pelo sanitizador, que olhava apenas o ramal (PIAM/NÚCLEO). Um meio plantão
// já gravado no roster sobrevivia à reconstrução: voltava a ser chamado para
// escolher almoço e, por ocupar vaga, mudava a capacidade dos horários,
// derrubando escolhas já fechadas de quem estava certo.
test("sanitizador tira MEIO plantão do roster, não só PIAM/NUCLEO", () => {
    const roster = [
        doctor("2035"),
        doctor("2037", HALF_SHIFT_ROLE_LABEL),
        doctor("PIAM"),
        doctor("2036"),
    ];

    assert.deepEqual(
        sanitizeMealBreakRosterForMode(roster, "day").map((item) => item.ramal),
        ["2035", "2036"],
    );
});

test("sanitizador aceita as grafias de meio plantão vindas do quadro", () => {
    for (const label of ["MEIO PLANTAO", "Meio Plantao", "MEIO"]) {
        assert.deepEqual(
            sanitizeMealBreakRosterForMode([doctor("2035"), doctor("2037", label)], "day")
                .map((item) => item.ramal),
            ["2035"],
            `grafia ${label} deveria sair da divisão`,
        );
    }
});

test("sanitizador vale também na divisão da noite", () => {
    assert.deepEqual(
        sanitizeMealBreakRosterForMode([doctor("2035"), doctor("2037", HALF_SHIFT_ROLE_LABEL)], "night")
            .map((item) => item.ramal),
        ["2035"],
    );
});
