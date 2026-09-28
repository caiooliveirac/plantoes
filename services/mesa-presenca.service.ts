/* Presença na Mesa — banco (docs/presenca-mesa.md). Regras em
   modules/acessos/presenca.ts.

   Lease em Postgres, não em Redis: um processo só, ~3 batidas/s no pico, e o
   lease sobrevive ao restart do deploy (em memória, quem pegou a senha
   ganharia a vez durante o restart). A troca de dono é uma query só, com a
   trava de linha do ON CONFLICT: dois aparelhos abrindo juntos → um ganha.
   O relógio é sempre o do banco.

   Nunca lança: erro de banco deixa passar (a Mesa é operação de emergência,
   mesma escolha do portão de turno) e vira log `[presenca]`. */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { authSessions, viewLeases, viewPresence } from "@/db/schema";
import type { ContextoRequisicao } from "@/lib/acessos/contexto";
import {
    LEASE_TTL_S,
    RECURSO_MESA,
    estaBloqueado,
    limiteOciosoSeg,
    passouDoLimite,
    ultimaInteracao,
    type EstadoPresenca,
    type ModoPresenca,
} from "@/modules/acessos/presenca";
import { registrarEvento } from "@/services/acessos.service";

export interface ContaNaMesa {
    userId: string;
    aparelhoId: string;
    sessaoId: string;
    contexto: ContextoRequisicao | null;
}

export interface RespostaPresenca {
    estado: EstadoPresenca;
    modo: ModoPresenca;
    /** Em sombra, o que teria acontecido (para medir antes de valer). */
    seria?: EstadoPresenca;
    /** Segundos até o lease do outro aparelho vencer, se ninguém renovar. */
    tenteEmSeg?: number;
    limiteOciosoSeg: number;
}

let ultimoErro = 0;
function logarErro(onde: string, erro: unknown) {
    const agora = Date.now();
    if (agora - ultimoErro < 60_000) return;
    ultimoErro = agora;
    console.error(`[presenca] ${onde}: ${erro instanceof Error ? erro.message : String(erro)}`);
}

/* Eventos repetitivos (negado, ocioso em sombra) saem no máximo de 10 em 10 min por conta × aparelho. */
const EVENTO_REPETE_A_CADA_MS = 10 * 60_000;
const eventoEm = new Map<string, number>();
function eventoLiberado(chave: string, agora: number) {
    const ultimo = eventoEm.get(chave);
    if (ultimo && agora - ultimo < EVENTO_REPETE_A_CADA_MS) return false;
    eventoEm.set(chave, agora);
    if (eventoEm.size > 10_000) {
        for (const [k, t] of eventoEm) if (agora - t > EVENTO_REPETE_A_CADA_MS) eventoEm.delete(k);
    }
    return true;
}

function evento(conta: ContaNaMesa, tipo: string, detalhes: Record<string, unknown> = {}) {
    void registrarEvento({ tipo, userId: conta.userId, sessaoId: conta.sessaoId || null, contexto: conta.contexto, aparelhoId: conta.aparelhoId, detalhes });
}

/* Restart do deploy: quem estava com a Mesa ganha 60 s a mais, para não perder
   a vez para outro aparelho enquanto o processo sobe. Uma vez por processo. */
let prorrogado = false;
async function prorrogarNoBoot() {
    if (prorrogado) return;
    prorrogado = true;
    await getDb().execute(sql`
        update ${viewLeases} set expires_at = expires_at + interval '60 seconds'
        where expires_at > now()
    `);
}

/* Liga a sessão ao aparelho no monitor (auth_sessions.device_id), uma vez por sessão por processo. */
const sessoesLigadas = new Set<string>();
async function ligarSessaoAoAparelho(conta: ContaNaMesa) {
    if (!conta.sessaoId || sessoesLigadas.has(conta.sessaoId)) return;
    sessoesLigadas.add(conta.sessaoId);
    if (sessoesLigadas.size > 20_000) sessoesLigadas.clear();
    await getDb().update(authSessions).set({ deviceId: conta.aparelhoId }).where(eq(authSessions.id, conta.sessaoId));
}

interface Tentativa {
    ganhou: boolean;
    trocou: boolean;
    tenteEmSeg: number;
    humanoLaSeg?: number | null;
}

