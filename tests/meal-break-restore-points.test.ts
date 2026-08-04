import assert from "node:assert/strict";
import test from "node:test";
import {
    buildMealBreakRestoreListMessage,
    parseTelegramMealBreakCommand,
    resolveMealBreakSaveReasonLabel,
    summarizeMealBreakRevisions,
    type MealBreakDoctor,
    type MealBreakLunchSlot,
    type MealBreakSession,
    type MealBreakStage,
} from "@/modules/telegram/meal-breaks";

function doctor(ramal: string): MealBreakDoctor {
    return {
        doctorId: `doc-${ramal}`,
        ramal,
        name: `Medico ${ramal}`,
        domain: "regulation",
        startedAt: "2026-08-04T10:00:00.000Z",
        shiftLabel: "SD",
        roleLabel: null,
    };
}

function daySession(params: {
    stage: MealBreakStage;
    lunchAssignments?: Record<string, MealBreakLunchSlot>;
    restAssignments?: Record<string, "14:30" | "15:30" | "16:30" | "18:00">;
}): MealBreakSession {
    return {
        kind: "telegram_meal_break_session",
        version: 1,
        mode: "day",
        operationalDate: "2026-08-04",
        stage: params.stage,
        trigger: "manual",
        roster: [doctor("2035"), doctor("2036"), doctor("2037")],
        chiefRamal: null,
        recipRamal: "2035",
        mrvRamals: [],
        mrvLunch1230Ramal: "2036",
        lunchCapacities: { "11:30": 1, "12:30": 1, "13:30": 1 },
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
        createdAt: "2026-08-04T12:00:00.000Z",
        updatedAt: "2026-08-04T12:00:00.000Z",
        events: [],
    };
}

const REVISIONS = [
    {
        reason: "session_started" as const,
        savedAt: "2026-08-04T13:00:00.000Z",
        session: daySession({ stage: "awaiting_lunch_choice" }),
    },
    {
        reason: "choice" as const,
        savedAt: "2026-08-04T13:20:00.000Z",
        session: daySession({
            stage: "awaiting_rest_choice",
            lunchAssignments: { "2035": "11:30", "2036": "12:30", "2037": "13:30" },
            restAssignments: { "2035": "18:00" },
        }),
    },
    {
        // O estrago: a rebobina limpou as escolhas de todo mundo.
        reason: "latecomer_rewind" as const,
        savedAt: "2026-08-04T13:35:00.000Z",
        session: daySession({ stage: "awaiting_lunch_choice", lunchAssignments: { "2035": "11:30" } }),
    },
];

test("pontos de restauração vêm do mais novo para o mais antigo, numerados a partir de 1", () => {
    const summaries = summarizeMealBreakRevisions(REVISIONS);

    assert.deepEqual(summaries.map((entry) => entry.position), [1, 2, 3]);
    assert.deepEqual(summaries.map((entry) => entry.reason), ["latecomer_rewind", "choice", "session_started"]);
    // O ponto 2 é a divisão inteira de antes do estrago: 3 almoços + 1 descanso.
    assert.equal(summaries[1]?.assignedCount, 4);
    assert.equal(summaries[0]?.assignedCount, 1);
    assert.equal(summaries[2]?.assignedCount, 0);
});

test("cada ponto carrega a sessão completa daquele instante", () => {
    const summaries = summarizeMealBreakRevisions(REVISIONS);

    assert.deepEqual(summaries[1]?.session.lunchAssignments, { "2035": "11:30", "2036": "12:30", "2037": "13:30" });
    assert.equal(summaries[1]?.stage, "awaiting_rest_choice");
    assert.equal(summaries[1]?.rosterCount, 3);
});

test("a lista marca o estado atual e ensina o comando de voltar", () => {
    const message = buildMealBreakRestoreListMessage({
        mode: "day",
        revisions: summarizeMealBreakRevisions(REVISIONS),
    });

    assert.match(message, /Pontos de restauração da divisão do almoço/);
    assert.match(message, /1\).*rebobina do retardatário.*← estado atual/);
    assert.match(message, /2\).*escolha registrada.*4 horário\(s\)/);
    assert.match(message, /\/almoco restaurar <número>/);
});

test("sem ponto guardado a lista diz isso em vez de mentir com lista vazia", () => {
    assert.match(
        buildMealBreakRestoreListMessage({ mode: "night", revisions: [] }),
        /Não há ponto de restauração guardado para a divisão do jantar de hoje\./,
    );
});

test("motivo desconhecido não quebra o rótulo", () => {
    assert.equal(resolveMealBreakSaveReasonLabel("choice"), "escolha registrada");
    assert.equal(resolveMealBreakSaveReasonLabel("motivo_que_nao_existe"), "gravação");
    assert.equal(resolveMealBreakSaveReasonLabel(null), "gravação");
});

test("o comando de restaurar sobrevive a acento, maiúscula e @bot", () => {
    assert.equal(parseTelegramMealBreakCommand("/ALMOÇO RESTAURAR 2")?.action, "restore_apply");
    assert.equal(parseTelegramMealBreakCommand("/almoco@plantoes_bot restaurar")?.action, "restore_list");
    assert.equal(parseTelegramMealBreakCommand("/jantar restaurar 12")?.restorePosition, 12);
});
