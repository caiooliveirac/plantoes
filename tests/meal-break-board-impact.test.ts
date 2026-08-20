import assert from "node:assert/strict";
import test from "node:test";
import {
    evaluateMealBreakSessionAgainstBoard,
    resolveMealBreakChoiceImpact,
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
    stage?: MealBreakSession["stage"];
}): MealBreakSession {
    return {
        kind: "telegram_meal_break_session",
        version: 1,
        mode: "night",
        operationalDate: "2026-08-03",
        stage: params.stage ?? "awaiting_night_work_choice",
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
        dinnerAssignments: {},
        dinnerDurationAssignments: {},
        dinnerChoiceCapacities: { "20:30": 0, "21:00": 0, "21:30": 0 },
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

test("escolhas livres: capacidade nova não rebobina", () => {
    const before = nightSession({
        roster: [doctor("2031"), doctor("2032"), doctor("2033")],
        nightWorkCapacities: { "23:00": 2, "03:00": 1 },
        events: [
            { type: "night_work_selected", ramal: "2031", slot: "23:00", at: "2026-08-03T22:11:00.000Z" },
            { type: "night_work_selected", ramal: "2032", slot: "03:00", at: "2026-08-03T22:12:00.000Z" },
        ],
        nightWorkAssignments: { "2031": "23:00", "2032": "03:00" },
    });
    const after = {
        ...before,
        nightWorkCapacities: { "23:00": 2 as number, "03:00": 2 as number },
        roster: [...before.roster, doctor("2034")],
    };
    assert.equal(resolveMealBreakChoiceImpact({ before, after }), null);
});

test("quem escolheu com 23:00 lotado reescolhe quando a vaga reabre (saída, caps iguais)", () => {
    // 4 pessoas, 23:00=2 / 03:00=2. A e B enchem 23:00; C é forçado a 03:00.
    // B sai: caps continuam 2/2 (3 pessoas: 2 e 1 — wait 3 is 2/1). Use rest-like
    // plateau: 4 people night = 2/2; remove B who had 23:00, remaining 3 = 2/1.
    // That's a cap change. To keep caps equal, rest 4→3 uses 2/2 for 15:30/16:30.
    const before = nightSession({
        roster: [doctor("2031"), doctor("2032"), doctor("2033"), doctor("2034")],
        nightWorkCapacities: { "23:00": 2, "03:00": 2 },
        events: [
            { type: "night_work_selected", ramal: "2031", slot: "23:00", at: "2026-08-03T22:11:00.000Z" },
            { type: "night_work_selected", ramal: "2032", slot: "23:00", at: "2026-08-03T22:12:00.000Z" },
            { type: "night_work_selected", ramal: "2033", slot: "03:00", at: "2026-08-03T22:13:00.000Z" },
        ],
        nightWorkAssignments: { "2031": "23:00", "2032": "23:00", "2033": "03:00" },
    });
    const after = {
        ...before,
        roster: before.roster.filter((entry) => entry.ramal !== "2032"),
        nightWorkCapacities: { "23:00": 2 as number, "03:00": 2 as number },
        nightWorkAssignments: { "2031": "23:00" as const, "2033": "03:00" as const },
    };
    const rewind = resolveMealBreakChoiceImpact({ before, after });
    assert.ok(rewind);
    assert.equal(rewind.pivotRamal, "2033");
    assert.deepEqual(rewind.blockedSlots, ["23:00"]);
    assert.deepEqual(rewind.clearedRamals, ["2033"]);
});

test("COI continua bloqueado do par: aumentar vaga do outro horário não rebobina", () => {
    const before = nightSession({
        roster: [doctor("1367", "COI"), doctor("1368", "COI"), doctor("2031")],
        nightWorkCapacities: { "23:00": 2, "03:00": 1 },
        events: [
            { type: "night_work_selected", ramal: "1367", slot: "23:00", at: "2026-08-03T22:11:00.000Z" },
            { type: "night_work_selected", ramal: "1368", slot: "03:00", at: "2026-08-03T22:12:00.000Z" },
        ],
        nightWorkAssignments: { "1367": "23:00", "1368": "03:00" },
    });
    const after = { ...before, nightWorkCapacities: { "23:00": 2 as number, "03:00": 2 as number } };
    assert.equal(resolveMealBreakChoiceImpact({ before, after }), null);
});

test("COI reescolhe se o par saiu e 23:00 ficou livre", () => {
    const before = nightSession({
        roster: [doctor("1367", "COI"), doctor("1368", "COI"), doctor("2031")],
        nightWorkCapacities: { "23:00": 2, "03:00": 1 },
        events: [
            { type: "night_work_selected", ramal: "1367", slot: "23:00", at: "2026-08-03T22:11:00.000Z" },
            { type: "night_work_selected", ramal: "1368", slot: "03:00", at: "2026-08-03T22:12:00.000Z" },
        ],
        nightWorkAssignments: { "1367": "23:00", "1368": "03:00" },
    });
    const after = {
        ...before,
        roster: [doctor("1368", "COI"), doctor("2031")],
        nightWorkCapacities: { "23:00": 1 as number, "03:00": 1 as number },
        nightWorkAssignments: { "1368": "03:00" as const },
    };
    const rewind = resolveMealBreakChoiceImpact({ before, after });
    assert.ok(rewind);
    assert.equal(rewind.pivotRamal, "1368");
    assert.ok(rewind.blockedSlots.includes("23:00"));
});

test("overfill: 5º no 11:30 vira pivô quando a vaga cai para 4", () => {
    const lunchEvents = ["2031", "2032", "2033", "2034", "2035"].map((ramal, index) => ({
        type: "lunch_selected" as const,
        ramal,
        slot: "11:30",
        at: `2026-08-04T12:1${index}:00.000Z`,
    }));
    const before: MealBreakSession = {
        ...nightSession({
            roster: ["2031", "2032", "2033", "2034", "2035", "2036"].map((ramal) => ({
                ...doctor(ramal),
                shiftLabel: "SD",
                startedAt: "2026-08-04T10:00:00.000Z",
            })),
            nightWorkCapacities: { "23:00": 0, "03:00": 0 },
            events: [],
        }),
        mode: "day",
        stage: "awaiting_lunch_choice",
        lunchCapacities: { "11:30": 5, "12:30": 4, "13:30": 4 },
        lunchAssignments: Object.fromEntries(lunchEvents.map((event) => [event.ramal, "11:30"])),
        events: lunchEvents.map((event) => ({
            type: event.type,
            ramal: event.ramal,
            slot: event.slot as never,
            actorTelegramId: null,
            recordedAt: event.at,
        })),
    };
    const after = {
        ...before,
        lunchCapacities: { "11:30": 4, "12:30": 4, "13:30": 4 },
    };
    const rewind = resolveMealBreakChoiceImpact({ before, after });
    assert.ok(rewind);
    assert.equal(rewind.pivotRamal, "2035");
    assert.deepEqual(rewind.clearedRamals, ["2035"]);
});

test("descanso 4 pessoas → 3: vagas 2/2 iguais, quem foi forçado ao 16:30 reescolhe", () => {
    const restDoctors = ["2041", "2042", "2043", "2044"].map((ramal) => ({
        ...doctor(ramal),
        shiftLabel: "SD" as const,
        startedAt: "2026-08-04T10:00:00.000Z",
    }));
    const before: MealBreakSession = {
        ...nightSession({
            roster: restDoctors,
            nightWorkCapacities: { "23:00": 0, "03:00": 0 },
            events: [],
        }),
        mode: "day",
        stage: "awaiting_rest_choice",
        lunchCapacities: { "11:30": 2, "12:30": 1, "13:30": 1 },
        restChoiceCapacities: { "15:30": 2, "16:30": 2 },
        restAssignments: { "2041": "15:30", "2042": "15:30", "2043": "16:30" },
        restExcludedRamals: [],
        events: [
            { type: "rest_selected", ramal: "2041", slot: "15:30", actorTelegramId: null, recordedAt: "2026-08-04T12:11:00.000Z" },
            { type: "rest_selected", ramal: "2042", slot: "15:30", actorTelegramId: null, recordedAt: "2026-08-04T12:12:00.000Z" },
            { type: "rest_selected", ramal: "2043", slot: "16:30", actorTelegramId: null, recordedAt: "2026-08-04T12:13:00.000Z" },
        ],
    };
    const after = {
        ...before,
        restExcludedRamals: ["2042"],
        restAssignments: { "2041": "15:30" as const, "2043": "16:30" as const },
        restChoiceCapacities: { "15:30": 2 as number, "16:30": 2 as number },
    };
    const rewind = resolveMealBreakChoiceImpact({ before, after });
    assert.ok(rewind);
    assert.equal(rewind.stage, "rest_choice");
    assert.equal(rewind.pivotRamal, "2043");
    assert.deepEqual(rewind.blockedSlots, ["15:30"]);
    assert.deepEqual(rewind.clearedRamals, ["2043"]);
});

function regulationRow(ramal: string) {
    return {
        postId: Number(ramal),
        occupancyId: `occ-${ramal}`,
        postCode: ramal,
        postLabel: ramal,
        defaultRole: null,
        doctorId: `doc-${ramal}`,
        doctorName: `Medico ${ramal}`,
        displayName: `Medico ${ramal}`,
        startedAt: "2026-08-03T22:05:00.000Z",
        boardStartedAt: "2026-08-03T22:05:00.000Z",
        scheduledEndAt: "2026-08-04T10:00:00.000Z",
        shiftLabel: "SN" as const,
        roleLabel: null,
        ramalLabel: ramal,
        status: "active" as const,
        liveSource: "operations_v2" as const,
        liveUpdatedAt: null,
    };
}

test("divisão fechada + alguém saiu: stale, sem projetar como rewind aplicado", () => {
    const session = nightSession({
        roster: [doctor("2041"), doctor("2042"), doctor("2043")],
        nightWorkCapacities: { "23:00": 2, "03:00": 1 },
        events: [
            { type: "night_work_selected", ramal: "2041", slot: "23:00", at: "2026-08-03T22:11:00.000Z" },
            { type: "night_work_selected", ramal: "2042", slot: "03:00", at: "2026-08-03T22:12:00.000Z" },
            { type: "night_work_selected", ramal: "2043", slot: "23:00", at: "2026-08-03T22:13:00.000Z" },
        ],
        nightWorkAssignments: { "2041": "23:00", "2042": "03:00", "2043": "23:00" },
        stage: "completed",
    });

    const { evaluation } = evaluateMealBreakSessionAgainstBoard({
        session,
        board: {
            generatedAt: "2026-08-03T23:00:00.000Z",
            regulation: [regulationRow("2041"), regulationRow("2043")],
            intervention: [],
        } as never,
        referenceAt: new Date("2026-08-03T23:00:00.000Z"),
    });
    assert.equal(evaluation.kind, "stale");
    assert.ok(evaluation.staleHint);
    assert.deepEqual(evaluation.rosterRemoved, ["2042"]);
});