/** Pega ou renova a vez: só se o lease é deste aparelho ou já venceu. */
async function tentarLease(conta: ContaNaMesa): Promise<Tentativa> {
    const db = getDb();
    const ganhou = await db.execute(sql`
        insert into ${viewLeases} as l (user_id, resource, device_id, session_id, epoch, acquired_at, heartbeat_at, expires_at)
        values (${conta.userId}, ${RECURSO_MESA}, ${conta.aparelhoId}, ${conta.sessaoId || null}, 1, now(), now(),
                now() + make_interval(secs => ${LEASE_TTL_S}))
        on conflict (user_id, resource) do update set
            epoch        = l.epoch + case when l.device_id = excluded.device_id then 0 else 1 end,
            acquired_at  = case when l.device_id = excluded.device_id then l.acquired_at else now() end,
            device_id    = excluded.device_id,
            session_id   = excluded.session_id,
            heartbeat_at = now(),
            expires_at   = excluded.expires_at
        where l.device_id = excluded.device_id or l.expires_at < now()
        returning epoch, (acquired_at = heartbeat_at) as recem
    `) as unknown as Array<{ epoch: number | string; recem: boolean }>;
    if (ganhou.length > 0) {
        return { ganhou: true, trocou: Boolean(ganhou[0].recem) && Number(ganhou[0].epoch) > 1, tenteEmSeg: 0 };
    }
    // Negado: quanto falta para a vez vencer e há quanto tempo alguém mexeu
    // no aparelho que está com ela (gente dos dois lados = forte no monitor).
    const dono = await db.execute(sql`
        select greatest(0, ceil(extract(epoch from l.expires_at - now())))::int as falta,
               extract(epoch from now() - p.last_human_at)::int as humano_la
        from ${viewLeases} l
        left join ${viewPresence} p on p.user_id = l.user_id and p.device_id = l.device_id
        where l.user_id = ${conta.userId} and l.resource = ${RECURSO_MESA}
    `) as unknown as Array<{ falta: number; humano_la: number | null }>;
    return {
        ganhou: false,
        trocou: false,
        tenteEmSeg: Math.max(1, Number(dono[0]?.falta ?? LEASE_TTL_S)),
        humanoLaSeg: dono[0]?.humano_la === null || dono[0]?.humano_la === undefined ? null : Number(dono[0].humano_la),
    };
}

async function lerPresenca(conta: ContaNaMesa) {
    const [linha] = await getDb()
        .select({ lastHumanAt: viewPresence.lastHumanAt, lockedAt: viewPresence.lockedAt, unlockedAt: viewPresence.unlockedAt })
        .from(viewPresence)
        .where(and(eq(viewPresence.userId, conta.userId), eq(viewPresence.deviceId, conta.aparelhoId)))
        .limit(1);
    return linha ?? null;
}

/* Soltar = vencer agora, não apagar: a linha guarda o epoch, e o próximo
   aparelho a pegar a vez conta como troca de aparelho no monitor. */
async function soltarVez(conta: ContaNaMesa) {
    await getDb().update(viewLeases)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(and(
            eq(viewLeases.userId, conta.userId),
            eq(viewLeases.resource, RECURSO_MESA),
            eq(viewLeases.deviceId, conta.aparelhoId),
        ));
}

async function bloquearPorOcio(conta: ContaNaMesa, ultima: Date | null) {
    const db = getDb();
    await db.insert(viewPresence)
        .values({ userId: conta.userId, deviceId: conta.aparelhoId, lockedAt: sql`now()`, lockReason: "ocioso", lastHeartbeatAt: sql`now()`, updatedAt: sql`now()` })
        .onConflictDoUpdate({
            target: [viewPresence.userId, viewPresence.deviceId],
            set: { lockedAt: sql`now()`, lockReason: "ocioso", lastHeartbeatAt: sql`now()`, updatedAt: sql`now()` },
        });
    // A vez fica livre na hora: o dono pode abrir no outro aparelho sem esperar.
    await soltarVez(conta);
    evento(conta, "mesa_bloqueada_ociosa", { ultimaInteracao: ultima?.toISOString() ?? null });
}

/**
 * Batida do aparelho (POST /api/mesa/presenca) ou abertura da página.
 * `humanoAgora` = página aberta por navegação (não o refresh automático).
 */
