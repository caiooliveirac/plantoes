/**
 * Chegada, saída, remanejo e estado declarados pelo PRÓPRIO médico na web
 * (área do médico).
 *
 * Mesmas regras do bot (docs/chegada.md, docs/dupla-usa.md,
 * docs/saidas-a-confirmar.md), reutilizando os mesmos serviços:
 *  - hora = `new Date()` no servidor, o médico nunca escolhe;
 *  - já em turno → recusa ("vale a primeira mensagem, chegada nunca avança");
 *  - ramal com titular do mesmo turno → tomada: titular vira [DESLOCADO]
 *    (`displaceRegulationOccupant` na chegada; `displace_destination` no
 *    remanejo) e quem chega assume — só com dupla confirmação do cliente
 *    (`cienteOcupado` + `assumirPosto`);
 *  - base (USA) com titular do mesmo turno → dupla: `startInterventionOccupancy`
 *    / `share_destination` põem quem chega fora do quadro sem tocar no titular;
 *    a confirmação dupla serve só para o médico saber que vai dividir a base;
 *  - titular no fim do turno anterior é rendição normal, sem confirmação (igual
 *    ao bot — `shouldDisplaceInsteadOfRelieve`);
 *  - saída = o mesmo fechamento do "saí" do bot: sem sucessor grava
 *    actual_ended_at e fica a confirmar pela chefia; com sucessor, rendição.
 */
import { and, asc, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors, interventionBases, interventionOccupancies, regulationOccupancies, regulationPosts } from "@/db/schema";
import type { AuthenticatedSession } from "@/lib/auth/server";
import { calculateGuardedBankHours } from "@/modules/bank-hours/calculator";
import { resolveBankHoursScheduledWindow } from "@/modules/bank-hours/window";
import { formatDoctorSurfaceName } from "@/modules/doctors/directory";
import { endInterventionOccupancy, shouldJoinInterventionBaseAsCompanion, startInterventionOccupancy } from "@/modules/intervention/service";
import { resolveOccupantCoverageEndAt, shouldDisplaceInsteadOfRelieve } from "@/modules/operational/board-rules";
import { transferOperationalOccupancy } from "@/modules/operational/corrections";
import { resolveHandoffClosure } from "@/modules/operational/handoff-closure";
import { findActiveOccupancyByDoctorId, resolveActiveOccupancyCoverageFloor, type OcupacaoAtivaDoMedico } from "@/modules/operational/ocupacao-ativa";
import { displaceRegulationOccupant, endRegulationOccupancy, isRegulationShadowOccupancyNotes, startRegulationOccupancy } from "@/modules/regulation/service";
import { esquecerTurnoDoPortao } from "@/services/acessos-portao.service";

export type DominioOperacional = "regulation" | "intervention";

export const NOTA_CHEGADA_WEB = "Chegada declarada pela web";
export const NOTA_REMANEJO_WEB = "Remanejo pelo próprio médico (web)";

/** Recusa com status HTTP e corpo prontos para a rota devolver. */
export class PresencaRecusada extends Error {
    constructor(readonly status: number, readonly body: Record<string, unknown>) {
        super(typeof body.error === "string" ? body.error : "presenca_recusada");
    }
}

export interface MedicoDaSessao {
    userId: string;
    doctorId: string;
}

/** Só o próprio médico (papel `doctor` com ficha vinculada) declara presença. */
export function medicoDaSessao(session: AuthenticatedSession): MedicoDaSessao {
    if (!session.user.doctorId) {
        throw new PresencaRecusada(403, { error: "sem_medico_vinculado" });
    }
    if (!session.user.roles.includes("doctor")) {
        throw new PresencaRecusada(403, { error: "sem_papel_medico" });
    }
    return { userId: session.user.id, doctorId: session.user.doctorId };
}

export interface OcupacaoDeclarada {
    domain: DominioOperacional;
    occupancyId: string;
    targetId: number;
    code: string;
    startedAt: string;
}

