import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    INTERVENTION_COMPANION_NOTE_MARKER,
    appendInterventionCompanionMarker,
    isInterventionCompanionOccupancyNotes,
    pickInterventionBoardReplacement,
    preserveInterventionCompanionMarker,
    preserveInterventionOffBoardMarkers,
    resolveStaleShadowInterventionEndedAt,
    shouldJoinInterventionBaseAsCompanion,
    stripInterventionCompanionMarker,
} from "@/modules/intervention/service";
import {
    describeOperationalError,
    isOperationalBoardConflictError,
    resolveTransferDestinationDecision,
} from "@/modules/operational/corrections";
import { resolveOccupantCoverageEndAt } from "@/modules/operational/board-rules";
import { buildSharedBaseHint } from "@/modules/telegram/service";

const d = (iso: string) => new Date(iso);

// Dupla: dois médicos na mesma USA. Regra-mãe do dono (20/09/2026): quem avisou
// chegada para o turno não sai da base por comando de outro médico.
function carrier(overrides: Partial<{
    doctorId: string;
    startedAt: Date;
    boardStartedAt: Date | null;
    scheduledEndAt: Date | null;
    shiftLabel: string | null;
    notes: string | null;
}> = {}) {
    return {
        doctorId: "doc-titular",
        startedAt: d("2026-09-20T07:02:00-03:00"),
        boardStartedAt: d("2026-09-20T07:02:00-03:00"),
        scheduledEndAt: d("2026-09-20T19:00:00-03:00"),
        shiftLabel: "SD",
        notes: "Leo Morais CZ50 SD",
        ...overrides,
    };
}

describe("shouldJoinInterventionBaseAsCompanion", () => {
    it("chegada no MESMO turno divide a base em vez de encerrar o titular", () => {
        assert.equal(shouldJoinInterventionBaseAsCompanion({
            carrier: carrier(),
            arrivingDoctorId: "doc-novo",
            arrivalAt: d("2026-09-20T09:40:00-03:00"),
        }), true);
    });

    it("titular que chegou adiantado (05h) para o turno também é protegido", () => {
        assert.equal(shouldJoinInterventionBaseAsCompanion({
            carrier: carrier({
                startedAt: d("2026-09-20T05:20:00-03:00"),
                boardStartedAt: d("2026-09-20T05:20:00-03:00"),
            }),
            arrivingDoctorId: "doc-novo",
            arrivalAt: d("2026-09-20T07:10:00-03:00"),
        }), true);
    });

    it("P de 24h com cobertura que segue: quem chega à noite divide a base", () => {
        assert.equal(shouldJoinInterventionBaseAsCompanion({
            carrier: carrier({ shiftLabel: "P", scheduledEndAt: d("2026-09-21T07:00:00-03:00") }),
            arrivingDoctorId: "doc-novo",
            arrivalAt: d("2026-09-20T19:05:00-03:00"),
        }), true);
    });

    it("fim do turno anterior continua sendo rendição normal", () => {
        assert.equal(shouldJoinInterventionBaseAsCompanion({
            carrier: carrier(),
            arrivingDoctorId: "doc-noturno",
            arrivalAt: d("2026-09-20T18:50:00-03:00"),
        }), false);
    });

    it("sombra declarada, base vazia, titular sombra e o próprio médico não viram dupla", () => {
        const arrivalAt = d("2026-09-20T09:40:00-03:00");
        assert.equal(shouldJoinInterventionBaseAsCompanion({ carrier: carrier(), arrivingDoctorId: "doc-novo", arrivalAt, arrivingIsShadow: true }), false);
        assert.equal(shouldJoinInterventionBaseAsCompanion({ carrier: null, arrivingDoctorId: "doc-novo", arrivalAt }), false);
        assert.equal(shouldJoinInterventionBaseAsCompanion({ carrier: carrier({ notes: "[telegram sombra] Fulano CZ50" }), arrivingDoctorId: "doc-novo", arrivalAt }), false);
        assert.equal(shouldJoinInterventionBaseAsCompanion({ carrier: carrier(), arrivingDoctorId: "doc-titular", arrivalAt }), false);
    });
});

describe("marcador [DUPLA]", () => {
    it("entra uma vez só; o remanejo para outro alvo tira o marcador da ocupação nova", () => {
        const joinedAt = d("2026-09-20T09:40:00-03:00");
        const marked = appendInterventionCompanionMarker("Leonardo Copque CZ50", joinedAt);
        assert.ok(marked?.includes(INTERVENTION_COMPANION_NOTE_MARKER));
        assert.ok(isInterventionCompanionOccupancyNotes(marked));
        assert.equal(appendInterventionCompanionMarker(marked, joinedAt), marked);
        assert.equal(stripInterventionCompanionMarker(marked), "Leonardo Copque CZ50");
        assert.equal(stripInterventionCompanionMarker(appendInterventionCompanionMarker(null, joinedAt)), null);
        assert.equal(isInterventionCompanionOccupancyNotes("Leonardo Copque CZ50"), false);
    });
});

