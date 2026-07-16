import assert from "node:assert/strict";
import test from "node:test";

import type {
    ChiefPayableBoardModel,
    ChiefPayableDoctorRow,
    PayableShift,
} from "@/modules/reporting/payable-shifts";
import {
    buildPaymentDigestDocument,
    formatDoctorBlock,
    formatShiftLine,
    shouldSendPaymentDigest,
} from "@/modules/telegram/payment-digest";
import {
    parseTelegramPaymentDigestCommand,
    resolveMonthKeyToken,
} from "@/modules/telegram/payment-commands";

function makeShift(overrides: Partial<PayableShift>): PayableShift {
    return {
        payableShiftId: "ps",
        occupancyId: "occ",
        domain: "regulation",
        doctorId: "doc",
        doctorName: "Médico",
        displayName: null,
        targetCode: "PR03",
        targetLabel: "PR03",
        tagCode: "PR03",
        operationalDate: "2026-06-01",
        shiftLabel: "SD",
        slotStartedAt: "2026-06-01T10:00:00.000Z",
        slotEndedAt: "2026-06-01T22:00:00.000Z",
        startedAt: "2026-06-01T10:00:00.000Z",
        endedAt: "2026-06-01T22:00:00.000Z",
        durationMinutes: 720,
        paymentStatus: "ready_for_payment",
        auditStatus: "clean",
        issues: [],
        source: "telegram",
        roleLabel: null,
        paymentUnit: 1,
        paymentTag: null,
        ...overrides,
    };
}

function makeDoctor(doctorName: string, shifts: PayableShift[]): ChiefPayableDoctorRow {
    const byDay = new Map<string, PayableShift[]>();
    for (const shift of shifts) {
        const day = shift.operationalDate.slice(8, 10);
        const list = byDay.get(day) ?? [];
        list.push(shift);
        byDay.set(day, list);
    }
    return {
        doctorId: doctorName,
        doctorName,
        displayName: null,
        paymentStatus: "ready_for_payment",
        totalSD: 0,
        totalSN: 0,
        total: shifts.length,
        pendingCount: 0,
        attestedAt: null,
        cells: [...byDay.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([day, dayShifts]) => ({ day, shifts: dayShifts })),
    };
}

function makeBoard(doctors: ChiefPayableDoctorRow[]): ChiefPayableBoardModel {
    return {
        allDoctorNames: doctors.map((d) => d.doctorName),
        monthKey: "2026-06",
        monthLabel: "Junho 2026",
        presetMonths: [],
        range: { startIso: "2026-06-01T03:00:00.000Z", endIso: "2026-07-01T03:00:00.000Z" },
        days: [],
        summary: {
            doctorCount: doctors.length,
            payableShiftCount: 0,
            payableUnitCount: 0,
            readyCount: 0,
            needsReviewCount: 0,
            segmentCount: 0,
            discardedSegmentCount: 0,
            disabledTargetCount: 0,
            uncoveredTargetCount: 0,
        },
        targetOptions: [],
        doctors,
        payableShifts: [],
        disabledTargets: [],
        uncoveredTargets: [],
        attestationSegments: [],
    };
}

// 12:05 em São Paulo (UTC-3) = 15:05 UTC.
const NOON_SP = new Date("2026-06-07T15:05:00.000Z");

test("formatShiftLine produz linha compacta para dia útil", () => {
    const line = formatShiftLine(makeShift({ operationalDate: "2026-06-01", shiftLabel: "SD", targetCode: "PR03" }));
    assert.equal(line, "01/06 Seg SD PR03 (Dia útil)");
});

test("formatShiftLine marca feriado SAMU", () => {
    // 2026-06-04 (Corpus Christi) está em SAMU_HOLIDAYS.
    const line = formatShiftLine(makeShift({ operationalDate: "2026-06-04", shiftLabel: "SN", targetCode: "BR60" }));
    assert.equal(line, "04/06 Qui SN BR60 (Feriado)");
});

test("formatShiftLine marca fim de semana", () => {
    // 2026-06-06 é sábado.
    const line = formatShiftLine(makeShift({ operationalDate: "2026-06-06", shiftLabel: "SD", targetCode: "CRU" }));
    assert.equal(line, "06/06 Sáb SD CRU (Fim de semana)");
});

test("formatShiftLine acrescenta tag MEIO em meio-plantão", () => {
    const line = formatShiftLine(makeShift({ operationalDate: "2026-06-02", paymentTag: "MEIO", targetCode: "BR60", shiftLabel: "SN" }));
    assert.equal(line, "02/06 Ter SN BR60 (Dia útil) MEIO");
});

test("formatDoctorBlock retorna null quando médico não tem plantão", () => {
    assert.equal(formatDoctorBlock(makeDoctor("Sem Plantão", [])), null);
});

test("formatDoctorBlock lista heading com contagem e linhas em ordem de dia", () => {
    const block = formatDoctorBlock(makeDoctor("Acácio Junio de Almeida", [
        makeShift({ operationalDate: "2026-06-02", shiftLabel: "SN", targetCode: "BR60" }),
        makeShift({ operationalDate: "2026-06-01", shiftLabel: "SD", targetCode: "PR03" }),
    ]));
    assert.equal(block, [
        "## 👤 Acácio Junio de Almeida — 2 plantões",
        "",
        "- 01/06 Seg SD PR03 (Dia útil)",
        "- 02/06 Ter SN BR60 (Dia útil)",
    ].join("\n"));
});

test("shouldSendPaymentDigest abre só na janela das 12:00 (SP)", () => {
    assert.equal(shouldSendPaymentDigest(new Date("2026-06-07T15:05:00.000Z")), true); // 12:05 SP
    assert.equal(shouldSendPaymentDigest(new Date("2026-06-07T14:55:00.000Z")), false); // 11:55 SP
    assert.equal(shouldSendPaymentDigest(new Date("2026-06-07T15:10:00.000Z")), false); // 12:10 SP
});