export function dominioDe(sector: "REGULATION" | "INTERVENTION"): DominioOperacional {
    return sector === "REGULATION" ? "regulation" : "intervention";
}

export function ocupacaoDeclaradaDe(ativa: OcupacaoAtivaDoMedico): OcupacaoDeclarada {
    return {
        domain: dominioDe(ativa.sector),
        occupancyId: ativa.occupancyId,
        targetId: ativa.targetId,
        code: ativa.baseCode,
        startedAt: ativa.startedAt.toISOString(),
    };
}

export async function nomeDoMedico(doctorId: string) {
    const medico = await getDb().query.doctors.findFirst({
        where: eq(doctors.id, doctorId),
        columns: { fullName: true, displayName: true },
    });
    return formatDoctorSurfaceName({ fullName: medico?.fullName, displayName: medico?.displayName });
}

/** Código do ramal/base para mostrar ao médico; null se o alvo sumiu. */
export async function codigoDoAlvo(domain: DominioOperacional, targetId: number): Promise<string | null> {
    const db = getDb();
    if (domain === "regulation") {
        const post = await db.query.regulationPosts.findFirst({ where: eq(regulationPosts.id, targetId), columns: { code: true } });
        return post?.code ?? null;
    }
    const base = await db.query.interventionBases.findFirst({ where: eq(interventionBases.id, targetId), columns: { code: true } });
    return base?.code ?? null;
}

/** Ramal eventual (on_demand) e ramal/base desativados não recebem o médico pela web. */
async function alvoDisponivel(domain: DominioOperacional, targetId: number): Promise<{ id: number; code: string }> {
    const db = getDb();
    if (domain === "regulation") {
        const post = await db.query.regulationPosts.findFirst({ where: eq(regulationPosts.id, targetId) });
        if (!post || !post.isActive || post.onDemand) {
            throw new PresencaRecusada(409, { error: "posto_indisponivel" });
        }
        return { id: post.id, code: post.code };
    }
    const base = await db.query.interventionBases.findFirst({ where: eq(interventionBases.id, targetId) });
    if (!base || !base.isActive) {
        throw new PresencaRecusada(409, { error: "posto_indisponivel" });
    }
    return { id: base.id, code: base.code };
}

interface TitularVigente {
    occupancyId: string;
    doctorId: string;
    desde: Date;
    /** O que acontece com ele se o médico insistir. */
    efeito: "deslocar" | "dupla";
}

/**
 * Quem DETÉM o quadro no alvo e ainda tem cobertura vigente — é só esse que
 * exige a dupla confirmação. Deslocado e sombra coexistem; titular no fim do
 * turno anterior é rendição normal (mesma régua do bot).
 */
async function titularVigente(domain: DominioOperacional, targetId: number, doctorId: string, agora: Date): Promise<TitularVigente | null> {
    const db = getDb();
    if (domain === "regulation") {
        const titular = await db.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, targetId),
                isNull(regulationOccupancies.endedAt),
                isNotNull(regulationOccupancies.boardStartedAt),
                ne(regulationOccupancies.doctorId, doctorId),
            ),
            orderBy: [desc(regulationOccupancies.boardStartedAt)],
        });
        if (!titular || isRegulationShadowOccupancyNotes(titular.notes)) return null;
        const vigente = shouldDisplaceInsteadOfRelieve({
            occupantAnchorAt: titular.boardStartedAt ?? titular.startedAt,
            occupantCoverageEndAt: resolveOccupantCoverageEndAt(titular),
            arrivalAt: agora,
        });
        return vigente
            ? { occupancyId: titular.id, doctorId: titular.doctorId, desde: titular.boardStartedAt ?? titular.startedAt, efeito: "deslocar" }
            : null;
    }

    const titular = await db.query.interventionOccupancies.findFirst({
        where: and(
            eq(interventionOccupancies.baseId, targetId),
            isNull(interventionOccupancies.endedAt),
            isNotNull(interventionOccupancies.boardStartedAt),
            ne(interventionOccupancies.doctorId, doctorId),
        ),
        orderBy: [desc(interventionOccupancies.boardStartedAt)],
    });
    // Base comporta dois médicos: titular vigente nunca é encerrado (docs/dupla-usa.md).
    const dupla = shouldJoinInterventionBaseAsCompanion({ carrier: titular, arrivingDoctorId: doctorId, arrivalAt: agora });
    return dupla && titular
        ? { occupancyId: titular.id, doctorId: titular.doctorId, desde: titular.boardStartedAt ?? titular.startedAt, efeito: "dupla" }
        : null;
}

