import assert from "node:assert/strict";
import test from "node:test";
import { HALF_SHIFT_ROLE_LABEL } from "@/modules/operational/half-shift";
import {
    resolveMealBreakLatecomerSkip,
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
