import assert from "node:assert/strict";
import test from "node:test";
import type { DepartureAutonomyResult } from "@/modules/operational/departure-autonomy";
import { decideSaidaAction, resolveSaidasAutonomasMode } from "@/modules/telegram/saidas-autonomas-cycle";

const at = (iso: string) => new Date(`${iso}-03:00`);

function assessment(autonomy: DepartureAutonomyResult["autonomy"], dueAt: string, deadlineAt: string): DepartureAutonomyResult {
    return {
        autonomy,
        triage: { kind: "routine", attention: false, headline: "", classification: null, extendedStay: null },
        suggestion: autonomy === "decide" ? null : { outcome: null, label: "Confirmar saída 19:05", effect: "" },
        dueAt: at(dueAt),
        deadlineAt: at(deadlineAt),
    };
}

test("rotina: espera a virada, depois confirma", () => {
    const item = assessment("auto", "2026-09-30T07:00", "2026-09-30T19:05");
    assert.deepEqual(decideSaidaAction(item, at("2026-09-30T06:59"), false), { kind: "wait" });
    assert.deepEqual(decideSaidaAction(item, at("2026-09-30T07:00"), false), { kind: "confirm", reason: "virada" });
});

test("sugestão: aplicada no prazo de 24h", () => {
    const item = assessment("glance", "2026-09-30T19:20", "2026-09-30T19:20");
    assert.deepEqual(decideSaidaAction(item, at("2026-09-30T19:19"), false), { kind: "wait" });
    assert.deepEqual(decideSaidaAction(item, at("2026-09-30T19:20"), false), { kind: "confirm", reason: "prazo" });
});

test("decisão humana nunca confirma: escala no prazo", () => {
    const item = assessment("decide", "2026-09-30T19:05", "2026-09-30T19:05");
    assert.deepEqual(decideSaidaAction(item, at("2026-09-30T19:04"), false), { kind: "wait" });
    assert.deepEqual(decideSaidaAction(item, at("2026-10-02T19:05"), false), { kind: "escalate" });
});

test("o que a chefia desfez vira dela: nunca reconfirma, só escala no prazo", () => {
    const item = assessment("auto", "2026-09-30T07:00", "2026-09-30T19:05");
    assert.deepEqual(decideSaidaAction(item, at("2026-09-30T08:00"), true), { kind: "wait" });
    assert.deepEqual(decideSaidaAction(item, at("2026-09-30T19:05"), true), { kind: "escalate" });
});

test("flag SAIDAS_AUTONOMAS: ligado por padrão; sombra; 0 desliga", () => {
    assert.equal(resolveSaidasAutonomasMode(undefined), "on");
    assert.equal(resolveSaidasAutonomasMode("sombra"), "sombra");
    assert.equal(resolveSaidasAutonomasMode("0"), "off");
    assert.equal(resolveSaidasAutonomasMode("false"), "off");
});
