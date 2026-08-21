import assert from "node:assert/strict";
import test from "node:test";
import {
    buildChiefArrivalBlockNotice,
    shouldBlockChiefArrivalEdit,
    touchesArrival,
} from "@/modules/operational/chief-arrival-guard";
import { isChiefRegulationPostCode } from "@/modules/operational/roles";
import { calculateBankHours } from "@/modules/bank-hours/calculator";
import { resolveBankHoursScheduledWindow } from "@/modules/bank-hours/window";

const ARRIVAL = new Date("2026-08-21T10:50:00.000Z"); // 07:50 SP

test("isChiefRegulationPostCode reconhece só o ramal da chefia", () => {
    assert.equal(isChiefRegulationPostCode("2031"), true);
    assert.equal(isChiefRegulationPostCode(" 2031 "), true);
    assert.equal(isChiefRegulationPostCode("2032"), false);
    assert.equal(isChiefRegulationPostCode(null), false);
});

test("touchesArrival só acusa quando a chegada realmente muda", () => {
    const base = { existingStartedAt: ARRIVAL, existingBoardStartedAt: ARRIVAL };
    assert.equal(touchesArrival({ ...base }), false);
    assert.equal(touchesArrival({ ...base, requestedStartedAt: ARRIVAL }), false);
    assert.equal(
        touchesArrival({ ...base, requestedStartedAt: new Date("2026-08-21T10:30:00.000Z") }),
        true,
    );
    // Só o espelho do quadro mudando já conta: é a mesma hora que o banco lê.
    assert.equal(
        touchesArrival({ ...base, requestedBoardStartedAt: new Date("2026-08-21T10:30:00.000Z") }),
        true,
    );
});

test("chefe não altera chegada na 2031; admin altera; outros ramais seguem livres", () => {
    assert.equal(shouldBlockChiefArrivalEdit({ postCode: "2031", isAdmin: false, arrivalChanged: true }), true);
    assert.equal(shouldBlockChiefArrivalEdit({ postCode: "2031", isAdmin: true, arrivalChanged: true }), false);
    assert.equal(shouldBlockChiefArrivalEdit({ postCode: "2031", isAdmin: false, arrivalChanged: false }), false);
    assert.equal(shouldBlockChiefArrivalEdit({ postCode: "2033", isAdmin: false, arrivalChanged: true }), false);
});

test("aviso à coordenação nomeia ramal, horários e canal, sem vazar segredo", () => {
    const texto = buildChiefArrivalBlockNotice({
        doctorName: "Luana Franco Bordoni",
        actorLabel: "chefe@samu.local",
        postCode: "2031",
        currentArrivalAt: ARRIVAL,
        requestedArrivalAt: new Date("2026-08-21T10:30:00.000Z"),
        note: "cheguei antes",
        channel: "quadro",
    });
    assert.match(texto, /2031/);
    assert.match(texto, /07:50/);
    assert.match(texto, /07:30/);
    assert.match(texto, /pelo quadro/);
    assert.match(texto, /cheguei antes/);
});

/**
 * A régua que o modal precisa reproduzir: na regulação o previsto termina 07:15
 * (inclui a rendição), mas o banco conta desde 07:00 e só então tolera 15 min.
 * Sair 07:15 não gera nada; 07:16 gera 16 min, dobrados quando a chegada foi no
 * horário. Usar a janela do quadro dava 15 min a menos.
 */
function creditFor(actualEndIso: string) {
    const startedAt = new Date("2026-08-20T22:02:00.000Z"); // 19:02 SP
    const window = resolveBankHoursScheduledWindow({
        domain: "regulation",
        startedAt,
        shiftLabel: "SN",
        scheduledStartAt: new Date("2026-08-20T22:00:00.000Z"), // 19:00 SP
        scheduledEndAt: new Date("2026-08-21T10:15:00.000Z"), // 07:15 SP
        postCode: "2031",
        actualEndAt: new Date(actualEndIso),
    });
    return calculateBankHours({
        scheduledStartAt: window.scheduledStartAt!,
        scheduledEndAt: window.scheduledEndAt!,
        actualStartAt: startedAt,
        actualEndAt: new Date(actualEndIso),
    });
}

test("saída na fronteira não credita; um minuto além credita a partir das 07:00 e dobra", () => {
    assert.equal(creditFor("2026-08-21T10:15:00.000Z").balanceMinutes, 0); // 07:15
    const umMinuto = creditFor("2026-08-21T10:16:00.000Z"); // 07:16
    assert.equal(umMinuto.overtimeMinutes, 16);
    assert.equal(umMinuto.creditedOvertimeMinutes, 32);
    const caso2031 = creditFor("2026-08-21T10:32:00.000Z"); // 07:32 — caso real de 21/08
    assert.equal(caso2031.overtimeMinutes, 32);
    assert.equal(caso2031.balanceMinutes, 64);
});

/**
 * Intervenção: a convenção normal é fechar em :00, mas 16 ocupações do histórico
 * ficaram gravadas em 07:15/19:15. Sem recuar essa fronteira, o excedente saía
 * medido de :15 e o médico perdia 15 min (dobrados quando chegou no horário) —
 * foi o que aconteceu com 3 entradas reais (Karen 08/06, David 08/08,
 * Matheus 12/08).
 */
test("intervenção com previsto gravado em :15 conta o excedente a partir de :00", () => {
    const startedAt = new Date("2026-08-07T22:00:00.000Z"); // 19:00 SP
    const actualEndAt = new Date("2026-08-08T10:31:00.000Z"); // 07:31 SP
    const window = resolveBankHoursScheduledWindow({
        domain: "intervention",
        startedAt,
        shiftLabel: "SN",
        scheduledStartAt: startedAt,
        scheduledEndAt: new Date("2026-08-08T10:15:00.000Z"), // 07:15 SP
        actualEndAt,
    });
    const calc = calculateBankHours({
        scheduledStartAt: window.scheduledStartAt!,
        scheduledEndAt: window.scheduledEndAt!,
        actualStartAt: startedAt,
        actualEndAt,
    });
    assert.equal(calc.overtimeMinutes, 31);
    assert.equal(calc.creditedOvertimeMinutes, 62);
});

test("intervenção com previsto em :00 não recua nada (convenção normal intacta)", () => {
    const startedAt = new Date("2026-08-07T22:00:00.000Z"); // 19:00 SP
    const actualEndAt = new Date("2026-08-08T10:31:00.000Z"); // 07:31 SP
    const window = resolveBankHoursScheduledWindow({
        domain: "intervention",
        startedAt,
        shiftLabel: "SN",
        scheduledStartAt: startedAt,
        scheduledEndAt: new Date("2026-08-08T10:00:00.000Z"), // 07:00 SP
        actualEndAt,
    });
    assert.equal(window.scheduledEndAt!.toISOString(), "2026-08-08T10:00:00.000Z");
});
