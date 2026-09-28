/* Redes do monitor de acessos (docs/monitor-acessos.md, "Redes"): carrega a
   presença do período com o turno do dono de cada janela (mesma folga do
   portão: 30 min antes, 1 h depois), os barrados e o que se sabe de cada IP,
   e roda modules/acessos/redes.ts. Rótulos de rede (tabela
   auth_network_labels, migration 0048): `central` garante a faixa no portão
   de turno; os outros só nomeiam. */
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
    auditLogs,
    authNetworkInfo,
    authNetworkLabels,
    authSessionActivity,
    authSessionEvents,
    authSessions,
    interventionOccupancies,
    regulationOccupancies,
    userRoles,
    users,
} from "@/db/schema";
import type { GeoAcesso } from "@/lib/acessos/contexto";
import { descreverAparelho } from "@/modules/acessos/aparelho";
import { analisarRedes, type InfoDoIp, type RedeAnalisada, type RotuloDeRede, type TipoDeRotulo } from "@/modules/acessos/redes";
import { carregarPlantoes } from "@/services/acessos-relatorio.service";

export async function listarRotulosDeRede(): Promise<RotuloDeRede[]> {
    const linhas = await getDb().select().from(authNetworkLabels);
    return linhas.map((l) => ({ faixa: l.faixa, kind: l.kind, label: l.label, note: l.note }));
}

export interface ContaResumida {
    email: string;
    papeis: string[];
    temMedico: boolean;
}

export interface DadosDeRedes {
    geradoEm: Date;
    desde: Date;
    redes: RedeAnalisada[];
    contas: Map<string, ContaResumida>;
}

export async function carregarRedes({ desde, ate = new Date() }: { desde: Date; ate?: Date }): Promise<DadosDeRedes> {
    const db = getDb();
    const de = desde.toISOString();
    const ateIso = ate.toISOString();
    const fimDoTurno = sql.raw("coalesce(actual_ended_at, ended_at, started_at + interval '24 hours')");
    const janelas = await db.execute(sql`
        with turnos as (
            select u.id as user_id, o.started_at - interval '30 minutes' as ini, o.fim + interval '60 minutes' as fim
            from (
                select doctor_id, started_at, ${fimDoTurno} as fim from ${regulationOccupancies}
                where started_at <= ${ateIso}::timestamptz and ${fimDoTurno} >= ${de}::timestamptz - interval '1 hour'
                union all
                select doctor_id, started_at, ${fimDoTurno} from ${interventionOccupancies}
                where started_at <= ${ateIso}::timestamptz and ${fimDoTurno} >= ${de}::timestamptz - interval '1 hour'
            ) o
            join ${users} u on u.doctor_id = o.doctor_id
        )
        select a.user_id, a.session_id, a.ip, a.window_start, a.active_requests > 0 as em_uso, s.created_user_agent as ua,
               exists (select 1 from turnos t where t.user_id = a.user_id and a.window_start between t.ini and t.fim) as em_turno
        from ${authSessionActivity} a
        join ${authSessions} s on s.id = a.session_id
        where a.window_start >= ${de}::timestamptz and a.window_start <= ${ateIso}::timestamptz
    `) as unknown as Array<{ user_id: string; session_id: string; ip: string; window_start: string | Date; em_uso: boolean; ua: string | null; em_turno: boolean }>;

    const barrados = await db
        .select({ userId: authSessionEvents.userId, ip: authSessionEvents.ip, em: authSessionEvents.occurredAt, detalhes: authSessionEvents.details })
        .from(authSessionEvents)
        .where(sql`${authSessionEvents.kind} = 'barrado_fora_do_plantao' and ${authSessionEvents.occurredAt} between ${de}::timestamptz and ${ateIso}::timestamptz`);

    const ips = [...new Set([...janelas.map((j) => j.ip), ...barrados.map((b) => b.ip).filter((ip): ip is string => Boolean(ip))])];
    const infoDosIps = new Map<string, InfoDoIp>();
    for (let i = 0; i < ips.length; i += 500) {
        const lote = await db.select().from(authNetworkInfo).where(inArray(authNetworkInfo.ip, ips.slice(i, i + 500)));
        for (const n of lote) {
            const geo = (n.geo ?? {}) as GeoAcesso;
            infoDosIps.set(n.ip, { provedor: n.provider, dnsReverso: n.reverseDns, cidade: geo.cidade ?? null, pais: geo.pais ?? null });
        }
    }

    // Central como o portão enxerga: pelo menos 14 dias (acessos-portao.service.ts).
    const desdeDaCentral = new Date(Math.min(desde.getTime(), ate.getTime() - 14 * 24 * 3_600_000));
    const [{ plantonistasPorFaixa }, rotulos] = await Promise.all([carregarPlantoes(desdeDaCentral, ate), listarRotulosDeRede()]);

    const redes = analisarRedes({
        janelas: janelas.map((j) => ({
            userId: j.user_id,
            sessaoId: j.session_id,
            ip: j.ip,
            inicio: new Date(j.window_start),
            emTurno: j.em_turno,
            emUso: j.em_uso,
            aparelho: descreverAparelho(j.ua).descricao,
        })),
        barrados: barrados.flatMap((b) => (b.userId && b.ip ? [{ userId: b.userId, ip: b.ip, em: b.em, sistema: String((b.detalhes as { sistema?: string })?.sistema ?? "") }] : [])),
        infoDosIps,
        plantonistasPorFaixa,
        rotulos,
    });

    const ids = [...new Set(redes.flatMap((r) => r.contas.map((c) => c.userId)))];
    const contas = new Map<string, ContaResumida>();
    if (ids.length > 0) {
        const linhas = await db
            .select({ id: users.id, email: users.email, doctorId: users.doctorId, role: userRoles.role })
            .from(users)
            .leftJoin(userRoles, eq(userRoles.userId, users.id))
            .where(inArray(users.id, ids));
        for (const l of linhas) {
            const c = contas.get(l.id) ?? { email: l.email, papeis: [], temMedico: Boolean(l.doctorId) };
            if (l.role) c.papeis.push(l.role);
            contas.set(l.id, c);
        }
    }
    return { geradoEm: new Date(), desde, redes, contas };
}

