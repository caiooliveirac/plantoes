/**
 * Purpose: Late departure reason parsing, departure correction candidate selection,
 *          and justification requirement checks.
 *
 * Source of truth: What qualifies as a valid late departure reason (occurrence, hygienization).
 *
 * Invariants:
 * - Only "occurrence" and "hygienization" are eligible automatic-credit reasons.
 * - Other accepted reasons (e.g. chief release, handoff/rendicao) are manual-review only.
 * - Fuzzy matching (Levenshtein ≤ 1–3 depending on keyword length) is intentional.
 * - Departure correction window: 48 hours from last shift.
 * - Ambiguity gap: 6 hours between candidates triggers disambiguation.
 *
 * Danger: Changing keyword lists or fuzzy thresholds silently changes which departures
 *         get automatic bank-hours credit vs. manual review.
 */

import { resolveOvertimeJustificationThreshold } from "@/modules/operational/board-rules";
import { parseMessage } from "@/modules/telegram/parser";
import { normalizeDoctorName } from "@/modules/doctors/importer";

// ── Types ──────────────────────────────────────────────────────────────────────

export type TelegramEligibleLateDepartureReasonCode = "occurrence" | "hygienization" | "chief_release" | "handoff";

export interface TelegramDepartureCorrectionCandidate {
    occupancyId: string;
    domain: "REGULATION" | "INTERVENTION";
    targetCode: string;
    shiftLabel: "SD" | "SN" | "P" | null;
    roleLabel: string | null;
    startedAt: Date;
    endedAt: Date | null;
    actualEndedAt: Date | null;
    isActive: boolean;
}

