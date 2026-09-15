import test from "node:test";
import assert from "node:assert/strict";
import { criarTokenHandoff, lerTokenHandoff } from "@/lib/auth/federacao";

const chave = "chave-de-teste-compartilhada";

test("handoff: token emitido para o escala volta inteiro na leitura de lá", () => {
    const token = criarTokenHandoff(
        { email: "Medico@X.Y", origem: "plantoes", nome: "Fulano de Tal", normalizedName: "FULANO DE TAL" },
        "samu-salvador",
        chave,
        1_000_000,
    );
    assert.equal(token.split(".").length, 3);
    const lido = lerTokenHandoff(token, "samu-salvador", chave, 1_000_030);
    assert.deepEqual(lido, { email: "medico@x.y", origem: "plantoes", nome: "Fulano de Tal", normalizedName: "FULANO DE TAL" });
});

test("handoff: audiência errada, chave errada ou 60 s passados = null", () => {
    const token = criarTokenHandoff({ email: "a@b.c", origem: "samu-salvador" }, "plantoes", chave, 1_000_000);
    assert.ok(lerTokenHandoff(token, "plantoes", chave, 1_000_059));
    assert.equal(lerTokenHandoff(token, "huddle", chave, 1_000_001), null);
    assert.equal(lerTokenHandoff(token, "plantoes", "outra-chave", 1_000_001), null);
    assert.equal(lerTokenHandoff(token, "plantoes", chave, 1_000_060), null);
    assert.equal(lerTokenHandoff("nao.e.jwt", "plantoes", chave), null);
});
