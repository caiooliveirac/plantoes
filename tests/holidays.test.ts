import test from "node:test";
import assert from "node:assert/strict";

import { isPremiumRateDate, isSamuHolidayDate } from "@/modules/operational/holidays";

test("07/09 (segunda-feira em 2026) paga tarifa de feriado", () => {
    assert.equal(isSamuHolidayDate("2026-09-07"), true);
    assert.equal(isPremiumRateDate("2026-09-07"), true);
});

test("feriados fixos valem todo ano, sem precisar datar", () => {
    for (const date of ["2026-10-12", "2026-11-02", "2026-11-20", "2026-12-25", "2027-01-01", "2027-09-07"]) {
        assert.equal(isPremiumRateDate(date), true, date);
    }
});

test("feriados datados continuam valendo e dia útil comum não", () => {
    assert.equal(isPremiumRateDate("2026-06-04"), true);
    assert.equal(isPremiumRateDate("2026-07-02"), true);
    assert.equal(isPremiumRateDate("2026-09-08"), false);
});
