import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anniversaryOn, nameSimilarity, normalizeDoctorName, resolveCycleWindow, suggestMatches } from "../scripts/backfill-saldo-contrato";

describe("anniversaryOn", () => {
    it("mantém o dia quando ele existe no ano", () => {
        assert.equal(anniversaryOn(2026, "2024-01-03"), "2026-01-03");
    });

    it("normaliza 29/02 para 28/02 em ano não bissexto", () => {
        assert.equal(anniversaryOn(2026, "2024-02-29"), "2026-02-28");
        assert.equal(anniversaryOn(2028, "2024-02-29"), "2028-02-29");
    });

    it("trata a regra dos séculos", () => {
        assert.equal(anniversaryOn(2100, "2024-02-29"), "2100-02-28");
        assert.equal(anniversaryOn(2000, "2024-02-29"), "2000-02-29");
    });
});

describe("resolveCycleWindow", () => {
    it("usa o aniversário deste ano quando ele já passou", () => {
        assert.deepEqual(
            resolveCycleWindow("2024-01-03", "2026-05-31"),
            { start: "2026-01-03", end: "2027-01-03" },
        );
    });

    it("volta para o aniversário do ano anterior quando ele ainda não chegou", () => {
        assert.deepEqual(
            resolveCycleWindow("2024-08-16", "2026-05-31"),
            { start: "2025-08-16", end: "2026-08-16" },
        );
    });

    it("aceita o aniversário exatamente na data de referência", () => {
        assert.deepEqual(
            resolveCycleWindow("2024-05-31", "2026-05-31"),
            { start: "2026-05-31", end: "2027-05-31" },
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
