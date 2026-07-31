import assert from "node:assert/strict";
import test from "node:test";
import {
    hasPlannedInterventionCoverageForCurrentShift,
    isSameOperationalShiftArrival,
    requiresOvertimeJustification,
    resolveArrivalShiftLabel,
    resolveContinuationBadgeLabel,
    resolveImplicitOccupancyExpiry,
    resolveInterventionLineState,
    resolveOccupancyDirection,
    resolveOvertimeJustificationThreshold,
    resolveOperationalShiftLabel,
    shouldHighlightInterventionVerification,
    shouldKeepRegulationOccupancyVisible,
} from "@/modules/operational/board-rules";
import { resolveContinuationBoardStartedAt } from "@/modules/intervention/service";
import { resolveRegulationContinuationExplicitScheduledEndAt, resolveRegulationContinuationScheduledEndAt } from "@/modules/regulation/service";
import { dedupeOperationalIdentityLabels, describeFixedRoleTransferImpact, isOperationalRoleRemovalSentinel, resolveOperationalRoleLabel } from "@/modules/operational/roles";
import { inferInterventionCoverageWindow, inferInterventionScheduledEndAt, inferOperationalScheduledStartAt, inferRegulationCoverageWindow, inferRegulationScheduledEndAt, normalizeArrivalEventTime, resolveContinuationReferenceBoundary, resolveForcedDayEventTime, resolveInterventionContinuationScheduledEndAt, resolveTelegramEventTime } from "@/modules/operational/rules";
import { isCasualTelegramMessage, looksLikeDepartureMessage, looksLikeOperationalMetaConversation, parseMessage, parseMessageMulti, parseTelegramBatchLines } from "@/modules/telegram/parser";
import { buildLocationWithoutRamalReply, detectLocationWithoutRamal } from "@/modules/telegram/service";

test("describeFixedRoleTransferImpact: remanejar nao-COI para 1368 sinaliza COI remoto", () => {
    const impact = describeFixedRoleTransferImpact({
        targetDomain: "regulation",
        targetCode: "1368",
        shiftLabel: "SD",
        currentRole: "MRV",
    });
    assert.equal(impact?.forcedRole, "COI");
    assert.equal(impact?.leavesPresentialMealQueue, true);
});

test("describeFixedRoleTransferImpact: quem ja e COI movido entre 1367/1368 nao gera aviso", () => {
    assert.equal(
        describeFixedRoleTransferImpact({
            targetDomain: "regulation",
            targetCode: "1368",
            shiftLabel: "SD",
            currentRole: "COI",
        }),
        null,
    );
});

test("describeFixedRoleTransferImpact: destino sem papel fixo nao gera aviso", () => {
    assert.equal(
        describeFixedRoleTransferImpact({
            targetDomain: "regulation",
            targetCode: "2035",
            shiftLabel: "SD",
            currentRole: "MRV",
        }),
        null,
    );
    // Intervencao nunca forca papel fixo, mesmo com code que casaria em regulacao.
    assert.equal(
        describeFixedRoleTransferImpact({
            targetDomain: "intervention",
            targetCode: "1368",
            shiftLabel: "SD",
            currentRole: "MRV",
        }),
        null,
    );
});

test("describeFixedRoleTransferImpact: 2031 (CP) e fixo mas nao e remoto", () => {
    const impact = describeFixedRoleTransferImpact({
        targetDomain: "regulation",
        targetCode: "2031",
        shiftLabel: "SD",
        currentRole: "MRV",
    });
    assert.equal(impact?.forcedRole, "CP");
    assert.equal(impact?.leavesPresentialMealQueue, false);
});

test("resolves operational shift label at 07h and 19h Sao Paulo", () => {
    assert.equal(resolveOperationalShiftLabel(new Date("2026-03-25T07:00:00-03:00")), "SD");
    assert.equal(resolveOperationalShiftLabel(new Date("2026-03-25T18:59:00-03:00")), "SD");
    assert.equal(resolveOperationalShiftLabel(new Date("2026-03-25T19:00:00-03:00")), "SN");
    assert.equal(resolveOperationalShiftLabel(new Date("2026-03-26T06:59:00-03:00")), "SN");
});

test("resolveOccupancyDirection: classifica saindo vs entrando na virada das 19h (UTC-3)", () => {
    // "agora" = 19:05, ja na SN: turno do dia (SD) encerrou as 19:00.
    const reference = "2026-03-25T19:05:00-03:00";

    // Quem chegou de manha (SD) esta SAINDO; shiftEndAt = inicio do turno atual (19:00).
    const saindoManha = resolveOccupancyDirection({
        startedAt: "2026-03-25T06:50:00-03:00",
        scheduledEndAt: null,
        shiftLabel: "SD",
        reference,
    });
    assert.equal(saindoManha.status, "saindo");
    assert.equal(saindoManha.shiftEndAt, new Date("2026-03-25T19:00:00-03:00").toISOString());

    // Quem acabou de chegar (19:04) esta ENTRANDO no plantao da noite.
    assert.equal(resolveOccupancyDirection({
        startedAt: "2026-03-25T19:04:00-03:00",
        scheduledEndAt: null,
        shiftLabel: "SN",
        reference,
    }).status, "entrando");

    // Chegada adiantada (18:53), dentro da tolerancia de 60 min, conta como ENTRANDO.
    assert.equal(resolveOccupancyDirection({
        startedAt: "2026-03-25T18:53:00-03:00",
        scheduledEndAt: null,
        shiftLabel: "SN",
        reference,
    }).status, "entrando");
});

test("REGRESSAO Caio 2152: chegada adiantada declarada SD nao vira VERIFICAR/Retirar as 07:00", () => {
    // Caso real 2026-07-18: "Caio 2152 SD" as 05:07 (alem dos 60 min de tolerancia
    // pre-turno), agendado inferido 07:00→19:15. O quadro marcava "saindo" na
    // virada — como se ele fosse sobra do SN — e a chefia chegou a remove-lo.
    // Label explicito do turno corrente + cobertura agendada = titular do SD.
    const caio = {
        startedAt: "2026-07-18T05:07:20-03:00",
        scheduledEndAt: "2026-07-18T19:15:00-03:00",
        shiftLabel: "SD" as const,
    };

    // Nao importa a hora do aviso: as 07:05, 09:00 ou 15:00, ele e o titular.
    for (const reference of ["2026-07-18T07:05:00-03:00", "2026-07-18T09:00:00-03:00", "2026-07-18T15:00:00-03:00"]) {
        assert.equal(resolveOccupancyDirection({ ...caio, reference }).status, "entrando", `saindo indevido as ${reference}`);
        assert.equal(resolveInterventionLineState({ ...caio, boardStartedAt: caio.startedAt, reference }).kind, "none");
    }

    // O caso oposto segue protegido: um SD de ONTEM ainda aberto hoje de manha
    // tem o mesmo label do turno corrente, mas cobertura vencida → "saindo".
    assert.equal(resolveOccupancyDirection({
        startedAt: "2026-07-17T06:58:00-03:00",
        scheduledEndAt: "2026-07-17T19:15:00-03:00",
        shiftLabel: "SD",
        reference: "2026-07-18T08:00:00-03:00",
    }).status, "saindo");

    // E a sobra real do SN na virada da manha continua "saindo".
    assert.equal(resolveOccupancyDirection({
        startedAt: "2026-07-17T18:57:00-03:00",
        scheduledEndAt: "2026-07-18T07:15:00-03:00",
        shiftLabel: "SN",
        reference: "2026-07-18T07:20:00-03:00",
    }).status, "saindo");
});

test("resolveInterventionLineState: CONTINUA so para quem comecou em turno anterior e atravessou a virada", () => {
    // Cenario Leo Morais: chegou ontem 19:01 (SN), continuou para o SD de hoje
    // (scheduledEndAt = hoje 19:00). Agora 08:13 (SD): atravessou a virada -> CONTINUA.
    assert.equal(resolveInterventionLineState({
        startedAt: "2026-05-31T19:01:00-03:00",
        boardStartedAt: "2026-05-31T19:01:00-03:00",
        scheduledEndAt: "2026-06-01T19:00:00-03:00",
        shiftLabel: "P",
        reference: "2026-06-01T08:13:00-03:00",
    }).kind, "continua");
});

