import assert from "node:assert/strict";
import test from "node:test";
import { resolveMultiSegmentDepartureTrim } from "@/modules/operational/multi-segment-departure";
import { triagePendingDeparture } from "@/modules/operational/departure-triage";

const at = (value: string) => new Date(value);

// P da regulação declarado na chegada: 27/08 07:00 -> 28/08 07:15.
const P_START = at("2026-08-27T07:00:00-03:00");
const P_END = at("2026-08-28T07:15:00-03:00");

test("P que saiu 19:07 vira SD com janela até 19:15 (regulação)", () => {
    const trim = resolveMultiSegmentDepartureTrim({
        domain: "regulation",
        scheduledStartAt: P_START,
        scheduledEndAt: P_END,
        departureAt: at("2026-08-27T19:07:00-03:00"),
    });
    assert.deepEqual(trim, { shiftLabel: "SD", scheduledEndAt: at("2026-08-27T19:15:00-03:00") });
});

test("P que saiu 20:30 também vira SD — a sobra é banco, não um SN retirado", () => {
    const trim = resolveMultiSegmentDepartureTrim({
        domain: "intervention",
        scheduledStartAt: P_START,
        scheduledEndAt: at("2026-08-28T07:00:00-03:00"),
        departureAt: at("2026-08-27T20:30:00-03:00"),
    });
    assert.deepEqual(trim, { shiftLabel: "SD", scheduledEndAt: at("2026-08-27T19:00:00-03:00") });
});

test("P com 6h ou mais no segundo turno não recorta — fica na régua de meio/inteiro", () => {
    assert.equal(resolveMultiSegmentDepartureTrim({
        domain: "regulation",
        scheduledStartAt: P_START,
        scheduledEndAt: P_END,
        departureAt: at("2026-08-28T01:00:00-03:00"),
    }), null);
});

test("saída no fim da janela ou depois não recorta", () => {
    assert.equal(resolveMultiSegmentDepartureTrim({
        domain: "regulation",
        scheduledStartAt: P_START,
        scheduledEndAt: P_END,
        departureAt: at("2026-08-28T07:20:00-03:00"),
    }), null);
});

test("ocupação de um turno só nunca recorta", () => {
    assert.equal(resolveMultiSegmentDepartureTrim({
        domain: "regulation",
        scheduledStartAt: P_START,
        scheduledEndAt: at("2026-08-27T19:15:00-03:00"),
        departureAt: at("2026-08-27T19:07:00-03:00"),
    }), null);
    assert.equal(resolveMultiSegmentDepartureTrim({
        domain: "regulation",
        scheduledStartAt: null,
        scheduledEndAt: null,
        departureAt: at("2026-08-27T19:07:00-03:00"),
    }), null);
});

test("P estendido por continuações perde só o último segmento e continua P", () => {
    // 27/08 07:00 -> 28/08 19:15 (SD + SN + SD); saiu 28/08 08:00.
    const trim = resolveMultiSegmentDepartureTrim({
        domain: "regulation",
        scheduledStartAt: P_START,
        scheduledEndAt: at("2026-08-28T19:15:00-03:00"),
        departureAt: at("2026-08-28T08:00:00-03:00"),
    });
    assert.deepEqual(trim, { shiftLabel: "P", scheduledEndAt: at("2026-08-28T07:15:00-03:00") });
});

test("depois do recorte a fila da chefia não oferece 'só banco / meio / inteiro'", () => {
    const trim = resolveMultiSegmentDepartureTrim({
        domain: "regulation",
        scheduledStartAt: P_START,
        scheduledEndAt: P_END,
        departureAt: at("2026-08-27T19:07:00-03:00"),
    })!;
    const triage = triagePendingDeparture({
        roleLabel: null,
        startedAt: at("2026-08-27T07:15:00-03:00"),
        actualEndedAt: at("2026-08-27T19:07:00-03:00"),
        scheduledStartAt: P_START,
        scheduledEndAt: trim.scheduledEndAt,
        delayMinutes: 0,
    });
    assert.equal(triage.kind, "routine");
});
