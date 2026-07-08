import assert from "node:assert/strict";
import test from "node:test";

import {
    buildFiscalSuggestionCallbackData,
    parseFiscalSuggestionCallbackData,
    resolveFiscalSuggestion,
} from "@/modules/telegram/fiscal-confirmation";

test("buildFiscalSuggestionCallbackData / parseFiscalSuggestionCallbackData roundtrip", () => {
    assert.equal(buildFiscalSuggestionCallbackData(true), "pjF:y");
    assert.equal(buildFiscalSuggestionCallbackData(false), "pjF:n");
    assert.equal(parseFiscalSuggestionCallbackData("pjF:y"), true);
    assert.equal(parseFiscalSuggestionCallbackData("pjF:n"), false);
});

test("parseFiscalSuggestionCallbackData ignora callback_data de outras features", () => {
    assert.equal(parseFiscalSuggestionCallbackData("pSN:r:abc-123"), null);
    assert.equal(parseFiscalSuggestionCallbackData(null), null);
    assert.equal(parseFiscalSuggestionCallbackData(undefined), null);
    assert.equal(parseFiscalSuggestionCallbackData("pjF:maybe"), null);
    assert.equal(parseFiscalSuggestionCallbackData("pjF"), null);
});

test("resolveFiscalSuggestion retorna a sugestão quando completa e sem confirmação prévia", () => {
    const suggestion = resolveFiscalSuggestion({
        suggestedRazaoSocial: "ACME SERVICOS MEDICOS LTDA",
        suggestedCnpj: "12.345.678/0001-90",
    });
    assert.deepEqual(suggestion, { razaoSocial: "ACME SERVICOS MEDICOS LTDA", cnpj: "12.345.678/0001-90" });
});

test("resolveFiscalSuggestion retorna null se o médico já confirmou dados fiscais antes", () => {
    const suggestion = resolveFiscalSuggestion({
        razaoSocial: "JA CONFIRMADO LTDA",
        cnpj: "11.111.111/0001-11",
        suggestedRazaoSocial: "SUGESTAO ANTIGA LTDA",
        suggestedCnpj: "22.222.222/0001-22",
    });
    assert.equal(suggestion, null);
});

test("resolveFiscalSuggestion retorna null quando faltam dados ou metadata é inválida", () => {
    assert.equal(resolveFiscalSuggestion(null), null);
    assert.equal(resolveFiscalSuggestion(undefined), null);
    assert.equal(resolveFiscalSuggestion({}), null);
    assert.equal(resolveFiscalSuggestion({ suggestedRazaoSocial: "SO EMPRESA LTDA" }), null);
    assert.equal(resolveFiscalSuggestion({ suggestedCnpj: "12.345.678/0001-90" }), null);
    assert.equal(resolveFiscalSuggestion({ suggestedRazaoSocial: "  ", suggestedCnpj: "12.345.678/0001-90" }), null);
});