test("resolveInterventionLineState: quem chegou no turno atual NAO mostra CONTINUA mesmo com P e fim futuro", () => {
    // Cenario PR03/CN10/IT30/BR60: chegou hoje 07:00, marcado P com fim amanha 07:00.
    // Comecou DENTRO do turno atual -> so chegou -> none (nao continua nada).
    assert.equal(resolveInterventionLineState({
        startedAt: "2026-06-01T07:00:00-03:00",
        boardStartedAt: "2026-06-01T07:00:00-03:00",
        scheduledEndAt: "2026-06-02T07:00:00-03:00",
        shiftLabel: "P",
        reference: "2026-06-01T08:13:00-03:00",
    }).kind, "none");
    // Chegada adiantada (06:56), dentro da tolerancia de 60 min do turno atual: tambem none.
    assert.equal(resolveInterventionLineState({
        startedAt: "2026-06-01T06:56:00-03:00",
        boardStartedAt: "2026-06-01T06:56:00-03:00",
        scheduledEndAt: "2026-06-02T07:00:00-03:00",
        shiftLabel: "P",
        reference: "2026-06-01T08:13:00-03:00",
    }).kind, "none");
});

test("resolveInterventionLineState: BUG 1 - continuidade expirada (P, scheduledEndAt no passado) vira saindo", () => {
    // Chegou ONTEM de manha, continuou para a noite de ontem (scheduledEndAt = ontem 19:00).
    // Hoje de manha (07:05) a continuidade ja se resolveu: deve sair, nao mostrar CONTINUA.
    const state = resolveInterventionLineState({
        startedAt: "2026-03-24T06:59:00-03:00",
        boardStartedAt: "2026-03-24T06:59:00-03:00",
        scheduledEndAt: "2026-03-24T19:00:00-03:00",
        shiftLabel: "P",
        reference: "2026-03-25T07:05:00-03:00",
    });
    assert.equal(state.kind, "saindo");
    assert.equal(state.kind === "saindo" && state.shiftEndAt, new Date("2026-03-25T07:00:00-03:00").toISOString());
});

test("resolveInterventionLineState: BUG 2 - turno anterior recebe saindo de forma uniforme (P ou nao-P)", () => {
    const reference = "2026-03-25T07:05:00-03:00"; // manha seguinte, ja na SD
    // Pessoa do turno noturno que NUNCA continuou (shiftLabel SN).
    assert.equal(resolveInterventionLineState({
        startedAt: "2026-03-24T19:01:00-03:00",
        boardStartedAt: "2026-03-24T19:01:00-03:00",
        scheduledEndAt: null,
        shiftLabel: "SN",
        reference,
    }).kind, "saindo");
    // Pessoa do turno noturno marcada como P mas com continuidade ja expirada: mesmo tratamento.
    assert.equal(resolveInterventionLineState({
        startedAt: "2026-03-24T19:01:00-03:00",
        boardStartedAt: "2026-03-24T19:01:00-03:00",
        scheduledEndAt: "2026-03-25T07:00:00-03:00",
        shiftLabel: "P",
        reference,
    }).kind, "saindo");
});

test("resolveInterventionLineState: chegada do turno atual nao recebe acao (entrando)", () => {
    // Chegou as 19:02, agora sao 19:10 do mesmo dia: turno atual, sem acao.
    assert.equal(resolveInterventionLineState({
        startedAt: "2026-03-25T19:02:00-03:00",
        boardStartedAt: "2026-03-25T19:02:00-03:00",
        scheduledEndAt: null,
        shiftLabel: "SN",
        reference: "2026-03-25T19:10:00-03:00",
    }).kind, "none");
});

test("resolveOccupancyDirection: cobertura planejada (P) que cobre o turno atual nao e tratada como saindo", () => {
    const reference = "2026-03-25T19:05:00-03:00";
    // Plantonista prolongado que comprometeu cobertura ate depois da virada: esta permanecendo.
    assert.equal(resolveOccupancyDirection({
        startedAt: "2026-03-25T07:00:00-03:00",
        scheduledEndAt: "2026-03-26T07:00:00-03:00",
        shiftLabel: "P",
        reference,
    }).status, "entrando");
});

test("keeps basal MRV on 2032/2151 only on SD and allows explicit override", () => {
    assert.equal(resolveOperationalRoleLabel({
        domain: "regulation",
        code: "2151",
        shiftLabel: "SD",
        roleLabel: null,
        defaultRole: null,
    }), "MRV");

    assert.equal(resolveOperationalRoleLabel({
        domain: "regulation",
        code: "2032",
        shiftLabel: "SD",
        roleLabel: null,
        defaultRole: null,
    }), "MRV");

    assert.equal(resolveOperationalRoleLabel({
        domain: "regulation",
        code: "2032",
        shiftLabel: "P",
        roleLabel: null,
        defaultRole: null,
    }), null);

    assert.equal(resolveOperationalRoleLabel({
        domain: "regulation",
        code: "2151",
        shiftLabel: "SN",
        roleLabel: null,
        defaultRole: null,
    }), null);

    assert.equal(resolveOperationalRoleLabel({
        domain: "regulation",
        code: "2032",
        shiftLabel: "SD",
        roleLabel: "SEM_FUNCAO",
        defaultRole: null,
    }), null);

    assert.equal(resolveOperationalRoleLabel({
        domain: "regulation",
        code: "2032",
        shiftLabel: "SD",
        roleLabel: "MRV",
        defaultRole: null,
    }), "MRV");
});

test("keeps explicit MEIO_PLANTAO even on fixed-role ramais", () => {
    assert.equal(resolveOperationalRoleLabel({
        domain: "regulation",
        code: "2032",
        shiftLabel: "SD",
        roleLabel: "MEIO_PLANTAO",
        defaultRole: null,
    }), "MEIO_PLANTAO");

    assert.equal(resolveOperationalRoleLabel({
        domain: "regulation",
        code: "2151",
        shiftLabel: "SD",
        roleLabel: "MEIO_PLANTAO",
        defaultRole: null,
    }), "MEIO_PLANTAO");

    assert.equal(resolveOperationalRoleLabel({
        domain: "regulation",
        code: "1367",
        shiftLabel: "SD",
        roleLabel: "MEIO_PLANTAO",
        defaultRole: null,
    }), "MEIO_PLANTAO");
});

test("dedupeOperationalIdentityLabels never duplicates MRV/RECIP tags", () => {
    assert.deepEqual(
        dedupeOperationalIdentityLabels(["MRV", "mrv", "RECIP", "RECIP", null, ""]),
        ["MRV", "RECIP"],
    );
});

test("isOperationalRoleRemovalSentinel detects explicit 'Nenhuma' override", () => {
    assert.equal(isOperationalRoleRemovalSentinel("SEM_FUNCAO"), true);
    assert.equal(isOperationalRoleRemovalSentinel("sem_funcao"), true);
    assert.equal(isOperationalRoleRemovalSentinel("MRV"), false);
    assert.equal(isOperationalRoleRemovalSentinel(null), false);
});

test("falls back to post default role on non-fixed regulation ramal and keeps explicit overrides", () => {
    assert.equal(resolveOperationalRoleLabel({
        domain: "regulation",
        code: "1363",
        shiftLabel: "SD",
        roleLabel: null,
        defaultRole: "MR",
    }), "MR");

    assert.equal(resolveOperationalRoleLabel({
        domain: "regulation",
        code: "1363",
        shiftLabel: "SD",
        roleLabel: "RMT",
        defaultRole: "MR",
    }), "RMT");

    assert.equal(resolveOperationalRoleLabel({
        domain: "regulation",
        code: "1363",
        shiftLabel: "SD",
        roleLabel: "IES",
        defaultRole: "MR",
    }), "IES");
});

