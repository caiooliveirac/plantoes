import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeConflicts, type OccupancyConflict } from "@/services/duplicate-occupancy-guard";

function conflito(overrides: Partial<OccupancyConflict> = {}): OccupancyConflict {
    return {
        domain: "regulation",
        occupancyId: "occ-1",
        targetCode: "2032",
        startedAt: "2026-07-27T10:14:22.000Z",
        source: "telegram",
        ...overrides,
    };
}

describe("describeConflicts", () => {
    it("diz onde e a que horas o plantão já existe", () => {
        const texto = describeConflicts([conflito()]);
        assert.match(texto, /2032/);
        assert.match(texto, /07:14/);
    });

    it("identifica quando veio do bot, que é o caso mais comum", () => {
        assert.match(describeConflicts([conflito()]), /registrado pelo bot/);
    });

    it("mostra a origem crua quando não é o bot", () => {
        assert.match(describeConflicts([conflito({ source: "admin_correction" })]), /origem admin_correction/);
    });

    it("explica a consequência em dinheiro, não só que existe", () => {
        const texto = describeConflicts([conflito()]);
        assert.match(texto, /dobro|infla/i);
        assert.match(texto, /nota/i);
    });

    it("lista todos quando há mais de um", () => {
        const texto = describeConflicts([conflito(), conflito({ targetCode: "2034", occupancyId: "occ-2" })]);
        assert.match(texto, /2032/);
        assert.match(texto, /2034/);
    });

    it("deixa claro que dá para prosseguir se for mesmo um segundo plantão", () => {
        assert.match(describeConflicts([conflito()]), /confirme para prosseguir/i);
    });
});
