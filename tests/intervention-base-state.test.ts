import assert from "node:assert/strict";
import test from "node:test";
import {
    isInterventionShadowOccupancyNotes,
    isInterventionBaseDeactivationActive,
    resolveExistingInterventionBoardAnchor,
    resolveSameDoctorBoardStartedAt,
    resolveInterventionArrivalBoardPolicy,
    resolveInterventionOccupancyActivationReferenceAt,
    resolveInterventionBaseDeactivationExpiresAt,
    resolveSafeInterventionHandoffAt,
    resolveStaleShadowInterventionEndedAt,
    shouldCloseInterventionBoardCarrierOnArrival,
    shouldInheritContinuityFromOtherBaseOccupancy,
    shouldReuseImplicitContinuitySource,
} from "@/modules/intervention/service";
import { isRegulationPostDeactivationActive, shouldReuseImplicitRegulationContinuitySource } from "@/modules/regulation/service";

test("resolveInterventionBaseDeactivationExpiresAt passa a representar persistencia indefinida", () => {
    assert.equal(
        resolveInterventionBaseDeactivationExpiresAt(new Date("2026-03-29T10:12:00-03:00")).toISOString(),
        new Date("9999-12-31T23:59:59.999Z").toISOString(),
    );
});

test("isInterventionBaseDeactivationActive exige /ativar manual para liberar turnos futuros", () => {
    assert.equal(isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-03-29T10:12:00-03:00"),
        reactivatedAt: null,
        referenceAt: new Date("2026-03-29T18:59:00-03:00"),
    }), true);

    assert.equal(isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-03-29T10:12:00-03:00"),
        reactivatedAt: null,
        referenceAt: new Date("2026-03-29T19:00:00-03:00"),
    }), true);

    assert.equal(isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-03-29T10:12:00-03:00"),
        reactivatedAt: null,
        referenceAt: new Date("2026-03-29T21:00:00-03:00"),
    }), true);
});

test("isInterventionBaseDeactivationActive respeita a ultima reativacao valida", () => {
    assert.equal(isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-03-29T10:12:00-03:00"),
        reactivatedAt: new Date("2026-03-30T08:00:00-03:00"),
        referenceAt: new Date("2026-03-30T07:59:00-03:00"),
    }), true);

    assert.equal(isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-03-29T10:12:00-03:00"),
        reactivatedAt: new Date("2026-03-30T08:00:00-03:00"),
        referenceAt: new Date("2026-03-30T08:00:00-03:00"),
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

test("chegada antecipada para SN continua bloqueada sem reativacao manual", () => {
    const referenceAt = resolveInterventionOccupancyActivationReferenceAt({
        startedAt: new Date("2026-03-30T18:10:00-03:00"),
        scheduledStartAt: new Date("2026-03-30T19:00:00-03:00"),
    });

    assert.equal(isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-03-30T10:12:00-03:00"),
        reactivatedAt: null,
        referenceAt,
    }), true);
});

test("isRegulationPostDeactivationActive segue a mesma persistencia ate reativacao", () => {
    assert.equal(isRegulationPostDeactivationActive({
        deactivatedAt: new Date("2026-03-29T10:12:00-03:00"),
        reactivatedAt: null,
        referenceAt: new Date("2026-03-31T10:12:00-03:00"),
    }), true);

    assert.equal(isRegulationPostDeactivationActive({
        deactivatedAt: new Date("2026-03-29T10:12:00-03:00"),
        reactivatedAt: new Date("2026-03-31T09:00:00-03:00"),
        referenceAt: new Date("2026-03-31T10:12:00-03:00"),
    }), false);
});

test("auto-reactivation on arrival: deactivation becomes inactive when reactivatedAt is set to arrival time", () => {
    // Before auto-reactivation: base is deactivated, no reactivation recorded
    assert.equal(isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-04-01T08:00:00-03:00"),
        reactivatedAt: null,
        referenceAt: new Date("2026-04-01T14:30:00-03:00"),
    }), true);

    // After auto-reactivation: arrival at 14:30 sets reactivatedAt, any check at or after that time sees inactive
    assert.equal(isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-04-01T08:00:00-03:00"),
        reactivatedAt: new Date("2026-04-01T14:30:00-03:00"),
        referenceAt: new Date("2026-04-01T14:30:00-03:00"),
    }), false);

    // Same for regulation
    assert.equal(isRegulationPostDeactivationActive({
        deactivatedAt: new Date("2026-04-01T08:00:00-03:00"),
        reactivatedAt: null,
        referenceAt: new Date("2026-04-01T14:30:00-03:00"),
    }), true);

    assert.equal(isRegulationPostDeactivationActive({
        deactivatedAt: new Date("2026-04-01T08:00:00-03:00"),
        reactivatedAt: new Date("2026-04-01T14:30:00-03:00"),
        referenceAt: new Date("2026-04-01T14:30:00-03:00"),
    }), false);
});

