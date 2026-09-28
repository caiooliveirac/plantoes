import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import type { ContextoRequisicao } from "@/lib/acessos/contexto";

/**
 * Monitor de acessos contra um Postgres de verdade (migration 0046 aplicada):
 * grava sessões e presença como o portão grava, lê o relatório e roda as ações
 * do admin. SÓ roda quando DATABASE_URL aponta para um banco `*_test` (o CI usa
 * plantoes_test com `npm run db:migrate` antes) — em qualquer outro banco o
 * arquivo inteiro é pulado sem abrir conexão. Contas com e-mail
 * @acessos-teste.invalid, IPs das faixas de documentação (RFC 5737), tudo
 * apagado no fim.
 */

function bancoDeTeste(): string | null {
    try {
        const nome = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "");
        return /_test$/.test(nome) ? nome : null;
    } catch {
        return null;
    }
}

const banco = bancoDeTeste();
const skip = banco ? false : "DATABASE_URL não aponta para um banco *_test";
process.env.AUTH_SECRET ??= "test-secret-monitor-acessos";

const IP_CENTRAL = "192.0.2.10";
const IP_CASA = "198.51.100.20";
const IP_TERCEIRO = "203.0.113.30";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const ANDROID_DB = "Mozilla/5.0 (Linux; Android 13; SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const EDGE = `${WINDOWS} Edg/128.0.0.0`;

async function modulos() {
    const [{ getDb, closeDb }, schema, gravacao, relatorio, acoes, auth] = await Promise.all([
        import("@/db"),
        import("@/db/schema"),
        import("@/services/acessos.service"),
        import("@/services/acessos-relatorio.service"),
        import("@/services/acessos-acoes.service"),
        import("@/services/auth.service"),
    ]);
    return { getDb, closeDb, schema, gravacao, relatorio, acoes, auth };
}

function ctx(ip: string, userAgent: string, parcial: Partial<ContextoRequisicao> = {}): ContextoRequisicao {
    return {
        ip,
        userAgent,
        geo: ip === IP_CENTRAL
            ? { pais: "BR", cidade: "Salvador", codigoRegiao: "BA", lat: -12.97, lon: -38.5 }
            : { pais: "BR", cidade: "Feira de Santana", codigoRegiao: "BA", lat: -12.27, lon: -38.97 },
        metodo: "GET",
        caminho: "/api/board",
        rsc: false,
        prefetch: false,
        usoMesa: { visivel: true, ociosoSeg: 20 },
        ...parcial,
    };
}

const criados: string[] = [];
const plantoesCriados: Array<{ medicoId: string; postoId: number }> = [];

/** Vincula a conta a um médico com ocupação aberta (chegou há 1 h): de plantão agora. */
async function darPlantao(userId: string) {
    const { getDb, schema } = await modulos();
    const db = getDb();
    const marca = randomUUID().slice(0, 6).toUpperCase();
    const [posto] = await db.insert(schema.regulationPosts).values({ code: `P${marca}`, label: `Plantão ${marca}` }).returning({ id: schema.regulationPosts.id });
    const [medico] = await db.insert(schema.doctors).values({ fullName: `Plantonista ${marca}`, normalizedName: `plantonista ${marca.toLowerCase()}` }).returning({ id: schema.doctors.id });
    plantoesCriados.push({ medicoId: medico.id, postoId: posto.id });
    await db.update(schema.users).set({ doctorId: medico.id }).where(eq(schema.users.id, userId));
    await db.insert(schema.regulationOccupancies).values({
        doctorId: medico.id,
        continuityGroupId: randomUUID(),
        postId: posto.id,
        startedAt: new Date(Date.now() - 3_600_000),
        ramalLabel: "1300",
        source: "manual",
    });
}
async function criarConta(papel: "doctor" | "admin") {
    const { getDb, schema, auth } = await modulos();
    const [user] = await getDb()
        .insert(schema.users)
        .values({ email: `${papel}-${randomUUID().slice(0, 8)}@acessos-teste.invalid`, passwordHash: await auth.hashPassword("senha-de-teste-123"), isActive: true })
        .returning({ id: schema.users.id, email: schema.users.email });
    await getDb().insert(schema.userRoles).values({ userId: user.id, role: papel });
    criados.push(user.id);
    return user;
}

