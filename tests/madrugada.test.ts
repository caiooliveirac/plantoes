import assert from "node:assert/strict";
import test from "node:test";
import {
    buildMadrugadaCallbackData,
    buildMadrugadaKeyboard,
    isMadrugadaMessage,
    isMadrugadaPendingData,
    parseMadrugadaCallbackData,
    resolveMadrugadaWindow,
    selectMadrugadaCandidates,
    stripMadrugadaWord,
} from "@/modules/telegram/madrugada";
import { parseMessage } from "@/modules/telegram/parser";

const LOG_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

// Horário local (UTC-3) → Date.
function local(iso: string) {
    return new Date(`${iso}-03:00`);
}

test("madrugada: reconhece a palavra com acento e caixa variados", () => {
    assert.equal(isMadrugadaMessage("Maria 2266 madrugada"), true);
    assert.equal(isMadrugadaMessage("MARIA 2266 MADRUGADA"), true);
    assert.equal(isMadrugadaMessage("maria 2266 SN 19:00"), false);
    assert.equal(stripMadrugadaWord("Maria Souza 2266 madrugada"), "Maria Souza 2266");
});

test("madrugada: sem a palavra, o parser comum acha nome e ramal novo", () => {
    const parsed = parseMessage(stripMadrugadaWord("Maria Souza 2268 madrugada"));
    assert.equal(parsed.baseCode, "2268");
    assert.equal(parsed.sector, "REGULATION");
    assert.ok(parsed.extractedNames.length > 0);
});

test("madrugada: perto das 23h fica de 23:00 às 03:00", () => {
    for (const at of ["2026-09-29T22:40", "2026-09-29T23:05", "2026-09-30T00:30"]) {
        const window = resolveMadrugadaWindow(local(at));
        assert.ok(window, at);
        assert.equal(window.slot, "23:00");
        assert.equal(window.scheduledStartAt.toISOString(), local("2026-09-29T23:00").toISOString(), at);
        assert.equal(window.scheduledEndAt.toISOString(), local("2026-09-30T03:00").toISOString(), at);
    }
});

test("madrugada: perto das 3h fica de 03:00 às 07:00", () => {
    for (const at of ["2026-09-30T02:40", "2026-09-30T03:10", "2026-09-30T05:30"]) {
        const window = resolveMadrugadaWindow(local(at));
        assert.ok(window, at);
        assert.equal(window.slot, "03:00");
        assert.equal(window.scheduledStartAt.toISOString(), local("2026-09-30T03:00").toISOString(), at);
        assert.equal(window.scheduledEndAt.toISOString(), local("2026-09-30T07:00").toISOString(), at);
    }
});

test("madrugada: de dia não é madrugada", () => {
    assert.equal(resolveMadrugadaWindow(local("2026-09-30T07:30")), null);
    assert.equal(resolveMadrugadaWindow(local("2026-09-30T15:00")), null);
    assert.equal(resolveMadrugadaWindow(local("2026-09-30T19:30")), null);
});

const ROWS = [
    { occupancyId: "o1", doctorId: "d1", doctorName: "Ana", postCode: "2151", status: "active" },
    { occupancyId: "o2", doctorId: "d2", doctorName: "Bruno", postCode: "2152", status: "active" },
    { occupancyId: "o3", doctorId: "d3", doctorName: "Carla", postCode: "2153", status: "active" },
    { occupancyId: null, doctorId: null, doctorName: null, postCode: "2154", status: "waiting" },
    { occupancyId: "o5", doctorId: "d5", doctorName: "Diego", postCode: "2266", status: "active", madrugadaCobertura: true },
    { occupancyId: "o6", doctorId: "dX", doctorName: "Quem avisou", postCode: "2031", status: "active" },
];

test("madrugada: botões são os da divisão da noite naquele horário", () => {
    const candidates = selectMadrugadaCandidates({
        rows: ROWS,
        slot: "03:00",
        nightWorkAssignments: { "2151": "23:00", "2152": "03:00", "2153": "03:00" },
        covererDoctorId: "dX",
    });
    assert.deepEqual(candidates.map((c) => c.doctorId), ["d2", "d3"]);
});

test("madrugada: sem divisão da noite, oferece todos os ativos (nunca cobertura nem quem avisou)", () => {
    const candidates = selectMadrugadaCandidates({ rows: ROWS, slot: "23:00", nightWorkAssignments: null, covererDoctorId: "dX" });
    assert.deepEqual(candidates.map((c) => c.doctorId), ["d1", "d2", "d3"]);
});

test("madrugada: callback ida e volta, cancelar é posição 0", () => {
    assert.deepEqual(parseMadrugadaCallbackData(buildMadrugadaCallbackData(3, LOG_ID)), { position: 3, logId: LOG_ID });
    assert.deepEqual(parseMadrugadaCallbackData(buildMadrugadaCallbackData(0, LOG_ID)), { position: 0, logId: LOG_ID });
    assert.equal(parseMadrugadaCallbackData(`mad:99:${LOG_ID}`), null);
    assert.equal(parseMadrugadaCallbackData(`coi:2262:${LOG_ID}`), null);
    assert.throws(() => buildMadrugadaCallbackData(1, "texto livre"));
});

test("madrugada: teclado tem um botão por médico + cancelar, dentro de 64 bytes", () => {
    const candidates = selectMadrugadaCandidates({ rows: ROWS, slot: "23:00", nightWorkAssignments: null, covererDoctorId: "dX" });
    const keyboard = buildMadrugadaKeyboard(candidates, LOG_ID);
    const buttons = keyboard.inline_keyboard.flat();
    assert.equal(buttons.length, candidates.length + 1);
    for (const button of buttons) {
        assert.ok(Buffer.byteLength(String(button.callback_data), "utf8") <= 64);
    }
});

test("madrugada: valida a pendência", () => {
    assert.equal(isMadrugadaPendingData({ kind: "madrugada_cover", postCode: "2266", slot: "03:00", candidates: [], coverer: { id: "x" } }), true);
    assert.equal(isMadrugadaPendingData({ kind: "outro" }), false);
    assert.equal(isMadrugadaPendingData(null), false);
});
