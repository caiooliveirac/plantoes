/*
 * Classificação da chegada — "que tipo de aviso é este?" — sem I/O.
 *
 * Regra de docs/chegada.md: a decisão de o que fazer com um aviso de chegada
 * mora aqui, em funções puras (sem banco, sem relógio implícito: "agora" entra
 * como parâmetro). modules/telegram/service.ts carrega o estado do banco, chama
 * estas funções e executa o efeito. Quem mexer numa regra de chegada muda AQUI
 * e prova com tests/arrival-classification.test.ts; o comportamento de ponta a
 * ponta está travado em tests/telegram-arrival-characterization.test.ts.
 *
 * O que NÃO está aqui (depende de I/O no meio da decisão ou é de outra camada):
 * re-chegada in-place/stale/junção (resolveArrivalIdentity em
 * modules/operational/occupancy-identity.ts, chamado dentro de start*Occupancy),
 * escolha da fonte de continuidade (findTelegramContinuityContext), PIAM
 * (depende do cadastro do médico) e a rendição forçada por conflito de
 * continuação (decidida pelo erro que start*Occupancy devolve).
 */

import {
    getSaoPauloParts,
    resolveArrivalShiftLabel,
    resolveOperationalShiftWindow,
    resolveProlongedShiftExpiry,
} from "@/modules/operational/board-rules";
import { isBeforeHalfShiftWindow, isWithinHalfShiftWindow } from "@/modules/operational/half-shift";
import type { ParsedMessage } from "@/modules/telegram/parser";

/** Entrada operacional já parseada (o `parsed` das pendências do bot). */
export type ArrivalParsedEntry = {
    sector: "REGULATION" | "INTERVENTION";
    baseCode: string;
    arrivalTime: string | null;
    shiftType: "SD" | "SN" | "P" | null;
    roleFunction: string | null;
    isShadow?: boolean;
    isDeparture: boolean;
    isContinuation: boolean;
    isReassignment: boolean;
    /** Turno escolhido pelo médico no botão/resposta da pendência (D7). */
    shiftLabelConfirmed?: boolean;
};

type OperationalParsedEntry = ArrivalParsedEntry;

// Emily, 2034, 07/09/2026: "2034 sd" às 19:08:05 e "2034 sn" às 19:08:15 viraram SD
// continuando em SN (janela 07:00 → 07:15 do dia seguinte). Quem emenda SD→SN de
// verdade chegou horas antes; rótulo trocado minutos depois da própria chegada é
// correção — segue como re-chegada, que troca o rótulo e preserva a chegada.
const SHIFT_LABEL_CORRECTION_WINDOW_MS = 15 * 60 * 1000;

export function isTelegramShiftLabelCorrection(params: {
    incomingShiftLabel?: string | null;
    activeShiftLabel?: string | null;
    activeStartedAt?: Date | null;
    eventAt?: Date | null;
}) {
    if (!params.activeStartedAt || !params.eventAt) {
        return false;
    }
    const swapsDayNight = (params.incomingShiftLabel === "SD" && params.activeShiftLabel === "SN")
        || (params.incomingShiftLabel === "SN" && params.activeShiftLabel === "SD");
    if (!swapsDayNight) {
        return false;
    }
    const elapsedMs = params.eventAt.getTime() - params.activeStartedAt.getTime();
    return elapsedMs >= 0 && elapsedMs <= SHIFT_LABEL_CORRECTION_WINDOW_MS;
}

export function shouldTreatTelegramArrivalAsContinuation(params: {
    sector: "REGULATION" | "INTERVENTION";
    isDeparture: boolean;
    isContinuation: boolean;
    incomingShiftLabel?: string | null;
    activeShiftLabel?: string | null;
    // Quando informados, troca de rótulo SD↔SN logo depois da própria chegada é
    // correção de digitação, não continuação (defeito D2 de docs/chegada.md).
    activeStartedAt?: Date | null;
    eventAt?: Date | null;
}) {
    if (params.isDeparture) {
        return false;
    }

    if (params.isContinuation) {
        return true;
    }

    if (isTelegramShiftLabelCorrection(params)) {
        return false;
    }

    if (params.sector === "REGULATION") {
        if (params.incomingShiftLabel === "P") {
            return params.activeShiftLabel === "SD"
                || params.activeShiftLabel === "SN"
                || params.activeShiftLabel === "P";
        }

        // Explicit cross-shift updates in regulation must keep continuity instead of opening
        // a brand-new arrival (ex.: SD→SN, P→SN, SN→SD, P→SD).
        if (
            (params.incomingShiftLabel === "SN" && (params.activeShiftLabel === "SD" || params.activeShiftLabel === "P"))
            || (params.incomingShiftLabel === "SD" && (params.activeShiftLabel === "SN" || params.activeShiftLabel === "P"))
        ) {
            return true;
        }

        return false;
    }

    if (params.incomingShiftLabel === "P") {
        return params.activeShiftLabel === "SD"
            || params.activeShiftLabel === "SN"
            || params.activeShiftLabel === "P";
    }

    if (
        params.incomingShiftLabel
        && params.activeShiftLabel
        && params.incomingShiftLabel !== params.activeShiftLabel
    ) {
        return true;
    }

    return params.activeShiftLabel === "P";
}

