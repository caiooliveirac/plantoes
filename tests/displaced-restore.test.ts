import assert from "node:assert/strict";
import test from "node:test";

import { stripDisplacedMarkerLines } from "@/modules/operational/displaced-restore";

// D10 (docs/chegada.md): o deslocado que reassume o quadro perde a linha [DESLOCADO]
// e mantém o resto das notas.
test("stripDisplacedMarkerLines: remove só a linha do marcador", () => {
    assert.equal(
        stripDisplacedMarkerLines("Jose Roberto PA 2153 SD\n[DESLOCADO] 2026-09-23T10:07:06.010Z por Jean Rios\nJosé Roberto SD 2153"),
        "Jose Roberto PA 2153 SD\nJosé Roberto SD 2153",
    );
    assert.equal(stripDisplacedMarkerLines("[DESLOCADO] 2026-09-23T10:07:06.010Z por Jean Rios"), null);
    assert.equal(stripDisplacedMarkerLines(null), null);
});
