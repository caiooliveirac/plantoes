import assert from "node:assert/strict";
import test from "node:test";
import {
    isInterventionBaseDeactivationActive,
    resolveInterventionOccupancyActivationReferenceAt,
    resolveInterventionBaseDeactivationExpiresAt,
} from "@/modules/intervention/service";

test("resolveInterventionBaseDeactivationExpiresAt vence no fim do turno desativado", () => {
    assert.equal(
        resolveInterventionBaseDeactivationExpiresAt(new Date("2026-03-29T10:12:00-03:00")).toISOString(),
        new Date("2026-03-29T19:00:00-03:00").toISOString(),
    );

    assert.equal(
        resolveInterventionBaseDeactivationExpiresAt(new Date("2026-03-29T21:12:00-03:00")).toISOString(),
        new Date("2026-03-30T07:00:00-03:00").toISOString(),
    );
});

test("isInterventionBaseDeactivationActive libera chegada no turno seguinte sem /ativar manual", () => {
    assert.equal(isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-03-29T10:12:00-03:00"),
        reactivatedAt: null,
        referenceAt: new Date("2026-03-29T18:59:00-03:00"),
    }), true);

    assert.equal(isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-03-29T10:12:00-03:00"),
        reactivatedAt: null,
        referenceAt: new Date("2026-03-29T19:00:00-03:00"),
    }), false);

    assert.equal(isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-03-29T10:12:00-03:00"),
        reactivatedAt: null,
        referenceAt: new Date("2026-03-29T21:00:00-03:00"),
    }), false);
});

test("resolveInterventionOccupancyActivationReferenceAt respeita SD/SN digitados antes da virada", () => {
    assert.equal(
        resolveInterventionOccupancyActivationReferenceAt({
            startedAt: new Date("2026-03-30T18:10:00-03:00"),
            scheduledStartAt: new Date("2026-03-30T19:00:00-03:00"),
        }).toISOString(),
        new Date("2026-03-30T19:00:00-03:00").toISOString(),
    );

    assert.equal(
        resolveInterventionOccupancyActivationReferenceAt({
            startedAt: new Date("2026-03-30T06:10:00-03:00"),
            scheduledStartAt: new Date("2026-03-30T07:00:00-03:00"),
        }).toISOString(),
        new Date("2026-03-30T07:00:00-03:00").toISOString(),
    );

    assert.equal(
        resolveInterventionOccupancyActivationReferenceAt({
            startedAt: new Date("2026-03-30T16:10:00-03:00"),
            scheduledStartAt: new Date("2026-03-30T07:00:00-03:00"),
        }).toISOString(),
        new Date("2026-03-30T16:10:00-03:00").toISOString(),
    );
});

test("chegada antecipada para SN usa a virada do turno para liberar base desativada", () => {
    const referenceAt = resolveInterventionOccupancyActivationReferenceAt({
        startedAt: new Date("2026-03-30T18:10:00-03:00"),
        scheduledStartAt: new Date("2026-03-30T19:00:00-03:00"),
    });

    assert.equal(isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-03-30T10:12:00-03:00"),
        reactivatedAt: null,
        referenceAt,
    }), false);
});