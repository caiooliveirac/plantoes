import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickDeparturePosition } from "@/modules/telegram/departure-position";

const d = (v: string) => new Date(v);
const at = d("2026-09-15T19:05:00-03:00");

describe("pickDeparturePosition (ADR-007 R5)", () => {
    it("alvo citado com posição aberta: fica como está", () => {
        const r = pickDeparturePosition({
            cited: { sector: "REGULATION", code: "2154" },
            positions: [{ sector: "REGULATION", code: "2154", startedAt: d("2026-09-15T07:10:00-03:00"), endedAt: null }],
            eventAt: at,
        });
        assert.deepEqual(r, { sector: "REGULATION", code: "2154", redirected: false });
    });

    it("remanejado: citou o ramal antigo, saída vai para a posição aberta (cross-domain inclusive)", () => {
        const r = pickDeparturePosition({
            cited: { sector: "REGULATION", code: "2154" },
            positions: [
                { sector: "REGULATION", code: "2154", startedAt: d("2026-09-15T07:10:00-03:00"), endedAt: d("2026-09-15T09:00:00-03:00") },
                { sector: "INTERVENTION", code: "CZ50", startedAt: d("2026-09-15T09:00:00-03:00"), endedAt: null },
            ],
            eventAt: at,
        });
        assert.deepEqual(r, { sector: "INTERVENTION", code: "CZ50", redirected: true });
    });

    it("alvo citado fechado há pouco (rendição) ainda vale, mesmo com outra posição aberta", () => {
        // Foi rendido no 2154 às 19:00 e avisa às 19:05: é o ajuste de saída do 2154.
        const r = pickDeparturePosition({
            cited: { sector: "REGULATION", code: "2154" },
            positions: [
                { sector: "REGULATION", code: "2154", startedAt: d("2026-09-15T07:10:00-03:00"), endedAt: d("2026-09-15T19:00:00-03:00") },
            ],
            eventAt: at,
        });
        assert.equal(r.redirected, false);
    });

    it("expulso do citado há dias e sem posição aberta: usa a última fechada há pouco", () => {
        const r = pickDeparturePosition({
            cited: { sector: "INTERVENTION", code: "BR05" },
            positions: [
                { sector: "INTERVENTION", code: "BR05", startedAt: d("2026-09-10T07:00:00-03:00"), endedAt: d("2026-09-10T19:00:00-03:00") },
                { sector: "REGULATION", code: "2152", startedAt: d("2026-09-15T07:05:00-03:00"), endedAt: d("2026-09-15T18:55:00-03:00") },
            ],
            eventAt: at,
        });
        assert.deepEqual(r, { sector: "REGULATION", code: "2152", redirected: true });
    });

    it("nada aberto nem recente: devolve o citado e deixa o fluxo dar o erro de sempre", () => {
        const r = pickDeparturePosition({ cited: { sector: "REGULATION", code: "2154" }, positions: [], eventAt: at });
        assert.deepEqual(r, { sector: "REGULATION", code: "2154", redirected: false });
    });
});
