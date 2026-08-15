import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    describeContestedDeparture,
    resolveContestedBoardDecision,
} from "@/modules/operational/contested-departure";

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
