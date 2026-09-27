/* Leitura do monitor de acessos: carrega sessões, presença e eventos do
   período, junta o que se sabe de cada rede e roda modules/acessos/analise.ts
   por conta. Usado pela tela /admin/acessos e pelos avisos do Telegram. */
import { and, asc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { authNetworkInfo, authSessionActivity, authSessionEvents, authSessions, doctors, userRoles, users } from "@/db/schema";
import type { GeoAcesso } from "@/lib/acessos/contexto";
import {
    analisarConta,
    type AnaliseDaConta,
    type ContaMonitorada,
    type EventoDeSessao,
    type InfoDeRede,
    type JanelaDeAtividade,
    type SessaoMonitorada,
} from "@/modules/acessos/analise";
import { chaveDeRede, provedorPorDnsReverso } from "@/modules/acessos/rede";

export const PERIODOS = {
    "24h": { rotulo: "últimas 24 horas", ms: 24 * 3_600_000 },
    "7d": { rotulo: "últimos 7 dias", ms: 7 * 24 * 3_600_000 },
    "30d": { rotulo: "últimos 30 dias", ms: 30 * 24 * 3_600_000 },
} as const;
export type ChavePeriodo = keyof typeof PERIODOS;

export function lerPeriodo(valor: string | string[] | undefined): ChavePeriodo {
    return typeof valor === "string" && valor in PERIODOS ? (valor as ChavePeriodo) : "7d";
}

export interface DadosDoMonitor {
    geradoEm: Date;
    desde: Date;
    ate: Date;
    analises: AnaliseDaConta[];
    redes: Map<string, InfoDeRede>;
    /** Por conta, o bruto que a análise usou — a tela de detalhe monta a linha do tempo com ele. */
    brutos: Map<string, { sessoes: SessaoMonitorada[]; janelas: JanelaDeAtividade[]; eventos: EventoDeSessao[] }>;
}

const comoGeo = (valor: unknown): GeoAcesso => (valor && typeof valor === "object" ? (valor as GeoAcesso) : {});
const comoObjeto = (valor: unknown): Record<string, unknown> => (valor && typeof valor === "object" ? (valor as Record<string, unknown>) : {});

async function carregarRedes(ips: Set<string>, desde: Date, ate: Date): Promise<Map<string, InfoDeRede>> {
    const db = getDb();
    const lista = [...ips];
    const infos: Array<typeof authNetworkInfo.$inferSelect> = [];
    for (let i = 0; i < lista.length; i += 2_000) {
        infos.push(...await db.select().from(authNetworkInfo).where(inArray(authNetworkInfo.ip, lista.slice(i, i + 2_000))));
    }
    // Quantas contas passaram por cada rede no período — todas as contas, não só a analisada.
    const pares = await db
        .selectDistinct({ ip: authSessionActivity.ip, userId: authSessionActivity.userId })
        .from(authSessionActivity)
        .where(and(gte(authSessionActivity.windowStart, desde), lte(authSessionActivity.windowStart, ate)));

    const contasPorRede = new Map<string, Set<string>>();
    for (const par of pares) {
        const chave = chaveDeRede(par.ip);
        const conjunto = contasPorRede.get(chave) ?? new Set<string>();
        conjunto.add(par.userId);
        contasPorRede.set(chave, conjunto);
    }
    const redes = new Map<string, InfoDeRede & { geoEm: number }>();
    for (const info of infos) {
        const chave = chaveDeRede(info.ip);
        const geo = comoGeo(info.geo);
        const geoEm = info.geoSeenAt?.getTime() ?? 0;
        const provedor = info.reverseDns ? provedorPorDnsReverso(info.reverseDns) : info.provider ? { nome: info.provider, servidor: false } : null;
        const atual = redes.get(chave);
        if (!atual) {
            redes.set(chave, { geo, geoEm, provedor, contas: contasPorRede.get(chave)?.size ?? 1 });
            continue;
        }
        if (geoEm > atual.geoEm && Object.keys(geo).length > 0) {
            atual.geo = geo;
            atual.geoEm = geoEm;
        }
        if (!atual.provedor && provedor) atual.provedor = provedor;
    }
    for (const [chave, contas] of contasPorRede) {
        if (!redes.has(chave)) redes.set(chave, { geo: {}, geoEm: 0, provedor: null, contas: contas.size });
    }
    return new Map([...redes].map(([chave, info]) => [chave, { geo: info.geo, provedor: info.provedor, contas: info.contas }]));
}

export async function carregarMonitor(opcoes: { desde: Date; ate?: Date; userId?: string }): Promise<DadosDoMonitor> {
    const db = getDb();
    const geradoEm = new Date();
    const ate = opcoes.ate ?? geradoEm;
    const { desde, userId } = opcoes;

    const [linhasSessoes, linhasJanelas, linhasEventos] = await Promise.all([
        db.select().from(authSessions).where(and(
            or(gte(authSessions.lastSeenAt, desde), gte(authSessions.createdAt, desde), gte(authSessions.revokedAt, desde)),
            lte(authSessions.createdAt, ate),
            userId ? eq(authSessions.userId, userId) : undefined,
        )),
        db.select().from(authSessionActivity).where(and(
            gte(authSessionActivity.windowStart, new Date(desde.getTime() - 5 * 60_000)),
            lte(authSessionActivity.windowStart, ate),
            userId ? eq(authSessionActivity.userId, userId) : undefined,
        )),
        db.select().from(authSessionEvents).where(and(
            gte(authSessionEvents.occurredAt, desde),
            lte(authSessionEvents.occurredAt, ate),
            userId ? eq(authSessionEvents.userId, userId) : sql`${authSessionEvents.userId} is not null`,
        )).orderBy(asc(authSessionEvents.occurredAt)),
    ]);

    const idsDeConta = new Set<string>([
        ...linhasSessoes.map((s) => s.userId),
        ...linhasJanelas.map((j) => j.userId),
        ...linhasEventos.map((e) => e.userId).filter((id): id is string => Boolean(id)),
    ]);
    if (userId) idsDeConta.add(userId);
    const ids = [...idsDeConta];

    const [contas, papeis] = ids.length === 0 ? [[], []] : await Promise.all([
        db.select({
            id: users.id,
            email: users.email,
            isActive: users.isActive,
            sessionVersion: users.sessionVersion,
            fullName: doctors.fullName,
            displayName: doctors.displayName,
        }).from(users).leftJoin(doctors, eq(doctors.id, users.doctorId)).where(inArray(users.id, ids)),
        db.select({ userId: userRoles.userId, role: userRoles.role }).from(userRoles).where(inArray(userRoles.userId, ids)),
    ]);

    const ips = new Set<string>([
        ...linhasJanelas.map((j) => j.ip),
        ...linhasSessoes.map((s) => s.createdIp).filter((ip): ip is string => Boolean(ip)),
        ...linhasEventos.map((e) => e.ip).filter((ip): ip is string => Boolean(ip)),
    ]);
    const redes = await carregarRedes(ips, desde, ate);

    const papeisPorConta = new Map<string, string[]>();
    for (const papel of papeis) papeisPorConta.set(papel.userId, [...(papeisPorConta.get(papel.userId) ?? []), papel.role]);

    const brutos: DadosDoMonitor["brutos"] = new Map();
    const pegar = (id: string) => {
        let bruto = brutos.get(id);
        if (!bruto) {
            bruto = { sessoes: [], janelas: [], eventos: [] };
            brutos.set(id, bruto);
        }
        return bruto;
    };
    for (const s of linhasSessoes) {
        pegar(s.userId).sessoes.push({
            id: s.id,
            origem: s.origin,
            versao: s.sessionVersion,
            criadaEm: s.createdAt,
            ipCriacao: s.createdIp,
            userAgent: s.createdUserAgent,
            geoCriacao: comoGeo(s.createdGeo),
            vistaEm: s.lastSeenAt,
            ultimoIp: s.lastIp,
            encerradaEm: s.revokedAt,
            motivoEncerramento: s.revokedReason,
        });
    }
    for (const j of linhasJanelas) {
        pegar(j.userId).janelas.push({
            sessaoId: j.sessionId,
            ip: j.ip,
            inicio: j.windowStart,
            primeira: j.firstAt,
            ultima: j.lastAt,
            pedidos: j.requests,
            visiveis: j.visibleRequests,
            emUso: j.activeRequests,
        });
    }
    for (const e of linhasEventos) {
        if (!e.userId) continue;
        pegar(e.userId).eventos.push({
            em: e.occurredAt,
            tipo: e.kind,
            sessaoId: e.sessionId,
            metodo: e.method,
            caminho: e.path,
            ip: e.ip,
            userAgent: e.userAgent,
            geo: comoGeo(e.geo),
            detalhes: comoObjeto(e.details),
        });
    }

    // Sessão com presença no período mas criada antes dele: entra também (a tela precisa do aparelho dela).
    const semSessao = new Map<string, Set<string>>();
    for (const [conta, bruto] of brutos) {
        const conhecidas = new Set(bruto.sessoes.map((s) => s.id));
        for (const j of bruto.janelas) {
            if (!conhecidas.has(j.sessaoId)) semSessao.set(conta, (semSessao.get(conta) ?? new Set()).add(j.sessaoId));
        }
    }
    const faltantes = [...semSessao.values()].flatMap((conjunto) => [...conjunto]);
    if (faltantes.length > 0) {
        for (const s of await db.select().from(authSessions).where(inArray(authSessions.id, faltantes))) {
            pegar(s.userId).sessoes.push({
                id: s.id,
                origem: s.origin,
                versao: s.sessionVersion,
                criadaEm: s.createdAt,
                ipCriacao: s.createdIp,
                userAgent: s.createdUserAgent,
                geoCriacao: comoGeo(s.createdGeo),
                vistaEm: s.lastSeenAt,
                ultimoIp: s.lastIp,
                encerradaEm: s.revokedAt,
                motivoEncerramento: s.revokedReason,
            });
        }
    }

    const analises: AnaliseDaConta[] = [];
    for (const conta of contas) {
        const bruto = pegar(conta.id);
        const monitorada: ContaMonitorada = {
            userId: conta.id,
            email: conta.email,
            nome: conta.displayName?.trim() || conta.fullName || null,
            papeis: papeisPorConta.get(conta.id) ?? [],
            ativa: conta.isActive,
            versaoSessao: conta.sessionVersion,
        };
        analises.push(analisarConta({ conta: monitorada, ...bruto, redes, agora: geradoEm }));
    }
    analises.sort((a, b) => b.pontuacao - a.pontuacao || (b.ultimaAtividade?.getTime() ?? 0) - (a.ultimaAtividade?.getTime() ?? 0));
    return { geradoEm, desde, ate, analises, redes, brutos };
}
