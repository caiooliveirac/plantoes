import assert from "node:assert/strict";
import test from "node:test";
import {
    hasPlannedInterventionCoverageForCurrentShift,
    requiresOvertimeJustification,
    resolveContinuationBadgeLabel,
    resolveImplicitOccupancyExpiry,
    resolveOvertimeJustificationThreshold,
    resolveOperationalShiftLabel,
    shouldHighlightInterventionVerification,
    shouldKeepRegulationOccupancyVisible,
} from "@/modules/operational/board-rules";
import { resolveContinuationBoardStartedAt } from "@/modules/intervention/service";
import { inferInterventionCoverageWindow, inferInterventionScheduledEndAt, inferOperationalScheduledStartAt, inferRegulationCoverageWindow, inferRegulationScheduledEndAt, resolveTelegramEventTime } from "@/modules/operational/rules";
import { isCasualTelegramMessage, parseMessage, parseMessageMulti, parseTelegramBatchLines } from "@/modules/telegram/parser";

test("resolves operational shift label at 07h and 19h Sao Paulo", () => {
    assert.equal(resolveOperationalShiftLabel(new Date("2026-03-25T07:00:00-03:00")), "SD");
    assert.equal(resolveOperationalShiftLabel(new Date("2026-03-25T18:59:00-03:00")), "SD");
    assert.equal(resolveOperationalShiftLabel(new Date("2026-03-25T19:00:00-03:00")), "SN");
    assert.equal(resolveOperationalShiftLabel(new Date("2026-03-26T06:59:00-03:00")), "SN");
});

test("flags intervention doctor from previous shift for verification at 19h boundary", () => {
    assert.equal(
        shouldHighlightInterventionVerification(
            new Date("2026-03-25T08:18:00-03:00"),
            new Date("2026-03-25T19:05:00-03:00"),
        ),
        true,
    );

    assert.equal(
        shouldHighlightInterventionVerification(
            new Date("2026-03-25T19:08:00-03:00"),
            new Date("2026-03-26T07:05:00-03:00"),
        ),
        true,
    );

    assert.equal(
        shouldHighlightInterventionVerification(
            new Date("2026-03-26T07:04:00-03:00"),
            new Date("2026-03-26T07:05:00-03:00"),
        ),
        false,
    );

    assert.equal(
        shouldHighlightInterventionVerification(
            new Date("2026-03-25T18:10:00-03:00"),
            new Date("2026-03-25T19:05:00-03:00"),
        ),
        false,
    );

    assert.equal(
        shouldHighlightInterventionVerification(
            new Date("2026-03-26T06:20:00-03:00"),
            new Date("2026-03-26T07:05:00-03:00"),
        ),
        false,
    );

    assert.equal(
        shouldHighlightInterventionVerification(
            new Date("2026-03-25T08:18:00-03:00"),
            new Date("2026-03-25T19:05:00-03:00"),
            "P",
        ),
        false,
    );

    assert.equal(
        shouldHighlightInterventionVerification(
            new Date("2026-03-25T08:18:00-03:00"),
            new Date("2026-03-26T07:31:00-03:00"),
            "P",
        ),
        true,
    );
});

