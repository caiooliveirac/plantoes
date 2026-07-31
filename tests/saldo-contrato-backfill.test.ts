import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cycleWindowFor, nameSimilarity, normalizeDoctorName, suggestMatches } from "../scripts/backfill-saldo-contrato";

describe("cycleWindowFor", () => {
    it("o dia da admissão não importa: o ciclo começa no dia 1 do mês", () => {
        // Admitido em 26/12 ou em 01/12, o ciclo é o mesmo.
        assert.deepEqual(
            cycleWindowFor("2024-12-26", "2026-05-31"),
            { start: "2025-12-01", end: "2026-12-01" },
        );
        assert.deepEqual(
            cycleWindowFor("2024-12-01", "2026-05-31"),
            { start: "2025-12-01", end: "2026-12-01" },
        );
    });

    it("volta um ano quando o mês de aniversário ainda não chegou", () => {
        assert.deepEqual(
            cycleWindowFor("2024-08-16", "2026-05-31"),
            { start: "2025-08-01", end: "2026-08-01" },
        );
    });

    it("usa o ano corrente quando o mês de aniversário já passou", () => {
        assert.deepEqual(
            cycleWindowFor("2024-01-03", "2026-05-31"),
            { start: "2026-01-01", end: "2027-01-01" },
        );
    });

    it("o mês de aniversário conta desde o dia 1, mesmo com admissão no fim dele", () => {
        assert.deepEqual(
            cycleWindowFor("2025-05-28", "2026-05-15"),
            { start: "2026-05-01", end: "2027-05-01" },
        );
    });

    it("nunca começa antes da própria admissão", () => {
        assert.deepEqual(
            cycleWindowFor("2026-04-09", "2026-05-31"),
            { start: "2026-04-01", end: "2027-04-01" },
        );
    });

    it("fevereiro não precisa de tratamento especial — o dia é sempre 1", () => {
        assert.deepEqual(
            cycleWindowFor("2024-02-29", "2026-05-31"),
            { start: "2026-02-01", end: "2027-02-01" },
        );
    });
});

describe("normalizeDoctorName", () => {
    it("colapsa espaço duplo e remove acento", () => {
        assert.equal(normalizeDoctorName("ANA LUIZA  ANDRADE ALVES"), "ANA LUIZA ANDRADE ALVES");
        assert.equal(normalizeDoctorName("LEONARDO COPQUE MAGALHÃES"), "LEONARDO COPQUE MAGALHAES");
    });

    it("descarta os sufixos que a planilha pendura no nome", () => {
        assert.equal(normalizeDoctorName("VICTOR RAMOS DA SILVA (PSIQUIATRIA)"), "VICTOR RAMOS DA SILVA");
        assert.equal(normalizeDoctorName("ANA LUIZA ANDRADE ALVES + UPA"), "ANA LUIZA ANDRADE ALVES");
        assert.equal(normalizeDoctorName("EMMANUELLE GOUVEIA OLIVEIRA  (-12H)"), "EMMANUELLE GOUVEIA OLIVEIRA");
    });

    it("preserva o apóstrofo, que é parte do nome", () => {
        assert.equal(normalizeDoctorName("ANA BEATRIZ D'ALMEIDA SILVA"), "ANA BEATRIZ D'ALMEIDA SILVA");
    });

    it("é idempotente — os dois lados da junção passam pela mesma regra", () => {
        const once = normalizeDoctorName("ANA LUIZA  ANDRADE ALVES + UPA");
        assert.equal(normalizeDoctorName(once), once);
    });
});

describe("nameSimilarity", () => {
    it("dá 1 para nomes idênticos", () => {
        assert.equal(nameSimilarity("MARIA SOUZA", "MARIA SOUZA"), 1);
    });

    it("pontua alto uma letra trocada — o erro típico da planilha", () => {
        // GULHERME (planilha) x GUILHERME (cadastro)
        assert.ok(nameSimilarity("GULHERME RABELO MOTA", "GUILHERME RABELO MOTA") > 0.9);
    });

    it("pontua baixo nomes diferentes", () => {
        assert.ok(nameSimilarity("KAREN SEIFARTH MIRANDA", "JOAO PEDRO MIGUEZ PINTO") < 0.3);
    });
});

describe("suggestMatches", () => {
    const candidates = [
        { id: "1", fullName: "Guilherme Rabelo Mota", normalized: "GUILHERME RABELO MOTA" },
        { id: "2", fullName: "Karen Seifarth Miranda", normalized: "KAREN SEIFARTH MIRANDA" },
        { id: "3", fullName: "Gustavo Rabelo Costa", normalized: "GUSTAVO RABELO COSTA" },
    ];

    it("põe o candidato certo em primeiro", () => {
        const [best] = suggestMatches("GULHERME RABELO MOTA", candidates);
        assert.equal(best.fullName, "Guilherme Rabelo Mota");
    });

    it("devolve os candidatos ordenados e limitados", () => {
        const result = suggestMatches("GULHERME RABELO MOTA", candidates, 2);
        assert.equal(result.length, 2);
        assert.ok(result[0].score >= result[1].score);
    });
});
