import assert from "node:assert/strict";
import test from "node:test";
import {
    resolveUndeclaredContinuationScheduledEndAt,
    UNDECLARED_CONTINUATION_OVERTIME_MINUTES,
} from "@/modules/operational/rules";

/**
 * Continuação NÃO DECLARADA — o caso Felipe Carneiro.
 *
 * Quem sai 10h ou mais depois do fim previsto, sem ninguém ter assumido a
 * posição, emendou o turno seguinte. Isso não é uma pergunta para o chefe nem
 * uma confirmação de rótulo para o médico: é a conta que o sistema faz sozinho.
 * O chefe só confirma o horário de saída.
 *
 * Sem esta régua, a permanência virava excedente — e o plantão emendado sumia
 * da folha ao mesmo tempo em que aparecia como crédito gigante no banco.
 */

function at(value: string) {
    return new Date(value);
}

const SD_END = at("2026-08-03T19:15:00-03:00");

test("o limite é 10h — o mesmo que assina plantão INTEIRO na régua da sobra", () => {
    assert.equal(UNDECLARED_CONTINUATION_OVERTIME_MINUTES, 600);
});

test("saída 12h depois do fim vira janela do turno seguinte (Carneiro)", () => {
    const end = resolveUndeclaredContinuationScheduledEndAt({
        domain: "REGULATION",
        scheduledEndAt: SD_END,
        departureAt: at("2026-08-04T07:00:00-03:00"),
    });
    assert.ok(end, "esperava janela estendida");
    // SD terminava 19:15 de 03/08; a continuação cobre o SN até 07:15 de 04/08.
    assert.equal(end!.toISOString(), at("2026-08-04T07:15:00-03:00").toISOString());
});

test("saída 9h59 depois ainda não é continuação — fica na régua da sobra", () => {
    const end = resolveUndeclaredContinuationScheduledEndAt({
        domain: "REGULATION",
        scheduledEndAt: SD_END,
        departureAt: new Date(SD_END.getTime() + ((9 * 60 + 59) * 60000)),
    });
    assert.equal(end, null);
});

test("exatamente 10h já é continuação", () => {
    const end = resolveUndeclaredContinuationScheduledEndAt({
        domain: "REGULATION",
        scheduledEndAt: SD_END,
        departureAt: new Date(SD_END.getTime() + (10 * 60 * 60000)),
    });
    assert.ok(end, "10h cravadas devem estender a janela");
});

test("saída dentro da janela não estende nada", () => {
    const end = resolveUndeclaredContinuationScheduledEndAt({
        domain: "REGULATION",
        scheduledEndAt: SD_END,
        departureAt: at("2026-08-03T18:00:00-03:00"),
    });
    assert.equal(end, null);
});

test("dois turnos emendados estendem dois blocos, não um", () => {
    // Entrou no SD de 03/08, saiu no fim do SD de 04/08: 24h de sobra.
    const end = resolveUndeclaredContinuationScheduledEndAt({
        domain: "REGULATION",
        scheduledEndAt: SD_END,
        departureAt: at("2026-08-04T19:10:00-03:00"),
    });
    assert.ok(end, "esperava janela estendida");
    assert.equal(end!.toISOString(), at("2026-08-04T19:15:00-03:00").toISOString());
});

test("intervenção usa a própria fronteira de janela", () => {
    const end = resolveUndeclaredContinuationScheduledEndAt({
        domain: "INTERVENTION",
        scheduledEndAt: at("2026-08-03T19:00:00-03:00"),
        departureAt: at("2026-08-04T07:00:00-03:00"),
    });
    assert.ok(end, "esperava janela estendida");
    assert.equal(end!.getTime() > at("2026-08-03T19:00:00-03:00").getTime(), true);
});

test("a janela estendida cobre a saída — a sobra deixa de ser excedente", () => {
    // É o efeito que importa: depois de estender, o médico não fica mais com
    // 12h de "excedente" contra a janela; ele fica dentro dela.
    const departureAt = at("2026-08-04T07:00:00-03:00");
    const end = resolveUndeclaredContinuationScheduledEndAt({
        domain: "REGULATION",
        scheduledEndAt: SD_END,
        departureAt,
    });
    assert.ok(end);
    const sobraMinutes = Math.trunc((departureAt.getTime() - end!.getTime()) / 60000);
    assert.equal(sobraMinutes <= 0, true, `sobra residual de ${sobraMinutes}min`);
});