describe("preserveInterventionOffBoardMarkers", () => {
    it("'continua' e correção pela tela trocam as notas sem apagar [DUPLA]/[DESLOCADO]", () => {
        const existing = "Leonardo Copque CZ50\n[DUPLA] 2026-09-20T12:40:00.000Z";
        const kept = preserveInterventionOffBoardMarkers(existing, "Leonardo Copque continua CZ50");
        assert.ok(isInterventionCompanionOccupancyNotes(kept));
        assert.ok(kept?.startsWith("Leonardo Copque continua CZ50"));
        // Idempotente e sem inventar marcador onde não havia.
        assert.equal(preserveInterventionOffBoardMarkers(existing, kept), kept);
        assert.equal(preserveInterventionOffBoardMarkers("Leo Morais CZ50", "motivo da chefia"), "motivo da chefia");
        assert.match(
            preserveInterventionOffBoardMarkers("Fulano PM40\n[DESLOCADO] 2026-09-20T13:00:00.000Z por Beltrano", "horario corrigido") ?? "",
            /\[DESLOCADO\]/,
        );
        assert.equal(preserveInterventionOffBoardMarkers(existing, null), "[DUPLA] 2026-09-20T12:40:00.000Z");
    });

    it("quem assumiu o quadro leva só o [DUPLA] adiante (é o que o pagamento lê); [DESLOCADO] não acompanha", () => {
        const existing = "Fulano CZ50\n[DUPLA] 2026-09-20T12:40:00.000Z\n[DESLOCADO] 2026-09-20T13:00:00.000Z por Beltrano";
        const kept = preserveInterventionCompanionMarker(existing, "Fulano continua CZ50") ?? "";
        assert.match(kept, /\[DUPLA\]/);
        assert.doesNotMatch(kept, /\[DESLOCADO\]/);
    });
});

describe("pickInterventionBoardReplacement", () => {
    const vacatedAt = d("2026-09-20T12:00:00-03:00");

    it("dupla herda o quadro antes de uma sombra mais antiga", () => {
        const shadow = { id: "sombra", startedAt: d("2026-09-20T07:30:00-03:00"), notes: "[telegram sombra] residente" };
        const companion = { id: "dupla", startedAt: d("2026-09-20T09:40:00-03:00"), notes: "[DUPLA] 2026-09-20T12:40:00.000Z" };
        assert.equal(pickInterventionBoardReplacement([shadow, companion], vacatedAt)?.id, "dupla");
    });

    it("sem dupla vale a regra antiga; quem chegou depois da vaga não herda", () => {
        const shadow = { id: "sombra", startedAt: d("2026-09-20T07:30:00-03:00"), notes: "[telegram sombra] residente" };
        const late = { id: "tarde", startedAt: d("2026-09-20T13:00:00-03:00"), notes: null };
        assert.equal(pickInterventionBoardReplacement([late, shadow], vacatedAt)?.id, "sombra");
        assert.equal(pickInterventionBoardReplacement([late], vacatedAt), null);
    });
});

describe("dupla fora do quadro vence no fim da janela, como sombra", () => {
    const notes = "Leonardo Copque CZ50\n[DUPLA] 2026-09-20T12:40:00.000Z";
    const scheduledEndAt = d("2026-09-20T19:00:00-03:00");

    it("sem board e passada a janela, fecha no scheduledEnd", () => {
        assert.equal(resolveStaleShadowInterventionEndedAt({
            notes, boardStartedAt: null, scheduledEndAt, endedAt: null, referenceAt: d("2026-09-20T19:01:00-03:00"),
        })?.toISOString(), scheduledEndAt.toISOString());
        assert.equal(resolveStaleShadowInterventionEndedAt({
            notes, boardStartedAt: null, scheduledEndAt, endedAt: null, referenceAt: d("2026-09-20T18:59:00-03:00"),
        }), null);
    });

    it("dupla que assumiu o quadro não é varrida", () => {
        assert.equal(resolveStaleShadowInterventionEndedAt({
            notes, boardStartedAt: d("2026-09-20T12:00:00-03:00"), scheduledEndAt, endedAt: null, referenceAt: d("2026-09-20T19:30:00-03:00"),
        }), null);
    });
});