async function recusarPostoOcupado(titular: TitularVigente): Promise<never> {
    throw new PresencaRecusada(409, {
        error: "posto_ocupado",
        ocupante: { nome: await nomeDoMedico(titular.doctorId), desde: titular.desde.toISOString() },
        efeito: titular.efeito,
        precisaConfirmar: true,
    });
}

export async function declararChegada(params: {
    medico: MedicoDaSessao;
    domain: DominioOperacional;
    targetId: number;
    cienteOcupado: boolean;
    assumirPosto: boolean;
    agora?: Date;
}): Promise<OcupacaoDeclarada> {
    const agora = params.agora ?? new Date();
    const { doctorId, userId } = params.medico;

    // Vale a primeira declaração: quem já está em turno não "chega" de novo
    // (mudar de posto é remanejo — declararRemanejo).
    const ativa = await findActiveOccupancyByDoctorId(doctorId, agora, { ignoreMadrugada: true });
    if (ativa) {
        throw new PresencaRecusada(409, { error: "ja_em_turno", ocupacao: ocupacaoDeclaradaDe(ativa) });
    }

    const alvo = await alvoDisponivel(params.domain, params.targetId);
    const titular = await titularVigente(params.domain, alvo.id, doctorId, agora);
    const confirmou = params.cienteOcupado && params.assumirPosto;
    if (titular && !confirmou) {
        await recusarPostoOcupado(titular);
    }

    if (params.domain === "regulation") {
        if (titular) {
            // Tomada confirmada: igual ao bot — o titular perde o quadro, segue no
            // plantão (pago) e precisa redeclarar posição.
            await displaceRegulationOccupant(titular.occupancyId, {
                displacedAt: agora,
                takenByDoctorName: await nomeDoMedico(doctorId),
            }, userId);
        }
        const criada = await startRegulationOccupancy({
            doctorId,
            postId: alvo.id,
            startedAt: agora,
            boardStartedAt: agora,
            source: "manual",
            notes: NOTA_CHEGADA_WEB,
            createdByUserId: userId,
        });
        esquecerTurnoDoPortao(userId);
        return { domain: "regulation", occupancyId: criada.id, targetId: alvo.id, code: alvo.code, startedAt: criada.startedAt.toISOString() };
    }

    // Dupla é decidida dentro de startInterventionOccupancy (regra-mãe do domínio).
    const criada = await startInterventionOccupancy({
        doctorId,
        baseId: alvo.id,
        startedAt: agora,
        boardStartedAt: agora,
        source: "manual",
        notes: NOTA_CHEGADA_WEB,
        createdByUserId: userId,
    });
    esquecerTurnoDoPortao(userId);
    return { domain: "intervention", occupancyId: criada.id, targetId: alvo.id, code: alvo.code, startedAt: criada.startedAt.toISOString() };
}

/** O próprio médico se move de posto: mesmo caminho da chefia e do bot
    (`transferOperationalOccupancy`), com a mesma dupla confirmação da chegada. */