after(async () => {
    if (!banco) return;
    const { getDb, closeDb, schema } = await modulos();
    const db = getDb();
    const doTeste = await db.select({ id: schema.users.id }).from(schema.users).where(like(schema.users.email, "%@acessos-teste.invalid"));
    for (const { medicoId, postoId } of plantoesCriados) {
        await db.delete(schema.regulationOccupancies).where(eq(schema.regulationOccupancies.postId, postoId));
        await db.delete(schema.regulationPosts).where(eq(schema.regulationPosts.id, postoId));
        await db.update(schema.users).set({ doctorId: null }).where(eq(schema.users.doctorId, medicoId));
        await db.delete(schema.doctors).where(eq(schema.doctors.id, medicoId));
    }
    const ids = [...new Set([...criados, ...doTeste.map((r) => r.id)])];
    if (ids.length > 0) {
        await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.entityId, ids));
        await db.delete(schema.users).where(inArray(schema.users.id, ids)); // cascata: sessões, eventos, presença, papéis, tokens
    }
    await db.delete(schema.authNetworkInfo).where(inArray(schema.authNetworkInfo.ip, [IP_CENTRAL, IP_CASA, IP_TERCEIRO]));
    await closeDb();
});

test("monitor (banco): dois aparelhos em uso em redes diferentes viram indício forte; ações do admin cortam", { skip }, async () => {
    const { getDb, schema, gravacao, relatorio, acoes } = await modulos();
    gravacao.limparMemoriaDoMonitor();
    const medico = await criarConta("doctor");
    const admin = await criarConta("admin");
    const sessaoA = randomUUID();
    const sessaoB = randomUUID();
    const inicio = new Date(Date.now() - 40 * 60_000);

    await gravacao.registrarNovaSessao({ sessaoId: sessaoA, userId: medico.id, origem: "portal", versao: 0, contexto: ctx(IP_CENTRAL, WINDOWS) });
    await gravacao.registrarNovaSessao({ sessaoId: sessaoB, userId: medico.id, origem: "login", versao: 0, contexto: ctx(IP_CASA, EDGE) });
    // 30 minutos de consulta do quadro nos dois, um pedido por minuto, com gente mexendo.
    for (let minuto = 0; minuto < 30; minuto += 1) {
        const agora = new Date(inicio.getTime() + minuto * 60_000);
        await gravacao.registrarAcesso({ sessaoId: sessaoA, userId: medico.id, versao: 0, contexto: ctx(IP_CENTRAL, WINDOWS), agora });
        await gravacao.registrarAcesso({ sessaoId: sessaoB, userId: medico.id, versao: 0, contexto: ctx(IP_CASA, EDGE), agora: new Date(agora.getTime() + 20_000) });
    }
    await gravacao.registrarAcesso({
        sessaoId: sessaoB,
        userId: medico.id,
        versao: 0,
        contexto: ctx(IP_CASA, EDGE, { metodo: "POST", caminho: "/api/regulation/occupancies", usoMesa: null }),
        agora: new Date(inicio.getTime() + 12 * 60_000),
    });
    await gravacao.registrarTentativaDeSenha({ email: medico.email, ok: true, via: "portal", contexto: ctx(IP_TERCEIRO, "node") });

    const janelas = await getDb().select().from(schema.authSessionActivity).where(eq(schema.authSessionActivity.userId, medico.id));
    assert.ok(janelas.length >= 12, `presença em janelas de 5 min: ${janelas.length}`);
    assert.ok(janelas.every((j) => j.activeRequests > 0), "cabeçalho de uso da Mesa virou 'em uso'");

    const dados = await relatorio.carregarMonitor({ desde: new Date(inicio.getTime() - 60 * 60_000), userId: medico.id });
    const analise = dados.analises.find((a) => a.conta.userId === medico.id)!;
    assert.equal(analise.nivel, "forte", analise.resumo);
    assert.equal(analise.sessoes.length, 2);
    assert.equal(analise.episodios[0].forca, "forte");
    assert.ok(analise.lugares.some((l) => l.local === "Feira de Santana-BA"), "localização gravada por rede");
    assert.equal(analise.entradasComSenha.length, 1);
    assert.ok(dados.brutos.get(medico.id)!.eventos.some((e) => e.tipo === "acao"), "ação entrou na linha do tempo");

    // Encerrar todas: versão sobe, sessões marcadas, auditoria e evento.
    const encerrou = await acoes.agirNaConta("encerrar_sessoes", medico.id, admin.id, "uso simultâneo em teste");
    assert.equal(encerrou.sessoesEncerradas, 2);
    assert.equal(await gravacao.sessaoFoiEncerrada(sessaoA), true);
    const [depois] = await getDb().select({ sv: schema.users.sessionVersion }).from(schema.users).where(eq(schema.users.id, medico.id));
    assert.equal(depois.sv, 1);
    const auditoria = await getDb().select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, medico.id), eq(schema.auditLogs.action, "acessos.encerrar_sessoes")));
    assert.equal(auditoria.length, 1);

    // Trocar a senha: a antiga para de valer, sai link de redefinição (sem SMTP no teste, volta o link).
    const trocou = await acoes.agirNaConta("exigir_nova_senha", medico.id, admin.id, "senha emprestada em teste");
    assert.equal(trocou.emailEnviado, false);
    assert.match(trocou.linkDeRedefinicao!, /\/redefinir-senha\/[0-9a-f]{32}$/);
    const { authenticateWithPassword } = await import("@/services/auth.service");
    assert.equal((await authenticateWithPassword(medico.email, "senha-de-teste-123")).status, "invalid_credentials");

    // Suspender e reativar; o admin não suspende a si mesmo; motivo curto é recusado.
    await acoes.agirNaConta("suspender", medico.id, admin.id, "apuração em teste");
    const [suspensa] = await getDb().select({ ativa: schema.users.isActive }).from(schema.users).where(eq(schema.users.id, medico.id));
    assert.equal(suspensa.ativa, false);
    await acoes.agirNaConta("reativar", medico.id, admin.id, "apuração concluída");
    await assert.rejects(acoes.agirNaConta("suspender", admin.id, admin.id, "tentando me suspender"), /própria conta/);
    await assert.rejects(acoes.agirNaConta("encerrar_sessoes", medico.id, admin.id, "curto".slice(0, 3)), /motivo/);

    const eventosDoAdmin = await getDb().select({ tipo: schema.authSessionEvents.kind }).from(schema.authSessionEvents)
        .where(and(eq(schema.authSessionEvents.userId, medico.id), like(schema.authSessionEvents.kind, "admin_%")));
    assert.deepEqual(eventosDoAdmin.map((e) => e.tipo).sort(), ["admin_encerrar_sessoes", "admin_exigir_nova_senha", "admin_reativar", "admin_suspender"]);
});

