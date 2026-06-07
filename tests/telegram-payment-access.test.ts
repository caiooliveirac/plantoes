import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-for-payment-access";

import {
    ATTEMPT_LIMIT,
    computeNextAttempt,
    generateCodename,
    hashCodename,
    isAttemptLocked,
    normalizeCodename,
} from "@/modules/telegram/payment-access";
import {
    createFolhaToken,
    isValidFolhaToken,
    signFolhaToken,
    verifyFolhaToken,
} from "@/lib/folha-ponto/token";
import {
    parseTelegramPaymentCodenameAdminCommand,
    parseTelegramPaymentListCommand,
    parseTelegramPaymentResetAllCommand,
    parseTelegramPaymentSelfServiceCommand,
    parseTelegramResetCodinomeCommand,
} from "@/modules/telegram/payment-commands";
import { buildDoctorPayrollMessages } from "@/modules/telegram/payment-digest";
import type { ChiefPayableBoardModel, ChiefPayableDoctorRow, PayableShift } from "@/modules/reporting/payable-shifts";

// ---------- codinome ----------

test("normalizeCodename: minúsculas, sem acento, separadores viram hífen", () => {
    assert.equal(normalizeCodename("  Falcão Jade 734 "), "falcao-jade-734");
    assert.equal(normalizeCodename("FALCAO-JADE-734"), "falcao-jade-734");
});

test("hashCodename é determinístico e insensível a caixa/acento", () => {
    assert.equal(hashCodename("Falcão-Jade-734"), hashCodename("falcao-jade-734"));
    assert.notEqual(hashCodename("falcao-jade-734"), hashCodename("falcao-jade-735"));
    assert.match(hashCodename("x"), /^[0-9a-f]{64}$/);
});

test("generateCodename no formato palavra-palavra-número", () => {
    for (let i = 0; i < 20; i++) {
        assert.match(generateCodename(), /^[a-z]+-[a-z]+-\d{3}$/);
    }
});

// ---------- cooldown (lógica pura) ----------

test("computeNextAttempt incrementa na janela e trava no limite", () => {
    const t0 = new Date("2026-06-07T12:00:00.000Z");
    let state = computeNextAttempt(null, t0);
    assert.equal(state.failedCount, 1);
    assert.equal(state.lockedUntil, null);

    for (let i = 2; i < ATTEMPT_LIMIT; i++) {
        state = computeNextAttempt({ failedCount: state.failedCount, windowStartedAt: state.windowStartedAt }, new Date(t0.getTime() + i * 1000));
        assert.equal(state.failedCount, i);
        assert.equal(state.lockedUntil, null);
    }

    state = computeNextAttempt({ failedCount: state.failedCount, windowStartedAt: state.windowStartedAt }, new Date(t0.getTime() + 9000));
    assert.equal(state.failedCount, ATTEMPT_LIMIT);
    assert.ok(state.lockedUntil, "trava ao atingir o limite");
});

test("computeNextAttempt reinicia contagem após a janela expirar", () => {
    const t0 = new Date("2026-06-07T12:00:00.000Z");
    const later = new Date(t0.getTime() + 20 * 60 * 1000); // > janela de 15min
    const state = computeNextAttempt({ failedCount: 4, windowStartedAt: t0 }, later);
    assert.equal(state.failedCount, 1);
    assert.equal(state.lockedUntil, null);
});

test("isAttemptLocked respeita o horário", () => {
    const now = new Date("2026-06-07T12:00:00.000Z");
    assert.equal(isAttemptLocked(new Date(now.getTime() + 1000), now), true);
    assert.equal(isAttemptLocked(new Date(now.getTime() - 1000), now), false);
    assert.equal(isAttemptLocked(null, now), false);
});

// ---------- token da folha de ponto ----------

const FOLHA = { medicoId: "doc-123", ano: 2026, mes: 6 };

test("folha token: sign → verify roundtrip", () => {
    const now = Date.now();
    const token = signFolhaToken({ ...FOLHA, exp: now + 60_000 });
    const payload = verifyFolhaToken(token, now);
    assert.equal(payload?.medicoId, "doc-123");
    assert.equal(payload?.mes, 6);
});

test("folha token: rejeita expirado", () => {
    const now = Date.now();
    const token = signFolhaToken({ ...FOLHA, exp: now - 1 });
    assert.equal(verifyFolhaToken(token, now), null);
});

test("folha token: rejeita assinatura adulterada", () => {
    const token = createFolhaToken(FOLHA);
    const tampered = `${token.split(".")[0]}.${"x".repeat(token.split(".")[1].length)}`;
    assert.equal(verifyFolhaToken(tampered), null);
});

test("isValidFolhaToken exige médico/ano/mês correspondentes", () => {
    const token = createFolhaToken(FOLHA);
    assert.equal(isValidFolhaToken(token, FOLHA), true);
    assert.equal(isValidFolhaToken(token, { ...FOLHA, medicoId: "outro" }), false);
    assert.equal(isValidFolhaToken(token, { ...FOLHA, mes: 7 }), false);
    assert.equal(isValidFolhaToken(undefined, FOLHA), false);
});

// ---------- parsers ----------

test("parseTelegramPaymentCodenameAdminCommand extrai o nome", () => {
    assert.deepEqual(parseTelegramPaymentCodenameAdminCommand("/pagamento codinome João Silva"), { name: "payment_codename", doctorName: "João Silva", rawBody: "João Silva" });
    assert.equal(parseTelegramPaymentCodenameAdminCommand("/pagamento codinome"), null);
    assert.equal(parseTelegramPaymentCodenameAdminCommand("/pagamento maio"), null);
});

