import assert from "node:assert/strict";
import test from "node:test";
import {
    buildDisplacementCoordinationMessage,
    buildDisplacementGroupMessage,
} from "@/modules/operational/displacement-alert";

// O aviso do grupo é para o MÉDICO agir: precisa dizer que o plantão continua e
// pedir a nova posição. Sem isso ele some do painel e ninguém toma atitude.
test("aviso do grupo nomeia quem assumiu e pede a nova posição", () => {
    const texto = buildDisplacementGroupMessage({
        doctorName: "Kêmylla Machado Souza",
        targetCode: "2152",
        takenByDoctorName: "Rafaela Menoita",
        domain: "regulation",
    });

    assert.match(texto, /Kêmylla Machado Souza/);
    assert.match(texto, /Rafaela Menoita assumiu o ramal 2152/);
    assert.match(texto, /plantão continua aberto/);
    assert.match(texto, /nova posição/);
});

test("sem saber quem assumiu, o aviso não inventa nome", () => {
    const texto = buildDisplacementGroupMessage({
        doctorName: "Bruno Oliveira Pedreira",
        targetCode: "PIAM",
        takenByDoctorName: null,
        domain: "intervention",
    });

    assert.match(texto, /outro médico assumiu a base PIAM/);
    assert.doesNotMatch(texto, /null|undefined/);
});

// O aviso da coordenação é para alguém DE FORA reparar — e precisa dizer que o
// plantão é pago se ele cumprir, senão vira desconto silencioso.
test("aviso da coordenação diz que o plantão segue ativo e é pago se cumprido", () => {
    const texto = buildDisplacementCoordinationMessage({
        doctorName: "Pollianna de Souza Roriz",
        targetCode: "PIAM",
        takenByDoctorName: "Leonardo Lopes",
        domain: "intervention",
    });

    assert.match(texto, /Pollianna de Souza Roriz perdeu a base PIAM para Leonardo Lopes/);
    assert.match(texto, /segue ATIVO/);
    assert.match(texto, /é pago/);
});
