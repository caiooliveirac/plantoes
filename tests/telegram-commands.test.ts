import assert from "node:assert/strict";
import test from "node:test";
import { isTelegramDoctorAdminCommandText, parseTelegramDoctorAdminCommand } from "@/modules/telegram/admin-commands";
import { isTelegramAdminOnlyCommand, parseTelegramCommand } from "@/modules/telegram/commands";
import {
    buildDeparturePriorityReply,
    getCurrentDeparturePriorityView,
    isTelegramDeparturePriorityCommandText,
    parseTelegramDeparturePriorityCommand,
} from "@/modules/telegram/departure-priority";
import { isTelegramDepartureReportCommandText, parseTelegramDepartureReportCommand } from "@/modules/telegram/departure-report-commands";
import { buildTelegramDepartureReport, resolveTelegramDepartureReportRequest } from "@/modules/telegram/departure-report";
import { isTelegramBankHoursCommandText, parseTelegramBankHoursCommand } from "@/modules/telegram/bank-hours-commands";
import { parseTelegramPaymentAdminCommand } from "@/modules/telegram/payment-commands";
import { isTelegramShiftReportCommandText, parseTelegramShiftReportCommand } from "@/modules/telegram/shift-report-commands";
import { isTelegramSummaryReportCommandText, parseTelegramSummaryReportCommand } from "@/modules/telegram/summary-report-commands";
import { buildTelegramSummaryReport } from "@/modules/telegram/summary-report";
import { buildGroupCorrectionAnnouncement, pickTelegramReply } from "@/modules/telegram/replies";
import { buildTelegramShiftReport } from "@/modules/telegram/shift-report";
import {
    buildTelegramReviewLogData,
    buildTelegramJustificationFollowUpText,
    hasTelegramOperationalJustification,
    isBatchCancelKeyword,
    isBatchConfirmationKeyword,
    requiresTelegramDepartureAdjustmentJustification,
    resolveLatestClosedShiftRequest,
    resolveTelegramSuccessReplyKind,
    shouldUseTelegramSenderNameFallback,
    shouldLinkTelegramArrivalToContinuitySource,
    shouldDeferPendingNameSelectionToFreshParsing,
    shouldTreatTelegramArrivalAsContinuation,
} from "@/modules/telegram/service";
import type { InterventionBoardRow, RegulationBoardRow } from "@/services/board.service";

function makeInterventionPriorityRow(overrides: Partial<InterventionBoardRow> = {}): InterventionBoardRow {
    return {
        baseId: 1,
        occupancyId: "int-priority-1",
        baseCode: "PM04",
        baseLabel: "PM04",
        doctorId: "doc-int-1",
        doctorName: "Ana Souza",
        displayName: "Ana",
        startedAt: "2026-03-30T10:00:00.000Z",
        boardStartedAt: "2026-03-30T10:00:00.000Z",
        scheduledEndAt: "2026-03-30T22:00:00.000Z",
        shiftLabel: "SD",
        roleLabel: null,
        status: "active",
        liveSource: "operations_v2",
        liveUpdatedAt: null,
        ...overrides,
    };
}

function makeRegulationPriorityRow(overrides: Partial<RegulationBoardRow> = {}): RegulationBoardRow {
    return {
        postId: 1,
        occupancyId: "reg-priority-1",
        postCode: "2035",
        postLabel: "2035",
        defaultRole: "MR",
        doctorId: "doc-reg-1",
        doctorName: "Bruno Lima",
        displayName: "Bruno",
        startedAt: "2026-03-30T10:05:00.000Z",
        boardStartedAt: "2026-03-30T10:05:00.000Z",
        scheduledEndAt: "2026-03-30T22:15:00.000Z",
        shiftLabel: "SD",
        roleLabel: null,
        ramalLabel: "2035",
        status: "active",
        liveSource: "operations_v2",
        liveUpdatedAt: null,
        ...overrides,
    };
}

test("parseTelegramCommand parses corrigir with target, full name and time", () => {
    const parsed = parseTelegramCommand("/corrigir PM04 Marcela Souza 20:00");

    assert.equal(parsed?.name, "corrigir");
    assert.equal(parsed?.sector, "INTERVENTION");
    assert.equal(parsed?.targetCode, "PM04");
    assert.equal(parsed?.doctorName, "Marcela Souza");
    assert.equal(parsed?.time, "20:00");
});

test("buildTelegramReviewLogData tags reviewable operational inputs with context", () => {
    const review = buildTelegramReviewLogData({
        reason: "doctor_not_resolved",
        parsed: {
            sector: "INTERVENTION",
            baseCode: "PM40",
            arrivalTime: "19:20",
            shiftType: "SN",
            roleFunction: null,
            isDeparture: true,
            isContinuation: false,
        },
        doctorQuery: "Leonardo Carteado",
        trainingCandidate: true,
        looksLikeDeparture: true,
        example: "Leonardo Carteado saindo PM40 19:20 porque fui liberado pela chefia",
        candidates: [
            { fullName: "Leonardo Carvalho" },
            { fullName: "Leonardo Cartaxo" },
        ],
    });

    assert.deepEqual(review, {
        reviewRequired: true,
        reviewQueue: "telegram_input_format_review",
        reviewReason: "doctor_not_resolved",
        reviewSummary: "não foi possível identificar o médico com segurança",
        trainingCandidate: true,
        trainingReason: "doctor_not_resolved",
        reviewParsed: {
            sector: "INTERVENTION",
            baseCode: "PM40",
            arrivalTime: "19:20",
            shiftType: "SN",
            roleFunction: null,
            isDeparture: true,
            isContinuation: false,
        },
        reviewDoctorQuery: "Leonardo Carteado",
        reviewCandidates: ["Leonardo Carvalho", "Leonardo Cartaxo"],
        reviewLooksLikeDeparture: true,
        reviewSuggestedFormat: "Leonardo Carteado saindo PM40 19:20 porque fui liberado pela chefia",
    });
});

test("parseTelegramCommand parses retirar with target and time", () => {
    const parsed = parseTelegramCommand("/retirar 2031 19:05");

    assert.equal(parsed?.name, "retirar");
    assert.equal(parsed?.sector, "REGULATION");
    assert.equal(parsed?.targetCode, "2031");
    assert.equal(parsed?.time, "19:05");
    assert.equal(parsed?.isDeparture, false);
});

test("parseTelegramCommand parses saiu alias as departure command", () => {
    const parsed = parseTelegramCommand("/saiu PP20 08:35");

    assert.equal(parsed?.name, "retirar");
    assert.equal(parsed?.sector, "INTERVENTION");
    assert.equal(parsed?.targetCode, "PP20");
    assert.equal(parsed?.time, "08:35");
    assert.equal(parsed?.isDeparture, true);
});

test("parseTelegramCommand parses corrigir with departure wording", () => {
    const parsed = parseTelegramCommand("/corrigir Emmanuelle PP20 saiu 08:35");

    assert.equal(parsed?.name, "corrigir");
    assert.equal(parsed?.sector, "INTERVENTION");
    assert.equal(parsed?.targetCode, "PP20");
    assert.equal(parsed?.doctorName, "Emmanuelle");
    assert.equal(parsed?.time, "08:35");
    assert.equal(parsed?.isDeparture, true);
});

test("parseTelegramCommand parses remover with base alias", () => {
    const parsed = parseTelegramCommand("/remover na 04");

    assert.equal(parsed?.name, "remover");
    assert.equal(parsed?.sector, "INTERVENTION");
    assert.equal(parsed?.targetCode, "PM04");
});

test("parseTelegramCommand parses remover with doctor and shift for historical cleanup", () => {
    const parsed = parseTelegramCommand("/remover Aline 1363 SD");

    assert.equal(parsed?.name, "remover");
    assert.equal(parsed?.sector, "REGULATION");
    assert.equal(parsed?.targetCode, "1363");
    assert.equal(parsed?.doctorName, "Aline");
    assert.equal(parsed?.shiftLabel, "SD");
});

