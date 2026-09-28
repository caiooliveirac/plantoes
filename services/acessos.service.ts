/* ==========================================================================
   Gravação do monitor de acessos (docs/monitor-acessos.md).

   Quem chama: lib/auth/server.ts depois de cada pedido autenticado (via
   after(), fora do tempo de resposta) e as rotas de entrada/saída. Tudo aqui é
   melhor esforço: erro de banco vira uma linha de log — nunca derruba o login
   nem o quadro. Isso também cobre o deploy antes da migration 0046: sem as
   tabelas, o app segue igual e só não registra.

   Escrita contida: a presença (auth_session_activity) e o "visto por último"
   da sessão vão ao banco no máximo uma vez por minuto por sessão × IP; o que
   chega no meio do minuto soma em memória e sai na gravação seguinte. O web
   roda num processo PM2 só (ecosystem.config.cjs), então a memória basta.
   ========================================================================== */
import { promises as dns } from "node:dns";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { authNetworkInfo, authSessionActivity, authSessionEvents, authSessions, users } from "@/db/schema";
import type { ContextoRequisicao, GeoAcesso } from "@/lib/acessos/contexto";
import { JANELA_MS } from "@/modules/acessos/analise";
import { provedorPorDnsReverso } from "@/modules/acessos/rede";
import { classificarPedido, mascararCaminho } from "@/modules/acessos/registro";

/** `portal_cookie` = o próprio login do portal (mnrs_sso) usado na Tabela e em
    outros sistemas sem conta própria — o porteiro reporta (api/servicos/portal/acesso). */
export type OrigemSessao = "login" | "portal" | "escala" | "cadastro" | "anterior" | "portal_cookie";

const GRAVAR_A_CADA_MS = 60_000;
const GEO_A_CADA_MS = 60 * 60_000;
const DNS_REVERSO_A_CADA_MS = 7 * 24 * 60 * 60_000;
const DNS_TIMEOUT_MS = 1_500;

let ultimoErroLogado = 0;
function logarErro(onde: string, erro: unknown) {
    const agora = Date.now();
    if (agora - ultimoErroLogado < 60_000) return;
    ultimoErroLogado = agora;
    console.error(`[acessos] ${onde}: ${erro instanceof Error ? erro.message : String(erro)}`);
}

async function melhorEsforco(onde: string, tarefa: () => Promise<void>) {
    try {
        await tarefa();
    } catch (erro) {
        logarErro(onde, erro);
    }
}

const temGeo = (geo: GeoAcesso) => Object.keys(geo).length > 0;

// ── Estado em memória (um processo) ──────────────────────────────────────────
const sessoesGarantidas = new Set<string>();
const ultimaPagina = new Map<string, string>();
const sessaoGravadaEm = new Map<string, number>();
const redesDaSessao = new Map<string, Set<string>>();
const redeAtualizadaEm = new Map<string, number>();

interface Pendente {
    sessaoId: string;
    userId: string;
    ip: string;
    janela: Date;
    primeira: Date;
    ultima: Date;
    pedidos: number;
    visiveis: number;
    emUso: number;
    gravadaEm: number | null;
}
const pendentes = new Map<string, Pendente>();

function podarMemoria(agora: number) {
    if (pendentes.size > 5_000) {
        for (const [chave, p] of pendentes) if (agora - p.janela.getTime() > 3 * JANELA_MS) pendentes.delete(chave);
    }
    for (const mapa of [sessaoGravadaEm, redeAtualizadaEm]) {
        if (mapa.size > 5_000) for (const [chave, em] of mapa) if (agora - em > GEO_A_CADA_MS) mapa.delete(chave);
    }
    if (sessoesGarantidas.size > 20_000) sessoesGarantidas.clear();
    if (ultimaPagina.size > 20_000) ultimaPagina.clear();
    if (redesDaSessao.size > 20_000) redesDaSessao.clear();
}

/** Só para os testes. */
export function limparMemoriaDoMonitor() {
    for (const colecao of [sessoesGarantidas, ultimaPagina, sessaoGravadaEm, redesDaSessao, redeAtualizadaEm, pendentes]) colecao.clear();
}