// Normaliza um rótulo de turno para SD/SN concretos. P e nulos viram null porque
// só uma troca explícita SD↔SN sinaliza "plantão novo" — P/ausente é ambíguo
// (continuidade/24h) e não deve bloquear o remanejamento implícito.
function normalizeConcreteShift(value: string | null | undefined): "SD" | "SN" | null {
    const normalized = (value ?? "").trim().toUpperCase();
    return normalized === "SD" || normalized === "SN" ? normalized : null;
}

export function shouldTreatTelegramArrivalAsImplicitReassignment(params: {
    sector: "REGULATION" | "INTERVENTION";
    baseCode: string | null;
    arrivalTime?: string | null;
    shiftType?: string | null;
    roleFunction?: string | null;
    isShadow?: boolean;
    isDeparture: boolean;
    isContinuation: boolean;
    isReassignment?: boolean;
    activeSector?: "REGULATION" | "INTERVENTION" | null;
    activeBaseCode?: string | null;
    activeShiftLabel?: string | null;
}) {
    if (!params.baseCode) {
        return false;
    }

    if (params.isDeparture || params.isContinuation || params.isReassignment) {
        return false;
    }

    // Uma chegada de "sombra" é uma coexistência própria no novo ramal, não uma
    // mudança de posição do titular — nunca move a ocupação existente.
    if (params.isShadow) {
        return false;
    }

    if (!params.activeSector || !params.activeBaseCode) {
        return false;
    }

    // Mesma posição (mesmo domínio + mesmo código) não é remanejamento.
    if (params.activeSector === params.sector && params.activeBaseCode === params.baseCode) {
        return false;
    }

    // Um médico que já está no plantão e avisa chegada em OUTRA posição — ramal ou
    // ambulância, inclusive cross-domínio — está mudando de posto, não começando
    // um plantão novo. O sistema preserva o 1º horário de chegada (handled pelo
    // transfer, que clona started_at/boardStartedAt) em vez de marcá-lo atrasado.
    // A única exceção é declarar um turno concreto DIFERENTE do atual (SD↔SN):
    // isso sinaliza um plantão novo de verdade, então trata como chegada nova.
    const declaredShift = normalizeConcreteShift(params.shiftType);
    const activeShift = normalizeConcreteShift(params.activeShiftLabel);
    if (declaredShift && activeShift && declaredShift !== activeShift) {
        return false;
    }

    return true;
}

/** Turno novo (SD/SN) quando um "remanejo" acontece depois do fim do turno de origem; senão null. */
export function resolveCrossTurnoMoveShift(params: {
    isMove: boolean;
    activeShiftLabel: string | null;
    activeScheduledEndAt: Date | null;
    eventAt: Date;
}): "SD" | "SN" | null {
    if (!params.isMove || !params.activeScheduledEndAt) {
        return null;
    }
    if (params.activeShiftLabel !== "SD" && params.activeShiftLabel !== "SN") {
        return null; // P segue P: remanejo dentro do plantão de 24h
    }
    if (params.eventAt.getTime() < params.activeScheduledEndAt.getTime()) {
        return null;
    }
    const currentShift = resolveOperationalShiftWindow(params.eventAt).shiftLabel;
    return currentShift !== params.activeShiftLabel && (currentShift === "SD" || currentShift === "SN") ? currentShift : null;
}

