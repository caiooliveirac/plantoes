import test from "node:test";
import assert from "node:assert/strict";

import { resolveActiveOccupancyCoverageFloor } from "@/modules/telegram/service";

// Incidente 08/07/2026: "CAROLINA TANAJURA 2031 P" digitado no aparelho da
// chefia às 07:18 encontrou o plantão dela de 01/07 (1366) ainda aberto e o
// tratou como remanejamento — moveu a ocupação de 01/07 para o 2031,
// preservando a chegada 06:30 daquele dia e derrubando a Bruna do SD da chefia.
// Uma mensagem de hoje só pode enxergar plantão cuja JANELA ainda cobre o agora.
const mensagemEm = new Date("2026-07-08T10:18:05.000Z"); // 07:18 SP

test("plantão cuja janela venceu há dias fica fora do alcance", () => {
    const piso = resolveActiveOccupancyCoverageFloor(mensagemEm);
    const janelaDoPlantaoDe0107 = new Date("2026-07-02T10:15:00.000Z"); // 07:15 SP de 02/07

    assert.ok(janelaDoPlantaoDe0107 < piso);
});

test("P de ontem virando agora ainda alcança — carry-over legítimo", () => {
    const piso = resolveActiveOccupancyCoverageFloor(mensagemEm);
    const janelaDoPDeOntem = new Date("2026-07-08T10:15:00.000Z"); // 07:15 SP de hoje

    assert.ok(janelaDoPDeOntem >= piso);
});

test("mensagem atrasada até 3h depois da virada ainda pega o plantão que acabou", () => {
    const piso = resolveActiveOccupancyCoverageFloor(mensagemEm);
    const janelaQueFechouDuasHorasAntes = new Date("2026-07-08T08:18:05.000Z");
    const janelaQueFechouQuatroHorasAntes = new Date("2026-07-08T06:18:05.000Z");

    assert.ok(janelaQueFechouDuasHorasAntes >= piso);
    assert.ok(janelaQueFechouQuatroHorasAntes < piso);
});