describe("resolveTransferDestinationDecision", () => {
    const transferredAt = d("2026-09-20T10:00:00-03:00");
    const occupant = {
        startedAt: d("2026-09-20T07:02:00-03:00"),
        boardStartedAt: d("2026-09-20T07:02:00-03:00"),
        scheduledEndAt: d("2026-09-20T19:00:00-03:00"),
        shiftLabel: "SD",
    };

    it("destino vazio ou entrada como sombra: nada a resolver", () => {
        assert.deepEqual(resolveTransferDestinationDecision({ carrier: null, destinationDomain: "intervention", transferredAt }), { kind: "free" });
        assert.deepEqual(resolveTransferDestinationDecision({
            carrier: occupant, destinationDomain: "intervention", asShadow: true, strategy: "remove_destination", transferredAt,
        }), { kind: "free" });
    });

    it("titular vigente sem escolha da chefia pede decisão — nunca estoura no índice", () => {
        assert.deepEqual(resolveTransferDestinationDecision({ carrier: occupant, destinationDomain: "intervention", transferredAt }), { kind: "needs_resolution" });
    });

    it("escolha explícita vence; dividir só vale em base de intervenção", () => {
        assert.deepEqual(resolveTransferDestinationDecision({
            carrier: occupant, destinationDomain: "intervention", strategy: "share_destination", transferredAt,
        }), { kind: "resolve", strategy: "share_destination" });
        assert.deepEqual(resolveTransferDestinationDecision({
            carrier: occupant, destinationDomain: "regulation", strategy: "displace_destination", transferredAt,
        }), { kind: "resolve", strategy: "displace_destination" });
        assert.throws(() => resolveTransferDestinationDecision({
            carrier: occupant, destinationDomain: "regulation", strategy: "share_destination", transferredAt,
        }), /nao comporta dois medicos/);
    });

    it("fantasma de cobertura vencida (P da véspera) é rendido no fim da cobertura dele", () => {
        const ghostEnd = d("2026-09-20T07:00:00-03:00");
        assert.deepEqual(resolveTransferDestinationDecision({
            carrier: {
                startedAt: d("2026-09-19T07:05:00-03:00"),
                boardStartedAt: d("2026-09-19T07:05:00-03:00"),
                scheduledEndAt: ghostEnd,
                shiftLabel: "P",
            },
            destinationDomain: "intervention",
            transferredAt,
        }), { kind: "relieve", closedAt: ghostEnd });
    });

    it("noturno ainda aberto na virada é rendição normal, no horário do remanejo", () => {
        const at = d("2026-09-20T07:05:00-03:00");
        assert.deepEqual(resolveTransferDestinationDecision({
            carrier: {
                startedAt: d("2026-09-19T19:03:00-03:00"),
                boardStartedAt: d("2026-09-19T19:03:00-03:00"),
                scheduledEndAt: d("2026-09-20T07:15:00-03:00"),
                shiftLabel: "SN",
            },
            destinationDomain: "regulation",
            transferredAt: at,
        }), { kind: "relieve", closedAt: at });
    });
});

describe("erro de banco nunca chega cru à chefia", () => {
    const fallback = "Nao foi possivel remanejar agora.";

    it("reconhece a violação do índice de um titular por posto/base, inclusive embrulhada pelo Drizzle", () => {
        const pg = Object.assign(new Error('duplicate key value violates unique constraint "intervention_occupancies_one_active_board_per_base_idx"'), { code: "23505" });
        const wrapped = Object.assign(new Error("Failed query: insert into \"operations_v2\".\"intervention_occupancies\" (...) values (...)"), { cause: pg });
        assert.equal(isOperationalBoardConflictError(pg), true);
        assert.equal(isOperationalBoardConflictError(wrapped), true);
        assert.match(describeOperationalError(wrapped, fallback), /ja tem um titular no quadro/);
    });

    it("SQL desconhecido vira a frase de fallback; erro de negócio passa como está", () => {
        assert.equal(describeOperationalError(new Error("Failed query: update x set y"), fallback), fallback);
        assert.equal(describeOperationalError(new Error("So ocupacoes ativas podem ser remanejadas."), fallback), "So ocupacoes ativas podem ser remanejadas.");
        assert.equal(isOperationalBoardConflictError(new Error("So ocupacoes ativas podem ser remanejadas.")), false);
    });
});

describe("resolveOccupantCoverageEndAt", () => {
    it("usa o scheduledEndAt; sem ele, a expiração implícita do turno", () => {
        const scheduledEndAt = d("2026-09-20T19:00:00-03:00");
        assert.equal(resolveOccupantCoverageEndAt({
            startedAt: d("2026-09-20T07:02:00-03:00"), boardStartedAt: null, scheduledEndAt, shiftLabel: "SD",
        })?.toISOString(), scheduledEndAt.toISOString());
        assert.ok(resolveOccupantCoverageEndAt({
            startedAt: d("2026-09-20T07:02:00-03:00"), boardStartedAt: null, scheduledEndAt: null, shiftLabel: "SD",
        }));
    });
});

describe("buildSharedBaseHint", () => {
    it("diz com quem a base ficou dividida e que ninguém foi retirado", () => {
        const hint = buildSharedBaseHint({ baseCode: "CZ50", doctorNames: ["Leo Morais", "Leonardo Copque"] });
        assert.match(hint, /CZ50/);
        assert.match(hint, /\*Leo Morais\* \+ \*Leonardo Copque\*/);
        assert.match(hint, /Ninguém foi retirado/);
        assert.equal(buildSharedBaseHint({ baseCode: "CZ50", doctorNames: ["Leo Morais"] }), "");
    });
});