test("hides regulation carry-over after boundary unless doctor declared P", () => {
    assert.equal(
        shouldKeepRegulationOccupancyVisible({
            startedAt: new Date("2026-03-25T08:18:00-03:00"),
            shiftLabel: "SD",
            reference: new Date("2026-03-25T19:01:00-03:00"),
        }),
        true,
    );

    assert.equal(
        shouldKeepRegulationOccupancyVisible({
            startedAt: new Date("2026-03-25T08:18:00-03:00"),
            shiftLabel: "SD",
            reference: new Date("2026-03-25T19:15:00-03:00"),
        }),
        false,
    );

    assert.equal(
        shouldKeepRegulationOccupancyVisible({
            startedAt: new Date("2026-03-25T07:00:00-03:00"),
            shiftLabel: "P",
            reference: new Date("2026-03-25T19:10:00-03:00"),
        }),
        true,
    );

    assert.equal(
        shouldKeepRegulationOccupancyVisible({
            startedAt: new Date("2026-03-25T19:00:00-03:00"),
            shiftLabel: "P",
            reference: new Date("2026-03-26T06:59:00-03:00"),
        }),
        true,
    );

    assert.equal(
        shouldKeepRegulationOccupancyVisible({
            startedAt: new Date("2026-03-25T19:00:00-03:00"),
            shiftLabel: "P",
            reference: new Date("2026-03-26T07:01:00-03:00"),
        }),
        true,
    );

    assert.equal(
        shouldKeepRegulationOccupancyVisible({
            startedAt: new Date("2026-03-25T19:00:00-03:00"),
            shiftLabel: "P",
            reference: new Date("2026-03-26T07:15:00-03:00"),
        }),
        false,
    );

    assert.equal(
        shouldKeepRegulationOccupancyVisible({
            startedAt: new Date("2026-03-25T18:15:00-03:00"),
            shiftLabel: "SN",
            reference: new Date("2026-03-25T19:01:00-03:00"),
        }),
        true,
    );

    assert.equal(
        shouldKeepRegulationOccupancyVisible({
            startedAt: new Date("2026-03-26T06:10:00-03:00"),
            shiftLabel: "SD",
            reference: new Date("2026-03-26T07:01:00-03:00"),
        }),
        true,
    );
});

test("resolveImplicitOccupancyExpiry uses base boundary for non-P and full span for P", () => {
    assert.equal(
        resolveImplicitOccupancyExpiry(new Date("2026-03-25T07:12:00-03:00"), "SD")?.toISOString(),
        new Date("2026-03-25T19:00:00-03:00").toISOString(),
    );

    assert.equal(
        resolveImplicitOccupancyExpiry(new Date("2026-03-25T19:02:00-03:00"), "SN")?.toISOString(),
        new Date("2026-03-26T07:00:00-03:00").toISOString(),
    );

    assert.equal(
        resolveImplicitOccupancyExpiry(new Date("2026-03-25T07:12:00-03:00"), "P")?.toISOString(),
        new Date("2026-03-26T07:00:00-03:00").toISOString(),
    );
});

test("shows continuation badge only in the verification grace window", () => {
    assert.equal(resolveContinuationBadgeLabel({
        startedAt: new Date("2026-03-25T07:00:00-03:00"),
        shiftLabel: "P",
        reference: new Date("2026-03-25T19:10:00-03:00"),
    }), "Continua as 19:00");

    assert.equal(resolveContinuationBadgeLabel({
        startedAt: new Date("2026-03-25T07:00:00-03:00"),
        shiftLabel: "P",
        reference: new Date("2026-03-25T19:31:00-03:00"),
    }), null);

    assert.equal(resolveContinuationBadgeLabel({
        startedAt: new Date("2026-03-25T19:00:00-03:00"),
        shiftLabel: "P",
        reference: new Date("2026-03-26T07:10:00-03:00"),
    }), "Continua as 07:00");

    assert.equal(resolveContinuationBadgeLabel({
        startedAt: new Date("2026-03-25T07:00:00-03:00"),
        shiftLabel: "P",
        reference: new Date("2026-03-26T07:10:00-03:00"),
    }), "Continua as 07:00");
});

test("resolveContinuationBoardStartedAt avanca o marcador do quadro para o turno corrente", () => {
    assert.equal(
        resolveContinuationBoardStartedAt({
            startedAt: new Date("2026-03-25T19:28:00-03:00"),
            boardStartedAt: new Date("2026-03-25T19:28:00-03:00"),
            continuedAt: new Date("2026-03-26T11:54:00-03:00"),
        }).toISOString(),
        new Date("2026-03-26T07:00:00-03:00").toISOString(),
    );

    assert.equal(
        resolveContinuationBoardStartedAt({
            startedAt: new Date("2026-03-25T19:28:00-03:00"),
            boardStartedAt: new Date("2026-03-25T19:28:00-03:00"),
            continuedAt: new Date("2026-03-25T23:08:00-03:00"),
        }).toISOString(),
        new Date("2026-03-25T19:28:00-03:00").toISOString(),
    );
});

