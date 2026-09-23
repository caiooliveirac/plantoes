import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNull, isNotNull, lte, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors, interventionBaseDeactivations, interventionBases, interventionOccupancies, regulationOccupancies } from "@/db/schema";
import { extractDoctorPreferredOperationalRole } from "@/modules/doctors/directory";
import { publishBoardUpdate } from "@/lib/board-live";
import { avisarDeslocamento } from "@/modules/operational/displacement-alert";
import { syncInterventionBankHours, syncRegulationBankHours } from "@/modules/bank-hours/service";
import { applyOperationalRoleShiftPolicy } from "@/modules/operational/roles";
import { resolveRearrivalNotes, shouldPromoteShadowToBoardOnRearrival } from "@/modules/operational/shadow";
import { isRearrivalWithinOwnWindow, resolveArrivalShiftLabel, resolveOccupantCoverageEndAt, resolveOperationalShiftWindow, shouldDisplaceInsteadOfRelieve } from "@/modules/operational/board-rules";
import { classifyEarlyDeparture, isEarlyDepartureEligible } from "@/modules/operational/early-departure";
import { resolveMultiSegmentDepartureTrim } from "@/modules/operational/multi-segment-departure";
import { describeMergedArrival, resolveArrivalIdentity } from "@/modules/operational/occupancy-identity";
import { describeContestBlockedByLaterArrival, describeContestedDeparture, isContestedDepartureNotes, resolveContestedBoardDecision, type ContestedDepartureContinuation } from "@/modules/operational/contested-departure";
import { findLaterArrivalForDoctor } from "@/modules/operational/later-arrival";
import { shouldJoinDoctorTurnoGroup } from "@/modules/operational/turno";
import { inferInterventionCoverageWindow, inferOperationalScheduledStartAt, resolveContinuationInPlaceShiftLabel, resolveInterventionContinuationScheduledEndAt } from "@/modules/operational/rules";

type Executor = any;
const AUTO_CONTINUITY_RECENT_CLOSED_WINDOW_MS = 2 * 60 * 60 * 1000;
const MIN_SAFE_OCCUPANCY_DURATION_MS = 60 * 1000;
/** Até onde procurar o plantão fechado que a chegada nova vem reabrir (P de 24h cabe). */
const ARRIVAL_MERGE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Remanejamento herda continuity_group_id do plantão aberto em outra base só quando a
 * chegada nova cai na mesma janela operacional do plantão anterior. Plantão antigo aberto
 * em outro turno (médico esqueceu de avisar saída há horas) não fundirá grupos.
 */
export function shouldInheritContinuityFromOtherBaseOccupancy(params: {
    otherBaseStartedAt: Date;
    eventAt: Date;
}) {
    const otherWindowStart = resolveOperationalShiftWindow(params.otherBaseStartedAt).startedAt.getTime();
    const eventWindowStart = resolveOperationalShiftWindow(params.eventAt).startedAt.getTime();
    return otherWindowStart === eventWindowStart;
}

export interface StartInterventionOccupancyInput {
    doctorId: string;
    baseId: number;
    continuityGroupId?: string | null;
    previousOccupancyId?: string | null;
    isContinuityEntry?: boolean;
    isShadow?: boolean | null;
    startedAt: Date;
    boardStartedAt?: Date | null;
    scheduledStartAt?: Date | null;
    scheduledEndAt?: Date | null;
    shiftLabel?: string | null;
    roleLabel?: string | null;
    source: "manual" | "telegram" | "import" | "admin_correction";
    notes?: string | null;
    createdByUserId?: string | null;
}

export interface DeactivateInterventionBaseInput {
    baseId: number;
    deactivatedAt: Date;
    notes?: string | null;
    createdByUserId?: string | null;
}

export interface ReactivateInterventionBaseInput {
    baseId: number;
    reactivatedAt?: Date | null;
    updatedByUserId?: string | null;
}

export function resolveHistoricalInterventionAdminCorrectionEndAt(params: {
    source: StartInterventionOccupancyInput["source"];
    startedAt: Date;
    inferredScheduledEndAt: Date | null;
    now: Date;
}) {
    if (params.source !== "admin_correction") {
        return null;
    }

    if (!params.inferredScheduledEndAt) {
        return null;
    }

    if (params.inferredScheduledEndAt.getTime() > params.now.getTime()) {
        return null;
    }

    if (params.inferredScheduledEndAt.getTime() <= params.startedAt.getTime()) {
        return null;
    }

    return params.inferredScheduledEndAt;
}

export function resolveContinuationBoardStartedAt(params: {
    startedAt: Date;
    boardStartedAt?: Date | null;
    continuedAt: Date;
}) {
    // Always preserve the earliest boardStartedAt. When a doctor continues across
    // shifts (SD→SN, P→SN), the board must reflect their original arrival time so
    // that operational priority correctly shows who has been present longer.
    return params.boardStartedAt ?? params.startedAt;
}

export function resolveExistingInterventionBoardAnchor(params: {
    startedAt: Date;
    boardStartedAt?: Date | null;
}) {
    return params.boardStartedAt ?? params.startedAt;
}

export function resolveSameDoctorBoardStartedAt(params: {
    existingStartedAt: Date;
    existingBoardStartedAt?: Date | null;
    effectiveBoardStartedAt?: Date | null;
    currentShiftStart: Date;
    withinOwnWindow?: boolean;
}) {
    // Shadow occupancies intentionally keep boardStartedAt=null so they never contend
    // for the unique active board-carrier slot on the base.
    if (!params.existingBoardStartedAt) {
        return null;
    }

    // Telegram shadow flows can preserve a null board anchor; in that case keep the
    // current carrier anchor instead of crashing on getTime().
    if (!params.effectiveBoardStartedAt) {
        return resolveExistingInterventionBoardAnchor({
            startedAt: params.existingStartedAt,
            boardStartedAt: params.existingBoardStartedAt,
        });
    }

    const PRE_SHIFT_TOLERANCE_MS = 60 * 60 * 1000;
    const existingBoardAnchor = resolveExistingInterventionBoardAnchor({
        startedAt: params.existingStartedAt,
        boardStartedAt: params.existingBoardStartedAt,
    });
    const existingAnchorIsStale = !params.withinOwnWindow
        && existingBoardAnchor.getTime() < (params.currentShiftStart.getTime() - PRE_SHIFT_TOLERANCE_MS);

    if (existingAnchorIsStale || params.effectiveBoardStartedAt.getTime() < existingBoardAnchor.getTime()) {
        return params.effectiveBoardStartedAt;
    }

    return existingBoardAnchor;
}

export function shouldReuseImplicitContinuitySource(referenceAt: Date, sourceEndedAt?: Date | null) {
    if (!sourceEndedAt) {
        return true;
    }

    return Math.abs(referenceAt.getTime() - sourceEndedAt.getTime()) <= AUTO_CONTINUITY_RECENT_CLOSED_WINDOW_MS;
}

function clampOccupancyEndAt(startedAt: Date, endedAt: Date) {
    return endedAt.getTime() < startedAt.getTime() ? startedAt : endedAt;
}

export function resolveSafeInterventionHandoffAt(params: {
    sourceStartedAt: Date;
    requestedAt: Date;
}) {
    const handoffAt = params.requestedAt.getTime() >= params.sourceStartedAt.getTime()
        ? params.requestedAt
        : params.sourceStartedAt;

    return handoffAt.getTime() - params.sourceStartedAt.getTime() >= MIN_SAFE_OCCUPANCY_DURATION_MS
        ? handoffAt
        : null;
}

// Uma desativação vale até a VIRADA do turno em que foi feita (07:00/19:00 SP).
// Passada essa fronteira, a base volta ao normal (waiting → AGUARDANDO o próximo
// escalado) sem depender de reativação manual nem da chegada de um médico. Se a base
// seguir fora de serviço por mais de um turno, a chefia redesativa (o turno seguinte
// vira vaga descoberta, não mais "coberta" — consequência aceita ao adotar a expiração
// por turno; ver ADR-001). Antes isto era um stub (ano 9999) e a desativação nunca
// expirava, deixando a base escura indefinidamente e suprimindo o "AGUARDANDO FULANO".
export function resolveInterventionBaseDeactivationExpiresAt(deactivatedAt: Date) {
    return resolveOperationalShiftWindow(deactivatedAt).nextBoundaryAt;
}

export function isInterventionBaseDeactivationActive(params: {
    deactivatedAt: Date;
    reactivatedAt?: Date | null;
    referenceAt: Date;
}) {
    if (params.referenceAt.getTime() < params.deactivatedAt.getTime()) {
        return false;
    }

    // Expira na virada do turno: além da fronteira, a desativação não vale mais.
    const expiresAt = resolveInterventionBaseDeactivationExpiresAt(params.deactivatedAt);
    if (params.referenceAt.getTime() >= expiresAt.getTime()) {
        return false;
    }

    return !params.reactivatedAt || params.referenceAt.getTime() < params.reactivatedAt.getTime();
}

