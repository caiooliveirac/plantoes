import assert from "node:assert/strict";
import test from "node:test";
import { isTelegramDoctorAdminCommandText, parseTelegramDoctorAdminCommand } from "@/modules/telegram/admin-commands";
import {
    isTelegramAdminOnlyCommand,
    isTelegramDepartureCorrectionCommandText,
    parseTelegramCommand,
    parseTelegramDepartureCorrectionCommand,
} from "@/modules/telegram/commands";
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
import { buildTelegramCommandSuggestionReply, suggestTelegramCommandHelp } from "@/modules/telegram/command-suggestions";
import { buildGroupCorrectionAnnouncement, pickTelegramReply } from "@/modules/telegram/replies";
import { buildTelegramShiftReport } from "@/modules/telegram/shift-report";
import {
    buildTelegramReviewLogData,
    buildTelegramJustificationFollowUpText,
    hasTelegramOperationalJustification,
    isBatchCancelKeyword,
    isBatchConfirmationKeyword,
    parseTelegramStandaloneTime,
    pickLikelyDepartureCorrectionCandidate,
    resolveTelegramEligibleLateDepartureReason,
    requiresTelegramDepartureAdjustmentJustification,
    resolveContinuationShiftStart,
    resolveTelegramContinuationStartedAt,
    resolveLatestClosedShiftRequest,
    resolveTelegramSuccessReplyKind,
    shouldLinkActiveTelegramContinuitySource,
    shouldLinkRecentClosedTelegramContinuity,
    shouldDeferPendingDepartureCorrectionToFreshParsing,
    shouldUseTelegramSenderNameFallback,
    isSharedAccountSender,
    shouldLinkTelegramArrivalToContinuitySource,
    resolveTelegramShadowFlag,
    shouldDeferPendingDepartureJustificationToFreshParsing,
    shouldDeferPendingNameSelectionToFreshParsing,
    shouldTreatTelegramArrivalAsContinuation,
    shouldReopenStaleTelegramInterventionContinuation,
    shouldReopenStaleTelegramRegulationContinuation,
    shouldTreatTelegramArrivalAsImplicitReassignment,
    buildTelegramContinuationSourceHint,
    buildPublicTelegramCommandHelpReply,
    shouldRouteToDepartureJustification,
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

function makeDepartureCorrectionCandidate(overrides: Partial<{
    occupancyId: string;
    domain: "REGULATION" | "INTERVENTION";
    targetCode: string;
    shiftLabel: "SD" | "SN" | "P" | null;
    roleLabel: string | null;
    startedAt: Date;
    endedAt: Date | null;
    actualEndedAt: Date | null;
    isActive: boolean;
}> = {}) {
    return {
        occupancyId: "dep-candidate-1",
        domain: "REGULATION" as const,
        targetCode: "2035",
        shiftLabel: "SD" as const,
        roleLabel: null,
        startedAt: new Date("2026-03-30T10:05:00.000Z"),
        endedAt: new Date("2026-03-30T22:15:00.000Z"),
        actualEndedAt: new Date("2026-03-30T22:05:00.000Z"),
        isActive: false,
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

test("buildPublicTelegramCommandHelpReply lista somente comandos publicos didaticos", () => {
    const reply = buildPublicTelegramCommandHelpReply();

    assert.match(reply, /\/plantao/);
    assert.match(reply, /\/resumo/);
    assert.match(reply, /\/saidas/);
    assert.doesNotMatch(reply, /\/medico|\/banco|\/desfazer|\/ativar|\/desativar|\/remover/);
});

test("suggestTelegramCommandHelp sugere RECIP com duas opcoes no maximo", () => {
    const result = suggestTelegramCommandHelp({
        text: "/recipiendario Angelo",
        recentMessages: [{ rawText: "Chegada Angelo Sposito 2153 às 08:03 SD", parsedTargetCode: "2153", parsedDoctorName: "Angelo Sposito" }],
    });

    assert.equal(result?.kind, "recip");
    assert.equal(result?.suggestions.length, 2);
    assert.match(result?.suggestions[0]?.usage ?? "", /RECIP/);
    assert.match(result?.suggestions[1]?.usage ?? "", /\/ramal .* RECIP/);
});

test("suggestTelegramCommandHelp sugere sintaxe de saida e corrigirsaida para liberado chefia", () => {
    const result = suggestTelegramCommandHelp({
        text: "Saída Lucio Parada IT30 07:50 Liberado chefia",
        recentMessages: [],
    });

    assert.equal(result?.kind, "departure");
    assert.equal(result?.suggestions.length, 2);
    assert.match(result?.suggestions[0]?.usage ?? "", /saindo IT30 07:50 porque fui liberado pela chefia/i);
    assert.match(result?.suggestions[1]?.usage ?? "", /\/corrigirsaida .* IT30/i);
});

test("suggestTelegramCommandHelp usa contexto recente para respostas curtas de meal break", () => {
    const result = suggestTelegramCommandHelp({
        text: "confirmo",
        recentMessages: [
            { rawText: "/almoço", parsedAction: "meal_break_command" },
            { rawText: "1367 13:30", parsedAction: "meal_break_reply" },
        ],
    });

    assert.equal(result?.kind, "meal_break");
    assert.deepEqual(result?.suggestions.map((item) => item.usage), ["/almoço", "/almoço reiniciar"]);
});

test("buildTelegramCommandSuggestionReply monta resposta curta e limita a duas sugestoes", () => {
    const reply = buildTelegramCommandSuggestionReply({
        kind: "short_reply",
        intro: "Isso parece uma resposta curta.",
        suggestions: [
            { label: "Primeira", usage: "/plantao" },
            { label: "Segunda", usage: "/resumo" },
            { label: "Terceira", usage: "/saidas" },
        ],
    });

    assert.match(reply, /Primeira/);
    assert.match(reply, /Segunda/);
    assert.doesNotMatch(reply, /Terceira/);
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
            isReassignment: false,
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
            isShadow: false,
            isDeparture: true,
            isContinuation: false,
            isReassignment: false,
        },
        reviewDoctorQuery: "Leonardo Carteado",
        reviewCandidates: ["Leonardo Carvalho", "Leonardo Cartaxo"],
        reviewLooksLikeDeparture: true,
        reviewSuggestedFormat: "Leonardo Carteado saindo PM40 19:20 porque fui liberado pela chefia",
    });
});

