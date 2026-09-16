import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTurnoOutcomeShadow, sumPositionedMinutesInSlot } from "@/modules/reporting/turno-outcome";

const slot = { slotStartAt: "2026-09-15T10:00:00.000Z", slotEndAt: "2026-09-15T22:00:00.000Z" }; // SD 07–19 SP

describe("turno-outcome (ADR-007 R4, sombra)", () => {
    it("Kêmylla: 1 min no 2154 com bank_only + 11h33 no 2152 → por turno pagaria inteiro", () => {
        const p1 = { occupancyId: "a", startedAt: "2026-09-15T10:15:00.000Z", endedAt: "2026-09-15T10:16:00.000Z" };
        const p2 = { occupancyId: "b", startedAt: "2026-09-15T10:40:00.000Z", endedAt: "2026-09-15T22:13:00.000Z" };
        const shadow = resolveTurnoOutcomeShadow({ row: { ...p1, earlyDepartureOutcome: "bank_only" }, pieces: [p1, p2], ...slot });
        assert.equal(shadow.turnoOutcome, "full_shift");
        assert.equal(shadow.isTail, false);
        assert.match(shadow.divergence ?? "", /pagaria inteiro/);
    });

    it("turno inteiro numa posição só, sem corte: sem divergência", () => {
        const p = { occupancyId: "a", startedAt: "2026-09-15T10:05:00.000Z", endedAt: "2026-09-15T22:00:00.000Z" };
        assert.equal(resolveTurnoOutcomeShadow({ row: { ...p, earlyDepartureOutcome: null }, pieces: [p], ...slot }).divergence, null);
    });

    it("saiu de verdade com 3h e o chefe gravou bank_only no fim: concordam", () => {
        const p = { occupancyId: "a", startedAt: "2026-09-15T10:05:00.000Z", endedAt: "2026-09-15T13:05:00.000Z" };
        const shadow = resolveTurnoOutcomeShadow({ row: { ...p, earlyDepartureOutcome: "bank_only" }, pieces: [p], ...slot });
        assert.equal(shadow.turnoOutcome, "bank_only");
        assert.equal(shadow.divergence, null);
    });

    it("expulso com 30 min e sem corte gravado: por turno seria só banco", () => {
        const p = { occupancyId: "a", startedAt: "2026-09-15T10:05:00.000Z", endedAt: "2026-09-15T10:35:00.000Z" };
        assert.match(resolveTurnoOutcomeShadow({ row: { ...p, earlyDepartureOutcome: null }, pieces: [p], ...slot }).divergence ?? "", /só banco/);
    });

    it("faixa 6h–10h sem desfecho gravado não é apontada (ruído)", () => {
        const p = { occupancyId: "a", startedAt: "2026-09-15T10:05:00.000Z", endedAt: "2026-09-15T18:05:00.000Z" };
        assert.equal(resolveTurnoOutcomeShadow({ row: { ...p, earlyDepartureOutcome: null }, pieces: [p], ...slot }).divergence, null);
    });

    it("soma só o que cai dentro do slot; pedaço aberto conta até o fim do slot", () => {
        const minutes = sumPositionedMinutesInSlot([
            { occupancyId: "a", startedAt: "2026-09-15T09:00:00.000Z", endedAt: "2026-09-15T11:00:00.000Z" },
            { occupancyId: "b", startedAt: "2026-09-15T20:00:00.000Z", endedAt: null },
        ], slot.slotStartAt, slot.slotEndAt);
        assert.equal(minutes, 60 + 120);
    });
});