export function shouldLinkTelegramArrivalToContinuitySource(params: {
    parsed: OperationalParsedEntry;
    sourceShiftLabel?: string | null;
}) {
    return shouldTreatTelegramArrivalAsContinuation({
        sector: params.parsed.sector,
        isDeparture: params.parsed.isDeparture,
        isContinuation: params.parsed.isContinuation,
        incomingShiftLabel: params.parsed.shiftType,
        activeShiftLabel: params.sourceShiftLabel,
    });
}

export function shouldAssumeTelegramHalfShift(params: {
    parsed: Pick<ParsedMessage, "sector" | "isDeparture" | "isContinuation">;
    eventAt: Date;
    effectiveShiftType: string | null;
    // Chegada já aberta do mesmo médico no mesmo ramal. Se é de antes das 11:10, o
    // aviso é reenvio de plantão inteiro, não meio plantão (defeito D6 de
    // docs/chegada.md; Jonas, 2154, 22/09/2026: SD desde 07:16 virou meio às 16:12).
    activeStartedAt?: Date | null;
}) {
    if (params.parsed.sector !== "REGULATION" || params.parsed.isDeparture || params.parsed.isContinuation) {
        return false;
    }

    if (params.activeStartedAt && isBeforeHalfShiftWindow(params.activeStartedAt)) {
        return false;
    }

    const parts = getSaoPauloParts(params.eventAt);
    return isWithinHalfShiftWindow((parts.hour * 60) + parts.minute);
}

// D7 (docs/chegada.md): rótulo declarado é o do turno que ESTÁ ACABANDO e a hora cai
// na janela antecipada de 3h do próximo ("SD" às 18:35, "SN" às 05:30). A régua de
// tempo (resolvePShiftAwareBaseShiftLabel) vira a janela para o próximo turno e o
// registro saía com rótulo SD e janela SN (Gerardson, 2152, 03/09/2026).
export function isTelegramShiftLabelTimeMismatch(eventAt: Date, shiftType: string | null | undefined): shiftType is "SD" | "SN" {
    if (shiftType !== "SD" && shiftType !== "SN") return false;
    const clockWindow = resolveOperationalShiftWindow(eventAt);
    return shiftType === clockWindow.shiftLabel && resolveArrivalShiftLabel(eventAt) !== clockWindow.shiftLabel;
}

// Pergunta "SD ou SN?" só na chegada NOVA: quem já tem plantão aberto (reenvio,
// correção de rótulo D2, remanejo) segue as regras próprias; meio plantão e PIAM têm
// janela fixa e não discordam.
export function shouldAskTelegramShiftLabelMismatch(params: {
    parsed: Pick<ParsedMessage, "sector" | "baseCode" | "shiftType" | "isDeparture" | "isContinuation" | "isReassignment">;
    eventAt: Date;
    hasActiveOccupancy: boolean;
}): boolean {
    const { parsed } = params;
    if (parsed.isDeparture || parsed.isContinuation || parsed.isReassignment) return false;
    if (params.hasActiveOccupancy || parsed.baseCode === "PIAM") return false;
    if (shouldAssumeTelegramHalfShift({ parsed, eventAt: params.eventAt, effectiveShiftType: parsed.shiftType })) return false;
    return isTelegramShiftLabelTimeMismatch(params.eventAt, parsed.shiftType);
}

/**
 * "Chegou num plantão e seguiu no outro" — a travessia de virada como prova de
 * continuidade, sem depender de o médico ter escrito a palavra.
 *
 * Compara o turno da OCUPAÇÃO ANTERIOR com o turno em que a nova mensagem cai.
 * Diferentes = ele atravessou a virada, e quem atravessa a virada continuou.
 * Antes esta inferência também exigia que o médico NÃO tivesse escrito o rótulo
 * do turno, e aí digitar "SN" ao voltar de um SD custava a âncora da cadeia —
 * justamente quem tentou ser explícito saía pior do que quem não disse nada.
 *
 * A adjacência temporal (a fonte ter ficado até perto da virada) é garantida
 * antes, por shouldLinkExplicitContinuationClosedSource, na escolha da fonte.
 */
export function shouldInferCrossShiftContinuation(params: {
    sourceShiftLabel?: string | null;
    eventAt: Date;
    isExplicitContinuation: boolean;
}) {
    // Continuidade explícita já entra pelo caminho de shouldLinkTelegramArrivalToContinuitySource.
    if (params.isExplicitContinuation || !params.sourceShiftLabel) {
        return false;
    }

    return params.sourceShiftLabel !== resolveOperationalShiftWindow(params.eventAt).shiftLabel;
}