test("resolveTelegramShadowFlag preserves shadow across pending name-resolution flows", () => {
    assert.equal(resolveTelegramShadowFlag({ isDeparture: false, isShadow: true }, "Leonardo PM40 07:14"), true);
    assert.equal(resolveTelegramShadowFlag({ isDeparture: false, isShadow: false }, "Leonardo Prado sombra PM40 07:14"), true);
    assert.equal(resolveTelegramShadowFlag({ isDeparture: false, isShadow: false }, "Leonardo Prado PM40 07:14"), false);
    assert.equal(resolveTelegramShadowFlag({ isDeparture: true, isShadow: true }, "Leonardo sombra saindo PM40 19:20"), false);
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

test("shouldUseTelegramSenderNameFallback blocks shared account senders", () => {
    assert.equal(shouldUseTelegramSenderNameFallback("2031 SD", "2151 Médico MRV"), false);
    assert.equal(shouldUseTelegramSenderNameFallback("2031 SD", "COI 1367"), false);
    assert.equal(shouldUseTelegramSenderNameFallback("2031 SD", "MR COI 1368"), false);
    assert.equal(shouldUseTelegramSenderNameFallback("2031 SD", "2031 CHEFE"), false);
    assert.equal(shouldUseTelegramSenderNameFallback("2031 SD", "Ana Luiza"), true);
    assert.equal(shouldUseTelegramSenderNameFallback("2031 SD", null), true);
});

test("isSharedAccountSender detects ramal/role-based Telegram account names", () => {
    assert.equal(isSharedAccountSender("2151 Médico MRV"), true);
    assert.equal(isSharedAccountSender("COI 1367"), true);
    assert.equal(isSharedAccountSender("MR COI 1368"), true);
    assert.equal(isSharedAccountSender("2031 CHEFE"), true);
    assert.equal(isSharedAccountSender("2032 MEDICO"), true);
    assert.equal(isSharedAccountSender("2154 MÉDICO"), true);
    assert.equal(isSharedAccountSender("Ana Luiza Alves"), false);
    assert.equal(isSharedAccountSender("Caio Oliveira"), false);
    assert.equal(isSharedAccountSender(null), false);
    assert.equal(isSharedAccountSender(""), false);
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

    const withPsiq = parseTelegramCommand("/ramal Emily 1363 PSIQ");
    assert.equal(withPsiq?.name, "ramal");
    assert.equal(withPsiq?.targetCode, "1363");
    assert.equal(withPsiq?.doctorName, "Emily");
    assert.equal(withPsiq?.roleLabel, "PSIQ");
});

test("parseTelegramDepartureCorrectionCommand parses doctor name with optional target", () => {
    const withTarget = parseTelegramDepartureCorrectionCommand("/corrigirsaida Joao Pedro 2035");

    assert.equal(withTarget?.name, "corrigirsaida");
    assert.equal(withTarget?.doctorName, "Joao Pedro");
    assert.equal(withTarget?.targetCode, "2035");
    assert.equal(withTarget?.sector, "REGULATION");

    const withoutTarget = parseTelegramDepartureCorrectionCommand("/corrigirsaida Joao Pedro");
    assert.equal(withoutTarget?.doctorName, "Joao Pedro");
    assert.equal(withoutTarget?.targetCode, null);
    assert.equal(isTelegramDepartureCorrectionCommandText("/corrigirsaida Joao Pedro"), true);
});

test("parseTelegramCommand parses /ontem with target and time", () => {
    const parsed = parseTelegramCommand("/ontem PM04 20:00");

    assert.equal(parsed?.name, "ontem");
    assert.equal(parsed?.sector, "INTERVENTION");
    assert.equal(parsed?.targetCode, "PM04");
    assert.equal(parsed?.time, "20:00");
    assert.equal(parsed?.isDeparture, false);
});

test("parseTelegramCommand parses /hoje with target, name and time", () => {
    const parsed = parseTelegramCommand("/hoje 2031 Samara 07:00");

    assert.equal(parsed?.name, "hoje");
    assert.equal(parsed?.sector, "REGULATION");
    assert.equal(parsed?.targetCode, "2031");
    assert.equal(parsed?.doctorName, "Samara");
    assert.equal(parsed?.time, "07:00");
    assert.equal(parsed?.isDeparture, false);
});

test("parseTelegramDoctorAdminCommand parses full name, display name and code", () => {
    const parsed = parseTelegramDoctorAdminCommand("/medico cadastrar Ana Beatriz D'Almeida Silva | Ana Beatriz | crm-1 | Ana Bia, Bia Almeida");

    assert.equal(parsed?.name, "doctor_create");
    assert.equal(parsed?.fullName, "Ana Beatriz D'Almeida Silva");
    assert.equal(parsed?.displayName, "Ana Beatriz");
    assert.equal(parsed?.externalCode, "crm-1");
    assert.deepEqual(parsed?.aliases, ["Ana Bia", "Bia Almeida"]);
});

test("parseTelegramDoctorAdminCommand aceita cadastro com apenas nome completo", () => {
    const parsed = parseTelegramDoctorAdminCommand("/medico cadastrar Monica Aragao");

    assert.equal(parsed?.fullName, "Monica Aragao");
    assert.equal(parsed?.displayName, null);
    assert.equal(parsed?.externalCode, null);
});

test("parseTelegramDoctorAdminCommand parses update with explicit lookup", () => {
    const parsed = parseTelegramDoctorAdminCommand("/medico atualizar Ana Beatriz | Ana Beatriz D'Almeida Silva | Ana Beatriz | | Ana Bia, Bia Almeida");

    assert.equal(parsed?.name, "doctor_update");
    assert.equal(parsed?.lookup, "Ana Beatriz");
    assert.equal(parsed?.fullName, "Ana Beatriz D'Almeida Silva");
    assert.equal(parsed?.displayName, "Ana Beatriz");
    assert.equal(parsed?.externalCode, null);
    assert.deepEqual(parsed?.aliases, ["Ana Bia", "Bia Almeida"]);
    assert.equal(parsed?.hasAliases, true);
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

test("getCurrentDeparturePriorityView lista so regulacao SD elegivel e separa continuidades em P", async () => {
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
                    postId: 4,
                    occupancyId: "reg-priority-cp",
                    postCode: "2031",
                    postLabel: "2031",
                    defaultRole: "MR",
                    doctorId: "doc-cp",
                    doctorName: "Carla Prado",
                    displayName: "Carla",
                    startedAt: "2026-03-30T09:40:00.000Z",
                    boardStartedAt: "2026-03-30T09:40:00.000Z",
                    roleLabel: null,
                    ramalLabel: "2031",
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
                makeRegulationPriorityRow({
                    postId: 5,
                    occupancyId: "reg-priority-p",
                    postCode: "2154",
                    postLabel: "2154",
                    defaultRole: "MR",
                    doctorId: "doc-p",
                    doctorName: "Diego Silva",
                    displayName: "Diego",
                    startedAt: "2026-03-30T09:45:00.000Z",
                    boardStartedAt: "2026-03-30T09:45:00.000Z",
                    shiftLabel: "P",
                    roleLabel: null,
                    ramalLabel: "2154",
                }),
            ],
        },
        mealBreakSession: { recipRamal: "2036" },
    });

    assert.equal(view.shiftLabel, "SD");
    assert.deepEqual(view.entries.map((entry) => entry.targetCode), ["2035"]);
    assert.deepEqual(view.entries.map((entry) => entry.rank), [1]);
    assert.deepEqual(view.excludedContinuations.map((entry) => entry.targetCode), ["2154"]);

    const reply = buildDeparturePriorityReply(view);
    assert.match(reply, /Lista de reguladores no DIURNO/);
    assert.match(reply, /Fora da lista principal: CP, MRV, RECIP, PIAM, NUCLEO, MEIO, quem chegou ha menos de 4h e quem est[aá] em P\/continua\./);
    assert.match(reply, /1\. Bruno \| 2035 \| 07:05/);
    assert.match(reply, /Fora por estarem em P \(continua\):/);
    assert.match(reply, /- Diego \| 2154 \| 06:45/);
    assert.doesNotMatch(reply, /Ana \| PM04/);
    assert.doesNotMatch(reply, /Marina Costa/);
    assert.doesNotMatch(reply, /Renata Lima/);
    assert.doesNotMatch(reply, /Carla Prado/);
});

