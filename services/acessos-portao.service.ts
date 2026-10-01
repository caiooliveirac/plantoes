/* ==========================================================================
   Portão de turno e limite de lugares (docs/monitor-acessos.md, "Portão de
   turno"). As regras estão em modules/acessos/portao.ts; aqui, o banco, a
   memória e a ação.

   - conferirPortaoDeTurno: Mesa (lib/auth/server.ts, requireMesaSession) e
     Tabela (api/servicos/portal/acesso) perguntam a cada pedido. Resposta
     guardada 60 s por conta; a rede do plantão, 15 min. Erro de banco deixa
     passar (a Mesa é operação de emergência) e vira linha de log.
   - vigiarLugares: cada pedido autenticado (Mesa e portal) entra na conta de
     lugares da conta. Mais de LUGARES_TOLERADOS ao mesmo tempo: todas as
     sessões caem e a senha é trocada (acessos-acoes.service.ts). Admin só
     fica registrado — o alerta de episódio forte já avisa.

   Desligar em emergência (sem deploy, só env + pm2 delete/start):
   ACESSOS_PORTAO_TURNO=0 e ACESSOS_LIMITE_LUGARES=0.
   ========================================================================== */
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { interventionOccupancies, regulationOccupancies, userRoles } from "@/db/schema";
import type { ContextoRequisicao } from "@/lib/acessos/contexto";
import { PLANTONISTAS_REDE_DO_PLANTAO } from "@/modules/acessos/analise";
import {
    FOLGA_ANTES_DO_TURNO_MS,
    FOLGA_DEPOIS_DA_SAIDA_REGISTRADA_MS,
    FOLGA_DEPOIS_DO_TURNO_MS,
    SAIU_VALE_MS,
    JANELA_DE_LUGARES_MS,
    LUGARES_TOLERADOS,
    contarLugares,
    decidirPortao,
    enfermeiroAbre,
    type MotivoDoPortao,
    type Visto,
} from "@/modules/acessos/portao";
import { faixaDeRede } from "@/modules/acessos/rede";
import { derrubarPorLugaresDemais } from "@/services/acessos-acoes.service";
import { registrarEvento } from "@/services/acessos.service";
import { listarRotulosDeRede } from "@/services/acessos-redes.service";
import { carregarPlantoes } from "@/services/acessos-relatorio.service";
import { emailDeEnfermeiroDoTurno } from "@/services/enfermeiro-plantao.service";

const TURNO_VALE_MS = 60_000;
const CENTRAL_VALE_MS = 15 * 60_000;
const CENTRAL_OLHA_DIAS = 14;
const BARRADO_REGISTRA_A_CADA_MS = 10 * 60_000;
const DERRUBADA_ESPERA_MS = 15 * 60_000;

function ligado(nome: string) {
    const valor = process.env[nome]?.trim().toLowerCase();
    return valor !== "0" && valor !== "false";
}

let ultimoErro = 0;
function logarErro(onde: string, erro: unknown) {
    const agora = Date.now();
    if (agora - ultimoErro < 60_000) return;
    ultimoErro = agora;
    console.error(`[acessos] portão ${onde}: ${erro instanceof Error ? erro.message : String(erro)}`);
}

// ── Estado em memória (o web é um processo PM2 só) ───────────────────────────
const turnos = new Map<string, { ate: number; emTurno: boolean; saiu: boolean }>();
let central: { ate: number; faixas: Set<string> } | null = null;
const barradoRegistradoEm = new Map<string, number>();
const vistosPorConta = new Map<string, Visto[]>();
const derrubadaEm = new Map<string, number>();

/** Só para os testes. */
/** Rótulo novo/alterado vale na hora, sem esperar os 15 min do cache. */
export function esquecerCentralDoPortao() {
    central = null;
}

/** O médico acabou de declarar chegada/saída pela web: a resposta guardada
    (60 s) ficaria errada justo no instante em que ele entra na Mesa. */
export function esquecerTurnoDoPortao(userId: string) {
    turnos.delete(userId);
}

export function limparMemoriaDoPortao() {
    turnos.clear();
    central = null;
    barradoRegistradoEm.clear();
    vistosPorConta.clear();
    derrubadaEm.clear();
}

