import test from "node:test";
import assert from "node:assert/strict";
import { analisarRedes, dominioDoDns, type JanelaDeRede } from "@/modules/acessos/redes";

const T0 = Date.parse("2026-09-28T13:00:00Z"); // 10h na Bahia
const j = (userId: string, sessaoId: string, ip: string, minutos: number, emTurno: boolean, emUso = true): JanelaDeRede => ({
    userId, sessaoId, ip, inicio: new Date(T0 + minutos * 60_000), emTurno, emUso, aparelho: "computador Windows",
});
const CENTRAL = "200.1.2.0/24";
const base = { barrados: [], infoDosIps: new Map(), rotulos: [], plantonistasPorFaixa: new Map([[CENTRAL, 5]]) };

test("redes: conta em uso fora enquanto o dono está na Central = vazou", () => {
    const janelas = [0, 5, 10].flatMap((m) => [j("dono", "s-central", "200.1.2.10", m, true), j("dono", "s-fora", "45.6.7.8", m, true)]);
    const [fora] = analisarRedes({ ...base, janelas }).filter((r) => r.faixa === "45.6.7.0/24");
    assert.equal(fora.contas[0].veredito, "vazou");
    assert.equal(fora.vazamentos, 1);
});

test("redes: duas contas fora do turno no mesmo escritório = coletiva; navegador estranho", () => {
    const janelas = [j("a", "sa", "45.6.7.8", 0, false), j("b", "sb", "45.6.7.9", 0, false)];
    const [rede] = analisarRedes({ ...base, janelas });
    assert.equal(rede.coletivaFora, true);
    assert.equal(rede.contasFora, 2);
    assert.deepEqual(rede.contas.map((c) => c.veredito), ["aparelho_estranho", "aparelho_estranho"]);
    assert.equal(rede.horasFora[10], 2);
});

test("redes: mesmo navegador usado no plantão e depois em casa = uso próprio", () => {
    const janelas = [j("a", "cel", "200.1.2.10", 0, true), j("a", "cel", "177.10.1.1", 600, false)];
    const casa = analisarRedes({ ...base, janelas }).find((r) => r.faixa === "177.10.1.0/24")!;
    assert.equal(casa.contas[0].veredito, "uso_proprio");
    assert.equal(casa.coletivaFora, false);
});

test("redes: faixa medida ou rotulada como Central não é suspeita", () => {
    const janelas = [j("a", "sa", "200.1.2.10", 0, false), j("b", "sb", "200.1.2.11", 0, false), j("c", "sc", "10.9.8.7", 0, false), j("d", "sd", "10.9.8.8", 0, false)];
    const rotulos = [{ faixa: "10.9.8.0/24", kind: "central" as const, label: "COI (SSP)", note: null }];
    const redes = analisarRedes({ ...base, janelas, rotulos });
    assert.equal(redes.find((r) => r.faixa === CENTRAL)?.central, "medida");
    assert.equal(redes.find((r) => r.faixa === "10.9.8.0/24")?.central, "rotulo");
    assert.ok(redes.every((r) => !r.coletivaFora));
});

test("redes: barrado conta na faixa e na conta", () => {
    const redes = analisarRedes({ ...base, janelas: [], barrados: [{ userId: "a", ip: "45.6.7.8", em: new Date(T0), sistema: "tabela" }] });
    assert.equal(redes[0].barrados, 1);
    assert.equal(redes[0].contas[0].barrados, 1);
});

test("redes: domínio do DNS reverso sem o nome da máquina", () => {
    assert.equal(dominioDoDns("200-1-2-3.ssp.ba.gov.br."), "ssp.ba.gov.br");
    assert.equal(dominioDoDns(null), null);
});