test("buildPaymentDigestDocument retorna null para board sem plantões", () => {
    const board = makeBoard([makeDoctor("Fulano", []), makeDoctor("Beltrano", [])]);
    assert.equal(buildPaymentDigestDocument(board, NOON_SP), null);
});

test("buildPaymentDigestDocument agrupa por médico, ordena por nome e inclui cabeçalho", () => {
    const board = makeBoard([
        makeDoctor("Zé da Silva", [makeShift({ operationalDate: "2026-06-03", shiftLabel: "SD", targetCode: "CRU" })]),
        makeDoctor("Ana Paula", [
            makeShift({ operationalDate: "2026-06-01", shiftLabel: "SD", targetCode: "PR03" }),
            makeShift({ operationalDate: "2026-06-02", shiftLabel: "SN", targetCode: "BR60", paymentTag: "MEIO" }),
        ]),
    ]);
    const document = buildPaymentDigestDocument(board, NOON_SP);
    assert.ok(document);
    assert.equal(document.filename, "fechamento-provisorio-2026-06.md");
    assert.match(document.content, /^# 💰 Fechamento provisório — Junho 2026/);
    assert.match(document.content, /Gerado 07\/06 12:05/);
    assert.match(document.content, /2 médicos · 3 plantões \(1 MEIO\)/);
    // Ana antes de Zé.
    assert.ok(document.content.indexOf("Ana Paula") < document.content.indexOf("Zé da Silva"));
    // Caption curta traz mês, stamp e resumo.
    assert.match(document.caption, /Junho 2026/);
    assert.match(document.caption, /2 médicos · 3 plantões/);
    assert.ok(document.caption.length <= 1024, "caption dentro do limite do Telegram");
});

// Referência: 07/06/2026 12:00 SP (junho).
const JUN_REF = new Date("2026-06-07T15:00:00.000Z");

test("resolveMonthKeyToken resolve vazio, número, nome e ISO", () => {
    assert.equal(resolveMonthKeyToken("", JUN_REF), null); // vazio → mês atual (null)
    assert.equal(resolveMonthKeyToken("05", JUN_REF), "2026-05");
    assert.equal(resolveMonthKeyToken("5", JUN_REF), "2026-05");
    assert.equal(resolveMonthKeyToken("maio", JUN_REF), "2026-05");
    assert.equal(resolveMonthKeyToken("Maio", JUN_REF), "2026-05");
    assert.equal(resolveMonthKeyToken("março", JUN_REF), "2026-03");
    assert.equal(resolveMonthKeyToken("mai", JUN_REF), "2026-05");
    assert.equal(resolveMonthKeyToken("2026-04", JUN_REF), "2026-04");
});

test("resolveMonthKeyToken usa ano anterior quando o mês ainda não chegou", () => {
    // Em janeiro/2026, pedir 'dezembro' deve trazer dez/2025.
    assert.equal(resolveMonthKeyToken("dezembro", new Date("2026-01-15T15:00:00.000Z")), "2025-12");
});

test("resolveMonthKeyToken rejeita tokens inválidos", () => {
    assert.equal(resolveMonthKeyToken("13", JUN_REF), null);
    assert.equal(resolveMonthKeyToken("conferir", JUN_REF), null);
    assert.equal(resolveMonthKeyToken("xyz", JUN_REF), null);
});

test("parseTelegramPaymentDigestCommand aceita bare e mês, rejeita subcomandos", () => {
    assert.deepEqual(parseTelegramPaymentDigestCommand("/pagamento", JUN_REF), { name: "payment_digest", monthKey: null, rawBody: "" });
    assert.deepEqual(parseTelegramPaymentDigestCommand("/pagamento 05", JUN_REF), { name: "payment_digest", monthKey: "2026-05", rawBody: "05" });
    assert.deepEqual(parseTelegramPaymentDigestCommand("/pagamento maio", JUN_REF), { name: "payment_digest", monthKey: "2026-05", rawBody: "maio" });
    assert.equal(parseTelegramPaymentDigestCommand("/pagamento conferir", JUN_REF), null);
    assert.equal(parseTelegramPaymentDigestCommand("/pagamento corrigir PM04 | Karen", JUN_REF), null);
    assert.equal(parseTelegramPaymentDigestCommand("/pagamento maio junho", JUN_REF), null);
});

test("buildPaymentDigestDocument gera arquivo único mesmo com volume de mês inteiro", () => {
    const doctors: ChiefPayableDoctorRow[] = [];
    for (let i = 0; i < 160; i++) {
        const name = `Doutor ${String(i).padStart(3, "0")}`;
        doctors.push(makeDoctor(name, [
            makeShift({ doctorName: name, operationalDate: "2026-06-01", shiftLabel: "SD", targetCode: "PR03" }),
            makeShift({ doctorName: name, operationalDate: "2026-06-02", shiftLabel: "SN", targetCode: "BR60" }),
        ]));
    }
    const document = buildPaymentDigestDocument(makeBoard(doctors), NOON_SP);
    assert.ok(document);
    assert.match(document.content, /160 médicos · 320 plantões/);
    const blockHeaders = document.content.match(/## 👤 Doutor \d{3}/g) ?? [];
    assert.equal(blockHeaders.length, 160, "todos os 160 médicos presentes");
    // Médico sem plantão não entra no arquivo.
    const withEmpty = buildPaymentDigestDocument(makeBoard([...doctors, makeDoctor("Zé Sem Plantão", [])]), NOON_SP);
    assert.ok(withEmpty);
    assert.ok(!withEmpty.content.includes("Zé Sem Plantão"));
});
