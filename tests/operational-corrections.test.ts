import assert from "node:assert/strict";
import test from "node:test";
import {
    filterTransferConflictsToShiftWindow,
    mergeOperationalNotes,
    resolveTransferShiftWindow,
    validateChronology,
    validateCorrectionChronology,
} from "@/modules/operational/corrections";
import { isInterventionBaseDeactivationActive, resolveInterventionBaseDeactivationExpiresAt } from "@/modules/intervention/service";
import { isRegulationPostDeactivationActive, resolveRegulationPostDeactivationExpiresAt } from "@/modules/regulation/service";

// ─── validateChronology ──────────────────────────────────────────────

test("validateChronology accepts valid chronological order", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    const boardStartedAt = new Date("2025-04-04T07:05:00Z");
    const endedAt = new Date("2025-04-04T19:00:00Z");
    const actualEndedAt = new Date("2025-04-04T19:10:00Z");

    assert.doesNotThrow(() => validateChronology(startedAt, boardStartedAt, endedAt, actualEndedAt));
});

test("validateChronology accepts null optional timestamps", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    assert.doesNotThrow(() => validateChronology(startedAt, null, null, null));
});

test("validateChronology accepts equal timestamps (boardStartedAt = startedAt)", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    assert.doesNotThrow(() => validateChronology(startedAt, startedAt, null, null));
});

test("validateChronology accepts equal timestamps (endedAt = startedAt)", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    assert.doesNotThrow(() => validateChronology(startedAt, null, startedAt, null));
});

test("validateChronology throws when boardStartedAt is before startedAt", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    const boardStartedAt = new Date("2025-04-04T06:59:00Z");

    assert.throws(
        () => validateChronology(startedAt, boardStartedAt, null, null),
        /Board start cannot be before the recorded arrival/,
    );
});

test("validateChronology throws when endedAt is before startedAt", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    const endedAt = new Date("2025-04-04T06:30:00Z");

    assert.throws(
        () => validateChronology(startedAt, null, endedAt, null),
        /Board end cannot be before the recorded arrival/,
    );
});

test("validateChronology throws when actualEndedAt is before startedAt", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    const actualEndedAt = new Date("2025-04-04T06:00:00Z");

    assert.throws(
        () => validateChronology(startedAt, null, null, actualEndedAt),
        /Actual end cannot be before the recorded arrival/,
    );
});

test("validateChronology throws when endedAt is before boardStartedAt", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    const boardStartedAt = new Date("2025-04-04T08:00:00Z");
    const endedAt = new Date("2025-04-04T07:30:00Z");

    assert.throws(
        () => validateChronology(startedAt, boardStartedAt, endedAt, null),
        /Board end cannot be before the board start/,
    );
});

test("validateChronology accepts actualEndedAt after endedAt (overtime scenario)", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    const endedAt = new Date("2025-04-04T19:00:00Z");
    const actualEndedAt = new Date("2025-04-04T19:30:00Z");

    assert.doesNotThrow(() => validateChronology(startedAt, null, endedAt, actualEndedAt));
});

test("validateChronology accepts actualEndedAt before endedAt (early departure)", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    const endedAt = new Date("2025-04-04T19:00:00Z");
    const actualEndedAt = new Date("2025-04-04T18:00:00Z");

    assert.doesNotThrow(() => validateChronology(startedAt, null, endedAt, actualEndedAt));
});

test("validateChronology rejects boardStartedAt < startedAt (direct validation)", () => {
    // validateChronology itself still rejects this — but correctRegulationOccupancy
    // should skip calling it when only non-temporal fields change, since continuity
    // occupancies legitimately have boardStartedAt < startedAt.
    const startedAt = new Date("2025-04-04T19:00:00-03:00");
    const boardStartedAt = new Date("2025-04-04T07:00:00-03:00"); // original SD arrival

    assert.throws(
        () => validateChronology(startedAt, boardStartedAt, null, null),
        /Board start cannot be before the recorded arrival/,
    );
});

test("validateCorrectionChronology allows correcting actual end on continuity rows without revalidating the inherited board anchor", () => {
    const startedAt = new Date("2025-04-04T19:00:00-03:00");
    const boardStartedAt = new Date("2025-04-04T07:00:00-03:00");
    const actualEndedAt = new Date("2025-04-05T07:10:00-03:00");

    assert.doesNotThrow(() => validateCorrectionChronology({
        startedAt,
        boardStartedAt,
        endedAt: null,
        actualEndedAt,
        actualEndedAtChanged: true,
    }));
});

test("validateCorrectionChronology still rejects impossible board anchors when the anchor itself is being edited", () => {
    const startedAt = new Date("2025-04-04T19:00:00-03:00");
    const boardStartedAt = new Date("2025-04-04T07:00:00-03:00");

    assert.throws(
        () => validateCorrectionChronology({
            startedAt,
            boardStartedAt,
            endedAt: null,
            actualEndedAt: null,
            boardStartedAtChanged: true,
        }),
        /Board start cannot be before the recorded arrival/,
    );
});

// ─── mergeOperationalNotes ───────────────────────────────────────────

test("mergeOperationalNotes joins non-empty segments", () => {
    const result = mergeOperationalNotes("first note", "second note");
    assert.equal(result, "first note\n\nsecond note");
});

test("mergeOperationalNotes returns null for empty input", () => {
    const result = mergeOperationalNotes(null, undefined, "");
    assert.equal(result, null);
});

test("mergeOperationalNotes skips null and undefined segments", () => {
    const result = mergeOperationalNotes(null, "valid note", undefined);
    assert.equal(result, "valid note");
});

