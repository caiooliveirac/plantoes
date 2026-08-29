import assert from "node:assert/strict";
import test from "node:test";
import {
    buildAdminExtraPayableShift,
    CHIEF_EXTRA_HALF_SHIFT_KIND,
    CHIEF_EXTRA_SHIFT_KIND,
    CHIEF_EXTRA_SHIFT_LABEL,
    resolveShiftDueAmountCents,
    type AdminExtraShiftInput,
} from "@/modules/reporting/payable-shifts";
import { HALF_SHIFT_TAG_LABEL } from "@/modules/operational/half-shift";

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

test("meio plantão de chefia paga 0,5 unidade, leva a tag MEIO e segue sendo chefia", () => {
    const half = buildAdminExtraPayableShift(makeInput({ kind: CHIEF_EXTRA_HALF_SHIFT_KIND }));
    assert.equal(half.isChiefExtra, true);
    assert.equal(half.paymentUnit, 0.5);
    assert.equal(half.tagCode, CHIEF_EXTRA_SHIFT_LABEL);
    assert.equal(half.paymentTag, HALF_SHIFT_TAG_LABEL);
});

test("meio plantão de chefia vale metade do dinheiro do plantão inteiro", () => {
    const full = buildAdminExtraPayableShift(makeInput());
    const half = buildAdminExtraPayableShift(makeInput({ id: "extra-2", kind: CHIEF_EXTRA_HALF_SHIFT_KIND }));
    const fullCents = resolveShiftDueAmountCents({
        profile: "generalist",
        operationalDate: full.operationalDate,
        paymentUnit: full.paymentUnit,
    });
    const halfCents = resolveShiftDueAmountCents({
        profile: "generalist",
        operationalDate: half.operationalDate,
        paymentUnit: half.paymentUnit,
    });
    // 2026-08-12 é dia útil: tarifa generalista cheia, e o meio arredonda o ½ centavo.
    assert.equal(fullCents, 124487);
    assert.equal(halfCents, Math.round(fullCents / 2));
});

test("extra comum e acerto de banco de horas NÃO se passam por chefia", () => {
    for (const kind of ["extra", "bonus", "penalty", "half_extra"]) {
        const shift = buildAdminExtraPayableShift(makeInput({ kind, label: "EXTRA DECLARADO" }));
        assert.equal(shift.isChiefExtra, false, `kind ${kind} não é chefia`);
    }
});
