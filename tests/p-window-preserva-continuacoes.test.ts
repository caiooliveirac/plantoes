import assert from "node:assert/strict";
import test from "node:test";
import { resolveCorrectedHalfShiftState } from "@/modules/operational/corrections";
import { inferRegulationCoverageWindow } from "@/modules/operational/rules";

/**
 * Corrigir a chegada de um P não pode apagar as continuações.
 *
 * A inferência (inferRegulationCoverageWindow) só sabe estender UM bloco além do
 * turno-base. Uma cadeia construída por avisos sucessivos de "continua" tem fim
 * muito além disso. Enquanto a correção devolvia a janela inferida inteira, um
 * /corrigir de horário encolhia a cobertura em 12h ou mais — o médico passava a
 * "ficar 12h além da janela", a folha perdia o plantão emendado e a fila do
 * chefe propunha um plantão que não existe.
 */

const iso = (v: string) => new Date(v);

// P que entrou no SD de 03/08 07:00. A janela-base da inferência termina
// 04/08 07:15; os avisos de "continua" empurraram o gravado para 04/08 19:15.
const CHEGADA = iso("2026-08-03T07:00:00-03:00");
const FIM_INFERIDO = iso("2026-08-04T07:15:00-03:00");
const FIM_GRAVADO = iso("2026-08-04T19:15:00-03:00");

function corrigir(overrides: Partial<Parameters<typeof resolveCorrectedHalfShiftState>[0]> = {}) {
    return resolveCorrectedHalfShiftState({
        existingRoleLabel: null,
        nextRoleLabel: null,
        roleLabelProvided: false,
        shiftLabelProvided: false,
        temporalFieldsChanged: true,
        windowReferenceAt: CHEGADA,
        existingWindow: { scheduledStartAt: CHEGADA, scheduledEndAt: FIM_GRAVADO },
        inferFullShiftWindow: () => inferRegulationCoverageWindow({
            startedAt: CHEGADA,
            shiftLabel: "P",
            postCode: "2262",
            explicitScheduledStartAt: null,
            explicitScheduledEndAt: null,
        }),
        ...overrides,
    });
}

test("a inferência realmente só estende um bloco — é a origem do defeito", () => {
    const inferida = inferRegulationCoverageWindow({
        startedAt: CHEGADA, shiftLabel: "P", postCode: "2262",
        explicitScheduledStartAt: null, explicitScheduledEndAt: null,
    });
    assert.equal(inferida.scheduledEndAt?.toISOString(), FIM_INFERIDO.toISOString());
    assert.equal(inferida.scheduledEndAt!.getTime() < FIM_GRAVADO.getTime(), true);
});

test("correção só de horário PRESERVA o fim acumulado pelas continuações", () => {
    const janela = corrigir();
    assert.equal(janela.scheduledEndAt?.toISOString(), FIM_GRAVADO.toISOString());
});

test("o início ainda segue a chegada corrigida", () => {
    const janela = corrigir();
    assert.equal(janela.scheduledStartAt?.toISOString(), CHEGADA.toISOString());
});

test("redefinir o turno continua podendo ENCOLHER a janela", () => {
    // Alguém dizendo "isto é SD, não P" é uma afirmação sobre a cobertura —
    // diferente de consertar um horário.
    const janela = corrigir({ shiftLabelProvided: true });
    assert.equal(janela.scheduledEndAt?.toISOString(), FIM_INFERIDO.toISOString());
});

test("mudar a função também refaz a janela", () => {
    const janela = corrigir({ roleLabelProvided: true });
    assert.equal(janela.scheduledEndAt?.toISOString(), FIM_INFERIDO.toISOString());
});

test("fim gravado MAIS CURTO que o inferido cede para a inferência", () => {
    // Preservar aqui congelaria uma janela curta errada para sempre.
    const curto = iso("2026-08-03T12:00:00-03:00");
    const janela = corrigir({ existingWindow: { scheduledStartAt: CHEGADA, scheduledEndAt: curto } });
    assert.equal(janela.scheduledEndAt?.toISOString(), FIM_INFERIDO.toISOString());
});

test("sem fim gravado, a inferência manda", () => {
    const janela = corrigir({ existingWindow: { scheduledStartAt: CHEGADA, scheduledEndAt: null } });
    assert.equal(janela.scheduledEndAt?.toISOString(), FIM_INFERIDO.toISOString());
});
