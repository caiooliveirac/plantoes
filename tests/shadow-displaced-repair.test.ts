import assert from "node:assert/strict";
import test from "node:test";
import { stripDisplacedMarkerLines } from "@/scripts/repair-shadow-marked-displaced";

// Estado impossível saneado pelo script: [DESLOCADO] gravado em cima de uma
// ocupação sombra (caso Vaner na 2031, 23/08/2026). Só a linha do marcador sai —
// a mensagem original da chegada tem que sobreviver inteira.
test("stripDisplacedMarkerLines remove só a linha do marcador", () => {
    assert.equal(
        stripDisplacedMarkerLines(
            "[telegram sombra] Vaner Sombra SD 2031\n[DESLOCADO] 2026-08-23T10:49:42.000Z por Felipe Carvalho",
        ),
        "[telegram sombra] Vaner Sombra SD 2031",
    );
});

test("stripDisplacedMarkerLines é idempotente e não inventa nota", () => {
    assert.equal(stripDisplacedMarkerLines("[telegram sombra] Vaner 2031"), "[telegram sombra] Vaner 2031");
    assert.equal(stripDisplacedMarkerLines("[DESLOCADO] 2026-08-23T10:49:42.000Z"), null);
    assert.equal(stripDisplacedMarkerLines(null), null);
});