export async function declararRemanejo(params: {
    medico: MedicoDaSessao;
    domain: DominioOperacional;
    targetId: number;
    cienteOcupado: boolean;
    assumirPosto: boolean;
    agora?: Date;
}): Promise<OcupacaoDeclarada> {
    const agora = params.agora ?? new Date();
    const { doctorId, userId } = params.medico;

    const ativa = await findActiveOccupancyByDoctorId(doctorId, agora);
    if (!ativa) {
        throw new PresencaRecusada(409, { error: "fora_de_turno" });
    }
    const alvo = await alvoDisponivel(params.domain, params.targetId);
    if (dominioDe(ativa.sector) === params.domain && ativa.targetId === alvo.id) {
        throw new PresencaRecusada(409, { error: "mesmo_posto", ocupacao: ocupacaoDeclaradaDe(ativa) });
    }
    const titular = await titularVigente(params.domain, alvo.id, doctorId, agora);
    if (titular && !(params.cienteOcupado && params.assumirPosto)) {
        await recusarPostoOcupado(titular);
    }

    const movida = await transferOperationalOccupancy(ativa.occupancyId, {
        sourceDomain: dominioDe(ativa.sector),
        destination: { domain: params.domain, targetId: alvo.id },
        notes: NOTA_REMANEJO_WEB,
        conflictResolution: titular
            ? { strategy: titular.efeito === "deslocar" ? "displace_destination" : "share_destination" }
            : null,
        // Nunca antes da própria chegada na origem (fechamento antes da abertura).
        transferredAt: new Date(Math.max(agora.getTime(), ativa.startedAt.getTime())),
    }, userId);
    esquecerTurnoDoPortao(userId);
    return {
        domain: params.domain,
        occupancyId: movida.movedOccupancyId,
        targetId: alvo.id,
        code: alvo.code,
        startedAt: (movida.movedSnapshot?.startedAt ?? agora).toISOString(),
    };
}

// ── Prévia do banco de horas ─────────────────────────────────────────────────

export interface PreviaBancoDeHoras {
    atrasoMin: number;
    excedenteMin: number;
    multiplicador: 1 | 2;
    creditoMin: number;
    saldoMin: number;
    janelaInicio: string;
    janelaFim: string;
    agora: string;
}

async function primeiraChegadaDoGrupo(continuityGroupId: string | null, fallback: Date): Promise<Date> {
    if (!continuityGroupId) return fallback;
    const db = getDb();
    const [reg, intv] = await Promise.all([
        db.query.regulationOccupancies.findFirst({
            where: eq(regulationOccupancies.continuityGroupId, continuityGroupId),
            orderBy: [asc(regulationOccupancies.startedAt)],
            columns: { startedAt: true },
        }),
        db.query.interventionOccupancies.findFirst({
            where: eq(interventionOccupancies.continuityGroupId, continuityGroupId),
            orderBy: [asc(interventionOccupancies.startedAt)],
            columns: { startedAt: true },
        }),
    ]);
    const candidatas = [reg?.startedAt, intv?.startedAt, fallback].filter((d): d is Date => d instanceof Date);
    return new Date(Math.min(...candidatas.map((d) => d.getTime())));
}

