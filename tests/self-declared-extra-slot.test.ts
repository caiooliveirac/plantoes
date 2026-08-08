import test from "node:test";
import assert from "node:assert/strict";
import { findFreeExtraSlot, slotKey } from "@/modules/reporting/self-declared-extra-slot";

const monthKey = "2026-08";
// Agosto/2026: dia 10 é segunda; 15 e 16 caem no fim de semana.
const isPremium = (date: string) => ["2026-08-15", "2026-08-16", "2026-08-08", "2026-08-09"].includes(date);

test("primeiro destino é o outro turno do mesmo dia", () => {
    const to = findFreeExtraSlot({
        current: { operationalDate: "2026-08-10", shiftLabel: "SD" },
        monthKey,
        occupied: new Set(["2026-08-10|SD"]),
        isPremium,
    });
    assert.deepEqual(to, { operationalDate: "2026-08-10", shiftLabel: "SN" });
});

test("dia inteiro tomado joga para o dia seguinte", () => {
    const to = findFreeExtraSlot({
        current: { operationalDate: "2026-08-10", shiftLabel: "SD" },
        monthKey,
        occupied: new Set(["2026-08-10|SD", "2026-08-10|SN"]),
        isPremium,
    });
    assert.deepEqual(to, { operationalDate: "2026-08-11", shiftLabel: "SD" });
});

test("dia de semana não vira fim de semana só por causa do remanejo", () => {
    // 14/08 (sexta) tomado nos dois turnos: o vizinho imediato é 15/08 (sábado),
    // que paga mais — a varredura pula para 13/08, dia de semana.
    const to = findFreeExtraSlot({
        current: { operationalDate: "2026-08-14", shiftLabel: "SD" },
        monthKey,
        occupied: new Set(["2026-08-14|SD", "2026-08-14|SN"]),
        isPremium,
    });
    assert.equal(isPremium(to!.operationalDate), false);
    assert.deepEqual(to, { operationalDate: "2026-08-13", shiftLabel: "SD" });
});

test("extra de fim de semana procura outro fim de semana", () => {
    const to = findFreeExtraSlot({
        current: { operationalDate: "2026-08-15", shiftLabel: "SD" },
        monthKey,
        occupied: new Set(["2026-08-15|SD", "2026-08-15|SN"]),
        isPremium,
    });
    assert.equal(isPremium(to!.operationalDate), true);
    assert.deepEqual(to, { operationalDate: "2026-08-16", shiftLabel: "SD" });
});

test("mês inteiro tomado devolve null", () => {
    const occupied = new Set<string>();
    for (let day = 1; day <= 31; day += 1) {
        const date = `${monthKey}-${String(day).padStart(2, "0")}`;
        occupied.add(slotKey({ operationalDate: date, shiftLabel: "SD" }));
        occupied.add(slotKey({ operationalDate: date, shiftLabel: "SN" }));
    }
    const to = findFreeExtraSlot({
        current: { operationalDate: "2026-08-10", shiftLabel: "SD" },
        monthKey,
        occupied,
        isPremium,
    });
    assert.equal(to, null);
});
