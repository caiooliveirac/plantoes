import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
    LEGACY_BANK_HOURS_EXPECTED_NET_TOTAL_MINUTES,
    LEGACY_BANK_HOURS_EXPECTED_ROW_COUNT,
    parseLegacyBankHoursCsv,
    parseSignedHoursToMinutes,
    validateLegacyBankHoursDataset,
} from "@/modules/bank-hours/legacy";
import {
    buildBankHoursHistoryModel,
    type BankHoursLegacyDoctorRecord,
    type RawBankHoursHistoryShift,
} from "@/modules/reporting/bank-hours-history";

const CSV_HEADER = "nome,saldo_pre_maio_2025,saldo_corrente_planilha,saldo_inicial_total";

test("parseSignedHoursToMinutes converte ±H:MM em minutos assinados", () => {
    assert.equal(parseSignedHoursToMinutes("41:15"), 2475);
    assert.equal(parseSignedHoursToMinutes("-2:05"), -125);
    // Sinal precisa valer mesmo com horas zeradas.
    assert.equal(parseSignedHoursToMinutes("-0:55"), -55);
    assert.equal(parseSignedHoursToMinutes("0:00"), 0);
    assert.equal(parseSignedHoursToMinutes("+1:30"), 90);
    assert.throws(() => parseSignedHoursToMinutes("1:5"));
    assert.throws(() => parseSignedHoursToMinutes("1:75"));
    assert.throws(() => parseSignedHoursToMinutes("1h30"));
    assert.throws(() => parseSignedHoursToMinutes(""));
});

test("parseLegacyBankHoursCsv valida soma das parcelas", () => {
    const csv = `${CSV_HEADER}\nFULANO,1:00,0:30,2:00`;
    assert.throws(() => parseLegacyBankHoursCsv(csv), /Soma divergente/);
});

test("parseLegacyBankHoursCsv rejeita granularidade fora de 5 min sem exceção", () => {
    const csv = `${CSV_HEADER}\nFULANO,-1:03,0:00,-1:03`;
    assert.throws(() => parseLegacyBankHoursCsv(csv), /granularidade/);
});

test("parseLegacyBankHoursCsv aceita a exceção auditada de FRED ANDERSON", () => {
    const csv = `${CSV_HEADER}\nFRED ANDERSON,-20:11,0:00,-20:11`;
    const rows = parseLegacyBankHoursCsv(csv);
    assert.equal(rows[0].totalMinutes, -1211);
});

test("parseLegacyBankHoursCsv rejeita nome duplicado", () => {
    const csv = `${CSV_HEADER}\nFULANO,0:00,1:00,1:00\nFULANO,0:00,2:00,2:00`;
    assert.throws(() => parseLegacyBankHoursCsv(csv), /duplicado/);
});

test("CSV versionado bate com os totais auditados da coordenação", async () => {
    const csvPath = path.resolve(process.cwd(), "scripts/data/legacy-bank-hours-2026-07.csv");
    const rows = parseLegacyBankHoursCsv(await readFile(csvPath, "utf8"));
    validateLegacyBankHoursDataset(rows);
    assert.equal(rows.length, LEGACY_BANK_HOURS_EXPECTED_ROW_COUNT);
    assert.equal(
        rows.reduce((sum, row) => sum + row.totalMinutes, 0),
        LEGACY_BANK_HOURS_EXPECTED_NET_TOTAL_MINUTES,
    );
});

function buildRawShift(overrides: Partial<RawBankHoursHistoryShift>): RawBankHoursHistoryShift {
    return {
        occupancyId: "occ-1",
        domain: "regulation",
        doctorId: "doctor-1",
        doctorName: "MARCELLA MARQUES SILVA",
        displayName: null,
        targetCode: "1360",
        targetLabel: "Ramal 1360",
        continuityGroupId: "group-1",
        startedAt: "2026-06-01T10:00:00.000Z",
        boardStartedAt: "2026-06-01T10:00:00.000Z",
        handoffEndedAt: "2026-06-01T22:00:00.000Z",
        actualEndedAt: "2026-06-01T22:00:00.000Z",
        effectiveEndedAt: "2026-06-01T22:00:00.000Z",
        shiftLabel: "D",
        source: "telegram",
        notes: null,
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T22:00:00.000Z",
        createdByEmail: null,
        updatedByEmail: null,
        hasPersistedBankEntry: true,
        occupancyScheduledStartAt: "2026-06-01T10:00:00.000Z",
        occupancyScheduledEndAt: "2026-06-01T22:00:00.000Z",
        bankScheduledStartAt: "2026-06-01T10:00:00.000Z",
        bankScheduledEndAt: "2026-06-01T22:00:00.000Z",
        bankActualStartAt: "2026-06-01T10:00:00.000Z",
        bankActualEndAt: "2026-06-01T22:00:00.000Z",
        arrivalDelayMinutes: 0,
        overtimeMinutes: 0,
        creditedOvertimeMinutes: 0,
        balanceMinutes: -90,
        ruleCode: "TEST_RULE",
        bankHoursExplanation: "teste",
        manualBalanceMinutes: null,
        manualBalanceNotes: null,
        manualBalanceUpdatedAt: null,
        manualBalanceActorEmail: null,
        auditTrail: [],
        ...overrides,
    };
}