/* Em turno: chegada até 30 min à frente; até 10 min depois da saída REGISTRADA,
   ou 60 min depois da prevista (sair sem registrar é comum), ou 24 h da chegada.
   Saiu: registrou saída nas últimas SAIU_VALE_MS e não está em outro turno —
   a Central deixa de abrir para esta conta (docs/conta-emprestada.md). */
async function turnoDoMedico(doctorId: string, agora: Date): Promise<{ emTurno: boolean; saiu: boolean }> {
    const antes = new Date(agora.getTime() + FOLGA_ANTES_DO_TURNO_MS).toISOString();
    const momento = agora.toISOString();
    const desde = new Date(agora.getTime() - SAIU_VALE_MS).toISOString();
    const linhas = await getDb().execute(sql`
        with o as (
            select started_at, actual_ended_at, ended_at from ${regulationOccupancies} where doctor_id = ${doctorId}
            union all
            select started_at, actual_ended_at, ended_at from ${interventionOccupancies} where doctor_id = ${doctorId}
        )
        select
            coalesce(bool_or(started_at <= ${antes}::timestamptz and coalesce(
                actual_ended_at + make_interval(mins => ${FOLGA_DEPOIS_DA_SAIDA_REGISTRADA_MS / 60_000}),
                coalesce(ended_at, started_at + interval '24 hours') + make_interval(mins => ${FOLGA_DEPOIS_DO_TURNO_MS / 60_000})
            ) >= ${momento}::timestamptz), false) as em_turno,
            coalesce(bool_or(actual_ended_at between ${desde}::timestamptz and ${momento}::timestamptz), false) as saiu
        from o
        where started_at >= ${momento}::timestamptz - interval '3 days'
    `) as unknown as Array<{ em_turno: boolean; saiu: boolean }>;
    const emTurno = Boolean(linhas[0]?.em_turno);
    return { emTurno, saiu: !emTurno && Boolean(linhas[0]?.saiu) };
}

async function faixasDaCentral(agora: Date): Promise<Set<string>> {
    if (central && central.ate > agora.getTime()) return central.faixas;
    const { plantonistasPorFaixa } = await carregarPlantoes(new Date(agora.getTime() - CENTRAL_OLHA_DIAS * 24 * 3_600_000), agora);
    const faixas = new Set([...plantonistasPorFaixa].filter(([, n]) => n >= PLANTONISTAS_REDE_DO_PLANTAO).map(([faixa]) => faixa));
    // Faixas rotuladas "Central" pelo admin (/admin/acessos/redes): valem mesmo sem
    // 3 plantonistas medidos — segunda saída de internet, PC novo, rede recém-trocada.
    // Sem a migration 0048 o portão segue só com a medida.
    try {
        for (const rotulo of await listarRotulosDeRede()) if (rotulo.kind === "central") faixas.add(rotulo.faixa);
    } catch (erro) {
        logarErro("rótulos de rede", erro);
    }
    central = { ate: agora.getTime() + CENTRAL_VALE_MS, faixas };
    return faixas;
}

/** O IP está numa faixa da Central (medida ou rotulada)? Erro de banco = não
    (quem depende disto para ganhar folga não ganha às cegas). Nunca lança. */
export async function naRedeDaCentral(ip: string | null, agora = new Date()): Promise<boolean> {
    if (!ip) return false;
    try {
        return (await faixasDaCentral(agora)).has(faixaDeRede(ip));
    } catch (erro) {
        logarErro("rede da Central", erro);
        return false;
    }
}

export interface ContaNoPortao {
    userId: string;
    doctorId: string | null;
    roles: readonly string[];
    /** Só o quadro usa (enfermeiro(a) do plantão é achado pelo e-mail). */
    email?: string;
}

export type SistemaDoPortao = "mesa" | "tabela" | "quadro";

export interface RespostaDoPortao {
    liberado: boolean;
    motivo: MotivoDoPortao | "desligado" | "falha";
}

/** Mesa, Tabela ou quadro: esta conta, deste IP, agora? Nunca lança.
    No quadro passa também o enfermeiro(a) do plantão registrado pela chefia
    (services/enfermeiro-plantao.service.ts). Conta com papel `enfermeiro`
    abre quadro e Mesa sempre (a Mesa só para ler). */