test("parseTelegramCommand parses /desativar and /ativar for intervention bases", () => {
    const deactivate = parseTelegramCommand("/desativar PM40 19:05");

    assert.equal(deactivate?.name, "desativar");
    assert.equal(deactivate?.sector, "INTERVENTION");
    assert.equal(deactivate?.targetCode, "PM40");
    assert.equal(deactivate?.time, "19:05");

    const reactivate = parseTelegramCommand("/ativar pm40");
    assert.equal(reactivate?.name, "ativar");
    assert.equal(reactivate?.sector, "INTERVENTION");
    assert.equal(reactivate?.targetCode, "PM40");
    assert.equal(reactivate?.time, null);
});

test("isTelegramAdminOnlyCommand marks remover as destructive and admin-only", () => {
    assert.equal(isTelegramAdminOnlyCommand("remover"), true);
    assert.equal(isTelegramAdminOnlyCommand("ativar"), true);
    assert.equal(isTelegramAdminOnlyCommand("desativar"), true);
    assert.equal(isTelegramAdminOnlyCommand("corrigir"), false);
    assert.equal(isTelegramAdminOnlyCommand("retirar"), false);
    assert.equal(isTelegramAdminOnlyCommand("ramal"), false);
});

test("shouldUseTelegramSenderNameFallback ignores messages with Telegram mentions", () => {
    assert.equal(shouldUseTelegramSenderNameFallback("@chefe2031"), false);
    assert.equal(shouldUseTelegramSenderNameFallback("2031 SD"), true);
});

test("parseTelegramCommand parses /ramal with optional function", () => {
    const withRole = parseTelegramCommand("/ramal Emily 1363 RMT");

    assert.equal(withRole?.name, "ramal");
    assert.equal(withRole?.sector, "REGULATION");
    assert.equal(withRole?.targetCode, "1363");
    assert.equal(withRole?.doctorName, "Emily");
    assert.equal(withRole?.roleLabel, "RMT");
    assert.equal(withRole?.time, null);

    const blankRole = parseTelegramCommand("/ramal Emily 1363");
    assert.equal(blankRole?.name, "ramal");
    assert.equal(blankRole?.targetCode, "1363");
    assert.equal(blankRole?.doctorName, "Emily");
    assert.equal(blankRole?.roleLabel, null);
});

test("parseTelegramDoctorAdminCommand parses full name, display name and code", () => {
    const parsed = parseTelegramDoctorAdminCommand("/medico cadastrar Ana Beatriz D'Almeida Silva | Ana Beatriz | crm-1");

    assert.equal(parsed?.name, "doctor_create");
    assert.equal(parsed?.fullName, "Ana Beatriz D'Almeida Silva");
    assert.equal(parsed?.displayName, "Ana Beatriz");
    assert.equal(parsed?.externalCode, "crm-1");
});

test("parseTelegramDoctorAdminCommand aceita cadastro com apenas nome completo", () => {
    const parsed = parseTelegramDoctorAdminCommand("/medico cadastrar Monica Aragao");

    assert.equal(parsed?.fullName, "Monica Aragao");
    assert.equal(parsed?.displayName, null);
    assert.equal(parsed?.externalCode, null);
});

test("isTelegramDoctorAdminCommandText reconhece o namespace mesmo quando o comando esta incompleto", () => {
    assert.equal(isTelegramDoctorAdminCommandText("/medico"), true);
    assert.equal(isTelegramDoctorAdminCommandText("/medico cadastrar Ana"), true);
    assert.equal(isTelegramDoctorAdminCommandText("/corrigir PM04 20:00"), false);
});

test("parseTelegramPaymentAdminCommand parses report with date and shift", () => {
    const parsed = parseTelegramPaymentAdminCommand("/pagamento conferir 2026-03-28 SD", new Date("2026-03-28T12:00:00-03:00"));

    assert.deepEqual(parsed, {
        name: "payment_report",
        operationalDate: "2026-03-28",
        shiftLabel: "SD",
        rawBody: "2026-03-28 SD",
    });
});

test("parseTelegramPaymentAdminCommand parses correction with note", () => {
    const parsed = parseTelegramPaymentAdminCommand(
        "/pagamento corrigir PM04 | Ana Souza | 2026-03-28 | SN | cobertura confirmada pela chefia",
        new Date("2026-03-28T12:00:00-03:00"),
    );

    assert.deepEqual(parsed, {
        name: "payment_correct",
        targetCode: "PM04",
        doctorName: "Ana Souza",
        operationalDate: "2026-03-28",
        shiftLabel: "SN",
        note: "cobertura confirmada pela chefia",
        rawBody: "PM04 | Ana Souza | 2026-03-28 | SN | cobertura confirmada pela chefia",
    });
});

test("parseTelegramPaymentAdminCommand rejects date without shift", () => {
    const parsed = parseTelegramPaymentAdminCommand("/pagamento conferir 2026-03-28", new Date("2026-03-28T12:00:00-03:00"));

    assert.equal(parsed, null);
});

test("parseTelegramDepartureReportCommand accepts bare /saidas and explicit date plus shift", () => {
    assert.deepEqual(parseTelegramDepartureReportCommand("/saidas"), {
        name: "departure_report",
        operationalDate: null,
        shiftLabel: null,
        rawBody: "",
    });

    assert.deepEqual(parseTelegramDepartureReportCommand("/saidas ontem SD", new Date("2026-03-29T12:00:00-03:00")), {
        name: "departure_report",
        operationalDate: "2026-03-28",
        shiftLabel: "SD",
        rawBody: "ontem SD",
    });
});

test("parseTelegramDepartureReportCommand rejects unsupported trailing arguments", () => {
    assert.equal(parseTelegramDepartureReportCommand("/saidas ontem"), null);
    assert.equal(parseTelegramDepartureReportCommand("/saidas SD"), null);
    assert.equal(isTelegramDepartureReportCommandText("/saidas qualquer coisa"), true);
});

test("parseTelegramDeparturePriorityCommand reconhece o comando sem argumentos", () => {
    assert.equal(isTelegramDeparturePriorityCommandText("/prioridadesaida"), true);
    assert.deepEqual(parseTelegramDeparturePriorityCommand("/prioridadesaida"), {
        name: "departure_priority",
        rawBody: "",
    });
    assert.equal(parseTelegramDeparturePriorityCommand("/prioridadesaida agora"), null);
});

test("getCurrentDeparturePriorityView ignora MRV, RECIP e quem nao esta mais no quadro", async () => {
    const view = await getCurrentDeparturePriorityView({
        referenceAt: new Date("2026-03-30T15:05:00-03:00"),
        board: {
            generatedAt: "2026-03-30T18:05:00.000Z",
            intervention: [
                makeInterventionPriorityRow(),
                makeInterventionPriorityRow({
                    baseId: 2,
                    occupancyId: null,
                    baseCode: "BR05",
                    baseLabel: "BR05",
                    doctorId: null,
                    doctorName: null,
                    displayName: null,
                    startedAt: null,
                    boardStartedAt: null,
                    scheduledEndAt: null,
                    shiftLabel: null,
                    status: "waiting",
                }),
            ],
            regulation: [
                makeRegulationPriorityRow(),
                makeRegulationPriorityRow({
                    postId: 2,
                    occupancyId: "reg-priority-2032",
                    postCode: "2032",
                    postLabel: "2032",
                    defaultRole: "MRV",
                    doctorId: "doc-mrv",
                    doctorName: "Marina Costa",
                    displayName: "Marina",
                    startedAt: "2026-03-30T09:55:00.000Z",
                    boardStartedAt: "2026-03-30T09:55:00.000Z",
                    roleLabel: null,
                    ramalLabel: "2032",
                }),
                makeRegulationPriorityRow({
                    postId: 3,
                    occupancyId: "reg-priority-recip",
                    postCode: "2036",
                    postLabel: "2036",
                    defaultRole: "MR",
                    doctorId: "doc-recip",
                    doctorName: "Renata Lima",
                    displayName: "Renata",
                    startedAt: "2026-03-30T09:50:00.000Z",
                    boardStartedAt: "2026-03-30T09:50:00.000Z",
                    roleLabel: null,
                    ramalLabel: "2036",
                }),
            ],
        },
        mealBreakSession: { recipRamal: "2036" },
    });

    assert.equal(view.shiftLabel, "SD");
    assert.deepEqual(view.entries.map((entry) => entry.targetCode), ["PM04", "2035"]);
    assert.deepEqual(view.entries.map((entry) => entry.rank), [1, 2]);

    const reply = buildDeparturePriorityReply(view);
    assert.match(reply, /Fora da conta: saídas já declaradas, MRV e RECIP\./);
    assert.match(reply, /1\. Ana Souza \| PM04 \| 07:00/);
    assert.match(reply, /2\. Bruno Lima \| 2035 \| 07:05/);
    assert.doesNotMatch(reply, /Marina Costa/);
    assert.doesNotMatch(reply, /Renata Lima/);
});

