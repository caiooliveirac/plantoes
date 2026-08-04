import assert from "node:assert/strict";
import test from "node:test";
import {
    applyMealBreakLatecomerRewind,
    resolveMealBreakLatecomerRewind,
    type MealBreakDoctor,
    type MealBreakSession,
} from "@/modules/telegram/meal-breaks";

function doctor(ramal: string, roleLabel: string | null = null): MealBreakDoctor {
    return {
        doctorId: `doc-${ramal}`,
        ramal,
        name: `Medico ${ramal}`,
        domain: "regulation",
        startedAt: "2026-08-03T22:05:00.000Z",
        shiftLabel: "SN",
        roleLabel,
    };
}

function nightSession(params: {
    roster: MealBreakDoctor[];
    nightWorkCapacities: Record<"23:00" | "03:00", number>;
    events: Array<{ type: "night_work_selected" | "night_dinner_selected"; ramal: string; slot: string; at: string }>;
    nightWorkAssignments?: Record<string, "23:00" | "03:00">;
    dinnerAssignments?: Record<string, "20:30" | "21:00" | "21:30" | "22:00" | "22:30">;
    dinnerChoiceCapacities?: Record<"20:30" | "21:00" | "21:30", number>;
}): MealBreakSession {
    return {
        kind: "telegram_meal_break_session",
        version: 1,
        mode: "night",
        operationalDate: "2026-08-03",
        stage: "awaiting_night_work_choice",
        trigger: "manual",
        roster: params.roster,
        chiefRamal: null,
        recipRamal: null,
        mrvRamals: [],
        mrvLunch1230Ramal: null,
        lunchCapacities: { "11:30": 0, "12:30": 0, "13:30": 0 },
        lunchAssignments: {},
        lunchExcludedRamals: [],
        restAssignments: {},
        restExcludedRamals: [],
        restChoiceCapacities: { "15:30": 0, "16:30": 0 },
        lunchQueue: [],
        restQueue: [],
        nightWorkCapacities: params.nightWorkCapacities,
        nightWorkAssignments: params.nightWorkAssignments ?? {},
        dinnerAssignments: params.dinnerAssignments ?? {},
        dinnerDurationAssignments: {},
        dinnerChoiceCapacities: params.dinnerChoiceCapacities ?? { "20:30": 0, "21:00": 0, "21:30": 0 },
        nightWorkQueue: [],
        dinnerQueue: [],
        undoSnapshots: [],
        createdAt: "2026-08-03T22:10:00.000Z",
        updatedAt: "2026-08-03T22:10:00.000Z",
        events: params.events.map((event) => ({
            type: event.type,
            ramal: event.ramal,
            slot: event.slot as never,
            actorTelegramId: null,
            recordedAt: event.at,
        })),
    };
}

test("todas as escolhas livres: sem rewind mesmo com capacidade nova", () => {
    const before = nightSession({
        roster: [doctor("2031"), doctor("2032"), doctor("2033")],
        nightWorkCapacities: { "23:00": 2, "03:00": 2 },
        events: [
            { type: "night_work_selected", ramal: "2031", slot: "23:00", at: "2026-08-03T22:11:00.000Z" },
            { type: "night_work_selected", ramal: "2032", slot: "03:00", at: "2026-08-03T22:12:00.000Z" },
        ],
    });
    const after = { ...before, nightWorkCapacities: { "23:00": 3 as number, "03:00": 2 as number } };
    assert.equal(resolveMealBreakLatecomerRewind({ before, after }), null);
});

test("escolha sob lotação vira pivô: quem escolheu depois refaz junto", () => {
    // caps 23:00=2/03:00=1; A e B enchem 23:00; C escolheu 03:00 SEM alternativa; D depois.
    const before = nightSession({
        roster: [doctor("2031"), doctor("2032"), doctor("2033"), doctor("2034")],
        nightWorkCapacities: { "23:00": 2, "03:00": 2 },
        events: [
            { type: "night_work_selected", ramal: "2031", slot: "23:00", at: "2026-08-03T22:11:00.000Z" },
            { type: "night_work_selected", ramal: "2032", slot: "23:00", at: "2026-08-03T22:12:00.000Z" },
            { type: "night_work_selected", ramal: "2033", slot: "03:00", at: "2026-08-03T22:13:00.000Z" },
            { type: "night_work_selected", ramal: "2034", slot: "03:00", at: "2026-08-03T22:14:00.000Z" },
        ],
    });
    const after = { ...before, nightWorkCapacities: { "23:00": 3 as number, "03:00": 2 as number } };
    const rewind = resolveMealBreakLatecomerRewind({ before, after });
    assert.ok(rewind);
    assert.equal(rewind.stage, "night_work");
    assert.equal(rewind.pivotRamal, "2033");
    assert.deepEqual(rewind.blockedSlots, ["23:00"]);
    assert.deepEqual(rewind.clearedRamals, ["2033", "2034"]);
});

