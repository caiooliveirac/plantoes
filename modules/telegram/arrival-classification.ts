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
