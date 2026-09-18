import assert from "node:assert/strict";
import test from "node:test";
import {
    buildReassignmentTargetOccupiedMessage,
    buildTelegramArrivalConflictMessage,
    isExpiredReassignmentConflict,
    isPreviousShiftReassignmentConflict,
    resolveReassignmentConflictCoverageEndAt,
} from "@/modules/telegram/service";

// Cenário real (jul/2026): Helmira Rafaela deu P na véspera na 2032. O painel a
// escondeu às 07:15, mas a ocupação seguia aberta e o remanejo de Carolina para a
// 2032 era rejeitado. Cobertura vencida agora conta como fantasma e é rendida.
test("P da vespera com scheduledEndAt vencido conta como fantasma no remanejo", () => {
    const coverageEndAt = resolveReassignmentConflictCoverageEndAt({
        startedAt: new Date("2026-07-13T07:20:00-03:00"),
        boardStartedAt: new Date("2026-07-13T07:20:00-03:00"),
        scheduledEndAt: new Date("2026-07-14T07:15:00-03:00"),
        shiftLabel: "P",
    });

    assert.deepEqual(coverageEndAt, new Date("2026-07-14T07:15:00-03:00"));
    assert.equal(isExpiredReassignmentConflict(coverageEndAt, new Date("2026-07-14T07:40:00-03:00")), true);
});

test("ocupante do turno atual com cobertura vigente segue bloqueando o remanejo", () => {
    const coverageEndAt = resolveReassignmentConflictCoverageEndAt({
        startedAt: new Date("2026-07-14T07:05:00-03:00"),
        boardStartedAt: new Date("2026-07-14T07:05:00-03:00"),
        scheduledEndAt: new Date("2026-07-14T19:15:00-03:00"),
        shiftLabel: "SD",
    });

    assert.equal(isExpiredReassignmentConflict(coverageEndAt, new Date("2026-07-14T09:00:00-03:00")), false);
});

test("continuidade declarada (scheduledEndAt futuro) protege o ocupante carry-over", () => {
    // P da véspera que declarou continuidade: o scheduledEndAt foi estendido para o
    // fim do próximo bloco. Ainda ocupa de verdade — o remanejo deve ser bloqueado.
    const coverageEndAt = resolveReassignmentConflictCoverageEndAt({
        startedAt: new Date("2026-07-13T07:20:00-03:00"),
        boardStartedAt: new Date("2026-07-13T07:20:00-03:00"),
        scheduledEndAt: new Date("2026-07-14T19:15:00-03:00"),
        shiftLabel: "P",
    });

    assert.equal(isExpiredReassignmentConflict(coverageEndAt, new Date("2026-07-14T07:40:00-03:00")), false);
});

test("sem scheduledEndAt, P usa a expiracao implicita (07:00 do dia seguinte)", () => {
    const coverageEndAt = resolveReassignmentConflictCoverageEndAt({
        startedAt: new Date("2026-07-13T07:20:00-03:00"),
        boardStartedAt: null,
        scheduledEndAt: null,
        shiftLabel: "P",
    });

    assert.deepEqual(coverageEndAt, new Date("2026-07-14T07:00:00-03:00"));
    assert.equal(isExpiredReassignmentConflict(coverageEndAt, new Date("2026-07-14T07:30:00-03:00")), true);
});

test("isExpiredReassignmentConflict trata cobertura desconhecida como conflito real", () => {
    assert.equal(isExpiredReassignmentConflict(null, new Date("2026-07-14T07:40:00-03:00")), false);
});

test("mensagem de destino ocupado nomeia o ocupante e ensina a declarar a saida", () => {
    const message = buildReassignmentTargetOccupiedMessage({
        occupantName: "Helmira Rafaela",
        targetLabel: "2032",
    });

    assert.match(message, /Helmira Rafaela/);
    assert.match(message, /2032/);
    assert.match(message, /declare a sa[íi]da/i);
});

// Incidente 18/09/2026: Caio (SD) remanejando 2152 -> 2153 às 07:13 foi barrado pelo
// SN da véspera (scheduledEndAt 07:15) e o chat recebeu o erro genérico.
test("SN da vespera nao barra remanejo na virada; mesmo turno continua barrando", () => {
    const eventAt = new Date("2026-09-18T07:13:05-03:00");
    assert.equal(isPreviousShiftReassignmentConflict(new Date("2026-09-17T18:41:36-03:00"), eventAt), true);
    assert.equal(isPreviousShiftReassignmentConflict(new Date("2026-09-18T07:05:00-03:00"), eventAt), false);
    assert.equal(isPreviousShiftReassignmentConflict(new Date("2026-09-18T06:50:00-03:00"), eventAt), false);
});

test("destino ocupado chega ao chat com o ocupante, nunca o erro generico", () => {
    const text = buildTelegramArrivalConflictMessage({
        parsed: { baseCode: "2153", isDeparture: false, isContinuation: false },
        errorMessage: buildReassignmentTargetOccupiedMessage({ occupantName: "José Roberto", targetLabel: "2153" }),
    });
    assert.match(text, /Encontrei \*José Roberto\* em \*2153\*/);
    assert.doesNotMatch(text, /do meu lado/);
});