test("parseTelegramSummaryReportCommand accepts bare /resumo and optional agora", () => {
    assert.equal(isTelegramSummaryReportCommandText("/resumo"), true);

    assert.deepEqual(parseTelegramSummaryReportCommand("/resumo"), {
        name: "summary_report",
        rawBody: "",
    });

    assert.deepEqual(parseTelegramSummaryReportCommand("/resumo agora"), {
        name: "summary_report",
        rawBody: "agora",
    });

    assert.equal(parseTelegramSummaryReportCommand("/resumo hoje"), null);
});

test("parseTelegramBankHoursCommand accepts doctor, shift and integer minutes", () => {
    assert.equal(isTelegramBankHoursCommandText("/banco Aline SN 0"), true);

    assert.deepEqual(parseTelegramBankHoursCommand("/banco Matheus Cordeiro SN -30"), {
        name: "bank_hours_override",
        doctorName: "Matheus Cordeiro",
        shiftLabel: "SN",
        balanceMinutes: -30,
        rawBody: "Matheus Cordeiro SN -30",
    });

    assert.equal(parseTelegramBankHoursCommand("/banco Aline SN"), null);
});

test("resolveLatestClosedShiftRequest walks back to the latest closed shift of the requested label", () => {
    assert.deepEqual(
        resolveLatestClosedShiftRequest(new Date("2026-03-29T12:00:00-03:00"), "SN"),
        { operationalDate: "2026-03-28", shiftLabel: "SN" },
    );

    assert.deepEqual(
        resolveLatestClosedShiftRequest(new Date("2026-03-29T12:00:00-03:00"), "SD"),
        { operationalDate: "2026-03-28", shiftLabel: "SD" },
    );
});

test("resolveTelegramDepartureReportRequest defaults to the previous shift", () => {
    assert.deepEqual(resolveTelegramDepartureReportRequest({
        operationalDate: null,
        shiftLabel: null,
        reference: new Date("2026-03-29T21:00:00-03:00"),
    }), {
        operationalDate: "2026-03-29",
        shiftLabel: "SD",
    });

    assert.deepEqual(resolveTelegramDepartureReportRequest({
        operationalDate: null,
        shiftLabel: null,
        reference: new Date("2026-03-29T09:00:00-03:00"),
    }), {
        operationalDate: "2026-03-28",
        shiftLabel: "SN",
    });
});

test("buildTelegramDepartureReport lists arrival, departure and bank-hours impact", () => {
    const report = buildTelegramDepartureReport({
        generatedAt: new Date("2026-03-29T00:30:00-03:00").toISOString(),
        operationalDate: new Date("2026-03-28T12:00:00-03:00").toISOString(),
        shiftLabel: "SN",
        startedAt: new Date("2026-03-28T19:00:00-03:00").toISOString(),
        endedAt: new Date("2026-03-29T07:00:00-03:00").toISOString(),
        summary: {
            totalTargets: 3,
            assignedCount: 2,
            readyForPaymentCount: 1,
            needsReviewCount: 1,
            unassignedCount: 1,
        },
        regulation: [
            {
                domain: "regulation",
                targetCode: "2031",
                targetLabel: "2031",
                sortOrder: 1,
                defaultRole: "MR",
                occupancyId: "reg-1",
                doctorId: "doc-1",
                doctorName: "Ana Souza",
                displayName: "Ana Souza",
                startedAt: "2026-03-28T22:00:00.000Z",
                endedAt: "2026-03-29T10:20:00.000Z",
                actualEndedAt: "2026-03-29T10:20:00.000Z",
                scheduledStartAt: "2026-03-28T22:00:00.000Z",
                scheduledEndAt: "2026-03-29T10:15:00.000Z",
                shiftLabel: "SN",
                roleLabel: "MR",
                ramalLabel: "2031",
                source: "telegram",
                candidateCount: 1,
                paymentStatus: "ready_for_payment",
                issues: [],
                arrivalDelayMinutes: 0,
                overtimeMinutes: 5,
                creditedOvertimeMinutes: 0,
                balanceMinutes: 0,
                ruleCode: "ON_TIME_NO_OVERTIME",
                bankHoursExplanation: "Chegou dentro da tolerância.",
            },
        ],
        intervention: [
            {
                domain: "intervention",
                targetCode: "PM04",
                targetLabel: "PM04",
                sortOrder: 1,
                defaultRole: null,
                occupancyId: "int-1",
                doctorId: "doc-2",
                doctorName: "Bruno Lima",
                displayName: "Bruno Lima",
                startedAt: "2026-03-28T22:10:00.000Z",
                endedAt: "2026-03-29T10:45:00.000Z",
                actualEndedAt: "2026-03-29T10:45:00.000Z",
                scheduledStartAt: "2026-03-28T22:00:00.000Z",
                scheduledEndAt: "2026-03-29T10:00:00.000Z",
                shiftLabel: "SN",
                roleLabel: null,
                ramalLabel: null,
                source: "telegram",
                candidateCount: 1,
                paymentStatus: "needs_review",
                issues: ["saída ajustada depois da rendição"],
                arrivalDelayMinutes: 10,
                overtimeMinutes: 45,
                creditedOvertimeMinutes: 45,
                balanceMinutes: 35,
                ruleCode: "LATE_SIMPLE_OVERTIME",
                bankHoursExplanation: "Chegou com atraso e hora simples.",
            },
            {
                domain: "intervention",
                targetCode: "IT30",
                targetLabel: "IT30",
                sortOrder: 2,
                defaultRole: null,
                occupancyId: null,
                doctorId: null,
                doctorName: null,
                displayName: null,
                startedAt: null,
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: null,
                scheduledEndAt: null,
                shiftLabel: null,
                roleLabel: null,
                ramalLabel: null,
                source: null,
                candidateCount: 0,
                paymentStatus: "needs_review",
                issues: ["sem ocupação"],
                arrivalDelayMinutes: null,
                overtimeMinutes: null,
                creditedOvertimeMinutes: null,
                balanceMinutes: null,
                ruleCode: null,
                bankHoursExplanation: null,
            },
        ],
    });

    assert.match(report, /Saídas 28\/03\/2026 SN/);
    assert.match(report, /Formato: alvo \| chegada real \| nome \| saída \| banco/);
    assert.match(report, /Alocados 2\/3 \| revisar 1 \| vazios 1/);
    assert.match(report, /✅ 2031 \| 19:00 \| Ana Souza \| 07:20 \| BH \+0h00/);
    assert.match(report, /⚠️ PM04 \| 19:10 \| Bruno Lima \| 07:45 \| BH \+0h35/);
    assert.match(report, /revisar: saída ajustada depois da rendição/);
    assert.match(report, /Vazios: IT30/);
});