test("requires written justification from 07:15 or 19:15 onward", () => {
    assert.equal(
        resolveOvertimeJustificationThreshold(new Date("2026-03-25T07:00:00-03:00"))?.toISOString(),
        new Date("2026-03-25T19:15:00-03:00").toISOString(),
    );

    assert.equal(
        requiresOvertimeJustification(
            new Date("2026-03-25T07:00:00-03:00"),
            new Date("2026-03-25T19:14:00-03:00"),
        ),
        false,
    );

    assert.equal(
        requiresOvertimeJustification(
            new Date("2026-03-25T07:00:00-03:00"),
            new Date("2026-03-25T19:15:00-03:00"),
        ),
        true,
    );
});

test("infers SD regulation cutoff at 19:15 local operational time", () => {
    const result = inferRegulationScheduledEndAt(
        new Date("2026-03-25T07:03:00-03:00"),
        "SD",
        null,
    );

    assert.equal(result?.toISOString(), new Date("2026-03-25T19:15:00-03:00").toISOString());
});

test("infers SD regulation start at 07:00 local operational time", () => {
    const result = inferOperationalScheduledStartAt(
        new Date("2026-03-25T07:25:00-03:00"),
        "SD",
        null,
    );

    assert.equal(result?.toISOString(), new Date("2026-03-25T07:00:00-03:00").toISOString());
});

test("infers SN regulation start at 19:00 of the previous local day when arrival happens after midnight", () => {
    const result = inferOperationalScheduledStartAt(
        new Date("2026-03-26T00:20:00-03:00"),
        "SN",
        null,
    );

    assert.equal(result?.toISOString(), new Date("2026-03-25T19:00:00-03:00").toISOString());
});

test("infers SN regulation cutoff at 07:15 on next local operational day", () => {
    const result = inferRegulationScheduledEndAt(
        new Date("2026-03-25T19:02:00-03:00"),
        "SN",
        null,
    );

    assert.equal(result?.toISOString(), new Date("2026-03-26T07:15:00-03:00").toISOString());
});

test("infers intervention SN cutoff at 07:00 on next local operational day", () => {
    const result = inferInterventionScheduledEndAt(
        new Date("2026-03-25T19:02:00-03:00"),
        "SN",
        null,
    );

    assert.equal(result?.toISOString(), new Date("2026-03-26T07:00:00-03:00").toISOString());
});

test("resolves Telegram explicit HH:mm on the same local operational day", () => {
    const result = resolveTelegramEventTime(
        new Date("2026-03-25T07:40:00-03:00"),
        "07:15",
    );

    assert.equal(result.toISOString(), new Date("2026-03-25T07:15:00-03:00").toISOString());
});

test("resolves Telegram explicit early-morning HH:mm to the next local day when sent late at night", () => {
    const result = resolveTelegramEventTime(
        new Date("2026-03-25T23:30:00-03:00"),
        "06:00",
    );

    assert.equal(result.toISOString(), new Date("2026-03-26T06:00:00-03:00").toISOString());
});

test("resolves Telegram explicit 07:00 to the next local day after the night-shift boundary", () => {
    const result = resolveTelegramEventTime(
        new Date("2026-03-25T19:05:00-03:00"),
        "07:00",
    );

    assert.equal(result.toISOString(), new Date("2026-03-26T07:00:00-03:00").toISOString());
});

test("parses free-text regulation arrival", () => {
    const parsed = parseMessage("Bom dia, cheguei no ramal 2031 SD");

    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2031");
    assert.equal(parsed.shiftType, "SD");
    assert.equal(parsed.isDeparture, false);
});

test("parses continuation wording without explicit P as continuation", () => {
    const parsed = parseMessage("Taiane Pinto continua BR05 19:00");

    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "BR05");
    assert.equal(parsed.isContinuation, true);
    assert.equal(parsed.isDeparture, false);
});

test("classifies simple greetings as casual conversation", () => {
    assert.equal(isCasualTelegramMessage("Bom dia, pessoal"), true);
    assert.equal(isCasualTelegramMessage("Oi, tudo bem por ai?"), true);
    assert.equal(isCasualTelegramMessage("Bom plantao a todos"), true);
});

test("does not classify operational messages as casual conversation", () => {
    assert.equal(isCasualTelegramMessage("Bom dia, cheguei no ramal 2031 SD"), false);
    assert.equal(isCasualTelegramMessage("Boa noite, saindo da 40 agora"), false);
    assert.equal(isCasualTelegramMessage("Oi, Marcela PM04 20:00 P"), false);
});