test("auto-reactivation on SN arrival: pre-shift arrival at 18:15 reactivates for the upcoming SN", () => {
    // Base deactivated during SD
    assert.equal(isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-04-01T10:00:00-03:00"),
        reactivatedAt: null,
        referenceAt: new Date("2026-04-01T19:00:00-03:00"),
    }), true);

    // Doctor arrives at 18:15 (pre-SN window), auto-reactivates with arrival time
    // The activation reference resolves to scheduledStartAt 19:00 for pre-shift
    const activationRef = resolveInterventionOccupancyActivationReferenceAt({
        startedAt: new Date("2026-04-01T18:15:00-03:00"),
        scheduledStartAt: new Date("2026-04-01T19:00:00-03:00"),
    });
    // Deactivation was active at the scheduledStartAt reference
    assert.equal(isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-04-01T10:00:00-03:00"),
        reactivatedAt: null,
        referenceAt: activationRef,
    }), true);

    // After auto-reactivation sets reactivatedAt = startedAt (18:15)
    assert.equal(isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-04-01T10:00:00-03:00"),
        reactivatedAt: new Date("2026-04-01T18:15:00-03:00"),
        referenceAt: activationRef,
    }), false);
});

test("implicit continuity reuse only links recent closed sources", () => {
    assert.equal(
        shouldReuseImplicitContinuitySource(
            new Date("2026-04-07T18:33:52-03:00"),
            new Date("2026-04-07T07:03:28-03:00"),
        ),
        false,
    );

    assert.equal(
        shouldReuseImplicitContinuitySource(
            new Date("2026-04-07T07:15:09-03:00"),
            new Date("2026-04-07T07:12:52-03:00"),
        ),
        true,
    );

    assert.equal(
        shouldReuseImplicitRegulationContinuitySource(
            new Date("2026-04-07T18:33:52-03:00"),
            new Date("2026-04-07T07:03:28-03:00"),
        ),
        false,
    );
});

test("resolveSafeInterventionHandoffAt fecha a base anterior do medico no horario do remanejamento", () => {
    const handoffAt = resolveSafeInterventionHandoffAt({
        sourceStartedAt: new Date("2026-04-08T06:54:48-03:00"),
        requestedAt: new Date("2026-04-08T07:00:00-03:00"),
    });

    assert.equal(handoffAt?.toISOString(), new Date("2026-04-08T07:00:00-03:00").toISOString());
});

test("resolveSafeInterventionHandoffAt bloqueia handoff de duracao zero", () => {
    const handoffAt = resolveSafeInterventionHandoffAt({
        sourceStartedAt: new Date("2026-04-08T07:00:00-03:00"),
        requestedAt: new Date("2026-04-08T06:59:30-03:00"),
    });

    assert.equal(handoffAt, null);
});

test("resolveExistingInterventionBoardAnchor usa startedAt quando boardStartedAt estiver nulo", () => {
    const startedAt = new Date("2026-04-28T10:14:00.000Z");

    assert.equal(
        resolveExistingInterventionBoardAnchor({
            startedAt,
            boardStartedAt: null,
        }).toISOString(),
        startedAt.toISOString(),
    );

    const boardStartedAt = new Date("2026-04-28T10:16:00.000Z");
    assert.equal(
        resolveExistingInterventionBoardAnchor({
            startedAt,
            boardStartedAt,
        }).toISOString(),
        boardStartedAt.toISOString(),
    );
});

test("resolveSameDoctorBoardStartedAt preserva nulo para sombra sem board carrier", () => {
    const currentShiftStart = new Date("2026-04-28T10:00:00.000Z");
    const effectiveBoardStartedAt = new Date("2026-04-28T10:14:00.000Z");

    assert.equal(resolveSameDoctorBoardStartedAt({
        existingStartedAt: new Date("2026-04-28T10:14:00.000Z"),
        existingBoardStartedAt: null,
        effectiveBoardStartedAt,
        currentShiftStart,
    }), null);

    assert.equal(
        resolveSameDoctorBoardStartedAt({
            existingStartedAt: new Date("2026-04-28T10:14:00.000Z"),
            existingBoardStartedAt: new Date("2026-04-28T10:16:00.000Z"),
            effectiveBoardStartedAt,
            currentShiftStart,
        })?.toISOString(),
        effectiveBoardStartedAt.toISOString(),
    );

        const existingBoardStartedAt = new Date("2026-04-28T10:16:00.000Z");
        assert.equal(
            resolveSameDoctorBoardStartedAt({
                existingStartedAt: new Date("2026-04-28T10:14:00.000Z"),
                existingBoardStartedAt,
                effectiveBoardStartedAt: null,
                currentShiftStart,
            })?.toISOString(),
            existingBoardStartedAt.toISOString(),
        );
});