export async function baterPresenca(
    conta: ContaNaMesa,
    sinal: { visivel: boolean; paradoSeg: number | null; humanoAgora: boolean },
    modo: ModoPresenca,
    agora = new Date(),
): Promise<RespostaPresenca> {
    const limite = limiteOciosoSeg();
    const resposta = (seria: EstadoPresenca, extra: Partial<RespostaPresenca> = {}): RespostaPresenca => (
        modo === "valendo"
            ? { estado: seria, modo, limiteOciosoSeg: limite, ...extra }
            : { estado: "ok", modo, seria, limiteOciosoSeg: limite, ...extra }
    );
    if (modo === "desligado") return { estado: "ok", modo, limiteOciosoSeg: limite };
    if (!conta.aparelhoId) return resposta("ocupada", { tenteEmSeg: LEASE_TTL_S });
    try {
        await prorrogarNoBoot();
        void ligarSessaoAoAparelho(conta).catch((erro) => logarErro("sessão × aparelho", erro));

        const presenca = await lerPresenca(conta);
        if (estaBloqueado(presenca)) return resposta("bloqueada");

        // Abrir a página não apaga o tempo parado de antes: F5 numa tela
        // esquecida (ou a Mesa aberta de novo no PC da Central horas depois)
        // cai no bloqueio. Só a senha — login ou tela de bloqueio — zera.
        const guardada = presenca?.lastHumanAt ?? null;
        const ultima = sinal.humanoAgora && passouDoLimite(agora, guardada, limite)
            ? guardada
            : ultimaInteracao({ agora, guardada, paradoSeg: sinal.paradoSeg, humanoAgora: sinal.humanoAgora });
        if (passouDoLimite(agora, ultima, limite)) {
            if (modo === "valendo") {
                await bloquearPorOcio(conta, ultima);
                return resposta("bloqueada");
            }
            if (eventoLiberado(`ocio|${conta.userId}|${conta.aparelhoId}`, agora.getTime())) {
                evento(conta, "mesa_bloqueada_ociosa_sombra", { ultimaInteracao: ultima?.toISOString() ?? null });
            }
        }

        await getDb().insert(viewPresence)
            .values({ userId: conta.userId, deviceId: conta.aparelhoId, lastHeartbeatAt: sql`now()`, lastHumanAt: ultima, updatedAt: sql`now()` })
            .onConflictDoUpdate({
                target: [viewPresence.userId, viewPresence.deviceId],
                set: { lastHeartbeatAt: sql`now()`, lastHumanAt: ultima, updatedAt: sql`now()` },
            });

        // Aba escondida não pega nem renova a vez: só diz como está.
        if (!sinal.visivel && !sinal.humanoAgora) {
            return (await conferirPresenca(conta, modo)).estado === "ok" ? resposta("ok") : resposta("ocupada");
        }

        const tentativa = await tentarLease(conta);
        if (tentativa.ganhou) {
            if (tentativa.trocou) evento(conta, "mesa_troca_de_aparelho");
            return resposta("ok");
        }
        if (eventoLiberado(`negado|${conta.userId}|${conta.aparelhoId}`, agora.getTime())) {
            evento(conta, modo === "valendo" ? "mesa_ocupada_negada" : "mesa_ocupada_negada_sombra", {
                humanoAqui: ultima ? Math.round((agora.getTime() - ultima.getTime()) / 1000) : null,
                humanoLa: tentativa.humanoLaSeg ?? null,
            });
        }
        return resposta("ocupada", { tenteEmSeg: tentativa.tenteEmSeg });
    } catch (erro) {
        logarErro("batida", erro);
        return { estado: "ok", modo, limiteOciosoSeg: limite };
    }
}

/**
 * Conferência em cada pedido de dados da Mesa: o aparelho não está bloqueado e
 * está com a vez. Não renova nada (quem renova é a batida). Em sombra e
 * desligado sempre "ok".
 */
export async function conferirPresenca(conta: ContaNaMesa, modo: ModoPresenca): Promise<{ estado: EstadoPresenca }> {
    if (modo !== "valendo") return { estado: "ok" };
    if (!conta.aparelhoId) return { estado: "ocupada" };
    try {
        const linhas = await getDb().execute(sql`
            select
                (select locked_at from ${viewPresence} where user_id = ${conta.userId} and device_id = ${conta.aparelhoId}) as locked_at,
                (select unlocked_at from ${viewPresence} where user_id = ${conta.userId} and device_id = ${conta.aparelhoId}) as unlocked_at,
                exists (
                    select 1 from ${viewLeases}
                    where user_id = ${conta.userId} and resource = ${RECURSO_MESA}
                      and device_id = ${conta.aparelhoId} and expires_at > now()
                ) as com_a_vez
        `) as unknown as Array<{ locked_at: string | Date | null; unlocked_at: string | Date | null; com_a_vez: boolean }>;
        const linha = linhas[0];
        const data = (v: string | Date | null) => (v ? new Date(v) : null);
        if (estaBloqueado({ lockedAt: data(linha?.locked_at ?? null), unlockedAt: data(linha?.unlocked_at ?? null) })) return { estado: "bloqueada" };
        return { estado: linha?.com_a_vez ? "ok" : "ocupada" };
    } catch (erro) {
        logarErro("conferência", erro);
        return { estado: "ok" };
    }
}

/** Senha certa (tela de bloqueio ou login com e-mail e senha): desbloqueia o aparelho e conta como interação. Nunca lança. */
export async function desbloquearAparelho(conta: ContaNaMesa) {
    if (!conta.aparelhoId) return;
    try {
        const estava = estaBloqueado(await lerPresenca(conta));
        await getDb().insert(viewPresence)
            .values({ userId: conta.userId, deviceId: conta.aparelhoId, unlockedAt: sql`now()`, lastHumanAt: sql`now()`, updatedAt: sql`now()` })
            .onConflictDoUpdate({
                target: [viewPresence.userId, viewPresence.deviceId],
                set: { unlockedAt: sql`now()`, lastHumanAt: sql`now()`, updatedAt: sql`now()` },
            });
        if (estava) evento(conta, "mesa_desbloqueada");
    } catch (erro) {
        logarErro("desbloqueio", erro);
    }
}

/** Aba fechada (sendBeacon no pagehide): solta a vez na hora. Outra aba do
    mesmo aparelho ainda aberta pega de volta na próxima batida. Nunca lança. */
export async function liberarLease(conta: ContaNaMesa) {
    if (!conta.aparelhoId) return;
    try {
        await soltarVez(conta);
    } catch (erro) {
        logarErro("liberar", erro);
    }
}

/** Testes: zera a memória do processo. */
export function limparMemoriaDaPresenca() {
    eventoEm.clear();
    sessoesLigadas.clear();
    prorrogado = false;
}
