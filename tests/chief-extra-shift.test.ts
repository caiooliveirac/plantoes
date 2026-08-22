import assert from "node:assert/strict";
import test from "node:test";
import {
    buildAdminExtraPayableShift,
    CHIEF_EXTRA_SHIFT_KIND,
    CHIEF_EXTRA_SHIFT_LABEL,
    type AdminExtraShiftInput,
} from "@/modules/reporting/payable-shifts";

function makeInput(overrides: Partial<AdminExtraShiftInput> = {}): AdminExtraShiftInput {
    return {
        id: "extra-1",
        doctorId: "doc-1",
        doctorName: "Cecilia Exemplo",
        displayName: null,
        operationalDate: "2026-08-12",
        shiftLabel: "SD",
        label: CHIEF_EXTRA_SHIFT_LABEL,
        kind: CHIEF_EXTRA_SHIFT_KIND,
        unit: 1,
        ...overrides,
    };
}

test("plantão de chefia é extra pagável inteiro e sai marcado como chefia", () => {
    const chief = buildAdminExtraPayableShift(makeInput());
    assert.equal(chief.isChiefExtra, true);
    assert.equal(chief.paymentUnit, 1);
    assert.equal(chief.tagCode, CHIEF_EXTRA_SHIFT_LABEL);
    // Nada de meio plantão: a marca de chefia não pode reaproveitar a régua do half.
    assert.equal(chief.paymentTag, null);
});

test("extra comum e acerto de banco de horas NÃO se passam por chefia", () => {
    for (const kind of ["extra", "bonus", "penalty", "half_extra"]) {
        const shift = buildAdminExtraPayableShift(makeInput({ kind, label: "EXTRA DECLARADO" }));
        assert.equal(shift.isChiefExtra, false, `kind ${kind} não é chefia`);
    }
});
