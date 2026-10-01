import { test } from "node:test";
import assert from "node:assert/strict";

import { motivoValido } from "@/components/board/motivo-chips-logica";
import {
    cruzaMeiaNoite,
    formatarHHMM,
    inicioDoDia,
    interpretarHHMM,
    presetsDoEditor,
    resolverHHMM,
    rotuloDelta,
    rotuloDoDia,
} from "@/components/board/editor-de-horario-logica";
import { azulejosDoSnapshot } from "@/components/board/azulejos-do-quadro";
import type { InterventionBoardRow, RegulationBoardRow } from "@/services/board.service";

// 2026-03-10 07:00 no fuso operacional (UTC-3) = 10:00Z
const T0700 = Date.parse("2026-03-10T10:00:00Z");
const H = 60 * 60 * 1000;
const M = 60 * 1000;

test("motivoValido: mínimo de 8 caracteres úteis, configurável", () => {
    assert.equal(motivoValido(""), false);
    assert.equal(motivoValido("   curto  "), false);
    assert.equal(motivoValido("Erro de registro"), true);
    assert.equal(motivoValido("abc", 3), true);
    assert.equal(motivoValido("ab ", 3), false);
});

test("formatarHHMM e inicioDoDia usam o fuso operacional, não o do processo", () => {
    assert.equal(formatarHHMM(T0700), "07:00");
    assert.equal(formatarHHMM(T0700 + 12 * H), "19:00");
    assert.equal(formatarHHMM(inicioDoDia(T0700)), "00:00");
    assert.equal(inicioDoDia(T0700), T0700 - 7 * H);
    // 23:30 local do dia anterior ainda é "ontem"
    assert.equal(inicioDoDia(T0700 - 7.5 * H), T0700 - 7 * H - 24 * H);
});

test("interpretarHHMM aceita variações e rejeita lixo", () => {
    assert.equal(interpretarHHMM("07:05"), 7 * 60 + 5);
    assert.equal(interpretarHHMM("7:05"), 7 * 60 + 5);
    assert.equal(interpretarHHMM("0705"), 7 * 60 + 5);
    assert.equal(interpretarHHMM("19.30"), 19 * 60 + 30);
    assert.equal(interpretarHHMM("24:00"), null);
    assert.equal(interpretarHHMM("12:60"), null);
    assert.equal(interpretarHHMM("abc"), null);
    assert.equal(interpretarHHMM(""), null);
});

test("resolverHHMM: janela diurna resolve no dia do valor atual e limita à faixa", () => {
    const ctx = { valorMs: T0700 + 2 * H, minMs: T0700 - 2 * H, maxMs: T0700 + 14 * H };
    assert.equal(resolverHHMM("08:15", ctx), T0700 + H + 15 * M);
    // 23:00 do mesmo dia está fora da faixa (max 21:00) → limita ao max
    assert.equal(resolverHHMM("23:00", ctx), ctx.maxMs);
    assert.equal(resolverHHMM("xx", ctx), null);
});

test("resolverHHMM: janela noturna — hora ambígua vai para o instante mais perto do valor atual", () => {
    // SN 19:00 → 07:00 do dia seguinte; faixa de 17:00 a 09:00 (dia seguinte)
    const inicioSN = T0700 + 12 * H; // 19:00
    const ctx = { valorMs: inicioSN + 5 * H, minMs: inicioSN - 2 * H, maxMs: inicioSN + 14 * H }; // valor 00:00
    // "23:30" cabe só no dia de ontem (relativo ao valor, que já é 00:00 de hoje)
    assert.equal(resolverHHMM("23:30", ctx), inicioSN + 4.5 * H);
    // "06:00" cabe só no dia de hoje
    assert.equal(resolverHHMM("06:00", ctx), inicioSN + 11 * H);
    // Valor em 18:00 e digita "08:00": cabe só amanhã (08:00 de amanhã ≤ max 09:00)
    const ctx2 = { ...ctx, valorMs: inicioSN - H };
    assert.equal(resolverHHMM("08:00", ctx2), inicioSN + 13 * H);
    assert.equal(cruzaMeiaNoite(ctx.minMs, ctx.maxMs), true);
    assert.equal(cruzaMeiaNoite(T0700, T0700 + 12 * H), false);
});

test("resolverHHMM: faixa > 24h — dois candidatos válidos, vence o mais próximo", () => {
    const ctx = { valorMs: T0700 + 20 * H, minMs: T0700 - 12 * H, maxMs: T0700 + 36 * H }; // valor 03:00 de amanhã
    // "04:00": hoje+1 (04:00 amanhã, a 1h) vs hoje (04:00 de hoje, a 23h) → amanhã
    assert.equal(resolverHHMM("04:00", ctx), T0700 + 21 * H);
});

test("rotuloDoDia e rotuloDelta", () => {
    assert.equal(rotuloDoDia(T0700, T0700 + 5 * H), "hoje");
    assert.equal(rotuloDoDia(T0700 - 8 * H, T0700), "ontem");
    assert.equal(rotuloDoDia(T0700 + 24 * H, T0700), "amanhã");
    assert.equal(rotuloDoDia(T0700 - 72 * H, T0700), "07/03");
    assert.equal(rotuloDelta(T0700 + 15 * M, T0700), "+15 min");
    assert.equal(rotuloDelta(T0700 - 5 * M, T0700), "−5 min");
    assert.equal(rotuloDelta(T0700, T0700), "");
});