export function resolveInterventionOccupancyActivationReferenceAt(params: {
    startedAt: Date;
    scheduledStartAt?: Date | null;
}) {
    if (!params.scheduledStartAt) {
        return params.startedAt;
    }

    return params.scheduledStartAt.getTime() > params.startedAt.getTime()
        ? params.scheduledStartAt
        : params.startedAt;
}

function normalizeInterventionOperationalNotes(value: string | null | undefined) {
    return (value ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase();
}

export function isInterventionShadowOccupancyNotes(notes: string | null | undefined) {
    const normalized = normalizeInterventionOperationalNotes(notes);
    return normalized.includes("[TELEGRAM SOMBRA]") || /\bSOMBRA\b/.test(normalized);
}

// Espelha o domínio de regulação: ocupação "deslocada" numa tomada confirmada
// permanece ativa fora do quadro (board_started_at nulo) com a chegada preservada.
export const INTERVENTION_DISPLACED_NOTE_MARKER = "[DESLOCADO]";

export function isInterventionDisplacedOccupancyNotes(notes: string | null | undefined) {
    return normalizeInterventionOperationalNotes(notes).includes(INTERVENTION_DISPLACED_NOTE_MARKER);
}

// "Dupla": segundo médico na MESMA base (USA com dois médicos). Quem já estava segue
// titular do quadro; quem chega entra com board_started_at nulo — fora do índice de um
// titular por base — e o painel desenha os dois ("Fulano + Beltrano"), cada um com
// remanejar/retirar próprios. Ninguém precisa escrever "sombra" para dividir a base.
export const INTERVENTION_COMPANION_NOTE_MARKER = "[DUPLA]";

export function isInterventionCompanionOccupancyNotes(notes: string | null | undefined) {
    return normalizeInterventionOperationalNotes(notes).includes(INTERVENTION_COMPANION_NOTE_MARKER);
}

export function appendInterventionCompanionMarker(notes: string | null | undefined, joinedAt: Date) {
    if (isInterventionCompanionOccupancyNotes(notes)) {
        return notes ?? null;
    }
    const marker = `${INTERVENTION_COMPANION_NOTE_MARKER} ${joinedAt.toISOString()}`;
    return notes?.trim() ? `${notes}\n${marker}` : marker;
}

// Remanejo leva o médico para OUTRO alvo: lá ele não entrou como dupla, então o
// marcador sai das notas da ocupação nova (a de origem, fechada, guarda o dela).
// Quem assume o quadro na MESMA base NÃO perde o marcador: ele é o registro de que
// entrou dividindo a base, e é o que o pagamento lê para não acusar conflito entre
// titular e dupla. Fora do quadro só é dupla quem tem board nulo — marcador em quem
// tem board é inerte para painel e varredura.
export function stripInterventionCompanionMarker(notes: string | null | undefined) {
    if (!notes || !isInterventionCompanionOccupancyNotes(notes)) {
        return notes ?? null;
    }
    const kept = notes
        .split("\n")
        .filter((line) => !line.trim().toUpperCase().startsWith(INTERVENTION_COMPANION_NOTE_MARKER))
        .join("\n")
        .trim();
    return kept || null;
}

// Reescrever as notas de quem está FORA do quadro não pode apagar o marcador que o
// mantém visível no painel: board nulo + marcador apagado = médico aberto que ninguém
// vê nem consegue retirar. Anexa a linha original do marcador às notas novas.
// Idempotente. Espelha preserveRegulationDisplacedMarker.
export function preserveInterventionOffBoardMarkers(
    existingNotes: string | null | undefined,
    nextNotes: string | null | undefined,
): string | null {
    return preserveInterventionNoteMarkers(existingNotes, nextNotes, [
        INTERVENTION_COMPANION_NOTE_MARKER,
        INTERVENTION_DISPLACED_NOTE_MARKER,
    ]);
}

// Quem tem board só carrega adiante o [DUPLA] (registro de como entrou, lido pelo
// pagamento); [DESLOCADO] é estado de quem está fora do quadro e não acompanha.
export function preserveInterventionCompanionMarker(
    existingNotes: string | null | undefined,
    nextNotes: string | null | undefined,
): string | null {
    return preserveInterventionNoteMarkers(existingNotes, nextNotes, [INTERVENTION_COMPANION_NOTE_MARKER]);
}

function preserveInterventionNoteMarkers(
    existingNotes: string | null | undefined,
    nextNotes: string | null | undefined,
    markers: string[],
): string | null {
    let result = nextNotes ?? null;
    for (const marker of markers) {
        if (!normalizeInterventionOperationalNotes(existingNotes).includes(marker)
            || normalizeInterventionOperationalNotes(result).includes(marker)) {
            continue;
        }
        const markerLine = (existingNotes ?? "")
            .split("\n")
            .find((line) => normalizeInterventionOperationalNotes(line).includes(marker));
        if (markerLine) {
            result = result ? `${result}\n${markerLine.trim()}` : markerLine.trim();
        }
    }
    return result;
}

// Regra-mãe: quem avisou chegada para o turno NÃO sai da base por comando de outro
// médico. Se o titular ainda tem cobertura vigente (mesmo turno, ou P/continuidade
// que segue), quem chega entra como dupla em vez de encerrá-lo. Só o fim do turno
// anterior é rendição. Sombra declarada e carga histórica seguem suas regras.
export function shouldJoinInterventionBaseAsCompanion(params: {
    carrier: {
        doctorId: string;
        startedAt: Date;
        boardStartedAt: Date | null;
        scheduledEndAt: Date | null;
        shiftLabel: string | null;
        notes: string | null | undefined;
    } | null | undefined;
    arrivingDoctorId: string;
    arrivalAt: Date;
    arrivingIsShadow?: boolean | null;
}) {
    const carrier = params.carrier;
    if (!carrier || params.arrivingIsShadow || carrier.doctorId === params.arrivingDoctorId) {
        return false;
    }
    if (isInterventionShadowOccupancyNotes(carrier.notes)) {
        return false;
    }
    return shouldDisplaceInsteadOfRelieve({
        occupantAnchorAt: carrier.boardStartedAt ?? carrier.startedAt,
        occupantCoverageEndAt: resolveOccupantCoverageEndAt(carrier),
        arrivalAt: params.arrivalAt,
    });
}

// Quem herda o quadro quando o titular sai: a dupla (médico de fato na base) antes
// da sombra; sem dupla, vale a regra antiga (aberto mais antigo sem board).
export function pickInterventionBoardReplacement<T extends { startedAt: Date; notes: string | null }>(
    openWithoutBoard: T[],
    vacatedAt: Date,
): T | null {
    const eligible = openWithoutBoard
        .filter((occupancy) => occupancy.startedAt.getTime() <= vacatedAt.getTime())
        .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
    return eligible.find((occupancy) => !isInterventionShadowOccupancyNotes(occupancy.notes))
        ?? eligible[0]
        ?? null;
}

async function promoteInterventionBoardReplacement(tx: Executor, params: {
    baseId: number;
    vacatedAt: Date;
    updatedByUserId: string | null;
}) {
    const openWithoutBoard: Array<typeof interventionOccupancies.$inferSelect> = await tx.query.interventionOccupancies.findMany({
        where: and(
            eq(interventionOccupancies.baseId, params.baseId),
            isNull(interventionOccupancies.boardStartedAt),
            isNull(interventionOccupancies.endedAt),
        ),
        orderBy: [asc(interventionOccupancies.startedAt)],
    });
    const replacement = pickInterventionBoardReplacement(openWithoutBoard, params.vacatedAt);
    if (!replacement) {
        return;
    }
    // Base que já tem titular não promove ninguém: o índice de um titular por base
    // rejeitaria o update (23505) e derrubaria a operação inteira.
    const currentCarrier = await tx.query.interventionOccupancies.findFirst({
        where: and(
            eq(interventionOccupancies.baseId, params.baseId),
            isNotNull(interventionOccupancies.boardStartedAt),
            isNull(interventionOccupancies.endedAt),
        ),
        columns: { id: true },
    });
    if (currentCarrier) {
        return;
    }
    await tx.update(interventionOccupancies)
        .set({
            boardStartedAt: params.vacatedAt,
            updatedByUserId: params.updatedByUserId,
            updatedAt: new Date(),
        })
        .where(eq(interventionOccupancies.id, replacement.id));
}

export function resolveStaleShadowInterventionEndedAt(params: {
    notes: string | null | undefined;
    /** Reaberto por "NÃO SAIU" fora do quadro (board nulo) vence como sombra. */
    boardStartedAt?: Date | null;
    scheduledEndAt?: Date | null;
    endedAt?: Date | null;
    referenceAt: Date;
}) {
    if (params.endedAt || !params.scheduledEndAt) {
        return null;
    }

    // Dupla fora do quadro vence como sombra: ninguém a rende na virada (não é
    // titular), então sem isto ficaria aberta para sempre. Saída tardia avisada
    // depois ainda ajusta o registro fechado ("telegram saida ajustada").
    const expiresOutOfBoard = !params.boardStartedAt
        && (isContestedDepartureNotes(params.notes) || isInterventionCompanionOccupancyNotes(params.notes));
    if (!isInterventionShadowOccupancyNotes(params.notes) && !expiresOutOfBoard) {
        return null;
    }

    if (params.referenceAt.getTime() < params.scheduledEndAt.getTime()) {
        return null;
    }

    return params.scheduledEndAt;
}

// Base diurna (day_only): fecha QUALQUER ocupação aberta (titular ou sombra) assim
// que o horário programado (07-19) termina — diferente de resolveStaleShadowInterventionEndedAt,
// que só fecha sombra. É isso que garante que a base some do painel à noite e nunca
// chegue a ser continuada (continueInterventionOccupancy exige !endedAt).
export function resolveDayOnlyBaseAutoCloseEndedAt(params: {
    dayOnly: boolean;
    scheduledEndAt?: Date | null;
    endedAt?: Date | null;
    referenceAt: Date;
}) {
    if (!params.dayOnly || params.endedAt || !params.scheduledEndAt) {
        return null;
    }

    if (params.referenceAt.getTime() < params.scheduledEndAt.getTime()) {
        return null;
    }

    return params.scheduledEndAt;
}

export function shouldCloseInterventionBoardCarrierOnArrival(params: {
    currentCarrierDoctorId: string;
    arrivingDoctorId: string;
    currentCarrierNotes: string | null | undefined;
}) {
    if (params.currentCarrierDoctorId === params.arrivingDoctorId) {
        return false;
    }

    if (isInterventionDisplacedOccupancyNotes(params.currentCarrierNotes)) {
        return false;
    }

    return !isInterventionShadowOccupancyNotes(params.currentCarrierNotes);
}

// Desloca o portador da base numa tomada confirmada: tira o board sem fechar,
// preservando a chegada. Mantém ativo fora do quadro até redeclarar nova posição.
export async function displaceInterventionOccupant(
    occupancyId: string,
    input: { displacedAt: Date; takenByDoctorName?: string | null },
    updatedByUserId?: string | null,
) {
    const db = getDb();
    // Deslocar duas vezes é idempotente; só a primeira avisa.
    let jaEstavaDeslocada = false;
    const updated = await db.transaction(async (tx) => {
        const existing = await tx.query.interventionOccupancies.findFirst({
            where: eq(interventionOccupancies.id, occupancyId),
        });
        if (!existing) {
            throw new Error("Intervention occupancy not found.");
        }
        if (existing.endedAt) {
            throw new Error("Only active intervention occupancies can be displaced.");
        }
        if (isInterventionDisplacedOccupancyNotes(existing.notes)) {
            jaEstavaDeslocada = true;
            return existing;
        }

        const stamp = input.displacedAt.toISOString();
        const by = input.takenByDoctorName ? ` por ${input.takenByDoctorName}` : "";
        const marker = `${INTERVENTION_DISPLACED_NOTE_MARKER} ${stamp}${by}`.trim();
        const nextNotes = existing.notes ? `${existing.notes}\n${marker}` : marker;

        const [row] = await tx.update(interventionOccupancies)
            .set({
                boardStartedAt: null,
                notes: nextNotes,
                updatedByUserId: updatedByUserId ?? null,
                updatedAt: new Date(),
            })
            .where(eq(interventionOccupancies.id, occupancyId))
            .returning();
        return row;
    });

    publishBoardUpdate(`intervention:displace:${updated.baseId}`);

    // Ver a nota gêmea em modules/regulation/service.ts: aviso fail-soft depois
    // do commit, nunca dentro da transação.
    if (jaEstavaDeslocada === false) {
        const [doctor, base] = await Promise.all([
            db.query.doctors.findFirst({ where: eq(doctors.id, updated.doctorId), columns: { fullName: true } }),
            db.query.interventionBases.findFirst({ where: eq(interventionBases.id, updated.baseId), columns: { code: true } }),
        ]);
        void avisarDeslocamento({
            doctorName: doctor?.fullName ?? "Médico não identificado",
            targetCode: base?.code ?? String(updated.baseId),
            takenByDoctorName: input.takenByDoctorName ?? null,
            domain: "intervention",
        });
    }

    return updated;
}

// Sombra NUNCA assume o quadro — nem quando a base está vazia. A regra antiga
// ("sombra sozinha assume") transformava a sombra em titular de fato e fazia o
// portão de tomada do Telegram disparar contra ela na chegada do titular real.
// Sombra fica sempre com board_started_at = NULL, fora do índice
// one-active-board-per-base; o painel a desenha pelo marcador de nota.
export function resolveInterventionArrivalBoardPolicy(params: {
    source: StartInterventionOccupancyInput["source"];
    isShadow?: boolean | null;
}) {
    return {
        shouldTakeBoardImmediately: params.source !== "import" && !params.isShadow,
    };
}

async function closeExpiredInterventionBaseDeactivation(tx: Executor, params: {
    deactivationId: string;
    expiredAt: Date;
    updatedByUserId?: string | null;
}) {
    return;
}

async function findActiveInterventionBaseDeactivation(tx: Executor, params: {
    baseId: number;
    referenceAt: Date;
    updatedByUserId?: string | null;
}) {
    const openDeactivation = await tx.query.interventionBaseDeactivations.findFirst({
        where: and(
            eq(interventionBaseDeactivations.baseId, params.baseId),
            isNull(interventionBaseDeactivations.reactivatedAt),
            lte(interventionBaseDeactivations.deactivatedAt, params.referenceAt),
        ),
        orderBy: [desc(interventionBaseDeactivations.deactivatedAt)],
    });

    if (!openDeactivation) {
        return null;
    }

    return openDeactivation;
}

// Reaper: fecha janelas de desativação que já passaram da virada do turno em que
// foram feitas (ver resolveInterventionBaseDeactivationExpiresAt), gravando
// reactivatedAt = fronteira do turno (fim histórico correto — a base voltou na virada).
// Chamado a cada montagem do quadro, devolve a base ao estado 'waiting' na virada sem
// depender de reativação manual ou da chegada de um médico. Idempotente; também sana
// janelas antigas que ficaram abertas antes desta regra (a fronteira já passou).
export async function expireInterventionBaseDeactivations(referenceAt: Date, updatedByUserId?: string | null) {
    const db = getDb();
    const open = await db.query.interventionBaseDeactivations.findMany({
        where: and(
            isNull(interventionBaseDeactivations.reactivatedAt),
            lte(interventionBaseDeactivations.deactivatedAt, referenceAt),
        ),
    });
    let closed = 0;
    for (const window of open) {
        const expiresAt = resolveInterventionBaseDeactivationExpiresAt(window.deactivatedAt);
        if (referenceAt.getTime() < expiresAt.getTime()) {
            continue;
        }
        await db.update(interventionBaseDeactivations)
            .set({ reactivatedAt: expiresAt, updatedByUserId: updatedByUserId ?? null, updatedAt: new Date() })
            .where(eq(interventionBaseDeactivations.id, window.id));
        closed++;
    }
    return closed;
}

async function assertInterventionBaseExists(baseId: number) {
    const db = getDb();
    const base = await db.query.interventionBases.findFirst({
        where: eq(interventionBases.id, baseId),
    });

    if (!base) {
        throw new Error("Intervention base not found.");
    }

    return base;
}

/**
 * Ocupação fechada do mesmo médico nesta base que esta chegada vem reabrir.
 * Janela de busca larga (24h) porque um "P" de 24h fechado por engano às 19h
 * ainda é o mesmo plantão às 19h48; quem decide de fato é resolveArrivalIdentity.
 */
async function resolveInterventionArrivalMergeTarget(tx: Executor, params: {
    baseId: number;
    doctorId: string;
    startedAt: Date;
}) {
    const candidates = await tx.query.interventionOccupancies.findMany({
        where: and(
            eq(interventionOccupancies.baseId, params.baseId),
            eq(interventionOccupancies.doctorId, params.doctorId),
            isNotNull(interventionOccupancies.endedAt),
            gte(interventionOccupancies.startedAt, new Date(params.startedAt.getTime() - ARRIVAL_MERGE_LOOKBACK_MS)),
        ),
        orderBy: [desc(interventionOccupancies.startedAt)],
    });

    const identity = resolveArrivalIdentity({
        startedAt: params.startedAt,
        existing: candidates.map((occupancy: typeof interventionOccupancies.$inferSelect) => ({
            id: occupancy.id,
            doctorId: occupancy.doctorId,
            startedAt: occupancy.startedAt,
            endedAt: occupancy.endedAt,
            actualEndedAt: occupancy.actualEndedAt,
            scheduledEndAt: occupancy.scheduledEndAt,
            isShadow: isInterventionShadowOccupancyNotes(occupancy.notes)
                || isInterventionDisplacedOccupancyNotes(occupancy.notes),
            departureConfirmed: occupancy.departureConfirmedAt !== null,
        })),
    });

    if (identity.kind !== "merge") {
        return null;
    }

    const occupancy = candidates.find(
        (candidate: typeof interventionOccupancies.$inferSelect) => candidate.id === identity.occupancyId,
    );
    return occupancy ? { occupancy, identity } : null;
}

/**
 * Junta a chegada nova com o plantão fechado: reabre a linha em vez de criar
 * outra. A saída anterior deixa de valer (era errada), então o desfecho de
 * pagamento e a confirmação da chefia caem junto — quem confirmou confirmou uma
 * saída que não aconteceu. O que a saída foi fica escrito na nota.
 */
async function mergeInterventionArrival(tx: Executor, params: {
    target: typeof interventionOccupancies.$inferSelect;
    keptStartedAt: Date;
    previousDepartureAt: Date | null;
    arrivalAt: Date;
    notes: string | null;
    shiftLabel: string | null;
    updatedByUserId: string | null;
}) {
    // Se outro médico assumiu o quadro nesta base, reabrir com board violaria o
    // índice de um titular por base: volta fora do quadro, como deslocado.
    const boardHeldByOther = await tx.query.interventionOccupancies.findFirst({
        where: and(
            eq(interventionOccupancies.baseId, params.target.baseId),
            isNotNull(interventionOccupancies.boardStartedAt),
            isNull(interventionOccupancies.endedAt),
            ne(interventionOccupancies.id, params.target.id),
        ),
    });

    const mergeNote = describeMergedArrival({
        previousDepartureAt: params.previousDepartureAt,
        arrivalAt: params.arrivalAt,
    });

    const mergedNotes = [params.target.notes, mergeNote, params.notes]
        .filter(Boolean)
        .join("\n")
        .trim();
    // Voltou com outro médico no quadro: os dois estão na base — entra como dupla
    // (visível no painel, com remanejar/retirar) em vez de sumir sem board.
    const rejoinsAsCompanion = Boolean(boardHeldByOther)
        && !isInterventionShadowOccupancyNotes(mergedNotes)
        && !isInterventionDisplacedOccupancyNotes(mergedNotes);

    const [updated] = await tx.update(interventionOccupancies)
        .set({
            startedAt: params.keptStartedAt,
            endedAt: null,
            actualEndedAt: null,
            boardStartedAt: boardHeldByOther
                ? null
                : (params.target.boardStartedAt ?? params.keptStartedAt),
            departureConfirmedAt: null,
            departureConfirmedByUserId: null,
            departureConfirmedNote: null,
            earlyDepartureOutcome: null,
            shiftLabel: params.shiftLabel ?? params.target.shiftLabel,
            notes: rejoinsAsCompanion
                ? appendInterventionCompanionMarker(mergedNotes, params.arrivalAt)
                : mergedNotes,
            updatedByUserId: params.updatedByUserId,
            updatedAt: new Date(),
        })
        .where(eq(interventionOccupancies.id, params.target.id))
        .returning();

    return updated;
}

/**
 * "NÃO SAIU": a chefia contesta a saída registrada. Reabre a ocupação que já
 * existe — sem criar outra, sem derrubar quem estiver no quadro — e derruba o
 * desfecho de pagamento que tinha sido decidido sobre a saída contestada.
 */
export async function reopenContestedInterventionDeparture(occupancyId: string, input: {
    continuation: ContestedDepartureContinuation;
    continuedAtLabel?: string | null;
    note?: string | null;
    updatedByUserId?: string | null;
}) {
    const db = getDb();
    const result = await db.transaction(async (tx: Executor) => {
        const existing = await tx.query.interventionOccupancies.findFirst({
            where: eq(interventionOccupancies.id, occupancyId),
        });
        if (!existing) {
            throw new Error("Intervention occupancy not found.");
        }
        const contestedDepartureAt = existing.actualEndedAt ?? existing.endedAt;
        if (!contestedDepartureAt) {
            throw new Error("Esta ocupacao nao tem saida registrada para contestar.");
        }

        const laterArrival = await findLaterArrivalForDoctor(tx, {
            doctorId: existing.doctorId,
            excludeOccupancyId: existing.id,
            afterStartedAt: existing.startedAt,
            contestedDepartureAt,
        });
        if (laterArrival) {
            const [doctor, base] = await Promise.all([
                tx.query.doctors.findFirst({ where: eq(doctors.id, existing.doctorId), columns: { fullName: true } }),
                tx.query.interventionBases.findFirst({ where: eq(interventionBases.id, existing.baseId), columns: { code: true } }),
            ]);
            throw new Error(describeContestBlockedByLaterArrival({
                doctorName: doctor?.fullName ?? "O médico",
                targetCode: base?.code ?? "esta base",
                contestedDepartureAt,
                laterArrival,
            }));
        }

        const carrier = await tx.query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.baseId, existing.baseId),
                isNotNull(interventionOccupancies.boardStartedAt),
                isNull(interventionOccupancies.endedAt),
                ne(interventionOccupancies.id, existing.id),
            ),
            orderBy: [desc(interventionOccupancies.boardStartedAt)],
        });
        const carrierDoctor = carrier
            ? await tx.query.doctors.findFirst({ where: eq(doctors.id, carrier.doctorId), columns: { fullName: true } })
            : null;

        const decision = resolveContestedBoardDecision({
            continuation: input.continuation,
            boardHeldByOther: carrier
                ? {
                    doctorName: carrierDoctor?.fullName ?? "Outro médico",
                    since: carrier.boardStartedAt ?? carrier.startedAt,
                }
                : null,
            previousBoardStartedAt: existing.boardStartedAt,
            startedAt: existing.startedAt,
        });

        const [updated] = await tx.update(interventionOccupancies)
            .set({
                endedAt: null,
                actualEndedAt: null,
                boardStartedAt: decision.boardStartedAt,
                departureConfirmedAt: null,
                departureConfirmedByUserId: null,
                departureConfirmedNote: null,
                earlyDepartureOutcome: null,
                notes: [
                    existing.notes,
                    describeContestedDeparture({
                        contestedDepartureAt,
                        continuation: input.continuation,
                        continuedAtLabel: input.continuedAtLabel ?? null,
                    }),
                    input.note,
                ].filter(Boolean).join("\n").trim(),
                updatedByUserId: input.updatedByUserId ?? null,
                updatedAt: new Date(),
            })
            .where(eq(interventionOccupancies.id, existing.id))
            .returning();

        await syncInterventionBankHours(tx, existing.id);
        return { occupancy: updated, contestedDepartureAt, outOfBoardReason: decision.outOfBoardReason };
    });

    publishBoardUpdate(`intervention:reopen:${result.occupancy.baseId}`);
    return result;
}


