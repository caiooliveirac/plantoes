import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bahiaClockHHMM, bahiaDateIso } from "@/lib/time";

// Rodar também com TZ=UTC e TZ=Asia/Tokyo: o resultado não pode depender do
// fuso do processo (o PM2 não define TZ).
describe("fuso de Bahia", () => {
    it("23:30 de Bahia em 31/jan continua sendo 31/jan (UTC já é 01/fev)", () => {
        assert.equal(bahiaDateIso(new Date("2026-02-01T02:30:00Z")), "2026-01-31");
    });

    it("meia-noite de Bahia já é o dia seguinte", () => {
        assert.equal(bahiaDateIso("2026-02-01T03:00:00Z"), "2026-02-01");
    });

    it("HH:MM é o relógio de Bahia, independente do TZ do processo", () => {
        assert.equal(bahiaClockHHMM("2026-02-01T02:30:00Z"), "23:30");
        assert.equal(bahiaClockHHMM(new Date("2026-07-15T10:05:00.000Z")), "07:05");
    });
});