test("mergeOperationalNotes trims whitespace from segments", () => {
    const result = mergeOperationalNotes("  note with spaces  ", "  another  ");
    assert.equal(result, "note with spaces\n\nanother");
});

test("mergeOperationalNotes returns single segment without double newline", () => {
    const result = mergeOperationalNotes("only one");
    assert.equal(result, "only one");
});

test("mergeOperationalNotes handles all null/empty inputs", () => {
    assert.equal(mergeOperationalNotes(), null);
    assert.equal(mergeOperationalNotes(null), null);
    assert.equal(mergeOperationalNotes(null, null, null), null);
    assert.equal(mergeOperationalNotes("", "", ""), null);
});

test("resolveTransferShiftWindow treats 16:00 as next SN shift", () => {
    const at1600Sp = new Date("2026-04-12T19:00:00.000Z");
    const window = resolveTransferShiftWindow(at1600Sp);
    assert.equal(window.shiftLabel, "SN");
    assert.equal(window.startedAt.toISOString(), "2026-04-12T22:00:00.000Z");
});

test("resolveTransferShiftWindow treats 04:00 as next SD shift", () => {
    const at0400Sp = new Date("2026-04-12T07:00:00.000Z");
    const window = resolveTransferShiftWindow(at0400Sp);
    assert.equal(window.shiftLabel, "SD");
    assert.equal(window.startedAt.toISOString(), "2026-04-12T10:00:00.000Z");
});

test("filterTransferConflictsToShiftWindow ignores past-shift open occupancy", () => {
    const transferShiftStartAt = new Date("2026-04-12T10:00:00.000Z");
    const conflicts = filterTransferConflictsToShiftWindow([
        {
            id: "old",
            startedAt: new Date("2026-04-11T09:56:46.000Z"),
            boardStartedAt: new Date("2026-04-11T09:56:46.000Z"),
            scheduledStartAt: new Date("2026-04-11T10:00:00.000Z"),
        },
        {
            id: "current",
            startedAt: new Date("2026-04-12T09:56:09.000Z"),
            boardStartedAt: new Date("2026-04-12T09:56:09.000Z"),
            scheduledStartAt: new Date("2026-04-12T10:00:00.000Z"),
        },
    ], transferShiftStartAt);

    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.scheduledStartAt?.toISOString(), "2026-04-12T10:00:00.000Z");
});

// ─── Desativação expira na virada do turno ────────────────────────────
// Uma desativação de base/posto vale só até a próxima virada 07:00/19:00 SP. Depois
// dela a base/posto volta a 'waiting' (→ AGUARDANDO o próximo escalado) sem reativação
// manual. Antes, a desativação nunca expirava (stub ano 9999) e a base ficava escura
// indefinidamente, suprimindo o "AGUARDANDO FULANO". Como efeito colateral, isto também
// neutraliza janelas órfãs antigas (fronteira já passada) — como a do incidente Camila
// Coutinho BR05 (aberta desde 14/07): hoje ela é classificada como INATIVA.

test("resolveInterventionBaseDeactivationExpiresAt retorna a virada do turno (SD → 19:00 SP)", () => {
    // 09:38 SP (= 12:38Z) está no SD; expira às 19:00 SP (= 22:00Z) do mesmo dia.
    const expiresAt = resolveInterventionBaseDeactivationExpiresAt(new Date("2026-07-23T12:38:00.000Z"));
    assert.equal(expiresAt.toISOString(), "2026-07-23T22:00:00.000Z");
});

test("resolveRegulationPostDeactivationExpiresAt retorna a virada do turno (SN → 07:00 SP do dia seguinte)", () => {
    // 20:00 SP (= 23:00Z) está no SN; expira às 07:00 SP (= 10:00Z) do dia seguinte.
    const expiresAt = resolveRegulationPostDeactivationExpiresAt(new Date("2026-07-23T23:00:00.000Z"));
    assert.equal(expiresAt.toISOString(), "2026-07-24T10:00:00.000Z");
});

test("desativação vale DENTRO do turno em que foi feita — base de intervenção", () => {
    const active = isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-07-23T12:38:00.000Z"), // 09:38 SP (SD)
        reactivatedAt: null,
        referenceAt: new Date("2026-07-23T13:00:00.000Z"), // 10:00 SP, mesmo turno
    });
    assert.equal(active, true);
});

test("desativação EXPIRA passada a virada do turno — base de intervenção", () => {
    const active = isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-07-23T12:38:00.000Z"), // 09:38 SP (SD)
        reactivatedAt: null,
        referenceAt: new Date("2026-07-23T22:30:00.000Z"), // 19:30 SP, já no SN
    });
    assert.equal(active, false);
});

test("desativação EXPIRA passada a virada do turno — posto de regulação", () => {
    const active = isRegulationPostDeactivationActive({
        deactivatedAt: new Date("2026-07-23T12:38:00.000Z"),
        reactivatedAt: null,
        referenceAt: new Date("2026-07-23T22:30:00.000Z"),
    });
    assert.equal(active, false);
});

test("janela órfã antiga (dias atrás) já não conta como ativa — incidente BR05", () => {
    const active = isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-07-14T12:41:00.000Z"),
        reactivatedAt: null,
        referenceAt: new Date("2026-07-23T11:51:00.000Z"),
    });
    assert.equal(active, false);
});

test("desativação futura não conta como ativa (referência antes de deactivatedAt)", () => {
    const active = isInterventionBaseDeactivationActive({
        deactivatedAt: new Date("2026-07-25T12:00:00.000Z"),
        reactivatedAt: null,
        referenceAt: new Date("2026-07-23T11:51:00.000Z"),
    });
    assert.equal(active, false);
});
