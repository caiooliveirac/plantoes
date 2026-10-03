import assert from "node:assert/strict";
import test from "node:test";

import {
    buildDepartureNotFoundReply,
    buildLooseComplementReply,
    buildUncertainArrivalReply,
    findUncertainArrivalWords,
    isLooseOperationalComplement,
} from "@/modules/telegram/arrival-certainty";
import { parseMessage } from "@/modules/telegram/parser";

// Nomes fictícios. Espelham os formatos reais do levantamento de out/2026.
const DOCTOR = ["Marcos Vinicius Teles Pacheco", "Marcos Pacheco", "Marcão Pacheco"];

function uncertain(text: string, doctorNames = DOCTOR) {
    return findUncertainArrivalWords({ doctorQuery: parseMessage(text).extractedNames[0] ?? null, doctorNames });
}

test("régua: mensagem só com nome, alvo e turno não deixa sobra", () => {
    for (const text of [
        "Marcos Pacheco 2152 SD",
        "marcos pacheco na PA 2152 sd",
        "Bom dia, Marcos Pacheco chegou na 20 P bom plantão pra todos nós",
        "Marcos Pacheco CRU SD MRV na PA 2032",
        "Marcos Pacheco PA 2154 SD PSIQUIATRIA 06:59",
        "Marcos Pacheco meio período na 1364",
        "Marcos Pacheco CB02 P invertido",
        "Marcos Pacheco CRU 2152 interno SN",
        "Marcos Pacheco 1364 SN RMT 19:18H",
        "Marcos Pacheco 2263 desde 6h33min SD",
        "Marcos Pacheco no COI SN ramal 2263",
        "Marcos Pacheco muda para 2263",
        "Marcos Pacheco núcleo de leitos SD",
    ]) {
        assert.deepEqual(uncertain(text), [], text);
    }
});

test("régua: erro de dedo e nome colado continuam sendo o nome do médico", () => {
    assert.deepEqual(uncertain("Marcos Pachceo 2152 SD"), []);
    assert.deepEqual(uncertain("Marcos Paxeco 2152 SD"), []);
    assert.deepEqual(uncertain("MarcosPacheco 2152 SD"), []);
    assert.deepEqual(uncertain("Marcao Pacheco 2152 SD"), []);
});

test("régua: palavra que não é do médico sobra e barra o registro", () => {
    assert.deepEqual(uncertain("Marcos na PP 20 de P dese 7:00 unidade em ocorrência"), ["dese", "unidade"]);
    assert.deepEqual(uncertain("Corrigindo Marcos Pacheco SN IT 30"), ["Corrigindo"]);
    assert.deepEqual(uncertain("Marcos Pacheco 2152 continuanando RMT"), ["continuanando"]);
    assert.deepEqual(uncertain("Marcos Pacheco 2263 SD esqueci de avisar"), ["esqueci", "avisar"]);
});

test("régua: sobrenome de OUTRO médico não passa pelo médico resolvido", () => {
    // Caso real: o bot casou o primeiro nome e gravou o plantão no médico errado.
    assert.deepEqual(uncertain("Marcos Figueira chegada PP20 SD"), ["Figueira"]);
});

test("parser: formas novas entendidas com certeza", () => {
    assert.equal(parseMessage("Marcos Pacheco PA 2154 SD PSIQUIATRIA").roleFunction, "PSIQ");
    assert.equal(parseMessage("Marcos Pacheco PIAM SE").shiftType, "SD");
    assert.equal(parseMessage("Marcos Pacheco saindo PIAM se precisar").shiftType, null);
    assert.equal(parseMessage("marcos2154 sd").baseCode, "2154");
    assert.deepEqual(parseMessage("marcos2154 sd").extractedNames, ["marcos"]);
    assert.equal(parseMessage("Marcos Pacheco PM 40SN").shiftType, "SN");
    assert.equal(parseMessage("Marcos Pacheco PM 40SN").baseCode, "PM40");
    assert.equal(parseMessage("Marcos Pacheco 2154SD").shiftType, "SD");
    assert.equal(parseMessage("Marcos Pacheco muda para 2263").isReassignment, true);
});