test("regulation post defaultRole=RMT is inherited when no explicit role is given", () => {
    // Scenario: Emily Thais or Malcom arrive at ramal 1363 (default_role=RMT) without saying "RMT"
    assert.equal(resolveOperationalRoleLabel({
        domain: "regulation",
        code: "1363",
        shiftLabel: "P",
        roleLabel: null,
        defaultRole: "RMT",
    }), "RMT");

    // Explicit IES overrides defaultRole=RMT
    assert.equal(resolveOperationalRoleLabel({
        domain: "regulation",
        code: "1363",
        shiftLabel: "SD",
        roleLabel: "IES",
        defaultRole: "RMT",
    }), "IES");

    // No defaultRole and no roleLabel → null (non-fixed post without default)
    assert.equal(resolveOperationalRoleLabel({
        domain: "regulation",
        code: "1363",
        shiftLabel: "SD",
        roleLabel: null,
        defaultRole: null,
    }), null);
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

    // Caio Oliveira regression: explicit continuation extends scheduledEndAt to next
    // shift boundary; visibility must respect that commitment instead of expiring at
    // 07:15 due to the implicit P-shift rule.
    assert.equal(
        shouldKeepRegulationOccupancyVisible({
            startedAt: new Date("2026-03-25T19:00:00-03:00"),
            boardStartedAt: new Date("2026-03-25T19:00:00-03:00"),
            scheduledEndAt: new Date("2026-03-26T19:15:00-03:00"),
            shiftLabel: "P",
            reference: new Date("2026-03-26T07:15:00-03:00"),
        }),
        true,
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

    // P que chega antes das 07:00 ainda cobre SD+SN do mesmo dia operacional
    assert.equal(
        resolveImplicitOccupancyExpiry(new Date("2026-03-30T06:39:00-03:00"), "P")?.toISOString(),
        new Date("2026-03-31T07:00:00-03:00").toISOString(),
    );
});

test("cross-shift continuation: SN label with SD startedAt causes board disappearance, P label keeps visible", () => {
    // BUG scenario: doctor continues from SD to SN at 18:38. Occupancy created with
    // startedAt=07:00, boardStartedAt=07:00, shiftLabel=SN. At 19:16 the occupancy
    // disappears because resolveImplicitOccupancyExpiry(07:00, "SN") = 19:00.
    const sdStart = new Date("2026-04-05T07:00:00-03:00");

    // With wrong shiftLabel "SN": visible at 19:14 but invisible at 19:16
    assert.equal(
        shouldKeepRegulationOccupancyVisible({
            startedAt: sdStart,
            boardStartedAt: sdStart,
            shiftLabel: "SN",
            reference: new Date("2026-04-05T19:14:00-03:00"),
        }),
        true,
    );
    assert.equal(
        shouldKeepRegulationOccupancyVisible({
            startedAt: sdStart,
            boardStartedAt: sdStart,
            shiftLabel: "SN",
            reference: new Date("2026-04-05T19:16:00-03:00"),
        }),
        false, // BUG: doctor disappears from the board after 19:15
    );

    // With correct shiftLabel "P": visible until tomorrow 07:15
    assert.equal(
        shouldKeepRegulationOccupancyVisible({
            startedAt: sdStart,
            boardStartedAt: sdStart,
            shiftLabel: "P",
            reference: new Date("2026-04-05T19:16:00-03:00"),
        }),
        true,
    );
    assert.equal(
        shouldKeepRegulationOccupancyVisible({
            startedAt: sdStart,
            boardStartedAt: sdStart,
            shiftLabel: "P",
            reference: new Date("2026-04-06T07:14:00-03:00"),
        }),
        true,
    );
    assert.equal(
        shouldKeepRegulationOccupancyVisible({
            startedAt: sdStart,
            boardStartedAt: sdStart,
            shiftLabel: "P",
            reference: new Date("2026-04-06T07:16:00-03:00"),
        }),
        false, // P expires at 07:15 the next day — correct behavior
    );
});

test("keeps active regulation visible when startedAt is current shift even with older boardStartedAt", () => {
    assert.equal(
        shouldKeepRegulationOccupancyVisible({
            startedAt: new Date("2026-04-16T07:18:00-03:00"),
            boardStartedAt: new Date("2026-04-15T19:01:00-03:00"),
            shiftLabel: "SD",
            reference: new Date("2026-04-16T08:10:00-03:00"),
        }),
        true,
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

test("shouldKeepRegulationOccupancyVisible hides cross-domain P when startedAt is from expired SN window", () => {
    // Simulates what happened before the fix: CZ50 SN (21:53 yesterday) → 2153 SD (08:00 today).
    // The new regulation occupancy was created with startedAt = 21:53 yesterday and shiftLabel = "P".
    // resolveProlongedShiftExpiry(21:53 22Apr, "P") = 23Apr 07:00 → already past at 08:00.
    assert.equal(
        shouldKeepRegulationOccupancyVisible({
            startedAt: new Date("2026-04-22T21:53:00-03:00"),
            boardStartedAt: new Date("2026-04-22T21:53:00-03:00"),
            shiftLabel: "P",
            reference: new Date("2026-04-23T08:00:00-03:00"),
        }),
        false, // this is the pre-fix behaviour — the occupancy was hidden
    );

    // After the fix: startedAt is set to eventAt (08:00 today), boardStartedAt keeps historical anchor.
    assert.equal(
        shouldKeepRegulationOccupancyVisible({
            startedAt: new Date("2026-04-23T08:00:00-03:00"),
            boardStartedAt: new Date("2026-04-22T21:53:00-03:00"),
            shiftLabel: "P",
            reference: new Date("2026-04-23T08:00:00-03:00"),
        }),
        true, // startedAt is in current shift → immediately visible
    );
});

test("resolveContinuationBoardStartedAt preserves the earliest board anchor across shifts", () => {
    // Cross-shift continuation: doctor arrived at 19:28 SN, continues next day at 11:54. 
    // Board retains original arrival (19:28) so priority ranking is accurate.
    assert.equal(
        resolveContinuationBoardStartedAt({
            startedAt: new Date("2026-03-25T19:28:00-03:00"),
            boardStartedAt: new Date("2026-03-25T19:28:00-03:00"),
            continuedAt: new Date("2026-03-26T11:54:00-03:00"),
        }).toISOString(),
        new Date("2026-03-25T19:28:00-03:00").toISOString(),
    );

    // Same-shift continuation: boardStartedAt already matches current shift → unchanged.
    assert.equal(
        resolveContinuationBoardStartedAt({
            startedAt: new Date("2026-03-25T19:28:00-03:00"),
            boardStartedAt: new Date("2026-03-25T19:28:00-03:00"),
            continuedAt: new Date("2026-03-25T23:08:00-03:00"),
        }).toISOString(),
        new Date("2026-03-25T19:28:00-03:00").toISOString(),
    );

    // Cross-shift continuation with inherited boardStartedAt from SD: doctor arrived
    // 07:20, source closed at 19:15. Continuation at 19:25 must keep 07:20 for priority.
    assert.equal(
        resolveContinuationBoardStartedAt({
            startedAt: new Date("2026-04-05T19:00:00-03:00"),
            boardStartedAt: new Date("2026-04-05T07:20:00-03:00"),
            continuedAt: new Date("2026-04-05T19:25:00-03:00"),
        }).toISOString(),
        new Date("2026-04-05T07:20:00-03:00").toISOString(),
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

test("infers NUCLEO SD regulation start at 08:00 instead of 07:00", () => {
    const result = inferOperationalScheduledStartAt(
        new Date("2026-03-25T08:10:00-03:00"),
        "SD",
        null,
        "NUCLEO",
    );

    assert.equal(result?.toISOString(), new Date("2026-03-25T08:00:00-03:00").toISOString());
});

test("NUCLEO arriving at 07:30 gets scheduledStart 08:00 — no false delay", () => {
    const result = inferOperationalScheduledStartAt(
        new Date("2026-03-25T07:30:00-03:00"),
        "SD",
        null,
        "NUCLEO",
    );

    assert.equal(result?.toISOString(), new Date("2026-03-25T08:00:00-03:00").toISOString());
});

test("inferRegulationCoverageWindow uses 08:00 for NUCLEO SD", () => {
    const result = inferRegulationCoverageWindow({
        startedAt: new Date("2026-03-25T08:05:00-03:00"),
        shiftLabel: "SD",
        postCode: "NUCLEO",
    });

    assert.equal(result.scheduledStartAt?.toISOString(), new Date("2026-03-25T08:00:00-03:00").toISOString());
    assert.equal(result.scheduledEndAt?.toISOString(), new Date("2026-03-25T19:15:00-03:00").toISOString());
});

test("inferRegulationCoverageWindow without postCode still uses 07:00 for SD", () => {
    const result = inferRegulationCoverageWindow({
        startedAt: new Date("2026-03-25T07:25:00-03:00"),
        shiftLabel: "SD",
    });

    assert.equal(result.scheduledStartAt?.toISOString(), new Date("2026-03-25T07:00:00-03:00").toISOString());
});

test("infers SN regulation start at 19:00 of the previous local day when arrival happens after midnight", () => {
    const result = inferOperationalScheduledStartAt(
        new Date("2026-03-26T00:20:00-03:00"),
        "SN",
        null,
    );

    assert.equal(result?.toISOString(), new Date("2026-03-25T19:00:00-03:00").toISOString());
});

test("infers SN regulation start at 19:00 of the same local day when arrival happens a few minutes before the shift", () => {
    const result = inferOperationalScheduledStartAt(
        new Date("2026-03-28T18:57:00-03:00"),
        "SN",
        null,
    );

    assert.equal(result?.toISOString(), new Date("2026-03-28T19:00:00-03:00").toISOString());
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

test("infers intervention SN cutoff on the next local day even when arrival happened a few minutes before 19:00", () => {
    const result = inferInterventionScheduledEndAt(
        new Date("2026-03-28T18:58:00-03:00"),
        "SN",
        null,
    );

    assert.equal(result?.toISOString(), new Date("2026-03-29T07:00:00-03:00").toISOString());
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

test("normalizeArrivalEventTime: back-correcao 'chegada 08h10' as 20:20 vai pro mesmo dia (Briang 2032 audit)", () => {
    const referenceAt = new Date("2026-05-12T20:20:53-03:00");
    const resolved = resolveTelegramEventTime(referenceAt, "08:10");
    // Por desempate de 12h, resolveTelegramEventTime escolhe o dia seguinte.
    assert.equal(resolved.toISOString(), new Date("2026-05-13T08:10:00-03:00").toISOString());

    const normalized = normalizeArrivalEventTime(resolved, referenceAt);
    assert.equal(normalized.toISOString(), new Date("2026-05-12T08:10:00-03:00").toISOString());
});

test("normalizeArrivalEventTime: 'na 1367 07:16' as 19:37 vai pro mesmo dia (Matheus 1367 audit)", () => {
    const referenceAt = new Date("2026-05-11T19:37:47-03:00");
    const resolved = resolveTelegramEventTime(referenceAt, "07:16");
    assert.equal(resolved.toISOString(), new Date("2026-05-12T07:16:00-03:00").toISOString());

    const normalized = normalizeArrivalEventTime(resolved, referenceAt);
    assert.equal(normalized.toISOString(), new Date("2026-05-11T07:16:00-03:00").toISOString());
});

test("normalizeArrivalEventTime preserva pre-anuncio curto (<= 4h) sem deslocar", () => {
    const referenceAt = new Date("2026-05-12T18:00:00-03:00");
    const eventAt = new Date("2026-05-12T19:00:00-03:00"); // 1h ahead, SN preannounce
    assert.equal(
        normalizeArrivalEventTime(eventAt, referenceAt).toISOString(),
        eventAt.toISOString(),
    );
});

test("normalizeArrivalEventTime mantem chegadas no passado intactas", () => {
    const referenceAt = new Date("2026-05-12T08:00:00-03:00");
    const eventAt = new Date("2026-05-12T07:30:00-03:00"); // 30min ago
    assert.equal(
        normalizeArrivalEventTime(eventAt, referenceAt).toISOString(),
        eventAt.toISOString(),
    );
});

test("parses free-text regulation arrival", () => {
    const parsed = parseMessage("Bom dia, cheguei no ramal 2031 SD");

    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2031");
    assert.equal(parsed.shiftType, "SD");
    assert.equal(parsed.isDeparture, false);
});

test("parses explicit operational role in Telegram arrival", () => {
    const parsed = parseMessage("Leo Marins 1321 07:00 SD IES");

    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "1321");
    assert.equal(parsed.shiftType, "SD");
    assert.equal(parsed.roleFunction, "IES");
});

test("parses PSIQ as explicit operational role in Telegram arrival", () => {
    const parsed = parseMessage("Emily Rocha 1363 07:00 SD PSIQ");

    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "1363");
    assert.equal(parsed.shiftType, "SD");
    assert.equal(parsed.roleFunction, "PSIQ");
});

test("parses new regulation posts 1326 to 1329 in Telegram arrival", () => {
    const parsed = parseMessage("Leo Marins 1326 07:00 SD");

    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "1326");
    assert.equal(parsed.shiftType, "SD");
    assert.equal(parsed.isDeparture, false);
});

test("parses regulation arrival on ramal 1476 in Telegram arrival", () => {
    const parsed = parseMessage("Karen Seifarth 1476 08:00 SD");

    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "1476");
    assert.equal(parsed.arrivalTime, "08:00");
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

test("ignores Telegram mentions when extracting doctor names", () => {
    const parsed = parseMessage("@chefe2031");

    assert.equal(parsed.sector, "REGULATION");
    assert.equal(parsed.baseCode, "2031");
    assert.deepEqual(parsed.extractedNames, []);
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

test("parses departure intent from liberated wording on a single line", () => {
    const parsed = parseMessage("Sara Carneiro liberada da PM40 07:05");

    assert.equal(parsed.sector, "INTERVENTION");
    assert.equal(parsed.baseCode, "PM40");
    assert.equal(parsed.arrivalTime, "07:05");
    assert.equal(parsed.isDeparture, true);
    assert.deepEqual(parsed.extractedNames, ["Sara Carneiro"]);
    assert.equal(looksLikeDepartureMessage("Sara Carneiro liberada da PM40 07:05"), true);
});

test("parses multiline departure even when name, action, base and time arrive out of order", () => {
    const parsed = parseMessageMulti("Leonardo Carteado\n2031\nsaindo do P\n07:15")[0];

    assert.equal(parsed?.sector, "REGULATION");
    assert.equal(parsed?.baseCode, "2031");
    assert.equal(parsed?.arrivalTime, "07:15");
    assert.equal(parsed?.isDeparture, true);
    assert.deepEqual(parsed?.extractedNames, ["Leonardo Carteado"]);
    assert.equal(parsed?.confidence, "HIGH");
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

test("extractNames strips noise tokens like desde, rendida, sombra, chefia from doctor names", () => {
    const p1 = parseMessage("LEO MORAIS 24H CRU DESDE AS 07:00");
    assert.deepEqual(p1.extractedNames, ["LEO MORAIS"]);

    const p2 = parseMessage("Ananda Andrade saindo CRU 07:20 rendida por Ronaldo");
    assert.ok(!p2.extractedNames[0]?.includes("rendida"), "should not include rendida");
    assert.ok(!p2.extractedNames[0]?.includes("por"), "should not include por");

    const p3 = parseMessage("ANA BEATRIZ 2031 SAINDO DA CHEFIA");
    assert.deepEqual(p3.extractedNames, ["ANA BEATRIZ"]);

    const p4 = parseMessage("Laisse SN na 30  desde as 18:58");
    assert.deepEqual(p4.extractedNames, ["Laisse"]);

    const p5 = parseMessage("Leonardo Cabanelas, CRU (sombra), chegada as 7:10");
    assert.deepEqual(p5.extractedNames, ["Leonardo Cabanelas"]);
    assert.equal(p5.isShadow, true);
});

test("classifies emoji-only and filler-heavy messages as casual", () => {
    assert.equal(isCasualTelegramMessage("😂"), true);
    assert.equal(isCasualTelegramMessage("kkkkkkkkkkkk jesus"), true);
    assert.equal(isCasualTelegramMessage("Vai dar certo"), true);
    assert.equal(isCasualTelegramMessage("Não entendi"), true);
    assert.equal(isCasualTelegramMessage("PerFeito! Sua Linda! BOm plan~tao"), true);
});

test("does not classify operational messages with CRU/COI as casual", () => {
    assert.equal(isCasualTelegramMessage("Ronaldo Acácio CRU SD"), false);
    assert.equal(isCasualTelegramMessage("Sadja Costa COI SN 19:14"), false);
    assert.equal(isCasualTelegramMessage("Gerardson continua no COI"), false);
});

test("classifies vacancy/coverage chatter as operational meta conversation", () => {
    assert.equal(looksLikeOperationalMetaConversation("2031 sem médico?"), true);
    assert.equal(looksLikeOperationalMetaConversation("Quem cobre o 1366 agora?"), true);
    assert.equal(looksLikeOperationalMetaConversation("Tem vaga no COI hoje?"), true);
    assert.equal(looksLikeOperationalMetaConversation("PM40 descoberto neste turno"), true);
});

test("does not classify structured operational registrations as meta conversation", () => {
    assert.equal(looksLikeOperationalMetaConversation("Leonardo 2031 07:00 SD"), false);
    assert.equal(looksLikeOperationalMetaConversation("Ana saindo 1366 19:20"), false);
    assert.equal(looksLikeOperationalMetaConversation("Rafaela continua COI SN"), false);
});

test("P arrival up to 60 min before boundary resolves to the upcoming shift, not the current one", () => {
    // Doctor arrives at 06:44 with P — 16 min before the 07:00 SD boundary.
    // Must resolve to SD (scheduledStart = 07:00), NOT SN (scheduledStart = 19:00 yesterday, which would create ~12h phantom delay).
    const earlySD = inferInterventionCoverageWindow({
        startedAt: new Date("2026-03-25T06:44:00-03:00"),
        shiftLabel: "P",
    });
    assert.equal(earlySD.baseShiftLabel, "SD");
    assert.equal(earlySD.scheduledStartAt?.toISOString(), new Date("2026-03-25T07:00:00-03:00").toISOString());
    assert.equal(earlySD.scheduledEndAt?.toISOString(), new Date("2026-03-26T07:00:00-03:00").toISOString());

    // Same scenario at 06:30 — 30 min before boundary
    const earlySD30 = inferInterventionCoverageWindow({
        startedAt: new Date("2026-03-25T06:30:00-03:00"),
        shiftLabel: "P",
    });
    assert.equal(earlySD30.baseShiftLabel, "SD");
    assert.equal(earlySD30.scheduledStartAt?.toISOString(), new Date("2026-03-25T07:00:00-03:00").toISOString());

    // Doctor arrives at 18:30 with P — 30 min before the 19:00 SN boundary
    const earlySN = inferInterventionCoverageWindow({
        startedAt: new Date("2026-03-25T18:30:00-03:00"),
        shiftLabel: "P",
    });
    assert.equal(earlySN.baseShiftLabel, "SN");
    assert.equal(earlySN.scheduledStartAt?.toISOString(), new Date("2026-03-25T19:00:00-03:00").toISOString());

    // P at 06:01 — 59 min before boundary, still within tolerance
    const earlySD59 = inferInterventionCoverageWindow({
        startedAt: new Date("2026-03-25T06:01:00-03:00"),
        shiftLabel: "P",
    });
    assert.equal(earlySD59.baseShiftLabel, "SD");
    assert.equal(earlySD59.scheduledStartAt?.toISOString(), new Date("2026-03-25T07:00:00-03:00").toISOString());

    // Regulation variant: P at 06:44
    const regEarlySD = inferRegulationCoverageWindow({
        startedAt: new Date("2026-03-25T06:44:00-03:00"),
        shiftLabel: "P",
    });
    assert.equal(regEarlySD.baseShiftLabel, "SD");
    assert.equal(regEarlySD.scheduledStartAt?.toISOString(), new Date("2026-03-25T07:00:00-03:00").toISOString());
});

test("P arrival well inside the current shift stays on the current shift", () => {
    // P at 22:00 — clearly SN, not approaching the SD boundary
    const nightP = inferInterventionCoverageWindow({
        startedAt: new Date("2026-03-25T22:00:00-03:00"),
        shiftLabel: "P",
    });
    assert.equal(nightP.baseShiftLabel, "SN");
    assert.equal(nightP.scheduledStartAt?.toISOString(), new Date("2026-03-25T19:00:00-03:00").toISOString());

    // P at 10:00 — clearly SD, not approaching the SN boundary
    const dayP = inferInterventionCoverageWindow({
        startedAt: new Date("2026-03-25T10:00:00-03:00"),
        shiftLabel: "P",
    });
    assert.equal(dayP.baseShiftLabel, "SD");
    assert.equal(dayP.scheduledStartAt?.toISOString(), new Date("2026-03-25T07:00:00-03:00").toISOString());
});

test("resolveArrivalShiftLabel classifies near-boundary arrivals to the upcoming shift", () => {
    // 18:55 is 5 min before SN boundary → SN
    assert.equal(resolveArrivalShiftLabel(new Date("2026-03-25T18:55:00-03:00")), "SN");
    // 16:00 is exactly 3 h before SN boundary → SN (at boundary of tolerance)
    assert.equal(resolveArrivalShiftLabel(new Date("2026-03-25T16:00:00-03:00")), "SN");
    // 06:44 is 16 min before SD boundary → SD
    assert.equal(resolveArrivalShiftLabel(new Date("2026-03-25T06:44:00-03:00")), "SD");
    // 06:01 is 59 min before SD boundary → SD
    assert.equal(resolveArrivalShiftLabel(new Date("2026-03-25T06:01:00-03:00")), "SD");
    // 04:00 is exactly 3 h before SD boundary → SD (at boundary of tolerance)
    assert.equal(resolveArrivalShiftLabel(new Date("2026-03-25T04:00:00-03:00")), "SD");
    // 03:59 is 3 h 01 min before SD boundary → SN (outside early window)
    assert.equal(resolveArrivalShiftLabel(new Date("2026-03-25T03:59:00-03:00")), "SN");
    // 15:59 is 3 h 01 min before SN boundary → SD (outside early window)
    assert.equal(resolveArrivalShiftLabel(new Date("2026-03-25T15:59:00-03:00")), "SD");
    // 15:00 is well inside SD → SD
    assert.equal(resolveArrivalShiftLabel(new Date("2026-03-25T15:00:00-03:00")), "SD");
    // 22:00 is well inside SN → SN
    assert.equal(resolveArrivalShiftLabel(new Date("2026-03-25T22:00:00-03:00")), "SN");
    // exactly 19:00 → SN (no tolerance needed, already in SN)
    assert.equal(resolveArrivalShiftLabel(new Date("2026-03-25T19:00:00-03:00")), "SN");
    // exactly 07:00 → SD
    assert.equal(resolveArrivalShiftLabel(new Date("2026-03-25T07:00:00-03:00")), "SD");
});

test("isSameOperationalShiftArrival: relevo de fim de plantão (07h x 18:50) NÃO é mesmo turno", () => {
    // Bug reportado: quem chega 18:50 para a noite não pode ser avisado de "posição
    // ocupada" por quem chegou 07:00 para o dia — turnos diferentes, é rendição normal.
    assert.equal(
        isSameOperationalShiftArrival(
            new Date("2026-03-25T07:00:00-03:00"),
            new Date("2026-03-25T18:50:00-03:00"),
        ),
        false,
    );
    // Espelho na virada da manhã: ocupante SN das 19h x chegada 06:40 para o dia.
    assert.equal(
        isSameOperationalShiftArrival(
            new Date("2026-03-25T19:00:00-03:00"),
            new Date("2026-03-26T06:40:00-03:00"),
        ),
        false,
    );
    // Mesmo turno (ambos SD, com poucos minutos de diferença): É tomada → segue confirmação.
    assert.equal(
        isSameOperationalShiftArrival(
            new Date("2026-03-25T07:05:00-03:00"),
            new Date("2026-03-25T07:40:00-03:00"),
        ),
        true,
    );
    // Mesmo turno SN (ambos chegando perto das 19h): tomada dentro do turno.
    assert.equal(
        isSameOperationalShiftArrival(
            new Date("2026-03-25T18:30:00-03:00"),
            new Date("2026-03-25T18:55:00-03:00"),
        ),
        true,
    );
});

test("null shiftLabel arrival near boundary produces correct coverage window", () => {
    // Cloud Sá scenario: arrival at 18:55 with no shift label → should get SN window
    const nearBoundary = inferInterventionCoverageWindow({
        startedAt: new Date("2026-04-05T18:55:00-03:00"),
        shiftLabel: null,
    });
    assert.equal(nearBoundary.baseShiftLabel, "SN");
    assert.equal(nearBoundary.scheduledStartAt?.toISOString(), new Date("2026-04-05T19:00:00-03:00").toISOString());
    assert.equal(nearBoundary.scheduledEndAt?.toISOString(), new Date("2026-04-06T07:00:00-03:00").toISOString());

    // Same for regulation
    const regNearBoundary = inferRegulationCoverageWindow({
        startedAt: new Date("2026-04-05T18:55:00-03:00"),
        shiftLabel: null,
    });
    assert.equal(regNearBoundary.baseShiftLabel, "SN");
    assert.equal(regNearBoundary.scheduledStartAt?.toISOString(), new Date("2026-04-05T19:00:00-03:00").toISOString());

    // Arrival at 06:30 with no label → should get SD window
    const earlyMorning = inferInterventionCoverageWindow({
        startedAt: new Date("2026-04-05T06:30:00-03:00"),
        shiftLabel: null,
    });
    assert.equal(earlyMorning.baseShiftLabel, "SD");
    assert.equal(earlyMorning.scheduledStartAt?.toISOString(), new Date("2026-04-05T07:00:00-03:00").toISOString());
    assert.equal(earlyMorning.scheduledEndAt?.toISOString(), new Date("2026-04-05T19:00:00-03:00").toISOString());

    // Arrival at 10:00 with no label → should stay SD (well inside)
    const midMorning = inferInterventionCoverageWindow({
        startedAt: new Date("2026-04-05T10:00:00-03:00"),
        shiftLabel: null,
    });
    assert.equal(midMorning.baseShiftLabel, "SD");
    assert.equal(midMorning.scheduledStartAt?.toISOString(), new Date("2026-04-05T07:00:00-03:00").toISOString());
});

test("explicit SN label at early-SD window is overridden to SD (Vinicius/CC70 drawer scenario)", () => {
    // Chief adds Vinicius to CC70 at 06:47 — the drawer auto-populates shiftLabel="SN"
    // (current board shift). The service must infer SD, not SN, for this arrival.
    const drawerSNAt0647 = inferInterventionCoverageWindow({
        startedAt: new Date("2026-04-10T06:47:00-03:00"),
        shiftLabel: "SN",
    });
    assert.equal(drawerSNAt0647.baseShiftLabel, "SD");
    assert.equal(drawerSNAt0647.scheduledStartAt?.toISOString(), new Date("2026-04-10T07:00:00-03:00").toISOString());
    assert.equal(drawerSNAt0647.scheduledEndAt?.toISOString(), new Date("2026-04-10T19:00:00-03:00").toISOString());

    // Same for regulation
    const regSNAt0647 = inferRegulationCoverageWindow({
        startedAt: new Date("2026-04-10T06:47:00-03:00"),
        shiftLabel: "SN",
    });
    assert.equal(regSNAt0647.baseShiftLabel, "SD");

    // Arrival at 04:00 with explicit "SN" (matches current window) → SD
    const extremeEarlySD = inferInterventionCoverageWindow({
        startedAt: new Date("2026-04-10T04:00:00-03:00"),
        shiftLabel: "SN",
    });
    assert.equal(extremeEarlySD.baseShiftLabel, "SD");

    // Arrival at 03:59 with explicit "SN" — outside the 3h window → stays SN
    const justOutside = inferInterventionCoverageWindow({
        startedAt: new Date("2026-04-10T03:59:00-03:00"),
        shiftLabel: "SN",
    });
    assert.equal(justOutside.baseShiftLabel, "SN");
});

test("explicit SD label at early-SN window is overridden to SN", () => {
    // Doctor added at 16:47 with the drawer auto-populated shiftLabel="SD" → should be SN
    const drawerSDAt1647 = inferInterventionCoverageWindow({
        startedAt: new Date("2026-04-10T16:47:00-03:00"),
        shiftLabel: "SD",
    });
    assert.equal(drawerSDAt1647.baseShiftLabel, "SN");
    assert.equal(drawerSDAt1647.scheduledStartAt?.toISOString(), new Date("2026-04-10T19:00:00-03:00").toISOString());

    // Arrival at 16:00 (exactly 3 h before SN) with explicit "SD" → SN
    const exactBoundary = inferInterventionCoverageWindow({
        startedAt: new Date("2026-04-10T16:00:00-03:00"),
        shiftLabel: "SD",
    });
    assert.equal(exactBoundary.baseShiftLabel, "SN");

    // Arrival at 15:59 with explicit "SD" — outside the 3h window → stays SD
    const justOutsideSN = inferInterventionCoverageWindow({
        startedAt: new Date("2026-04-10T15:59:00-03:00"),
        shiftLabel: "SD",
    });
    assert.equal(justOutsideSN.baseShiftLabel, "SD");
});

test("explicit SN that already differs from the current window is kept (chief intentional override)", () => {
    // Doctor added at 18:57 with explicit "SN" — currently SD window but chief CHOSE SN
    // (normalized "SN" != window.shiftLabel "SD" → no flip)
    const intentionalSN = inferInterventionCoverageWindow({
        startedAt: new Date("2026-03-28T18:57:00-03:00"),
        shiftLabel: "SN",
    });
    assert.equal(intentionalSN.baseShiftLabel, "SN");
    assert.equal(intentionalSN.scheduledStartAt?.toISOString(), new Date("2026-03-28T19:00:00-03:00").toISOString());
});

test("inferInterventionCoverageWindow extends P through the next shift when there is no explicit end", () => {
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

test("inferInterventionCoverageWindow keeps an explicit P end without extending twice", () => {
    const carried = inferInterventionCoverageWindow({
        startedAt: new Date("2026-03-25T07:25:00-03:00"),
        shiftLabel: "P",
        explicitScheduledEndAt: new Date("2026-03-26T07:00:00-03:00"),
    });

    assert.equal(carried.scheduledEndAt?.toISOString(), new Date("2026-03-26T07:00:00-03:00").toISOString());
});

test("inferRegulationCoverageWindow extends P through the next shift when there is no explicit end", () => {
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

test("inferRegulationCoverageWindow keeps an explicit P end without extending twice", () => {
    const carried = inferRegulationCoverageWindow({
        startedAt: new Date("2026-03-25T07:25:00-03:00"),
        shiftLabel: "P",
        explicitScheduledEndAt: new Date("2026-03-26T07:15:00-03:00"),
    });

    assert.equal(carried.scheduledEndAt?.toISOString(), new Date("2026-03-26T07:15:00-03:00").toISOString());
});

test("resolveRegulationContinuationExplicitScheduledEndAt drops expired carry-over end", () => {
    const continuationAt = new Date("2026-04-28T08:55:00-03:00");
    const expiredScheduledEndAt = new Date("2026-04-28T07:15:00-03:00");

    assert.equal(
        resolveRegulationContinuationExplicitScheduledEndAt({
            existingScheduledEndAt: expiredScheduledEndAt,
            continuationAt,
        }),
        null,
    );

    const futureScheduledEndAt = new Date("2026-04-28T19:15:00-03:00");
    assert.equal(
        resolveRegulationContinuationExplicitScheduledEndAt({
            existingScheduledEndAt: futureScheduledEndAt,
            continuationAt,
        })?.toISOString(),
        futureScheduledEndAt.toISOString(),
    );
});

test("resolveRegulationContinuationScheduledEndAt does NOT extend when continuation lands inside the covered window (reforco de P)", () => {
    // Medico de P desde ~07:00 mandando "P"/continua as 19:00 do MESMO dia esta
    // apenas reforcando — ainda dentro da janela de 24h. Nao vira plantao de 36h.
    const nextScheduledEndAt = resolveRegulationContinuationScheduledEndAt({
        existingStartedAt: new Date("2026-04-27T06:48:00-03:00"),
        continuationAt: new Date("2026-04-27T19:00:58-03:00"),
        postCode: "1367",
        inferredScheduledStartAt: new Date("2026-04-27T07:00:00-03:00"),
        explicitScheduledEndAt: null,
    });

    assert.equal(nextScheduledEndAt?.toISOString(), new Date("2026-04-28T07:15:00-03:00").toISOString());
});

test("resolveRegulationContinuationScheduledEndAt: continuidade apos o fim da janela emenda UM bloco discreto", () => {
    // Continuidade genuina: o medico avisa apos o fim da janela (07:40 da manha
    // seguinte). O aviso referencia a virada das 07:00 → cobertura ate o fim do
    // bloco SD (19:15). Um bloco discreto por aviso, nunca dois — para seguir a
    // noite, um novo "continua" perto da virada das 19:00 emenda o proximo.
    const nextScheduledEndAt = resolveRegulationContinuationScheduledEndAt({
        existingStartedAt: new Date("2026-04-27T06:48:00-03:00"),
        continuationAt: new Date("2026-04-28T07:40:00-03:00"),
        postCode: "1367",
        inferredScheduledStartAt: new Date("2026-04-27T07:00:00-03:00"),
        explicitScheduledEndAt: null,
    });

    assert.equal(nextScheduledEndAt?.toISOString(), new Date("2026-04-28T19:15:00-03:00").toISOString());
});

test("REGRESSAO Manuella Barreto: 'continua' dentro da janela P nao infla o plantao para 36h", () => {
    // Caso real 2026-05-15: medica de P desde 07:00 recebe "Manuella continua" na
    // virada de turno (19:00 do mesmo dia). Isso e apenas reforco — ainda dentro
    // da janela de 24h ja coberta. O bot NAO pode estender para ~36h.
    const existingStartedAt = new Date("2026-05-15T07:00:00-03:00");
    const nextScheduledEndAt = resolveRegulationContinuationScheduledEndAt({
        existingStartedAt,
        continuationAt: new Date("2026-05-15T19:00:00-03:00"),
        postCode: "1367",
        inferredScheduledStartAt: existingStartedAt,
        explicitScheduledEndAt: null,
    });

    // Cobertura permanece no bloco de 24h (07:15 da manha seguinte), nunca 36h.
    assert.equal(nextScheduledEndAt?.toISOString(), new Date("2026-05-16T07:15:00-03:00").toISOString());
    const coverageHours = (nextScheduledEndAt!.getTime() - existingStartedAt.getTime()) / 3_600_000;
    assert.ok(coverageHours <= 25, `cobertura inflada: ${coverageHours}h (esperado <= 25h)`);
});

test("REGRESSAO Uenderson 1361: 'continua' estende para o turno seguinte independente da hora do aviso", () => {
    // Caso real 2026-07-18: SN desde 18:57 da vespera, "continuando 1361" as 06:41
    // e "continua" as 08:12. A regra antiga tratava o aviso pre-virada como reforco
    // e mantinha 07:15 — o expiry fechava a ocupacao e a proxima mensagem recriava
    // o plantao com chegada 08:12. Ambos os avisos referenciam a virada das 07:00
    // e devem produzir a MESMA cobertura (fim do bloco SD, 19:15).
    const base = {
        existingStartedAt: new Date("2026-07-17T18:57:15-03:00"),
        postCode: "1361",
        inferredScheduledStartAt: new Date("2026-07-17T19:00:00-03:00"),
        explicitScheduledEndAt: new Date("2026-07-18T07:15:00-03:00"),
    };

    const beforeBoundary = resolveRegulationContinuationScheduledEndAt({
        ...base,
        continuationAt: new Date("2026-07-18T06:41:36-03:00"),
    });
    const afterBoundary = resolveRegulationContinuationScheduledEndAt({
        ...base,
        continuationAt: new Date("2026-07-18T08:12:21-03:00"),
    });

    assert.equal(beforeBoundary?.toISOString(), new Date("2026-07-18T19:15:00-03:00").toISOString());
    assert.equal(afterBoundary?.toISOString(), beforeBoundary?.toISOString());
});

test("resolveContinuationReferenceBoundary: o aviso referencia a virada mais proxima", () => {
    // Madrugada/manha → virada das 07:00, nao importa se antes ou depois dela.
    assert.equal(
        resolveContinuationReferenceBoundary(new Date("2026-07-18T06:41:00-03:00")).toISOString(),
        new Date("2026-07-18T07:00:00-03:00").toISOString(),
    );
    assert.equal(
        resolveContinuationReferenceBoundary(new Date("2026-07-18T10:15:00-03:00")).toISOString(),
        new Date("2026-07-18T07:00:00-03:00").toISOString(),
    );
    // Tarde/inicio da noite → virada das 19:00.
    assert.equal(
        resolveContinuationReferenceBoundary(new Date("2026-07-18T17:00:00-03:00")).toISOString(),
        new Date("2026-07-18T19:00:00-03:00").toISOString(),
    );
    assert.equal(
        resolveContinuationReferenceBoundary(new Date("2026-07-18T22:00:00-03:00")).toISOString(),
        new Date("2026-07-18T19:00:00-03:00").toISOString(),
    );
    // Empate exato (13:00, meio do SD) → a virada anterior (comportamento conservador).
    assert.equal(
        resolveContinuationReferenceBoundary(new Date("2026-07-18T13:00:00-03:00")).toISOString(),
        new Date("2026-07-18T07:00:00-03:00").toISOString(),
    );
});

test("resolveRegulationContinuationScheduledEndAt: reforco no MEIO da janela segue sem estender", () => {
    // Mesmo com a regra da reta final, um "continua" com 12h+ de cobertura restante
    // (P desde 07h reforcado as 19h) continua sendo apenas reforco.
    const nextScheduledEndAt = resolveRegulationContinuationScheduledEndAt({
        existingStartedAt: new Date("2026-07-17T07:00:00-03:00"),
        continuationAt: new Date("2026-07-17T19:00:00-03:00"),
        postCode: "1367",
        inferredScheduledStartAt: new Date("2026-07-17T07:00:00-03:00"),
        explicitScheduledEndAt: null,
    });

    assert.equal(nextScheduledEndAt?.toISOString(), new Date("2026-07-18T07:15:00-03:00").toISOString());
});

test("resolveInterventionContinuationScheduledEndAt: continuidade dentro da janela so reforca (nao estende)", () => {
    // P de intervencao desde 07:00, fim agendado 07:00 do dia seguinte. "continua"
    // as 19:00 cai dentro da janela: a proxima virada coincide com o fim atual.
    const nextScheduledEndAt = resolveInterventionContinuationScheduledEndAt({
        existingScheduledEndAt: new Date("2026-05-16T07:00:00-03:00"),
        continuationAt: new Date("2026-05-15T19:00:00-03:00"),
    });
    assert.equal(nextScheduledEndAt.toISOString(), new Date("2026-05-16T07:00:00-03:00").toISOString());
});

test("resolveInterventionContinuationScheduledEndAt: continuidade apos a janela emenda um unico bloco discreto", () => {
    // Fim agendado 19:00; aviso as 19:30 (turno noturno) emenda ate a PROXIMA
    // virada (07:00 do dia seguinte) — um bloco discreto, nunca alem.
    const nextScheduledEndAt = resolveInterventionContinuationScheduledEndAt({
        existingScheduledEndAt: new Date("2026-05-15T19:00:00-03:00"),
        continuationAt: new Date("2026-05-15T19:30:00-03:00"),
    });
    assert.equal(nextScheduledEndAt.toISOString(), new Date("2026-05-16T07:00:00-03:00").toISOString());
});

test("resolveInterventionContinuationScheduledEndAt: aviso pre-virada emenda o bloco seguinte a virada referenciada", () => {
    // SN com fim agendado 07:00; "continuando" as 06:41 referencia a virada das
    // 07:00 → cobertura ate o fim do bloco seguinte (19:00).
    const nearMorning = resolveInterventionContinuationScheduledEndAt({
        existingScheduledEndAt: new Date("2026-07-18T07:00:00-03:00"),
        continuationAt: new Date("2026-07-18T06:41:00-03:00"),
    });
    assert.equal(nearMorning.toISOString(), new Date("2026-07-18T19:00:00-03:00").toISOString());

    // SD com fim 19:00; "continua" as 18:30 referencia a virada das 19:00 →
    // emenda ate 07:00 do dia seguinte.
    const nearEvening = resolveInterventionContinuationScheduledEndAt({
        existingScheduledEndAt: new Date("2026-07-18T19:00:00-03:00"),
        continuationAt: new Date("2026-07-18T18:30:00-03:00"),
    });
    assert.equal(nearEvening.toISOString(), new Date("2026-07-19T07:00:00-03:00").toISOString());

    // Aviso DEPOIS da virada produz a mesma cobertura que o aviso antes dela.
    const afterBoundary = resolveInterventionContinuationScheduledEndAt({
        existingScheduledEndAt: new Date("2026-07-18T07:00:00-03:00"),
        continuationAt: new Date("2026-07-18T10:15:40-03:00"),
    });
    assert.equal(afterBoundary.toISOString(), nearMorning.toISOString());
});

test("resolveInterventionContinuationScheduledEndAt: nunca encurta um fim agendado mais distante", () => {
    const nextScheduledEndAt = resolveInterventionContinuationScheduledEndAt({
        existingScheduledEndAt: new Date("2026-05-17T07:00:00-03:00"),
        continuationAt: new Date("2026-05-15T19:30:00-03:00"),
    });
    assert.equal(nextScheduledEndAt.toISOString(), new Date("2026-05-17T07:00:00-03:00").toISOString());
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

test("detectLocationWithoutRamal identifies CRU/COI without ramal", () => {
    assert.deepEqual(detectLocationWithoutRamal("Ronaldo Acácio CRU SD"), { location: "CRU" });
    assert.deepEqual(detectLocationWithoutRamal("Sadja Costa COI SN 19:14"), { location: "COI" });
    assert.deepEqual(detectLocationWithoutRamal("Gerardson continua no COI"), { location: "COI" });
    assert.equal(detectLocationWithoutRamal("Fulano 1366 SD 07:00"), null);
    assert.equal(detectLocationWithoutRamal("Fulano SM01 SD"), null);
    assert.equal(detectLocationWithoutRamal("Bom dia pessoal"), null);
});

test("buildLocationWithoutRamalReply includes sender name, ramal list, and copy-paste example", () => {
    const reply = buildLocationWithoutRamalReply({
        senderName: "Sadja Costa",
        location: "COI",
        shiftLabel: "SN",
        time: "19:14",
    });
    assert.ok(reply.includes("Sadja Costa"));
    assert.ok(reply.includes("COI"));
    assert.ok(reply.includes("1367"));
    assert.ok(reply.includes("1368"));
    assert.ok(reply.includes("SN"));
    assert.ok(reply.includes("19:14"));
    assert.ok(reply.includes("mais de um ramal"));
    assert.ok(reply.includes("Reenvie"));

    const cruReply = buildLocationWithoutRamalReply({
        senderName: "Ananda Andrade",
        location: "CRU",
        shiftLabel: "SD",
        time: null,
    });
    assert.ok(cruReply.includes("Ananda Andrade"));
    assert.ok(cruReply.includes("CRU"));
    assert.ok(cruReply.includes("1321"));
    assert.ok(cruReply.includes("Central de Regulação Urbana"));
});

test("resolveForcedDayEventTime with dayOffset=-1 forces yesterday", () => {
    // Message sent April 1st 07:00 BRT, user wants 20:00 of yesterday (March 31)
    const result = resolveForcedDayEventTime(
        new Date("2026-04-01T07:00:00-03:00"),
        "20:00",
        -1,
    );

    assert.equal(result.toISOString(), new Date("2026-03-31T20:00:00-03:00").toISOString());
});

test("resolveForcedDayEventTime with dayOffset=0 forces today", () => {
    // Message sent April 1st 07:00 BRT, user wants 07:00 of today (April 1st)
    const result = resolveForcedDayEventTime(
        new Date("2026-04-01T07:00:00-03:00"),
        "07:00",
        0,
    );

    assert.equal(result.toISOString(), new Date("2026-04-01T07:00:00-03:00").toISOString());
});

test("resolveForcedDayEventTime with dayOffset=0 does not drift to next day for late-night messages", () => {
    // Message sent March 31 at 23:30 BRT, user wants 07:00 of today (March 31), NOT April 1
    const result = resolveForcedDayEventTime(
        new Date("2026-03-31T23:30:00-03:00"),
        "07:00",
        0,
    );

    assert.equal(result.toISOString(), new Date("2026-03-31T07:00:00-03:00").toISOString());
});

test("parses 'vou continuar' compound continuation without a base code", () => {
    const parsed = parseMessage("Ana Luiza vou continuar SN");

    assert.equal(parsed.isContinuation, true);
    assert.equal(parsed.isDeparture, false);
    assert.equal(parsed.shiftType, "SN");
    assert.deepEqual(parsed.extractedNames, ["Ana Luiza"]);
});

test("parses 'vou ficar' and 'vou permanecer' as continuation signals", () => {
    assert.equal(parseMessage("Maria vou ficar na PM04").isContinuation, true);
    assert.equal(parseMessage("João vou permanecer CB02").isContinuation, true);
    assert.equal(parseMessage("Carlos vai continuar SM01").isContinuation, true);
});

test("parses infinitive continuation forms: continuar, ficar, permanecer, seguir", () => {
    assert.equal(parseMessage("Larissa continuar na 50").isContinuation, true);
    assert.equal(parseMessage("Larissa ficar na 50").isContinuation, true);
    assert.equal(parseMessage("Larissa permanecer na 50").isContinuation, true);
    assert.equal(parseMessage("Larissa seguir na 50").isContinuation, true);
    assert.equal(parseMessage("Larissa prosseguir na 50").isContinuation, true);
});

test("continuation without base code still parses isContinuation but has no sector", () => {
    const parsed = parseMessage("Ana Luiza continua SN");

    assert.equal(parsed.isContinuation, true);
    assert.equal(parsed.baseCode, null);
    assert.equal(parsed.sector, null);
    assert.equal(parsed.shiftType, "SN");
    assert.deepEqual(parsed.extractedNames, ["Ana Luiza"]);
});

test("does not leak continuation/vou tokens into doctor name extraction", () => {
    const parsed = parseMessage("Vagner vou continuar PR03 SN");

    assert.equal(parsed.isContinuation, true);
    assert.equal(parsed.baseCode, "PR03");
    assert.deepEqual(parsed.extractedNames, ["Vagner"]);
});
// Caso Ana Beatriz 31/07/2026: SN na regulação 2031 (30/07 18:26 → 31/07 07:10) e
// "continua" na CZ50. O registro novo nascia com rótulo "P" e ganhava cobertura de 24h
// (07:00 → 01/08 07:00), o que a fazia ser PAGA no SN do dia 31 sem ter trabalhado, e
// travava a tag "Continua" no lugar do botão de retirar.
//
// O rótulo do bloco novo é o turno da chegada; a cobertura, 12h.
test("continuidade em outro posto abre bloco de 12h, não 24h", () => {
    const chegada = new Date("2026-07-31T07:10:24-03:00");
    assert.equal(resolveArrivalShiftLabel(chegada), "SD");

    const janela = inferInterventionCoverageWindow({
        startedAt: chegada,
        shiftLabel: resolveArrivalShiftLabel(chegada),
        explicitScheduledStartAt: null,
        explicitScheduledEndAt: null,
    });
    assert.equal(janela.scheduledStartAt?.toISOString(), new Date("2026-07-31T07:00:00-03:00").toISOString());
    assert.equal(janela.scheduledEndAt?.toISOString(), new Date("2026-07-31T19:00:00-03:00").toISOString());

    // O que acontecia antes: rótulo "P" no mesmo registro esticava para 01/08 07:00.
    const janelaAntiga = inferInterventionCoverageWindow({
        startedAt: chegada,
        shiftLabel: "P",
        explicitScheduledStartAt: null,
        explicitScheduledEndAt: null,
    });
    assert.equal(janelaAntiga.scheduledEndAt?.toISOString(), new Date("2026-08-01T07:00:00-03:00").toISOString());
});

// Avisar continuidade pouco antes da virada tem de abrir o turno SEGUINTE, não repetir
// o que está acabando: quem está no SD e avisa 18:50 que segue à noite abre o SN.
test("continuidade avisada pouco antes da virada abre o turno seguinte", () => {
    const aviso = new Date("2026-07-31T18:50:00-03:00");
    assert.equal(resolveArrivalShiftLabel(aviso), "SN");

    const janela = inferInterventionCoverageWindow({
        startedAt: aviso,
        shiftLabel: resolveArrivalShiftLabel(aviso),
        explicitScheduledStartAt: null,
        explicitScheduledEndAt: null,
    });
    assert.equal(janela.scheduledStartAt?.toISOString(), new Date("2026-07-31T19:00:00-03:00").toISOString());
    assert.equal(janela.scheduledEndAt?.toISOString(), new Date("2026-08-01T07:00:00-03:00").toISOString());
});