test("resolveInterventionArrivalBoardPolicy preserva o titular quando a chegada eh sombra", () => {
    assert.deepEqual(resolveInterventionArrivalBoardPolicy({
        source: "telegram",
        isShadow: true,
        hasCurrentBoardCarrier: true,
    }), {
        shouldTakeBoardImmediately: false,
    });
});

test("resolveInterventionArrivalBoardPolicy permite board imediato sem titular previo", () => {
    assert.deepEqual(resolveInterventionArrivalBoardPolicy({
        source: "telegram",
        isShadow: true,
        hasCurrentBoardCarrier: false,
    }), {
        shouldTakeBoardImmediately: true,
    });
});

test("isInterventionShadowOccupancyNotes reconhece o caso do Leonardo Prado Faben na PM40", () => {
    assert.equal(
        isInterventionShadowOccupancyNotes("[telegram sombra] Leonardo Prado Faben PM40 07:10 sombra"),
        true,
    );
});

test("shouldCloseInterventionBoardCarrierOnArrival nao encerra sombra quando outro medico chega", () => {
    assert.equal(shouldCloseInterventionBoardCarrierOnArrival({
        currentCarrierDoctorId: "doc-shadow",
        arrivingDoctorId: "doc-titular",
        currentCarrierNotes: "[telegram sombra] Leonardo Prado Faben PM40 07:10 sombra",
    }), false);

    assert.equal(shouldCloseInterventionBoardCarrierOnArrival({
        currentCarrierDoctorId: "doc-titular",
        arrivingDoctorId: "doc-shadow",
        currentCarrierNotes: "Titular PM40 07:00",
    }), true);
});

test("resolveStaleShadowInterventionEndedAt encerra sombra exatamente no fim da janela", () => {
    const scheduledEndAt = new Date("2026-04-28T22:00:00.000Z");

    assert.equal(resolveStaleShadowInterventionEndedAt({
        notes: "[telegram sombra] Leonardo Prado Faben PM40 07:10 sombra",
        scheduledEndAt,
        endedAt: null,
        referenceAt: new Date("2026-04-28T21:59:00.000Z"),
    }), null);

    assert.equal(
        resolveStaleShadowInterventionEndedAt({
            notes: "[telegram sombra] Leonardo Prado Faben PM40 07:10 sombra",
            scheduledEndAt,
            endedAt: null,
            referenceAt: new Date("2026-04-28T22:01:00.000Z"),
        })?.toISOString(),
        scheduledEndAt.toISOString(),
    );
});
test("shouldInheritContinuityFromOtherBaseOccupancy só herda em remanejamento dentro do mesmo turno", () => {
    // Remanejamento legítimo: aberto às 08:00 SD, chega outra base 13:00 mesmo SD
    assert.equal(shouldInheritContinuityFromOtherBaseOccupancy({
        otherBaseStartedAt: new Date("2026-05-03T08:00:00-03:00"),
        eventAt: new Date("2026-05-03T13:00:00-03:00"),
    }), true);

    // Plantão SD aberto há um dia (esquecimento), nova chegada hoje à tarde → não herda
    assert.equal(shouldInheritContinuityFromOtherBaseOccupancy({
        otherBaseStartedAt: new Date("2026-05-02T08:00:00-03:00"),
        eventAt: new Date("2026-05-03T15:00:00-03:00"),
    }), false);

    // Esquecimento atravessando boundary do dia: aberto às 18:00 SD, chega 21:00 SN
    // mesmo dia → janelas operacionais distintas, não herda
    assert.equal(shouldInheritContinuityFromOtherBaseOccupancy({
        otherBaseStartedAt: new Date("2026-05-03T18:00:00-03:00"),
        eventAt: new Date("2026-05-03T21:00:00-03:00"),
    }), false);

    // Caso Leo Morais (variante hipotética em que PR03 ficou aberto): aberto manhã,
    // chegada à noite → janelas distintas, não herda
    assert.equal(shouldInheritContinuityFromOtherBaseOccupancy({
        otherBaseStartedAt: new Date("2026-05-03T07:00:00-03:00"),
        eventAt: new Date("2026-05-03T19:09:59-03:00"),
    }), false);
});
