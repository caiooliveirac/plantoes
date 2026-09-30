import assert from "node:assert/strict";
import test from "node:test";
import {
    parseReassignmentOriginCode,
    pickTurnoArrivalPostCode,
} from "@/modules/operational/posto-de-chegada";
import { inferInterventionCoverageWindow, inferRegulationCoverageWindow } from "@/modules/operational/rules";

function sp(iso: string) {
    return new Date(`${iso}-03:00`);
}

test("parseReassignmentOriginCode lê a origem nos três formatos de nota de remanejo", () => {
    assert.equal(parseReassignmentOriginCode("Remanejado de NUCLEO para 2151. cobrir furo"), "NUCLEO");
    assert.equal(parseReassignmentOriginCode("Remanejado via Telegram de NUCLEO para 2151. Fulano mudou para 2151"), "NUCLEO");
    assert.equal(parseReassignmentOriginCode("Remanejado por conflito operacional de 2152 para 2153. x"), "2152");
    assert.equal(parseReassignmentOriginCode("Fulano NUCLEO SD"), null);
    assert.equal(parseReassignmentOriginCode(null), null);
});

test("parseReassignmentOriginCode numa cadeia devolve a PRIMEIRA origem (a chegada do turno)", () => {
    const notes = "Fulano NUCLEO SD 07:50\n\nRemanejado de NUCLEO para 2151. furo\n\nRemanejado de 2151 para 2152. troca";
    assert.equal(parseReassignmentOriginCode(notes), "NUCLEO");
});

test("pickTurnoArrivalPostCode: a posição mais antiga do grupo no turno define o posto de chegada", () => {
    const code = pickTurnoArrivalPostCode({
        current: { domain: "regulation", targetCode: "2152", startedAt: sp("2026-09-13T14:00:00"), notes: null },
        earlierLegs: [
            { domain: "regulation", targetCode: "2151", startedAt: sp("2026-09-13T09:00:00") },
            { domain: "regulation", targetCode: "NUCLEO", startedAt: sp("2026-09-13T07:50:00") },
        ],
    });
    assert.equal(code, "NUCLEO");
});

test("pickTurnoArrivalPostCode: chegada em base de intervenção não tem hora própria (null)", () => {
    const code = pickTurnoArrivalPostCode({
        current: { domain: "regulation", targetCode: "NUCLEO", startedAt: sp("2026-09-13T10:00:00"), notes: null },
        earlierLegs: [{ domain: "intervention", targetCode: "CC70", startedAt: sp("2026-09-13T07:10:00") }],
    });
    assert.equal(code, null);
});

test("pickTurnoArrivalPostCode: posição de outro turno (mais de 13h antes) não conta", () => {
    const code = pickTurnoArrivalPostCode({
        current: { domain: "regulation", targetCode: "2151", startedAt: sp("2026-09-14T07:05:00"), notes: null },
        earlierLegs: [{ domain: "regulation", targetCode: "NUCLEO", startedAt: sp("2026-09-13T07:50:00") }],
    });
    assert.equal(code, "2151");
});

test("pickTurnoArrivalPostCode: sem posição anterior (origem apagada), vale a origem gravada nas notas", () => {
    const code = pickTurnoArrivalPostCode({
        current: {
            domain: "regulation",
            targetCode: "2151",
            startedAt: sp("2026-09-12T07:50:00"),
            notes: "Remanejado de NUCLEO para 2151. cobrir furo na CRU",
        },
        earlierLegs: [],
    });
    assert.equal(code, "NUCLEO");
});

test("pickTurnoArrivalPostCode: sem grupo e sem nota, o posto atual decide", () => {
    assert.equal(pickTurnoArrivalPostCode({
        current: { domain: "regulation", targetCode: "2151", startedAt: sp("2026-09-12T07:10:00"), notes: "Fulano 2151 SD" },
        earlierLegs: [],
    }), "2151");
    assert.equal(pickTurnoArrivalPostCode({
        current: { domain: "intervention", targetCode: "CC70", startedAt: sp("2026-09-12T07:10:00"), notes: null },
        earlierLegs: [],
    }), null);
});

test("inferInterventionCoverageWindow com arrivalPostCode NUCLEO começa 08:00 e termina 19:00 (fim da base)", () => {
    const window = inferInterventionCoverageWindow({
        startedAt: sp("2026-09-13T10:00:00"),
        shiftLabel: "SD",
        arrivalPostCode: "NUCLEO",
    });
    assert.equal(window.scheduledStartAt?.toISOString(), sp("2026-09-13T08:00:00").toISOString());
    assert.equal(window.scheduledEndAt?.toISOString(), sp("2026-09-13T19:00:00").toISOString());
});

test("inferInterventionCoverageWindow sem arrivalPostCode segue 07:00", () => {
    const window = inferInterventionCoverageWindow({ startedAt: sp("2026-09-13T10:00:00"), shiftLabel: "SD" });
    assert.equal(window.scheduledStartAt?.toISOString(), sp("2026-09-13T07:00:00").toISOString());
});

test("inferRegulationCoverageWindow do destino 2151 com postCode do posto de chegada (NUCLEO) mantém 08:00–19:15", () => {
    const window = inferRegulationCoverageWindow({
        startedAt: sp("2026-09-13T10:00:00"),
        shiftLabel: "SD",
        postCode: "NUCLEO",
    });
    assert.equal(window.scheduledStartAt?.toISOString(), sp("2026-09-13T08:00:00").toISOString());
    assert.equal(window.scheduledEndAt?.toISOString(), sp("2026-09-13T19:15:00").toISOString());
});