export async function conferirPortaoDeTurno(
    conta: ContaNoPortao,
    contexto: ContextoRequisicao,
    sistema: SistemaDoPortao,
    agora = new Date(),
): Promise<RespostaDoPortao> {
    if (!ligado("ACESSOS_PORTAO_TURNO")) return { liberado: true, motivo: "desligado" };
    if (conta.roles.includes("admin")) return { liberado: true, motivo: "admin" };
    if (enfermeiroAbre(conta.roles, sistema)) return { liberado: true, motivo: "enfermeiro" };
    try {
        let emTurno = false;
        let saiu = false;
        if (conta.doctorId) {
            const guardado = turnos.get(conta.userId);
            if (guardado && guardado.ate > agora.getTime()) {
                ({ emTurno, saiu } = guardado);
            } else {
                ({ emTurno, saiu } = await turnoDoMedico(conta.doctorId, agora));
                turnos.set(conta.userId, { ate: agora.getTime() + TURNO_VALE_MS, emTurno, saiu });
            }
        }
        const naCentral = !emTurno && contexto.ip ? (await faixasDaCentral(agora)).has(faixaDeRede(contexto.ip)) : false;
        const enfermeiroDoTurno = sistema === "quadro" && !emTurno && !naCentral && conta.email
            ? await emailDeEnfermeiroDoTurno(conta.email, agora).catch((erro: unknown) => {
                // Falha aqui fecha (só esta via): sem a tabela, ninguém ganha o quadro às cegas.
                logarErro("enfermeiro do plantão", erro);
                return false;
            })
            : false;
        const decisao = decidirPortao({ roles: conta.roles, emTurno, naCentral, saiuDoPlantao: saiu, enfermeiroDoTurno });
        if (!decisao.liberado) {
            const chave = `${conta.userId}|${sistema}`;
            const ultimo = barradoRegistradoEm.get(chave);
            if (!ultimo || agora.getTime() - ultimo >= BARRADO_REGISTRA_A_CADA_MS) {
                barradoRegistradoEm.set(chave, agora.getTime());
                void registrarEvento({ tipo: "barrado_fora_do_plantao", userId: conta.userId, contexto, detalhes: { sistema }, em: agora });
            }
        }
        return decisao;
    } catch (erro) {
        logarErro("conferência", erro);
        return { liberado: true, motivo: "falha" };
    }
}

/** Conta este pedido nos lugares da conta; com lugares demais, derruba. Chamado depois da resposta; nunca lança. */
export async function vigiarLugares(userId: string, sessaoId: string, ip: string | null, agora = new Date()) {
    if (!ip || !sessaoId || !ligado("ACESSOS_LIMITE_LUGARES")) return;
    const t = agora.getTime();
    const vistos = (vistosPorConta.get(userId) ?? []).filter((v) => t - v.em <= JANELA_DE_LUGARES_MS && !(v.sessaoId === sessaoId && v.ip === ip));
    vistos.push({ sessaoId, ip, em: t });
    vistosPorConta.set(userId, vistos);
    if (vistosPorConta.size > 5_000) {
        for (const [chave, lista] of vistosPorConta) if (lista.every((v) => t - v.em > JANELA_DE_LUGARES_MS)) vistosPorConta.delete(chave);
    }

    const lugares = contarLugares(vistos, t);
    if (lugares.total <= LUGARES_TOLERADOS) return;
    const ultima = derrubadaEm.get(userId);
    if (ultima && t - ultima < DERRUBADA_ESPERA_MS) return;
    derrubadaEm.set(userId, t);
    vistosPorConta.delete(userId);

    try {
        const papeis = await getDb().select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId));
        if (papeis.some((p) => p.role === "admin")) {
            await registrarEvento({ tipo: "lugares_demais_admin", userId, detalhes: { lugares: lugares.total, faixas: lugares.faixas }, em: agora });
            return;
        }
        await derrubarPorLugaresDemais(userId, lugares.total, lugares.faixas);
    } catch (erro) {
        logarErro("derrubada por lugares", erro);
    }
}