export interface SerializedTelegramDepartureCorrectionCandidate {
    occupancyId: string;
    domain: "REGULATION" | "INTERVENTION";
    targetCode: string;
    shiftLabel: "SD" | "SN" | "P" | null;
    roleLabel: string | null;
    startedAt: string;
    endedAt: string | null;
    actualEndedAt: string | null;
    isActive: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────────

export const TELEGRAM_DEPARTURE_CORRECTION_WINDOW_MS = 48 * 60 * 60 * 1000;
const TELEGRAM_DEPARTURE_CORRECTION_AMBIGUITY_GAP_MS = 6 * 60 * 60 * 1000;

const TELEGRAM_LATE_DEPARTURE_REASON_KEYWORDS: Record<TelegramEligibleLateDepartureReasonCode, string[]> = {
    occurrence: ["OCORRENCIA", "OCORRENCIAS", "OCORR", "ATENDENDO", "ATENDIMENTO", "CHAMADO"],
    hygienization: ["HIGIENIZANDO", "HIGIENIZACAO", "HIGIENIZAR", "HIGIENE", "LIMPEZA", "LIMPANDO", "LAVANDO", "DESINFECCAO", "DESINFETANDO", "DESCONTAMINANDO"],
    chief_release: ["CHEFIA", "CHEFE", "LIBERADO", "LIBERADA", "LIBEROU", "AUTORIZOU", "AUTORIZACAO", "AUTORIZADO", "DETERMINACAO"],
    handoff: ["RENDIDO", "RENDIDA", "RENDICAO", "REDICAO", "RENDERAM", "RENDICAO", "TROCA", "UNIDADE", "SUBSTITUICAO"],
};

const TELEGRAM_LATE_DEPARTURE_REASON_STOPWORDS = new Set([
    "A", "AINDA", "AS", "COM", "COMO", "DA", "DAS", "DE", "DO", "DOS", "E", "EM", "ESTAVA", "ESTOU", "EU",
    "FOI", "FUI", "JA", "MAS", "ME", "MEU", "MINHA", "MOTIVO", "NA", "NO", "O", "OS", "OU", "PARA", "POR",
    "PORQUE", "QUE", "RESPONDI", "SAIDA", "SAINDO", "SIGO", "SO", "SÓ", "TAVA", "TO", "TÔ", "UMA",
]);

// ── Text normalization ─────────────────────────────────────────────────────────

export function normalizeTelegramReasonText(value: string) {
    return value
        .toUpperCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^A-Z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function stripTelegramOperationalFragments(text: string, fragments: Array<string | null | undefined>) {
    let reduced = normalizeTelegramReasonText(text)
        .replace(/^\s*\/(?:CORRIGIR|RETIRAR|REMOVER|SAIU|SAINDO|SAIDA|CORRIGIRSAIDA)\b/i, " ");

    for (const fragment of fragments) {
        if (!fragment) {
            continue;
        }

        const escaped = normalizeTelegramReasonText(fragment)
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!escaped) {
            continue;
        }

        reduced = reduced.replace(new RegExp(escaped, "gi"), " ");
    }

    return reduced
        .replace(/\b\d{1,2}[:.]\d{2}\b/g, " ")
        .replace(/\b\d{1,2}H(?:\d{2})?\b/g, " ")
        .replace(/\b(?:SD|SN|P|CHEGUEI|CHEGANDO|CHEGADA|PRESENTE|ASSUMINDO|ASSUMI|RENDENDO|RENDI|CONTINUO|CONTINUA|SEGUINDO|SIGO|SAINDO|SAIU|SAI|SAIDA|ENCERRANDO|ENCERREI|FINALIZANDO|FINALIZEI|LIBEREI|MOTIVO)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// ── Levenshtein & fuzzy matching ───────────────────────────────────────────────

export function computeLevenshteinDistance(left: string, right: string) {
    if (left === right) {
        return 0;
    }

    if (left.length === 0) {
        return right.length;
    }

    if (right.length === 0) {
        return left.length;
    }

    const currentRow = Array.from({ length: right.length + 1 }, (_, index) => index);

    for (let row = 1; row <= left.length; row += 1) {
        let diagonal = currentRow[0];
        currentRow[0] = row;

        for (let column = 1; column <= right.length; column += 1) {
            const nextDiagonal = currentRow[column];
            const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
            currentRow[column] = Math.min(
                currentRow[column] + 1,
                currentRow[column - 1] + 1,
                diagonal + substitutionCost,
            );
            diagonal = nextDiagonal;
        }
    }

    return currentRow[right.length];
}

function matchesTelegramLateDepartureKeyword(token: string, keyword: string) {
    if (token === keyword) {
        return true;
    }

    if (token.length >= 5 && (token.startsWith(keyword) || keyword.startsWith(token))) {
        return true;
    }

    if (token.length >= 6 && (token.includes(keyword) || keyword.includes(token))) {
        return true;
    }

    const threshold = keyword.length >= 10 ? 3 : keyword.length >= 7 ? 2 : 1;
    return computeLevenshteinDistance(token, keyword) <= threshold;
}

function matchesTelegramLateDepartureReason(tokens: string[], reasonCode: TelegramEligibleLateDepartureReasonCode) {
    return tokens.some((token) => TELEGRAM_LATE_DEPARTURE_REASON_KEYWORDS[reasonCode].some((keyword) => matchesTelegramLateDepartureKeyword(token, keyword)));
}

// ── Late departure reason resolution ───────────────────────────────────────────

export function resolveTelegramEligibleLateDepartureReason(
    text: string,
    fragments: Array<string | null | undefined> = [],
): { code: TelegramEligibleLateDepartureReasonCode; normalizedText: string } | null {
    const reduced = stripTelegramOperationalFragments(text, fragments);
    const normalized = normalizeTelegramReasonText(reduced);
    if (!normalized) {
        return null;
    }

    if (/\b(?:OCORR\w*|ATEND(?:IMENTO|ENDO)?|CHAMAD\w*)\b/.test(normalized)) {
        return { code: "occurrence", normalizedText: normalized };
    }

    if (/\b(?:HIGIEN\w*|LIMP\w*|LAVAND\w*|DESINF\w*|DESCONTAMIN\w*)\b/.test(normalized)) {
        return { code: "hygienization", normalizedText: normalized };
    }

    // "liberado chefia", "fui liberado pela chefia", "chefia liberou" etc.
    if (/\b(?:LIBERADO|LIBERADA|LIBEROU)\b/.test(normalized) && /\b(?:CHEFIA|CHEFE)\b/.test(normalized)) {
        return { code: "chief_release", normalizedText: normalized };
    }
    if (/\b(?:CHEFIA|CHEFE)\b/.test(normalized) && /\b(?:LIBEROU|AUTORIZOU|DETERMINOU|PEDIU|SOLICITOU|MANDOU|DISSE|FALOU)\b/.test(normalized)) {
        return { code: "chief_release", normalizedText: normalized };
    }
    if (/\b(?:AUTORIZACAO|AUTORIZADO|AUTORIZADA|DETERMINACAO|DETERMINADO)\s+(?:DA\s+)?(?:CHEFIA|CHEFE)\b/.test(normalized)) {
        return { code: "chief_release", normalizedText: normalized };
    }

    // "atraso de quem veio render" is not an eligible reason code; keep manual path behavior unchanged.
    if (/\bATRAS\w*\b/.test(normalized) && /\b(?:REND\w*|RENDER\w*)\b/.test(normalized)) {
        return null;
    }

    // Frequent late-departure explanations tied to handoff/replacement.
    if (/\b(?:FUI\s+RENDID[OA]|SENDO\s+RENDID[OA]|RENDID[OA]\s+POR|RENDICAO|REDICAO)\b/.test(normalized)) {
        return { code: "handoff", normalizedText: normalized };
    }
    if (/\b(?:TROCA|MUDANCA|SUBSTITUICAO)\b.*\b(?:UNIDADE|VIATURA|BASE)\b/.test(normalized)) {
        return { code: "handoff", normalizedText: normalized };
    }

    const tokens = normalized
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 4 && !TELEGRAM_LATE_DEPARTURE_REASON_STOPWORDS.has(token));

    if (matchesTelegramLateDepartureReason(tokens, "occurrence")) {
        return { code: "occurrence", normalizedText: normalized };
    }

    if (matchesTelegramLateDepartureReason(tokens, "hygienization")) {
        return { code: "hygienization", normalizedText: normalized };
    }

    if (matchesTelegramLateDepartureReason(tokens, "chief_release")) {
        return { code: "chief_release", normalizedText: normalized };
    }

    if (matchesTelegramLateDepartureReason(tokens, "handoff")) {
        return { code: "handoff", normalizedText: normalized };
    }

    return null;
}

// ── Occurrence number requirement ──────────────────────────────────────────────

/**
 * Business rule: a doctor claiming a late departure for bank-hours credit under
 * the "occurrence" reason MUST say which occurrence they were in. The occurrence
 * number has exactly 4 digits. We charge it in the Telegram chat and surface it to
 * the chief, so this extractor must recover it from free-form text while never
 * mistaking the verbalized departure time (e.g. "19:40" / "1940") for it.
 *
 * Strategy:
 *  1. Strip the known operational fragments (departure time, target code, name)
 *     plus their digits-only forms, and any remaining HH:MM / HHhMM time tokens.
 *  2. Prefer a 4-digit run sitting next to an occurrence keyword ("ocorrência 4521").
 *  3. Fall back to a lone 4-digit token — safe in the reply context, where the bot
 *     explicitly asked only for the number.
 */
export function extractTelegramOccurrenceNumber(
    text: string,
    fragments: Array<string | null | undefined> = [],
): string | null {
    const expandedFragments: Array<string | null | undefined> = [];
    for (const fragment of fragments) {
        if (!fragment) {
            continue;
        }
        expandedFragments.push(fragment);
        const digitsOnly = String(fragment).replace(/\D/g, "");
        if (digitsOnly.length >= 3) {
            expandedFragments.push(digitsOnly);
        }
    }

    const reduced = stripTelegramOperationalFragments(text, expandedFragments)
        // Remove residual time tokens so "1940" / "19 40" are never read as the number.
        .replace(/\b\d{1,2}\s*[:.H]\s*\d{2}\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const keyed = reduced.match(/(?:OCORR\w*|CHAMAD\w*|ATEND\w*|NUMERO|N)\D{0,6}(\d{4})(?!\d)/);
    if (keyed) {
        return keyed[1];
    }

    const lone = reduced.match(/(?<!\d)\d{4}(?!\d)/);
    return lone ? lone[0] : null;
}

export interface TelegramLateDepartureClaim {
    code: TelegramEligibleLateDepartureReasonCode;
    normalizedText: string;
    /** The 4-digit occurrence number, when the rule applies and one was provided. */
    occurrenceNumber: string | null;
    /** True when the reason is "occurrence" but the mandatory 4-digit number is absent. */
    missingOccurrenceNumber: boolean;
}

/**
 * Resolves a late-departure claim AND enforces the occurrence-number rule on top of
 * the reason match. Only "occurrence" requires the number; every other reason carries
 * `missingOccurrenceNumber: false` so their behavior is unchanged.
 *
 * `missingOccurrenceNumber === true` means "recognized as occurrence, but not yet
 * eligible for automatic credit — charge the doctor for the number first."
 */
export function resolveTelegramLateDepartureClaim(
    text: string,
    fragments: Array<string | null | undefined> = [],
): TelegramLateDepartureClaim | null {
    const reason = resolveTelegramEligibleLateDepartureReason(text, fragments);
    if (!reason) {
        return null;
    }

    const occurrenceNumber = reason.code === "occurrence"
        ? extractTelegramOccurrenceNumber(text, fragments)
        : null;

    return {
        code: reason.code,
        normalizedText: reason.normalizedText,
        occurrenceNumber,
        missingOccurrenceNumber: reason.code === "occurrence" && !occurrenceNumber,
    };
}

/**
 * True when a recognized claim is eligible for automatic bank-hours credit: a valid
 * reason was found and, if it is an occurrence, the 4-digit number is present.
 */
export function isTelegramCreditEligibleClaim(
    text: string,
    fragments: Array<string | null | undefined> = [],
): boolean {
    const claim = resolveTelegramLateDepartureClaim(text, fragments);
    return Boolean(claim) && !claim!.missingOccurrenceNumber;
}

// ── Justification / prompt helpers ─────────────────────────────────────────────

export function getPendingDepartureJustificationAttemptCount(data: { invalidJustificationAttempts?: number }) {
    const value = Number(data.invalidJustificationAttempts ?? 0);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function resolveDepartureJustificationPromptKind(attemptCount: number) {
    return attemptCount > 0 ? "departure_justification_retry" as const : "departure_justification_required" as const;
}

export function requiresTelegramDepartureAdjustmentJustification(params: {
    domain: "REGULATION" | "INTERVENTION";
    startedAt: string | Date | null;
    scheduledEndAt?: string | Date | null;
    endedAt: string | Date | null;
    eventAt: string | Date | null;
    hasSuccessorOccupancy?: boolean;
}) {
    if (!params.eventAt || !params.endedAt) {
        return false;
    }

    if (params.hasSuccessorOccupancy === false) {
        return false;
    }

    const eventTime = new Date(params.eventAt).getTime();
    const handoffTime = new Date(params.endedAt).getTime();
    if (eventTime <= handoffTime) {
        return false;
    }

    const threshold = resolveTelegramDepartureAdjustmentThreshold(params);
    if (!threshold) {
        return false;
    }

    return eventTime >= threshold.getTime();
}

export function resolveTelegramDepartureAdjustmentThreshold(params: {
    domain: "REGULATION" | "INTERVENTION";
    startedAt: string | Date | null;
    scheduledEndAt?: string | Date | null;
}) {
    if (params.scheduledEndAt) {
        const scheduledEndAt = new Date(params.scheduledEndAt);
        return params.domain === "INTERVENTION"
            ? new Date(scheduledEndAt.getTime() + (15 * 60 * 1000))
            : scheduledEndAt;
    }

    return resolveOvertimeJustificationThreshold(params.startedAt);
}

// ── Departure correction candidates ────────────────────────────────────────────

export function resolveDepartureCorrectionReferenceAt(candidate: TelegramDepartureCorrectionCandidate) {
    return candidate.actualEndedAt ?? candidate.endedAt ?? candidate.startedAt;
}

export function compareDepartureCorrectionCandidates(left: TelegramDepartureCorrectionCandidate, right: TelegramDepartureCorrectionCandidate) {
    const anchorDiff = resolveDepartureCorrectionReferenceAt(right).getTime() - resolveDepartureCorrectionReferenceAt(left).getTime();
    if (anchorDiff !== 0) {
        return anchorDiff;
    }

    if (left.isActive !== right.isActive) {
        return Number(right.isActive) - Number(left.isActive);
    }

    return right.startedAt.getTime() - left.startedAt.getTime();
}

export function normalizeDepartureCorrectionTargetCode(value: string | null | undefined) {
    return value?.trim().toUpperCase() ?? null;
}

export function serializeDepartureCorrectionCandidate(candidate: TelegramDepartureCorrectionCandidate): SerializedTelegramDepartureCorrectionCandidate {
    return {
        occupancyId: candidate.occupancyId,
        domain: candidate.domain,
        targetCode: candidate.targetCode,
        shiftLabel: candidate.shiftLabel,
        roleLabel: candidate.roleLabel,
        startedAt: candidate.startedAt.toISOString(),
        endedAt: candidate.endedAt?.toISOString() ?? null,
        actualEndedAt: candidate.actualEndedAt?.toISOString() ?? null,
        isActive: candidate.isActive,
    };
}

export function deserializeDepartureCorrectionCandidate(candidate: SerializedTelegramDepartureCorrectionCandidate): TelegramDepartureCorrectionCandidate {
    return {
        occupancyId: candidate.occupancyId,
        domain: candidate.domain,
        targetCode: candidate.targetCode,
        shiftLabel: candidate.shiftLabel,
        roleLabel: candidate.roleLabel,
        startedAt: new Date(candidate.startedAt),
        endedAt: candidate.endedAt ? new Date(candidate.endedAt) : null,
        actualEndedAt: candidate.actualEndedAt ? new Date(candidate.actualEndedAt) : null,
        isActive: candidate.isActive,
    };
}

export function parseTelegramStandaloneTime(text: string) {
    return parseMessage(text).arrivalTime;
}

export function pickLikelyDepartureCorrectionCandidate(params: {
    candidates: TelegramDepartureCorrectionCandidate[];
    targetCode?: string | null;
}) {
    const targetCode = normalizeDepartureCorrectionTargetCode(params.targetCode);
    const candidates = params.candidates
        .filter((candidate) => !targetCode || normalizeDepartureCorrectionTargetCode(candidate.targetCode) === targetCode)
        .sort(compareDepartureCorrectionCandidates);

    if (candidates.length === 0) {
        return {
            candidate: null,
            ambiguousCandidates: [] as TelegramDepartureCorrectionCandidate[],
        };
    }

    if (targetCode || candidates.length === 1) {
        return {
            candidate: candidates[0],
            ambiguousCandidates: [] as TelegramDepartureCorrectionCandidate[],
        };
    }

    const [first, second] = candidates;
    if (!second) {
        return {
            candidate: first,
            ambiguousCandidates: [] as TelegramDepartureCorrectionCandidate[],
        };
    }

    const firstAnchor = resolveDepartureCorrectionReferenceAt(first).getTime();
    const secondAnchor = resolveDepartureCorrectionReferenceAt(second).getTime();
    const sameOperationalSlot = first.domain === second.domain
        && first.targetCode === second.targetCode
        && first.shiftLabel === second.shiftLabel;

    if (sameOperationalSlot || (firstAnchor - secondAnchor) >= TELEGRAM_DEPARTURE_CORRECTION_AMBIGUITY_GAP_MS) {
        return {
            candidate: first,
            ambiguousCandidates: [] as TelegramDepartureCorrectionCandidate[],
        };
    }

    return {
        candidate: null,
        ambiguousCandidates: candidates.slice(0, 3),
    };
}

// ── Batch keyword helpers (used by service.ts) ─────────────────────────────────

export function normalizeBatchKeyword(text: string) {
    return normalizeDoctorName(text)
        .replace(/\s+/g, " ")
        .trim();
}

export function isBatchConfirmationKeyword(text: string) {
    const normalized = normalizeBatchKeyword(text);
    return normalized === "CONFIRMAR"
        || normalized === "CONFIRMAR SIM"
        || normalized === "CONFIRMO"
        || normalized === "CONFIRMADO"
        || normalized === "CONFIRMA"
        || normalized === "OK CONFIRMAR"
        || normalized === "OK PODE LANCAR"
        || normalized === "OK LANCAR"
        || normalized === "PODE LANCAR"
        || normalized === "LANCAR TUDO";
}

export function isBatchCancelKeyword(text: string) {
    const normalized = normalizeBatchKeyword(text);
    return normalized === "CANCELAR"
        || normalized === "CANCELA"
        || normalized === "DESCARTAR LOTE";
}