test("buildTelegramDepartureReport shows CONTINUA for carried P coverage and preserves a late actual departure", () => {
    const report = buildTelegramDepartureReport({
        generatedAt: new Date("2026-03-29T00:30:00-03:00").toISOString(),
        operationalDate: new Date("2026-03-28T12:00:00-03:00").toISOString(),
        shiftLabel: "SD",
        startedAt: new Date("2026-03-28T07:00:00-03:00").toISOString(),
        endedAt: new Date("2026-03-28T19:00:00-03:00").toISOString(),
        summary: {
            totalTargets: 2,
            assignedCount: 2,
            readyForPaymentCount: 1,
            needsReviewCount: 1,
            unassignedCount: 0,
        },
        regulation: [
            {
                domain: "regulation",
                targetCode: "2031",
                targetLabel: "2031",
                sortOrder: 1,
                defaultRole: "MR",
                occupancyId: "reg-1",
                doctorId: "doc-1",
                doctorName: "João Perrone",
                displayName: "João Perrone",
                startedAt: "2026-03-28T10:01:54.000Z",
                endedAt: "2026-03-28T22:00:00.000Z",
                actualEndedAt: "2026-03-28T22:00:00.000Z",
                scheduledStartAt: "2026-03-28T10:00:00.000Z",
                scheduledEndAt: "2026-03-28T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: "MR",
                ramalLabel: "2031",
                source: "telegram",
                candidateCount: 1,
                paymentStatus: "needs_review",
                issues: ["Plantao sem saida consolidada"],
                arrivalDelayMinutes: 1,
                overtimeMinutes: 0,
                creditedOvertimeMinutes: 0,
                balanceMinutes: -1,
                ruleCode: "LATE_NO_OVERTIME",
                bankHoursExplanation: "ok",
                sourceShiftLabel: "P",
                sourceStartedAt: "2026-03-28T10:01:54.000Z",
                sourceBoardStartedAt: "2026-03-28T22:00:00.000Z",
                sourceEndedAt: null,
                sourceActualEndedAt: null,
                continuesBeyondShift: true,
            },
        ],
        intervention: [
            {
                domain: "intervention",
                targetCode: "CZ50",
                targetLabel: "CZ50",
                sortOrder: 50,
                defaultRole: null,
                occupancyId: "int-1",
                doctorId: "doc-2",
                doctorName: "Laisse Melo",
                displayName: "Laisse Melo",
                startedAt: "2026-03-28T10:00:00.000Z",
                endedAt: "2026-03-28T22:00:00.000Z",
                actualEndedAt: "2026-03-28T22:00:00.000Z",
                scheduledStartAt: "2026-03-28T10:00:00.000Z",
                scheduledEndAt: "2026-03-28T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: null,
                ramalLabel: null,
                source: "telegram",
                candidateCount: 1,
                paymentStatus: "ready_for_payment",
                issues: [],
                arrivalDelayMinutes: 0,
                overtimeMinutes: 0,
                creditedOvertimeMinutes: 0,
                balanceMinutes: 0,
                ruleCode: "ON_TIME_NO_OVERTIME",
                bankHoursExplanation: "ok",
                sourceShiftLabel: "SD",
                sourceStartedAt: "2026-03-28T10:00:00.000Z",
                sourceBoardStartedAt: "2026-03-28T10:00:00.000Z",
                sourceEndedAt: "2026-03-28T22:12:53.000Z",
                sourceActualEndedAt: "2026-03-28T22:12:53.000Z",
                continuesBeyondShift: false,
            },
        ],
    });

    assert.match(report, /Alocados 2\/2 \| revisar 0 \| vazios 0/);
    assert.match(report, /🔁 2031 \| 07:01 \| João Perrone \| 19:00 \| CONTINUA/);
    assert.doesNotMatch(report, /2031.*Plantão sem saída consolidada/);
    assert.match(report, /✅ CZ50 \| 07:00 \| Laisse Melo \| 19:12 \| BH \+0h00/);
});

test("buildTelegramDepartureReport uses carried P bank-hours once the final exit is known", () => {
    const report = buildTelegramDepartureReport({
        generatedAt: new Date("2026-03-29T12:00:00-03:00").toISOString(),
        operationalDate: new Date("2026-03-28T12:00:00-03:00").toISOString(),
        shiftLabel: "SN",
        startedAt: new Date("2026-03-28T19:00:00-03:00").toISOString(),
        endedAt: new Date("2026-03-29T07:00:00-03:00").toISOString(),
        summary: {
            totalTargets: 1,
            assignedCount: 1,
            readyForPaymentCount: 1,
            needsReviewCount: 0,
            unassignedCount: 0,
        },
        regulation: [],
        intervention: [
            {
                domain: "intervention",
                targetCode: "CN10",
                targetLabel: "CN10",
                sortOrder: 10,
                defaultRole: null,
                occupancyId: "int-1",
                doctorId: "doc-1",
                doctorName: "João Perrone",
                displayName: "João Perrone",
                startedAt: "2026-03-28T22:00:00.000Z",
                endedAt: "2026-03-29T10:00:00.000Z",
                actualEndedAt: "2026-03-29T10:00:00.000Z",
                scheduledStartAt: "2026-03-28T22:00:00.000Z",
                scheduledEndAt: "2026-03-29T10:00:00.000Z",
                shiftLabel: "SN",
                roleLabel: null,
                ramalLabel: null,
                source: "telegram",
                candidateCount: 1,
                paymentStatus: "ready_for_payment",
                issues: [],
                arrivalDelayMinutes: 0,
                overtimeMinutes: 0,
                creditedOvertimeMinutes: 0,
                balanceMinutes: 0,
                ruleCode: "ON_TIME_NO_OVERTIME",
                bankHoursExplanation: "slot fechado sem impacto",
                sourceShiftLabel: "P",
                sourceStartedAt: "2026-03-28T10:01:54.000Z",
                sourceBoardStartedAt: "2026-03-28T22:00:00.000Z",
                sourceEndedAt: "2026-03-29T10:20:00.000Z",
                sourceActualEndedAt: "2026-03-29T10:20:00.000Z",
                sourceScheduledStartAt: "2026-03-28T10:00:00.000Z",
                sourceScheduledEndAt: "2026-03-29T10:00:00.000Z",
                sourceArrivalDelayMinutes: 0,
                sourceOvertimeMinutes: 20,
                sourceCreditedOvertimeMinutes: 40,
                sourceBalanceMinutes: 40,
                sourceRuleCode: "ON_TIME_DOUBLE_OVERTIME",
                sourceBankHoursExplanation: "Chegou dentro da tolerancia e a saida excedeu a janela carregada.",
                continuesBeyondShift: false,
            },
        ],
    });

    assert.match(report, /✅ CN10 \| 07:01 \| João Perrone \| 07:20 \| BH \+0h40 \(extra \+0h20 x2\)/);
});

test("buildTelegramDepartureReport uses source bank-hours for a single-slot SN when the real exit exceeded the slot boundary", () => {
    const report = buildTelegramDepartureReport({
        generatedAt: new Date("2026-03-29T12:00:00-03:00").toISOString(),
        operationalDate: new Date("2026-03-28T12:00:00-03:00").toISOString(),
        shiftLabel: "SN",
        startedAt: new Date("2026-03-28T19:00:00-03:00").toISOString(),
        endedAt: new Date("2026-03-29T07:00:00-03:00").toISOString(),
        summary: {
            totalTargets: 1,
            assignedCount: 1,
            readyForPaymentCount: 1,
            needsReviewCount: 0,
            unassignedCount: 0,
        },
        regulation: [],
        intervention: [
            {
                domain: "intervention",
                targetCode: "PM40",
                targetLabel: "PM40",
                sortOrder: 40,
                defaultRole: null,
                occupancyId: "int-2",
                doctorId: "doc-2",
                doctorName: "Victor Mangabeira",
                displayName: "Victor Mangabeira",
                startedAt: "2026-03-28T22:00:00.000Z",
                endedAt: "2026-03-29T10:00:00.000Z",
                actualEndedAt: "2026-03-29T10:00:00.000Z",
                scheduledStartAt: "2026-03-28T22:00:00.000Z",
                scheduledEndAt: "2026-03-29T10:00:00.000Z",
                shiftLabel: "SN",
                roleLabel: null,
                ramalLabel: null,
                source: "telegram",
                candidateCount: 1,
                paymentStatus: "ready_for_payment",
                issues: [],
                arrivalDelayMinutes: 0,
                overtimeMinutes: 0,
                creditedOvertimeMinutes: 0,
                balanceMinutes: 0,
                ruleCode: "ON_TIME_NO_OVERTIME",
                bankHoursExplanation: "slot fechado sem impacto",
                sourceShiftLabel: "SN",
                sourceStartedAt: "2026-03-28T21:57:56.000Z",
                sourceBoardStartedAt: "2026-03-28T21:57:56.000Z",
                sourceEndedAt: "2026-03-29T10:27:29.000Z",
                sourceActualEndedAt: "2026-03-29T10:27:29.000Z",
                sourceScheduledStartAt: "2026-03-28T22:00:00.000Z",
                sourceScheduledEndAt: "2026-03-29T10:00:00.000Z",
                sourceArrivalDelayMinutes: 0,
                sourceOvertimeMinutes: 27,
                sourceCreditedOvertimeMinutes: 54,
                sourceBalanceMinutes: 54,
                sourceRuleCode: "ON_TIME_DOUBLE_OVERTIME",
                sourceBankHoursExplanation: "Chegou com ate 15 min de atraso e o excedente acima de 15 min entrou em dobro.",
                continuesBeyondShift: false,
            },
        ],
    });

    assert.match(report, /✅ PM40 \| 18:57 \| Victor Mangabeira \| 07:27 \| BH \+0h54 \(extra \+0h27 x2\)/);
});