test("monitor (banco): sessão de cookie antigo nasce na primeira visita; rede nova no meio da sessão vira evento", { skip }, async () => {
    const { getDb, schema, gravacao } = await modulos();
    gravacao.limparMemoriaDoMonitor();
    const medico = await criarConta("doctor");
    const sessao = randomUUID();
    await gravacao.registrarAcesso({ sessaoId: sessao, userId: medico.id, versao: 3, contexto: ctx(IP_CENTRAL, WINDOWS, { caminho: "/", usoMesa: null }) });
    const [linha] = await getDb().select().from(schema.authSessions).where(eq(schema.authSessions.id, sessao));
    assert.equal(linha.origin, "anterior");
    assert.equal(linha.sessionVersion, 3);
    await gravacao.registrarAcesso({ sessaoId: sessao, userId: medico.id, versao: 3, contexto: ctx(IP_CASA, WINDOWS) });
    const tipos = (await getDb().select({ tipo: schema.authSessionEvents.kind }).from(schema.authSessionEvents).where(eq(schema.authSessionEvents.sessionId, sessao))).map((e) => e.tipo);
    assert.ok(tipos.includes("sessao_criada"));
    assert.ok(tipos.includes("pagina"));
    assert.ok(tipos.includes("nova_rede"));

    await gravacao.registrarSaida(sessao, medico.id, ctx(IP_CASA, WINDOWS));
    assert.equal(await gravacao.sessaoFoiEncerrada(sessao), true);

    // Retenção: com o relógio 181 dias à frente, some tudo desta conta.
    const podados = await gravacao.podarRegistrosAntigos(new Date(Date.now() + 181 * 24 * 60 * 60_000));
    assert.ok(podados.sessoes >= 1);
    const sobrou = await getDb().select().from(schema.authSessions).where(eq(schema.authSessions.userId, medico.id));
    assert.equal(sobrou.length, 0);
});

