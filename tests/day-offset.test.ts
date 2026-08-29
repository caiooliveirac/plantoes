import assert from "node:assert/strict";
import test from "node:test";
import { resolveDayOffsetLabel } from "@/lib/board/day-offset";

/**
 * Achado ao olhar a tela nova rodando: um plantão que atravessa a noite
 * produzia "CHEGOU 07:00 → SAIU 07:00" — dois números grandes idênticos, sem
 * nada dizendo que são dias diferentes. Exatamente a leitura que a fila veio
 * consertar.
 */

test("mesmo dia não recebe marca", () => {
    assert.equal(
        resolveDayOffsetLabel("2026-08-03T07:00:00-03:00", "2026-08-03T19:15:00-03:00"),
        null,
    );
});

test("turno emendado ganha +1d", () => {
    assert.equal(
        resolveDayOffsetLabel("2026-08-03T07:00:00-03:00", "2026-08-04T07:00:00-03:00"),
        "+1d",
    );
});

test("dois turnos emendados ganham +2d", () => {
    assert.equal(
        resolveDayOffsetLabel("2026-08-03T07:00:00-03:00", "2026-08-05T07:00:00-03:00"),
        "+2d",
    );
});

test("a virada é de CALENDÁRIO, não de 24h: SN de 23:00 a 03:00 é +1d", () => {
    assert.equal(
        resolveDayOffsetLabel("2026-08-03T23:00:00-03:00", "2026-08-04T03:00:00-03:00"),
        "+1d",
    );
});

test("menos de 24h dentro do mesmo dia segue sem marca", () => {
    assert.equal(
        resolveDayOffsetLabel("2026-08-03T01:00:00-03:00", "2026-08-03T23:00:00-03:00"),
        null,
    );
});

test("data inválida não quebra a tela", () => {
    assert.equal(resolveDayOffsetLabel("nao-e-data", "2026-08-04T07:00:00-03:00"), null);
});