test("parseTelegramShiftReportCommand accepts bare /plantao and optional agora", () => {
    assert.deepEqual(parseTelegramShiftReportCommand("/plantao"), {
        name: "shift_report",
        rawBody: "",
    });

    assert.deepEqual(parseTelegramShiftReportCommand("/plantao agora"), {
        name: "shift_report",
        rawBody: "agora",
    });
});

test("parseTelegramShiftReportCommand rejects unsupported trailing arguments", () => {
    assert.equal(parseTelegramShiftReportCommand("/plantao 2026-03-28 SN"), null);
    assert.equal(isTelegramShiftReportCommandText("/plantao qualquer coisa"), true);
});

test("buildTelegramShiftReport separates confirmed rows from previous-shift carryover and missing targets", () => {
    const report = buildTelegramShiftReport({
        reference: new Date("2026-03-28T19:20:00-03:00"),
        board: {
            intervention: [
                {
                    baseId: 1,
                    occupancyId: "int-1",
                    baseCode: "PM04",
                    baseLabel: "PM04",
                    doctorId: "doc-1",
                    doctorName: "Ana Souza",
                    displayName: "Ana",
                    startedAt: "2026-03-28T22:00:00.000Z",
                    boardStartedAt: "2026-03-28T22:00:00.000Z",
                    scheduledEndAt: "2026-03-29T10:00:00.000Z",
                    shiftLabel: "SN",
                    roleLabel: null,
                    status: "active",
                    liveSource: "operations_v2",
                    liveUpdatedAt: null,
                },
                {
                    baseId: 2,
                    occupancyId: "int-2",
                    baseCode: "BR05",
                    baseLabel: "BR05",
                    doctorId: "doc-2",
                    doctorName: "Joao Santana",
                    displayName: "Joao",
                    startedAt: "2026-03-28T10:18:00.000Z",
                    boardStartedAt: "2026-03-28T10:18:00.000Z",
                    scheduledEndAt: "2026-03-28T22:00:00.000Z",
                    shiftLabel: "SD",
                    roleLabel: null,
                    status: "active",
                    liveSource: "operations_v2",
                    liveUpdatedAt: null,
                },
                {
                    baseId: 3,
                    occupancyId: null,
                    baseCode: "IT30",
                    baseLabel: "IT30",
                    doctorId: null,
                    doctorName: null,
                    displayName: null,
                    startedAt: null,
                    boardStartedAt: null,
                    scheduledEndAt: null,
                    shiftLabel: null,
                    roleLabel: null,
                    status: "waiting",
                    liveSource: "none",
                    liveUpdatedAt: null,
                },
            ],
            regulation: [
                {
                    postId: 1,
                    occupancyId: "reg-1",
                    postCode: "2031",
                    postLabel: "2031",
                    defaultRole: "MR",
                    doctorId: "doc-3",
                    doctorName: "Bruno Lima",
                    displayName: "Bruno",
                    startedAt: "2026-03-28T22:02:00.000Z",
                    boardStartedAt: "2026-03-28T22:02:00.000Z",
                    scheduledEndAt: "2026-03-29T10:15:00.000Z",
                    shiftLabel: "SN",
                    roleLabel: "MR",
                    ramalLabel: "2031",
                    status: "active",
                    liveSource: "operations_v2",
                    liveUpdatedAt: null,
                },
                {
                    postId: 2,
                    occupancyId: "reg-2",
                    postCode: "2032",
                    postLabel: "2032",
                    defaultRole: "MR",
                    doctorId: "doc-4",
                    doctorName: "Marina Costa",
                    displayName: "Marina",
                    startedAt: "2026-03-28T10:05:00.000Z",
                    boardStartedAt: "2026-03-28T10:05:00.000Z",
                    scheduledEndAt: "2026-03-28T22:15:00.000Z",
                    shiftLabel: "SD",
                    roleLabel: "MR",
                    ramalLabel: "2032",
                    status: "active",
                    liveSource: "operations_v2",
                    liveUpdatedAt: null,
                },
                {
                    postId: 3,
                    occupancyId: null,
                    postCode: "2033",
                    postLabel: "2033",
                    defaultRole: "MR",
                    doctorId: null,
                    doctorName: null,
                    displayName: null,
                    startedAt: null,
                    boardStartedAt: null,
                    scheduledEndAt: null,
                    shiftLabel: null,
                    roleLabel: null,
                    ramalLabel: "2033",
                    status: "waiting",
                    liveSource: "none",
                    liveUpdatedAt: null,
                },
            ],
        },
    });

    assert.match(report, /Relato do plantão SN/);
    assert.match(report, /✅ PM04 - Ana Souza \| chegada 19:00 \| SN/);
    assert.match(report, /🟡 BR05 - Joao Santana \| SD desde 07:18|🟡 BR05 - Joao Santana \| SD desde 07:18/);
    assert.match(report, /ainda no quadro, mas não confirmado para SN/);
    assert.match(report, /🔴 IT30/);
    assert.match(report, /✅ 2031 - Bruno Lima \| chegada 19:02 \| SN/);
    assert.match(report, /🟡 2032 - Marina Costa/);
    assert.match(report, /🔴 2033/);
});

test("buildTelegramShiftReport reports disabled intervention bases outside the pending bucket", () => {
    const report = buildTelegramShiftReport({
        reference: new Date("2026-03-28T19:20:00-03:00"),
        board: {
            intervention: [
                {
                    baseId: 1,
                    occupancyId: "int-1",
                    baseCode: "PM04",
                    baseLabel: "PM04",
                    doctorId: "doc-1",
                    doctorName: "Ana Souza",
                    displayName: "Ana",
                    startedAt: "2026-03-28T22:00:00.000Z",
                    boardStartedAt: "2026-03-28T22:00:00.000Z",
                    scheduledEndAt: "2026-03-29T10:00:00.000Z",
                    shiftLabel: "SN",
                    roleLabel: null,
                    status: "active",
                    liveSource: "operations_v2",
                    liveUpdatedAt: null,
                },
                {
                    baseId: 2,
                    occupancyId: null,
                    baseCode: "IT30",
                    baseLabel: "IT30",
                    doctorId: null,
                    doctorName: null,
                    displayName: null,
                    startedAt: null,
                    boardStartedAt: null,
                    scheduledEndAt: null,
                    shiftLabel: null,
                    roleLabel: null,
                    status: "disabled",
                    disabledAt: "2026-03-28T21:30:00.000Z",
                    disabledReason: "USA recolhida",
                    liveSource: "none",
                    liveUpdatedAt: null,
                },
            ],
            regulation: [],
        },
    });

    assert.match(report, /Intervenção confirmada 1\/1/);
    assert.match(report, /⚫ IT30 - desativada às 18:30 \| USA recolhida/);
    assert.doesNotMatch(report, /Intervenção sem aviso.*IT30/s);
});