test("getCurrentDeparturePriorityView no SN aplica piso 19:15 para RMT e exclui continua SD", async () => {
    const view = await getCurrentDeparturePriorityView({
        // Fechamento do noturno: todos já passaram das 4h de plantão.
        referenceAt: new Date("2026-03-31T00:00:00-03:00"),
        board: {
            generatedAt: "2026-03-31T03:00:00.000Z",
            intervention: [makeInterventionPriorityRow()],
            regulation: [
                makeRegulationPriorityRow({
                    postCode: "2035",
                    postLabel: "2035",
                    doctorName: "Ana Presencial",
                    displayName: "Ana",
                    startedAt: "2026-03-30T22:10:00.000Z", // 19:10 local
                    boardStartedAt: "2026-03-30T22:10:00.000Z",
                    shiftLabel: "SN",
                    roleLabel: null,
                }),
                makeRegulationPriorityRow({
                    postId: 2,
                    postCode: "2036",
                    postLabel: "2036",
                    doctorName: "Bruno RMT",
                    displayName: "Bruno",
                    startedAt: "2026-03-30T21:59:00.000Z", // 18:59 local
                    boardStartedAt: "2026-03-30T21:59:00.000Z",
                    shiftLabel: "SN",
                    roleLabel: "RMT",
                }),
                makeRegulationPriorityRow({
                    postId: 5,
                    postCode: "2032",
                    postLabel: "2032",
                    defaultRole: "MRV",
                    doctorName: "Erika 2032",
                    displayName: "Erika",
                    startedAt: "2026-03-30T22:11:00.000Z", // 19:11 local
                    boardStartedAt: "2026-03-30T22:11:00.000Z",
                    shiftLabel: "SN",
                    roleLabel: null,
                }),
                makeRegulationPriorityRow({
                    postId: 3,
                    postCode: "2154",
                    postLabel: "2154",
                    doctorName: "Carla Continua SD",
                    displayName: "Carla",
                    startedAt: "2026-03-30T19:30:00.000Z",
                    boardStartedAt: "2026-03-30T19:30:00.000Z",
                    shiftLabel: "SD",
                    roleLabel: null,
                }),
                makeRegulationPriorityRow({
                    postId: 4,
                    postCode: "2153",
                    postLabel: "2153",
                    doctorName: "Diego P",
                    displayName: "Diego",
                    startedAt: "2026-03-30T19:20:00.000Z",
                    boardStartedAt: "2026-03-30T19:20:00.000Z",
                    shiftLabel: "P",
                    roleLabel: null,
                }),
            ],
        },
        mealBreakSession: { recipRamal: null },
    });

    assert.equal(view.shiftLabel, "SN");
    assert.equal(view.activeNightWorkSlot, null);
    // Diego (2153) está em P mas iniciou no SD anterior, então sai no fechamento do SN
    // e entra no ranking principal — não na lista de continuação.
    assert.deepEqual(view.entries.map((entry) => entry.targetCode), ["2153", "2035", "2032", "2036"]);
    assert.deepEqual(view.excludedContinuations.map((entry) => entry.targetCode), []);

    const diego = view.entries.find((entry) => entry.targetCode === "2153");
    const ana = view.entries.find((entry) => entry.targetCode === "2035");
    const erika = view.entries.find((entry) => entry.targetCode === "2032");
    const bruno = view.entries.find((entry) => entry.targetCode === "2036");
    assert.ok(diego);
    assert.ok(ana);
    assert.ok(erika);
    assert.ok(bruno);
    assert.equal(diego?.priorityStartedAt.slice(11, 16), "19:20");
    assert.equal(ana?.priorityStartedAt.slice(11, 16), "22:10");
    assert.equal(erika?.priorityStartedAt.slice(11, 16), "22:11");
    assert.equal(bruno?.priorityStartedAt.slice(11, 16), "22:15");

    const reply = buildDeparturePriorityReply(view);
    assert.match(reply, /NOTURNO/);
    assert.match(reply, /RMT recebe piso 19:15/);
    assert.match(reply, /1\. Diego \| 2153 \| 16:20/);
    assert.match(reply, /2\. Ana \| 2035 \| 19:10/);
    assert.match(reply, /3\. Erika \| 2032 \| 19:11/);
    assert.match(reply, /4\. Bruno \| 2036 \| 18:59/);
    assert.doesNotMatch(reply, /Carla Continua SD/);
});

test("getCurrentDeparturePriorityView exclui quem chegou ha menos de 4h e os postos PIAM/NUCLEO", async () => {
    const view = await getCurrentDeparturePriorityView({
        referenceAt: new Date("2026-03-30T15:00:00-03:00"),
        board: {
            generatedAt: "2026-03-30T18:00:00.000Z",
            intervention: [makeInterventionPriorityRow()],
            regulation: [
                makeRegulationPriorityRow({
                    postCode: "2035",
                    postLabel: "2035",
                    doctorName: "Ana Veterana",
                    displayName: "Ana",
                    startedAt: "2026-03-30T10:00:00.000Z", // 07:00 local, 8h de plantão
                    boardStartedAt: "2026-03-30T10:00:00.000Z",
                    shiftLabel: "SD",
                    roleLabel: null,
                }),
                makeRegulationPriorityRow({
                    postId: 2,
                    postCode: "2036",
                    postLabel: "2036",
                    doctorName: "Bruno Recem",
                    displayName: "Bruno",
                    startedAt: "2026-03-30T15:30:00.000Z", // 12:30 local, 2h30 de plantão
                    boardStartedAt: "2026-03-30T15:30:00.000Z",
                    shiftLabel: "SD",
                    roleLabel: null,
                }),
                makeRegulationPriorityRow({
                    postId: 3,
                    postCode: "PIAM",
                    postLabel: "PIAM",
                    doctorName: "Carla PIAM",
                    displayName: "Carla",
                    startedAt: "2026-03-30T10:00:00.000Z",
                    boardStartedAt: "2026-03-30T10:00:00.000Z",
                    shiftLabel: "SD",
                    roleLabel: "PIAM",
                }),
                makeRegulationPriorityRow({
                    postId: 4,
                    postCode: "NUCLEO",
                    postLabel: "NUCLEO",
                    doctorName: "Diego Nucleo",
                    displayName: "Diego",
                    startedAt: "2026-03-30T10:00:00.000Z",
                    boardStartedAt: "2026-03-30T10:00:00.000Z",
                    shiftLabel: "SD",
                    roleLabel: null,
                }),
            ],
        },
        mealBreakSession: { recipRamal: null },
    });

    assert.equal(view.shiftLabel, "SD");
    // Só Ana entra: Bruno tem menos de 4h, PIAM e NUCLEO nunca entram.
    assert.deepEqual(view.entries.map((entry) => entry.targetCode), ["2035"]);
});

test("getCurrentDeparturePriorityView no SN filtra por turma 23:00 antes de 03:00 e por 03:00 depois", async () => {
    const board = {
        generatedAt: "2026-03-31T04:40:00.000Z",
        intervention: [makeInterventionPriorityRow()],
        regulation: [
            makeRegulationPriorityRow({
                postCode: "2035",
                postLabel: "2035",
                doctorName: "Ana 23",
                displayName: "Ana",
                startedAt: "2026-03-30T22:05:00.000Z",
                boardStartedAt: "2026-03-30T22:05:00.000Z",
                scheduledEndAt: "2026-03-31T10:15:00.000Z",
                shiftLabel: "SN",
                roleLabel: null,
            }),
            makeRegulationPriorityRow({
                postId: 2,
                postCode: "2036",
                postLabel: "2036",
                doctorName: "Bruno 03",
                displayName: "Bruno",
                startedAt: "2026-03-30T22:06:00.000Z",
                boardStartedAt: "2026-03-30T22:06:00.000Z",
                scheduledEndAt: "2026-03-31T10:15:00.000Z",
                shiftLabel: "SN",
                roleLabel: null,
            }),
        ],
    };

    const mealBreakSession = {
        recipRamal: null,
        mode: "night" as const,
        stage: "completed" as const,
        nightWorkAssignments: {
            "2035": "23:00" as const,
            "2036": "03:00" as const,
        },
    };

    const beforeThree = await getCurrentDeparturePriorityView({
        referenceAt: new Date("2026-03-31T02:40:00-03:00"),
        board,
        mealBreakSession,
    });

    assert.equal(beforeThree.activeNightWorkSlot, "23:00");
    assert.deepEqual(beforeThree.entries.map((entry) => entry.targetCode), ["2035"]);
    assert.match(buildDeparturePriorityReply(beforeThree), /Janela ativa da divisao de jantar: 23:00\./);

    const afterThree = await getCurrentDeparturePriorityView({
        referenceAt: new Date("2026-03-31T03:10:00-03:00"),
        board,
        mealBreakSession,
    });

    assert.equal(afterThree.activeNightWorkSlot, "03:00");
    assert.deepEqual(afterThree.entries.map((entry) => entry.targetCode), ["2036"]);
    assert.match(buildDeparturePriorityReply(afterThree), /Janela ativa da divisao de jantar: 03:00\./);
});

