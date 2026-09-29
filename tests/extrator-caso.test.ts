/**
 * Extrator de caso (docs/extrator-caso.md): o texto que sai do servidor não
 * pode carregar nome, e-mail, unidade, id nem data civil. Todos os dados daqui
 * são inventados.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { montarCaso } from "@/modules/extrator-caso/caso";
import { Mascara } from "@/modules/extrator-caso/mascara";
import type { BankHoursDoctorHistory, BankHoursHistoryShift } from "@/modules/reporting/bank-hours-history";
import type { ChiefPayableDoctorRow, PayableShift } from "@/modules/reporting/payable-shifts";

const MEDICA = "11111111-1111-4111-8111-111111111111";
const COLEGA = "22222222-2222-4222-8222-222222222222";
const OCUPACAO = "33333333-3333-4333-8333-333333333333";
const GRUPO = "44444444-4444-4444-8444-444444444444";

function novaMascara(segredo = "segredo-de-teste") {
    return new Mascara({
        segredo,
        mesAncora: "2031-03",
        pessoas: [
            { id: MEDICA, nomes: ["Joaquina Bezerra Dias", "Dra. Joaquina"] },
            { id: COLEGA, nomes: ["Teodoro Albuquerque Peçanha", null] },
        ],
        alvos: [
            { dominio: "regulation", codigo: "2031", rotulo: "Chefia de plantão" },
            { dominio: "regulation", codigo: "2152", rotulo: "Ramal Oeste" },
            { dominio: "intervention", codigo: "USA07", rotulo: "Base Jardim Ficticio" },
        ],
    });
}

test("datas viram posição no mês do caso", () => {
    const mascara = novaMascara();
    assert.equal(mascara.dia("2031-03-01"), "D+00 sáb");
    assert.equal(mascara.dia("2031-02-27"), "D-02 qui");
    // 22:04 UTC = 19:04 no relógio operacional; 01:30 UTC ainda é o dia anterior.
    assert.equal(mascara.instante("2031-03-04T22:04:00.000Z"), "D+03 ter 19:04");
    assert.equal(mascara.instante("2031-03-01T01:30:00.000Z"), "D-01 sex 22:30");
    assert.equal(mascara.mes("2031-03"), "M0");
    assert.equal(mascara.mes("2031-01"), "M-2");
    assert.equal(mascara.mes("2032-04"), "M+13");
    assert.equal(mascara.dia("não é data"), null);
});

test("pseudônimo é estável e depende do segredo", () => {
    const a = novaMascara().pessoaPorId(MEDICA);
    assert.match(a, /^MED-[0-9a-f]{8}$/);
    assert.equal(novaMascara().pessoaPorId(MEDICA), a);
    assert.notEqual(novaMascara("outro-segredo").pessoaPorId(MEDICA), a);
    assert.notEqual(novaMascara().pessoaPorId(COLEGA), a);
});

test("nome solto cai no médico cadastrado; desconhecido ganha pseudônimo próprio", () => {
    const mascara = novaMascara();
    assert.equal(mascara.pessoaPorNome("JOAQUINA BEZERRA DIAS"), mascara.pessoaPorId(MEDICA));
    assert.match(mascara.pessoaPorNome("Marcolina Peixoto") ?? "", /^PESSOA-[0-9a-f]{8}$/);
    assert.equal(mascara.pessoaPorNome("  "), null);
});

test("ramal da chefia e eventual da madrugada mantêm o papel, não o número", () => {
    const mascara = novaMascara();
    assert.equal(mascara.alvo("regulation", "2031"), "REG-CHEFIA");
    assert.match(mascara.alvo("regulation", "2266") ?? "", /^REG-EVENTUAL-[0-9a-f]{4}$/);
    assert.match(mascara.alvo("regulation", "2152") ?? "", /^REG-[0-9a-f]{8}$/);
    assert.match(mascara.alvo("intervention", "USA07") ?? "", /^USA-[0-9a-f]{8}$/);
});

test("texto livre: nome, e-mail, unidade, data, id e número saem mascarados", () => {
    const mascara = novaMascara();
    const medica = mascara.pessoaPorId(MEDICA);
    const texto = mascara.texto(
        "joaquina bezerra dias saiu 19:40 da Base Jardim Fictício em 04/03/2031, rendida por Teodoro no 2152. "
        + "Contato fulana@exemplo.test, tel (71) 99999-0000, ocorrência 1234567, ref 33333333-3333-4333-8333-333333333333. Ficou 2 dias.",
    ) ?? "";

    assert.ok(texto.includes(`${medica} saiu 19:40`), texto);
    assert.ok(texto.includes(mascara.pessoaPorId(COLEGA)), texto);
    assert.ok(texto.includes("D+03 ter"), texto);
    assert.ok(texto.includes("Ficou 2 dias"), "palavra comum em minúscula não é nome");
    for (const proibido of ["joaquina", "bezerra", "Teodoro", "Jardim", "2152", "04/03", "2031", "exemplo.test", "99999", "1234567", "33333333"]) {
        assert.ok(!texto.toLowerCase().includes(proibido.toLowerCase()), `vazou "${proibido}": ${texto}`);
    }
});

test("sobrenome que é palavra comum só é mascarado com inicial maiúscula", () => {
    const mascara = novaMascara();
    assert.equal(mascara.texto("faltam 3 dias"), "faltam 3 dias");
    assert.equal(mascara.texto("falei com a Dias"), `falei com a ${mascara.pessoaPorId(MEDICA)}`);
});

function plantaoDoBanco(): BankHoursHistoryShift {
    return {
        occupancyId: OCUPACAO,
        domain: "intervention",
        doctorId: MEDICA,
        doctorName: "Joaquina Bezerra Dias",
        displayName: "Dra. Joaquina",
        targetCode: "USA07",
        targetLabel: "Base Jardim Ficticio",
        continuityGroupId: GRUPO,
        startedAt: "2031-03-04T10:12:00.000Z",
        boardStartedAt: "2031-03-04T10:12:00.000Z",
        handoffEndedAt: "2031-03-04T22:00:00.000Z",
        actualEndedAt: "2031-03-04T22:40:00.000Z",
        effectiveEndedAt: "2031-03-04T22:40:00.000Z",
        shiftLabel: "SD",
        source: "telegram",
        notes: "Joaquina avisou a Marcolina Peixoto que sairia tarde",
        createdAt: "2031-03-04T10:12:05.000Z",
        updatedAt: "2031-03-04T22:41:00.000Z",
        createdByEmail: "bot@exemplo.test",
        updatedByEmail: "chefia@exemplo.test",
        hasPersistedBankEntry: true,
        occupancyScheduledStartAt: "2031-03-04T10:00:00.000Z",
        occupancyScheduledEndAt: "2031-03-04T22:00:00.000Z",
        bankScheduledStartAt: "2031-03-04T10:00:00.000Z",
        bankScheduledEndAt: "2031-03-04T22:00:00.000Z",
        bankActualStartAt: "2031-03-04T10:12:00.000Z",
        bankActualEndAt: "2031-03-04T22:40:00.000Z",
        arrivalDelayMinutes: 12,
        overtimeMinutes: 40,
        creditedOvertimeMinutes: 40,
        balanceMinutes: 28,
        ruleCode: "simple_overtime",
        bankHoursExplanation: "Chegou 07:12 em 04/03/2031 e saiu 19:40.",
        departureConfirmedAt: "2031-03-04T23:00:00.000Z",
        departureConfirmedByName: "Marcolina Peixoto",
        departureConfirmedNote: "ok, Teodoro rendeu",
        lateArrivalAcknowledgedAt: null,
        lateArrivalAcknowledgedByName: null,
        lateArrivalAcknowledgedNote: null,
        manualBalanceMinutes: null,
        manualBalanceNotes: null,
        manualBalanceUpdatedAt: null,
        manualBalanceActorEmail: null,
        auditTrail: [{
            id: "55555555-5555-4555-8555-555555555555",
            action: "occupancy.corrected",
            actorEmail: "chefia@exemplo.test",
            createdAt: "2031-03-05T12:00:00.000Z",
            details: { doctorName: "Joaquina Bezerra Dias", before: "2031-03-04T22:30:00.000Z", target: "USA07" },
        }],
        lateDeparture: { reasonCode: "occurrence", occurrenceNumber: "7654321" },
        workedMinutes: 748,
        countedStartAt: "2031-03-04T10:12:00.000Z",
        countedEndAt: "2031-03-04T22:40:00.000Z",
        monthKey: "2031-03",
        proof: { summary: "Saída 40 min depois do fim programado.", items: ["Rendida por Teodoro Albuquerque Peçanha às 19:40"], mode: "simple_overtime" },
        successorDoctorName: "Teodoro Albuquerque Peçanha",
        successorTookOverAt: "2031-03-04T22:40:00.000Z",
        corrections: [{
            id: "66666666-6666-4666-8666-666666666666",
            createdAt: "2031-03-05T12:00:00.000Z",
            actorEmail: "chefia@exemplo.test",
            chiefOnDutyName: "Marcolina Peixoto",
            changes: ["saída: 19:30 → 19:40"],
            notes: "pedido da Joaquina",
            undone: false,
        }],
        approval: { state: "validado", tone: "ok", label: "Validado", detail: "Validado por Marcolina Peixoto", chiefName: "Marcolina Peixoto", at: "2031-03-04T23:00:00.000Z", note: null },
        flags: { hasCorrectionHistory: true, hasHandoffOverride: false, hasLateArrival: true, hasOpenShift: false },
    };
}

function historico(): BankHoursDoctorHistory {
    return {
        doctorId: MEDICA,
        doctorName: "Joaquina Bezerra Dias",
        displayName: "Dra. Joaquina",
        employmentType: "pj",
        shiftCount: 2,
        workedMinutes: 1468,
        balanceMinutes: 88,
        applicationBalanceMinutes: 28,
        legacy: { spreadsheetName: "JOAQUINA B DIAS", preMay2025Minutes: 60, spreadsheetPeriodMinutes: 0, totalMinutes: 60, source: "planilha", notes: null },
        creditedOvertimeMinutes: 40,
        arrivalDelayMinutes: 12,
        lateArrivalCount: 1,
        handoffOverrideCount: 0,
        correctionCount: 1,
        openShiftCount: 0,
        lastShiftAt: "2031-03-04T10:12:00.000Z",
        shifts: [plantaoDoBanco(), { ...plantaoDoBanco(), occupancyId: "77777777-7777-4777-8777-777777777777", monthKey: "2031-02", balanceMinutes: 0 }],
        settlements: [{ id: "88888888-8888-4888-8888-888888888888", monthKey: "2031-02", kind: "bonus", deltaMinutes: -720, operationalDate: "2031-02-20", notes: "acerto combinado com Joaquina", createdAt: "2031-02-21T13:00:00.000Z" }],
    };
}

function linhaPagavel(): PayableShift {
    return {
        payableShiftId: `${OCUPACAO}:2031-03-04:SD`,
        occupancyId: OCUPACAO,
        domain: "intervention",
        doctorId: MEDICA,
        doctorName: "Joaquina Bezerra Dias",
        displayName: "Dra. Joaquina",
        targetCode: "USA07",
        targetLabel: "Base Jardim Ficticio",
        tagCode: "USA07",
        operationalDate: "2031-03-04",
        shiftLabel: "SD",
        slotStartedAt: "2031-03-04T10:00:00.000Z",
        slotEndedAt: "2031-03-04T22:00:00.000Z",
        startedAt: "2031-03-04T10:12:00.000Z",
        endedAt: "2031-03-04T22:00:00.000Z",
        actualEndedAt: "2031-03-04T22:40:00.000Z",
        scheduledStartAt: "2031-03-04T10:00:00.000Z",
        scheduledEndAt: "2031-03-04T22:00:00.000Z",
        durationMinutes: 748,
        paymentStatus: "ready_for_payment",
        auditStatus: "clean",
        issues: [],
        source: "telegram",
        roleLabel: null,
        paymentUnit: 1,
        paymentTag: null,
        earlyDepartureOutcome: null,
    };
}

function fechamento(): ChiefPayableDoctorRow {
    return {
        doctorId: MEDICA,
        doctorName: "Joaquina Bezerra Dias",
        displayName: "Dra. Joaquina",
        paymentStatus: "ready_for_payment",
        totalSD: 1,
        totalSN: 0,
        total: 1,
        totalDue: 1244.87,
        paymentProfile: "generalist",
        employmentType: "pj",
        pendingCount: 0,
        attestedAt: "2031-04-02T14:00:00.000Z",
        invoiceNumber: "NF-000123",
        paymentProcessNumber: "PROC-2031/000456",
        usaShiftCount: 1,
        cruShiftCount: 0,
        cells: [{ day: "2031-03-04", shifts: [linhaPagavel()] }],
    };
}

const SENTINELAS = [
    "Joaquina", "Bezerra", "Teodoro", "Albuquerque", "Peçanha", "Marcolina", "Peixoto",
    "exemplo.test", "USA07", "Jardim", "2031-03", "04/03", "7654321", "NF-000123", "PROC-2031", "JOAQUINA B DIAS",
    MEDICA, COLEGA, OCUPACAO, GRUPO,
];

test("caso montado não deixa passar nenhum dado identificável", () => {
    const mascara = novaMascara();
    const caso = montarCaso({ medicoId: MEDICA, mes: "2031-03", comTextos: true, pagamento: fechamento(), bancoDeHoras: historico() }, mascara);
    const texto = JSON.stringify(caso);

    for (const sentinela of SENTINELAS) {
        assert.ok(!texto.toLowerCase().includes(sentinela.toLowerCase()), `vazou "${sentinela}"`);
    }
    assert.equal(caso.medico.pseudonimo, mascara.pessoaPorId(MEDICA));
    assert.equal(caso.mes, "M0");
    assert.equal(caso.pagamento?.linhas[0].valorCentavos, 124487);
    assert.equal(caso.pagamento?.linhas[0].chegada, "D+03 ter 07:12");
    assert.equal(caso.pagamento?.notaFiscalInformada, true);
    // Só o plantão do mês pedido entra com detalhe; o resto vira saldo por mês.
    assert.equal(caso.bancoDeHoras?.plantoesDoMes.length, 1);
    assert.deepEqual(caso.bancoDeHoras?.saldoDosPlantoesPorMes.map((item) => item.mes), ["M-1", "M0"]);
    assert.equal(caso.bancoDeHoras?.plantoesDoMes[0].saidaTardia?.ocorrenciaInformada, true);
    assert.equal(caso.bancoDeHoras?.plantoesDoMes[0].sucessor.quem, mascara.pessoaPorId(COLEGA));
    // Quem não é médico cadastrado mas veio em campo próprio também some do texto livre.
    assert.ok(texto.includes(mascara.pessoaPorNome("Marcolina Peixoto") ?? "?"));

    const legenda = mascara.legenda();
    assert.ok(legenda.pessoas.some((pessoa) => pessoa.nome === "Joaquina Bezerra Dias"));
    assert.ok(legenda.alvos.some((alvo) => alvo.codigo === "USA07"));
    assert.ok(legenda.ids.some((id) => id.id === OCUPACAO));
});

test("sem textos: anotação escrita à mão vira marcador, o resto continua", () => {
    const caso = montarCaso({ medicoId: MEDICA, mes: "2031-03", comTextos: false, pagamento: fechamento(), bancoDeHoras: historico() }, novaMascara());
    const plantao = caso.bancoDeHoras?.plantoesDoMes[0];
    assert.equal(plantao?.observacoes, "[texto omitido]");
    assert.equal(plantao?.confirmacaoDaSaida.nota, "[texto omitido]");
    assert.equal(plantao?.trilha[0].detalhes, "[omitido]");
    assert.equal(plantao?.minutos.saldo, 28);
    assert.ok(plantao?.explicacao?.includes("D+03 ter"));
});

test("médico sem fechamento nem banco de horas no mês devolve caso vazio, não erro", () => {
    const caso = montarCaso({ medicoId: MEDICA, mes: "2031-03", comTextos: true, pagamento: null, bancoDeHoras: null }, novaMascara());
    assert.equal(caso.pagamento, null);
    assert.equal(caso.bancoDeHoras, null);
});
