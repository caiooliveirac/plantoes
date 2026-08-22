import assert from "node:assert/strict";
import test from "node:test";

import { resolveHandoffClosure } from "@/modules/operational/handoff-closure";

// Caso Murilo Damasceno (PR03, 22/08/2026): Gabriel assumiu às 07:01, ele avisou
// a saída às 08:27 por causa da ocorrência 0126.
test("rendição fecha na chegada de quem assumiu e guarda a saída declarada", () => {
    const closure = resolveHandoffClosure({
        startedAt: new Date("2026-08-21T09:59:36.000Z"),
        successorStartedAt: new Date("2026-08-22T10:01:55.000Z"),
        eventAt: new Date("2026-08-22T11:27:24.000Z"),
    });

    assert.equal(closure.endedAt.toISOString(), "2026-08-22T10:01:55.000Z");
    assert.equal(closure.actualEndedAt?.toISOString(), "2026-08-22T11:27:24.000Z");
});

test("aviso logo depois da rendição não vira saída tardia", () => {
    const closure = resolveHandoffClosure({
        startedAt: new Date("2026-08-21T09:59:36.000Z"),
        successorStartedAt: new Date("2026-08-22T10:01:55.000Z"),
        eventAt: new Date("2026-08-22T10:09:00.000Z"),
    });

    assert.equal(closure.endedAt.toISOString(), "2026-08-22T10:01:55.000Z");
    assert.equal(closure.actualEndedAt, null);
});

test("sem sucessor identificável, fecha no aviso como antes", () => {
    const closure = resolveHandoffClosure({
        startedAt: new Date("2026-08-21T09:59:36.000Z"),
        successorStartedAt: null,
        eventAt: new Date("2026-08-22T11:27:24.000Z"),
    });

    assert.equal(closure.endedAt.toISOString(), "2026-08-22T11:27:24.000Z");
    assert.equal(closure.actualEndedAt, null);
});

test("sucessor que chegou antes da chegada do ocupante não puxa o fim para trás", () => {
    const closure = resolveHandoffClosure({
        startedAt: new Date("2026-08-21T09:59:36.000Z"),
        successorStartedAt: new Date("2026-08-21T08:00:00.000Z"),
        eventAt: new Date("2026-08-21T22:00:00.000Z"),
    });

    assert.equal(closure.endedAt.toISOString(), "2026-08-21T09:59:36.000Z");
    assert.equal(closure.actualEndedAt?.toISOString(), "2026-08-21T22:00:00.000Z");
});
