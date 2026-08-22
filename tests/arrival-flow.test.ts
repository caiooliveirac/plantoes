/* Fluxo de esclarecimento da chegada (nível B).

   O que se protege aqui: a frase que a pessoa lê, o formato do callback (que
   viaja em 64 bytes e não pode colidir com os outros parsers do bot) e a régua
   do nome digitado — que a partir de outubro decide se a chegada completa. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCallbackChegada, tecladoPergunta, textoPergunta } from "../modules/operational/arrival-flow";

const CTX = {
    ocupacaoId: "8f14e45f-ceea-467a-9d1f-1b3c2a2e0b11",
    medico: "Roberto Alves Pinto",
    posto: "SM-01",
    turno: "SD",
    esperados: ["Ana Paula de Oliveira Mendes"],
};

describe("textoPergunta", () => {
    it("diz com todas as letras quem era esperado e quem chegou", () => {
        const t = textoPergunta(CTX);
        assert.match(t, /A escala esperava: Ana Paula de Oliveira Mendes/);
        assert.match(t, /Quem registrou chegada: Roberto Alves Pinto/);
        assert.match(t, /SM-01/);
    });

    it("avisa o que muda em outubro — a pessoa decide sabendo", () => {
        assert.match(textoPergunta(CTX), /outubro/);
    });

    it("posto sem titular não vira acusação", () => {
        const t = textoPergunta({ ...CTX, esperados: [] });
        assert.match(t, /sem titular/);
    });
});

describe("teclado e callback", () => {
    it("cabe nos 64 bytes que o Telegram aceita por botão", () => {
        for (const linha of tecladoPergunta(CTX.ocupacaoId, CTX.esperados).inline_keyboard) {
            for (const b of linha) {
                assert.ok((b.callback_data ?? "").length <= 64, `callback_data grande: ${b.callback_data}`);
            }
        }
    });

    it("oferece as três saídas: troquei, peguei de outro, erro", () => {
        const textos = tecladoPergunta(CTX.ocupacaoId, CTX.esperados).inline_keyboard.flat().map((b) => b.text);
        assert.equal(textos.length, 3);
        assert.ok(textos.some((t) => /Troquei com Ana Paula/.test(t)));
        assert.ok(textos.some((t) => /OUTRA pessoa/.test(t)));
        assert.ok(textos.some((t) => /erro de registro/i.test(t)));
    });

    it("o parse devolve ação e ocupação, e ignora o que não é nosso", () => {
        const t = tecladoPergunta(CTX.ocupacaoId, CTX.esperados).inline_keyboard[1][0].callback_data!;
        const p = parseCallbackChegada(t);
        assert.equal(p?.acao, "o");
        assert.equal(p?.ocupacaoId, CTX.ocupacaoId);
        assert.equal(parseCallbackChegada("dep:123"), null);
        assert.equal(parseCallbackChegada(undefined), null);
        assert.equal(parseCallbackChegada("chg:x:1"), null, "ação desconhecida não passa");
    });
});