// ── Rótulos (admin) ──────────────────────────────────────────────────────────
export class RotuloDeRedeError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

/** Faixa como o monitor escreve: "200.1.2.0/24" ou "2804:14c:1:2::/64". */
export function faixaValida(faixa: string) {
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.0\/24$/.test(faixa) || /^[0-9a-f:]+::\/64$/.test(faixa);
}

export async function salvarRotuloDeRede(entrada: { faixa: string; kind: TipoDeRotulo; label: string; note?: string | null }, adminId: string) {
    const faixa = entrada.faixa.trim().toLowerCase();
    if (!faixaValida(faixa)) throw new RotuloDeRedeError(400, "Faixa inválida: use a faixa como o monitor mostra (ex.: 200.1.2.0/24).");
    const label = entrada.label.trim().slice(0, 80);
    if (label.length < 2) throw new RotuloDeRedeError(400, "Dê um nome à rede (ex.: Central, Vitalmed).");
    const note = entrada.note?.trim().slice(0, 500) || null;
    await getDb().transaction(async (tx) => {
        await tx.insert(authNetworkLabels)
            .values({ faixa, kind: entrada.kind, label, note, updatedBy: adminId })
            .onConflictDoUpdate({ target: authNetworkLabels.faixa, set: { kind: entrada.kind, label, note, updatedBy: adminId, updatedAt: new Date() } });
        await tx.insert(auditLogs).values({
            actorUserId: adminId,
            action: "acessos.rotulo_de_rede",
            entityType: "network",
            entityId: faixa,
            details: { kind: entrada.kind, label, note },
        });
    });
}

export async function removerRotuloDeRede(faixaBruta: string, adminId: string) {
    const faixa = faixaBruta.trim().toLowerCase();
    await getDb().transaction(async (tx) => {
        const apagados = await tx.delete(authNetworkLabels).where(eq(authNetworkLabels.faixa, faixa)).returning({ faixa: authNetworkLabels.faixa });
        if (apagados.length === 0) throw new RotuloDeRedeError(404, "Esta rede não tem rótulo.");
        await tx.insert(auditLogs).values({ actorUserId: adminId, action: "acessos.rotulo_de_rede_removido", entityType: "network", entityId: faixa, details: {} });
    });
}