/**
 * ADR-007 R1: sem grupo resolvido pelos caminhos explícitos (continuação,
 * remanejo, chegada anterior), procura a última posição do médico nos dois
 * domínios e, se ela pertence ao mesmo turno ou está encostada na virada,
 * herda o grupo dela. É o que faz "turno" existir para banco de horas e
 * pagamento sem tabela nova.
 */
async function resolveTurnoContinuityGroupId(tx: Executor, params: {
    doctorId: string;
    arrivalAt: Date;
    excludeRegulationId?: string | null;
    excludeInterventionId?: string | null;
}): Promise<string | null> {
    const since = new Date(params.arrivalAt.getTime() - 36 * 60 * 60 * 1000);
    const [reg, intv] = await Promise.all([
        tx.query.regulationOccupancies.findMany({
            where: and(eq(regulationOccupancies.doctorId, params.doctorId), gte(regulationOccupancies.startedAt, since)),
            columns: { id: true, startedAt: true, endedAt: true, continuityGroupId: true },
            orderBy: [desc(regulationOccupancies.startedAt)],
            limit: 5,
        }),
        tx.query.interventionOccupancies.findMany({
            where: and(eq(interventionOccupancies.doctorId, params.doctorId), gte(interventionOccupancies.startedAt, since)),
            columns: { id: true, startedAt: true, endedAt: true, continuityGroupId: true },
            orderBy: [desc(interventionOccupancies.startedAt)],
            limit: 5,
        }),
    ]);
    const candidates = [
        ...reg.filter((r: { id: string }) => r.id !== params.excludeRegulationId),
        ...intv.filter((r: { id: string }) => r.id !== params.excludeInterventionId),
    ].sort((a: { startedAt: Date }, b: { startedAt: Date }) => b.startedAt.getTime() - a.startedAt.getTime());
    const previous = candidates[0];
    if (!previous) return null;
    return shouldJoinDoctorTurnoGroup({
        previousStartedAt: previous.startedAt,
        previousEndedAt: previous.endedAt,
        arrivalAt: params.arrivalAt,
    })
        ? previous.continuityGroupId
        : null;
}