test("parser: 'entrando' é chegada, nunca saída por semelhança com 'encerrando'", () => {
    const parsed = parseMessage("Marcos Pacheco entrando PM04 SN");
    assert.equal(parsed.isDeparture, false);
    assert.equal(parsed.baseCode, "PM04");
    assert.equal(parseMessage("Marcos Pacheco encerrando PM04").isDeparture, true);
});

test("parser: hora colada é reconhecida mas não vira hora de chegada", () => {
    assert.equal(parseMessage("Marcos Pacheco 2263 SD desde 6h33min").arrivalTime, null);
});

test("parser: ramal de 5 dígitos vira destino desconhecido com sugestão", () => {
    const parsed = parseMessage("Marcos Pacheco SD CRU 21524");
    assert.equal(parsed.baseCode, null);
    assert.equal(parsed.unknownTargetToken, "21524");
});

test("complemento solto: fragmento operacional sim, conversa não", () => {
    for (const text of ["SD", "P", "Desde 07:12", "Cancela", "corrigindo PA 2262", "Meio turno", "23:00"]) {
        assert.equal(isLooseOperationalComplement(text), true, text);
    }
    for (const text of ["PESSOAL, BOM DIA", "vc me rende ne?", "Marcos Pacheco 2152 SD", "estou ajustando", ""]) {
        assert.equal(isLooseOperationalComplement(text), false, text);
    }
});

test("respostas dizem o que o bot entendeu e a frase a digitar", () => {
    const refusal = buildUncertainArrivalReply({
        doctorName: "Marcos Pacheco",
        targetCode: "PP20",
        shiftLabel: "P",
        isContinuation: false,
        uncertainWords: ["dese", "unidade"],
        hasQuestionMark: false,
        noticeTime: "07:02",
        activeElsewhere: null,
    });
    assert.match(refusal, /NÃO registrei/);
    assert.match(refusal, /Não reconheci: dese, unidade\./);
    assert.match(refusal, /\nMarcos Pacheco PP20 P\n/);
    assert.match(refusal, /vale a deste aviso \(07:02\)/);

    const moved = buildUncertainArrivalReply({
        doctorName: "Marcos Pacheco",
        targetCode: "IT30",
        shiftLabel: "SN",
        isContinuation: false,
        uncertainWords: ["Corrigindo"],
        hasQuestionMark: false,
        noticeTime: "19:05",
        activeElsewhere: { targetCode: "CC70", sinceTime: "19:02" },
    });
    assert.match(moved, /já está em CC70 desde 19:02/);
    assert.match(moved, /\nMarcos Pacheco mudou para IT30\n/);

    const loose = buildLooseComplementReply({ doctorName: "Marcos Pacheco", targetCode: "2154", previousText: "Marcos Pacheco 2154 SD" });
    assert.match(loose, /Marcos Pacheco continua 2154/);
    assert.match(loose, /Marcos Pacheco saindo 2154/);

    const elsewhere = buildDepartureNotFoundReply({
        doctorName: "Marcos Pacheco",
        declaredTarget: "BR05",
        active: { targetCode: "IT30", sinceTime: "07:02" },
        last: null,
    });
    assert.match(elsewhere, /saída de BR05, mas no meu registro Marcos Pacheco está em IT30 desde 07:02/);
    assert.match(elsewhere, /\nMarcos Pacheco saindo IT30\n/);

    const closed = buildDepartureNotFoundReply({
        doctorName: "Marcos Pacheco",
        declaredTarget: "2153",
        active: null,
        last: { targetCode: "2153", shiftLabel: "SD", startedLabel: "03/10 07:10", endedLabel: "03/10 19:15" },
    });
    assert.match(closed, /Último plantão registrado: SD 2153, chegada 03\/10 07:10, saída 03\/10 19:15\./);
    assert.match(closed, /já está fechado/);
    assert.match(closed, /chefe de plantão/);
});
