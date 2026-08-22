import assert from "node:assert/strict";
import test from "node:test";
import {
    buildContinuityBankHoursSpan,
    buildContinuityCarrierLookup,
    isDepartureClosureAuthoritative,
    resolveContinuityEffectiveEndedAt,
} from "@/modules/bank-hours/continuity";
import { calculateBankHours } from "@/modules/bank-hours/calculator";

test("rendição (endedAt sem actualEndedAt) fecha o banco autoritativamente, sem precisar de confirmação", () => {
    // Handoff closure: predecessor closed at the handoff time with no verbalized departure.
    assert.equal(
        isDepartureClosureAuthoritative({
            endedAt: new Date("2026-03-25T07:20:00-03:00"),
            actualEndedAt: null,
            departureConfirmedAt: null,
        }),
        true,
    );
    // Verbalized departure still in hold until the chefe confirms.
    assert.equal(
        isDepartureClosureAuthoritative({
            endedAt: new Date("2026-03-25T07:20:00-03:00"),
            actualEndedAt: new Date("2026-03-25T07:20:00-03:00"),
            departureConfirmedAt: null,
        }),
        false,
    );
});

test("resolveContinuityEffectiveEndedAt cai no endedAt quando o handoff não gravou actualEndedAt", () => {
    assert.equal(
        resolveContinuityEffectiveEndedAt({
            endedAt: new Date("2026-03-25T07:20:00-03:00"),
            actualEndedAt: null,
        })?.toISOString(),
        new Date("2026-03-25T07:20:00-03:00").toISOString(),
    );
});

test("buildContinuityBankHoursSpan fecha um grupo rendido (actualEndedAt null) no horário do handoff", () => {
    const span = buildContinuityBankHoursSpan([
        {
            occupancyId: "occ-1",
            domain: "intervention",
            doctorId: "doc-1",
            continuityGroupId: "cg-1",
            startedAt: new Date("2026-03-25T19:00:00-03:00"),
            endedAt: new Date("2026-03-26T07:20:00-03:00"),
            actualEndedAt: null,
            departureConfirmedAt: null,
            scheduledStartAt: null,
            scheduledEndAt: null,
            shiftLabel: "SN",
        },
    ]);

    assert.equal(span.isClosed, true);
    assert.equal(span.actualEndAt?.toISOString(), new Date("2026-03-26T07:20:00-03:00").toISOString());
});

test("buildContinuityBankHoursSpan preserves first arrival and final exit across a domain switch", () => {
    const span = buildContinuityBankHoursSpan([
        {
            occupancyId: "occ-1",
            domain: "intervention",
            doctorId: "doc-1",
            continuityGroupId: "cg-1",
            startedAt: new Date("2026-03-25T07:12:00-03:00"),
            endedAt: new Date("2026-03-25T19:00:00-03:00"),
            actualEndedAt: new Date("2026-03-25T19:00:00-03:00"),
            scheduledStartAt: null,
            scheduledEndAt: null,
            shiftLabel: "SD",
        },
        {
            occupancyId: "occ-2",
            domain: "regulation",
            doctorId: "doc-1",
            continuityGroupId: "cg-1",
            startedAt: new Date("2026-03-25T19:00:00-03:00"),
            endedAt: new Date("2026-03-26T07:20:00-03:00"),
            actualEndedAt: new Date("2026-03-26T07:20:00-03:00"),
            scheduledStartAt: null,
            scheduledEndAt: null,
            shiftLabel: "SN",
        },
    ]);

    assert.equal(span.carrierOccupancyId, "occ-1");
    assert.equal(span.actualStartAt.toISOString(), new Date("2026-03-25T07:12:00-03:00").toISOString());
    assert.equal(span.actualEndAt?.toISOString(), new Date("2026-03-26T07:20:00-03:00").toISOString());
    assert.equal(span.scheduledStartAt?.toISOString(), new Date("2026-03-25T07:00:00-03:00").toISOString());
    assert.equal(span.scheduledEndAt?.toISOString(), new Date("2026-03-26T07:00:00-03:00").toISOString());
});

