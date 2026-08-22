import assert from "node:assert/strict";
import test from "node:test";

import {
    buildBankHoursStory,
    extractArrivalPhrase,
    extractDeparturePhrase,
    renderBankHoursStoryText,
} from "@/modules/reporting/bank-hours-story";

test("extrai a fala da chegada e ignora marcação do sistema", () => {
    const notes = "Murilo Damasceno na PR03 p\n[NÃO SAIU] chefia contestou a saída registrada às 07:01.";
    assert.equal(extractArrivalPhrase(notes), "Murilo Damasceno na PR03 p");
    assert.equal(extractDeparturePhrase(notes), null);
});

test("extrai a fala da saída ajustada pelo bot", () => {
    const notes = "Décia sd CZ50\n[telegram saida ajustada] Decia saindo apos oc 0969\n[botão] estava em ocorrência";
    assert.equal(extractDeparturePhrase(notes), "Decia saindo apos oc 0969");
});

test("plantão com crédito em dobro vira história legível", () => {
    const story = buildBankHoursStory({
        doctorName: "Murilo Candido do Monte Damasceno",
        targetCode: "PR03",
        shiftLabel: "P",
        notes: "Murilo Damasceno na PR03 p\n[telegram saida ajustada] Murilo saindo da PR03, em ocorrência 0594",
        scheduledStartAt: "2026-05-10T10:00:00.000Z",
        scheduledEndAt: "2026-05-11T10:00:00.000Z",
        startedAt: "2026-05-10T10:03:12.000Z",
        actualEndedAt: "2026-05-11T10:26:05.000Z",
        handoffEndedAt: null,
        countedEndAt: "2026-05-11T10:26:05.000Z",
        arrivalDelayMinutes: 0,
        overtimeMinutes: 26,
        creditedOvertimeMinutes: 52,
        balanceMinutes: 52,
        lateDeparture: null,
    });

    const texto = renderBankHoursStoryText(story);
    assert.match(texto, /Murilo · PR03 · plantão de 24h \(P\) · 10\/05 · \+52 min/);
    assert.match(texto, /avisou chegada às 07:03 de 10\/05/);
    assert.match(texto, /"Murilo Damasceno na PR03 p"/);
    assert.match(texto, /Saiu às 07:26 de 11\/05, 26 min além das 07:00 e disse que estava na ocorrência 0594/);
    assert.match(texto, /conta em dobro: \+52 min/);
    // Nada de jargão de tela nem inglês.
    assert.doesNotMatch(texto, /janela|considerad|overtime|handoff/i);
});

test("chegada atrasada explica a conta sem regra técnica", () => {
    const story = buildBankHoursStory({
        doctorName: "Ana Paula Souza",
        targetCode: "PM40",
        shiftLabel: "P",
        notes: "Ana Paula PM40 P",
        scheduledStartAt: "2026-06-19T10:00:00.000Z",
        scheduledEndAt: "2026-06-19T21:00:00.000Z",
        startedAt: "2026-06-19T10:24:47.000Z",
        actualEndedAt: "2026-06-19T21:50:19.000Z",
        handoffEndedAt: null,
        countedEndAt: "2026-06-19T21:50:19.000Z",
        arrivalDelayMinutes: 24,
        overtimeMinutes: 50,
        creditedOvertimeMinutes: 50,
        balanceMinutes: 26,
    });

    const texto = renderBankHoursStoryText(story);
    assert.match(texto, /24 min depois das 07:00/);
    assert.match(texto, /excedente conta simples: \+50 min, menos 24 min do atraso — fica \+26 min/);
});

test("rendição atrasada aparece com nome de quem assumiu", () => {
    const story = buildBankHoursStory({
        doctorName: "Samara Alves",
        targetCode: "CC70",
        shiftLabel: "P",
        notes: "Samara CC70 P",
        scheduledStartAt: "2026-04-04T10:00:00.000Z",
        scheduledEndAt: "2026-04-05T10:00:00.000Z",
        startedAt: "2026-04-04T10:00:00.000Z",
        actualEndedAt: "2026-04-05T11:50:00.000Z",
        handoffEndedAt: "2026-04-05T09:54:35.000Z",
        countedEndAt: "2026-04-05T09:54:35.000Z",
        arrivalDelayMinutes: 0,
        overtimeMinutes: 0,
        creditedOvertimeMinutes: 0,
        balanceMinutes: 0,
        successorDoctorName: "João Pedro Miguez",
        successorTookOverAt: "2026-04-05T09:54:35.000Z",
    });

    assert.match(renderBankHoursStoryText(story), /Quem rendeu foi João, às 06:54 — o cálculo parou na rendição/);
});

test("plantão aberto diz que ninguém registrou saída", () => {
    const story = buildBankHoursStory({
        doctorName: "Murilo Damasceno",
        targetCode: "PR03",
        shiftLabel: "SD",
        notes: "Murilo Damasceno na PR03 p",
        scheduledStartAt: "2026-08-21T10:00:00.000Z",
        scheduledEndAt: "2026-08-21T22:00:00.000Z",
        startedAt: "2026-08-21T09:59:36.000Z",
        actualEndedAt: null,
        handoffEndedAt: null,
        countedEndAt: null,
        arrivalDelayMinutes: 0,
        overtimeMinutes: 0,
        creditedOvertimeMinutes: 0,
        balanceMinutes: 0,
    });

    assert.match(renderBankHoursStoryText(story), /O plantão está aberto — ninguém registrou a saída até agora/);
});