test("presetsDoEditor: fim só com janela; tudo limitado à faixa", () => {
    const semFim = presetsDoEditor({ janelaInicioMs: T0700, janelaFimMs: null, minMs: T0700 + H, maxMs: T0700 + 10 * H, agoraMs: T0700 + 20 * H });
    assert.deepEqual(semFim.map((p) => p.chave), ["inicio", "agora"]);
    assert.equal(semFim[0].ms, T0700 + H); // início limitado ao min
    assert.equal(semFim[0].rotulo, "Início da janela (07:00)");
    assert.equal(semFim[1].ms, T0700 + 10 * H); // agora limitado ao max
    const comFim = presetsDoEditor({ janelaInicioMs: T0700, janelaFimMs: T0700 + 12 * H, minMs: T0700 - H, maxMs: T0700 + 14 * H, agoraMs: T0700 + 3 * H });
    assert.deepEqual(comFim.map((p) => p.chave), ["inicio", "fim", "agora"]);
    assert.equal(comFim[1].rotulo, "Fim da janela (19:00)");
});

function reg(partial: Partial<RegulationBoardRow> & Pick<RegulationBoardRow, "postId" | "postCode" | "status">): RegulationBoardRow {
    return {
        occupancyId: null,
        postLabel: partial.postCode,
        defaultRole: null,
        doctorId: null,
        doctorName: null,
        displayName: null,
        startedAt: null,
        boardStartedAt: null,
        scheduledEndAt: null,
        shiftLabel: null,
        roleLabel: null,
        ramalLabel: null,
        liveSource: "none",
        liveUpdatedAt: null,
        ...partial,
    };
}

function inter(partial: Partial<InterventionBoardRow> & Pick<InterventionBoardRow, "baseId" | "baseCode" | "status">): InterventionBoardRow {
    return {
        occupancyId: null,
        baseLabel: partial.baseCode,
        doctorId: null,
        doctorName: null,
        displayName: null,
        startedAt: null,
        boardStartedAt: null,
        scheduledEndAt: null,
        shiftLabel: null,
        roleLabel: null,
        liveSource: "none",
        liveUpdatedAt: null,
        ...partial,
    };
}

test("azulejosDoSnapshot: status, ocupante, eventual, origem e dupla", () => {
    const snapshot = {
        regulation: [
            reg({ postId: 1, postCode: "1362", status: "waiting" }),
            reg({ postId: 2, postCode: "1363", status: "active", doctorId: "d1", doctorName: "Ana Souza", displayName: "Ana", startedAt: "2026-03-10T10:05:00Z" }),
            reg({ postId: 3, postCode: "1364", status: "disabled", disabledReason: "manutenção" }),
            reg({ postId: 9, postCode: "4091", postLabel: "Eventual 4091", status: "active", onDemand: true, doctorId: "d2", doctorName: "Bruno Lima" }),
        ],
        intervention: [
            inter({ baseId: 10, baseCode: "CB02", baseLabel: "USA Centro", status: "active", doctorId: "d3", doctorName: "Carla Dias", companionOccupants: [{ occupancyId: "o2", doctorId: "d4", doctorName: "Davi Melo", displayName: null, startedAt: null, boardStartedAt: null }] }),
            inter({ baseId: 11, baseCode: "CB05", status: "waiting" }),
        ],
    };

    const semOrigem = azulejosDoSnapshot(snapshot);
    assert.deepEqual(
        semOrigem.map((a) => [a.domain, a.targetId, a.code, a.status, a.ocupante ?? null, a.onDemand ?? false]),
        [
            ["regulation", "1", "1362", "livre", null, false],
            ["regulation", "2", "1363", "ocupado", "Ana", false],
            ["regulation", "3", "1364", "desativado", null, false],
            ["regulation", "9", "4091", "ocupado", "Bruno Lima", true],
            ["intervention", "10", "CB02", "ocupado", "Carla Dias + Davi Melo", false],
            ["intervention", "11", "CB05", "livre", null, false],
        ],
    );
    assert.equal(semOrigem[1].ocupanteDesde, "2026-03-10T10:05:00Z");
    assert.equal(semOrigem[0].ocupanteDesde, null);
    assert.equal(semOrigem[3].nome, "Eventual 4091");
    assert.equal(semOrigem[4].nome, "USA Centro");
    assert.equal(semOrigem[5].nome, null);

    const comOrigem = azulejosDoSnapshot(snapshot, { origem: { domain: "regulation", targetId: "2" } });
    assert.equal(comOrigem[1].status, "origem");
    assert.equal(comOrigem[1].ocupante, "Ana");
    // Origem com id numérico também casa
    const origemNumerica = azulejosDoSnapshot(snapshot, { origem: { domain: "intervention", targetId: 10 as unknown as string } });
    assert.equal(origemNumerica[4].status, "origem");
});

test("azulejosDoSnapshot: cobertura de madrugada expõe os ocultos e não duplica posto", () => {
    const oculto = reg({ postId: 5, postCode: "1367", status: "active", doctorId: "d5", doctorName: "Eva Reis" });
    const cobertura = reg({ postId: 7, postCode: "2266", status: "active", onDemand: true, doctorId: "d6", doctorName: "Fábio Luz", madrugadaCobertura: true, madrugadaOcultos: [oculto] });
    const repetido = reg({ postId: 5, postCode: "1367", status: "waiting" });
    const lista = azulejosDoSnapshot({ regulation: [cobertura, repetido], intervention: [] });
    assert.deepEqual(lista.map((a) => [a.code, a.status]), [["2266", "ocupado"], ["1367", "ocupado"]]);
});
