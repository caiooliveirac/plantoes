/* A régua de nome da conferência de chegada.

   É o ponto onde o sistema decide se alguém "chegou fora da escala" — e a
   partir de outubro isso barra o registro. Uma régua frouxa acusa quem não
   deve; uma régua cega deixa passar a troca por fora. Por isso as três
   respostas (confere / divergente / indeterminado) têm teste próprio. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compararNome, normalizaNome, textoAviso } from "../modules/operational/arrival-check";

const ESPERADOS = ["Ana Paula de Oliveira Mendes", "Carlos Eduardo Souza Lima"];

describe("compararNome", () => {
    it("nome inteiro igual confere, com confiança máxima", () => {
        const r = compararNome("Ana Paula de Oliveira Mendes", ESPERADOS);
        assert.equal(r.veredicto, "confere");
        assert.equal(r.confianca, 1);
    });

    it("acento e caixa não separam a mesma pessoa", () => {
        assert.equal(compararNome("ANA PAULA DE OLIVEIRA MENDES", ESPERADOS).veredicto, "confere");
        assert.equal(normalizaNome("Claúdio Magalhães"), "CLAUDIO MAGALHAES");
    });

    it("nome curto contido no esperado confere — é como se fala no rádio", () => {
        const r = compararNome("Ana Paula", ESPERADOS);
        assert.equal(r.veredicto, "confere");
    });

    it("primeiro + último sobrenome confere, com confiança alta", () => {
        const r = compararNome("Carlos Lima", ESPERADOS);
        assert.equal(r.veredicto, "confere");
        assert.equal(r.confianca, 0.9);
    });

    it("SÓ o primeiro nome batendo é INDETERMINADO, nunca acusação", () => {
        // existem várias "Ana" no serviço: divergir aqui seria acusar por homonímia
        const r = compararNome("Ana Beatriz Nunes", ESPERADOS);
        assert.equal(r.veredicto, "indeterminado");
        assert.ok(r.confianca > 0 && r.confianca < 0.9);
    });

    it("ninguém em comum é divergente — é a troca não registrada", () => {
        assert.equal(compararNome("Roberto Alves Pinto", ESPERADOS).veredicto, "divergente");
    });

    it("posto sem titular na escala não vira acusação", () => {
        assert.equal(compararNome("Roberto Alves Pinto", []).veredicto, "sem_escala");
    });

    it("nome vazio não decide nada", () => {
        assert.equal(compararNome("", ESPERADOS).veredicto, "indeterminado");
    });
});

describe("textoAviso", () => {
    it("divergência anuncia o que vem em setembro e outubro", () => {
        const t = textoAviso({ medico: "Roberto", posto: "SM-01", turno: "SD", esperados: ["Ana Paula"], indeterminado: false });
        assert.match(t, /FORA da escala/);
        assert.match(t, /setembro/);
        assert.match(t, /outubro/);
    });

    it("indeterminado pede conferência, não acusa", () => {
        const t = textoAviso({ medico: "Ana Beatriz", posto: "CRU", turno: "SN", esperados: ["Ana Paula"], indeterminado: true });
        assert.match(t, /CONFERIR/);
        assert.doesNotMatch(t, /FORA da escala/);
    });

    it("posto sem titular é dito como tal, não como culpa de quem chegou", () => {
        const t = textoAviso({ medico: "Roberto", posto: "PM-04", turno: "SD", esperados: [], indeterminado: false });
        assert.match(t, /sem titular/);
    });
});
