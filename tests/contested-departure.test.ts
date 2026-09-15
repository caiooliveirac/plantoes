import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    CONTESTED_DEPARTURE_NOTE_MARKER,
    describeContestBlockedByLaterArrival,
    describeContestedDeparture,
    isContestedDepartureNotes,
    resolveContestedBoardDecision,
} from "@/modules/operational/contested-departure";
import { resolveStaleShadowInterventionEndedAt } from "@/modules/intervention/service";

function d(value: string) {
    return new Date(value);
}

describe("resolveContestedBoardDecision", () => {
    it("com outro médico no quadro, NÃO o derruba — volta fora do quadro e nomeia o conflito", () => {
        // Caso Maria Juliana BR05 14/08: David entrou na base errada às 19:41.
        const decisao = resolveContestedBoardDecision({
            continuation: "same_target",
            boardHeldByOther: { doctorName: "David Menezes", since: d("2026-08-14T19:41:00-03:00") },
            previousBoardStartedAt: d("2026-08-14T06:58:00-03:00"),
            startedAt: d("2026-08-14T06:58:00-03:00"),
        });
        assert.equal(decisao.boardStartedAt, null);
        assert.match(decisao.outOfBoardReason ?? "", /David Menezes/);
        assert.match(decisao.outOfBoardReason ?? "", /19:41/);
        assert.match(decisao.outOfBoardReason ?? "", /não tira ninguém do quadro/);
    });

    it("alvo livre e chefe diz que continuou ali: volta ao quadro na âncora antiga", () => {
        const decisao = resolveContestedBoardDecision({
            continuation: "same_target",
            boardHeldByOther: null,
            previousBoardStartedAt: d("2026-08-14T06:58:00-03:00"),
            startedAt: d("2026-08-14T07:10:00-03:00"),
        });
        assert.equal(decisao.boardStartedAt?.toISOString(), d("2026-08-14T06:58:00-03:00").toISOString());
        assert.equal(decisao.outOfBoardReason, null);
    });

    it("sem âncora anterior, volta ao quadro pela chegada", () => {
        const decisao = resolveContestedBoardDecision({
            continuation: "same_target",
            boardHeldByOther: null,
            previousBoardStartedAt: null,
            startedAt: d("2026-08-14T07:10:00-03:00"),
        });
        assert.equal(decisao.boardStartedAt?.toISOString(), d("2026-08-14T07:10:00-03:00").toISOString());
    });

    it("chefe diz que foi para outro alvo: fora do quadro até o remanejamento", () => {
        const decisao = resolveContestedBoardDecision({
            continuation: "other_target",
            boardHeldByOther: null,
            previousBoardStartedAt: d("2026-08-14T06:58:00-03:00"),
            startedAt: d("2026-08-14T06:58:00-03:00"),
        });
        assert.equal(decisao.boardStartedAt, null);
        assert.match(decisao.outOfBoardReason ?? "", /mesma ocupação/);
    });

    it("chefe não sabe onde ficou: fora do quadro, e a tela diz isso", () => {
        const decisao = resolveContestedBoardDecision({
            continuation: "unknown",
            boardHeldByOther: null,
            previousBoardStartedAt: null,
            startedAt: d("2026-08-14T06:58:00-03:00"),
        });
        assert.equal(decisao.boardStartedAt, null);
        assert.match(decisao.outOfBoardReason ?? "", /ninguém informou/);
    });
});

describe("describeContestedDeparture", () => {
    it("registra a hora contestada e o que o chefe disse", () => {
        const nota = describeContestedDeparture({
            contestedDepartureAt: d("2026-08-14T19:41:00-03:00"),
            continuation: "same_target",
        });
        assert.match(nota, /\[NÃO SAIU\]/);
        assert.match(nota, /19:41/);
        assert.match(nota, /mesmo posto\/base/);
        assert.match(nota, /nenhuma ocupação nova/);
    });

    it("nomeia o alvo informado quando o médico mudou de lugar", () => {
        const nota = describeContestedDeparture({
            contestedDepartureAt: d("2026-08-14T19:41:00-03:00"),
            continuation: "other_target",
            continuedAtLabel: "CB02",
        });
        assert.match(nota, /CB02/);
    });

    it("aceita a contestação sem saber o destino", () => {
        const nota = describeContestedDeparture({
            contestedDepartureAt: d("2026-08-14T19:41:00-03:00"),
            continuation: "unknown",
        });
        assert.match(nota, /sem informação/);
    });
});

describe("contestação bloqueada por chegada posterior", () => {
    it("médico já chegou em outra base: explica que a saída aconteceu e aponta os dois caminhos", () => {
        // Caso Laisse IT30→CZ50, 2026-09-15: "não saiu" reabriu a SN e derrubou o quadro.
        const texto = describeContestBlockedByLaterArrival({
            doctorName: "Laisse Oliveira",
            targetCode: "IT30",
            contestedDepartureAt: d("2026-09-15T07:20:00-03:00"),
            laterArrival: { targetCode: "CZ50", startedAt: d("2026-09-15T07:45:00-03:00") },
        });
        assert.match(texto, /chegada em CZ50 às 07:45/);
        assert.match(texto, /saída de IT30 às 07:20 aconteceu/);
        assert.match(texto, /Confirme a saída/);
        assert.match(texto, /corrija o horário para 07:45/);
    });
});

describe("reaberto por NÃO SAIU fora do quadro vence no fim da janela", () => {
    const notes = describeContestedDeparture({
        contestedDepartureAt: d("2026-09-15T07:20:00-03:00"),
        continuation: "other_target",
        continuedAtLabel: "CZ50",
    });

    it("a nota da contestação carrega o marcador", () => {
        assert.ok(notes.includes(CONTESTED_DEPARTURE_NOTE_MARKER));
        assert.ok(isContestedDepartureNotes(notes));
        assert.equal(isContestedDepartureNotes("Fulano SN 30"), false);
    });

    it("sem board e passada a janela, a varredura fecha no scheduledEnd", () => {
        assert.equal(resolveStaleShadowInterventionEndedAt({
            notes,
            boardStartedAt: null,
            scheduledEndAt: d("2026-09-15T07:00:00-03:00"),
            endedAt: null,
            referenceAt: d("2026-09-15T19:00:00-03:00"),
        })?.toISOString(), d("2026-09-15T07:00:00-03:00").toISOString());
    });

    it("com board (voltou ao quadro como titular), não é a varredura que fecha", () => {
        assert.equal(resolveStaleShadowInterventionEndedAt({
            notes,
            boardStartedAt: d("2026-09-14T19:03:00-03:00"),
            scheduledEndAt: d("2026-09-15T07:00:00-03:00"),
            endedAt: null,
            referenceAt: d("2026-09-15T19:00:00-03:00"),
        }), null);
    });

    it("registro comum sem marcador e sem board segue fora da varredura", () => {
        assert.equal(resolveStaleShadowInterventionEndedAt({
            notes: "Fulano SN 30",
            boardStartedAt: null,
            scheduledEndAt: d("2026-09-15T07:00:00-03:00"),
            endedAt: null,
            referenceAt: d("2026-09-15T19:00:00-03:00"),
        }), null);
    });
});