test("monitor (banco): o porteiro confere o login do portal — vale, senha trocada recusa, suspensa recusa — e o uso da Tabela entra no monitor", { skip }, async () => {
    const { getDb, schema, gravacao, acoes } = await modulos();
    gravacao.limparMemoriaDoMonitor();
    process.env.ESCALA_SSO_TOKEN = "token-de-servico-de-teste";
    const { POST } = await import("@/app/api/servicos/portal/acesso/route");
    const { NextRequest } = await import("next/server");
    const medico = await criarConta("doctor");
    const admin = await criarConta("admin");
    const sid = randomUUID();
    const chamar = async (corpo: Record<string, unknown>, token = "token-de-servico-de-teste") => {
        const resposta = await POST(new NextRequest("http://127.0.0.1:3004/api/servicos/portal/acesso", {
            method: "POST",
            headers: { "content-type": "application/json", "x-escala-token": token, "cf-connecting-ip": IP_CASA, "user-agent": EDGE, "cf-ipcity": "Feira de Santana", "cf-ipcountry": "BR" },
            body: JSON.stringify(corpo),
        }));
        return { status: resposta.status, dados: await resposta.json() as { ok?: boolean; motivo?: string } };
    };

    assert.equal((await chamar({ email: medico.email, sid, sv: 0 }, "token-errado")).status, 401);
    // Portão de turno: sem plantão e fora da Central, a Tabela recusa; o portal (sem sistema de plantão) vale.
    const { limparMemoriaDoPortao } = await import("@/services/acessos-portao.service");
    limparMemoriaDoPortao();
    assert.deepEqual((await chamar({ email: medico.email, sid, sv: 0, sistema: "tabela" })).dados, { ok: false, motivo: "fora_do_plantao" });
    assert.deepEqual((await chamar({ email: medico.email, sid: randomUUID(), sv: 0 })).dados, { ok: true });
    await darPlantao(medico.id);
    limparMemoriaDoPortao();
    const valendo = await chamar({ email: medico.email, sid, sv: 0, pedidos: 7, sistema: "tabela", metodo: "GET", caminho: "/tabela/?tab=destino&local=Rua%20X" });
    assert.deepEqual(valendo, { status: 200, dados: { ok: true } });
    assert.deepEqual((await chamar({ email: "ninguem@acessos-teste.invalid", sid, sv: 0 })).dados, { ok: false, motivo: "sem_conta" });

    // O registro sai "depois da resposta" (fora de pedido, roda já): espera assentar.
    let sessao: { origin: string } | undefined;
    for (let tentativa = 0; tentativa < 20 && !sessao; tentativa += 1) {
        [sessao] = await getDb().select({ origin: schema.authSessions.origin }).from(schema.authSessions).where(eq(schema.authSessions.id, sid));
        if (!sessao) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(sessao?.origin, "portal_cookie");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const [presenca] = await getDb().select().from(schema.authSessionActivity).where(eq(schema.authSessionActivity.sessionId, sid));
    assert.equal(presenca.requests, 7, "o porteiro soma os pedidos do minuto");
    const eventos = await getDb().select().from(schema.authSessionEvents).where(eq(schema.authSessionEvents.sessionId, sid));
    const pagina = eventos.find((e) => e.kind === "pagina");
    assert.equal(pagina?.path, "/tabela/", "caminho sem a query string (endereço de ocorrência)");
    assert.equal((pagina?.details as { sistema?: string }).sistema, "tabela");

    // "Encerrar sessões" sobe a versão: o mesmo login do portal passa a ser recusado.
    await acoes.agirNaConta("encerrar_sessoes", medico.id, admin.id, "teste da tabela");
    assert.deepEqual((await chamar({ email: medico.email, sid, sv: 0 })).dados, { ok: false, motivo: "versao" });
    assert.deepEqual((await chamar({ email: medico.email, sid: randomUUID(), sv: 1 })).dados, { ok: true }, "login novo, com a versão nova, vale");
    await acoes.agirNaConta("suspender", medico.id, admin.id, "teste da tabela");
    assert.deepEqual((await chamar({ email: medico.email, sid: randomUUID(), sv: 1 })).dados, { ok: false, motivo: "inativa" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const recusas = await getDb().select().from(schema.authSessionEvents)
        .where(and(eq(schema.authSessionEvents.userId, medico.id), eq(schema.authSessionEvents.kind, "portal_recusado")));
    assert.ok(recusas.length >= 2, "cada recusa fica na linha do tempo da conta");
});

test("monitor (banco): turnos das ocupações e rede do plantão (faixa /24 com 3+ plantonistas no PC)", { skip }, async () => {
    const { getDb, schema, gravacao, relatorio } = await modulos();
    gravacao.limparMemoriaDoMonitor();
    const db = getDb();
    const marca = randomUUID().slice(0, 6).toUpperCase();
    const [posto] = await db.insert(schema.regulationPosts).values({ code: `T${marca}`, label: `Teste ${marca}` }).returning({ id: schema.regulationPosts.id });
    const medicos: string[] = [];
    const contas: Array<{ id: string; email: string }> = [];
    try {
        // Três no PC, cada um saindo por um IP do pool da Central (mesma /24), e um
        // quarto no celular — celular não forma rede do plantão.
        for (let i = 0; i < 4; i += 1) {
            const [medico] = await db.insert(schema.doctors).values({ fullName: `Medico Teste ${marca} ${i}`, normalizedName: `medico teste ${marca.toLowerCase()} ${i}` }).returning({ id: schema.doctors.id });
            medicos.push(medico.id);
            const conta = await criarConta("doctor");
            await db.update(schema.users).set({ doctorId: medico.id }).where(eq(schema.users.id, conta.id));
            contas.push(conta);
            await db.insert(schema.regulationOccupancies).values({
                doctorId: medico.id,
                continuityGroupId: randomUUID(),
                postId: posto.id,
                startedAt: new Date(Date.now() - 3 * 3_600_000),
                ramalLabel: `13${i}${i}`,
                source: "manual",
            });
            const sessaoId = randomUUID();
            const contexto = i < 3 ? ctx(`192.0.2.${20 + i}`, WINDOWS) : ctx("192.0.2.23", ANDROID_DB);
            for (let minuto = 0; minuto < 20; minuto += 5) {
                await gravacao.registrarAcesso({ sessaoId, userId: conta.id, versao: 0, contexto, agora: new Date(Date.now() - (60 - minuto) * 60_000) });
            }
        }
        const dados = await relatorio.carregarMonitor({ desde: new Date(Date.now() - 6 * 3_600_000), userId: contas[0].id });
        assert.equal(dados.redes.get("192.0.2.20")?.plantonistas, 3, "3 plantonistas no PC na faixa; o do celular não conta");
        const analise = dados.analises.find((a) => a.conta.userId === contas[0].id)!;
        assert.equal(analise.plantao?.turnos, 1);
        assert.equal(analise.plantao?.agora?.rotulo, "Regulação 1300", "turno aberto (sem saída) = de plantão agora");
        assert.equal(analise.lugares[0].plantao, true);

        // Ocupação esquecida aberta há 3 dias: vale 24 h, não "de plantão agora".
        await db.insert(schema.regulationOccupancies).values({
            doctorId: medicos[1],
            continuityGroupId: randomUUID(),
            postId: posto.id,
            startedAt: new Date(Date.now() - 72 * 3_600_000),
            ramalLabel: "1399",
            source: "manual",
        });
        const antigo = await relatorio.carregarMonitor({ desde: new Date(Date.now() - 96 * 3_600_000), userId: contas[1].id });
        const turnos = antigo.plantoes.get(contas[1].id) ?? [];
        const esquecido = turnos.find((t) => t.rotulo === "Regulação 1399")!;
        assert.equal(Math.round((esquecido.fim.getTime() - esquecido.inicio.getTime()) / 3_600_000), 24);
    } finally {
        await db.delete(schema.regulationOccupancies).where(eq(schema.regulationOccupancies.postId, posto.id));
        await db.delete(schema.regulationPosts).where(eq(schema.regulationPosts.id, posto.id));
        for (const conta of contas) await db.update(schema.users).set({ doctorId: null }).where(eq(schema.users.id, conta.id));
        if (medicos.length) await db.delete(schema.doctors).where(inArray(schema.doctors.id, medicos));
    }
});
