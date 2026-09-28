import test from "node:test";
import assert from "node:assert/strict";
import { criarCookieAparelho, lerCookieAparelho, nomeCookieAparelho } from "@/lib/auth/aparelho";
import { achadosDaPresenca, type EventoDeSessao } from "@/modules/acessos/analise";
import {
    estaBloqueado,
    lerBatida,
    limiteOciosoSeg,
    modoPresenca,
    passouDoLimite,
    ultimaInteracao,
} from "@/modules/acessos/presenca";

/* Presença na Mesa (docs/presenca-mesa.md): regras puras. O comportamento com
   banco (corrida de dois aparelhos, bloqueio, desbloqueio) está em
   tests/presenca-mesa-db.test.ts. */

const SEGREDO = "segredo-de-teste";

test("aparelho: cookie assinado volta o mesmo id; adulterado ou inventado não vale", () => {
    const valor = criarCookieAparelho(SEGREDO, "11111111-2222-4333-8444-555555555555");
    assert.equal(lerCookieAparelho(valor, SEGREDO), "11111111-2222-4333-8444-555555555555");
    assert.equal(lerCookieAparelho(valor, "outro-segredo"), null);
    assert.equal(lerCookieAparelho(valor.replace("1111", "9999"), SEGREDO), null);
    assert.equal(lerCookieAparelho("11111111-2222-4333-8444-555555555555", SEGREDO), null);
    assert.equal(lerCookieAparelho("nao-e-uuid.abc", SEGREDO), null);
    assert.equal(lerCookieAparelho(undefined, SEGREDO), null);
});

test("aparelho: em produção o cookie é __Host- (subdomínio irmão não planta)", () => {
    assert.equal(nomeCookieAparelho({ NODE_ENV: "production" }), "__Host-plantoes_aparelho");
    assert.equal(nomeCookieAparelho({ NODE_ENV: "development" }), "plantoes_aparelho");
});

test("modo: vazio é sombra (registra sem bloquear); 1 vale; 0 desliga", () => {
    assert.equal(modoPresenca({}), "sombra");
    assert.equal(modoPresenca({ MESA_PRESENCA: "1" }), "valendo");
    assert.equal(modoPresenca({ MESA_PRESENCA: "valendo" }), "valendo");
    assert.equal(modoPresenca({ MESA_PRESENCA: "0" }), "desligado");
    assert.equal(modoPresenca({ MESA_PRESENCA: "talvez" }), "sombra");
});

test("ociosidade: 15 min por padrão; fora de 5–240 min volta ao padrão", () => {
    assert.equal(limiteOciosoSeg({}), 900);
    assert.equal(limiteOciosoSeg({ MESA_OCIOSO_MIN: "20" }), 1200);
    assert.equal(limiteOciosoSeg({ MESA_OCIOSO_MIN: "1" }), 900);
    assert.equal(limiteOciosoSeg({ MESA_OCIOSO_MIN: "abc" }), 900);
});

test("ociosidade: última interação nunca volta no tempo e nunca passa de agora", () => {
    const agora = new Date("2026-09-28T12:00:00Z");
    const guardada = new Date("2026-09-28T11:58:00Z");
    // Cliente diz "parado há 10 min", mas já houve interação há 2 min: vale a mais recente.
    assert.deepEqual(ultimaInteracao({ agora, guardada, paradoSeg: 600, humanoAgora: false }), guardada);
    assert.deepEqual(ultimaInteracao({ agora, guardada, paradoSeg: 30, humanoAgora: false }), new Date("2026-09-28T11:59:30Z"));
    assert.deepEqual(ultimaInteracao({ agora, guardada: null, paradoSeg: null, humanoAgora: true }), agora);
    assert.equal(ultimaInteracao({ agora, guardada: null, paradoSeg: null, humanoAgora: false }), null);
});

test("ociosidade: passa do limite só depois dele; sem interação conhecida não bloqueia", () => {
    const agora = new Date("2026-09-28T12:00:00Z");
    assert.equal(passouDoLimite(agora, new Date("2026-09-28T11:45:30Z"), 900), false);
    assert.equal(passouDoLimite(agora, new Date("2026-09-28T11:44:59Z"), 900), true);
    assert.equal(passouDoLimite(agora, null, 900), false);
});

test("bloqueio: vale até um desbloqueio POSTERIOR", () => {
    const t1 = new Date("2026-09-28T10:00:00Z");
    const t2 = new Date("2026-09-28T11:00:00Z");
    assert.equal(estaBloqueado(null), false);
    assert.equal(estaBloqueado({ lockedAt: t1, unlockedAt: null }), true);
    assert.equal(estaBloqueado({ lockedAt: t2, unlockedAt: t1 }), true);
    assert.equal(estaBloqueado({ lockedAt: t1, unlockedAt: t2 }), false);
});

test("batida: o corpo do cliente não é confiado — lixo vira invisível e sem tempo", () => {
    assert.deepEqual(lerBatida({ visivel: true, paradoSeg: 12.4 }), { visivel: true, paradoSeg: 12 });
    assert.deepEqual(lerBatida({ visivel: "sim", paradoSeg: -5 }), { visivel: false, paradoSeg: null });
    assert.deepEqual(lerBatida(null), { visivel: false, paradoSeg: null });
    assert.deepEqual(lerBatida({ visivel: true, paradoSeg: 1e12, aparelhoId: "forjado" }), { visivel: true, paradoSeg: 7 * 24 * 3600 });
});

function evento(tipo: string, em: string, detalhes: Record<string, unknown> = {}): EventoDeSessao {
    return { em: new Date(em), tipo, sessaoId: null, metodo: null, caminho: null, ip: null, userAgent: null, geo: {}, detalhes };
}

test("achados: Mesa negada com gente mexendo nos dois aparelhos é forte", () => {
    const achados = achadosDaPresenca([evento("mesa_ocupada_negada", "2026-09-28T10:00:00Z", { humanoAqui: 5, humanoLa: 40 })]);
    assert.equal(achados.length, 1);
    assert.equal(achados[0].nivel, "forte");
});

test("achados: aba esquecida no outro aparelho (ninguém mexendo lá) não é forte", () => {
    const achados = achadosDaPresenca([
        evento("mesa_ocupada_negada", "2026-09-28T10:00:00Z", { humanoAqui: 5, humanoLa: 3_000 }),
        evento("mesa_ocupada_negada_sombra", "2026-09-28T10:10:00Z", { humanoAqui: 5, humanoLa: 3_600 }),
    ]);
    assert.deepEqual(achados.map((a) => a.nivel), ["atencao"]);
});

test("achados: trocar do PC para o celular uma vez é normal; revezar 4× em 30 min é ping-pong", () => {
    assert.deepEqual(achadosDaPresenca([evento("mesa_troca_de_aparelho", "2026-09-28T10:00:00Z")]), []);
    const pingPong = achadosDaPresenca(["10:00", "10:04", "10:08", "10:12"].map((h) => evento("mesa_troca_de_aparelho", `2026-09-28T${h}:00Z`)));
    assert.equal(pingPong.length, 1);
    assert.match(pingPong[0].titulo, /revezando/);
    const espalhado = achadosDaPresenca(["10:00", "10:40", "11:20", "12:00"].map((h) => evento("mesa_troca_de_aparelho", `2026-09-28T${h}:00Z`)));
    assert.deepEqual(espalhado, []);
});
