import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { corrigirUtf8, geoDoCliente, ipDoCliente, lerContextoRequisicao, lerRota, lerUsoDaMesa, normalizarIp, type ContextoRequisicao } from "@/lib/acessos/contexto";
import { createSessionToken, legacySessionId, sessionIdOf, verifySessionToken } from "@/lib/auth/token";
import { decidirAtitude } from "@/modules/acessos/atitude";
import {
    analisarConta,
    type ContaMonitorada,
    type EventoDeSessao,
    type InfoDeRede,
    type JanelaDeAtividade,
    type SessaoMonitorada,
} from "@/modules/acessos/analise";
import { descreverAparelho } from "@/modules/acessos/aparelho";
import { montarLinhaDoTempo } from "@/modules/acessos/linha-do-tempo";
import { mensagemDeUsoSimultaneo, mensagemDoResumoDiario } from "@/modules/acessos/mensagens";
import { chaveDeRede, distanciaKm, provedorPorDnsReverso } from "@/modules/acessos/rede";
import { classificarPedido, descreverPedido, mascararCaminho } from "@/modules/acessos/registro";
import { duracao, intervalo, quando } from "@/modules/acessos/texto";
import { escalaDoPeriodo, faixaDeCalor, faixasPorAparelho, lugaresDoPainel, montarPainel, riscoDaConta } from "@/modules/acessos/painel";

/**
 * Monitor de acessos (docs/monitor-acessos.md): leitura do contexto do pedido,
 * id de sessão no cookie, classificação dos pedidos e — o principal — a
 * análise que separa "senha compartilhada" de "uma pessoa com dois aparelhos".
 */

