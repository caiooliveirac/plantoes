import test from "node:test";
import assert from "node:assert/strict";
import { canDoctorManageSettlement } from "@/services/bank-hours-settlements.service";

const base = {
    doctorId: "doc-1",
    monthKey: "2026-08",
    kind: "bonus",
    notes: "Banco de horas +12h — plantão extra declarado (autoatendimento, 2026-08-10 SD)",
};
const context = { doctorId: "doc-1", currentMonthKey: "2026-08" };

test("o médico gerencia o extra que ele mesmo declarou no mês corrente", () => {
    assert.equal(canDoctorManageSettlement(base, context), true);
});

test("não alcança acerto de outro médico", () => {
    assert.equal(canDoctorManageSettlement({ ...base, doctorId: "doc-2" }, context), false);
});

test("não alcança mês já passado", () => {
    assert.equal(canDoctorManageSettlement({ ...base, monthKey: "2026-07" }, context), false);
});

test("não alcança acerto lançado pelo coordenador", () => {
    const doCoordenador = { ...base, notes: "Banco de horas +12h (acerto automático de banco de horas)" };
    assert.equal(canDoctorManageSettlement(doCoordenador, context), false);
});

test("não alcança a retirada de plantão da folha nem estorno", () => {
    assert.equal(canDoctorManageSettlement({ ...base, kind: "penalty" }, context), false);
    assert.equal(
        canDoctorManageSettlement({ ...base, notes: "reversal:abc — autoatendimento" }, context),
        false,
    );
});
