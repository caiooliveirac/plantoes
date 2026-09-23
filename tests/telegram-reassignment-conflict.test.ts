import assert from "node:assert/strict";
import test from "node:test";

import { classifyTurnoArrivalEdit } from "@/modules/operational/corrections";

import { isSameTurnoOccupant, shouldDisplaceInsteadOfRelieve } from "@/modules/operational/board-rules";
import {
    buildReassignmentTargetOccupiedMessage,
    buildTelegramArrivalConflictMessage,
    isExpiredReassignmentConflict,
    isPreviousShiftReassignmentConflict,
    pickFirstArrivalAttemptAt,
    resolveCrossTurnoMoveShift,
    resolveReassignmentConflictCoverageEndAt,
    shouldTreatReassignmentAsArrival,
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

// Quem chegou 06:49 para o SD é do MESMO turno de quem chega 07:26: tomada pede
// confirmação e o ocupante vira deslocado — nunca é rendido/fechado por troca de ramal.
test("mesmo turno nao depende do inicio da janela; SD de ontem nao e o SD de hoje", () => {
    assert.equal(isSameTurnoOccupant(at("2026-09-18T06:49:44-03:00"), at("2026-09-18T07:26:22-03:00")), true);
    assert.equal(isSameTurnoOccupant(at("2026-09-17T18:41:00-03:00"), at("2026-09-18T07:13:00-03:00")), false);
    assert.equal(isSameTurnoOccupant(at("2026-09-17T07:20:00-03:00"), at("2026-09-18T07:10:00-03:00")), false);
});

test("hora da chegada e a da primeira tentativa: mesmo turno, ate 2h", () => {
    const eventAt = at("2026-09-18T07:20:00-03:00");
    assert.deepEqual(pickFirstArrivalAttemptAt([at("2026-09-18T07:10:00-03:00"), at("2026-09-18T07:05:00-03:00")], eventAt), at("2026-09-18T07:05:00-03:00"));
    // fora da janela de 2h, ou nenhuma tentativa: vale a hora da mensagem que passou
    assert.deepEqual(pickFirstArrivalAttemptAt([at("2026-09-18T05:10:00-03:00")], eventAt), eventAt);
    assert.deepEqual(pickFirstArrivalAttemptAt([], eventAt), eventAt);
});

const at = (iso: string) => new Date(iso);

// Quem chega nunca ENCERRA cobertura vigente: desloca (segue no plantão, é pago).
test("P vigente e mesmo turno sao deslocados; fim do turno anterior e rendicao", () => {
    // P de 24h que começou 07:10 (cobre até 07:15 de amanhã), SN chega/é remanejado 19:20
    assert.equal(shouldDisplaceInsteadOfRelieve({
        occupantAnchorAt: at("2026-09-18T07:10:00-03:00"),
        occupantCoverageEndAt: at("2026-09-19T07:15:00-03:00"),
        arrivalAt: at("2026-09-18T19:20:00-03:00"),
    }), true);
    // SD (até 19:15) rendido pelo SN que chega cedo 17:30 ou 19:05
    for (const arrival of ["2026-09-18T17:30:00-03:00", "2026-09-18T19:05:00-03:00"]) {
        assert.equal(shouldDisplaceInsteadOfRelieve({
            occupantAnchorAt: at("2026-09-18T07:05:00-03:00"),
            occupantCoverageEndAt: at("2026-09-18T19:15:00-03:00"),
            arrivalAt: at(arrival),
        }), false, arrival);
    }
    // SN (até 07:15) rendido pelo SD das 07:13 — o incidente de hoje
    assert.equal(shouldDisplaceInsteadOfRelieve({
        occupantAnchorAt: at("2026-09-17T18:41:00-03:00"),
        occupantCoverageEndAt: at("2026-09-18T07:15:00-03:00"),
        arrivalAt: at("2026-09-18T07:13:00-03:00"),
    }), false);
    // P fantasma (cobertura vencida) segue sendo rendido
    assert.equal(shouldDisplaceInsteadOfRelieve({
        occupantAnchorAt: at("2026-09-17T07:20:00-03:00"),
        occupantCoverageEndAt: at("2026-09-18T07:15:00-03:00"),
        arrivalAt: at("2026-09-18T07:40:00-03:00"),
    }), false);
});

// Beltrano (SD na CZ50) vai à noite para a CC70: é SN novo, não clone do SD.
test("remanejo depois do fim do turno de origem vira chegada do turno seguinte", () => {
    const sdEnd = at("2026-09-18T19:15:00-03:00");
    const move = (eventAt: string, label = "SD") => resolveCrossTurnoMoveShift({
        isMove: true, activeShiftLabel: label, activeScheduledEndAt: sdEnd, eventAt: at(eventAt),
    });
    assert.equal(move("2026-09-18T19:20:00-03:00"), "SN");
    assert.equal(move("2026-09-18T21:50:00-03:00"), "SN");
    assert.equal(move("2026-09-18T15:00:00-03:00"), null); // troca de ramal dentro do SD
    assert.equal(move("2026-09-18T19:05:00-03:00"), null); // ainda dentro da janela do SD
    assert.equal(move("2026-09-18T19:20:00-03:00", "P"), null); // P segue P
    assert.equal(resolveCrossTurnoMoveShift({ isMove: false, activeShiftLabel: "SD", activeScheduledEndAt: sdEnd, eventAt: at("2026-09-18T19:20:00-03:00") }), null);
});

// Card de quem trocou de ramal devolve a chegada do turno: eco não grava nada no
// destino (senão qualquer edição reescrevia o livro); horário novo corrige a ORIGEM.
test("edicao de chegada em card movido: eco ignora, mudanca real vai para a origem", () => {
    const origin = at("2026-09-18T06:49:44-03:00");
    assert.equal(classifyTurnoArrivalEdit({ originStartedAt: origin, requestedArrivalAt: at("2026-09-18T06:49:44-03:00") }), "echo");
    assert.equal(classifyTurnoArrivalEdit({ originStartedAt: origin, requestedArrivalAt: at("2026-09-18T06:49:00-03:00") }), "echo");
    assert.equal(classifyTurnoArrivalEdit({ originStartedAt: origin, requestedArrivalAt: at("2026-09-18T06:55:00-03:00") }), "correct_origin");
    assert.equal(classifyTurnoArrivalEdit({ originStartedAt: null, requestedArrivalAt: at("2026-09-18T06:55:00-03:00") }), "not_a_move");
});

// D12 (docs/chegada.md): "remanejado para X" nunca é recusado. Sem plantão aberto, ou
// já estando em X, vira chegada comum.
test("shouldTreatReassignmentAsArrival: sem plantão aberto ou já no destino vira chegada", () => {
    const parsed = { isReassignment: true, sector: "REGULATION" as const, baseCode: "2153" };
    assert.equal(shouldTreatReassignmentAsArrival({ parsed, activeOcc: null }), true);
    assert.equal(shouldTreatReassignmentAsArrival({ parsed, activeOcc: { sector: "REGULATION", baseCode: "2153" } }), true);
    assert.equal(shouldTreatReassignmentAsArrival({ parsed, activeOcc: { sector: "REGULATION", baseCode: "2151" } }), false);
    assert.equal(shouldTreatReassignmentAsArrival({ parsed: { ...parsed, isReassignment: false }, activeOcc: null }), false);
});