const UA = {
    windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
    android: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
    samsung: "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    firefoxAndroid: "Mozilla/5.0 (Android 13; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0",
    curl: "curl/8.4.0",
};

const SALVADOR = { pais: "BR", cidade: "Salvador", codigoRegiao: "BA", lat: -12.97, lon: -38.5 };
const FEIRA = { pais: "BR", cidade: "Feira de Santana", codigoRegiao: "BA", lat: -12.27, lon: -38.97 };
const SAO_PAULO = { pais: "BR", cidade: "São Paulo", codigoRegiao: "SP", lat: -23.55, lon: -46.63 };

const BASE = new Date("2026-09-22T22:00:00.000Z"); // 19:00 na Bahia
const min = (n: number) => new Date(BASE.getTime() + n * 60_000);

function conta(parcial: Partial<ContaMonitorada> = {}): ContaMonitorada {
    return { userId: "11111111-1111-4111-8111-111111111111", email: "medico@teste.invalid", nome: "Dra. Teste", papeis: ["doctor"], ativa: true, versaoSessao: 0, ...parcial };
}

function sessao(id: string, userAgent: string, ip: string, criadaEm = min(-60)): SessaoMonitorada {
    return { id, origem: "portal", versao: 0, criadaEm, ipCriacao: ip, userAgent, geoCriacao: {}, vistaEm: null, ultimoIp: ip, encerradaEm: null, motivoEncerramento: null };
}

/** Presença de `inicio` a `fim` minutos, uma janela de 5 min por vez, com o estado pedido. */
function presenca(sessaoId: string, ip: string, inicio: number, fim: number, estado: "uso" | "visivel" | "fundo"): JanelaDeAtividade[] {
    const janelas: JanelaDeAtividade[] = [];
    for (let m = inicio; m < fim; m += 5) {
        janelas.push({
            sessaoId,
            ip,
            inicio: min(m),
            primeira: min(m),
            ultima: min(Math.min(m + 4, fim)),
            pedidos: 3,
            visiveis: estado === "fundo" ? 0 : 3,
            emUso: estado === "uso" ? 2 : 0,
        });
    }
    return janelas;
}

function evento(tipo: string, em: Date, parcial: Partial<EventoDeSessao> = {}): EventoDeSessao {
    return { em, tipo, sessaoId: null, metodo: null, caminho: null, ip: null, userAgent: null, geo: {}, detalhes: {}, ...parcial };
}

function redes(entradas: Array<[string, Partial<InfoDeRede>]>) {
    return new Map<string, InfoDeRede>(entradas.map(([chave, info]) => [chave, { geo: {}, provedor: null, contas: 1, ...info }]));
}

function contexto(parcial: Partial<ContextoRequisicao> = {}): ContextoRequisicao {
    return { ip: "187.1.1.1", userAgent: UA.windows, geo: {}, metodo: "GET", caminho: "/", rsc: false, prefetch: false, usoMesa: null, ...parcial };
}

// ── Contexto do pedido ─────────────────────────────────────────────────────

test("contexto: IP do Cloudflare vence; x-real-ip (IP do Cloudflare no nginx) é o último recurso", () => {
    assert.equal(ipDoCliente(new Headers({ "cf-connecting-ip": "187.10.20.30", "x-forwarded-for": "1.1.1.1", "x-real-ip": "172.70.0.1" })), "187.10.20.30");
    assert.equal(ipDoCliente(new Headers({ "x-forwarded-for": "177.5.6.7, 172.70.0.1", "x-real-ip": "172.70.0.1" })), "177.5.6.7");
    assert.equal(ipDoCliente(new Headers({ "x-real-ip": "127.0.0.1" })), "127.0.0.1");
    assert.equal(ipDoCliente(new Headers({})), null);
    assert.equal(normalizarIp("::ffff:10.0.0.5"), "10.0.0.5");
    assert.equal(normalizarIp("2804:14C:65::1"), "2804:14c:65::1");
    assert.equal(normalizarIp("<script>"), null);
});

test("contexto: cidade com acento chega em latin1 do Node e é redecodificada", () => {
    const latin1 = Buffer.from("São Paulo", "utf8").toString("latin1");
    assert.equal(corrigirUtf8(latin1), "São Paulo");
    assert.equal(corrigirUtf8("Salvador"), "Salvador");
    assert.equal(corrigirUtf8("São Paulo"), "São Paulo", "já decodificado fica como está");
    const geo = geoDoCliente(new Headers({ "cf-ipcountry": "BR", "cf-ipcity": latin1, "cf-region-code": "SP", "cf-iplatitude": "-23.55", "cf-iplongitude": "-46.63" }));
    assert.deepEqual(geo, { pais: "BR", cidade: "São Paulo", codigoRegiao: "SP", lat: -23.55, lon: -46.63 });
    assert.deepEqual(geoDoCliente(new Headers({ "cf-ipcountry": "XX" })), {}, "XX = desconhecido");
});

test("contexto: uso da Mesa e rota repassada pelo proxy", () => {
    assert.deepEqual(lerUsoDaMesa("v=1;o=12"), { visivel: true, ociosoSeg: 12 });
    assert.deepEqual(lerUsoDaMesa("v=0"), { visivel: false, ociosoSeg: null });
    assert.equal(lerUsoDaMesa("v=talvez"), null);
    assert.deepEqual(lerRota("POST /api/regulation/occupancies"), { metodo: "POST", caminho: "/api/regulation/occupancies" });
    assert.deepEqual(lerRota("lixo"), { metodo: null, caminho: null });
    const ctx = lerContextoRequisicao(new Headers({ "x-plantoes-rota": "GET /", rsc: "1", "next-router-prefetch": "1", "user-agent": UA.iphone }));
    assert.equal(ctx.rsc, true);
    assert.equal(ctx.prefetch, true);
    assert.equal(ctx.caminho, "/");
});

// ── Sessão no cookie ───────────────────────────────────────────────────────

test("token: sid vai e volta; sid malformado invalida o cookie", () => {
    const sid = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const token = createSessionToken({ sub: "u1", exp: Date.now() + 60_000, sv: 2, sid }, "segredo");
    assert.equal(verifySessionToken(token, "segredo")?.sid, sid);
    const ruim = createSessionToken({ sub: "u1", exp: Date.now() + 60_000, sid: "'; drop table" }, "segredo");
    assert.equal(verifySessionToken(ruim, "segredo"), null);
});

test("token: cookie de antes do monitor ganha id derivado estável, formato uuid v8", () => {
    const antigo = createSessionToken({ sub: "u1", exp: Date.now() + 60_000 }, "segredo");
    const a = legacySessionId(antigo);
    assert.equal(a, legacySessionId(antigo), "determinístico");
    assert.notEqual(a, legacySessionId(`${antigo}x`));
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const payload = verifySessionToken(antigo, "segredo")!;
    assert.equal(sessionIdOf(payload, antigo), a);
    assert.equal(sessionIdOf({ sid: "x" }, antigo), "x");
});

test("proxy: repassa a rota e a renovação diária mantém o sid (ou grava o derivado do cookie antigo)", async () => {
    process.env.AUTH_SECRET = "segredo-proxy";
    const { proxy } = await import("@/proxy");
    const velho = Date.now() - 2 * 24 * 3_600_000 + 30 * 24 * 3_600_000; // emitido há 2 dias
    const semSid = createSessionToken({ sub: "u1", exp: velho, sv: 1 }, "segredo-proxy");
    const req = new NextRequest("https://plantoes.mnrs.com.br/admin/acessos", {
        headers: { cookie: `operations_v2_session=${semSid}`, "x-plantoes-rota": "FORJADO /x" },
    });
    const res = proxy(req);
    assert.equal(res.headers.get("x-middleware-request-x-plantoes-rota"), "GET /admin/acessos", "o valor do cliente nunca passa");
    const renovado = verifySessionToken(res.cookies.get("operations_v2_session")!.value, "segredo-proxy")!;
    assert.equal(renovado.sid, legacySessionId(semSid));
    assert.equal(renovado.sv, 1);

    const api = proxy(new NextRequest("https://plantoes.mnrs.com.br/api/board", { method: "GET" }));
    assert.equal(api.headers.get("x-middleware-request-x-plantoes-rota"), "GET /api/board");
});

// ── Aparelho, rede, pedido ─────────────────────────────────────────────────

test("aparelho: descrição em português que distingue aparelhos", () => {
    assert.equal(descreverAparelho(UA.windows).descricao, "computador Windows com Chrome 128");
    assert.equal(descreverAparelho(UA.windowsEdge).descricao, "computador Windows com Edge 128");
    assert.equal(descreverAparelho(UA.android).descricao, "celular Android 10 com Chrome 128");
    assert.equal(descreverAparelho(UA.samsung).descricao, "celular Android 13 SAMSUNG SM-A536E com Samsung Internet 23");
    assert.equal(descreverAparelho(UA.iphone).descricao, "iPhone com Safari 17");
    assert.equal(descreverAparelho(UA.firefoxAndroid).descricao, "celular Android 13 com Firefox 128");
    assert.equal(descreverAparelho(UA.curl).tipo, "programa");
    assert.equal(descreverAparelho(null).tipo, "desconhecido");
});

test("rede: IPv6 agrupa por /64; distância; provedor pelo DNS reverso sem casar pedaço de rótulo", () => {
    assert.equal(chaveDeRede("187.10.20.30"), "187.10.20.30");
    assert.equal(chaveDeRede("2804:14c:65:1:a1b2:c3d4:e5f6:1"), "2804:14c:65:1::/64");
    assert.equal(chaveDeRede("2804:14c:65::1"), "2804:14c:65:0::/64");
    assert.equal(chaveDeRede("2804:14c:65:1:ffff::"), "2804:14c:65:1::/64");
    const km = distanciaKm(SALVADOR, FEIRA);
    assert.ok(km > 80 && km < 120, `Salvador–Feira ≈ 100 km, deu ${km}`);
    assert.deepEqual(provedorPorDnsReverso("b3d4a1c2.virtua.com.br"), { nome: "Claro", servidor: false });
    assert.deepEqual(provedorPorDnsReverso("201-1-2-3.dsl.telesp.net.br."), { nome: "Vivo", servidor: false });
    assert.deepEqual(provedorPorDnsReverso("ec2-3-4-5-6.compute-1.amazonaws.com"), { nome: "Amazon (nuvem)", servidor: true });
    assert.deepEqual(provedorPorDnsReverso("host.internet.com.br"), { nome: "internet.com.br", servidor: false }, "não é a Claro (net.com.br)");
    assert.equal(provedorPorDnsReverso(null), null);
});

test("pedido: página, ação e quadro ao vivo viram evento; consulta periódica e refresh viram só presença", () => {
    assert.deepEqual(classificarPedido(contexto({ metodo: "POST", caminho: "/api/regulation/occupancies" }), null), { evento: "acao", visivel: true, emUso: true });
    assert.equal(classificarPedido(contexto({ caminho: "/api/board/stream" }), null).evento, "quadro_ao_vivo");
    assert.equal(classificarPedido(contexto({ caminho: "/" }), null).evento, "pagina");
    assert.equal(classificarPedido(contexto({ caminho: "/", rsc: true }), "/").evento, null, "router.refresh da mesma página");
    assert.equal(classificarPedido(contexto({ caminho: "/admin/acessos", rsc: true }), "/").evento, "pagina", "navegação no cliente");
    assert.deepEqual(classificarPedido(contexto({ caminho: "/medico", prefetch: true }), "/"), { evento: null, visivel: false, emUso: false });
    const consulta = classificarPedido(contexto({ caminho: "/api/board", usoMesa: { visivel: true, ociosoSeg: 30 } }), "/");
    assert.deepEqual(consulta, { evento: null, visivel: true, emUso: true });
    assert.equal(classificarPedido(contexto({ caminho: "/api/board", usoMesa: { visivel: true, ociosoSeg: 600 } }), "/").emUso, false, "parada há 10 min");
    assert.equal(mascararCaminho("/redefinir-senha/0123456789abcdef0123456789abcdef"), "/redefinir-senha/…");
    assert.equal(mascararCaminho("/folha-ponto/0f0e0d0c-0b0a-4908-8706-050403020100/2026/09"), "/folha-ponto/0f0e0d0c-0b0a-4908-8706-050403020100/2026/09");
    assert.equal(descreverPedido("acao", "POST", "/api/regulation/occupancies/x/end"), "mexeu em plantão ou ramal da regulação");
    assert.equal(descreverPedido("pagina", "GET", "/"), "abriu a Mesa operacional");
});

test("texto: horário da Bahia e durações", () => {
    assert.equal(quando(BASE), "ter 22/09 19:00");
    assert.equal(intervalo(min(40), min(170)), "ter 22/09, 19:40–21:50");
    assert.equal(duracao(130 * 60_000), "2h10");
    assert.equal(duracao(35 * 60_000), "35 min");
    assert.equal(duracao(10_000), "menos de 1 min");
});

// ── Análise ────────────────────────────────────────────────────────────────

test("análise: uma pessoa só, o dia todo na rede da Central — normal, sem episódio", () => {
    const analise = analisarConta({
        conta: conta(),
        sessoes: [sessao("s1", UA.windows, "200.1.1.1")],
        janelas: presenca("s1", "200.1.1.1", 0, 240, "uso"),
        eventos: [],
        redes: redes([["200.1.1.1", { contas: 14, geo: SALVADOR }]]),
        agora: min(242),
    });
    assert.equal(analise.nivel, "normal");
    assert.equal(analise.episodios.length, 0);
    assert.match(analise.resumo, /compatível com uma pessoa/);
    assert.equal(analise.lugares[0].coletiva, true);
    assert.equal(analise.abertaAgora.sessoes, 1);
});

test("análise: aba esquecida em casa enquanto trabalha na Central não vira indício forte", () => {
    const analise = analisarConta({
        conta: conta(),
        sessoes: [sessao("casa", UA.windowsEdge, "177.2.2.2"), sessao("central", UA.windows, "200.1.1.1")],
        janelas: [...presenca("casa", "177.2.2.2", 0, 180, "fundo"), ...presenca("central", "200.1.1.1", 30, 180, "uso")],
        eventos: [],
        redes: redes([["200.1.1.1", { contas: 14 }], ["177.2.2.2", {}]]),
        agora: min(200),
    });
    assert.notEqual(analise.nivel, "forte");
    assert.equal(analise.episodios[0].forca, "moderado", "horas abertas nos dois lados pesa, mas sem uso num deles");
    assert.ok(analise.episodios[0].ressalvas.some((r) => /aba esquecida/.test(r)));
});

test("análise: dois computadores em redes diferentes em uso ao mesmo tempo — indício forte, com evidência", () => {
    const analise = analisarConta({
        conta: conta(),
        sessoes: [sessao("a", UA.windows, "200.1.1.1"), sessao("b", UA.windowsEdge, "177.2.2.2")],
        janelas: [...presenca("a", "200.1.1.1", 0, 60, "uso"), ...presenca("b", "177.2.2.2", 20, 50, "uso")],
        eventos: [evento("acao", min(22), { sessaoId: "b", ip: "177.2.2.2", metodo: "POST", caminho: "/api/regulation/occupancies" })],
        redes: redes([["200.1.1.1", { contas: 14, geo: SALVADOR }], ["177.2.2.2", { geo: FEIRA, provedor: { nome: "Claro", servidor: false } }]]),
        agora: min(70),
    });
    assert.equal(analise.nivel, "forte");
    const [episodio] = analise.episodios;
    assert.equal(episodio.forca, "forte");
    assert.equal(episodio.redes.length, 2);
    assert.ok(episodio.janelasComUsoNosDois >= 2);
    assert.ok(episodio.distanciaKm! > 80);
    assert.ok(episodio.motivos.some((m) => /Dois computadores/.test(m)));
    assert.match(analise.resumo, /Forte indício de senha compartilhada/);
    const evidencia = analise.achados.find((a) => a.nivel === "forte")!.evidencias[0];
    assert.match(evidencia, /computador Windows com Chrome 128 na rede 200\.1\.1\.1 \(Salvador-BA\), usada por 14 contas/);
    assert.match(evidencia, /computador Windows com Edge 128 na rede 177\.2\.2\.2 \(Feira de Santana-BA · Claro\)/);
    // O trecho sobreposto é de quando o segundo apareceu até o primeiro dos dois sair.
    assert.equal(episodio.inicio.getTime(), min(20).getTime());
    assert.equal(episodio.fim.getTime(), min(49).getTime());
});

test("análise: celular + computador em uso pouco tempo pode ser a mesma pessoa; por muito tempo, não", () => {
    const base = {
        conta: conta(),
        sessoes: [sessao("pc", UA.windows, "200.1.1.1"), sessao("cel", UA.android, "177.2.2.2")],
        eventos: [],
        redes: redes([["200.1.1.1", {}], ["177.2.2.2", {}]]),
        agora: min(90),
    };
    const curto = analisarConta({ ...base, janelas: [...presenca("pc", "200.1.1.1", 0, 60, "uso"), ...presenca("cel", "177.2.2.2", 10, 20, "uso")] });
    assert.equal(curto.episodios[0].forca, "moderado");
    assert.ok(curto.episodios[0].ressalvas.some((r) => /mesma pessoa/.test(r)));
    const longo = analisarConta({ ...base, janelas: [...presenca("pc", "200.1.1.1", 0, 60, "uso"), ...presenca("cel", "177.2.2.2", 5, 40, "uso")] });
    assert.equal(longo.episodios[0].forca, "forte");
    assert.ok(longo.episodios[0].motivos.some((m) => /mais do que alternar/.test(m)));
});

test("análise: três redes ao mesmo tempo é forte mesmo sem sinal de toque", () => {
    const analise = analisarConta({
        conta: conta(),
        sessoes: [sessao("a", UA.windows, "200.1.1.1"), sessao("b", UA.android, "177.2.2.2"), sessao("c", UA.iphone, "191.3.3.3")],
        janelas: [
            ...presenca("a", "200.1.1.1", 0, 30, "fundo"),
            ...presenca("b", "177.2.2.2", 0, 30, "fundo"),
            ...presenca("c", "191.3.3.3", 0, 30, "fundo"),
        ],
        eventos: [],
        redes: redes([]),
        agora: min(40),
    });
    assert.equal(analise.episodios[0].forca, "forte");
    assert.ok(analise.episodios[0].motivos.some((m) => /3 redes diferentes/.test(m)));
});

test("análise: redes todas coletivas ou IPv4 × IPv6 sem distância rebaixam o episódio", () => {
    const janelas = [...presenca("a", "200.1.1.1", 0, 40, "uso"), ...presenca("b", "200.1.1.9", 0, 40, "uso")];
    const coletivas = analisarConta({
        conta: conta(),
        sessoes: [sessao("a", UA.windows, "200.1.1.1"), sessao("b", UA.windowsEdge, "200.1.1.9")],
        janelas,
        eventos: [],
        redes: redes([["200.1.1.1", { contas: 20 }], ["200.1.1.9", { contas: 12 }]]),
        agora: min(50),
    });
    assert.equal(coletivas.episodios[0].forca, "moderado");
    assert.ok(coletivas.episodios[0].ressalvas.some((r) => /mesmo prédio/.test(r)));

    const v4v6 = analisarConta({
        conta: conta(),
        sessoes: [sessao("a", UA.windows, "177.2.2.2"), sessao("b", UA.windowsEdge, "2804:14c:65:1::5")],
        janelas: [...presenca("a", "177.2.2.2", 0, 40, "uso"), ...presenca("b", "2804:14c:65:1::5", 0, 40, "uso")],
        eventos: [],
        redes: redes([]),
        agora: min(50),
    });
    assert.equal(v4v6.episodios[0].forca, "moderado");
    assert.ok(v4v6.episodios[0].ressalvas.some((r) => /IPv4 e a outra IPv6/.test(r)));
});

test("análise: a mesma sessão em duas redes não é uso simultâneo de duas pessoas", () => {
    const analise = analisarConta({
        conta: conta(),
        sessoes: [sessao("cel", UA.android, "177.2.2.2")],
        janelas: [...presenca("cel", "177.2.2.2", 0, 20, "uso"), ...presenca("cel", "189.4.4.4", 0, 20, "uso")],
        eventos: [],
        redes: redes([]),
        agora: min(30),
    });
    assert.equal(analise.episodios.length, 0);
    assert.ok(analise.achados.some((a) => a.titulo === "A mesma sessão em duas redes ao mesmo tempo"));
});

test("análise: deslocamento impossível, senha de muitos lugares, programa e VPN viram atenção", () => {
    const analise = analisarConta({
        conta: conta(),
        sessoes: [sessao("a", UA.windows, "200.1.1.1"), sessao("robo", UA.curl, "3.4.5.6")],
        janelas: [
            ...presenca("a", "200.1.1.1", 0, 10, "uso"),
            ...presenca("a", "189.9.9.9", 20, 30, "uso"),
            ...presenca("robo", "3.4.5.6", 100, 105, "fundo"),
        ],
        eventos: [
            evento("senha_portal_ok", min(0), { ip: "200.1.1.1" }),
            evento("senha_portal_ok", min(60), { ip: "177.2.2.2" }),
            evento("senha_login_ok", min(120), { ip: "191.3.3.3" }),
        ],
        redes: redes([
            ["200.1.1.1", { geo: SALVADOR }],
            ["189.9.9.9", { geo: SAO_PAULO }],
            ["3.4.5.6", { provedor: { nome: "Amazon (nuvem)", servidor: true }, geo: { pais: "US" } }],
        ]),
        agora: min(130),
    });
    const titulos = analise.achados.map((a) => a.titulo);
    assert.ok(titulos.includes("Deslocamento impossível entre cidades"), titulos.join(" | "));
    assert.ok(titulos.includes("Senha digitada em muitos lugares"));
    assert.ok(titulos.includes("Sessão usada fora de um navegador"));
    assert.ok(titulos.includes("Acesso por servidor, nuvem ou VPN"));
    assert.ok(titulos.includes("Acesso de fora do Brasil"));
    assert.equal(analise.nivel, "atencao");
    assert.match(analise.deslocamentos[0].deLocal, /Salvador-BA/);
});

test("análise: sessão de senha antiga conta como encerrada", () => {
    const antiga = { ...sessao("velha", UA.windows, "200.1.1.1"), versao: 0 };
    const analise = analisarConta({ conta: conta({ versaoSessao: 1 }), sessoes: [antiga], janelas: [], eventos: [], redes: redes([]), agora: min(10) });
    assert.equal(analise.sessoes[0].situacao, "encerrada");
    assert.match(analise.sessoes[0].motivoEncerramento!, /senha trocada/);
});

// ── Linha do tempo e mensagens ─────────────────────────────────────────────

test("linha do tempo: intercala os aparelhos com a mesma letra no relatório inteiro", () => {
    const sessoes = [sessao("a", UA.windows, "200.1.1.1"), sessao("b", UA.android, "177.2.2.2")];
    const { linhas, rotulos } = montarLinhaDoTempo({
        sessoes,
        janelas: [...presenca("a", "200.1.1.1", 0, 10, "uso"), ...presenca("b", "177.2.2.2", 5, 10, "visivel")],
        eventos: [evento("pagina", min(6), { sessaoId: "b", ip: "177.2.2.2", caminho: "/" })],
        redes: redes([]),
        inicio: min(0),
        fim: min(15),
    });
    assert.deepEqual(linhas.map((l) => `${l.lado} ${l.tipo}`), ["A presenca", "A presenca", "B presenca", "B evento"]);
    assert.equal(rotulos.get("b"), "B");
    assert.match(linhas[3].oque, /abriu a Mesa/);
    assert.match(linhas[2].oque, /tela à vista, parada/);
});

test("mensagens: alerta na hora e resumo diário em português, dentro do limite do Telegram", () => {
    const analise = analisarConta({
        conta: conta(),
        sessoes: [sessao("a", UA.windows, "200.1.1.1"), sessao("b", UA.windowsEdge, "177.2.2.2")],
        janelas: [...presenca("a", "200.1.1.1", 0, 60, "uso"), ...presenca("b", "177.2.2.2", 20, 50, "uso")],
        eventos: [],
        redes: redes([]),
        agora: min(70),
    });
    const alerta = mensagemDeUsoSimultaneo(analise, analise.episodios[0], redes([]), "https://x/admin/acessos/1");
    assert.match(alerta, /^USO SIMULTÂNEO — Dra\. Teste \(medico@teste\.invalid\)/);
    assert.match(alerta, /• A: computador Windows com Chrome 128 — rede 200\.1\.1\.1 — em uso/);
    assert.match(alerta, /Nada foi bloqueado/);

    const limpo = mensagemDoResumoDiario([], min(0), "https://x/admin/acessos");
    assert.match(limpo, /Nenhuma conta com sinal/);
    const cheio = mensagemDoResumoDiario(Array.from({ length: 80 }, () => analise), min(0), "https://x/admin/acessos");
    assert.ok(cheio.length <= 4096, `tamanho ${cheio.length}`);
    assert.match(cheio, /Indício forte \(80\)/);
    assert.match(cheio, /o resto está no monitor/);
    assert.match(cheio, /Monitor: https:\/\/x\/admin\/acessos$/);
});

test("pedido da Tabela (via porteiro): página, ação, WebSocket e arquivos", () => {
    assert.equal(classificarPedido(contexto({ caminho: "/tabela/" }), null).evento, "pagina");
    assert.equal(classificarPedido(contexto({ caminho: "/tabela/api/cases" }), null).evento, null, "consulta de API é presença");
    assert.equal(classificarPedido(contexto({ caminho: "/tabela/assets/index-abc123.js" }), null).evento, null, "arquivo estático é presença");
    assert.equal(classificarPedido(contexto({ caminho: "/tabela/ws" }), null).evento, "quadro_ao_vivo");
    assert.equal(classificarPedido(contexto({ metodo: "POST", caminho: "/tabela/api/cases" }), null).evento, "acao");
    assert.equal(descreverPedido("pagina", "GET", "/tabela/"), "abriu a Tabela de vagas");
    assert.equal(descreverPedido("acao", "POST", "/tabela/api/cases"), "registrou ou alterou caso na Tabela");
    assert.equal(descreverPedido("acao", "DELETE", "/tabela/api/upas/restrictions/3"), "mexeu em restrição de UPA na Tabela");
    assert.equal(descreverPedido("quadro_ao_vivo", "GET", "/tabela/ws"), "ligou a Tabela ao vivo");
    assert.equal(descreverPedido("quadro_ao_vivo", "GET", "/api/board/stream"), "ligou o quadro ao vivo");
});

// ── Painel (/admin/acessos) ────────────────────────────────────────────────

test("painel: escala do período em colunas alinhadas ao relógio da Bahia", () => {
    const ate = new Date("2026-09-27T20:40:00.000Z"); // 17:40 na Bahia
    const dia = escalaDoPeriodo(new Date(ate.getTime() - 24 * 3_600_000), ate);
    assert.equal(dia.passoMs, 30 * 60_000);
    assert.equal(dia.colunas, 49, "24 h desde 17:40 alinhado a 17:30: a última coluna é parcial");
    assert.ok(dia.marcas.every((m) => /^\d{1,2}h$/.test(m.texto)), JSON.stringify(dia.marcas));
    assert.equal(dia.marcas[0].texto, "18h");
    const semana = escalaDoPeriodo(new Date(ate.getTime() - 7 * 24 * 3_600_000), ate);
    assert.equal(semana.passoMs, 3 * 3_600_000);
    assert.ok(semana.marcas.some((m) => m.texto === "dom 27"), JSON.stringify(semana.marcas));
    assert.equal(escalaDoPeriodo(new Date(ate.getTime() - 30 * 24 * 3_600_000), ate).passoMs, 12 * 3_600_000);
});

test("painel: faixa de calor — uso por intensidade, duas redes, episódio moderado e forte", () => {
    const escala = escalaDoPeriodo(min(-5), min(115)); // passo de 30 min a partir de 18:30: [18:30] [19:00] [19:30] [20:00] [20:30]
    const janelas = [
        ...presenca("a", "200.1.1.1", 0, 30, "uso"), // coluna 0: uso
        ...presenca("a", "200.1.1.1", 30, 60, "uso"),
        ...presenca("b", "177.2.2.2", 30, 60, "uso"), // coluna 1: duas redes
    ];
    const faixa = faixaDeCalor(janelas, [], escala);
    assert.equal(faixa.length, escala.colunas);
    assert.equal(faixa[0], "0", `antes do uso: ${faixa}`);
    assert.ok(Number(faixa[1]) >= 1 && Number(faixa[1]) <= 3, `uso numa rede: ${faixa}`);
    assert.equal(faixa[2], "4", `duas redes no mesmo trecho: ${faixa}`);
    const analise = analisarConta({
        conta: conta(),
        sessoes: [sessao("a", UA.windows, "200.1.1.1"), sessao("b", UA.windowsEdge, "177.2.2.2")],
        janelas,
        eventos: [],
        redes: redes([]),
        agora: min(70),
    });
    assert.ok(faixaDeCalor(janelas, analise.episodios, escala).includes("6"), "episódio forte pinta de vermelho");
    const raias = faixasPorAparelho([sessao("a", UA.windows, "200.1.1.1"), sessao("b", UA.windowsEdge, "177.2.2.2")], janelas, analise.episodios, redes([["177.2.2.2", { geo: FEIRA }]]), escala);
    assert.equal(raias.length, 2);
    assert.ok(raias.every((r) => r.faixa.includes("6")), "os dois aparelhos do episódio forte ficam vermelhos");
    assert.equal(raias.find((r) => r.sessaoId === "b")?.onde, "Feira de Santana-BA");
});

test("painel: risco coerente com o nível — forte ≥ 70, atenção 20–69, normal < 20", () => {
    const base = { eventos: [], agora: min(70) };
    const forte = analisarConta({
        ...base,
        conta: conta(),
        sessoes: [sessao("a", UA.windows, "200.1.1.1"), sessao("b", UA.windowsEdge, "177.2.2.2")],
        janelas: [...presenca("a", "200.1.1.1", 0, 60, "uso"), ...presenca("b", "177.2.2.2", 20, 50, "uso")],
        redes: redes([]),
    });
    const normal = analisarConta({ ...base, conta: conta(), sessoes: [sessao("a", UA.windows, "200.1.1.1")], janelas: presenca("a", "200.1.1.1", 0, 60, "uso"), redes: redes([]) });
    const atencao = analisarConta({
        ...base,
        conta: conta(),
        sessoes: [sessao("a", UA.windows, "200.1.1.1"), sessao("robo", UA.curl, "3.4.5.6")],
        janelas: [...presenca("a", "200.1.1.1", 0, 30, "uso"), ...presenca("robo", "3.4.5.6", 40, 45, "fundo")],
        redes: redes([]),
    });
    assert.equal(forte.nivel, "forte");
    assert.ok(riscoDaConta(forte) >= 70);
    assert.equal(atencao.nivel, "atencao");
    assert.ok(riscoDaConta(atencao) >= 20 && riscoDaConta(atencao) < 70);
    assert.equal(normal.nivel, "normal");
    assert.ok(riscoDaConta(normal) < 20);

    const painel = montarPainel({
        analises: [normal, forte],
        brutos: new Map([[forte.conta.userId, { sessoes: [sessao("a", UA.windows, "200.1.1.1"), sessao("b", UA.windowsEdge, "177.2.2.2")], janelas: [] }]]),
        redes: redes([]),
        desde: min(-60),
        ate: min(70),
        geradoEm: min(70),
    });
    assert.equal(painel.foco?.userId, forte.conta.userId, "a conta de maior risco vai para \"Olhe primeiro\"");
    const calmo = montarPainel({ analises: [normal], brutos: new Map(), redes: redes([]), desde: min(-60), ate: min(70), geradoEm: min(70) });
    assert.equal(calmo.foco, null, "sem sinal, ninguém é destacado");
});

test("painel: lugares do período agrupam por cidade e contam contas com sinal", () => {
    const mapa = redes([["200.1.1.1", { geo: SALVADOR, contas: 12 }], ["201.9.9.9", { geo: SALVADOR }], ["177.2.2.2", { geo: FEIRA }]]);
    const uma = analisarConta({ conta: conta({ userId: "u1" }), sessoes: [sessao("a", UA.windows, "200.1.1.1")], janelas: presenca("a", "200.1.1.1", 0, 30, "uso"), eventos: [], redes: mapa, agora: min(40) });
    const outra = analisarConta({
        conta: conta({ userId: "u2" }),
        sessoes: [sessao("b", UA.windows, "201.9.9.9"), sessao("c", UA.windowsEdge, "177.2.2.2")],
        janelas: [...presenca("b", "201.9.9.9", 0, 40, "uso"), ...presenca("c", "177.2.2.2", 0, 40, "uso")],
        eventos: [],
        redes: mapa,
        agora: min(45),
    });
    const lugares = lugaresDoPainel([uma, outra], mapa);
    const salvador = lugares.find((l) => l.rotulo === "Salvador-BA")!;
    assert.equal(salvador.contas, 2, "duas redes da mesma cidade viram um lugar");
    assert.equal(salvador.contasComSinal, 1);
    assert.equal(salvador.coletiva, true);
    assert.equal(lugares[0].contasComSinal >= lugares[lugares.length - 1].contasComSinal, true, "lugar com sinal primeiro");
});


// ── Plantão: uso de trabalho × login emprestado ────────────────────────────

const CENTRAL = "200.1.1.1";
const redesComCentral = (extras: Array<[string, Partial<InfoDeRede>]> = []) =>
    redes([[CENTRAL, { geo: SALVADOR, contas: 20, plantonistas: 9 }], ...extras]);
const turno = (inicio: number, fim: number, rotulo = "Regulação 1363") => ({ inicio: min(inicio), fim: min(fim), rotulo });

test("plantão: dois PCs na rede do plantão durante o turno é trabalho — vira fraco e não pesa", () => {
    const analise = analisarConta({
        conta: conta(),
        sessoes: [sessao("pc1", UA.windows, CENTRAL), sessao("pc2", UA.windowsEdge, "200.1.1.9")],
        janelas: [...presenca("pc1", CENTRAL, 0, 60, "uso"), ...presenca("pc2", "200.1.1.9", 0, 60, "uso")],
        eventos: [],
        redes: redesComCentral([["200.1.1.9", { geo: SALVADOR, contas: 14, plantonistas: 6 }]]),
        agora: min(70),
        plantoes: [turno(-60, 600)],
    });
    assert.equal(analise.episodios[0].forca, "fraco");
    assert.equal(analise.episodios[0].plantao?.todosNaRedeDoPlantao, true);
    assert.match(analise.episodios[0].motivos[0], /De plantão \(Regulação 1363\).*Uso de trabalho/);
    assert.equal(analise.nivel, "normal");
    assert.ok(analise.achados.some((a) => a.titulo === "Mais de um aparelho durante o plantão, todos na rede do plantão"));
    assert.equal(analise.plantao?.agora?.rotulo, "Regulação 1363");
    assert.equal(analise.lugares.find((l) => l.rede === CENTRAL)?.plantao, true);
});

test("plantão: dono na Central e um COMPUTADOR em uso em outra rede ao mesmo tempo é forte", () => {
    const base = {
        conta: conta(),
        eventos: [],
        redes: redesComCentral([["177.2.2.2", { geo: FEIRA }]]),
        agora: min(70),
        plantoes: [turno(-60, 600)],
    };
    const casa = analisarConta({
        ...base,
        sessoes: [sessao("pc", UA.windows, CENTRAL), sessao("casa", UA.windowsEdge, "177.2.2.2")],
        janelas: [...presenca("pc", CENTRAL, 0, 60, "uso"), ...presenca("casa", "177.2.2.2", 10, 25, "uso")],
    });
    assert.equal(casa.episodios[0].forca, "forte");
    assert.ok(casa.episodios[0].motivos.some((m) => /não é o celular dele/.test(m)));
    assert.deepEqual(casa.episodios[0].plantao?.aparelhosFora, ["computador Windows com Edge 128"]);

    const celular = analisarConta({
        ...base,
        sessoes: [sessao("pc", UA.windows, CENTRAL), sessao("cel", UA.android, "177.2.2.2")],
        janelas: [...presenca("pc", CENTRAL, 0, 60, "uso"), ...presenca("cel", "177.2.2.2", 10, 25, "uso")],
    });
    assert.notEqual(celular.episodios[0].forca, "forte", "celular fora pode ser o do plantonista");
    assert.ok(celular.episodios[0].ressalvas.some((r) => /pode ser o do próprio plantonista/.test(r)));
});

test("plantão: fora do turno, Central + computador de casa ao mesmo tempo segue a regra normal", () => {
    const analise = analisarConta({
        conta: conta(),
        sessoes: [sessao("pc1", UA.windows, CENTRAL), sessao("casa", UA.windowsEdge, "177.2.2.2")],
        janelas: [...presenca("pc1", CENTRAL, 0, 60, "uso"), ...presenca("casa", "177.2.2.2", 0, 60, "uso")],
        eventos: [],
        redes: redesComCentral([["177.2.2.2", { geo: FEIRA }]]),
        agora: min(70),
        plantoes: [turno(-1440, -720)],
    });
    assert.equal(analise.episodios[0].forca, "forte");
    assert.equal(analise.episodios[0].plantao, null);
    assert.equal(analise.plantao?.agora, null);
});

test("plantão: dois IPs do pool da Central fora do turno são o mesmo lugar (chefia: fraco; médico: desce um nível)", () => {
    const entrada = {
        sessoes: [sessao("pc1", UA.windows, CENTRAL), sessao("pc2", UA.windowsEdge, "200.1.1.9")],
        janelas: [...presenca("pc1", CENTRAL, 0, 60, "uso"), ...presenca("pc2", "200.1.1.9", 0, 60, "uso")],
        eventos: [],
        redes: redesComCentral([["200.1.1.9", { geo: SALVADOR, contas: 2, plantonistas: 9 }]]),
        agora: min(70),
    };
    const chefe = analisarConta({ ...entrada, conta: conta({ papeis: ["chief"] }) });
    assert.equal(chefe.episodios[0].forca, "fraco");
    assert.match(chefe.episodios[0].motivos[0], /Chefia\/coordenação\/operador da Central.*mesmo lugar/);
    assert.equal(chefe.nivel, "normal");
    const medico = analisarConta({ ...entrada, conta: conta(), plantoes: [turno(-1440, -720)] });
    assert.equal(medico.episodios[0].forca, "moderado", "forte (2 PCs em uso) desce um nível");
    assert.ok(medico.episodios[0].ressalvas.some((r) => /fora do turno do dono/.test(r)));
});

test("rede: faixa /24 junta o pool de IPs da Central; IPv6 fica no /64", async () => {
    const { faixaDeRede } = await import("@/modules/acessos/rede");
    assert.equal(faixaDeRede("200.1.1.9"), "200.1.1.0/24");
    assert.equal(faixaDeRede("200.1.1.200"), faixaDeRede("200.1.1.9"));
    assert.equal(faixaDeRede("2804:14c:65:1:aaaa::5"), "2804:14c:65:1::/64");
    assert.equal(faixaDeRede("2804:14c:65:1::/64"), "2804:14c:65:1::/64");
});

test("plantão: conta na rede do plantão fora do turno do dono vira atenção (mas não para a chefia)", () => {
    const entrada = {
        sessoes: [sessao("pc", UA.windows, CENTRAL)],
        janelas: presenca("pc", CENTRAL, 0, 90, "uso"),
        eventos: [],
        redes: redesComCentral(),
        agora: min(95),
        plantoes: [turno(-2000, -1300)],
    };
    const medico = analisarConta({ ...entrada, conta: conta() });
    const achado = medico.achados.find((a) => a.titulo === "Na rede do plantão fora do turno do dono");
    assert.ok(achado, medico.achados.map((a) => a.titulo).join(" | "));
    assert.equal(medico.nivel, "atencao");
    assert.ok((medico.plantao?.minutosNaRedeForaDoTurno ?? 0) >= 80);
    const chefe = analisarConta({ ...entrada, conta: conta({ papeis: ["chief", "doctor"] }) });
    assert.equal(chefe.achados.some((a) => a.titulo === "Na rede do plantão fora do turno do dono"), false);
    const semMedico = analisarConta({ ...entrada, conta: conta(), plantoes: undefined });
    assert.equal(semMedico.plantao, null, "conta sem médico vinculado não tem escala para comparar");
});

test("rádio-operador: trabalha na Central sem escala — tratado como a chefia no monitor", () => {
    const naCentral = {
        sessoes: [sessao("pc", UA.windows, CENTRAL)],
        janelas: presenca("pc", CENTRAL, 0, 90, "uso"),
        eventos: [],
        redes: redesComCentral(),
        agora: min(95),
        plantoes: [turno(-2000, -1300)],
    };
    const radio = analisarConta({ ...naCentral, conta: conta({ papeis: ["radio_operador"] }) });
    assert.equal(radio.achados.some((a) => a.titulo === "Na rede do plantão fora do turno do dono"), false);

    const doisPcsNaCentral = {
        sessoes: [sessao("pc1", UA.windows, CENTRAL), sessao("pc2", UA.windowsEdge, "200.1.1.9")],
        janelas: [...presenca("pc1", CENTRAL, 0, 60, "uso"), ...presenca("pc2", "200.1.1.9", 0, 60, "uso")],
        eventos: [],
        redes: redesComCentral([["200.1.1.9", { geo: SALVADOR, contas: 2, plantonistas: 9 }]]),
        agora: min(70),
    };
    const radio2 = analisarConta({ ...doisPcsNaCentral, conta: conta({ papeis: ["radio_operador"] }) });
    assert.equal(radio2.episodios[0].forca, "fraco");
    assert.equal(radio2.nivel, "normal");
    const tarm = analisarConta({ ...doisPcsNaCentral, conta: conta({ papeis: ["tarm"] }) });
    assert.equal(tarm.nivel, "normal");
});

test("plantão: PCs usados só na rede do plantão durante o turno não contam em muitos aparelhos", () => {
    const pcs = [UA.windows, UA.windowsEdge, UA.windows.replace("128", "127"), UA.windows.replace("128", "126"), UA.windows.replace("128", "125")];
    const sessoes = pcs.map((ua, i) => sessao(`pc${i}`, ua, CENTRAL));
    const janelas = pcs.flatMap((_, i) => presenca(`pc${i}`, CENTRAL, i * 60, i * 60 + 30, "uso"));
    const noPlantao = analisarConta({ conta: conta(), sessoes, janelas, eventos: [], redes: redesComCentral(), agora: min(400), plantoes: [turno(-60, 720)] });
    assert.equal(noPlantao.achados.some((a) => a.titulo === "Muitos aparelhos"), false);
    assert.ok(noPlantao.aparelhos.every((a) => a.doPlantao));
    const semTurno = analisarConta({ conta: conta(), sessoes, janelas, eventos: [], redes: redesComCentral(), agora: min(400), plantoes: [] });
    assert.ok(semTurno.achados.some((a) => a.titulo === "Muitos aparelhos"));
});

test("painel: banda de plantão e raia do plantão", async () => {
    const { faixaDePlantao, raiaDoPlantao } = await import("@/modules/acessos/painel");
    const escala = escalaDoPeriodo(min(-5), min(115));
    assert.equal(faixaDePlantao([turno(30, 70)], escala), "00110");
    assert.equal(raiaDoPlantao([], escala), null);
    assert.equal(raiaDoPlantao([turno(30, 70), turno(90, 100, "Intervenção BR60")], escala)?.rotulo, "Regulação 1363 · Intervenção BR60");
});

test("análise: Mesa disputada com gente nos dois aparelhos é forte mesmo sem episódio de redes", () => {
    const analise = analisarConta({
        conta: conta(),
        sessoes: [sessao("a", UA.windows, "200.1.1.1")],
        janelas: presenca("a", "200.1.1.1", 0, 20, "uso"),
        eventos: [evento("mesa_ocupada_negada", min(10), { detalhes: { humanoAqui: 30, humanoLa: 40 } })],
        redes: redes([]),
        agora: min(30),
    });
    assert.equal(analise.nivel, "forte");
    assert.equal(analise.episodios.filter((e) => e.forca === "forte").length, 0);
    assert.match(analise.resumo, /mesa aberta em dois aparelhos/i);
});

test("atitude: admin não é derrubado; risco alto derruba; insistência troca a senha", () => {
    const agora = min(100);
    const episodio = { forca: "forte", inicio: min(10), fim: min(90) };
    const base = { nivel: "forte", episodios: [episodio], eventos: [] as Array<{ tipo: string; em: Date }>, agora, aindaAberto: false };
    assert.equal(decidirAtitude({ ...base, papeis: ["admin", "chief"] }), "isento");
    assert.equal(decidirAtitude({ ...base, papeis: ["chief", "doctor"] }), "derrubar");
    assert.equal(decidirAtitude({ ...base, papeis: ["doctor"], nivel: "atencao" }), "nada");
    assert.equal(decidirAtitude({
        ...base,
        papeis: ["doctor"],
        eventos: [{ tipo: "auto_encerrar_sessoes", em: min(40) }],
    }), "nada", "já derrubada neste episódio");
    assert.equal(decidirAtitude({
        papeis: ["doctor"],
        nivel: "forte",
        episodios: [{ forca: "forte", inicio: min(80), fim: min(95) }],
        eventos: [{ tipo: "auto_encerrar_sessoes", em: min(30) }],
        agora,
        aindaAberto: false,
    }), "trocar_senha");
    assert.equal(decidirAtitude({
        papeis: ["doctor"],
        nivel: "forte",
        episodios: [{ forca: "forte", inicio: min(0), fim: min(10) }],
        eventos: [],
        agora,
        aindaAberto: true,
    }), "derrubar", "forte nas últimas 3 h e ainda aberta em 2 redes");
    assert.equal(decidirAtitude({
        ...base,
        papeis: ["doctor"],
        eventos: [{ tipo: "auto_exigir_nova_senha", em: min(50) }],
    }), "nada");
});

test("plantão: aba parada na rede do plantão fora do turno (sem toque) não vira achado", () => {
    const analise = analisarConta({
        conta: conta(),
        sessoes: [sessao("pc", UA.windows, CENTRAL)],
        janelas: presenca("pc", CENTRAL, 0, 120, "visivel"),
        eventos: [],
        redes: redesComCentral(),
        agora: min(125),
        plantoes: [turno(-2000, -1300)],
    });
    assert.equal(analise.achados.some((a) => a.titulo === "Na rede do plantão fora do turno do dono"), false);
    assert.equal(analise.plantao?.minutosNaRedeForaDoTurno, 0);
});