export async function startInterventionOccupancy(input: StartInterventionOccupancyInput) {
    const db = getDb();
    const now = new Date();
    let autoReactivated = false;
    let closedPreviousBaseId: number | null = null;
    let joinsAsCompanion = false;
    /** Titular com quem esta chegada passou a dividir a base (dupla). */
    let sharedWithDoctorId = null as string | null;
    await expireStaleShadowInterventionOccupancies(input.startedAt, input.createdByUserId ?? null);
    const created = await db.transaction(async (tx) => {
        const doctor = await tx.query.doctors.findFirst({
            where: eq(doctors.id, input.doctorId),
            columns: { metadata: true },
        });
        const defaultDoctorRoleLabel = input.roleLabel ?? extractDoctorPreferredOperationalRole(doctor?.metadata);

        let resolvedContinuityGroupId = input.continuityGroupId ?? null;
        if (!resolvedContinuityGroupId && input.previousOccupancyId) {
            const previous = await tx.query.interventionOccupancies.findFirst({
                where: eq(interventionOccupancies.id, input.previousOccupancyId),
                columns: { continuityGroupId: true },
            });
            if (!previous) {
                const previousReg = await tx.query.regulationOccupancies.findFirst({
                    where: eq(regulationOccupancies.id, input.previousOccupancyId),
                    columns: { continuityGroupId: true },
                });
                resolvedContinuityGroupId = previousReg?.continuityGroupId ?? null;
            } else {
                resolvedContinuityGroupId = previous.continuityGroupId ?? null;
            }
        }

        // Step 2: auto-resolve for continuity entries — find doctor's most recent occupancy
        if (input.isContinuityEntry && !resolvedContinuityGroupId) {
            const latestInt = await tx.query.interventionOccupancies.findFirst({
                where: eq(interventionOccupancies.doctorId, input.doctorId),
                orderBy: [desc(interventionOccupancies.startedAt)],
                columns: { continuityGroupId: true, boardStartedAt: true, startedAt: true, endedAt: true },
            });
            const latestReg = await tx.query.regulationOccupancies.findFirst({
                where: eq(regulationOccupancies.doctorId, input.doctorId),
                orderBy: [desc(regulationOccupancies.startedAt)],
                columns: { continuityGroupId: true, boardStartedAt: true, startedAt: true, endedAt: true },
            });
            const latest = latestInt && latestReg
                ? (latestInt.startedAt.getTime() >= latestReg.startedAt.getTime() ? latestInt : latestReg)
                : (latestInt ?? latestReg);
            if (latest && shouldReuseImplicitContinuitySource(input.startedAt, latest.endedAt ?? null)) {
                resolvedContinuityGroupId = latest.continuityGroupId;
            }
        }

        // Step 3: walk the continuity chain to find the earliest boardStartedAt
        let resolvedBoardStartedAt: Date | null = input.boardStartedAt ?? null;
        if (input.isContinuityEntry && resolvedContinuityGroupId && !input.boardStartedAt) {
            const earliestInt = await tx.query.interventionOccupancies.findFirst({
                where: and(
                    eq(interventionOccupancies.doctorId, input.doctorId),
                    eq(interventionOccupancies.continuityGroupId, resolvedContinuityGroupId),
                ),
                orderBy: [asc(interventionOccupancies.boardStartedAt)],
                columns: { boardStartedAt: true, startedAt: true },
            });
            const earliestReg = await tx.query.regulationOccupancies.findFirst({
                where: and(
                    eq(regulationOccupancies.doctorId, input.doctorId),
                    eq(regulationOccupancies.continuityGroupId, resolvedContinuityGroupId),
                ),
                orderBy: [asc(regulationOccupancies.boardStartedAt)],
                columns: { boardStartedAt: true, startedAt: true },
            });
            const candidates = [earliestInt, earliestReg].filter(Boolean) as { boardStartedAt: Date; startedAt: Date }[];
            if (candidates.length > 0) {
                const earliest = candidates.reduce((best, current) => {
                    const bestTime = (best.boardStartedAt ?? best.startedAt).getTime();
                    const curTime = (current.boardStartedAt ?? current.startedAt).getTime();
                    return curTime < bestTime ? current : best;
                });
                resolvedBoardStartedAt = earliest.boardStartedAt ?? earliest.startedAt;
            }
        }

        const effectiveBoardStartedAt = resolvedBoardStartedAt ?? input.startedAt;

        const windowReferenceAt = effectiveBoardStartedAt.getTime() > input.startedAt.getTime()
            ? effectiveBoardStartedAt
            : input.startedAt;
        const normalizedShiftLabel = input.shiftLabel ?? resolveArrivalShiftLabel(windowReferenceAt);
        const { scheduledStartAt: inferredScheduledStartAt, scheduledEndAt: inferredScheduledEndAt } = inferInterventionCoverageWindow({
            startedAt: windowReferenceAt,
            shiftLabel: normalizedShiftLabel,
            explicitScheduledStartAt: input.scheduledStartAt ?? null,
            explicitScheduledEndAt: input.scheduledEndAt ?? null,
        });
        const historicalCorrectionEndAt = resolveHistoricalInterventionAdminCorrectionEndAt({
            source: input.source,
            startedAt: input.startedAt,
            inferredScheduledEndAt,
            now,
        });
        const activationReferenceAt = resolveInterventionOccupancyActivationReferenceAt({
            startedAt: input.startedAt,
            scheduledStartAt: inferredScheduledStartAt,
        });
        const activeDeactivation = await findActiveInterventionBaseDeactivation(tx, {
            baseId: input.baseId,
            referenceAt: activationReferenceAt,
            updatedByUserId: input.createdByUserId ?? null,
        });

        if (activeDeactivation) {
            // Auto-reactivate: doctor arrival implicitly reactivates the base.
            // Fecha TODAS as janelas de desativação já vigentes e ainda abertas (não só a
            // mais recente): janelas sobrepostas antigas ficavam órfãs (reactivated_at NULL)
            // e faziam a base parecer "desativada" para o remanejamento mesmo com is_active
            // true e médico em plantão. Janelas futuras (deactivatedAt > referência) são
            // preservadas.
            await tx.update(interventionBaseDeactivations)
                .set({
                    reactivatedAt: input.startedAt,
                    updatedByUserId: input.createdByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(and(
                    eq(interventionBaseDeactivations.baseId, input.baseId),
                    isNull(interventionBaseDeactivations.reactivatedAt),
                    lte(interventionBaseDeactivations.deactivatedAt, activationReferenceAt),
                ));
            autoReactivated = true;
        }
        const existingSameDoctor = await tx.query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.baseId, input.baseId),
                eq(interventionOccupancies.doctorId, input.doctorId),
                isNull(interventionOccupancies.endedAt),
            ),
            orderBy: [desc(interventionOccupancies.boardStartedAt), desc(interventionOccupancies.startedAt)],
        });

        // Same doctor on same base: update in place instead of close+create.
        if (existingSameDoctor) {
            // Preserve the earliest boardStartedAt — but only if it belongs to the current
            // operational shift context. A stale anchor from a past shift would cause the
            // occupancy to be invisible on the board (board-rules visibility check would expire it).
            const currentShiftStart = resolveOperationalShiftWindow(input.startedAt).startedAt;
            // Sombra redeclarada SEM a palavra "sombra": assumiu de fato a base e vira
            // titular no lugar — board gravado, marcador fora das notas, chegada
            // preservada. Espelha a regra da regulação.
            const otherBoardCarrier = await tx.query.interventionOccupancies.findFirst({
                where: and(
                    eq(interventionOccupancies.baseId, input.baseId),
                    ne(interventionOccupancies.doctorId, input.doctorId),
                    isNotNull(interventionOccupancies.boardStartedAt),
                    isNull(interventionOccupancies.endedAt),
                ),
            });
            const promotingShadow = shouldPromoteShadowToBoardOnRearrival({
                existingHasBoard: existingSameDoctor.boardStartedAt !== null,
                existingIsShadow: isInterventionShadowOccupancyNotes(existingSameDoctor.notes),
                existingIsDisplaced: isInterventionDisplacedOccupancyNotes(existingSameDoctor.notes),
                arrivingIsShadow: Boolean(input.isShadow),
                hasOtherBoardCarrier: Boolean(otherBoardCarrier),
            });
            // F2 safety: never allow started_at to advance forward past the existing value.
            const keptStartedAt = input.startedAt.getTime() < existingSameDoctor.startedAt.getTime()
                ? input.startedAt
                : existingSameDoctor.startedAt;

            // Deslocado que reassume volta ao quadro com a PRIMEIRA chegada, nunca com a
            // hora do reenvio — senão a janela do turno é recalculada pela mensagem nova.
            const keptBoardStartedAt = promotingShadow
                ? (isInterventionDisplacedOccupancyNotes(existingSameDoctor.notes) ? keptStartedAt : effectiveBoardStartedAt)
                : resolveSameDoctorBoardStartedAt({
                    existingStartedAt: existingSameDoctor.startedAt,
                    existingBoardStartedAt: existingSameDoctor.boardStartedAt,
                    effectiveBoardStartedAt,
                    currentShiftStart,
                    withinOwnWindow: isRearrivalWithinOwnWindow({
                        existingScheduledEndAt: existingSameDoctor.scheduledEndAt,
                        existingShiftLabel: existingSameDoctor.shiftLabel,
                        incomingAt: input.startedAt,
                        incomingShiftLabel: input.shiftLabel,
                    }),
                });

            const keptContinuityGroupId = resolvedContinuityGroupId ?? existingSameDoctor.continuityGroupId;

            const windowRef = keptBoardStartedAt && keptBoardStartedAt.getTime() > keptStartedAt.getTime()
                ? keptBoardStartedAt : keptStartedAt;
            const {
                baseShiftLabel: recalcBaseShiftLabel,
                scheduledStartAt: recalcStart,
                scheduledEndAt: recalcEnd,
            } = inferInterventionCoverageWindow({
                startedAt: windowRef,
                shiftLabel: input.shiftLabel ?? existingSameDoctor.shiftLabel,
                explicitScheduledStartAt: null,
                explicitScheduledEndAt: null,
            });
            const requestedRoleLabel = input.roleLabel !== undefined ? input.roleLabel : existingSameDoctor.roleLabel;
            const nextRoleLabel = applyOperationalRoleShiftPolicy({
                shiftLabel: recalcBaseShiftLabel,
                roleLabel: requestedRoleLabel,
            });

            const [updated] = await tx.update(interventionOccupancies)
                .set({
                    startedAt: keptStartedAt,
                    boardStartedAt: keptBoardStartedAt,
                    continuityGroupId: keptContinuityGroupId,
                    scheduledStartAt: recalcStart,
                    scheduledEndAt: recalcEnd,
                    shiftLabel: input.shiftLabel ?? existingSameDoctor.shiftLabel,
                    roleLabel: nextRoleLabel,
                    notes: resolveRearrivalNotes({
                        existingNotes: existingSameDoctor.notes,
                        incomingNotes: input.notes,
                        promotingShadow,
                    }),
                    updatedByUserId: input.createdByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(eq(interventionOccupancies.id, existingSameDoctor.id))
                .returning();

            await syncInterventionBankHours(tx, existingSameDoctor.id);
            return updated;
        }

        // Plantão do mesmo médico nesta base JÁ FECHADO, mas cuja janela ainda
        // cobre esta chegada: é o mesmo plantão sendo redeclarado depois de uma
        // saída errada (ou de uma rendição indevida), não um plantão novo.
        // Sem isto nascia a duplicata — 131 dos 149 pares sobrepostos dos últimos
        // 4 meses caíram exatamente aqui.
        const mergeTarget = input.isShadow || historicalCorrectionEndAt
            ? null
            : await resolveInterventionArrivalMergeTarget(tx, {
                baseId: input.baseId,
                doctorId: input.doctorId,
                startedAt: input.startedAt,
            });

        if (mergeTarget) {
            const merged = await mergeInterventionArrival(tx, {
                target: mergeTarget.occupancy,
                keptStartedAt: mergeTarget.identity.keptStartedAt,
                previousDepartureAt: mergeTarget.identity.previousDepartureAt,
                arrivalAt: input.startedAt,
                notes: input.notes ?? null,
                shiftLabel: input.shiftLabel ?? null,
                updatedByUserId: input.createdByUserId ?? null,
            });
            await syncInterventionBankHours(tx, merged.id);
            return merged;
        }

        const otherBaseOccupancy = await tx.query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.doctorId, input.doctorId),
                ne(interventionOccupancies.baseId, input.baseId),
                isNull(interventionOccupancies.endedAt),
            ),
            orderBy: [desc(interventionOccupancies.startedAt)],
        });

        const shouldPreserveDoctorCurrentOtherBase = Boolean(
            historicalCorrectionEndAt
            && otherBaseOccupancy
            && input.startedAt.getTime() < otherBaseOccupancy.startedAt.getTime(),
        );

        if (otherBaseOccupancy && !shouldPreserveDoctorCurrentOtherBase) {
            const otherCloseAt = resolveSafeInterventionHandoffAt({
                sourceStartedAt: otherBaseOccupancy.startedAt,
                requestedAt: input.startedAt,
            });

            if (otherCloseAt) {
                await tx.update(interventionOccupancies)
                    .set({
                        endedAt: otherCloseAt,
                        // ADR-007 R2: mudança de posição não é saída. ended_at fecha a posição;
                        // actual_ended_at fica nulo (só aviso do médico, chefe ou janela gravam saída).
                        actualEndedAt: null,
                        // Mudança de base do próprio médico: nasce confirmado, não
                        // entra na fila do chefe (nada a decidir — ele segue no plantão).
                        departureConfirmedAt: otherBaseOccupancy.departureConfirmedAt ?? otherCloseAt,
                        departureConfirmedNote: otherBaseOccupancy.departureConfirmedNote ?? "Saida por mudanca de posto/base: chegada registrada em outro alvo.",
                        updatedByUserId: input.createdByUserId ?? null,
                        updatedAt: new Date(),
                    })
                    .where(eq(interventionOccupancies.id, otherBaseOccupancy.id));

                if (otherBaseOccupancy.boardStartedAt) {
                    await promoteInterventionBoardReplacement(tx, {
                        baseId: otherBaseOccupancy.baseId,
                        vacatedAt: otherCloseAt,
                        updatedByUserId: input.createdByUserId ?? null,
                    });
                }

                await syncInterventionBankHours(tx, otherBaseOccupancy.id);
                closedPreviousBaseId = otherBaseOccupancy.baseId;
            }

            if (!resolvedContinuityGroupId && shouldInheritContinuityFromOtherBaseOccupancy({
                otherBaseStartedAt: otherBaseOccupancy.startedAt,
                eventAt: input.startedAt,
            })) {
                resolvedContinuityGroupId = otherBaseOccupancy.continuityGroupId;
            }
        }

        // Cross-domain cleanup: close open regulation occupancy when doctor moves to an intervention base.
        // Symmetric counterpart to the same guard in startRegulationOccupancy.
        const otherRegulationOccupancy = await tx.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.doctorId, input.doctorId),
                isNull(regulationOccupancies.endedAt),
            ),
            orderBy: [desc(regulationOccupancies.startedAt)],
        });
        const shouldPreserveCrossRegulation = Boolean(
            historicalCorrectionEndAt
            && otherRegulationOccupancy
            && input.startedAt.getTime() < otherRegulationOccupancy.startedAt.getTime(),
        );
        if (otherRegulationOccupancy && !shouldPreserveCrossRegulation) {
            const crossCloseMs = input.startedAt.getTime() - otherRegulationOccupancy.startedAt.getTime();
            if (crossCloseMs >= 60_000) {
                await tx.update(regulationOccupancies)
                    .set({
                        endedAt: input.startedAt,
                        actualEndedAt: otherRegulationOccupancy.actualEndedAt ?? null,
                        departureConfirmedAt: otherRegulationOccupancy.departureConfirmedAt ?? input.startedAt,
                        departureConfirmedNote: otherRegulationOccupancy.departureConfirmedNote ?? "Saida por mudanca de posto/base: chegada registrada em outro alvo.",
                        updatedByUserId: input.createdByUserId ?? null,
                        updatedAt: new Date(),
                    })
                    .where(eq(regulationOccupancies.id, otherRegulationOccupancy.id));
                await syncRegulationBankHours(tx, otherRegulationOccupancy.id);
            }
        }

        const currentBoardCarrier = await tx.query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.baseId, input.baseId),
                isNotNull(interventionOccupancies.boardStartedAt),
                isNull(interventionOccupancies.endedAt),
            ),
            orderBy: [desc(interventionOccupancies.boardStartedAt), desc(interventionOccupancies.startedAt)],
        });
        const { shouldTakeBoardImmediately } = resolveInterventionArrivalBoardPolicy({
            source: input.source,
            isShadow: input.isShadow ?? false,
        });

        const shouldPreserveCurrentBoardCarrier = Boolean(
            historicalCorrectionEndAt
            && currentBoardCarrier
            && input.startedAt.getTime() < currentBoardCarrier.startedAt.getTime(),
        );

        // Titular com cobertura vigente nunca é encerrado pela chegada de outro:
        // quem chega divide a base com ele (dupla), fora do quadro.
        joinsAsCompanion = shouldTakeBoardImmediately
            && !shouldPreserveCurrentBoardCarrier
            && shouldJoinInterventionBaseAsCompanion({
                carrier: currentBoardCarrier,
                arrivingDoctorId: input.doctorId,
                arrivalAt: input.startedAt,
                arrivingIsShadow: input.isShadow,
            });
        if (joinsAsCompanion && currentBoardCarrier) {
            sharedWithDoctorId = currentBoardCarrier.doctorId;
        }

        if (shouldTakeBoardImmediately && currentBoardCarrier && !shouldPreserveCurrentBoardCarrier && !joinsAsCompanion) {
            const shouldCloseCurrentBoardCarrier = shouldCloseInterventionBoardCarrierOnArrival({
                currentCarrierDoctorId: currentBoardCarrier.doctorId,
                arrivingDoctorId: input.doctorId,
                currentCarrierNotes: currentBoardCarrier.notes,
            });
            const takeoverAt = resolveSafeInterventionHandoffAt({
                sourceStartedAt: currentBoardCarrier.startedAt,
                requestedAt: input.startedAt,
            });

            // P2: guard against zero-duration occupancies caused by retroactive or duplicate arrivals.
            if (!takeoverAt && shouldCloseCurrentBoardCarrier) {
                throw new Error("arrival_conflicts_with_active_occupancy");
            }

            if (takeoverAt && shouldCloseCurrentBoardCarrier) {
                await tx.update(interventionOccupancies)
                    .set({
                        endedAt: takeoverAt,
                        actualEndedAt: takeoverAt,
                        updatedByUserId: input.createdByUserId ?? null,
                        updatedAt: new Date(),
                    })
                    .where(eq(interventionOccupancies.id, currentBoardCarrier.id));

                await syncInterventionBankHours(tx, currentBoardCarrier.id);
            }
        }

        if (!resolvedContinuityGroupId) {
            resolvedContinuityGroupId = await resolveTurnoContinuityGroupId(tx, {
                doctorId: input.doctorId,
                arrivalAt: input.startedAt,
            });
        }

        const [created] = await tx.insert(interventionOccupancies).values({
            doctorId: input.doctorId,
            baseId: input.baseId,
            continuityGroupId: resolvedContinuityGroupId ?? randomUUID(),
            scheduledStartAt: inferredScheduledStartAt,
            scheduledEndAt: inferredScheduledEndAt,
            startedAt: input.startedAt,
            boardStartedAt: shouldTakeBoardImmediately && !currentBoardCarrier ? effectiveBoardStartedAt : null,
            shiftLabel: normalizedShiftLabel,
            roleLabel: applyOperationalRoleShiftPolicy({
                shiftLabel: normalizedShiftLabel === "SD" || normalizedShiftLabel === "SN" || normalizedShiftLabel === "P"
                    ? normalizedShiftLabel
                    : null,
                roleLabel: defaultDoctorRoleLabel,
            }),
            source: input.source,
            notes: joinsAsCompanion && !historicalCorrectionEndAt
                ? appendInterventionCompanionMarker(input.notes, input.startedAt)
                : input.notes ?? null,
            endedAt: historicalCorrectionEndAt,
            actualEndedAt: historicalCorrectionEndAt,
            createdByUserId: input.createdByUserId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
        }).returning();

        if (shouldTakeBoardImmediately && !historicalCorrectionEndAt && !joinsAsCompanion) {
            await tx.update(interventionOccupancies)
                .set({
                    boardStartedAt: null,
                    updatedByUserId: input.createdByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(and(
                    eq(interventionOccupancies.baseId, input.baseId),
                    isNull(interventionOccupancies.endedAt),
                ));

            await tx.update(interventionOccupancies)
                .set({
                    boardStartedAt: input.boardStartedAt ?? input.startedAt,
                    updatedByUserId: input.createdByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(eq(interventionOccupancies.id, created.id));
        }

        if (historicalCorrectionEndAt) {
            await syncInterventionBankHours(tx, created.id);
        }

        return created;
    });

    publishBoardUpdate(`intervention:start:${input.baseId}`);
    if (closedPreviousBaseId) {
        publishBoardUpdate(`intervention:end:${closedPreviousBaseId}`);
    }
    if (autoReactivated) {
        publishBoardUpdate(`intervention:reactivate:${input.baseId}`);
    }
    return { ...created, autoReactivated, sharedWithDoctorId };
}

export async function deactivateInterventionBase(input: DeactivateInterventionBaseInput) {
    await assertInterventionBaseExists(input.baseId);

    const db = getDb();
    const result = await db.transaction(async (tx) => {
        const activeDeactivation = await findActiveInterventionBaseDeactivation(tx, {
            baseId: input.baseId,
            referenceAt: input.deactivatedAt,
            updatedByUserId: input.createdByUserId ?? null,
        });

        if (activeDeactivation) {
            throw new Error("Esta base já está desativada.");
        }

        const openOccupancies = await tx.query.interventionOccupancies.findMany({
            where: and(
                eq(interventionOccupancies.baseId, input.baseId),
                isNull(interventionOccupancies.endedAt),
            ),
            orderBy: [asc(interventionOccupancies.startedAt)],
        });

        const [created] = await tx.insert(interventionBaseDeactivations).values({
            baseId: input.baseId,
            deactivatedAt: input.deactivatedAt,
            notes: input.notes ?? null,
            createdByUserId: input.createdByUserId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
        }).returning();

        const closedOccupancyIds: string[] = [];
        const closedOccupancies: Array<{ id: string; doctorId: string; endedAt: Date; earlyDepartureOutcome: string | null }> = [];
        for (const occupancy of openOccupancies) {
            const endedAt = clampOccupancyEndAt(occupancy.startedAt, input.deactivatedAt);

            // Desativar com ocupante é uma retirada decidida pela chefia:
            // aplica a régua de saída antecipada e grava o desfecho.
            const earlyDepartureOutcome = isEarlyDepartureEligible({ roleLabel: occupancy.roleLabel })
                ? classifyEarlyDeparture({
                    departureAt: endedAt,
                    scheduledStartAt: occupancy.scheduledStartAt,
                    scheduledEndAt: occupancy.scheduledEndAt,
                    startedAt: occupancy.startedAt,
                }).outcome
                : occupancy.earlyDepartureOutcome;

            await tx.update(interventionOccupancies)
                .set({
                    endedAt,
                    actualEndedAt: endedAt,
                    earlyDepartureOutcome,
                    updatedByUserId: input.createdByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(eq(interventionOccupancies.id, occupancy.id));

            await syncInterventionBankHours(tx, occupancy.id);
            closedOccupancyIds.push(occupancy.id);
            closedOccupancies.push({ id: occupancy.id, doctorId: occupancy.doctorId, endedAt, earlyDepartureOutcome });
        }

        return {
            state: created,
            closedOccupancyIds,
            closedOccupancies,
        };
    });

    publishBoardUpdate(`intervention:deactivate:${input.baseId}`);
    return result;
}

export async function endInterventionOccupancy(
    id: string,
    input: {
        endedAt: Date;
        actualEndedAt?: Date | null;
        chiefConfirmed?: boolean;
        handoffClosure?: boolean;
        /** Retirada decidida pela chefia: aplica a régua de saída antecipada
         *  (modules/operational/early-departure.ts) e grava o desfecho. */
        chiefWithdrawal?: boolean;
    },
    updatedByUserId?: string | null,
) {
    const db = getDb();
    const updated = await db.transaction(async (tx) => {
        const existing = await tx.query.interventionOccupancies.findFirst({
            where: eq(interventionOccupancies.id, id),
        });

        if (!existing) {
            throw new Error("Intervention occupancy not found.");
        }

        // Fechamento por rendição: grava só endedAt e deixa actualEndedAt nulo, para que o banco
        // feche autoritativamente no horário do handoff sem cair na fila de confirmação do chefe.
        // Um aviso de saída tardia posterior (ocorrência) preenche actualEndedAt e aí sim exige confirmação.
        const actualEndedAt = input.handoffClosure
            ? (input.actualEndedAt ?? null)
            : (input.actualEndedAt ?? input.endedAt);
        if (actualEndedAt && actualEndedAt.getTime() < existing.startedAt.getTime()) {
            throw new Error("Actual end cannot be before the recorded arrival.");
        }

        // P que saiu antes de 6h do turno seguinte volta a ser o turno cumprido
        // (modules/operational/multi-segment-departure.ts).
        const departureTrim = resolveMultiSegmentDepartureTrim({
            domain: "intervention",
            scheduledStartAt: existing.scheduledStartAt,
            scheduledEndAt: existing.scheduledEndAt,
            departureAt: actualEndedAt ?? input.endedAt,
        });

        const now = new Date();
        const departureConfirmedAt = input.chiefConfirmed ? now : existing.departureConfirmedAt;
        const departureConfirmedByUserId = input.chiefConfirmed
            ? (updatedByUserId ?? null)
            : existing.departureConfirmedByUserId;

        const earlyDepartureOutcome = input.chiefWithdrawal
            && isEarlyDepartureEligible({ roleLabel: existing.roleLabel })
            ? classifyEarlyDeparture({
                departureAt: actualEndedAt ?? input.endedAt,
                scheduledStartAt: existing.scheduledStartAt,
                scheduledEndAt: departureTrim?.scheduledEndAt ?? existing.scheduledEndAt,
                startedAt: existing.startedAt,
            }).outcome
            : existing.earlyDepartureOutcome;

        const [updated] = await tx
            .update(interventionOccupancies)
            .set({
                endedAt: input.endedAt,
                actualEndedAt,
                earlyDepartureOutcome,
                ...(departureTrim ? { scheduledEndAt: departureTrim.scheduledEndAt, shiftLabel: departureTrim.shiftLabel } : {}),
                updatedByUserId: updatedByUserId ?? null,
                updatedAt: now,
                departureConfirmedAt,
                departureConfirmedByUserId,
            })
            .where(eq(interventionOccupancies.id, id))
            .returning();

        // Só quem tinha o board libera vaga no quadro. Fechar sombra/deslocado
        // não pode promover outro aberto sem board: a base pode já ter titular
        // e a promoção estoura o índice de um titular por base (incidente
        // 2026-09-15: registro reaberto por "NÃO SAIU" promovido em cima do
        // titular da noite, derrubando todo carregamento do quadro e o bot).
        if (existing.boardStartedAt) {
            await promoteInterventionBoardReplacement(tx, {
                baseId: existing.baseId,
                vacatedAt: input.endedAt,
                updatedByUserId: updatedByUserId ?? null,
            });
        }

        await syncInterventionBankHours(tx, id);
        return updated;
    });

    publishBoardUpdate(`intervention:end:${id}`);
    return updated;
}

export async function expireStaleShadowInterventionOccupancies(referenceAt: Date, updatedByUserId?: string | null) {
    const db = getDb();
    const [openOccupancies, dayOnlyBaseRows] = await Promise.all([
        db.query.interventionOccupancies.findMany({
            where: isNull(interventionOccupancies.endedAt),
            orderBy: [asc(interventionOccupancies.scheduledEndAt), asc(interventionOccupancies.startedAt)],
        }),
        db.query.interventionBases.findMany({
            where: eq(interventionBases.dayOnly, true),
            columns: { id: true },
        }),
    ]);
    const dayOnlyBaseIds = new Set(dayOnlyBaseRows.map((row) => row.id));

    let expiredCount = 0;
    for (const occupancy of openOccupancies) {
        const endedAt = resolveStaleShadowInterventionEndedAt({
            notes: occupancy.notes,
            boardStartedAt: occupancy.boardStartedAt,
            scheduledEndAt: occupancy.scheduledEndAt,
            endedAt: occupancy.endedAt,
            referenceAt,
        }) ?? resolveDayOnlyBaseAutoCloseEndedAt({
            dayOnly: dayOnlyBaseIds.has(occupancy.baseId),
            scheduledEndAt: occupancy.scheduledEndAt,
            endedAt: occupancy.endedAt,
            referenceAt,
        });

        if (!endedAt) {
            continue;
        }

        // Stale shadow cleanup is system-initiated; no verbalized late departure
        // to audit. Auto-confirm so credit flows without a chief review queue
        // backlogged with stale entries.
        await endInterventionOccupancy(occupancy.id, {
            endedAt,
            actualEndedAt: endedAt,
            chiefConfirmed: true,
        }, updatedByUserId ?? null);
        expiredCount += 1;
    }

    return expiredCount;
}

export async function continueInterventionOccupancy(
    id: string,
    input?: { notes?: string | null; continuedAt?: Date | null },
    updatedByUserId?: string | null,
) {
    const db = getDb();
    const updated = await db.transaction(async (tx) => {
        const existing = await tx.query.interventionOccupancies.findFirst({
            where: eq(interventionOccupancies.id, id),
        });

        if (!existing) {
            throw new Error("Intervention occupancy not found.");
        }

        if (existing.endedAt) {
            throw new Error("Only active intervention occupancies can be continued.");
        }

        const base = await tx.query.interventionBases.findFirst({
            where: eq(interventionBases.id, existing.baseId),
            columns: { dayOnly: true },
        });
        if (base?.dayOnly) {
            throw new Error("Base diurna não gera plantão contínuo (P); a chegada seguinte deve ser um novo plantão SD.");
        }

        const nextNotes = input?.notes?.trim()
            ? input.notes.trim()
            : existing.notes;
        const baseShiftLabel = existing.shiftLabel && existing.shiftLabel !== "P"
            ? existing.shiftLabel
            : resolveOperationalShiftWindow(existing.startedAt).shiftLabel;
        const inferredScheduledStartAt = existing.scheduledStartAt
            ?? inferOperationalScheduledStartAt(existing.startedAt, baseShiftLabel, null);
        const continuationAt = input?.continuedAt ?? new Date();
        const nextScheduledEndAt = resolveInterventionContinuationScheduledEndAt({
            existingScheduledEndAt: existing.scheduledEndAt,
            continuationAt,
        });
        // Quem continua FORA do quadro (dupla, deslocado, sombra) com outro titular
        // na base segue fora dele: dar board aqui estouraria o índice de um titular
        // por base (23505 cru no "continua" de quem divide a USA).
        const boardHeldByOther = existing.boardStartedAt
            ? null
            : await tx.query.interventionOccupancies.findFirst({
                where: and(
                    eq(interventionOccupancies.baseId, existing.baseId),
                    isNotNull(interventionOccupancies.boardStartedAt),
                    isNull(interventionOccupancies.endedAt),
                    ne(interventionOccupancies.id, existing.id),
                ),
                columns: { id: true },
            });
        const nextBoardStartedAt = boardHeldByOther
            ? null
            : resolveContinuationBoardStartedAt({
                startedAt: existing.startedAt,
                boardStartedAt: existing.boardStartedAt,
                continuedAt: continuationAt,
            });
        const nextShiftLabel = resolveContinuationInPlaceShiftLabel({
            existingStartedAt: existing.startedAt,
            existingShiftLabel: existing.shiftLabel,
            fallbackShiftLabel: baseShiftLabel,
            continuationAt,
        });

        const [updated] = await tx
            .update(interventionOccupancies)
            .set({
                boardStartedAt: nextBoardStartedAt,
                shiftLabel: nextShiftLabel,
                scheduledStartAt: inferredScheduledStartAt,
                scheduledEndAt: nextScheduledEndAt,
                // "continua" troca as notas pelo texto da mensagem: quem segue fora do
                // quadro mantém o marcador que o deixa visível; [DUPLA] acompanha sempre.
                notes: nextBoardStartedAt
                    ? preserveInterventionCompanionMarker(existing.notes, nextNotes)
                    : preserveInterventionOffBoardMarkers(existing.notes, nextNotes),
                updatedByUserId: updatedByUserId ?? null,
                updatedAt: new Date(),
            })
            .where(eq(interventionOccupancies.id, id))
            .returning();

        await syncInterventionBankHours(tx, id);
        return updated;
    });

    publishBoardUpdate(`intervention:continue:${id}`);
    return updated;
}

export async function reactivateInterventionBase(input: ReactivateInterventionBaseInput) {
    await assertInterventionBaseExists(input.baseId);

    const db = getDb();
    const result = await db.transaction(async (tx) => {
        const reactivatedAt = input.reactivatedAt ?? new Date();
        const activeDeactivation = await findActiveInterventionBaseDeactivation(tx, {
            baseId: input.baseId,
            referenceAt: reactivatedAt,
            updatedByUserId: input.updatedByUserId ?? null,
        });

        if (!activeDeactivation) {
            throw new Error("Esta base não está desativada.");
        }

        if (reactivatedAt.getTime() < activeDeactivation.deactivatedAt.getTime()) {
            throw new Error("A reativação não pode ser anterior à desativação.");
        }

        const [updated] = await tx.update(interventionBaseDeactivations)
            .set({
                reactivatedAt,
                updatedByUserId: input.updatedByUserId ?? null,
                updatedAt: new Date(),
            })
            .where(eq(interventionBaseDeactivations.id, activeDeactivation.id))
            .returning();

        return updated;
    });

    publishBoardUpdate(`intervention:reactivate:${input.baseId}`);
    return result;
}
