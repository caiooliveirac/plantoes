import { test } from "node:test";
import assert from "node:assert/strict";
import { PORTAL_LOGIN_URL, destinoSemSessao } from "../lib/auth/portao";

test("portão: produção sem PORTAL_LOGIN_URL vai ao login único do portal", () => {
    assert.equal(destinoSemSessao({ NODE_ENV: "production" }), PORTAL_LOGIN_URL);
    assert.equal(destinoSemSessao({ NODE_ENV: "production", PORTAL_LOGIN_URL: "   " }), PORTAL_LOGIN_URL);
});

test("portão: PORTAL_LOGIN_URL definido manda", () => {
    assert.equal(destinoSemSessao({ NODE_ENV: "production", PORTAL_LOGIN_URL: " https://x.example/?proximo=plantoes " }), "https://x.example/?proximo=plantoes");
    assert.equal(destinoSemSessao({ NODE_ENV: "development", PORTAL_LOGIN_URL: "/outro" }), "/outro");
});

test("portão: fora de produção sem env vai ao login local", () => {
    assert.equal(destinoSemSessao({ NODE_ENV: "development" }), "/entrar");
    assert.equal(destinoSemSessao({}), "/entrar");
});
