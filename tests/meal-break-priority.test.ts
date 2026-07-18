import assert from "node:assert/strict";
import test from "node:test";
import {
    applyMealBreakPriorityOverrides,
    resolvePriorityOverridesByDoctorId,
    type MealBreakPriorityContextEntry,
    type MealBreakPriorityOverrideRecord,
} from "@/modules/telegram/meal-breaks";

function makeEntry(doctorId: string, ramal: string, index: number): MealBreakPriorityContextEntry {
    return {
        rank: index + 1,
        automaticRank: index + 1,
        doctor: {
            doctorId,
            ramal,
            name: doctorId,
            domain: "regulation",
            startedAt: "2026-03-29T10:00:00.000Z",
            shiftLabel: "SD",
            roleLabel: null,
        },
        actualStartedAt: "2026-03-29T10:00:00.000Z",
        continuityStartedAt: null,
        priorityStartedAt: "2026-03-29T10:00:00.000Z",
        automaticReasons: [],
        manualJustification: null,
    };
}

function orderOf(entries: MealBreakPriorityContextEntry[]) {
    return entries.map((entry) => entry.doctor.doctorId);
}

test("prioridade v2 segue o medico (doctorId) mesmo apos remanejamento de ramal", () => {
    // Ordem manual definida quando Reinaldo (doc-reinaldo) estava no 2041.
    const overrides: MealBreakPriorityOverrideRecord = {
        kind: "telegram_meal_break_priority_overrides",
        version: 2,
        mode: "day",
        operationalDate: "2026-03-29",
        orderedDoctorIds: ["doc-reinaldo", "doc-ana", "doc-bruno"],
        justifications: {
            "doc-reinaldo": { notes: "chegou cedo", actorUserId: null, updatedAt: "2026-03-29T10:00:00.000Z" },
        },
        updatedAt: "2026-03-29T10:00:00.000Z",
    };

    // Roster atual: Reinaldo foi remanejado para 1368 (ramal diferente do 2041 original).
    const entries = [
        makeEntry("doc-ana", "2035", 0),
        makeEntry("doc-bruno", "2036", 1),
        makeEntry("doc-reinaldo", "1368", 2),
    ];

    const applied = applyMealBreakPriorityOverrides({ entries, overrides });

    // A posicao manual continua valendo: Reinaldo em primeiro, apesar da troca de ramal.
    assert.deepEqual(orderOf(applied), ["doc-reinaldo", "doc-ana", "doc-bruno"]);
    // E a justificativa manual continua atrelada a ele.
    assert.equal(applied[0].manualJustification?.notes, "chegou cedo");
});

test("registro legado v1 (por ramal) e traduzido ramal->doctorId pelo roster vivo", () => {
    const legacy: MealBreakPriorityOverrideRecord = {
        kind: "telegram_meal_break_priority_overrides",
        version: 1,
        mode: "day",
        operationalDate: "2026-03-29",
        orderedRamals: ["2041", "2035"],
        justifications: {
            "2041": { notes: "prioridade manual", actorUserId: null, updatedAt: "2026-03-29T10:00:00.000Z" },
        },
        updatedAt: "2026-03-29T10:00:00.000Z",
    };

    const entries = [
        makeEntry("doc-ana", "2035", 0),
        makeEntry("doc-reinaldo", "2041", 1),
    ];

    const resolved = resolvePriorityOverridesByDoctorId(legacy, entries);
    assert.deepEqual(resolved.orderedDoctorIds, ["doc-reinaldo", "doc-ana"]);
    assert.equal(resolved.justifications["doc-reinaldo"]?.notes, "prioridade manual");

    const applied = applyMealBreakPriorityOverrides({ entries, overrides: legacy });
    assert.deepEqual(orderOf(applied), ["doc-reinaldo", "doc-ana"]);
});

test("override vazio mantem a ordem automatica (sem prioridade manual)", () => {
    const entries = [
        makeEntry("doc-ana", "2035", 0),
        makeEntry("doc-bruno", "2036", 1),
    ];
    const applied = applyMealBreakPriorityOverrides({ entries, overrides: null });
    assert.deepEqual(orderOf(applied), ["doc-ana", "doc-bruno"]);
    assert.equal(applied.every((entry) => entry.manualJustification === null), true);
});

test("REGRESSAO 2026-07-18: painel descobre sessao de refeicao pelos notices do banco, nao so pelo env", async () => {
    // Com TELEGRAM_ALLOWED_CHAT_IDS vazio (magalu pos-migracao), o bot rodava o
    // /almoco no grupo mas painel e lembretes nao enxergavam a sessao persistida.
    // A descoberta agora considera os chats com sessao gravada no banco.
    const { filterMealBreakSessionNoticeChatIds } = await import("@/modules/telegram/meal-breaks");

    const rows = [
        { noticeKey: "-1001591556887:meal_break:session:day", chatId: "-1001591556887" },
        { noticeKey: "-1001591556887:meal_break:session:night", chatId: "-1001591556887" },
        { noticeKey: "-2009999999999:meal_break:session", chatId: "-2009999999999" }, // legado (sem sufixo de modo)
        { noticeKey: "-1001591556887:meal_break:priority:day", chatId: "-1001591556887" }, // outro stage, ignorar
        { noticeKey: "123:meal_break:session:day", chatId: null }, // sem chatId, ignorar
    ];

    assert.deepEqual(
        filterMealBreakSessionNoticeChatIds(rows, "day").sort(),
        ["-1001591556887", "-2009999999999"].sort(),
    );
    assert.deepEqual(filterMealBreakSessionNoticeChatIds(rows, "night"), ["-1001591556887"]);
});