test("getCurrentDeparturePriorityView na janela 16-21h lista saida das 19h (SD + P invertido)", async () => {
    const view = await getCurrentDeparturePriorityView({
        referenceAt: new Date("2026-03-30T18:00:00-03:00"),
        board: {
            generatedAt: "2026-03-30T21:00:00.000Z",
            intervention: [makeInterventionPriorityRow()],
            regulation: [
                makeRegulationPriorityRow({
                    postCode: "2035",
                    postLabel: "2035",
                    doctorName: "Ana SD",
                    displayName: "Ana",
                    startedAt: "2026-03-30T10:00:00.000Z", // 07:00 local
                    boardStartedAt: "2026-03-30T10:00:00.000Z",
                    scheduledEndAt: "2026-03-30T22:15:00.000Z", // 19:15 local
                    shiftLabel: "SD",
                    roleLabel: null,
                }),
                makeRegulationPriorityRow({
                    postId: 2,
                    postCode: "2036",
                    postLabel: "2036",
                    doctorName: "Bruno P invertido",
                    displayName: "Bruno",
                    startedAt: "2026-03-30T10:05:00.000Z",
                    boardStartedAt: "2026-03-29T22:00:00.000Z",
                    scheduledEndAt: "2026-03-30T22:15:00.000Z", // sai 19:15 → P invertido
                    shiftLabel: "P",
                    roleLabel: null,
                }),
                makeRegulationPriorityRow({
                    postId: 3,
                    postCode: "2154",
                    postLabel: "2154",
                    doctorName: "Emily P normal",
                    displayName: "Emily",
                    startedAt: "2026-03-30T10:13:00.000Z",
                    boardStartedAt: "2026-03-30T10:13:00.000Z",
                    scheduledEndAt: "2026-03-31T10:15:00.000Z", // sai 07:15 → P normal
                    shiftLabel: "P",
                    roleLabel: null,
                }),
                makeRegulationPriorityRow({
                    postId: 4,
                    postCode: "2153",
                    postLabel: "2153",
                    doctorName: "Caroline SN",
                    displayName: "Caroline",
                    startedAt: "2026-03-30T21:40:00.000Z",
                    boardStartedAt: "2026-03-30T21:40:00.000Z",
                    scheduledEndAt: "2026-03-31T10:15:00.000Z",
                    shiftLabel: "SN",
                    roleLabel: null,
                }),
            ],
        },
        mealBreakSession: { recipRamal: null },
    });

    assert.equal(view.shiftLabel, "SD");
    assert.equal(view.departureBoundary, "19h");
    // SD e P invertido saem 19h → rankeados. Emily (P normal) sai 07h → continuacao. Caroline (SN) fora.
    assert.deepEqual(view.entries.map((entry) => entry.targetCode), ["2035", "2036"]);
    assert.deepEqual(view.excludedContinuations.map((entry) => entry.targetCode), ["2154"]);

    const reply = buildDeparturePriorityReply(view);
    assert.match(reply, /Janela atual: lista quem está previsto para sair às 19h\./);
    assert.doesNotMatch(reply, /Caroline SN/);
});

test("getCurrentDeparturePriorityView na janela 02-09h lista saida das 07h (SN + P normal)", async () => {
    const view = await getCurrentDeparturePriorityView({
        referenceAt: new Date("2026-03-31T04:00:00-03:00"),
        board: {
            generatedAt: "2026-03-31T07:00:00.000Z",
            intervention: [makeInterventionPriorityRow()],
            regulation: [
                makeRegulationPriorityRow({
                    postCode: "2035",
                    postLabel: "2035",
                    doctorName: "Ana SN",
                    displayName: "Ana",
                    startedAt: "2026-03-30T22:05:00.000Z", // 19:05 local
                    boardStartedAt: "2026-03-30T22:05:00.000Z",
                    scheduledEndAt: "2026-03-31T10:15:00.000Z", // 07:15 local
                    shiftLabel: "SN",
                    roleLabel: null,
                }),
                makeRegulationPriorityRow({
                    postId: 2,
                    postCode: "2036",
                    postLabel: "2036",
                    doctorName: "Bruno P normal",
                    displayName: "Bruno",
                    startedAt: "2026-03-30T22:10:00.000Z",
                    boardStartedAt: "2026-03-30T10:00:00.000Z",
                    scheduledEndAt: "2026-03-31T10:15:00.000Z", // sai 07:15 → P normal
                    shiftLabel: "P",
                    roleLabel: null,
                }),
                makeRegulationPriorityRow({
                    postId: 3,
                    postCode: "2154",
                    postLabel: "2154",
                    doctorName: "Carla P invertido",
                    displayName: "Carla",
                    startedAt: "2026-03-31T10:05:00.000Z",
                    boardStartedAt: "2026-03-30T22:00:00.000Z",
                    scheduledEndAt: "2026-03-31T22:15:00.000Z", // sai 19:15 → P invertido
                    shiftLabel: "P",
                    roleLabel: null,
                }),
                makeRegulationPriorityRow({
                    postId: 4,
                    postCode: "2153",
                    postLabel: "2153",
                    doctorName: "Diego SD",
                    displayName: "Diego",
                    startedAt: "2026-03-31T09:50:00.000Z",
                    boardStartedAt: "2026-03-31T09:50:00.000Z",
                    scheduledEndAt: "2026-03-31T22:15:00.000Z",
                    shiftLabel: "SD",
                    roleLabel: null,
                }),
            ],
        },
        mealBreakSession: { recipRamal: null },
    });

    assert.equal(view.shiftLabel, "SN");
    assert.equal(view.departureBoundary, "07h");
    // SN e P normal saem 07h → rankeados. Carla (P invertido) sai 19h → continuacao. Diego (SD) fora.
    assert.deepEqual(view.entries.map((entry) => entry.targetCode), ["2035", "2036"]);
    assert.deepEqual(view.excludedContinuations.map((entry) => entry.targetCode), ["2154"]);

    const reply = buildDeparturePriorityReply(view);
    assert.match(reply, /Janela atual: lista quem está previsto para sair às 07h\./);
    assert.doesNotMatch(reply, /Diego SD/);
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
                displayName: "Ana",
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
                displayName: "Bruno",
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
    assert.match(report, /✅ 2031 \| 19:00 \| Ana \| 07:20 \| BH \+0h00 \(extra/);
    assert.match(report, /⚠️ PM04 \| 19:10 \| Bruno \| 07:45 \| BH \+0h35/);
    assert.match(report, /revisar: saída ajustada depois da rendição/);
    assert.match(report, /Vazios \(1\): IT30/);
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
    assert.match(report, /✅ CZ50 \| 07:00 \| Laisse Melo \| 19:12 \| BH 0/);
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

    assert.match(report, /Plantão SN/);
    assert.match(report, /✅ PM04 - Ana \| chegada 19:00 \| SN/);
    assert.match(report, /🔴 BR05 - Joao \| SD desde 07:18/);
    assert.match(report, /sem confirmação para SN/);
    assert.match(report, /🔴 IT30/);
    assert.match(report, /✅ 2031 - Bruno \| chegada 19:02 \| SN/);
    assert.match(report, /🟡 2032 - Marina/);
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

    assert.match(report, /Intervenção 1\/1 confirmadas/);
    assert.match(report, /⚫ IT30 - desativada às 18:30 \| USA recolhida/);
    assert.doesNotMatch(report, /Sem aviso.*IT30/s);
});

test("buildTelegramShiftReport treats null shiftLabel with current-shift boardStartedAt as confirmed", () => {
    const report = buildTelegramShiftReport({
        reference: new Date("2026-03-29T11:00:00-03:00"),
        board: {
            intervention: [
                {
                    baseId: 1,
                    occupancyId: "int-1",
                    baseCode: "SM01",
                    baseLabel: "SM01",
                    doctorId: "doc-1",
                    doctorName: "Carlos Mendes",
                    displayName: "Carlos",
                    startedAt: "2026-03-29T10:05:00.000Z",
                    boardStartedAt: "2026-03-29T10:05:00.000Z",
                    scheduledEndAt: "2026-03-29T22:00:00.000Z",
                    shiftLabel: null,
                    roleLabel: null,
                    status: "active",
                    liveSource: "operations_v2",
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
                    doctorId: "doc-2",
                    doctorName: "Felipe Ramos",
                    displayName: "Felipe",
                    startedAt: "2026-03-29T10:10:00.000Z",
                    boardStartedAt: "2026-03-29T10:10:00.000Z",
                    scheduledEndAt: "2026-03-29T22:15:00.000Z",
                    shiftLabel: null,
                    roleLabel: "MR",
                    ramalLabel: "2031",
                    status: "active",
                    liveSource: "operations_v2",
                    liveUpdatedAt: null,
                },
            ],
        },
    });

    assert.match(report, /Plantão SD/);
    assert.match(report, /✅ SM01 - Carlos \| chegada 07:05 \| SD/);
    assert.match(report, /✅ 2031 - Felipe \| chegada 07:10 \| SD/);
    assert.doesNotMatch(report, /Herança/);
    assert.doesNotMatch(report, /sem confirmação/);
});

test("buildTelegramShiftReport shows null shiftLabel from previous shift as carryover for regulation and awaiting for intervention", () => {
    const report = buildTelegramShiftReport({
        reference: new Date("2026-03-29T11:00:00-03:00"),
        board: {
            intervention: [
                {
                    baseId: 1,
                    occupancyId: "int-1",
                    baseCode: "PM04",
                    baseLabel: "PM04",
                    doctorId: "doc-1",
                    doctorName: "Joana Ferreira",
                    displayName: "Joana",
                    startedAt: "2026-03-28T22:30:00.000Z",
                    boardStartedAt: "2026-03-28T22:30:00.000Z",
                    scheduledEndAt: "2026-03-29T10:00:00.000Z",
                    shiftLabel: null,
                    roleLabel: null,
                    status: "active",
                    liveSource: "operations_v2",
                    liveUpdatedAt: null,
                },
            ],
            regulation: [
                {
                    postId: 1,
                    occupancyId: "reg-1",
                    postCode: "2032",
                    postLabel: "2032",
                    defaultRole: "MR",
                    doctorId: "doc-2",
                    doctorName: "Paulo Santos",
                    displayName: "Paulo",
                    startedAt: "2026-03-28T22:00:00.000Z",
                    boardStartedAt: "2026-03-28T22:00:00.000Z",
                    scheduledEndAt: "2026-03-29T10:15:00.000Z",
                    shiftLabel: null,
                    roleLabel: "MR",
                    ramalLabel: "2032",
                    status: "active",
                    liveSource: "operations_v2",
                    liveUpdatedAt: null,
                },
            ],
        },
    });

    assert.match(report, /Plantão SD/);
    assert.match(report, /🔴 PM04 - Joana \| turno anterior desde 19:30 \| sem confirmação para SD/);
    assert.match(report, /🟡 2032 - Paulo \| turno anterior desde 19:00/);
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
                lunchExcludedRamals: [],
                restAssignments: { "2032": "18:00" },
                restExcludedRamals: [],
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
                undoSnapshots: [],
                createdAt: "2026-03-29T12:00:00.000Z",
                updatedAt: "2026-03-29T12:00:00.000Z",
                events: [],
            },
        },
    });

    assert.match(report, /SAÍDAS SN/);
    assert.match(report, /INTERVENÇÃO\nbase\|nome\|saída\nPM04\|Ana Souza\|07:05/);
    assert.match(report, /REGULAÇÃO\nramal\|nome\|saída\n2032\|Marina Costa\|07:15/);
    assert.match(report, /CHEGADAS SD/);
    assert.match(report, /INTERVENÇÃO\nbase\|nome\|chegada\nPM04\|Bruno Lima\|07:00/);
    assert.match(report, /REGULAÇÃO\nramal\|nome\|chegada\|almoco\|descanso\n2032\|Carlos Melo\|07:03\|11:30\|18:00/);
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
                lunchExcludedRamals: [],
                restAssignments: {},
                restExcludedRamals: [],
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
                undoSnapshots: [],
                createdAt: "2026-03-29T23:00:00.000Z",
                updatedAt: "2026-03-29T23:00:00.000Z",
                events: [],
            },
        },
    });

    assert.match(report, /CHEGADAS SN/);
    assert.match(report, /ramal\|nome\|chegada\|jantar\|trabalho/);
    assert.match(report, /2154\|Matheus Quezado\|19:25\|20:30\|23:00/);
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

