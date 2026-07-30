import assert from "node:assert/strict";
import test from "node:test";
import {
    buildUpaRestrictionsCommandReply,
    buildUpaRestrictionsHint,
    fetchUpaRestrictions,
    upaRestrictionsHintForConfirmation,
} from "@/modules/telegram/upa-restrictions";

const RESTRICOES = [
    { unitName: "UPA Brotas", untilLabel: "hoje 19:00" },
    { unitName: "UPA São Marcos", untilLabel: "amanhã 07:00" },
];

test("buildUpaRestrictionsHint: lista as restritas com o prazo", () => {
    const hint = buildUpaRestrictionsHint(RESTRICOES);
    assert.match(hint, /UPAs restritas pela chefia/);
    assert.match(hint, /• UPA Brotas — até hoje 19:00/);
    assert.match(hint, /• UPA São Marcos — até amanhã 07:00/);
    assert.ok(hint.startsWith("\n\n"), "separa da confirmação com linha em branco");
});

test("buildUpaRestrictionsHint: sem restrição não ocupa espaço na chegada", () => {
    assert.equal(buildUpaRestrictionsHint([]), "");
});

test("buildUpaRestrictionsHint: trunca lista longa para não dominar o balão", () => {
    const muitas = Array.from({ length: 9 }, (_, i) => ({
        unitName: `UPA ${i + 1}`,
        untilLabel: "hoje 19:00",
    }));
    const hint = buildUpaRestrictionsHint(muitas);
    assert.match(hint, /• \.\.\. e mais 3/);
    assert.doesNotMatch(hint, /UPA 7/);
});

test("buildUpaRestrictionsCommandReply: diz explicitamente quando não há nenhuma", () => {
    assert.match(buildUpaRestrictionsCommandReply([]), /Nenhuma UPA restrita/);
});

test("buildUpaRestrictionsCommandReply: avisa quando não deu para consultar", () => {
    assert.match(buildUpaRestrictionsCommandReply(null), /Não consegui consultar/);
});

test("buildUpaRestrictionsCommandReply: conta e lista as restritas", () => {
    const reply = buildUpaRestrictionsCommandReply(RESTRICOES);
    assert.match(reply, /2 UPAs restritas/);
    assert.match(reply, /UPA Brotas — até hoje 19:00/);
});

test("fetchUpaRestrictions: sem TABELA_API_URL devolve null (fail-soft)", async () => {
    const prev = process.env.TABELA_API_URL;
    delete process.env.TABELA_API_URL;
    try {
        assert.equal(await fetchUpaRestrictions(), null);
    } finally {
        if (prev !== undefined) process.env.TABELA_API_URL = prev;
    }
});

test("upaRestrictionsHintForConfirmation: só chegada de REGULAÇÃO recebe a lista", async () => {
    const prev = process.env.TABELA_API_URL;
    // Sem config a busca devolve null; o que importa aqui é que os casos
    // barrados nem chegam a consultar (todos devolvem "").
    delete process.env.TABELA_API_URL;
    try {
        assert.equal(
            await upaRestrictionsHintForConfirmation({ sector: "INTERVENTION" }, "arrival_recorded"),
            "",
            "intervencionista recebe a chave do checklist, não a lista de UPAs",
        );
        assert.equal(
            await upaRestrictionsHintForConfirmation({ sector: "REGULATION", isDeparture: true }, "arrival_recorded"),
            "",
            "saída não recebe lista",
        );
        assert.equal(
            await upaRestrictionsHintForConfirmation({ sector: "REGULATION" }, "departure_recorded"),
            "",
            "só confirmações que registram ocupação",
        );
        assert.equal(
            await upaRestrictionsHintForConfirmation({ sector: "REGULATION" }, "arrival_recorded"),
            "",
            "sem TABELA_API_URL a chegada segue normal, sem o bloco",
        );
    } finally {
        if (prev !== undefined) process.env.TABELA_API_URL = prev;
    }
});