export function shouldReopenStaleTelegramRegulationContinuation(params: {
    activeShiftLabel?: string | null;
    activeStartedAt?: Date | null;
    eventAt: Date;
}) {
    if (params.activeShiftLabel !== "P" || !params.activeStartedAt) {
        return false;
    }

    const expiryAt = resolveProlongedShiftExpiry(params.activeStartedAt, "P");
    return Boolean(expiryAt && expiryAt.getTime() <= params.eventAt.getTime());
}

export function shouldReopenStaleTelegramInterventionContinuation(params: {
    activeShiftLabel?: string | null;
    activeStartedAt?: Date | null;
    eventAt: Date;
}) {
    if (params.activeShiftLabel !== "P" || !params.activeStartedAt) {
        return false;
    }

    const expiryAt = resolveProlongedShiftExpiry(params.activeStartedAt, "P");
    return Boolean(expiryAt && expiryAt.getTime() <= params.eventAt.getTime());
}

export function shouldTreatReassignmentAsArrival(params: {
    parsed: Pick<OperationalParsedEntry, "isReassignment" | "sector" | "baseCode">;
    activeOcc: { sector: "REGULATION" | "INTERVENTION"; baseCode: string } | null | undefined;
}) {
    if (!params.parsed.isReassignment) {
        return false;
    }
    if (!params.activeOcc) {
        return true;
    }
    return params.activeOcc.sector === params.parsed.sector && params.activeOcc.baseCode === params.parsed.baseCode;
}

// ---------------------------------------------------------------------------
// Decisões compostas: cada uma é um passo do caminho de docs/chegada.md §3, entre
// duas leituras do banco. service.ts lê o estado, chama e executa o efeito.
// ---------------------------------------------------------------------------

/**
 * Rótulo de turno com que a chegada começa, antes de olhar o banco.
 */
export function resolveInitialArrivalShiftType(params: {
    parsed: Pick<ArrivalParsedEntry, "shiftType" | "isDeparture" | "isContinuation">;
    eventAt: Date;
    /** Hora da mensagem ("agora" do aviso). */
    referenceAt: Date;
}): string | null {
    const { parsed, eventAt, referenceAt } = params;
    let effectiveShiftType: string | null = parsed.shiftType ?? null;
    if (!parsed.isDeparture && parsed.isContinuation) {
        // "continua" diz de onde o médico VEM, não que ele promete mais 24h. O rótulo
        // aqui é o turno em que ele está chegando — nunca "P", que daria a este registro
        // cobertura de 24h e, com ela, pagamento do turno seguinte sem tê-lo trabalhado
        // (doesCandidateCoverPaymentSlot) e a tag "Continua" travada no lugar do botão de
        // retirar (continuesBeyondShift).
        //
        // O rótulo continua preenchido — a preocupação original de não deixar SD/SN/null
        // sumir de painéis com escopo de turno segue atendida, agora com o turno certo.
        // Continuidade no MESMO posto é outro caminho (continueRegulation/Intervention
        // Occupancy), que estende a ocupação existente em um bloco de 12h e mantém "P".
        effectiveShiftType = resolveArrivalShiftLabel(eventAt);
    }

    // When no explicit shift is provided and the arrival time is near a shift boundary,
    // use the message timestamp's shift to disambiguate.
    // Example: arrival 18:55 (technically SD) but message sent 20:06 (SN) → doctor is arriving for SN.
    if (!effectiveShiftType && !parsed.isDeparture) {
        const arrivalShiftWindow = resolveOperationalShiftWindow(eventAt);
        const messageShiftWindow = resolveOperationalShiftWindow(referenceAt);
        if (arrivalShiftWindow.shiftLabel !== messageShiftWindow.shiftLabel) {
            const minutesToBoundary = (arrivalShiftWindow.nextBoundaryAt.getTime() - eventAt.getTime()) / 60000;
            if (minutesToBoundary >= 0 && minutesToBoundary <= 60) {
                effectiveShiftType = messageShiftWindow.shiftLabel;
            }
        }
    }

    return effectiveShiftType;
}