test("pickTelegramReply renders half-shift assumption with dedicated emoji and wording", () => {
    const reply = pickTelegramReply("half_shift_assumed", 21, {
        name: "Tiago Neves",
        target: "2032",
        time: "11:34",
    });

    assert.match(reply, /^🟠🌓/u);
    assert.match(reply, /supus que voce esta no meio plantao da tarde/i);
    assert.match(reply, /MEIO/i);
    assert.match(reply, /17:00/);
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
            isReassignment: false,
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
            isReassignment: false,
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
            isReassignment: false,
        },
    }), "arrival_recorded");

    // Regulation continuation with isContinuation=true should be continuation_recorded (not arrival)
    assert.equal(resolveTelegramSuccessReplyKind({
        parsed: {
            sector: "REGULATION",
            baseCode: "2151",
            arrivalTime: null,
            shiftType: "SN",
            roleFunction: null,
            isDeparture: false,
            isContinuation: true,
            isReassignment: false,
        },
    }), "continuation_recorded");

    assert.equal(resolveTelegramSuccessReplyKind({
        parsed: {
            sector: "REGULATION",
            baseCode: "2032",
            arrivalTime: "11:32",
            shiftType: "SD",
            roleFunction: null,
            isDeparture: false,
            isContinuation: false,
            isReassignment: false,
        },
        forceHalfShift: true,
    }), "half_shift_assumed");
});