test("parses intervention departure by numeric base alias", () => {
    const parsed = parseMessage("Saindo da 20 agora");

    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "PP20");
    assert.equal(parsed.isDeparture, true);
});

test("parses intervention SN handoff with alphanumeric base", () => {
    const parsed = parseMessage("Uenderson SM01 19:50 SN");

    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "SM01");
    assert.equal(parsed.arrivalTime, "19:50");
    assert.equal(parsed.shiftType, "SN");
    assert.equal(parsed.isDeparture, false);
    assert.deepEqual(parsed.extractedNames, ["Uenderson"]);
});

test("parses intervention SD handoff with explicit HH:mm", () => {
    const parsed = parseMessage("Yuri PR03 07:15 SD");

    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "PR03");
    assert.equal(parsed.arrivalTime, "07:15");
    assert.equal(parsed.shiftType, "SD");
    assert.equal(parsed.isDeparture, false);
    assert.deepEqual(parsed.extractedNames, ["Yuri"]);
});

test("parses intervention P shift with numeric base alias and 07h format", () => {
    const parsed = parseMessage("Larissa Rocha 60 07h P");

    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "BR60");
    assert.equal(parsed.arrivalTime, "07:00");
    assert.equal(parsed.shiftType, "P");
    assert.equal(parsed.isDeparture, false);
    assert.equal(parsed.isContinuation, false);
    assert.deepEqual(parsed.extractedNames, ["Larissa Rocha"]);
});

test("parses intervention continuation message without polluting the doctor name", () => {
    const parsed = parseMessage("Briang Seguir na PM04 - continua.");

    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "PM04");
    assert.equal(parsed.isDeparture, false);
    assert.deepEqual(parsed.extractedNames, ["Briang"]);
});

test("parses intervention arrival with prepositions around the base and time", () => {
    const parsed = parseMessage("João Paulo Almeida na CZ50 às 19:00h");

    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "CZ50");
    assert.equal(parsed.arrivalTime, "19:00");
    assert.deepEqual(parsed.extractedNames, ["João Paulo Almeida"]);
});

test("strips greeting words from the extracted doctor name", () => {
    const parsed = parseMessage("Bom dia, Gabriel na 50");

    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "CZ50");
    assert.deepEqual(parsed.extractedNames, ["Gabriel"]);
});

test("parses multiline intervention arrival carrying name and time across lines", () => {
    const parsed = parseMessageMulti("Lucas Albuquerque\nChegada a BR 60 sn\n19:09")[0];

    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "BR60");
    assert.equal(parsed.arrivalTime, "19:09");
    assert.equal(parsed.shiftType, "SN");
    assert.equal(parsed.isDeparture, false);
    assert.deepEqual(parsed.extractedNames, ["Lucas Albuquerque"]);
});

test("parses intervention arrival by short alias with sender-style wording", () => {
    const parsed = parseMessage("Bia na 05");

    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "BR05");
    assert.equal(parsed.isDeparture, false);
    assert.deepEqual(parsed.extractedNames, ["Bia"]);
});

test("parses intervention departure in free text without leaking filler words into the name", () => {
    const parsed = parseMessage("Saindo da 40 só agora");

    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "PM40");
    assert.equal(parsed.isDeparture, true);
    assert.deepEqual(parsed.extractedNames, []);
});

test("parses intervention continuation without treating continuation word as a doctor name", () => {
    const parsed = parseMessage("Continuo na 30");

    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "IT30");
    assert.equal(parsed.isDeparture, false);
    assert.deepEqual(parsed.extractedNames, []);
});

test("parses transfer destination as intervention arrival instead of departure", () => {
    const parsed = parseMessage("Saída da CRU 19:00, deslocando para CB02");

    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "CB02");
    assert.equal(parsed.arrivalTime, "19:00");
    assert.equal(parsed.isDeparture, false);
    assert.deepEqual(parsed.extractedNames, []);
});

