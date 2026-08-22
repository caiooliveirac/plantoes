import assert from "node:assert/strict";
import test from "node:test";
import {
    EXTENDED_STAY_FULL_THRESHOLD_MINUTES,
    EXTENDED_STAY_HALF_THRESHOLD_MINUTES,
    classifyExtendedStay,
    describeExtendedStay,
} from "@/modules/operational/extended-stay";
import {
    EARLY_DEPARTURE_FULL_REMAINING_MINUTES,
    EARLY_DEPARTURE_HALF_THRESHOLD_MINUTES,
} from "@/modules/operational/early-departure";

// A régua da sobra é a mesma da falta, no outro sentido. Se alguém mexer numa
// sem mexer na outra, a folha passa a pagar coisas diferentes para o mesmo
// tempo de posição — que é exatamente como a subjetividade volta.
test("os limiares da permanência espelham os da saída antecipada", () => {
    assert.equal(EXTENDED_STAY_HALF_THRESHOLD_MINUTES, EARLY_DEPARTURE_HALF_THRESHOLD_MINUTES);
    assert.equal(EXTENDED_STAY_FULL_THRESHOLD_MINUTES, 12 * 60 - EARLY_DEPARTURE_FULL_REMAINING_MINUTES);
});

test("abaixo de 6h a permanência continua sendo banco de horas", () => {
    const result = classifyExtendedStay(5 * 60 + 59);
    assert.deepEqual(result, { overtimeMinutes: 359, fullShifts: 0, halfShifts: 0, bankMinutes: 359 });
    assert.equal(describeExtendedStay(result), null);
});

test("de 6h a 10h assina meio plantão e nada fica no banco", () => {
    const result = classifyExtendedStay(7 * 60);
    assert.deepEqual(result, { overtimeMinutes: 420, fullShifts: 0, halfShifts: 1, bankMinutes: 0 });
    assert.equal(describeExtendedStay(result), "1 MEIO plantão");
});

// Os 35 casos de produção: previsto de 12h, ficou o turno seguinte inteiro.
test("de 10h em diante assina plantão inteiro", () => {
    const result = classifyExtendedStay(11 * 60 + 42);
    assert.deepEqual(result, { overtimeMinutes: 702, fullShifts: 1, halfShifts: 0, bankMinutes: 0 });
    assert.equal(describeExtendedStay(result), "1 plantão INTEIRO");
});

test("permanência de vários turnos rende um plantão por turno, e o resto segue a régua", () => {
    assert.deepEqual(classifyExtendedStay(24 * 60), { overtimeMinutes: 1440, fullShifts: 2, halfShifts: 0, bankMinutes: 0 });
    assert.deepEqual(classifyExtendedStay(19 * 60), { overtimeMinutes: 1140, fullShifts: 1, halfShifts: 1, bankMinutes: 0 });
    assert.deepEqual(classifyExtendedStay(14 * 60), { overtimeMinutes: 840, fullShifts: 1, halfShifts: 0, bankMinutes: 120 });
});

// Invariante que sustenta o teto do banco: qualquer permanência, de qualquer
// tamanho, deixa menos de 6h para creditar.
test("o resto que sobra para o banco é sempre menor que 6h", () => {
    for (let minutes = 0; minutes <= 72 * 60; minutes += 1) {
        const result = classifyExtendedStay(minutes);
        assert.ok(
            result.bankMinutes < EXTENDED_STAY_HALF_THRESHOLD_MINUTES,
            `permanência de ${minutes} min deixou ${result.bankMinutes} min no banco`,
        );
    }
});