test("sem mudança de capacidade não rebobina nada (escolha lotada mas +1 não abre vaga)", () => {
    const before = nightSession({
        roster: [doctor("2031"), doctor("2032"), doctor("2033")],
        nightWorkCapacities: { "23:00": 1, "03:00": 2 },
        events: [
            { type: "night_work_selected", ramal: "2031", slot: "23:00", at: "2026-08-03T22:11:00.000Z" },
            { type: "night_work_selected", ramal: "2032", slot: "03:00", at: "2026-08-03T22:12:00.000Z" },
        ],
    });
    const after = { ...before };
    assert.equal(resolveMealBreakLatecomerRewind({ before, after }), null);
});

test("COI bloqueado do horário do par (com vaga sobrando) é pivô", () => {
    // 1367/1368 são a dupla COI; 1367 pegou 23:00; 1368 foi forçado ao 03:00
    // mesmo havendo vaga no 23:00 — escolha não-livre.
    const before = nightSession({
        roster: [doctor("1367", "COI"), doctor("1368", "COI"), doctor("2031")],
        nightWorkCapacities: { "23:00": 2, "03:00": 1 },
        events: [
            { type: "night_work_selected", ramal: "1367", slot: "23:00", at: "2026-08-03T22:11:00.000Z" },
            { type: "night_work_selected", ramal: "1368", slot: "03:00", at: "2026-08-03T22:12:00.000Z" },
        ],
    });
    const after = { ...before, nightWorkCapacities: { "23:00": 2 as number, "03:00": 2 as number } };
    const rewind = resolveMealBreakLatecomerRewind({ before, after });
    assert.ok(rewind);
    assert.equal(rewind.pivotRamal, "1368");
    assert.deepEqual(rewind.blockedSlots, ["23:00"]);
});

test("re-escolha substitui a anterior no replay (última por ramal)", () => {
    // Sem dedup, as DUAS escolhas do 2031 consumiriam 23:00 e 03:00 e o 2032
    // viraria pivô indevido. Com dedup (só a última do 2031 vale), tudo livre.
    const before = nightSession({
        roster: [doctor("2031"), doctor("2032")],
        nightWorkCapacities: { "23:00": 1, "03:00": 2 },
        events: [
            { type: "night_work_selected", ramal: "2031", slot: "23:00", at: "2026-08-03T22:11:00.000Z" },
            { type: "night_work_selected", ramal: "2031", slot: "03:00", at: "2026-08-03T22:12:00.000Z" },
            { type: "night_work_selected", ramal: "2032", slot: "23:00", at: "2026-08-03T22:13:00.000Z" },
        ],
    });
    const after = { ...before, nightWorkCapacities: { "23:00": 2 as number, "03:00": 2 as number } };
    assert.equal(resolveMealBreakLatecomerRewind({ before, after }), null);
});

test("rewind de trabalho noturno limpa também a janta dos afetados", () => {
    const before = nightSession({
        roster: [doctor("2031"), doctor("2032"), doctor("2033")],
        nightWorkCapacities: { "23:00": 1, "03:00": 2 },
        nightWorkAssignments: { "2031": "23:00", "2032": "03:00", "2033": "03:00" },
        dinnerAssignments: { "2031": "20:30", "2032": "22:00", "2033": "22:00" },
        events: [
            { type: "night_work_selected", ramal: "2031", slot: "23:00", at: "2026-08-03T22:11:00.000Z" },
            { type: "night_work_selected", ramal: "2032", slot: "03:00", at: "2026-08-03T22:12:00.000Z" },
            { type: "night_work_selected", ramal: "2033", slot: "03:00", at: "2026-08-03T22:13:00.000Z" },
        ],
    });
    const after = { ...before, nightWorkCapacities: { "23:00": 2 as number, "03:00": 2 as number } };
    const rewind = resolveMealBreakLatecomerRewind({ before, after });
    assert.ok(rewind);
    assert.equal(rewind.pivotRamal, "2032");
    const cleared = applyMealBreakLatecomerRewind(before, rewind);
    assert.deepEqual(cleared.nightWorkAssignments, { "2031": "23:00" });
    assert.deepEqual(cleared.dinnerAssignments, { "2031": "20:30" });
});