test("parses intervention P shift with bare base alias and explicit time", () => {
    const parsed = parseMessage("Marcela na 04 20:35 P");

    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "PM04");
    assert.equal(parsed.arrivalTime, "20:35");
    assert.equal(parsed.shiftType, "P");
    assert.equal(parsed.isDeparture, false);
    assert.equal(parsed.isContinuation, false);
    assert.deepEqual(parsed.extractedNames, ["Marcela"]);
});

test("inferInterventionCoverageWindow extends explicit P through the next shift", () => {
    const dayShift = inferInterventionCoverageWindow({
        startedAt: new Date("2026-03-25T07:25:00-03:00"),
        shiftLabel: "P",
    });

    assert.equal(dayShift.scheduledStartAt?.toISOString(), new Date("2026-03-25T07:00:00-03:00").toISOString());
    assert.equal(dayShift.scheduledEndAt?.toISOString(), new Date("2026-03-26T07:00:00-03:00").toISOString());

    const nightShift = inferInterventionCoverageWindow({
        startedAt: new Date("2026-03-25T19:12:00-03:00"),
        shiftLabel: "P",
    });

    assert.equal(nightShift.scheduledStartAt?.toISOString(), new Date("2026-03-25T19:00:00-03:00").toISOString());
    assert.equal(nightShift.scheduledEndAt?.toISOString(), new Date("2026-03-26T19:00:00-03:00").toISOString());
});

test("inferRegulationCoverageWindow extends explicit P through the next shift", () => {
    const dayShift = inferRegulationCoverageWindow({
        startedAt: new Date("2026-03-25T07:25:00-03:00"),
        shiftLabel: "P",
    });

    assert.equal(dayShift.scheduledStartAt?.toISOString(), new Date("2026-03-25T07:00:00-03:00").toISOString());
    assert.equal(dayShift.scheduledEndAt?.toISOString(), new Date("2026-03-26T07:15:00-03:00").toISOString());

    const nightShift = inferRegulationCoverageWindow({
        startedAt: new Date("2026-03-25T19:12:00-03:00"),
        shiftLabel: "P",
    });

    assert.equal(nightShift.scheduledStartAt?.toISOString(), new Date("2026-03-25T19:00:00-03:00").toISOString());
    assert.equal(nightShift.scheduledEndAt?.toISOString(), new Date("2026-03-26T19:15:00-03:00").toISOString());
});

test("hasPlannedInterventionCoverageForCurrentShift suppresses next-boundary verification for explicit P", () => {
    assert.equal(hasPlannedInterventionCoverageForCurrentShift({
        shiftLabel: "P",
        scheduledEndAt: new Date("2026-03-26T07:00:00-03:00"),
        reference: new Date("2026-03-25T19:10:00-03:00"),
    }), true);

    assert.equal(hasPlannedInterventionCoverageForCurrentShift({
        shiftLabel: "P",
        scheduledEndAt: new Date("2026-03-25T19:00:00-03:00"),
        reference: new Date("2026-03-25T19:10:00-03:00"),
    }), false);
});

test("parses pasted batch lines ignoring headings and separators", () => {
    const lines = parseTelegramBatchLines(`REGULACAO

FELIPE CARVALHO 2031 07:00
MARIA AUGUSTA 1322 07:40

⸻

INTERVENCAO
VINICIUS JESUS CZ50 CONT.
CAIO OLIVEIRA IT30 06:54`);

    assert.equal(lines.length, 4);
    assert.equal(lines[0]?.headingSector, "REGULATION");
    assert.equal(lines[0]?.parsed.baseCode, "2031");
    assert.equal(lines[1]?.parsed.baseCode, "1322");
    assert.equal(lines[2]?.headingSector, "INTERVENTION");
    assert.equal(lines[2]?.parsed.baseCode, "CZ50");
    assert.equal(lines[2]?.parsed.isContinuation, true);
    assert.equal(lines[3]?.parsed.baseCode, "IT30");
});

test("parses CONT abbreviation as intervention continuation", () => {
    const parsed = parseMessage("Vinicius Jesus CZ50 CONT.");

    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "CZ50");
    assert.equal(parsed.isContinuation, true);
    assert.equal(parsed.isDeparture, false);
    assert.deepEqual(parsed.extractedNames, ["Vinicius Jesus"]);
});