/** Banco de horas como ficaria se o médico saísse em `agora` — só números. */
export async function previaBancoDeHoras(params: {
    domain: DominioOperacional;
    occupancyId: string;
    agora: Date;
}): Promise<PreviaBancoDeHoras | null> {
    const db = getDb();
    const linha = params.domain === "regulation"
        ? await db.query.regulationOccupancies.findFirst({ where: eq(regulationOccupancies.id, params.occupancyId) })
        : await db.query.interventionOccupancies.findFirst({ where: eq(interventionOccupancies.id, params.occupancyId) });
    if (!linha) return null;

    // Janela prevista da ocupação; quando ela não a tem gravada, a mesma inferência
    // do banco de horas (resolveBankHoursScheduledWindow).
    const janela = linha.scheduledStartAt && linha.scheduledEndAt
        ? { scheduledStartAt: linha.scheduledStartAt, scheduledEndAt: linha.scheduledEndAt }
        : resolveBankHoursScheduledWindow({
            domain: params.domain,
            startedAt: linha.startedAt,
            shiftLabel: linha.shiftLabel,
            scheduledStartAt: linha.scheduledStartAt,
            scheduledEndAt: linha.scheduledEndAt,
            postCode: params.domain === "regulation" ? await codigoDoAlvo("regulation", (linha as typeof regulationOccupancies.$inferSelect).postId) : null,
            actualEndAt: params.agora,
        });
    // Sem janela inferível (não deve acontecer), a chegada real e o agora: zera o cálculo.
    const scheduledStartAt: Date = linha.scheduledStartAt ?? janela.scheduledStartAt ?? linha.startedAt;
    const scheduledEndAt: Date = linha.scheduledEndAt ?? janela.scheduledEndAt ?? params.agora;

    const actualStartAt = await primeiraChegadaDoGrupo(linha.continuityGroupId, linha.startedAt);
    const calculo = calculateGuardedBankHours({
        scheduledStartAt,
        scheduledEndAt,
        actualStartAt,
        actualEndAt: params.agora,
        arrivalDelayWaived: Boolean(linha.arrivalDelayWaivedAt),
    });
    return {
        atrasoMin: calculo.arrivalDelayMinutes,
        excedenteMin: calculo.overtimeMinutes,
        multiplicador: calculo.overtimeMultiplier,
        creditoMin: calculo.creditedOvertimeMinutes,
        saldoMin: calculo.balanceMinutes,
        janelaInicio: scheduledStartAt.toISOString(),
        janelaFim: scheduledEndAt.toISOString(),
        agora: params.agora.toISOString(),
    };
}

// ── Saída ────────────────────────────────────────────────────────────────────

export interface SaidaDeclarada {
    at: string;
    /** true = gravou saída física (actual_ended_at) e a chefia ainda precisa confirmar. */
    aConfirmar: boolean;
    previa: PreviaBancoDeHoras | null;
}

export async function declararSaida(params: { medico: MedicoDaSessao; agora?: Date }): Promise<SaidaDeclarada> {
    const agora = params.agora ?? new Date();
    const { doctorId, userId } = params.medico;
    const db = getDb();

    const ativa = await findActiveOccupancyByDoctorId(doctorId, agora);
    if (!ativa) {
        throw new PresencaRecusada(409, { error: "fora_de_turno" });
    }
    const domain = dominioDe(ativa.sector);
    // Calculada ANTES de fechar: é o que o médico vê no instante da saída.
    const previa = await previaBancoDeHoras({ domain, occupancyId: ativa.occupancyId, agora });

    // Mesma regra do "saí" do bot (modules/telegram/service.ts, shouldCloseAsHandoff):
    // com sucessor aberto no mesmo alvo é rendição — fecha na chegada dele e só
    // guarda a saída física se veio bem depois; sem sucessor, saída solo com
    // actual_ended_at, que entra na fila de confirmação da chefia.
    let fechada: { actualEndedAt: Date | null; departureConfirmedAt: Date | null };
    if (domain === "regulation") {
        const sucessor = await db.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, ativa.targetId),
                isNull(regulationOccupancies.endedAt),
                ne(regulationOccupancies.id, ativa.occupancyId),
                ne(regulationOccupancies.doctorId, doctorId),
            ),
        });
        const closure = resolveHandoffClosure({
            startedAt: ativa.startedAt,
            successorStartedAt: sucessor?.boardStartedAt ?? sucessor?.startedAt ?? null,
            eventAt: agora,
        });
        fechada = await endRegulationOccupancy(ativa.occupancyId, sucessor
            ? { endedAt: closure.endedAt, actualEndedAt: closure.actualEndedAt, handoffClosure: true }
            : { endedAt: agora, actualEndedAt: agora }, userId);
    } else {
        const sucessor = await db.query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.baseId, ativa.targetId),
                isNull(interventionOccupancies.endedAt),
                ne(interventionOccupancies.id, ativa.occupancyId),
                ne(interventionOccupancies.doctorId, doctorId),
            ),
        });
        const closure = resolveHandoffClosure({
            startedAt: ativa.startedAt,
            successorStartedAt: sucessor?.boardStartedAt ?? sucessor?.startedAt ?? null,
            eventAt: agora,
        });
        fechada = await endInterventionOccupancy(ativa.occupancyId, sucessor
            ? { endedAt: closure.endedAt, actualEndedAt: closure.actualEndedAt, handoffClosure: true }
            : { endedAt: agora, actualEndedAt: agora }, userId);
    }

    esquecerTurnoDoPortao(userId);
    return { at: agora.toISOString(), aConfirmar: Boolean(fechada.actualEndedAt) && !fechada.departureConfirmedAt, previa };
}

