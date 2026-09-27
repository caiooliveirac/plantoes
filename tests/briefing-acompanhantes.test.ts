import assert from "node:assert/strict";
import test from "node:test";

import { acompanantesDoQuadro } from "../lib/briefing/acompanhantes";

test("sombra não vira titular e deslocado sai em lista própria", () => {
    const quadro = acompanantesDoQuadro(
        [{
            baseCode: "PM04",
            displayName: "Paula",
            shiftLabel: "SD",
            shadowOccupants: [{ displayName: "Beatriz", doctorName: "Beatriz Pamponet" }],
            displacedOccupants: [{ doctorName: "Yngra Souza" }],
        }],
        [{
            postCode: "2152",
            doctorName: "Indira",
            shiftLabel: "SN",
            shadowOccupants: [{ doctorName: "Sombra Sem Display" }],
        }],
    );

    assert.deepEqual(quadro.sombras, [
        { dominio: "base", code: "PM04", doctorName: "Beatriz", titular: "Paula", shiftLabel: "SD" },
        { dominio: "ramal", code: "2152", doctorName: "Sombra Sem Display", titular: "Indira", shiftLabel: "SN" },
    ]);
    assert.deepEqual(quadro.deslocados, [
        { dominio: "base", code: "PM04", doctorName: "Yngra Souza", titular: "Paula", shiftLabel: "SD" },
    ]);
});

test("linha sem acompanhante não inventa sombra", () => {
    assert.deepEqual(acompanantesDoQuadro([{ baseCode: "IT30", doctorName: "Murilo" }], []), {
        sombras: [],
        deslocados: [],
    });
});
