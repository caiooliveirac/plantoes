import test from "node:test";
import assert from "node:assert/strict";
import { mutacaoDeOutroSite } from "@/lib/auth/origem";

const APP = "https://plantoes.mnrs.com.br";
const h = (valores: Record<string, string>) => new Headers(valores);

test("CSRF: POST do próprio app passa", () => {
    assert.equal(mutacaoDeOutroSite("POST", h({ "sec-fetch-site": "same-origin", origin: APP }), APP), false);
});

test("CSRF: POST de subdomínio irmão (same-site) é recusado — SameSite=Lax não barra", () => {
    assert.equal(mutacaoDeOutroSite("POST", h({ "sec-fetch-site": "same-site", origin: "https://tabela.mnrs.com.br" }), APP), true);
});

test("CSRF: POST de outro domínio é recusado", () => {
    assert.equal(mutacaoDeOutroSite("DELETE", h({ "sec-fetch-site": "cross-site" }), APP), true);
});

test("CSRF: GET nunca é barrado aqui", () => {
    assert.equal(mutacaoDeOutroSite("GET", h({ "sec-fetch-site": "cross-site" }), APP), false);
});

test("CSRF: navegador antigo sem Sec-Fetch-Site cai na Origin", () => {
    assert.equal(mutacaoDeOutroSite("POST", h({ origin: APP }), APP), false);
    assert.equal(mutacaoDeOutroSite("POST", h({ origin: "https://lab-plantoes.mnrs.com.br" }), APP), true);
    assert.equal(mutacaoDeOutroSite("POST", h({ origin: "null" }), APP), true);
});

test("CSRF: chamada de servidor (porteiro, webhook) sem Origin nem Sec-Fetch passa", () => {
    assert.equal(mutacaoDeOutroSite("POST", h({}), APP), false);
});