function buildLegacyRecord(overrides: Partial<BankHoursLegacyDoctorRecord>): BankHoursLegacyDoctorRecord {
    return {
        doctorId: "doctor-1",
        doctorName: "MARCELLA MARQUES SILVA",
        displayName: null,
        spreadsheetName: "MARCELLA MARQUES",
        preMay2025Minutes: 2475,
        spreadsheetPeriodMinutes: 140,
        totalMinutes: 2615,
        source: "Planilha Banco de Horas 2026 — coordenação, importada em jul/2026",
        notes: null,
        ...overrides,
    };
}

test("modelo compõe saldo legado + apurado sem misturar as parcelas", () => {
    const model = buildBankHoursHistoryModel(
        [buildRawShift({})],
        new Map(),
        new Map([["doctor-1", buildLegacyRecord({})]]),
    );

    const doctor = model.doctors.find((entry) => entry.doctorId === "doctor-1");
    assert.ok(doctor);
    assert.equal(doctor.applicationBalanceMinutes, -90);
    assert.ok(doctor.legacy);
    assert.equal(doctor.legacy.preMay2025Minutes, 2475);
    assert.equal(doctor.legacy.spreadsheetPeriodMinutes, 140);
    // Saldo final = 2475 + 140 - 90 = 2525 (+42h05 do exemplo da migração).
    assert.equal(doctor.balanceMinutes, 2525);
    assert.equal(model.summary.balanceMinutes, 2525);
});

test("plantonista sem legado não ganha parcelas fantasmas", () => {
    const model = buildBankHoursHistoryModel([buildRawShift({})], new Map(), new Map());
    const doctor = model.doctors.find((entry) => entry.doctorId === "doctor-1");
    assert.ok(doctor);
    assert.equal(doctor.legacy, null);
    assert.equal(doctor.applicationBalanceMinutes, doctor.balanceMinutes);
    assert.equal(doctor.balanceMinutes, -90);
});

test("plantonista só com legado (sem plantão na aplicação) aparece no modelo", () => {
    const model = buildBankHoursHistoryModel(
        [buildRawShift({})],
        new Map(),
        new Map([["doctor-2", buildLegacyRecord({
            doctorId: "doctor-2",
            doctorName: "YHOKENN KARLO SANTOS",
            spreadsheetName: "YHOKENN KARLO",
            preMay2025Minutes: -3640,
            spreadsheetPeriodMinutes: 0,
            totalMinutes: -3640,
        })]]),
    );

    const doctor = model.doctors.find((entry) => entry.doctorId === "doctor-2");
    assert.ok(doctor);
    assert.equal(doctor.shiftCount, 0);
    assert.equal(doctor.applicationBalanceMinutes, 0);
    assert.equal(doctor.balanceMinutes, -3640);
    assert.equal(model.summary.balanceMinutes, -90 - 3640);
});

test("acertos do fechamento continuam somados antes do legado", () => {
    const model = buildBankHoursHistoryModel(
        [buildRawShift({})],
        new Map([["doctor-1", [{
            id: "settlement-1",
            monthKey: "2026-06",
            kind: "bonus" as const,
            deltaMinutes: 720,
            operationalDate: null,
            notes: "bônus de teste",
            createdAt: "2026-06-30T00:00:00.000Z",
        }]]]),
        new Map([["doctor-1", buildLegacyRecord({})]]),
    );

    const doctor = model.doctors.find((entry) => entry.doctorId === "doctor-1");
    assert.ok(doctor);
    assert.equal(doctor.applicationBalanceMinutes, -90 + 720);
    assert.equal(doctor.balanceMinutes, -90 + 720 + 2615);
});