/**
 * Para onde vai o aviso, dado o plantão aberto do médico (em qualquer alvo):
 * - `cross_turno_arrival`: "remanejo" depois do fim do turno de origem → chegada
 *   com o turno atual (reprocessa sem a marca de remanejo);
 * - `reassignment_as_arrival`: "remanejado para X" sem plantão aberto, ou já em X → chegada (D12);
 * - `reassignment`: troca de posto dentro do turno (explícita ou implícita);
 * - `on_target`: segue para o alvo declarado (chegada, continuação ou saída).
 */
export type ArrivalRoute =
    | { kind: "cross_turno_arrival"; shiftType: "SD" | "SN" }
    | { kind: "reassignment_as_arrival" }
    | { kind: "reassignment"; implicit: boolean }
    | { kind: "on_target" };

export function classifyArrivalRoute(params: {
    parsed: ArrivalParsedEntry;
    activeOcc: {
        sector: "REGULATION" | "INTERVENTION";
        baseCode: string;
        shiftLabel: string | null;
        scheduledEndAt: Date | null;
    } | null;
    eventAt: Date;
}): ArrivalRoute {
    const { parsed, activeOcc, eventAt } = params;
    const implicitReassignment = shouldTreatTelegramArrivalAsImplicitReassignment({
        sector: parsed.sector,
        baseCode: parsed.baseCode,
        arrivalTime: parsed.arrivalTime,
        shiftType: parsed.shiftType,
        roleFunction: parsed.roleFunction,
        isShadow: parsed.isShadow,
        isDeparture: parsed.isDeparture,
        isContinuation: parsed.isContinuation,
        isReassignment: parsed.isReassignment,
        activeSector: activeOcc?.sector,
        activeBaseCode: activeOcc?.baseCode,
        activeShiftLabel: activeOcc?.shiftLabel,
    });

    // Remanejo só existe DENTRO do turno. Depois que o SD/SN de origem acabou (o plantão
    // aberto segue "ativo" por 3h de folga), ir para outro posto é o turno SEGUINTE do
    // médico: vira chegada com o turno atual, que cai no caminho de continuidade de
    // todo dia ("Fulano CC70 SN"). Antes o remanejo clonava rótulo e janela do SD para
    // o trabalho noturno — beltrano da CZ50 que ia à noite para a CC70 não tinha SN.
    const crossTurnoShift = resolveCrossTurnoMoveShift({
        isMove: Boolean(parsed.isReassignment || implicitReassignment),
        activeShiftLabel: activeOcc?.shiftLabel ?? null,
        activeScheduledEndAt: activeOcc?.scheduledEndAt ?? null,
        eventAt,
    });
    if (crossTurnoShift) {
        return { kind: "cross_turno_arrival", shiftType: crossTurnoShift };
    }

    // "Remanejado para X" de quem não tem plantão aberto, ou que já está em X, é uma
    // chegada: registra em vez de recusar (docs/chegada.md, D12 — a chegada é soberana).
    if (shouldTreatReassignmentAsArrival({ parsed, activeOcc })) {
        return { kind: "reassignment_as_arrival" };
    }

    if (parsed.isReassignment || implicitReassignment) {
        return { kind: "reassignment", implicit: !parsed.isReassignment };
    }

    return { kind: "on_target" };
}

/**
 * Chegada (não saída) no alvo declarado, dada a ocupação aberta do MESMO médico
 * NESSE alvo:
 * - `continue_active`: estende essa ocupação (continue*Occupancy) — "continua",
 *   rótulo P ou troca SD↔SN horas depois;
 * - `new_occupancy`: vai para start*Occupancy (que decide re-chegada in-place,
 *   stale ou junção). `assumedHalfShift` = meio plantão da regulação (D6);
 *   `lookupContinuity` = vale buscar uma fonte de continuidade (falso na correção
 *   de rótulo D2, senão a ocupação que o médico acabou de abrir vira "fonte").
 */
export type TargetArrivalDecision =
    | { kind: "continue_active" }
    | { kind: "new_occupancy"; assumedHalfShift: boolean; lookupContinuity: boolean };

