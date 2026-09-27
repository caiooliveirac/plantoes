import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { corrigirUtf8, geoDoCliente, ipDoCliente, lerContextoRequisicao, lerRota, lerUsoDaMesa, normalizarIp, type ContextoRequisicao } from "@/lib/acessos/contexto";
import { createSessionToken, legacySessionId, sessionIdOf, verifySessionToken } from "@/lib/auth/token";
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
