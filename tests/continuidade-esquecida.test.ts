import assert from "node:assert/strict";
import test from "node:test";
import {
    shouldInferCrossShiftContinuation,
    shouldLinkExplicitContinuationClosedSource,
    shouldLinkRecentClosedTelegramContinuity,
} from "@/modules/telegram/service";

/**
 * Continuidade ESQUECIDA — casos João Victor Perrone e Thainara.
 *
 * A regra combinada, decidida pela coordenação: supõe-se que o médico FICOU
 * quando ele usa "continua" OU quando chegou num plantão e seguiu no outro.
 * Esquecer a palavra é a coisa mais comum do mundo às 7h da manhã, e a palavra
 * não pode comprar uma régua melhor que a realidade.
 *
 * Antes, o vínculo sem o verbo valia só por 2h desde o fechamento. Quem avisava
 * tarde nascia órfão: perdia a âncora de chegada, ganhava atraso fantasma no
 * banco de horas, caía na fila de prioridade de refeição como recém-chegado e
 * jantava 30min em vez de 1h.
 *
 * Duas condições se protegem: a travessia de virada diz que é continuação, e a
 * regra da fronteira diz que ele estava lá na virada. Quem foi para casa no meio
 * do plantão não passa nem por uma nem por outra.
 */

function at(value: string) {
    return new Date(value);
}

// ── a fonte ficou até a virada? (adjacência temporal) ──────────────────────

test("SD que expirou 19:15 e avisou 22:00 linka — sem precisar do verbo", () => {
    assert.equal(
        shouldLinkExplicitContinuationClosedSource({
            eventAt: at("2026-08-03T22:00:00-03:00"),
            sourceStartedAt: at("2026-08-03T07:00:00-03:00"),
            sourceEndedAt: at("2026-08-03T19:15:00-03:00"),
        }),
        true,
    );
});

test("SN que expirou 07:15 e avisou 10:00 linka (forma do caso Thainara)", () => {
    assert.equal(
        shouldLinkExplicitContinuationClosedSource({
            eventAt: at("2026-08-04T10:00:00-03:00"),
            sourceStartedAt: at("2026-08-03T19:00:00-03:00"),
            sourceEndedAt: at("2026-08-04T07:15:00-03:00"),
        }),
        true,
    );
});

test("quem foi embora no meio do plantão NÃO linka", () => {
    // Saiu 12:00, volta 20:00: não estava lá na virada das 19:00.
    assert.equal(
        shouldLinkExplicitContinuationClosedSource({
            eventAt: at("2026-08-03T20:00:00-03:00"),
            sourceStartedAt: at("2026-08-03T07:00:00-03:00"),
            sourceEndedAt: at("2026-08-03T12:00:00-03:00"),
        }),
        false,
    );
});

test("plantão de ONTEM não linka com a chegada de hoje", () => {
    // SD de 03/08 encerrado 19:15; chegada às 08:00 de 04/08 é plantão novo.
    assert.equal(
        shouldLinkExplicitContinuationClosedSource({
            eventAt: at("2026-08-04T08:00:00-03:00"),
            sourceStartedAt: at("2026-08-03T07:00:00-03:00"),
            sourceEndedAt: at("2026-08-03T19:15:00-03:00"),
        }),
        false,
    );
});

test("a régua antiga (2h, mesmo turno) sozinha perdia o aviso das 22:00", () => {
    // É a razão de o vínculo implícito ter de passar pela regra da fronteira:
    // fechou 19:15, avisou 22:00 — quase 3h depois.
    assert.equal(
        shouldLinkRecentClosedTelegramContinuity(
            at("2026-08-03T22:00:00-03:00"),
            at("2026-08-03T19:15:00-03:00"),
        ),
        false,
    );
});

test("saída-e-volta-rápida no mesmo turno continua valendo em paralelo", () => {
    // Fechamento acidental às 09:00, reenvio às 09:30, ambos dentro do SD.
    assert.equal(
        shouldLinkRecentClosedTelegramContinuity(
            at("2026-08-03T09:30:00-03:00"),
            at("2026-08-03T09:00:00-03:00"),
        ),
        true,
    );
});

// ── é travessia de virada? (natureza do vínculo) ───────────────────────────

test("fonte do SD com mensagem caindo no SN é continuação", () => {
    assert.equal(
        shouldInferCrossShiftContinuation({
            sourceShiftLabel: "SD",
            eventAt: at("2026-08-03T22:00:00-03:00"),
            isExplicitContinuation: false,
        }),
        true,
    );
});

test("escrever o rótulo do turno não custa mais a âncora", () => {
    // O médico que digita "SN" ao voltar de um SD saía PIOR do que quem não
    // dizia nada: a inferência exigia ausência de rótulo.
    assert.equal(
        shouldInferCrossShiftContinuation({
            sourceShiftLabel: "SN",
            eventAt: at("2026-08-04T07:40:00-03:00"),
            isExplicitContinuation: false,
        }),
        true,
    );
});

test("mesma faixa de turno não é travessia — é plantão novo", () => {
    assert.equal(
        shouldInferCrossShiftContinuation({
            sourceShiftLabel: "SN",
            eventAt: at("2026-08-03T20:00:00-03:00"),
            isExplicitContinuation: false,
        }),
        false,
    );
});

test("continuidade explícita não passa por aqui — tem caminho próprio", () => {
    assert.equal(
        shouldInferCrossShiftContinuation({
            sourceShiftLabel: "SD",
            eventAt: at("2026-08-03T22:00:00-03:00"),
            isExplicitContinuation: true,
        }),
        false,
    );
});

test("sem rótulo na fonte não há travessia a afirmar", () => {
    assert.equal(
        shouldInferCrossShiftContinuation({
            sourceShiftLabel: null,
            eventAt: at("2026-08-03T22:00:00-03:00"),
            isExplicitContinuation: false,
        }),
        false,
    );
});