// ── Rede: localização e provedor ─────────────────────────────────────────────
async function consultarDnsReverso(ip: string) {
    let timer: NodeJS.Timeout | undefined;
    try {
        const nomes = await Promise.race([
            dns.reverse(ip),
            new Promise<string[]>((resolve) => {
                timer = setTimeout(() => resolve([]), DNS_TIMEOUT_MS);
            }),
        ]);
        return nomes[0] ?? null;
    } catch {
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function atualizarRede(ip: string, geo: GeoAcesso, agora: Date) {
    const ultima = redeAtualizadaEm.get(ip);
    if (ultima && agora.getTime() - ultima < GEO_A_CADA_MS) return;
    redeAtualizadaEm.set(ip, agora.getTime());
    const db = getDb();
    const [atual] = await db
        .select({ reverseLookedUpAt: authNetworkInfo.reverseLookedUpAt })
        .from(authNetworkInfo)
        .where(eq(authNetworkInfo.ip, ip))
        .limit(1);
    const precisaDns = !atual?.reverseLookedUpAt || agora.getTime() - atual.reverseLookedUpAt.getTime() > DNS_REVERSO_A_CADA_MS;
    if (atual && !precisaDns && !temGeo(geo)) return;
    const ptr = precisaDns ? await consultarDnsReverso(ip) : null;
    const provedor = provedorPorDnsReverso(ptr)?.nome ?? null;
    const novidades = {
        ...(temGeo(geo) ? { geo, geoSeenAt: agora } : {}),
        ...(precisaDns ? { reverseDns: ptr, provider: provedor, reverseLookedUpAt: agora } : {}),
    };
    const insercao = getDb().insert(authNetworkInfo).values({ ip, geo: {}, ...novidades });
    await (Object.keys(novidades).length > 0
        ? insercao.onConflictDoUpdate({ target: authNetworkInfo.ip, set: novidades })
        : insercao.onConflictDoNothing());
}

// ── Eventos ──────────────────────────────────────────────────────────────────
export interface NovoEvento {
    tipo: string;
    sessaoId?: string | null;
    userId?: string | null;
    contexto?: ContextoRequisicao | null;
    detalhes?: Record<string, unknown>;
    em?: Date;
    /** Aparelho (cookie plantoes_aparelho), quando o evento é da presença na Mesa. */
    aparelhoId?: string | null;
}

async function inserirEvento(evento: NovoEvento) {
    const contexto = evento.contexto;
    await getDb().insert(authSessionEvents).values({
        occurredAt: evento.em ?? new Date(),
        sessionId: evento.sessaoId ?? null,
        userId: evento.userId ?? null,
        kind: evento.tipo,
        method: contexto?.metodo ?? null,
        path: contexto?.caminho ? mascararCaminho(contexto.caminho) : null,
        ip: contexto?.ip ?? null,
        userAgent: contexto?.userAgent ?? null,
        geo: contexto?.geo ?? {},
        details: evento.detalhes ?? {},
        ...(evento.aparelhoId ? { deviceId: evento.aparelhoId } : {}),
    });
}

/** Senha digitada (login daqui ou portal/escala via verificar-escala). Só registra conta que existe. Nunca lança. */
export async function registrarTentativaDeSenha(tentativa: {
    email: string;
    ok: boolean;
    via: "login" | "portal";
    contexto: ContextoRequisicao;
    userId?: string | null;
    motivo?: string;
}) {
    await melhorEsforco("tentativa de senha", async () => {
        let userId = tentativa.userId ?? null;
        if (!userId) {
            const [conta] = await getDb()
                .select({ id: users.id })
                .from(users)
                .where(eq(users.email, tentativa.email.trim().toLowerCase()))
                .limit(1);
            userId = conta?.id ?? null;
        }
        if (!userId) return;
        await inserirEvento({
            tipo: `senha_${tentativa.via}_${tentativa.ok ? "ok" : "falhou"}`,
            userId,
            contexto: tentativa.contexto,
            detalhes: tentativa.motivo ? { motivo: tentativa.motivo } : {},
        });
        if (tentativa.contexto.ip) await atualizarRede(tentativa.contexto.ip, tentativa.contexto.geo, new Date());
    });
}

/** Evento avulso (saída, ação do admin, SSO recusado). Nunca lança. */
export async function registrarEvento(evento: NovoEvento) {
    await melhorEsforco(`evento ${evento.tipo}`, async () => {
        await inserirEvento(evento);
        if (evento.contexto?.ip) await atualizarRede(evento.contexto.ip, evento.contexto.geo, evento.em ?? new Date());
    });
}

// ── Sessões ──────────────────────────────────────────────────────────────────
export interface NovaSessao {
    sessaoId: string;
    userId: string;
    origem: OrigemSessao;
    versao: number;
    contexto: ContextoRequisicao | null;
    detalhes?: Record<string, unknown>;
}

/** Login, SSO ou cadastro acabou de emitir o cookie. Chamada ANTES de responder
    (duas inserções rápidas): o navegador segue o redirecionamento na hora e o
    próximo pedido já precisa achar a sessão com a origem certa. Localização e
    DNS reverso ficam para depois (atualizarRedeDoContexto). Nunca lança. */
export async function registrarNovaSessao(nova: NovaSessao) {
    const agora = new Date();
    await melhorEsforco("nova sessão", async () => {
        const contexto = nova.contexto;
        await getDb().insert(authSessions).values({
            id: nova.sessaoId,
            userId: nova.userId,
            origin: nova.origem,
            sessionVersion: nova.versao,
            createdAt: agora,
            createdIp: contexto?.ip ?? null,
            createdUserAgent: contexto?.userAgent ?? null,
            createdGeo: contexto?.geo ?? {},
            lastSeenAt: agora,
            lastIp: contexto?.ip ?? null,
        }).onConflictDoNothing();
        sessoesGarantidas.add(nova.sessaoId);
        if (contexto?.ip) redesDaSessao.set(nova.sessaoId, new Set([contexto.ip]));
        await inserirEvento({
            tipo: "sessao_criada",
            sessaoId: nova.sessaoId,
            userId: nova.userId,
            contexto,
            detalhes: { origem: nova.origem, ...nova.detalhes },
            em: agora,
        });
    });
}

/** Localização e provedor do IP de um pedido — pode esperar o DNS reverso (até 1,5 s). Nunca lança. */
export async function atualizarRedeDoContexto(contexto: ContextoRequisicao | null) {
    if (!contexto?.ip) return;
    const ip = contexto.ip;
    await melhorEsforco("rede", () => atualizarRede(ip, contexto.geo, new Date()));
}

/** Troca de senha reemitiu o cookie: a sessão continua, com a versão nova. */
export async function renovarVersaoDaSessao(sessaoId: string, userId: string, versao: number, contexto: ContextoRequisicao | null) {
    await melhorEsforco("versão da sessão", async () => {
        await getDb().update(authSessions).set({ sessionVersion: versao }).where(eq(authSessions.id, sessaoId));
        await inserirEvento({ tipo: "senha_trocada", sessaoId, userId, contexto });
    });
}

/** A sessão foi encerrada (pelo admin ou por "Sair")? Sem tabela ou sem linha = não. */
export async function sessaoFoiEncerrada(sessaoId: string) {
    try {
        const [linha] = await getDb()
            .select({ revokedAt: authSessions.revokedAt })
            .from(authSessions)
            .where(eq(authSessions.id, sessaoId))
            .limit(1);
        return Boolean(linha?.revokedAt);
    } catch (erro) {
        logarErro("checagem de sessão encerrada", erro);
        return false;
    }
}

export async function encerrarSessao(sessaoId: string, opcoes: { por: string | null; motivo: string; userId?: string }) {
    const [linha] = await getDb()
        .update(authSessions)
        .set({ revokedAt: new Date(), revokedBy: opcoes.por, revokedReason: opcoes.motivo })
        .where(and(eq(authSessions.id, sessaoId), isNull(authSessions.revokedAt), ...(opcoes.userId ? [eq(authSessions.userId, opcoes.userId)] : [])))
        .returning({ id: authSessions.id, userId: authSessions.userId });
    return linha ?? null;
}

/** "Sair": marca a sessão como encerrada e registra. Nunca lança. */
export async function registrarSaida(sessaoId: string, userId: string, contexto: ContextoRequisicao | null) {
    await melhorEsforco("saída", async () => {
        await getDb()
            .update(authSessions)
            .set({ revokedAt: new Date(), revokedReason: "saiu" })
            .where(and(eq(authSessions.id, sessaoId), isNull(authSessions.revokedAt)));
        await inserirEvento({ tipo: "saida", sessaoId, userId, contexto });
    });
}

// ── Retenção ─────────────────────────────────────────────────────────────────
/** Dias que o registro do monitor fica guardado (docs/monitor-acessos.md). */
export const RETENCAO_DIAS = 180;

/** Apaga o que passou da retenção. Sessão sem uso há 180 dias leva junto os eventos e a presença dela (cascata). */
export async function podarRegistrosAntigos(agora = new Date(), dias = RETENCAO_DIAS) {
    // Em sql`` cru o postgres.js não serializa Date: vai como texto ISO.
    const limite = new Date(agora.getTime() - dias * 24 * 60 * 60_000).toISOString();
    const db = getDb();
    const eventos = await db.execute(sql`delete from ${authSessionEvents} where ${authSessionEvents.occurredAt} < ${limite}`);
    const presenca = await db.execute(sql`delete from ${authSessionActivity} where ${authSessionActivity.windowStart} < ${limite}`);
    const sessoes = await db.execute(sql`
        delete from ${authSessions}
        where coalesce(${authSessions.lastSeenAt}, ${authSessions.createdAt}) < ${limite}
    `);
    const redes = await db.execute(sql`
        delete from ${authNetworkInfo}
        where coalesce(${authNetworkInfo.geoSeenAt}, ${authNetworkInfo.reverseLookedUpAt}, ${limite}) < ${limite}
          and not exists (select 1 from ${authSessionActivity} a where a.ip = ${authNetworkInfo.ip})
    `);
    const contar = (resultado: unknown) => (resultado as { count?: number }).count ?? 0;
    return { eventos: contar(eventos), presenca: contar(presenca), sessoes: contar(sessoes), redes: contar(redes) };
}

// ── Acesso autenticado (cada pedido) ─────────────────────────────────────────
export interface AcessoAutenticado {
    sessaoId: string;
    userId: string;
    /** `sv` do cookie — usado se a sessão ainda não existir na tabela (cookie de antes do monitor). */
    versao: number;
    contexto: ContextoRequisicao;
    agora?: Date;
    /** Quantos pedidos este registro representa (o porteiro soma por minuto). Padrão 1. */
    pedidos?: number;
    /** Origem se a sessão ainda não existir: "anterior" (cookie daqui antigo) ou "portal_cookie". */
    origemSeNova?: OrigemSessao;
    /** Sistema do portal (tabela, triagem…) — vai nos detalhes dos eventos. */
    sistema?: string;
}

function acumular(p: AcessoAutenticado, ip: string, agora: Date, visivel: boolean, emUso: boolean) {
    const janela = new Date(Math.floor(agora.getTime() / JANELA_MS) * JANELA_MS);
    const chave = `${p.sessaoId}|${ip}|${janela.getTime()}`;
    let pendente = pendentes.get(chave);
    if (!pendente) {
        pendente = { sessaoId: p.sessaoId, userId: p.userId, ip, janela, primeira: agora, ultima: agora, pedidos: 0, visiveis: 0, emUso: 0, gravadaEm: null };
        pendentes.set(chave, pendente);
    }
    pendente.pedidos += Math.max(1, Math.min(p.pedidos ?? 1, 100_000));
    if (visivel) pendente.visiveis += 1;
    if (emUso) pendente.emUso += 1;
    pendente.ultima = agora;
    if (pendente.gravadaEm !== null && agora.getTime() - pendente.gravadaEm < GRAVAR_A_CADA_MS) return null;
    const lote = { ...pendente };
    pendente.pedidos = 0;
    pendente.visiveis = 0;
    pendente.emUso = 0;
    pendente.gravadaEm = agora.getTime();
    return lote;
}

async function garantirSessao(p: AcessoAutenticado, agora: Date) {
    if (sessoesGarantidas.has(p.sessaoId)) return;
    sessoesGarantidas.add(p.sessaoId);
    // Cookie de antes do monitor (ou emitido noutro ambiente) ou login do portal
    // visto pela primeira vez: a sessão nasce aqui, com o que se sabe agora.
    const origem = p.origemSeNova ?? "anterior";
    const [criada] = await getDb().insert(authSessions).values({
        id: p.sessaoId,
        userId: p.userId,
        origin: origem,
        sessionVersion: p.versao,
        createdAt: agora,
        createdIp: p.contexto.ip,
        createdUserAgent: p.contexto.userAgent,
        createdGeo: p.contexto.geo,
        lastSeenAt: agora,
        lastIp: p.contexto.ip,
    }).onConflictDoNothing().returning({ id: authSessions.id });
    if (criada) {
        await inserirEvento({
            tipo: "sessao_criada",
            sessaoId: p.sessaoId,
            userId: p.userId,
            contexto: p.contexto,
            detalhes: origem === "anterior"
                ? { origem, observacao: "login anterior ao monitor; primeira vez vista agora" }
                : { origem, ...(p.sistema ? { sistema: p.sistema } : {}) },
            em: agora,
        });
    }
}

/** Rede que a sessão ainda não tinha usado? Na primeira vez que o processo vê a sessão, pergunta ao banco. */
async function redeNovaNaSessao(sessaoId: string, ip: string) {
    let vistas = redesDaSessao.get(sessaoId);
    if (vistas?.has(ip)) return null;
    if (!vistas) {
        const linhas = await getDb().execute<{ ip: string | null }>(sql`
            select created_ip as ip from ${authSessions} where ${authSessions.id} = ${sessaoId}
            union
            select distinct ip from ${authSessionActivity} where ${authSessionActivity.sessionId} = ${sessaoId}
        `) as unknown as Array<{ ip: string | null }>;
        vistas = new Set(linhas.map((linha) => linha.ip).filter((valor): valor is string => Boolean(valor)));
        redesDaSessao.set(sessaoId, vistas);
        if (vistas.has(ip)) return null;
    }
    const anteriores = [...vistas];
    vistas.add(ip);
    return anteriores.length > 0 ? anteriores : null;
}

/** Registra um pedido autenticado. Chamado via after(); nunca lança. */
export async function registrarAcesso(p: AcessoAutenticado) {
    const agora = p.agora ?? new Date();
    podarMemoria(agora.getTime());
    const classificacao = classificarPedido(p.contexto, ultimaPagina.get(p.sessaoId) ?? null);
    if (classificacao.evento === "pagina" && p.contexto.caminho) ultimaPagina.set(p.sessaoId, p.contexto.caminho);
    const ip = p.contexto.ip;
    const lote = ip ? acumular(p, ip, agora, classificacao.visivel, classificacao.emUso) : null;

    await melhorEsforco("acesso", async () => {
        await garantirSessao(p, agora);
        const db = getDb();

        if (ip) {
            const anteriores = await redeNovaNaSessao(p.sessaoId, ip);
            if (anteriores) {
                await inserirEvento({
                    tipo: "nova_rede",
                    sessaoId: p.sessaoId,
                    userId: p.userId,
                    contexto: p.contexto,
                    detalhes: { redesAnteriores: anteriores.slice(-5) },
                    em: agora,
                });
            }
        }

        if (lote) {
            await db.insert(authSessionActivity).values({
                sessionId: lote.sessaoId,
                userId: lote.userId,
                ip: lote.ip,
                windowStart: lote.janela,
                firstAt: lote.primeira,
                lastAt: lote.ultima,
                requests: lote.pedidos,
                visibleRequests: lote.visiveis,
                activeRequests: lote.emUso,
            }).onConflictDoUpdate({
                target: [authSessionActivity.sessionId, authSessionActivity.ip, authSessionActivity.windowStart],
                set: {
                    firstAt: sql`least(${authSessionActivity.firstAt}, excluded.first_at)`,
                    lastAt: sql`greatest(${authSessionActivity.lastAt}, excluded.last_at)`,
                    requests: sql`${authSessionActivity.requests} + excluded.requests`,
                    visibleRequests: sql`${authSessionActivity.visibleRequests} + excluded.visible_requests`,
                    activeRequests: sql`${authSessionActivity.activeRequests} + excluded.active_requests`,
                },
            });
        }

        const gravadaEm = sessaoGravadaEm.get(p.sessaoId);
        if (!gravadaEm || agora.getTime() - gravadaEm >= GRAVAR_A_CADA_MS) {
            sessaoGravadaEm.set(p.sessaoId, agora.getTime());
            await db.update(authSessions).set({ lastSeenAt: agora, lastIp: ip }).where(eq(authSessions.id, p.sessaoId));
        }

        if (classificacao.evento) {
            await inserirEvento({
                tipo: classificacao.evento,
                sessaoId: p.sessaoId,
                userId: p.userId,
                contexto: p.contexto,
                em: agora,
                ...(p.sistema ? { detalhes: { sistema: p.sistema } } : {}),
            });
        }

        if (ip) await atualizarRede(ip, p.contexto.geo, agora);
    });
}
