import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LUGARES_TOLERADOS, contarLugares, decidirPortao } from "@/modules/acessos/portao";

// ── Portão de turno (docs/monitor-acessos.md) ────────────────────────────────
test("portão: admin passa sempre, mesmo fora do turno e da Central", () => {
    assert.deepEqual(decidirPortao({ roles: ["admin", "chief"], emTurno: false, naCentral: false }), { liberado: true, motivo: "admin" });
});

test("portão: chefia fora do plantão e fora da Central é barrada", () => {
    assert.deepEqual(decidirPortao({ roles: ["chief", "doctor"], emTurno: false, naCentral: false }), { liberado: false, motivo: "fora_do_plantao" });
});

test("portão: médico em turno passa de qualquer lugar", () => {
    assert.equal(decidirPortao({ roles: ["doctor"], emTurno: true, naCentral: false }).liberado, true);
});

test("portão: na Central passa mesmo sem chegada registrada", () => {
    assert.deepEqual(decidirPortao({ roles: ["doctor"], emTurno: false, naCentral: true }), { liberado: true, motivo: "central" });
});

test("portão: conta só de portal fora do turno é barrada (Tabela)", () => {
    assert.equal(decidirPortao({ roles: ["portal"], emTurno: false, naCentral: false }).liberado, false);
});

// ── Lugares ao mesmo tempo ───────────────────────────────────────────────────
const agora = Date.parse("2026-09-28T12:00:00Z");
const v = (sessaoId: string, ip: string, minutosAtras = 0) => ({ sessaoId, ip, em: agora - minutosAtras * 60_000 });

test("lugares: PCs da Central (mesma /24, IPs e sessões diferentes) são um lugar", () => {
    const r = contarLugares([v("a", "200.1.2.10"), v("b", "200.1.2.11"), v("c", "200.1.2.12"), v("d", "200.1.2.13"), v("e", "200.1.2.14")], agora);
    assert.equal(r.total, 1);
});

test("lugares: celular que troca de IP no 4G (mesma sessão) é um lugar", () => {
    const r = contarLugares([v("cel", "177.10.1.1"), v("cel", "189.20.2.2"), v("cel", "2804:14c:1:2::5")], agora);
    assert.equal(r.total, 1);
});

test("lugares: Central + celular + casa = 3, tolerado", () => {
    const r = contarLugares([v("pc", "200.1.2.10"), v("cel", "177.10.1.1"), v("casa", "189.20.2.2")], agora);
    assert.equal(r.total, 3);
    assert.ok(r.total <= LUGARES_TOLERADOS);
});

test("lugares: quatro lugares diferentes ao mesmo tempo passam do limite", () => {
    const r = contarLugares([v("a", "200.1.2.10"), v("b", "177.10.1.1"), v("c", "189.20.2.2"), v("d", "45.6.7.8")], agora);
    assert.equal(r.total, 4);
    assert.ok(r.total > LUGARES_TOLERADOS);
});

test("lugares: visto há mais de 5 minutos não conta", () => {
    const r = contarLugares([v("a", "200.1.2.10"), v("b", "177.10.1.1"), v("c", "189.20.2.2"), v("d", "45.6.7.8", 6)], agora);
    assert.equal(r.total, 3);
});

// ── Guarda: toda rota da Mesa passa pelo portão de turno ─────────────────────
function arquivos(dir: string): string[] {
    return readdirSync(dir).flatMap((nome) => {
        const caminho = join(dir, nome);
        return statSync(caminho).isDirectory() ? arquivos(caminho) : caminho.endsWith("route.ts") ? [caminho] : [];
    });
}

for (const rota of ["app/api/board", "app/api/regulation", "app/api/intervention", "app/api/operational"].flatMap(arquivos)) {
    test(`portão: ${rota} usa requireMesaSession`, () => {
        const fonte = readFileSync(rota, "utf8");
        assert.doesNotMatch(fonte, /\b(requireAuthenticatedSession|requireSessionForRead|readAuthenticatedSession)\s*\(/, "rota da Mesa sem portão de turno");
        // abrirVigiaDaMesa (SSE) chama requireMesaSessionForRead e reconfere depois.
        assert.match(fonte, /\b(requireMesaSession(ForRead)?|requireMesaEscrita|abrirVigiaDaMesa)\s*\(/);
    });
}

test("portão: operadores da Central (rádio, TARM — sem escala aqui) só abrem a Mesa na rede da Central", () => {
    for (const papel of ["radio_operador", "tarm"]) {
        assert.deepEqual(decidirPortao({ roles: [papel], emTurno: false, naCentral: true }), { liberado: true, motivo: "central" });
        assert.deepEqual(decidirPortao({ roles: [papel], emTurno: false, naCentral: false }), { liberado: false, motivo: "fora_do_plantao" });
    }
});