test("buildTelegramDepartureReport lists disabled bases separately from empty targets", () => {
    const report = buildTelegramDepartureReport({
        generatedAt: "2026-03-28T23:00:00.000Z",
        operationalDate: "2026-03-28T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-03-28T10:00:00.000Z",
        endedAt: "2026-03-28T22:00:00.000Z",
        summary: {
            totalTargets: 0,
            assignedCount: 0,
            readyForPaymentCount: 0,
            needsReviewCount: 0,
            unassignedCount: 0,
            disabledCount: 1,
        },
        regulation: [],
        intervention: [
            {
                domain: "intervention",
                targetCode: "PP20",
                targetLabel: "PP20",
                sortOrder: 20,
                defaultRole: null,
                disabledAt: "2026-03-28T08:30:00.000Z",
                disabledReason: "USA recolhida",
                disabledDuringShift: true,
                disabledEntireShift: true,
                occupancyId: null,
                doctorId: null,
                doctorName: null,
                displayName: null,
                startedAt: null,
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: null,
                scheduledEndAt: null,
                shiftLabel: "SD",
                roleLabel: null,
                ramalLabel: null,
                source: null,
                candidateCount: 0,
                paymentStatus: "ready_for_payment",
                issues: ["Base desativada para este turno"],
                arrivalDelayMinutes: null,
                overtimeMinutes: null,
                creditedOvertimeMinutes: null,
                balanceMinutes: null,
                ruleCode: null,
                bankHoursExplanation: null,
                continuesBeyondShift: false,
            },
        ],
    });

    assert.match(report, /desativadas 1/);
    assert.match(report, /Desativadas:/);
    assert.match(report, /⚫ PP20 \| 05:30 \| base desativada para o turno \| USA recolhida/);
    assert.doesNotMatch(report, /Vazios: PP20/);
});

test("buildTelegramSummaryReport returns a copy-friendly day summary with exits first and regulation meal-break columns", () => {
    const report = buildTelegramSummaryReport({
        reference: new Date("2026-03-29T10:20:00-03:00"),
        data: {
            departureBoard: {
                generatedAt: "2026-03-29T12:00:00.000Z",
                operationalDate: "2026-03-28T12:00:00.000Z",
                shiftLabel: "SN",
                startedAt: "2026-03-28T22:00:00.000Z",
                endedAt: "2026-03-29T10:00:00.000Z",
                summary: {
                    totalTargets: 2,
                    assignedCount: 2,
                    readyForPaymentCount: 2,
                    needsReviewCount: 0,
                    unassignedCount: 0,
                },
                intervention: [
                    {
                        domain: "intervention",
                        targetCode: "PM04",
                        targetLabel: "PM04",
                        sortOrder: 4,
                        defaultRole: null,
                        occupancyId: "int-exit-1",
                        doctorId: "doc-int-1",
                        doctorName: "Ana Beatriz Souza",
                        displayName: "Ana Souza",
                        startedAt: "2026-03-28T22:00:00.000Z",
                        endedAt: "2026-03-29T10:00:00.000Z",
                        actualEndedAt: "2026-03-29T10:05:00.000Z",
                        scheduledStartAt: "2026-03-28T22:00:00.000Z",
                        scheduledEndAt: "2026-03-29T10:00:00.000Z",
                        shiftLabel: "SN",
                        roleLabel: null,
                        ramalLabel: null,
                        source: "telegram",
                        candidateCount: 1,
                        paymentStatus: "ready_for_payment",
                        issues: [],
                        arrivalDelayMinutes: 0,
                        overtimeMinutes: 5,
                        creditedOvertimeMinutes: 10,
                        balanceMinutes: 10,
                        ruleCode: "ON_TIME_DOUBLE_OVERTIME",
                        bankHoursExplanation: "ok",
                        continuesBeyondShift: false,
                    },
                ],
                regulation: [
                    {
                        domain: "regulation",
                        targetCode: "2032",
                        targetLabel: "2032",
                        sortOrder: 32,
                        defaultRole: "MR",
                        occupancyId: "reg-exit-1",
                        doctorId: "doc-reg-1",
                        doctorName: "Marina Costa Lima",
                        displayName: "Marina Costa",
                        startedAt: "2026-03-28T22:00:00.000Z",
                        endedAt: "2026-03-29T10:00:00.000Z",
                        actualEndedAt: "2026-03-29T10:15:00.000Z",
                        scheduledStartAt: "2026-03-28T22:00:00.000Z",
                        scheduledEndAt: "2026-03-29T10:15:00.000Z",
                        shiftLabel: "SN",
                        roleLabel: "MRV",
                        ramalLabel: "2032",
                        source: "telegram",
                        candidateCount: 1,
                        paymentStatus: "ready_for_payment",
                        issues: [],
                        arrivalDelayMinutes: 0,
                        overtimeMinutes: 15,
                        creditedOvertimeMinutes: 30,
                        balanceMinutes: 30,
                        ruleCode: "ON_TIME_DOUBLE_OVERTIME",
                        bankHoursExplanation: "ok",
                        continuesBeyondShift: false,
                    },
                ],
            },
            currentBoard: {
                intervention: [
                    {
                        baseId: 4,
                        occupancyId: "int-current-1",
                        baseCode: "PM04",
                        baseLabel: "PM04",
                        doctorId: "doc-int-2",
                        doctorName: "Bruno Lima Ferreira",
                        displayName: "Bruno Lima",
                        startedAt: "2026-03-29T10:00:00.000Z",
                        boardStartedAt: "2026-03-29T10:00:00.000Z",
                        scheduledEndAt: "2026-03-29T22:00:00.000Z",
                        shiftLabel: "SD",
                        roleLabel: null,
                        status: "active",
                        liveSource: "operations_v2",
                        liveUpdatedAt: null,
                    },
                ],
                regulation: [
                    {
                        postId: 32,
                        occupancyId: "reg-current-1",
                        postCode: "2032",
                        postLabel: "2032",
                        defaultRole: "MR",
                        doctorId: "doc-reg-2",
                        doctorName: "Carlos Eduardo Melo",
                        displayName: "Carlos Melo",
                        startedAt: "2026-03-29T10:03:00.000Z",
                        boardStartedAt: "2026-03-29T10:03:00.000Z",
                        scheduledEndAt: "2026-03-29T22:15:00.000Z",
                        shiftLabel: "SD",
                        roleLabel: "MRV",
                        ramalLabel: "2032",
                        status: "active",
                        liveSource: "operations_v2",
                        liveUpdatedAt: null,
                    },
                ],
            },
            mealBreakSession: {
                kind: "telegram_meal_break_session",
                version: 1,
                mode: "day",
                operationalDate: "2026-03-29",
                stage: "completed",
                trigger: "manual",
                roster: [],
                chiefRamal: "2031",
                recipRamal: null,
                mrvRamals: ["2032", "2151"],
                mrvLunch1230Ramal: null,
                lunchCapacities: { "11:30": 1, "12:30": 0, "13:30": 0 },
                lunchAssignments: { "2032": "11:30" },
                restAssignments: { "2032": "18:00" },
                restChoiceCapacities: { "15:30": 0, "16:30": 0 },
                lunchQueue: [],
                restQueue: [],
                nightWorkCapacities: { "23:00": 0, "03:00": 0 },
                nightWorkAssignments: {},
                dinnerAssignments: {},
                dinnerDurationAssignments: {},
                dinnerChoiceCapacities: { "20:30": 0, "21:00": 0, "21:30": 0 },
                nightWorkQueue: [],
                dinnerQueue: [],
                createdAt: "2026-03-29T12:00:00.000Z",
                updatedAt: "2026-03-29T12:00:00.000Z",
                events: [],
            },
        },
    });

    assert.match(report, /SAIDAS 28\/03\/2026 SN/);
    assert.match(report, /INTERVENCAO\nbase\|nome\|saida\nPM04\|Ana Souza\|07:05/);
    assert.match(report, /REGULACAO\nramal\|nome\|saida\n2032\|Marina Lima\|07:15/);
    assert.match(report, /CHEGADAS SD/);
    assert.match(report, /INTERVENCAO\nbase\|nome\|chegada\nPM04\|Bruno Ferreira\|07:00/);
    assert.match(report, /REGULACAO\nramal\|nome\|chegada\|almoco\|descanso\n2032\|Carlos Melo\|07:03\|11:30\|18:00/);
});

