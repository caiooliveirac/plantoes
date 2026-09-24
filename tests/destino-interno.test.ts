import { test } from "node:test";
import assert from "node:assert/strict";
import { destinoInterno } from "../lib/auth/destino-interno";

test("destino do SSO: caminho interno passa", () => {
    assert.equal(destinoInterno("/medico"), "/medico");
    assert.equal(destinoInterno("/medico/folha-ponto"), "/medico/folha-ponto");
    assert.equal(destinoInterno("/banco-de-horas/abc/2026/9"), "/banco-de-horas/abc/2026/9");
});

test("destino do SSO: qualquer outra coisa vira /", () => {
    for (const ruim of [null, undefined, "", "medico", "https://evil.example", "//evil.example", "/\\evil.example", "/api/auth/logout", "/x\u0000y", "/" + "a".repeat(300)]) {
        assert.equal(destinoInterno(ruim as string), "/", String(ruim));
    }
});
