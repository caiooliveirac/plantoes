import assert from "node:assert/strict";
import test from "node:test";
import {
    emptyMealBreakChiefPins,
    resolveMealBreakChiefRewind,
    syncDaySessionState,
    type MealBreakChiefPins,
    type MealBreakDoctor,
    type MealBreakLunchSlot,
    type MealBreakRestSlot,
    type MealBreakSession,
} from "@/modules/telegram/meal-breaks";

function doctor(ramal: string, roleLabel: string | null = null): MealBreakDoctor {
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

function daySession(params: {
    roster: MealBreakDoctor[];
    lunchAssignments?: Record<string, MealBreakLunchSlot>;
    restAssignments?: Record<string, MealBreakRestSlot>;
    chiefPins?: Partial<MealBreakChiefPins>;
    mrvLunch1230Ramal?: string | null;
    events?: MealBreakSession["events"];
}): MealBreakSession {
    return {
        kind: "telegram_meal_break_session",
        version: 1,
        mode: "day",
        operationalDate: "2026-08-04",
        stage: "awaiting_lunch_choice",
        trigger: "manual",
        roster: params.roster,
        chiefRamal: null,
        recipRamal: "2153",
        mrvRamals: ["2154"],
        mrvLunch1230Ramal: params.mrvLunch1230Ramal === undefined ? "2154" : params.mrvLunch1230Ramal,
        lunchCapacities: { "11:30": 2, "12:30": 2, "13:30": 2 },
        lunchAssignments: params.lunchAssignments ?? {},
        lunchExcludedRamals: [],
        restAssignments: params.restAssignments ?? {},
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
        chiefPins: { ...emptyMealBreakChiefPins(), ...(params.chiefPins ?? {}) },
        createdAt: "2026-08-04T12:00:00.000Z",
        updatedAt: "2026-08-04T12:00:00.000Z",
        events: params.events ?? [],
    };
}

const ROSTER = [doctor("2153", "RECIP"), doctor("2154", "MRV"), doctor("2035"), doctor("2036")];

test("descanso fixado sobrevive à fase de almoço em aberto (era o clique que 'não funcionava')", () => {
    // Sem fixação, o sync apaga todo descanso não-fixo enquanto alguém não almoçou.
    const semFixacao = syncDaySessionState(daySession({
        roster: ROSTER,
        lunchAssignments: { "2153": "11:30" },
        restAssignments: { "2035": "15:30" },
    }));
    assert.equal(semFixacao.restAssignments["2035"], undefined);

    const comFixacao = syncDaySessionState(daySession({
        roster: ROSTER,
        lunchAssignments: { "2153": "11:30" },
        restAssignments: { "2035": "15:30" },
        chiefPins: { rest: { "2035": "15:30" } },
    }));
    assert.equal(comFixacao.restAssignments["2035"], "15:30");
});

test("fixação vence o 14:30 automático de quem almoçou 13:30", () => {
    const roster = [doctor("2153", "RECIP"), doctor("2154", "MRV"), doctor("2035")];
    const base = {
        roster,
        lunchAssignments: { "2153": "11:30", "2154": "12:30", "2035": "13:30" } as Record<string, MealBreakLunchSlot>,
    };

    const automatico = syncDaySessionState(daySession(base));
    assert.equal(automatico.restAssignments["2035"], "14:30");

    const fixado = syncDaySessionState(daySession({ ...base, chiefPins: { rest: { "2035": "16:30" } } }));
    assert.equal(fixado.restAssignments["2035"], "16:30");
});

test("fixação vence a capacidade do horário — chefe pode estourar a vaga", () => {
    const roster = [doctor("2153", "RECIP"), doctor("2154", "MRV"), doctor("2035"), doctor("2036"), doctor("2037")];
    const fixado = syncDaySessionState(daySession({
        roster,
        lunchAssignments: { "2153": "11:30", "2154": "12:30", "2035": "11:30", "2036": "11:30" },
        chiefPins: { lunch: { "2036": "11:30" } },
    }));

    // 11:30 tem capacidade 2 e ficou com 3 por decisão da chefia.
    assert.equal(
        Object.values(fixado.lunchAssignments).filter((slot) => slot === "11:30").length,
        3,
    );
    assert.equal(fixado.lunchAssignments["2036"], "11:30");
});

test("fixação vence a separação de par COI", () => {
    const roster = [doctor("2153", "RECIP"), doctor("2154", "MRV"), doctor("1367", "COI"), doctor("1368", "COI")];
    const fixado = syncDaySessionState(daySession({
        roster,
        lunchAssignments: { "2153": "11:30", "2154": "12:30", "1367": "13:30", "1368": "13:30" },
        chiefPins: { lunch: { "1367": "13:30", "1368": "13:30" } },
    }));

    // O par COI ficaria separado pela regra automática; fixado, os dois seguem juntos.
    assert.equal(fixado.lunchAssignments["1367"], "13:30");
    assert.equal(fixado.lunchAssignments["1368"], "13:30");
});

test("quem foi fixado sai da fila de pendência e não é mais cobrado", () => {
    const fixado = syncDaySessionState(daySession({
        roster: ROSTER,
        lunchAssignments: { "2153": "11:30", "2154": "12:30", "2035": "11:30", "2036": "12:30" },
        chiefPins: { lunch: { "2036": "12:30" } },
    }));

    assert.deepEqual(fixado.lunchQueue, []);
    // Com todos almoçados, a etapa seguinte (descanso) é que abre — o fixado
    // não volta para a fila de almoço.
    assert.equal(fixado.stage, "awaiting_rest_choice");
});

test("desfixar devolve o horário à regra automática", () => {
    const roster = [doctor("2153", "RECIP"), doctor("2154", "MRV"), doctor("2035")];
    const semPino = syncDaySessionState(daySession({
        roster,
        lunchAssignments: { "2153": "11:30", "2154": "12:30", "2035": "13:30" },
        restAssignments: { "2035": "16:30" },
        chiefPins: {},
    }));

    // Sem o pino, volta a valer o 14:30 automático de quem almoçou 13:30.
    assert.equal(semPino.restAssignments["2035"], "14:30");
});

test("rebobina: quem escolheu com o horário fixado já lotado reescolhe", () => {
    // Capacidade 11:30=2. O 2035 e o 2036 escolheram; depois a chefia FIXA o
    // 2037 no 11:30, que passa a estar cheio para quem ainda vai escolher.
    const before = daySession({
        roster: [doctor("2153", "RECIP"), doctor("2154", "MRV"), doctor("2035"), doctor("2036"), doctor("2037")],
        lunchAssignments: { "2035": "11:30", "2036": "12:30" },
        events: [
            { type: "lunch_selected", ramal: "2035", slot: "11:30", actorTelegramId: null, recordedAt: "2026-08-04T12:10:00.000Z" },
            { type: "lunch_selected", ramal: "2036", slot: "12:30", actorTelegramId: null, recordedAt: "2026-08-04T12:11:00.000Z" },
        ],
    });
    const after = {
        ...before,
        lunchAssignments: { ...before.lunchAssignments, "2037": "11:30" },
        lunchCapacities: { "11:30": 1 as number, "12:30": 2 as number, "13:30": 2 as number },
    };

    const rewind = resolveMealBreakChiefRewind({ before, after, pinnedRamal: "2037" });
    assert.ok(rewind);
    assert.equal(rewind.stage, "lunch");
    // O 2035 escolheu o próprio 11:30 (não foi barrado); o pivô é quem veio depois.
    assert.equal(rewind.pivotRamal, "2036");
    assert.deepEqual(rewind.clearedRamals, ["2036"]);
});

test("rebobina não dispara quando a fixação não tira vaga de ninguém", () => {
    const before = daySession({
        roster: [doctor("2153", "RECIP"), doctor("2154", "MRV"), doctor("2035"), doctor("2036")],
        lunchAssignments: { "2035": "11:30" },
        events: [
            { type: "lunch_selected", ramal: "2035", slot: "11:30", actorTelegramId: null, recordedAt: "2026-08-04T12:10:00.000Z" },
        ],
    });
    const after = { ...before, lunchAssignments: { ...before.lunchAssignments, "2036": "13:30" } };

    assert.equal(resolveMealBreakChiefRewind({ before, after, pinnedRamal: "2036" }), null);
});

test("o próprio fixado nunca é o pivô da rebobina", () => {
    const before = daySession({
        roster: [doctor("2153", "RECIP"), doctor("2154", "MRV"), doctor("2035")],
        lunchAssignments: {},
        events: [
            { type: "lunch_selected", ramal: "2035", slot: "11:30", actorTelegramId: null, recordedAt: "2026-08-04T12:10:00.000Z" },
        ],
    });
    const after = { ...before, lunchAssignments: { "2035": "13:30" } };

    const rewind = resolveMealBreakChiefRewind({ before, after, pinnedRamal: "2035" });
    assert.equal(rewind?.pivotRamal, undefined);
});
