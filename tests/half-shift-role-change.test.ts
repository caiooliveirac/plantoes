/**
 * Troca de função meio plantão <-> plantão inteiro (jul/2026).
 *
 * Incidente: Vanessa Brito chegou 10:38 num SD. O bot interpretou como MEIO
 * PLANTAO (a janela de reconhecimento começava 10:30) e gravou a janela agendada
 * 11:30–17:00. A chefia trocou a função pra COI no quadro — mas a janela ficou
 * na de meia jornada, então o banco de horas continuou medindo atraso a partir
 * das 11:30 (ou seja: chegada adiantada, saldo zero) em vez do SD inteiro.
 *
 * Regra atual: a função manda na JANELA.
 *   - sai de MEIO_PLANTAO  -> janela do turno inteiro (SD 07:00–19:15) e o
 *     atraso vira o débito cheio a partir das 07:00;
 *   - entra em MEIO_PLANTAO -> janela canônica 11:30–17:00;
 *   - continua meio plantão -> a janela de meia jornada NÃO é reescrita por uma
 *     correção de horário.
 * O pagamento acompanha sozinho: a unidade (0,5 vs 1) vem do role_label.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { resolveCorrectedScheduledWindow } from "@/modules/operational/corrections";
import { inferRegulationCoverageWindow } from "@/modules/operational/rules";
import { resolveBankHoursScheduledWindow } from "@/modules/bank-hours/window";
import { calculateBankHours, applyAnomalyGuard } from "@/modules/bank-hours/calculator";
import { HALF_SHIFT_ROLE_LABEL, isHalfShiftScheduledWindow, resolvePaymentUnitFromRole } from "@/modules/operational/half-shift";
import { OPERATIONAL_ROLE_REMOVED_SENTINEL } from "@/modules/operational/roles";

const iso = (value: string) => new Date(value);
const at = (hhmm: string) => iso(`2026-07-30T${hhmm}:00-03:00`);

// Chegada real da Vanessa: 10:38, ramal comum de regulação, turno SD.
const ARRIVAL_AT = at("10:38");
const POST_CODE = "2153";

function regulationWindow(params: {
    existingRoleLabel: string | null;
    nextRoleLabel: string | null;
    roleLabelProvided?: boolean;
    temporalFieldsChanged?: boolean;
    existingWindow?: { scheduledStartAt: Date | null; scheduledEndAt: Date | null };
}) {
    return resolveCorrectedScheduledWindow({
        existingRoleLabel: params.existingRoleLabel,
        nextRoleLabel: params.nextRoleLabel,
        roleLabelProvided: params.roleLabelProvided ?? true,
        temporalFieldsChanged: params.temporalFieldsChanged ?? false,
        windowReferenceAt: ARRIVAL_AT,
        existingWindow: params.existingWindow ?? {
            // Janela que o bot gravou ao supor meia jornada.
            scheduledStartAt: at("11:30"),
            scheduledEndAt: at("17:00"),
        },
        inferFullShiftWindow: () => inferRegulationCoverageWindow({
            startedAt: ARRIVAL_AT,
            shiftLabel: "SD",
            postCode: POST_CODE,
            explicitScheduledStartAt: null,
            explicitScheduledEndAt: null,
        }),
    });
}

test("meio plantao -> COI: janela volta a ser o SD inteiro (07:00–19:15)", () => {
    const window = regulationWindow({
        existingRoleLabel: HALF_SHIFT_ROLE_LABEL,
        nextRoleLabel: "COI",
    });

    assert.equal(window.scheduledStartAt?.toISOString(), at("07:00").toISOString());
    assert.equal(window.scheduledEndAt?.toISOString(), at("19:15").toISOString());
});

test("meio plantao -> COI: chegada 10:38 passa a debitar o atraso cheio", () => {
    const corrected = regulationWindow({
        existingRoleLabel: HALF_SHIFT_ROLE_LABEL,
        nextRoleLabel: "COI",
    });

    // O banco normaliza o fim 19:15 do quadro para 19:00 (tolerância de saída).
    const bankWindow = resolveBankHoursScheduledWindow({
        domain: "regulation",
        startedAt: ARRIVAL_AT,
        shiftLabel: "SD",
        scheduledStartAt: corrected.scheduledStartAt,
        scheduledEndAt: corrected.scheduledEndAt,
        postCode: POST_CODE,
    });
    assert.equal(bankWindow.scheduledStartAt?.toISOString(), at("07:00").toISOString());
    assert.equal(bankWindow.scheduledEndAt?.toISOString(), at("19:00").toISOString());

    const result = calculateBankHours({
        scheduledStartAt: bankWindow.scheduledStartAt as Date,
        scheduledEndAt: bankWindow.scheduledEndAt as Date,
        actualStartAt: ARRIVAL_AT,
        actualEndAt: at("19:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 218, "07:00 -> 10:38 = 3h38");
    assert.equal(result.balanceMinutes, -218);
    assert.equal(result.ruleCode, "LATE_NO_OVERTIME");
    // 3h38 é um atraso crível: não pode ser zerado pelo guard de anomalia (>6h).
    assert.deepEqual(applyAnomalyGuard(result), result);
});

test("meio plantao antes da troca: o mesmo plantao não gerava débito nenhum", () => {
    const result = calculateBankHours({
        scheduledStartAt: at("11:30"),
        scheduledEndAt: at("17:00"),
        actualStartAt: ARRIVAL_AT,
        actualEndAt: at("17:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0, "10:38 é 'antes' das 11:30 na janela de meia jornada");
    assert.equal(result.balanceMinutes, 0);
});

test("remover a função de um meio plantao também devolve a janela inteira", () => {
    const window = regulationWindow({
        existingRoleLabel: HALF_SHIFT_ROLE_LABEL,
        nextRoleLabel: OPERATIONAL_ROLE_REMOVED_SENTINEL,
    });

    assert.equal(window.scheduledStartAt?.toISOString(), at("07:00").toISOString());
    assert.equal(window.scheduledEndAt?.toISOString(), at("19:15").toISOString());
});

test("COI -> meio plantao: janela vira a canônica 11:30–17:00", () => {
    const window = regulationWindow({
        existingRoleLabel: "COI",
        nextRoleLabel: HALF_SHIFT_ROLE_LABEL,
        existingWindow: { scheduledStartAt: at("07:00"), scheduledEndAt: at("19:15") },
    });

    assert.equal(window.scheduledStartAt?.toISOString(), at("11:30").toISOString());
    assert.equal(window.scheduledEndAt?.toISOString(), at("17:00").toISOString());
});

test("corrigir o horário de quem CONTINUA meio plantao não reescreve a janela de meia jornada", () => {
    const window = regulationWindow({
        existingRoleLabel: HALF_SHIFT_ROLE_LABEL,
        nextRoleLabel: HALF_SHIFT_ROLE_LABEL,
        roleLabelProvided: false,
        temporalFieldsChanged: true,
    });

    assert.equal(window.scheduledStartAt?.toISOString(), at("11:30").toISOString());
    assert.equal(window.scheduledEndAt?.toISOString(), at("17:00").toISOString());
});

test("troca de função que não cruza a fronteira preserva a janela existente", () => {
    const existingWindow = { scheduledStartAt: at("07:00"), scheduledEndAt: at("19:15") };
    const window = regulationWindow({
        existingRoleLabel: "COI",
        nextRoleLabel: "MRV",
        existingWindow,
    });

    assert.equal(window.scheduledStartAt?.toISOString(), existingWindow.scheduledStartAt.toISOString());
    assert.equal(window.scheduledEndAt?.toISOString(), existingWindow.scheduledEndAt.toISOString());
});

// --- Auto-cura do passivo -------------------------------------------------
// As ocupações que já sofreram a troca de função ANTES do fix ficaram com a
// função inteira sobre a janela de meia jornada. Trocar a função de novo não
// cruza fronteira nenhuma (COI -> COI), então sem a auto-cura a janela errada
// sobreviveria para sempre. Casos reais: Vanessa Brito 30/07 e Ana Luiza 06/07.

test("auto-cura: função inteira sobre janela de meia jornada é refeita mesmo sem cruzar fronteira", () => {
    const window = regulationWindow({
        existingRoleLabel: "COI",
        nextRoleLabel: "COI",
        roleLabelProvided: true,
        temporalFieldsChanged: false,
        // Estado exato da Vanessa em produção: role COI, janela 11:30–17:00.
        existingWindow: { scheduledStartAt: at("11:30"), scheduledEndAt: at("17:00") },
    });

    assert.equal(window.scheduledStartAt?.toISOString(), at("07:00").toISOString());
    assert.equal(window.scheduledEndAt?.toISOString(), at("19:15").toISOString());
});

test("auto-cura: vale também quando nem a função foi enviada na correção", () => {
    const window = regulationWindow({
        existingRoleLabel: "MRV",
        nextRoleLabel: "MRV",
        roleLabelProvided: false,
        temporalFieldsChanged: false,
        existingWindow: { scheduledStartAt: at("11:30"), scheduledEndAt: at("17:00") },
    });

    assert.equal(window.scheduledStartAt?.toISOString(), at("07:00").toISOString());
});

test("auto-cura NÃO reescreve quem é meio plantão de verdade", () => {
    const window = regulationWindow({
        existingRoleLabel: HALF_SHIFT_ROLE_LABEL,
        nextRoleLabel: HALF_SHIFT_ROLE_LABEL,
        roleLabelProvided: true,
        temporalFieldsChanged: false,
        existingWindow: { scheduledStartAt: at("11:30"), scheduledEndAt: at("17:00") },
    });

    assert.equal(window.scheduledStartAt?.toISOString(), at("11:30").toISOString());
    assert.equal(window.scheduledEndAt?.toISOString(), at("17:00").toISOString());
});

test("auto-cura não confunde janela custom com janela de meia jornada", () => {
    const existingWindow = { scheduledStartAt: at("11:30"), scheduledEndAt: at("19:00") };
    const window = regulationWindow({
        existingRoleLabel: "COI",
        nextRoleLabel: "COI",
        roleLabelProvided: true,
        temporalFieldsChanged: false,
        existingWindow,
    });

    assert.equal(window.scheduledEndAt?.toISOString(), existingWindow.scheduledEndAt.toISOString());
});

test("isHalfShiftScheduledWindow reconhece a janela pelo relógio local, em qualquer dia", () => {
    assert.equal(isHalfShiftScheduledWindow({
        scheduledStartAt: new Date("2026-02-14T11:30:00-03:00"),
        scheduledEndAt: new Date("2026-02-14T17:00:00-03:00"),
    }), true);
    assert.equal(isHalfShiftScheduledWindow({
        scheduledStartAt: at("07:00"),
        scheduledEndAt: at("19:15"),
    }), false);
    assert.equal(isHalfShiftScheduledWindow({ scheduledStartAt: null, scheduledEndAt: null }), false);
});

test("pagamento acompanha a troca: 0,5 como meio plantao, 1 como qualquer outra função", () => {
    assert.equal(resolvePaymentUnitFromRole(HALF_SHIFT_ROLE_LABEL), 0.5);
    assert.equal(resolvePaymentUnitFromRole("COI"), 1);
    assert.equal(resolvePaymentUnitFromRole(OPERATIONAL_ROLE_REMOVED_SENTINEL), 1);
});