test("buildTelegramSummaryReport switches regulation columns to jantar and trabalho on SN", () => {
    const report = buildTelegramSummaryReport({
        reference: new Date("2026-03-29T20:20:00-03:00"),
        data: {
            departureBoard: {
                generatedAt: "2026-03-29T23:00:00.000Z",
                operationalDate: "2026-03-29T12:00:00.000Z",
                shiftLabel: "SD",
                startedAt: "2026-03-29T10:00:00.000Z",
                endedAt: "2026-03-29T22:00:00.000Z",
                summary: {
                    totalTargets: 0,
                    assignedCount: 0,
                    readyForPaymentCount: 0,
                    needsReviewCount: 0,
                    unassignedCount: 0,
                },
                intervention: [],
                regulation: [],
            },
            currentBoard: {
                intervention: [],
                regulation: [
                    {
                        postId: 54,
                        occupancyId: "reg-night-1",
                        postCode: "2154",
                        postLabel: "2154",
                        defaultRole: "MR",
                        doctorId: "doc-night-1",
                        doctorName: "Matheus Henrique Quezado Cordeiro",
                        displayName: "Matheus Quezado",
                        startedAt: "2026-03-29T22:25:14.000Z",
                        boardStartedAt: "2026-03-29T22:25:14.000Z",
                        scheduledEndAt: "2026-03-30T10:15:00.000Z",
                        shiftLabel: "SN",
                        roleLabel: "MR",
                        ramalLabel: "2154",
                        status: "active",
                        liveSource: "operations_v2",
                        liveUpdatedAt: null,
                    },
                ],
            },
            mealBreakSession: {
                kind: "telegram_meal_break_session",
                version: 1,
                mode: "night",
                operationalDate: "2026-03-29",
                stage: "completed",
                trigger: "manual",
                roster: [],
                chiefRamal: "2031",
                recipRamal: null,
                mrvRamals: ["2032", "2151"],
                mrvLunch1230Ramal: null,
                lunchCapacities: { "11:30": 0, "12:30": 0, "13:30": 0 },
                lunchAssignments: {},
                restAssignments: {},
                restChoiceCapacities: { "15:30": 0, "16:30": 0 },
                lunchQueue: [],
                restQueue: [],
                nightWorkCapacities: { "23:00": 1, "03:00": 0 },
                nightWorkAssignments: { "2154": "23:00" },
                dinnerAssignments: { "2154": "20:30" },
                dinnerDurationAssignments: { "2154": "half_hour" },
                dinnerChoiceCapacities: { "20:30": 1, "21:00": 0, "21:30": 0 },
                nightWorkQueue: [],
                dinnerQueue: [],
                createdAt: "2026-03-29T23:00:00.000Z",
                updatedAt: "2026-03-29T23:00:00.000Z",
                events: [],
            },
        },
    });

    assert.match(report, /CHEGADAS SN/);
    assert.match(report, /ramal\|nome\|chegada\|jantar\|trabalho/);
    assert.match(report, /2154\|Matheus Cordeiro\|19:25\|20:30\|23:00/);
});

test("pickTelegramReply supports polite command denial", () => {
    const reply = pickTelegramReply("command_forbidden", 7, {});

    assert.match(reply, /chef/i);
});

test("pickTelegramReply supports casual smalltalk without sounding like an error", () => {
    const reply = pickTelegramReply("casual_smalltalk", 11, {});

    assert.ok(reply.length > 0);
    assert.doesNotMatch(reply, /não consegui|não entendi|erro/i);
    assert.match(reply, /^💬/u);
});

test("pickTelegramReply uses dedicated wording for explicit P arrival", () => {
    const reply = pickTelegramReply("arrival_p_recorded", 13, {
        name: "Luiza de Sa",
        target: "CB02",
        time: "07:00",
    });

    assert.match(reply, /^🔵🔁/u);
    assert.match(reply, /chegada em P|entrada em P|tudo certo com o P|P registrado/i);
    assert.match(reply, /próximo|seguinte/i);
});

test("pickTelegramReply describes continuation without resetting arrival", () => {
    const reply = pickTelegramReply("continuation_recorded", 17, {
        name: "Taiane Pinto Menezes",
        target: "BR05",
        time: "07:12",
    });

    assert.match(reply, /continua|continuidade/i);
    assert.match(reply, /já estava|preservei|desde 07:12|mesmo plantão/i);
    assert.match(reply, /^🔵🔁/u);
});

test("resolveTelegramSuccessReplyKind separates arrival, P arrival and continuation", () => {
    assert.equal(resolveTelegramSuccessReplyKind({
        parsed: {
            sector: "INTERVENTION",
            baseCode: "CB02",
            arrivalTime: "07:00",
            shiftType: "P",
            roleFunction: null,
            isDeparture: false,
            isContinuation: false,
        },
    }), "arrival_p_recorded");

    assert.equal(resolveTelegramSuccessReplyKind({
        parsed: {
            sector: "INTERVENTION",
            baseCode: "CB02",
            arrivalTime: "07:00",
            shiftType: "P",
            roleFunction: null,
            isDeparture: false,
            isContinuation: true,
        },
        forceContinuation: true,
    }), "continuation_recorded");

    assert.equal(resolveTelegramSuccessReplyKind({
        parsed: {
            sector: "REGULATION",
            baseCode: "2031",
            arrivalTime: "07:00",
            shiftType: "SD",
            roleFunction: null,
            isDeparture: false,
            isContinuation: false,
        },
    }), "arrival_recorded");
});

test("shouldTreatTelegramArrivalAsContinuation infers rollover for intervention and explicit SD→SN regulation cross-shift", () => {
    assert.equal(
        shouldTreatTelegramArrivalAsContinuation({
            sector: "REGULATION",
            isDeparture: false,
            isContinuation: false,
            incomingShiftLabel: "P",
            activeShiftLabel: null,
        }),
        false,
    );

    assert.equal(
        shouldTreatTelegramArrivalAsContinuation({
            sector: "REGULATION",
            isDeparture: false,
            isContinuation: false,
            incomingShiftLabel: "P",
            activeShiftLabel: "SD",
        }),
        true,
    );

    assert.equal(
        shouldTreatTelegramArrivalAsContinuation({
            sector: "REGULATION",
            isDeparture: false,
            isContinuation: false,
            incomingShiftLabel: "SN",
            activeShiftLabel: "P",
        }),
        false,
    );

    assert.equal(
        shouldTreatTelegramArrivalAsContinuation({
            sector: "REGULATION",
            isDeparture: false,
            isContinuation: false,
            incomingShiftLabel: "SN",
            activeShiftLabel: "SD",
        }),
        true, // SD→SN regulation cross-shift is now treated as location update / continuation
    );

    assert.equal(
        shouldTreatTelegramArrivalAsContinuation({
            sector: "REGULATION",
            isDeparture: false,
            isContinuation: true,
            incomingShiftLabel: "SN",
            activeShiftLabel: "SD",
        }),
        true,
    );

    assert.equal(
        shouldTreatTelegramArrivalAsContinuation({
            sector: "INTERVENTION",
            isDeparture: false,
            isContinuation: false,
            incomingShiftLabel: "SN",
            activeShiftLabel: "SD",
        }),
        true,
    );

    assert.equal(
        shouldTreatTelegramArrivalAsContinuation({
            sector: "INTERVENTION",
            isDeparture: false,
            isContinuation: false,
            incomingShiftLabel: "SN",
            activeShiftLabel: "SN",
        }),
        false,
    );
});

test("shouldLinkTelegramArrivalToContinuitySource links SD→SN regulation cross-shift and refuses same-shift or P-only rollover", () => {
    assert.equal(
        shouldLinkTelegramArrivalToContinuitySource({
            parsed: {
                sector: "REGULATION",
                baseCode: "2154",
                arrivalTime: "19:25",
                shiftType: "SN",
                roleFunction: "MR",
                isDeparture: false,
                isContinuation: false,
            },
            sourceShiftLabel: "SD",
        }),
        true, // SD→SN cross-shift: links to SD continuity group to preserve original arrival time
    );

    assert.equal(
        shouldLinkTelegramArrivalToContinuitySource({
            parsed: {
                sector: "REGULATION",
                baseCode: "2154",
                arrivalTime: "19:25",
                shiftType: "P",
                roleFunction: "MR",
                isDeparture: false,
                isContinuation: false,
            },
            sourceShiftLabel: "SD",
        }),
        true,
    );

    assert.equal(
        shouldLinkTelegramArrivalToContinuitySource({
            parsed: {
                sector: "REGULATION",
                baseCode: "2154",
                arrivalTime: "19:25",
                shiftType: "SN",
                roleFunction: "MR",
                isDeparture: false,
                isContinuation: true,
            },
            sourceShiftLabel: "SD",
        }),
        true,
    );

    assert.equal(
        shouldLinkTelegramArrivalToContinuitySource({
            parsed: {
                sector: "REGULATION",
                baseCode: "2154",
                arrivalTime: "19:25",
                shiftType: "SN",
                roleFunction: "MR",
                isDeparture: false,
                isContinuation: false,
            },
            sourceShiftLabel: "SN",
        }),
        false,
    );
});