test("shouldRouteToDepartureJustification never treats a continuation warning as a departure", () => {
    const justificationError = "Justificativa obrigatoria para liberar continuidade apos 07:15 ou 19:15. Inclua motivo por escrito na mensagem.";

    // Caso Uemerson Alcantara (SM01): "continua" depois das 19:15 NUNCA pode
    // cair no fluxo de saida tardia — continuar nao e sair.
    assert.equal(shouldRouteToDepartureJustification(justificationError, {
        sector: "INTERVENTION",
        baseCode: "SM01",
        arrivalTime: null,
        shiftType: null,
        roleFunction: null,
        isDeparture: false,
        isContinuation: true,
        isReassignment: false,
    }), false);

    // Uma saida real com justificativa obrigatoria continua sendo roteada.
    assert.equal(shouldRouteToDepartureJustification(justificationError, {
        sector: "INTERVENTION",
        baseCode: "SM01",
        arrivalTime: "19:53",
        shiftType: null,
        roleFunction: null,
        isDeparture: true,
        isContinuation: false,
        isReassignment: false,
    }), true);

    // Erro generico (nao justificativa) nunca abre o fluxo de saida tardia.
    assert.equal(shouldRouteToDepartureJustification("Intervention base not found.", {
        sector: "INTERVENTION",
        baseCode: "SM01",
        arrivalTime: null,
        shiftType: null,
        roleFunction: null,
        isDeparture: false,
        isContinuation: true,
        isReassignment: false,
    }), false);
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
        true,
    );

    assert.equal(
        shouldTreatTelegramArrivalAsContinuation({
            sector: "REGULATION",
            isDeparture: false,
            isContinuation: false,
            incomingShiftLabel: "SD",
            activeShiftLabel: "P",
        }),
        true,
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

test("shouldReopenStaleTelegramRegulationContinuation flags expired P anchors", () => {
    assert.equal(
        shouldReopenStaleTelegramRegulationContinuation({
            activeShiftLabel: "P",
            activeStartedAt: new Date("2026-04-27T19:14:00-03:00"),
            eventAt: new Date("2026-04-28T08:55:00-03:00"),
        }),
        true,
    );

    assert.equal(
        shouldReopenStaleTelegramRegulationContinuation({
            activeShiftLabel: "P",
            activeStartedAt: new Date("2026-04-28T07:20:00-03:00"),
            eventAt: new Date("2026-04-28T08:55:00-03:00"),
        }),
        false,
    );

    assert.equal(
        shouldReopenStaleTelegramRegulationContinuation({
            activeShiftLabel: "SN",
            activeStartedAt: new Date("2026-04-27T19:14:00-03:00"),
            eventAt: new Date("2026-04-28T08:55:00-03:00"),
        }),
        false,
    );
});

test("shouldReopenStaleTelegramInterventionContinuation flags expired P anchors", () => {
    assert.equal(
        shouldReopenStaleTelegramInterventionContinuation({
            activeShiftLabel: "P",
            activeStartedAt: new Date("2026-04-27T19:14:00-03:00"),
            eventAt: new Date("2026-04-28T08:55:00-03:00"),
        }),
        true,
    );

    assert.equal(
        shouldReopenStaleTelegramInterventionContinuation({
            activeShiftLabel: "P",
            activeStartedAt: new Date("2026-04-28T07:20:00-03:00"),
            eventAt: new Date("2026-04-28T08:55:00-03:00"),
        }),
        false,
    );

    assert.equal(
        shouldReopenStaleTelegramInterventionContinuation({
            activeShiftLabel: "SD",
            activeStartedAt: new Date("2026-04-27T19:14:00-03:00"),
            eventAt: new Date("2026-04-28T08:55:00-03:00"),
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
                isReassignment: false,
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
                isReassignment: false,
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
                isReassignment: false,
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
                isReassignment: false,
            },
            sourceShiftLabel: "SN",
        }),
        false,
    );

    // P→SN: doctor was registered as P-shift and sends "continuando SN". Should link
    // to the P continuity group. The calling code must also preserve effectiveShiftType = "P"
    // so that boardStartedAt (from the P arrival) + shiftLabel "P" keeps the occupancy visible.
    assert.equal(
        shouldLinkTelegramArrivalToContinuitySource({
            parsed: {
                sector: "REGULATION",
                baseCode: "2035",
                arrivalTime: null,
                shiftType: "SN",
                roleFunction: null,
                isDeparture: false,
                isContinuation: true,
                isReassignment: false,
            },
            sourceShiftLabel: "P",
        }),
        true,
    );
});

test("shouldLinkRecentClosedTelegramContinuity só linka saída-e-volta-rápida dentro do mesmo turno", () => {
    // saiu de manhã e volta no fim do mesmo SD: gap > 2h, não linka
    assert.equal(
        shouldLinkRecentClosedTelegramContinuity(
            new Date("2026-04-07T18:33:00-03:00"),
            new Date("2026-04-07T07:03:28-03:00"),
        ),
        false,
    );

    // saiu 18:10 SD e volta 19:20 SN: cruza o turno, não é continuidade implícita
    assert.equal(
        shouldLinkRecentClosedTelegramContinuity(
            new Date("2026-04-07T19:20:00-03:00"),
            new Date("2026-04-07T18:10:00-03:00"),
        ),
        false,
    );

    // saiu 18:18 SD e volta 23:40 SN: turno SN inteiro passou sem ocupar
    assert.equal(
        shouldLinkRecentClosedTelegramContinuity(
            new Date("2026-04-07T23:40:00-03:00"),
            new Date("2026-04-07T18:18:00-03:00"),
        ),
        false,
    );

    // dia seguinte → óbvio que não linka
    assert.equal(
        shouldLinkRecentClosedTelegramContinuity(
            new Date("2026-04-08T18:33:00-03:00"),
            new Date("2026-04-08T07:03:28-03:00"),
        ),
        false,
    );

    // saiu 09:30 SD e volta 11:00 SD (gap 1h30min, mesmo turno) → linka
    assert.equal(
        shouldLinkRecentClosedTelegramContinuity(
            new Date("2026-04-07T11:00:00-03:00"),
            new Date("2026-04-07T09:30:00-03:00"),
        ),
        true,
    );

    // caso Leo Morais: PR03 P fechado 07:33 BRT, CB02 P invertido 19:09 BRT (cross-shift, ~11.5h)
    assert.equal(
        shouldLinkRecentClosedTelegramContinuity(
            new Date("2026-05-03T19:09:59-03:00"),
            new Date("2026-05-03T07:33:28-03:00"),
        ),
        false,
    );
});

test("shouldLinkRecentClosedTelegramContinuity rejeita gap negativo (endedAt no futuro)", () => {
    assert.equal(
        shouldLinkRecentClosedTelegramContinuity(
            new Date("2026-05-03T08:00:00-03:00"),
            new Date("2026-05-03T10:00:00-03:00"),
        ),
        false,
    );
});

test("shouldLinkRecentClosedTelegramContinuity não cola quando termina e volta no boundary do turno", () => {
    // saiu 06:55 SD da véspera e volta 07:30 (já é o SD do dia novo) — gap 35min mas turnos diferentes
    assert.equal(
        shouldLinkRecentClosedTelegramContinuity(
            new Date("2026-05-04T07:30:00-03:00"),
            new Date("2026-05-04T06:55:00-03:00"),
        ),
        false,
    );

    // saiu 18:55 SD e volta 19:10 SN — gap pequeno mas cruza para o turno seguinte
    assert.equal(
        shouldLinkRecentClosedTelegramContinuity(
            new Date("2026-05-04T19:10:00-03:00"),
            new Date("2026-05-04T18:55:00-03:00"),
        ),
        false,
    );
});

test("shouldLinkActiveTelegramContinuitySource só linka enquanto a janela esperada do plantão ativo não expirou", () => {
    // P aberto 07:00 BRT e chegada outra base 13:00 BRT mesmo dia → ainda dentro do P (24h)
    assert.equal(
        shouldLinkActiveTelegramContinuitySource({
            activeStartedAt: new Date("2026-05-03T07:00:00-03:00"),
            activeShiftLabel: "P",
            eventAt: new Date("2026-05-03T13:00:00-03:00"),
        }),
        true,
    );

    // P aberto 07:00 BRT, chegada 09:00 do dia seguinte → P já expirou (boundary 7h do dia seguinte)
    assert.equal(
        shouldLinkActiveTelegramContinuitySource({
            activeStartedAt: new Date("2026-05-03T07:00:00-03:00"),
            activeShiftLabel: "P",
            eventAt: new Date("2026-05-04T09:00:00-03:00"),
        }),
        false,
    );

    // SD aberto 07:30 e chegada 21:00 mesmo dia → SD esperado expira no próximo boundary (19:00)
    assert.equal(
        shouldLinkActiveTelegramContinuitySource({
            activeStartedAt: new Date("2026-05-03T07:30:00-03:00"),
            activeShiftLabel: "SD",
            eventAt: new Date("2026-05-03T21:00:00-03:00"),
        }),
        false,
    );

    // SD aberto 07:30 e chegada 14:00 mesmo dia → ainda dentro da janela SD
    assert.equal(
        shouldLinkActiveTelegramContinuitySource({
            activeStartedAt: new Date("2026-05-03T07:30:00-03:00"),
            activeShiftLabel: "SD",
            eventAt: new Date("2026-05-03T14:00:00-03:00"),
        }),
        true,
    );

    // SN aberto 19:00 e chegada 03:00 da madrugada do dia seguinte → ainda dentro do SN
    assert.equal(
        shouldLinkActiveTelegramContinuitySource({
            activeStartedAt: new Date("2026-05-03T19:00:00-03:00"),
            activeShiftLabel: "SN",
            eventAt: new Date("2026-05-04T03:00:00-03:00"),
        }),
        true,
    );

    // SN aberto 19:00 e chegada 14:00 do dia seguinte → SN já expirou no boundary 07:00
    assert.equal(
        shouldLinkActiveTelegramContinuitySource({
            activeStartedAt: new Date("2026-05-03T19:00:00-03:00"),
            activeShiftLabel: "SN",
            eventAt: new Date("2026-05-04T14:00:00-03:00"),
        }),
        false,
    );

    // shiftLabel desconhecido → cai pro boundary geral; depois dele, fonte stale
    assert.equal(
        shouldLinkActiveTelegramContinuitySource({
            activeStartedAt: new Date("2026-05-03T08:00:00-03:00"),
            activeShiftLabel: null,
            eventAt: new Date("2026-05-03T13:00:00-03:00"),
        }),
        true,
    );
    assert.equal(
        shouldLinkActiveTelegramContinuitySource({
            activeStartedAt: new Date("2026-05-03T08:00:00-03:00"),
            activeShiftLabel: null,
            eventAt: new Date("2026-05-04T13:00:00-03:00"),
        }),
        false,
    );

    // chegada antes do início do ativo (clock skew) → permite, fluxo principal cuida
    assert.equal(
        shouldLinkActiveTelegramContinuitySource({
            activeStartedAt: new Date("2026-05-03T08:00:00-03:00"),
            activeShiftLabel: "P",
            eventAt: new Date("2026-05-03T07:30:00-03:00"),
        }),
        true,
    );
});

test("regras de continuidade: chegadas P futuras nunca herdam plantão antigo (Leo Morais e variantes)", () => {
    // Caso Leo Morais: PR03 P fechado 07:33 BRT, "CB02 P invertido" 19:09 BRT
    // Não há fonte ativa válida porque o plantão fechou; recent-closed também recusa
    // (cross-shift). Nada a herdar.
    const leoEnded = new Date("2026-05-03T07:33:28-03:00");
    const leoEvent = new Date("2026-05-03T19:09:59-03:00");
    assert.equal(shouldLinkRecentClosedTelegramContinuity(leoEvent, leoEnded), false);

    // Variante: doutor esquece de avisar saída, plantão P de ontem ainda aberto, chega
    // hoje à noite anunciando "P invertido" em base diferente. Active stale → não linka.
    assert.equal(
        shouldLinkActiveTelegramContinuitySource({
            activeStartedAt: new Date("2026-05-02T08:00:00-03:00"),
            activeShiftLabel: "P",
            eventAt: new Date("2026-05-03T19:00:00-03:00"),
        }),
        false,
    );

    // Variante: doutor SD de ontem aberto (esquecimento), chega hoje à tarde "PR03 P".
    // Active expirado → não linka.
    assert.equal(
        shouldLinkActiveTelegramContinuitySource({
            activeStartedAt: new Date("2026-05-02T07:30:00-03:00"),
            activeShiftLabel: "SD",
            eventAt: new Date("2026-05-03T15:00:00-03:00"),
        }),
        false,
    );

    // Caminho legítimo: doutor terminou SD agora há 30min e chega na mesma manhã na
    // outra base. Mesma janela operacional, gap pequeno → linka.
    assert.equal(
        shouldLinkRecentClosedTelegramContinuity(
            new Date("2026-05-03T13:00:00-03:00"),
            new Date("2026-05-03T12:30:00-03:00"),
        ),
        true,
    );

    // Caminho legítimo: P em curso, doutor anuncia "P invertido" em outra base 6h depois
    // (ex.: remanejamento real). Active ainda válido → linka (intervenção depois decide
    // se herda continuity_group por shouldInheritContinuityFromOtherBaseOccupancy).
    assert.equal(
        shouldLinkActiveTelegramContinuitySource({
            activeStartedAt: new Date("2026-05-03T07:00:00-03:00"),
            activeShiftLabel: "P",
            eventAt: new Date("2026-05-03T13:00:00-03:00"),
        }),
        true,
    );
});

test("shouldTreatTelegramArrivalAsImplicitReassignment detects same-doctor sparse target switch", () => {
    assert.equal(shouldTreatTelegramArrivalAsImplicitReassignment({
        sector: "REGULATION",
        baseCode: "1368",
        arrivalTime: null,
        shiftType: null,
        roleFunction: null,
        isDeparture: false,
        isContinuation: false,
        isReassignment: false,
        activeSector: "REGULATION",
        activeBaseCode: "1366",
    }), true);
});

test("shouldTreatTelegramArrivalAsImplicitReassignment stays false for explicit new arrival", () => {
    assert.equal(shouldTreatTelegramArrivalAsImplicitReassignment({
        sector: "INTERVENTION",
        baseCode: "PP20",
        arrivalTime: "19:03",
        shiftType: "SN",
        roleFunction: null,
        isDeparture: false,
        isContinuation: false,
        isReassignment: false,
        activeSector: "INTERVENTION",
        activeBaseCode: "PM40",
    }), false);
});

test("resolveTelegramSuccessReplyKind can force reassignment wording for implicit remanejamento", () => {
    assert.equal(resolveTelegramSuccessReplyKind({
        parsed: {
            sector: "REGULATION",
            baseCode: "2035",
            arrivalTime: null,
            shiftType: null,
            roleFunction: null,
            isDeparture: false,
            isContinuation: false,
            isReassignment: false,
        },
        forceReassignment: true,
    }), "reassignment_recorded");
});

test("buildTelegramContinuationSourceHint explicita troca de destino durante continuidade", () => {
    assert.equal(
        buildTelegramContinuationSourceHint({
            continuationFrom: "PM40",
            targetCode: "2153",
            isContinuationReply: true,
        }),
        "\n\n🔁 Mudanca confirmada: *PM40* → *2153* mantendo a mesma continuidade.",
    );

    assert.equal(
        buildTelegramContinuationSourceHint({
            continuationFrom: "2153",
            targetCode: "2153",
            isContinuationReply: true,
        }),
        "",
    );

    assert.equal(
        buildTelegramContinuationSourceHint({
            continuationFrom: "PM40",
            targetCode: "2153",
            isContinuationReply: false,
        }),
        "",
    );
});

test("resolveContinuationShiftStart honors the explicit next-shift boundary instead of snapping to the stale current window", () => {
    assert.equal(
        resolveContinuationShiftStart(
            new Date("2026-04-07T18:33:00-03:00"),
            "SN",
        ).toISOString(),
        new Date("2026-04-07T19:00:00-03:00").toISOString(),
    );

    assert.equal(
        resolveContinuationShiftStart(
            new Date("2026-04-08T06:50:00-03:00"),
            "SD",
        ).toISOString(),
        new Date("2026-04-08T07:00:00-03:00").toISOString(),
    );
});

test("resolveTelegramContinuationStartedAt preserves continuity chain start when available", () => {
    assert.equal(
        resolveTelegramContinuationStartedAt({
            eventAt: new Date("2026-04-16T07:18:00-03:00"),
            shiftType: null,
            continuityStartedAt: new Date("2026-04-15T19:00:00-03:00"),
            sourceStartedAt: new Date("2026-04-15T19:05:00-03:00"),
        }).toISOString(),
        new Date("2026-04-15T19:00:00-03:00").toISOString(),
    );
});

test("resolveTelegramContinuationStartedAt falls back to shift-based start when continuity anchor is invalid", () => {
    assert.equal(
        resolveTelegramContinuationStartedAt({
            eventAt: new Date("2026-04-16T07:18:00-03:00"),
            shiftType: null,
            continuityStartedAt: new Date("2026-04-16T08:10:00-03:00"),
            sourceStartedAt: null,
        }).toISOString(),
        new Date("2026-04-16T07:00:00-03:00").toISOString(),
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

    assert.equal(shouldDeferPendingNameSelectionToFreshParsing("Carolina Tanajura 1363 SN 06:39", [
        {
            id: "carol-1",
            fullName: "Carolina Tanajura",
            displayName: "Carol Tanajura",
            normalizedName: "CAROLINA TANAJURA",
            score: 0,
        },
        {
            id: "carol-2",
            fullName: "Carolina Tavares",
            displayName: "Carol Tavares",
            normalizedName: "CAROLINA TAVARES",
            score: 0,
        },
    ]), true);
});

test("shouldDeferPendingDepartureJustificationToFreshParsing leaves fresh arrivals out of stale departure flow", () => {
    assert.equal(shouldDeferPendingDepartureJustificationToFreshParsing("Laisse chegou na PP20 18:58 SN"), true);
    assert.equal(shouldDeferPendingDepartureJustificationToFreshParsing("Lucio Parada avisou chegada na PR03 07:15 SD"), true);
    assert.equal(shouldDeferPendingDepartureJustificationToFreshParsing("Lucio Parada continuando IT30"), true);
});

test("shouldDeferPendingDepartureJustificationToFreshParsing keeps plain-text reason attached to pending departure", () => {
    assert.equal(shouldDeferPendingDepartureJustificationToFreshParsing("atraso de quem veio render"), false);
    assert.equal(shouldDeferPendingDepartureJustificationToFreshParsing("liberado pela chefia apos ocorrencia"), false);
});

test("shouldDeferPendingDepartureCorrectionToFreshParsing preserves fresh commands and operational relaunches", () => {
    assert.equal(shouldDeferPendingDepartureCorrectionToFreshParsing("/corrigirsaida Joao Pedro 2035"), true);
    assert.equal(shouldDeferPendingDepartureCorrectionToFreshParsing("Laisse chegou na PP20 18:58 SN"), true);
    assert.equal(shouldDeferPendingDepartureCorrectionToFreshParsing("19:05"), false);
    assert.equal(shouldDeferPendingDepartureCorrectionToFreshParsing("atraso de rendicao"), false);
});

test("parseTelegramStandaloneTime extracts bare HH:MM replies", () => {
    assert.equal(parseTelegramStandaloneTime("19:05"), "19:05");
    assert.equal(parseTelegramStandaloneTime("saida real 07:12"), "07:12");
    assert.equal(parseTelegramStandaloneTime("sem horario aqui"), null);
});

test("pickLikelyDepartureCorrectionCandidate chooses the latest unique recent shift and flags close ambiguity", () => {
    const unambiguous = pickLikelyDepartureCorrectionCandidate({
        candidates: [
            makeDepartureCorrectionCandidate({
                occupancyId: "latest",
                targetCode: "2152",
                startedAt: new Date("2026-03-31T10:00:00.000Z"),
                endedAt: new Date("2026-03-31T22:15:00.000Z"),
                actualEndedAt: new Date("2026-03-31T22:05:00.000Z"),
            }),
            makeDepartureCorrectionCandidate({
                occupancyId: "older",
                targetCode: "2035",
                startedAt: new Date("2026-03-30T10:00:00.000Z"),
                endedAt: new Date("2026-03-30T14:00:00.000Z"),
                actualEndedAt: new Date("2026-03-30T14:00:00.000Z"),
            }),
        ],
    });

    assert.equal(unambiguous.candidate?.occupancyId, "latest");
    assert.equal(unambiguous.ambiguousCandidates.length, 0);

    const ambiguous = pickLikelyDepartureCorrectionCandidate({
        candidates: [
            makeDepartureCorrectionCandidate({
                occupancyId: "late-reg",
                domain: "REGULATION",
                targetCode: "2035",
                startedAt: new Date("2026-03-31T10:00:00.000Z"),
                endedAt: new Date("2026-03-31T22:15:00.000Z"),
                actualEndedAt: new Date("2026-03-31T22:05:00.000Z"),
            }),
            makeDepartureCorrectionCandidate({
                occupancyId: "late-int",
                domain: "INTERVENTION",
                targetCode: "PM04",
                startedAt: new Date("2026-03-31T10:00:00.000Z"),
                endedAt: new Date("2026-03-31T20:30:00.000Z"),
                actualEndedAt: new Date("2026-03-31T20:30:00.000Z"),
            }),
        ],
    });

    assert.equal(ambiguous.candidate, null);
    assert.equal(ambiguous.ambiguousCandidates.length, 2);

    const explicitTarget = pickLikelyDepartureCorrectionCandidate({
        candidates: ambiguous.ambiguousCandidates,
        targetCode: "PM04",
    });

    assert.equal(explicitTarget.candidate?.occupancyId, "late-int");
});

test("pickTelegramReply teaches how to justify a late departure", () => {
    const reply = pickTelegramReply("departure_justification_required", 23, {
        name: "Vagner Barroso",
        target: "PR03",
        time: "19:20",
        example: "Vagner Barroso saindo PR03 19:20 porque estava em ocorrência 0729",
    });

    assert.match(reply, /pagamento|banco de horas/i);
    assert.match(reply, /ocorrência 0729|em ocorrência/i);
    assert.match(reply, /higienizando|higienização/i);
    assert.match(reply, /\n\n🚑/u);
    assert.match(reply, /\n\n🧼/u);
    assert.match(reply, /responda só com um desses motivos|responda apenas o motivo|responda aqui só com o motivo/i);
    assert.match(reply, /PR03/);
});

test("pickTelegramReply gives a second chance before blocking automatic credit", () => {
    const reply = pickTelegramReply("departure_justification_retry", 41, {
        name: "Vagner Barroso",
        target: "PR03",
        time: "19:20",
        example: "Vagner Barroso saindo PR03 19:20 porque estava em ocorrência 0729",
    });

    assert.match(reply, /mais uma vez|tentar/i);
    assert.match(reply, /ocorrência|higienização|higienizando/i);
    assert.match(reply, /sem crédito automático|sem pagar banco de horas automaticamente/i);
    assert.match(reply, /chefia/i);
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

test("pickTelegramReply explains when the justification stays only for manual review", () => {
    const reply = pickTelegramReply("departure_justification_manual_review", 33, {
        name: "Vagner Barroso",
        target: "PR03",
        time: "19:20",
    });

    assert.match(reply, /coordenação/i);
    assert.match(reply, /sem crédito automático/i);
    assert.match(reply, /chefia/i);
});

test("resolveTelegramEligibleLateDepartureReason aceita ocorrência com variações e typos", () => {
    assert.equal(
        resolveTelegramEligibleLateDepartureReason("Vagner saindo PR03 19:20 porque estava em ocorrência 0729", ["Vagner", "PR03", "19:20"])?.code,
        "occurrence",
    );
    assert.equal(resolveTelegramEligibleLateDepartureReason("em ocorencia 0729")?.code, "occurrence");
    assert.equal(resolveTelegramEligibleLateDepartureReason("atendendo chamado no local")?.code, "occurrence");
});

test("resolveTelegramEligibleLateDepartureReason aceita higienização com sinônimos e erros de digitação", () => {
    assert.equal(resolveTelegramEligibleLateDepartureReason("estava higienizando a viatura")?.code, "hygienization");
    assert.equal(resolveTelegramEligibleLateDepartureReason("estava higienisando a ambulancia")?.code, "hygienization");
    assert.equal(resolveTelegramEligibleLateDepartureReason("limpeza da viatura")?.code, "hygienization");
});

test("resolveTelegramEligibleLateDepartureReason aceita 'liberado pela chefia' como chief_release e rejeita atraso de redicao", () => {
    assert.equal(resolveTelegramEligibleLateDepartureReason("fui liberado pela chefia")?.code, "chief_release");
    assert.equal(resolveTelegramEligibleLateDepartureReason("liberado chefia")?.code, "chief_release");
    assert.equal(resolveTelegramEligibleLateDepartureReason("chefia liberou")?.code, "chief_release");
    assert.equal(resolveTelegramEligibleLateDepartureReason("atraso de quem veio render"), null);
});

test("resolveTelegramEligibleLateDepartureReason aceita rendicao/troca de unidade como handoff", () => {
    assert.equal(resolveTelegramEligibleLateDepartureReason("motivo: rendição agora")?.code, "handoff");
    assert.equal(resolveTelegramEligibleLateDepartureReason("rendido por Vinicius Raimundo")?.code, "handoff");
    assert.equal(resolveTelegramEligibleLateDepartureReason("finalizando apos troca de unidade")?.code, "handoff");
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
            domain: "INTERVENTION",
            startedAt: new Date("2026-03-26T07:00:00-03:00"),
            scheduledEndAt: new Date("2026-03-26T19:00:00-03:00"),
            endedAt: new Date("2026-03-26T19:01:00-03:00"),
            eventAt: new Date("2026-03-26T19:10:00-03:00"),
            hasSuccessorOccupancy: true,
        }),
        false,
    );

    assert.equal(
        requiresTelegramDepartureAdjustmentJustification({
            domain: "INTERVENTION",
            startedAt: new Date("2026-03-26T07:00:00-03:00"),
            scheduledEndAt: new Date("2026-03-26T19:00:00-03:00"),
            endedAt: new Date("2026-03-26T19:01:00-03:00"),
            eventAt: new Date("2026-03-26T19:40:00-03:00"),
            hasSuccessorOccupancy: true,
        }),
        true,
    );

    assert.equal(
        requiresTelegramDepartureAdjustmentJustification({
            domain: "INTERVENTION",
            startedAt: new Date("2026-04-07T06:50:00-03:00"),
            scheduledEndAt: new Date("2026-04-07T19:00:00-03:00"),
            endedAt: new Date("2026-04-07T08:08:18-03:00"),
            eventAt: new Date("2026-04-07T19:05:00-03:00"),
            hasSuccessorOccupancy: true,
        }),
        false,
    );

    assert.equal(
        requiresTelegramDepartureAdjustmentJustification({
            domain: "INTERVENTION",
            startedAt: new Date("2026-03-26T07:00:00-03:00"),
            scheduledEndAt: new Date("2026-03-26T19:00:00-03:00"),
            endedAt: new Date("2026-03-26T19:01:00-03:00"),
            eventAt: new Date("2026-03-26T19:40:00-03:00"),
            hasSuccessorOccupancy: false,
        }),
        false,
    );

    assert.equal(
        requiresTelegramDepartureAdjustmentJustification({
            domain: "REGULATION",
            startedAt: new Date("2026-03-26T07:00:00-03:00"),
            scheduledEndAt: new Date("2026-03-26T19:15:00-03:00"),
            endedAt: new Date("2026-03-26T19:01:00-03:00"),
            eventAt: new Date("2026-03-26T19:10:00-03:00"),
            hasSuccessorOccupancy: true,
        }),
        false,
    );

    assert.equal(
        requiresTelegramDepartureAdjustmentJustification({
            domain: "REGULATION",
            startedAt: new Date("2026-03-26T07:00:00-03:00"),
            scheduledEndAt: new Date("2026-03-26T19:15:00-03:00"),
            endedAt: new Date("2026-03-26T19:01:00-03:00"),
            eventAt: new Date("2026-03-26T19:20:00-03:00"),
            hasSuccessorOccupancy: true,
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