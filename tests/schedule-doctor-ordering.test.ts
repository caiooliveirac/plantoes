import assert from "node:assert/strict";
import test from "node:test";
import { compareScheduleDoctors, type ScheduleDoctorEntry } from "@/services/schedule.service";

function doctor(overrides: Partial<ScheduleDoctorEntry> & Pick<ScheduleDoctorEntry, "id" | "fullName">): ScheduleDoctorEntry {
    return {
        displayName: null,
        admittedAt: null,
        eligibleRegulation: true,
        eligibleIntervention: true,
        fixedForWeekday: false,
        fixedShiftLabels: [],
        weekdayPreferenceRank: null,
        basePreferences: [],
        ...overrides,
    };
}

test("médicos com turno fixo no dia vêm antes de todos", () => {
    const entries = [
        doctor({ id: "1", fullName: "Zuleide", fixedForWeekday: true, fixedShiftLabels: ["SN"] }),
        doctor({ id: "2", fullName: "Alberto", weekdayPreferenceRank: 0 }),
    ].sort(compareScheduleDoctors);

    assert.equal(entries[0].id, "1");
});

test("sem turno fixo, vale o ranking de dia preferido (menor primeiro)", () => {
    const entries = [
        doctor({ id: "1", fullName: "Alberto", weekdayPreferenceRank: 2 }),
        doctor({ id: "2", fullName: "Zuleide", weekdayPreferenceRank: 0 }),
        doctor({ id: "3", fullName: "Bruna" }),
    ].sort(compareScheduleDoctors);

    assert.deepEqual(entries.map((entry) => entry.id), ["2", "1", "3"]);
});

test("empate no ranking resolve por antiguidade; sem admissão vai pro fim do bloco", () => {
    const entries = [
        doctor({ id: "1", fullName: "Alberto" }),
        doctor({ id: "2", fullName: "Zuleide", admittedAt: "2019-03-01" }),
        doctor({ id: "3", fullName: "Bruna", admittedAt: "2023-08-15" }),
    ].sort(compareScheduleDoctors);

    assert.deepEqual(entries.map((entry) => entry.id), ["2", "3", "1"]);
});

test("último desempate é o nome em pt-BR", () => {
    const entries = [
        doctor({ id: "1", fullName: "Érica" }),
        doctor({ id: "2", fullName: "Eduardo" }),
    ].sort(compareScheduleDoctors);

    assert.deepEqual(entries.map((entry) => entry.fullName), ["Eduardo", "Érica"]);
});
