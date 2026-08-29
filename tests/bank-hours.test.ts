import assert from "node:assert/strict";
import test from "node:test";
import { applyAnomalyGuard, calculateBankHours, calculateGuardedBankHours } from "@/modules/bank-hours/calculator";
import { resolveBankHoursScheduledWindow } from "@/modules/bank-hours/window";

function iso(value: string) {
    return new Date(value).toISOString();
}

test("gives double overtime when arrival is on time", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T07:12:00-03:00"),
        actualEndAt: iso("2026-03-25T19:30:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 30);
    assert.equal(result.creditedOvertimeMinutes, 60);
    assert.equal(result.balanceMinutes, 60);
});

test("uses full arrival delay once tolerance is broken", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T07:18:00-03:00"),
        actualEndAt: iso("2026-03-25T19:45:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 18);
    assert.equal(result.overtimeMultiplier, 1);
    assert.equal(result.creditedOvertimeMinutes, 45);
    assert.equal(result.balanceMinutes, 27);
});

test("does not create extra debit for leaving early", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T06:55:00-03:00"),
        actualEndAt: iso("2026-03-25T18:40:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
});

test("ignores arrival and late exit below 15 minutes", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T07:14:00-03:00"),
        actualEndAt: iso("2026-03-25T19:14:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.overtimeMultiplier, 2);
    assert.equal(result.creditedOvertimeMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
});

test("keeps late departure neutral at exactly 15 minutes", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T07:00:00-03:00"),
        actualEndAt: iso("2026-03-25T19:15:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.overtimeMultiplier, 2);
    assert.equal(result.creditedOvertimeMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
});

test("keeps arrival delay neutral at exactly 15 minutes", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T07:15:00-03:00"),
        actualEndAt: iso("2026-03-25T19:15:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.overtimeMultiplier, 2);
    assert.equal(result.creditedOvertimeMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
});

test("breaks forgiveness after 15 minutes and removes doubled overtime", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T07:16:00-03:00"),
        actualEndAt: iso("2026-03-25T19:16:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 16);
    assert.equal(result.overtimeMinutes, 16);
    assert.equal(result.overtimeMultiplier, 1);
    assert.equal(result.creditedOvertimeMinutes, 16);
    assert.equal(result.balanceMinutes, 0);
});

test("does not reward early arrival by itself", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T06:42:00-03:00"),
        actualEndAt: iso("2026-03-25T19:00:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.creditedOvertimeMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
});

test("continued shift ignores arrival and late exit below 15 minutes", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T19:00:00-03:00"),
        scheduledEndAt: iso("2026-03-26T07:00:00-03:00"),
        actualStartAt: iso("2026-03-25T19:14:00-03:00"),
        actualEndAt: iso("2026-03-26T07:14:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.overtimeMultiplier, 2);
    assert.equal(result.creditedOvertimeMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
});

test("continued shift keeps exactly 15 minutes neutral", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T19:00:00-03:00"),
        scheduledEndAt: iso("2026-03-26T07:00:00-03:00"),
        actualStartAt: iso("2026-03-25T19:15:00-03:00"),
        actualEndAt: iso("2026-03-26T07:15:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.overtimeMultiplier, 2);
    assert.equal(result.creditedOvertimeMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
});

test("continued shift loses the doubled bonus when arrival exceeds tolerance", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T19:00:00-03:00"),
        scheduledEndAt: iso("2026-03-26T07:00:00-03:00"),
        actualStartAt: iso("2026-03-25T19:16:00-03:00"),
        actualEndAt: iso("2026-03-26T07:16:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 16);
    assert.equal(result.overtimeMinutes, 16);
    assert.equal(result.overtimeMultiplier, 1);
    assert.equal(result.creditedOvertimeMinutes, 16);
    assert.equal(result.balanceMinutes, 0);
});

test("continued shift leaving early does not create benefit", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T19:00:00-03:00"),
        scheduledEndAt: iso("2026-03-26T07:00:00-03:00"),
        actualStartAt: iso("2026-03-25T19:12:00-03:00"),
        actualEndAt: iso("2026-03-26T06:40:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.creditedOvertimeMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
});

test("regulation bank-hours window removes the duplicated 15-minute grace on exit", () => {
    const window = resolveBankHoursScheduledWindow({
        domain: "regulation",
        startedAt: iso("2026-04-09T19:02:20-03:00"),
        shiftLabel: "SN",
        scheduledStartAt: iso("2026-04-09T19:00:00-03:00"),
        scheduledEndAt: iso("2026-04-10T07:15:00-03:00"),
        postCode: "2031",
    });

    assert.equal(window.scheduledStartAt?.toISOString(), iso("2026-04-09T19:00:00-03:00"));
    assert.equal(window.scheduledEndAt?.toISOString(), iso("2026-04-10T07:00:00-03:00"));

    const result = calculateBankHours({
        scheduledStartAt: window.scheduledStartAt!,
        scheduledEndAt: window.scheduledEndAt!,
        actualStartAt: iso("2026-04-09T19:02:20-03:00"),
        actualEndAt: iso("2026-04-10T07:20:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 20);
    assert.equal(result.creditedOvertimeMinutes, 40);
    assert.equal(result.balanceMinutes, 40);
});

test("regulation bank-hours window preserves explicit custom end times", () => {
    const window = resolveBankHoursScheduledWindow({
        domain: "regulation",
        startedAt: iso("2026-04-09T10:30:00-03:00"),
        shiftLabel: "SD",
        scheduledStartAt: iso("2026-04-09T10:30:00-03:00"),
        scheduledEndAt: iso("2026-04-09T17:00:00-03:00"),
        postCode: "2031",
    });

    assert.equal(window.scheduledEndAt?.toISOString(), iso("2026-04-09T17:00:00-03:00"));
});

test("regulation bank-hours window also normalizes explicit P ends at 07:15 or 19:15", () => {
    const window = resolveBankHoursScheduledWindow({
        domain: "regulation",
        startedAt: iso("2026-04-07T07:00:00-03:00"),
        shiftLabel: "P",
        scheduledStartAt: iso("2026-04-07T07:00:00-03:00"),
        scheduledEndAt: iso("2026-04-07T19:15:00-03:00"),
        postCode: "1368",
    });

    assert.equal(window.scheduledEndAt?.toISOString(), iso("2026-04-07T19:00:00-03:00"));
});

test("anomaly guard clamps excessive delay to zero balance", () => {
    // P shift misregistered as SN: scheduledStart 19:00 but arrived 07:00 next day = 720 min "delay"
    // Doctor left at 07:15 (within scheduled end), so no overtime to compensate
    const raw = calculateBankHours({
        scheduledStartAt: iso("2026-04-04T19:00:00-03:00"),
        scheduledEndAt: iso("2026-04-05T07:00:00-03:00"),
        actualStartAt: iso("2026-04-05T07:00:00-03:00"),
        actualEndAt: iso("2026-04-05T07:00:00-03:00"),
    });

    assert.equal(raw.arrivalDelayMinutes, 720);
    assert.equal(raw.balanceMinutes, -720);

    const guarded = applyAnomalyGuard(raw);
    assert.equal(guarded.balanceMinutes, 0);
    assert.equal(guarded.creditedOvertimeMinutes, 0);
    assert.equal(guarded.ruleCode, "ANOMALY_EXCESSIVE_DELAY");
    assert.ok(guarded.explanation.includes("ANOMALIA"));
});

test("permanencia de 6h ou mais nao vira banco: vira plantao a assinar na folha", () => {
    // SD previsto 07:00-19:15, ficou ate 06:55 do dia seguinte: quase 12h a mais.
    // Antes isso virava ANOMALIA zerada em silencio (e, sem a guarda, +23h de credito).
    const raw = calculateBankHours({
        scheduledStartAt: iso("2026-04-05T07:00:00-03:00"),
        scheduledEndAt: iso("2026-04-05T19:15:00-03:00"),
        actualStartAt: iso("2026-04-05T07:20:00-03:00"),
        actualEndAt: iso("2026-04-06T06:55:00-03:00"),
    });

    assert.equal(raw.overtimeMinutes > 360, true);

    const guarded = applyAnomalyGuard(raw);
    assert.equal(guarded.ruleCode, "EXTENDED_STAY_PAYABLE_SHIFT");
    assert.equal(guarded.extendedStay?.fullShifts, 1);
    assert.equal(guarded.extendedStay?.halfShifts, 0);
    assert.equal(guarded.extendedStay?.bankMinutes, 0);
    assert.equal(guarded.creditedOvertimeMinutes, 0);
    // O atraso de 20 min na chegada continua debitando: sai da folha o plantao,
    // do banco o atraso.
    assert.equal(guarded.balanceMinutes, -20);
});

test("permanencia entre 6h e 10h assina MEIO plantao", () => {
    const raw = calculateBankHours({
        scheduledStartAt: iso("2026-04-05T07:00:00-03:00"),
        scheduledEndAt: iso("2026-04-05T19:00:00-03:00"),
        actualStartAt: iso("2026-04-05T07:00:00-03:00"),
        actualEndAt: iso("2026-04-06T01:45:00-03:00"),
    });

    const guarded = applyAnomalyGuard(raw);
    assert.equal(guarded.extendedStay?.halfShifts, 1);
    assert.equal(guarded.extendedStay?.fullShifts, 0);
    assert.equal(guarded.balanceMinutes, 0);
});

test("permanencia abaixo de 6h continua no banco, em dobro se a chegada foi pontual", () => {
    const raw = calculateBankHours({
        scheduledStartAt: iso("2026-04-05T07:00:00-03:00"),
        scheduledEndAt: iso("2026-04-05T19:00:00-03:00"),
        actualStartAt: iso("2026-04-05T07:00:00-03:00"),
        actualEndAt: iso("2026-04-06T00:59:00-03:00"),
    });

    const guarded = applyAnomalyGuard(raw);
    assert.deepEqual(guarded, raw);
    assert.equal(guarded.extendedStay, null);
    assert.equal(guarded.balanceMinutes, 359 * 2);
});

// O banco de horas tem teto estrutural: nenhuma permanencia credita mais que 6h
// brutas (12h em dobro). Acima disso a saida e a folha, nunca o credito.
test("nenhuma permanencia, por maior que seja, credita mais que 12h no banco", () => {
    for (let overtimeMinutes = 16; overtimeMinutes <= 48 * 60; overtimeMinutes += 7) {
        const guarded = applyAnomalyGuard(calculateBankHours({
            scheduledStartAt: iso("2026-04-05T07:00:00-03:00"),
            scheduledEndAt: iso("2026-04-05T19:00:00-03:00"),
            actualStartAt: iso("2026-04-05T07:00:00-03:00"),
            actualEndAt: new Date(new Date(iso("2026-04-05T19:00:00-03:00")).getTime() + overtimeMinutes * 60000).toISOString(),
        }));

        assert.ok(
            guarded.balanceMinutes <= 12 * 60,
            `permanencia de ${overtimeMinutes} min creditou ${guarded.balanceMinutes} min no banco`,
        );
    }
});

test("anomaly guard passes through normal calculations unchanged", () => {
    const raw = calculateBankHours({
        scheduledStartAt: iso("2026-04-05T07:00:00-03:00"),
        scheduledEndAt: iso("2026-04-05T19:00:00-03:00"),
        actualStartAt: iso("2026-04-05T07:12:00-03:00"),
        actualEndAt: iso("2026-04-05T19:30:00-03:00"),
    });

    const guarded = applyAnomalyGuard(raw);
    assert.deepEqual(guarded, raw);
});

test("anomaly guard passes through delay at exactly 360 minutes", () => {
    const raw = calculateBankHours({
        scheduledStartAt: iso("2026-04-05T07:00:00-03:00"),
        scheduledEndAt: iso("2026-04-05T19:00:00-03:00"),
        actualStartAt: iso("2026-04-05T13:00:00-03:00"),
        actualEndAt: iso("2026-04-05T19:00:00-03:00"),
    });

    assert.equal(raw.arrivalDelayMinutes, 360);
    const guarded = applyAnomalyGuard(raw);
    assert.deepEqual(guarded, raw);
});

// ================================================================
// A regra "chegada >= 9h em intervencao SD vira meio plantao 13-19 com
// carryover de credito no banco" foi APOSENTADA (jul/2026). Atraso em
// plantao inteiro debita sobre a janela do turno, sem conversao automatica.
// ================================================================

test("atraso longo em SD inteiro debita de verdade (sem virar meio plantao)", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-05-26T07:00:00-03:00"),
        scheduledEndAt: iso("2026-05-26T19:00:00-03:00"),
        actualStartAt: iso("2026-05-26T10:38:00-03:00"),
        actualEndAt: iso("2026-05-26T19:00:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 218);
    assert.equal(result.balanceMinutes, -218);
    assert.equal(result.ruleCode, "LATE_NO_OVERTIME");
    assert.deepEqual(applyAnomalyGuard(result), result, "3h38 de atraso e cri\u00advel: nao pode virar ANOMALIA");
});

// A tela nunca pode mostrar um numero que a gravacao nao produz. O modal de
// saida chegou a oferecer "confirmar 23h30 de banco de horas" a quem tinha
// emendado o turno seguinte (caso Felipe Carneiro) porque chamava a matematica
// crua; calculateGuardedBankHours e o unico caminho que preview e gravacao
// compartilham.
test("calculateGuardedBankHours e identico a applyAnomalyGuard(calculateBankHours)", () => {
    const input = {
        scheduledStartAt: iso("2026-04-05T07:00:00-03:00"),
        scheduledEndAt: iso("2026-04-05T19:15:00-03:00"),
        actualStartAt: iso("2026-04-05T07:20:00-03:00"),
        actualEndAt: iso("2026-04-06T06:55:00-03:00"),
    };
    assert.deepEqual(calculateGuardedBankHours(input), applyAnomalyGuard(calculateBankHours(input)));
});

test("preview guardado nao oferece o credito bruto de uma permanencia longa", () => {
    const input = {
        scheduledStartAt: iso("2026-04-05T07:00:00-03:00"),
        scheduledEndAt: iso("2026-04-05T19:15:00-03:00"),
        actualStartAt: iso("2026-04-05T07:00:00-03:00"),
        actualEndAt: iso("2026-04-06T06:55:00-03:00"),
    };
    const raw = calculateBankHours(input);
    const guarded = calculateGuardedBankHours(input);

    // A conta crua daria quase 24h de credito (excedente em dobro).
    assert.equal(raw.balanceMinutes > 20 * 60, true);
    assert.equal(guarded.balanceMinutes, 0);
    assert.equal(guarded.ruleCode, "EXTENDED_STAY_PAYABLE_SHIFT");
});