test("shouldDeferPendingNameSelectionToFreshParsing leaves new operational launch out of stale candidate flow", () => {
    assert.equal(shouldDeferPendingNameSelectionToFreshParsing("Caio Oliveira 2151 SD", [
        {
            id: "ana-1",
            fullName: "Ana Beatriz D'Almeida Silva",
            displayName: "Ana Beatriz D'Almeida",
            normalizedName: "ANA BEATRIZ D'ALMEIDA SILVA",
            score: 0,
        },
        {
            id: "ana-2",
            fullName: "Ana Beatriz de Andrade Carvalho",
            displayName: "Ana Carvalho",
            normalizedName: "ANA BEATRIZ DE ANDRADE CARVALHO",
            score: 0,
        },
        {
            id: "ana-3",
            fullName: "Ana Beatriz Nunes Bonfim",
            displayName: "Ana Bonfim",
            normalizedName: "ANA BEATRIZ NUNES BONFIM",
            score: 0,
        },
    ]), true);

    assert.equal(shouldDeferPendingNameSelectionToFreshParsing("3", [
        {
            id: "ana-1",
            fullName: "Ana Beatriz D'Almeida Silva",
            displayName: "Ana Beatriz D'Almeida",
            normalizedName: "ANA BEATRIZ D'ALMEIDA SILVA",
            score: 0,
        },
        {
            id: "ana-2",
            fullName: "Ana Beatriz de Andrade Carvalho",
            displayName: "Ana Carvalho",
            normalizedName: "ANA BEATRIZ DE ANDRADE CARVALHO",
            score: 0,
        },
        {
            id: "ana-3",
            fullName: "Ana Beatriz Nunes Bonfim",
            displayName: "Ana Bonfim",
            normalizedName: "ANA BEATRIZ NUNES BONFIM",
            score: 0,
        },
    ]), false);
});

test("pickTelegramReply teaches how to justify a late departure", () => {
    const reply = pickTelegramReply("departure_justification_required", 23, {
        name: "Vagner Barroso",
        target: "PR03",
        time: "19:20",
        example: "Vagner Barroso saindo PR03 19:20 porque fui liberado pela chefia",
    });

    assert.match(reply, /motivo|justificativa|reenvie/i);
    assert.match(reply, /chefia|ocorrência 0729|render/i);
    assert.match(reply, /responder esta mensagem só com o motivo|responda só o motivo|responda apenas o motivo|responder aqui só com a justificativa|responda aqui só com a justificativa/i);
    assert.match(reply, /horário mudou|reenvie a saída completa|se precisar trocar o horário/i);
    assert.match(reply, /PR03/);
});

test("pickTelegramReply confirms that the late-departure justification was attached for coordination", () => {
    const reply = pickTelegramReply("departure_justification_recorded", 24, {
        name: "Vagner Barroso",
        target: "PR03",
        time: "19:20",
    });

    assert.match(reply, /^📝✅/u);
    assert.match(reply, /justificativa|motivo/i);
    assert.match(reply, /coordenação/i);
    assert.match(reply, /pagamento|banco de horas/i);
});

test("buildTelegramJustificationFollowUpText appends a plain follow-up reason to the original departure message", () => {
    const merged = buildTelegramJustificationFollowUpText(
        "Vagner Barroso saindo PR03 19:20",
        "liberado pela chefia por atraso na rendicao",
    );

    assert.match(merged, /Vagner Barroso saindo PR03 19:20/);
    assert.match(merged, /motivo complementar/);
    assert.match(merged, /liberado pela chefia por atraso na rendicao/);
});

test("requiresTelegramDepartureAdjustmentJustification only after operational grace even with handoff", () => {
    assert.equal(
        requiresTelegramDepartureAdjustmentJustification({
            startedAt: new Date("2026-03-26T07:00:00-03:00"),
            endedAt: new Date("2026-03-26T19:01:00-03:00"),
            eventAt: new Date("2026-03-26T19:10:00-03:00"),
        }),
        false,
    );

    assert.equal(
        requiresTelegramDepartureAdjustmentJustification({
            startedAt: new Date("2026-03-26T07:00:00-03:00"),
            endedAt: new Date("2026-03-26T19:01:00-03:00"),
            eventAt: new Date("2026-03-26T19:40:00-03:00"),
        }),
        true,
    );
});

test("pickTelegramReply explains late departure adjustment without changing the panel", () => {
    const reply = pickTelegramReply("departure_adjusted", 29, {
        name: "Vagner Barroso",
        target: "PR03",
        time: "19:20",
    });

    assert.match(reply, /painel/i);
    assert.match(reply, /pagamento|banco de horas/i);
    assert.match(reply, /19:20/);
});

test("pickTelegramReply asks for missing context on departure", () => {
    const reply = pickTelegramReply("departure_missing_context", 31, {
        example: "Vagner saindo PR03 19:20 porque estava em ocorrencia",
    });

    assert.match(reply, /base|horário|local|contexto/i);
    assert.match(reply, /saindo PR03 19:20 porque estava em ocorrencia/i);
});

test("pickTelegramReply prefixes unresolved replies with emoticon", () => {
    const reply = pickTelegramReply("name_unresolved", 21, {});

    assert.match(reply, /^⚠️/u);
});

test("buildGroupCorrectionAnnouncement creates playful group summary", () => {
    const reply = buildGroupCorrectionAnnouncement(9, {
        name: "Gabriel Carvalho Monteiro",
        target: "CZ50",
        time: "07:00",
    });

    assert.match(reply, /Gabriel Carvalho Monteiro/);
    assert.match(reply, /CZ50/);
    assert.match(reply, /07:00/);
});

test("hasTelegramOperationalJustification rejects bare departure commands after stripping operational tokens", () => {
    assert.equal(
        hasTelegramOperationalJustification("/saiu PP20 19:20", ["PP20", "19:20"]),
        false,
    );
});

test("hasTelegramOperationalJustification accepts written operational reason", () => {
    assert.equal(
        hasTelegramOperationalJustification(
            "/saiu PP20 19:20 motivo cobertura estendida por sala vermelha",
            ["PP20", "19:20"],
        ),
        true,
    );
});

test("hasTelegramOperationalJustification accepts continuation messages only when there is real free text", () => {
    assert.equal(
        hasTelegramOperationalJustification("PP20 Maria Silva 07:20 P", ["PP20", "Maria Silva", "07:20", "P"]),
        false,
    );

    assert.equal(
        hasTelegramOperationalJustification(
            "PP20 Maria Silva 07:20 P motivo aguardando liberacao da sala vermelha",
            ["PP20", "Maria Silva", "07:20", "P"],
        ),
        true,
    );
});

test("isBatchConfirmationKeyword aceita confirmacao em maiusculas e frases equivalentes", () => {
    assert.equal(isBatchConfirmationKeyword("CONFIRMAR"), true);
    assert.equal(isBatchConfirmationKeyword("Confirmar"), true);
    assert.equal(isBatchConfirmationKeyword("ok pode lançar"), true);
    assert.equal(isBatchConfirmationKeyword("OK"), false);
});

test("isBatchCancelKeyword aceita variantes de cancelamento", () => {
    assert.equal(isBatchCancelKeyword("CANCELAR"), true);
    assert.equal(isBatchCancelKeyword("Cancela"), true);
    assert.equal(isBatchCancelKeyword("Descartar lote"), true);
    assert.equal(isBatchCancelKeyword("Fechar"), false);
});