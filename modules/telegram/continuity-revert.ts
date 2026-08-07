// Reversão rápida do "P forward" da continuidade noturna.
//
// Quando o bot registra uma chegada noturna como P (plantão 24h) que vai cobrir
// também o SD de amanhã, ele oferece um botão inline "Foi só esta noite". Tocar
// no botão dentro de 2 minutos rebaixa a ocupação de P para SN (cobre só a noite).
//
// Aqui ficam apenas os helpers PUROS (sem I/O), para serem testáveis isoladamente:
// codificação/decodificação do callback_data e o portão de validade (TTL + estado).
// O handler com efeito (DB + Telegram) vive em modules/telegram/service.ts.

import { resolvePShiftAwareBaseShiftLabel } from "@/modules/operational/rules";

export type ContinuityRevertDomain = "regulation" | "intervention";

/**
 * Turno-base que um P declarado em `startedAt` realmente assume — a MESMA regra
 * que a camada de domínio usa para montar a cobertura (rules.ts), não o relógio.
 *
 * Chegada adiantada (04:00–06:59) é P do DIA: cobre 07h→07h de amanhã. Só quem
 * declara P já dentro da noite (ou adiantado para ela, 16:00–18:59) é P noturno,
 * 19h→19h de amanhã. Antes, o botão de reversão olhava só o relógio e oferecia
 * "Foi só esta noite (SN)" a quem chegou às 06:xx para o SD (caso Syone BR60,
 * 07/08/2026): rótulo errado, e a reversão teria jogado a médica para a noite.
 */
export function resolveContinuityRevertTarget(startedAt: Date): "SD" | "SN" {
    return resolvePShiftAwareBaseShiftLabel(startedAt, "P") === "SN" ? "SN" : "SD";
}

/** Prefixo curto do callback_data (limite de 64 bytes do Telegram). */
export const CONTINUITY_REVERT_CALLBACK_PREFIX = "pSN";

/** Janela em que o médico pode reverter o P para SN. */
export const CONTINUITY_REVERT_TTL_MS = 2 * 60 * 1000;

const DOMAIN_CODE: Record<ContinuityRevertDomain, string> = {
    regulation: "r",
    intervention: "i",
};

const CODE_DOMAIN: Record<string, ContinuityRevertDomain> = {
    r: "regulation",
    i: "intervention",
};

/** Monta o callback_data do botão: `pSN:r:<occupancyId>` (≤ 64 bytes). */
export function buildContinuityRevertCallbackData(domain: ContinuityRevertDomain, occupancyId: string) {
    return `${CONTINUITY_REVERT_CALLBACK_PREFIX}:${DOMAIN_CODE[domain]}:${occupancyId}`;
}

export interface ParsedContinuityRevertCallback {
    domain: ContinuityRevertDomain;
    occupancyId: string;
}

/** Decodifica o callback_data; retorna null se não for um botão de reversão válido. */
export function parseContinuityRevertCallbackData(data: string | null | undefined): ParsedContinuityRevertCallback | null {
    if (!data) {
        return null;
    }

    const parts = data.split(":");
    if (parts.length !== 3 || parts[0] !== CONTINUITY_REVERT_CALLBACK_PREFIX) {
        return null;
    }

    const domain = CODE_DOMAIN[parts[1]];
    const occupancyId = parts[2]?.trim();
    if (!domain || !occupancyId) {
        return null;
    }

    return { domain, occupancyId };
}

export type ContinuityRevertOutcome = "ok" | "expired" | "already_changed" | "not_found";

/**
 * Portão puro: decide se a reversão P→SN ainda é válida.
 * - `not_found`: ocupação inexistente.
 * - `already_changed`: já não está mais em P (revertida antes, ou alterada).
 * - `expired`: passou da janela de 2 minutos desde a criação.
 * - `ok`: pode rebaixar para SN.
 */
export function evaluateContinuityRevert(params: {
    occupancy: { shiftLabel: string | null; createdAt: Date } | null;
    now: Date;
    ttlMs?: number;
}): ContinuityRevertOutcome {
    if (!params.occupancy) {
        return "not_found";
    }
    if (params.occupancy.shiftLabel !== "P") {
        return "already_changed";
    }

    const ttlMs = params.ttlMs ?? CONTINUITY_REVERT_TTL_MS;
    const ageMs = params.now.getTime() - params.occupancy.createdAt.getTime();
    if (ageMs > ttlMs) {
        return "expired";
    }

    return "ok";
}