test("buildContinuityCarrierLookup points every member to the first operational record in the chain", () => {
    const lookup = buildContinuityCarrierLookup([
        {
            occupancyId: "occ-1",
            doctorId: "doc-1",
            continuityGroupId: "cg-1",
            startedAt: "2026-03-25T10:00:00.000Z",
            endedAt: "2026-03-25T22:00:00.000Z",
            actualEndedAt: "2026-03-25T22:00:00.000Z",
        },
        {
            occupancyId: "occ-2",
            doctorId: "doc-1",
            continuityGroupId: "cg-1",
            startedAt: "2026-03-25T22:00:00.000Z",
            endedAt: "2026-03-26T10:00:00.000Z",
            actualEndedAt: "2026-03-26T10:00:00.000Z",
        },
    ]);

    assert.deepEqual(lookup.get("occ-1"), {
        carrierOccupancyId: "occ-1",
        continuityGroupId: "cg-1",
        memberCount: 2,
    });
    assert.deepEqual(lookup.get("occ-2"), {
        carrierOccupancyId: "occ-1",
        continuityGroupId: "cg-1",
        memberCount: 2,
    });
});
// Caso real (Ana Beatriz, 16→17/07/2026): entrou de noite na regulação 2031, avisou
// continuidade e emendou o dia na base CZ50. O registro da ponta nasceu com "P"
// herdado, e a extensão do P jogava o previsto para 18/07 07:00 — 12h depois da saída.
// Resultado: a permanência além das 19:00 sumia e o crédito em dobro não saía.
test("P herdado na ponta da continuidade não estica o previsto além da saída", () => {
    const span = buildContinuityBankHoursSpan([
        {
            occupancyId: "reg-2031",
            domain: "regulation",
            doctorId: "ana",
            continuityGroupId: "cg-p",
            startedAt: new Date("2026-07-16T19:06:48-03:00"),
            endedAt: new Date("2026-07-17T07:26:36-03:00"),
            actualEndedAt: new Date("2026-07-17T19:15:00-03:00"),
            departureConfirmedAt: new Date("2026-07-17T19:38:41-03:00"),
            scheduledStartAt: new Date("2026-07-16T19:00:00-03:00"),
            scheduledEndAt: new Date("2026-07-17T19:15:00-03:00"),
            shiftLabel: "P",
        },
        {
            occupancyId: "int-cz50",
            domain: "intervention",
            doctorId: "ana",
            continuityGroupId: "cg-p",
            startedAt: new Date("2026-07-17T07:47:38-03:00"),
            endedAt: new Date("2026-07-17T19:12:30-03:00"),
            actualEndedAt: new Date("2026-07-17T19:19:50-03:00"),
            departureConfirmedAt: new Date("2026-07-17T19:38:41-03:00"),
            scheduledStartAt: new Date("2026-07-17T07:00:00-03:00"),
            scheduledEndAt: new Date("2026-07-18T07:00:00-03:00"),
            shiftLabel: "P",
        },
    ]);

    assert.equal(span.scheduledStartAt?.toISOString(), new Date("2026-07-16T19:00:00-03:00").toISOString());
    assert.equal(span.scheduledEndAt?.toISOString(), new Date("2026-07-17T19:00:00-03:00").toISOString());
    assert.equal(span.actualEndAt?.toISOString(), new Date("2026-07-17T19:19:50-03:00").toISOString());
});

// O contrário também precisa valer: quem de fato cumpriu o turno extra prometido pelo
// "P" mantém a janela estendida (a saída na virada não pode virar hora extra).
test("P cumprido até a virada seguinte mantém o previsto estendido", () => {
    const span = buildContinuityBankHoursSpan([
        {
            occupancyId: "int-p-cumprido",
            domain: "intervention",
            doctorId: "doc-1",
            continuityGroupId: "cg-ok",
            startedAt: new Date("2026-07-16T19:00:00-03:00"),
            endedAt: null,
            actualEndedAt: new Date("2026-07-17T19:05:00-03:00"),
            departureConfirmedAt: new Date("2026-07-17T19:30:00-03:00"),
            scheduledStartAt: new Date("2026-07-16T19:00:00-03:00"),
            scheduledEndAt: null,
            shiftLabel: "P",
        },
    ]);

    assert.equal(span.scheduledEndAt?.toISOString(), new Date("2026-07-17T19:00:00-03:00").toISOString());
});

// Caso real (Rafael Santana Azevedo, 21→22/08/2026): entrou 19:02 na regulação 2152,
// emendou o dia na 2154 com "P" e saiu 18:41 — 19 min antes do fim previsto. O recuo
// do previsto tolerava só 15 min, então a janela caía para 22/08 07:00: um turno
// inteiro trabalhado (SD pagável) virava 11h41 de excedente, dobrado = +23h22 de
// banco, e o alerta oferecia um "plantão verde" à chefia.
test("saída faltando menos de 2h para o fim do P não recua o previsto nem vira crédito", () => {
    const span = buildContinuityBankHoursSpan([
        {
            occupancyId: "reg-2152",
            domain: "regulation",
            doctorId: "rafael",
            continuityGroupId: "cg-rafael",
            startedAt: new Date("2026-08-21T19:02:48-03:00"),
            endedAt: new Date("2026-08-22T06:52:15-03:00"),
            actualEndedAt: new Date("2026-08-22T06:53:17-03:00"),
            departureConfirmedAt: new Date("2026-08-22T07:32:11-03:00"),
            scheduledStartAt: new Date("2026-08-21T19:00:00-03:00"),
            scheduledEndAt: new Date("2026-08-22T07:15:00-03:00"),
            shiftLabel: "SN",
        },
        {
            occupancyId: "reg-2154",
            domain: "regulation",
            doctorId: "rafael",
            continuityGroupId: "cg-rafael",
            startedAt: new Date("2026-08-22T06:54:51-03:00"),
            endedAt: new Date("2026-08-22T18:41:42-03:00"),
            actualEndedAt: new Date("2026-08-22T18:41:42-03:00"),
            departureConfirmedAt: new Date("2026-08-22T19:00:00-03:00"),
            scheduledStartAt: new Date("2026-08-22T07:00:00-03:00"),
            scheduledEndAt: new Date("2026-08-22T19:15:00-03:00"),
            shiftLabel: "P",
        },
    ]);

    assert.equal(span.scheduledEndAt?.toISOString(), new Date("2026-08-22T19:00:00-03:00").toISOString());

    const calculation = calculateBankHours({
        scheduledStartAt: span.scheduledStartAt!,
        scheduledEndAt: span.scheduledEndAt!,
        actualStartAt: span.actualStartAt,
        actualEndAt: span.actualEndAt!,
    });

    assert.equal(calculation.overtimeMinutes, 0);
    assert.equal(calculation.balanceMinutes, 0);
});