test("parseTelegramPaymentSelfServiceCommand: codinome e mês opcional", () => {
    const ref = new Date("2026-06-07T15:00:00.000Z");
    assert.deepEqual(parseTelegramPaymentSelfServiceCommand("/pagamento falcao-jade-734", ref), { name: "payment_self", codename: "falcao-jade-734", monthKey: null });
    assert.deepEqual(parseTelegramPaymentSelfServiceCommand("/pagamento falcao-jade-734 05", ref), { name: "payment_self", codename: "falcao-jade-734", monthKey: "2026-05" });
    assert.deepEqual(parseTelegramPaymentSelfServiceCommand("/pagamento", ref), { name: "payment_self", codename: null, monthKey: null });
});

test("parseTelegramPaymentResetAllCommand: pede confirmação e reconhece CONFIRMO", () => {
    assert.deepEqual(parseTelegramPaymentResetAllCommand("/pagamento resetar-todos"), { name: "payment_reset_all", confirmed: false });
    assert.deepEqual(parseTelegramPaymentResetAllCommand("/pagamento resetar-todos CONFIRMO"), { name: "payment_reset_all", confirmed: true });
    assert.deepEqual(parseTelegramPaymentResetAllCommand("/pagamento resetar-todos confirmo"), { name: "payment_reset_all", confirmed: true });
    assert.equal(parseTelegramPaymentResetAllCommand("/pagamento codinome João"), null);
    assert.equal(parseTelegramPaymentResetAllCommand("/pagamento maio"), null);
    assert.equal(parseTelegramPaymentResetAllCommand("/pagamento"), null);
});

test("parseTelegramResetCodinomeCommand aceita nome ou codinome", () => {
    assert.deepEqual(parseTelegramResetCodinomeCommand("/resetcodinome João Silva"), { name: "reset_codinome", query: "João Silva" });
    assert.deepEqual(parseTelegramResetCodinomeCommand("/resetcodinome tigre-azul-958"), { name: "reset_codinome", query: "tigre-azul-958" });
    assert.equal(parseTelegramResetCodinomeCommand("/resetcodinome"), null);
    assert.equal(parseTelegramResetCodinomeCommand("/pagamento maio"), null);
});

test("parseTelegramPaymentListCommand reconhece só /pagamento listar", () => {
    assert.deepEqual(parseTelegramPaymentListCommand("/pagamento listar"), { name: "payment_list" });
    assert.equal(parseTelegramPaymentListCommand("/pagamento"), null);
    assert.equal(parseTelegramPaymentListCommand("/pagamento listar tudo"), null);
});

// ---------- relatório do médico (com R$ + link) ----------

function makeShift(overrides: Partial<PayableShift>): PayableShift {
    return {
        payableShiftId: "ps", occupancyId: "occ", domain: "regulation", doctorId: "doc-123",
        doctorName: "Acácio", displayName: null, targetCode: "PR03", targetLabel: "PR03", tagCode: "PR03",
        operationalDate: "2026-06-01", shiftLabel: "SD", slotStartedAt: "", slotEndedAt: "",
        startedAt: "", endedAt: null, durationMinutes: 720, paymentStatus: "ready_for_payment",
        auditStatus: "clean", issues: [], source: "telegram", roleLabel: null, paymentUnit: 1, paymentTag: null,
        ...overrides,
    };
}

function makeRow(shifts: PayableShift[]): ChiefPayableDoctorRow {
    return {
        doctorId: "doc-123", doctorName: "Acácio Junio de Almeida", displayName: null,
        paymentStatus: "ready_for_payment", totalSD: 0, totalSN: 0, total: shifts.length,
        totalDue: 2489.74, paymentProfile: "generalist", pendingCount: 0,
        cells: [{ day: "01", shifts }],
    };
}

function makeBoard(): ChiefPayableBoardModel {
    return {
        allDoctorNames: [], monthKey: "2026-06", monthLabel: "Junho 2026", presetMonths: [],
        range: { startIso: "", endIso: "" }, days: [],
        summary: { doctorCount: 1, payableShiftCount: 0, payableUnitCount: 0, readyCount: 0, needsReviewCount: 0, segmentCount: 0, discardedSegmentCount: 0, disabledTargetCount: 0, uncoveredTargetCount: 0 },
        targetOptions: [], doctors: [], payableShifts: [], disabledTargets: [], uncoveredTargets: [], attestationSegments: [],
    };
}

test("buildDoctorPayrollMessages inclui R$ por linha, total e link", () => {
    const row = makeRow([makeShift({})]);
    const url = "https://plantoes.mnrs.com.br/folha-ponto/doc-123/2026/06?t=abc.def";
    const [message] = buildDoctorPayrollMessages(row, makeBoard(), url);
    assert.match(message, /💰 Seu pagamento — Junho 2026/);
    assert.match(message, /01\/06 Seg SD PR03 \(Dia útil\) · R\$\s?1\.244,87/);
    assert.match(message, /Total: R\$\s?2\.489,74/);
    assert.match(message, /📄 Folha de ponto: https:\/\/plantoes/);
});

test("buildDoctorPayrollMessages: sem plantões, mensagem amigável", () => {
    const row = makeRow([]);
    const [message] = buildDoctorPayrollMessages(row, makeBoard(), "https://x/y");
    assert.match(message, /Nenhum plantão registrado/);
});