export function classifyTargetArrival(params: {
    parsed: ArrivalParsedEntry;
    activeOnTarget: { shiftLabel: string | null; startedAt: Date } | null | undefined;
    eventAt: Date;
    effectiveShiftType: string | null;
}): TargetArrivalDecision {
    const { parsed, activeOnTarget, eventAt } = params;
    // When the message carries an explicit continuation intent (e.g. "continua 2153"),
    // never treat the existing active P-shift as stale: the operator/chief is confirming
    // continuity and we must update the existing occupancy in place instead of closing
    // it and opening a new one (which would shift started_at to eventAt and break
    // downstream displays — board, meal break panel, shift report, reminders).
    const shouldReopenStale = parsed.sector === "REGULATION"
        ? shouldReopenStaleTelegramRegulationContinuation
        : shouldReopenStaleTelegramInterventionContinuation;
    const shouldReopenStaleContinuation = !parsed.isContinuation && shouldReopenStale({
        activeShiftLabel: activeOnTarget?.shiftLabel,
        activeStartedAt: activeOnTarget?.startedAt,
        eventAt,
    });

    const shouldContinueActiveOccupancy = Boolean(activeOnTarget) && !shouldReopenStaleContinuation && shouldTreatTelegramArrivalAsContinuation({
        sector: parsed.sector,
        isDeparture: parsed.isDeparture,
        isContinuation: parsed.isContinuation,
        incomingShiftLabel: parsed.shiftType,
        activeShiftLabel: activeOnTarget?.shiftLabel,
        activeStartedAt: activeOnTarget?.startedAt,
        eventAt,
    });
    if (shouldContinueActiveOccupancy && activeOnTarget) {
        return { kind: "continue_active" };
    }

    const assumedHalfShift = shouldAssumeTelegramHalfShift({
        parsed,
        eventAt,
        effectiveShiftType: params.effectiveShiftType,
        activeStartedAt: activeOnTarget?.startedAt ?? null,
    });
    const isLabelCorrection = isTelegramShiftLabelCorrection({
        incomingShiftLabel: parsed.shiftType,
        activeShiftLabel: activeOnTarget?.shiftLabel,
        activeStartedAt: activeOnTarget?.startedAt,
        eventAt,
    });
    return {
        kind: "new_occupancy",
        assumedHalfShift,
        lookupContinuity: !(parsed.isDeparture || isLabelCorrection),
    };
}

/**
 * Com a fonte de continuidade achada no banco (findTelegramContinuityContext):
 * a chegada entra na cadeia dela? Sim quando o aviso é continuação pelas regras de
 * rótulo, ou quando atravessou a virada (shouldInferCrossShiftContinuation).
 */
export function shouldUseTelegramContinuitySource(params: {
    parsed: ArrivalParsedEntry;
    source: { shiftLabel: string | null; boardStartedAt: Date | null; startedAt: Date } | null | undefined;
    eventAt: Date;
}): boolean {
    const { parsed, source } = params;
    if (!source) {
        return false;
    }
    const sourceShiftLabel = source.shiftLabel
        ?? resolveOperationalShiftWindow(source.boardStartedAt ?? source.startedAt).shiftLabel;
    return shouldLinkTelegramArrivalToContinuitySource({ parsed, sourceShiftLabel })
        || shouldInferCrossShiftContinuation({
            sourceShiftLabel,
            eventAt: params.eventAt,
            isExplicitContinuation: Boolean(parsed.isContinuation),
        });
}

/**
 * A chegada quer o quadro do alvo (passa pelo portão de tomada e pode deslocar o
 * ocupante na chegada retroativa)? Saída, continuação e sombra nunca querem.
 */
export function arrivalWantsBoard(
    parsed: Pick<ArrivalParsedEntry, "isDeparture" | "isContinuation" | "baseCode">,
    isShadow: boolean,
): boolean {
    return !parsed.isDeparture
        && !parsed.isContinuation
        && !isShadow
        && Boolean(parsed.baseCode);
}

/**
 * Chegada retroativa (hora da 1ª tentativa, anterior a este aviso) que quer o quadro
 * sem tomada confirmada: o ocupante do quadro NÃO pode ser encerrado nessa hora
 * passada — ele estava lá. É deslocado (fora do quadro, plantão aberto), exceto
 * sombra, o próprio médico, ou titular de base que divide a base com quem chega.
 */
export function shouldDisplaceOnRetroactiveArrival(params: {
    previous: { doctorId: string; isShadow: boolean } | null | undefined;
    arrivingDoctorId: string;
    /** Titular vigente de uma base não é deslocado: quem chega divide a base com ele. */
    sharesBase: boolean;
}): boolean {
    return Boolean(params.previous)
        && !params.previous!.isShadow
        && params.previous!.doctorId !== params.arrivingDoctorId
        && !params.sharesBase;
}
