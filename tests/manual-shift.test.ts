import assert from "node:assert/strict";
import test from "node:test";
import { previewManualShiftBankHours, resolveManualShiftInstants } from "@/modules/operational/manual-shift";

test("SD na base chegando 07:00 e saindo 21:20 rende 140 min em dobro (280)", () => {
    const { startedAt, departureAt } = resolveManualShiftInstants({ date: "2026-09-30", arrivalTime: "07:00", departureTime: "21:20" });
    const { calculation } = previewManualShiftBankHours({ domain: "intervention", targetCode: "SM01", shiftLabel: "SD", startedAt, departureAt });
    assert.equal(calculation.overtimeMinutes, 140);
    assert.equal(calculation.overtimeMultiplier, 2);
    assert.equal(calculation.balanceMinutes, 280);
});

test("SD completo no ramal sem excedente nao mexe no banco", () => {
    const { startedAt, departureAt } = resolveManualShiftInstants({ date: "2026-09-28", arrivalTime: "07:00", departureTime: "19:00" });
    const { calculation } = previewManualShiftBankHours({ domain: "regulation", targetCode: "2154", shiftLabel: "SD", startedAt, departureAt });
    assert.equal(calculation.balanceMinutes, 0);
});

test("SN: a saida das 07:00 cai no dia seguinte", () => {
    const { startedAt, departureAt } = resolveManualShiftInstants({ date: "2026-09-28", arrivalTime: "19:00", departureTime: "07:00" });
    assert.equal(departureAt.getTime() - startedAt.getTime(), 12 * 60 * 60 * 1000);
});
