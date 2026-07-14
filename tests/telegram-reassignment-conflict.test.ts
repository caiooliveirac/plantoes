import assert from "node:assert/strict";
import test from "node:test";
import {
    buildReassignmentTargetOccupiedMessage,
    isExpiredReassignmentConflict,
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