// ── Estado ───────────────────────────────────────────────────────────────────

export interface EstadoDoMedico {
    medico: { id: string; nome: string };
    emTurno: (OcupacaoDeclarada & { saidaDeclaradaAt: string | null }) | null;
    previa: PreviaBancoDeHoras | null;
}

/** O que a área do médico mostra: "Você está na 1362 desde 07:03" (com a prévia
    do banco até agora) — e, depois da saída declarada e ainda não confirmada
    pela chefia, a hora dela. */
export async function estadoDoMedico(doctorId: string, agora = new Date()): Promise<EstadoDoMedico> {
    const db = getDb();
    const medico = { id: doctorId, nome: await nomeDoMedico(doctorId) };

    const ativa = await findActiveOccupancyByDoctorId(doctorId, agora);
    if (ativa) {
        const emTurno = { ...ocupacaoDeclaradaDe(ativa), saidaDeclaradaAt: null };
        const previa = await previaBancoDeHoras({ domain: emTurno.domain, occupancyId: ativa.occupancyId, agora });
        return { medico, emTurno, previa };
    }

    // Saída declarada há pouco (janela ainda cobre o agora) e sem confirmação da
    // chefia: o médico continua vendo o plantão, agora com a saída marcada.
    const piso = resolveActiveOccupancyCoverageFloor(agora);
    const [reg, intv] = await Promise.all([
        db.query.regulationOccupancies.findFirst({
            where: and(eq(regulationOccupancies.doctorId, doctorId), isNotNull(regulationOccupancies.actualEndedAt), isNull(regulationOccupancies.departureConfirmedAt)),
            orderBy: [desc(regulationOccupancies.startedAt)],
        }),
        db.query.interventionOccupancies.findFirst({
            where: and(eq(interventionOccupancies.doctorId, doctorId), isNotNull(interventionOccupancies.actualEndedAt), isNull(interventionOccupancies.departureConfirmedAt)),
            orderBy: [desc(interventionOccupancies.startedAt)],
        }),
    ]);
    const recentes: Array<{ domain: DominioOperacional; id: string; targetId: number; startedAt: Date; saidaAt: Date }> = [];
    if (reg?.actualEndedAt && reg.actualEndedAt.getTime() >= piso.getTime()) {
        recentes.push({ domain: "regulation", id: reg.id, targetId: reg.postId, startedAt: reg.startedAt, saidaAt: reg.actualEndedAt });
    }
    if (intv?.actualEndedAt && intv.actualEndedAt.getTime() >= piso.getTime()) {
        recentes.push({ domain: "intervention", id: intv.id, targetId: intv.baseId, startedAt: intv.startedAt, saidaAt: intv.actualEndedAt });
    }
    recentes.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const [recente] = recentes;
    if (!recente) return { medico, emTurno: null, previa: null };

    const code = (await codigoDoAlvo(recente.domain, recente.targetId)) ?? String(recente.targetId);
    const previa = await previaBancoDeHoras({ domain: recente.domain, occupancyId: recente.id, agora: recente.saidaAt });
    return {
        medico,
        emTurno: {
            domain: recente.domain,
            occupancyId: recente.id,
            targetId: recente.targetId,
            code,
            startedAt: recente.startedAt.toISOString(),
            saidaDeclaradaAt: recente.saidaAt.toISOString(),
        },
        previa,
    };
}
