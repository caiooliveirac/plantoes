import { normalizeDoctorName } from "@/modules/doctors/importer";

const NAME_PARTICLES = new Set(["de", "da", "do", "dos", "das", "e"]);
const AMBIGUOUS_FIRST_NAME_PREFIXES = ["ale", "gabriel", "joao", "lucas", "felipe"];

export interface TelegramDoctorDirectoryEntry {
    id: string;
    fullName: string;
    displayName: string | null;
    aliases?: string[];
    normalizedName: string;
    isActive?: boolean;
}

export interface TelegramDoctorCandidate {
    id: string;
    fullName: string;
    displayName: string | null;
    aliases?: string[];
    normalizedName: string;
    isActive?: boolean;
    score: number;
}

export function pickConfidentDoctorCandidate(query: string, candidates: TelegramDoctorCandidate[]) {
    if (candidates.length === 0) {
        return null;
    }

    const [first, second] = candidates;
    if (isExactCandidateMatch(query, first) && !(second && isExactCandidateMatch(query, second))) {
        return first;
    }

    const queryTokens = tokenizeName(query);
    const lead = first.score - (second?.score ?? 0);
    const hasTwoOrMoreTokens = queryTokens.length >= 2;

    if (candidates.length === 1) {
        return first.score >= 100 ? first : null;
    }

    if (hasTwoOrMoreTokens && first.score >= 220 && lead >= 25) {
        return first;
    }

    if (first.score >= 280 && lead >= 15) {
        return first;
    }

    if (first.score >= 180 && lead >= 60) {
        return first;
    }

    return null;
}

function tokenizeName(value: string) {
    return normalizeDoctorName(value)
        .split(/\s+/)
        .filter((token) => token.length >= 2 && !NAME_PARTICLES.has(token))
        .map((token) => token.replace(/Y/g, "I"));
}

function hasAmbiguousFrequentPrefix(query: string) {
    const firstToken = tokenizeName(query)[0]?.toLowerCase() ?? "";
    if (!firstToken) {
        return false;
    }

    return AMBIGUOUS_FIRST_NAME_PREFIXES.some((prefix) => firstToken.startsWith(prefix));
}

function isExactCandidateMatch(query: string, candidate: TelegramDoctorCandidate) {
    const normalizedQuery = normalizeDoctorName(query);
    const normalizedDisplayName = candidate.displayName ? normalizeDoctorName(candidate.displayName) : "";
    const normalizedAliases = (candidate.aliases ?? []).map((alias) => normalizeDoctorName(alias));
    return candidate.normalizedName === normalizedQuery
        || normalizedDisplayName === normalizedQuery
        || normalizedAliases.includes(normalizedQuery);
}

function scoreCandidateVariant(query: string, variant: string | null | undefined) {
    const normalizedQuery = normalizeDoctorName(query);
    const normalizedVariant = normalizeDoctorName(variant ?? "");
    if (!normalizedQuery || !normalizedVariant) {
        return 0;
    }

    if (normalizedVariant === normalizedQuery) {
        return 1000;
    }

    const variantTokens = tokenizeName(variant ?? "");
    const queryTokens = tokenizeName(query);
    let score = 0;

    if (normalizedVariant.includes(normalizedQuery)) {
        score += 220;
    }

    const matchedTokens = queryTokens.filter((token) => variantTokens.includes(token));
    score += matchedTokens.length * 70;

    if (queryTokens[0] && variantTokens[0] === queryTokens[0]) {
        score += 55;
    }
    if (queryTokens.at(-1) && variantTokens.at(-1) === queryTokens.at(-1)) {
        score += 55;
    }

    if (
        queryTokens.length >= 2
        && variantTokens[0] === queryTokens[0]
        && variantTokens.includes(queryTokens.at(-1) as string)
    ) {
        score += 80;
    }

    if (queryTokens.length > 0 && matchedTokens.length === queryTokens.length) {
        score += 120;
    }

    return score;
}

export function scoreDoctorCandidate(query: string, doctor: TelegramDoctorDirectoryEntry) {
    const normalizedQuery = normalizeDoctorName(query);
    if (!normalizedQuery) {
        return 0;
    }

    return Math.max(
        scoreCandidateVariant(query, doctor.fullName),
        scoreCandidateVariant(query, doctor.displayName),
        ...(doctor.aliases ?? []).map((alias) => scoreCandidateVariant(query, alias)),
    );
}

export function resolveDoctorCandidates(
    query: string,
    directory: TelegramDoctorDirectoryEntry[],
    limit = 5,
) {
    const normalizedQuery = normalizeDoctorName(query);
    if (!normalizedQuery) {
        return [] as TelegramDoctorCandidate[];
    }

    return directory
        .map((doctor) => ({
            ...doctor,
            score: scoreDoctorCandidate(query, doctor),
        }))
        .filter((doctor) => doctor.score > 0)
        .sort((left, right) => {
            const scoreDiff = right.score - left.score;
            if (scoreDiff !== 0) {
                return scoreDiff;
            }

            const activeDiff = Number(right.isActive ?? false) - Number(left.isActive ?? false);
            if (activeDiff !== 0) {
                return activeDiff;
            }

            return left.fullName.localeCompare(right.fullName, "pt-BR");
        })
        .slice(0, limit);
}

export function pickCandidateFromReply(replyText: string, candidates: TelegramDoctorCandidate[]) {
    const cleaned = replyText.trim();
    if (!cleaned) {
        return null;
    }

    const numericChoice = cleaned.match(/^([1-9]\d*)$/);
    if (numericChoice) {
        const index = Number(numericChoice[1]) - 1;
        return candidates[index] ?? null;
    }

    const rescored = resolveDoctorCandidates(cleaned, candidates, candidates.length);
    if (rescored.length === 0) {
        return null;
    }

    if (rescored.length === 1) {
        return rescored[0];
    }

    if (isExactCandidateMatch(cleaned, rescored[0])) {
        return rescored[0];
    }

    const confidentCandidate = pickConfidentDoctorCandidate(cleaned, rescored);
    if (confidentCandidate) {
        return confidentCandidate;
    }

    const ambiguousFrequentPrefix = hasAmbiguousFrequentPrefix(cleaned);
    const queryTokens = tokenizeName(cleaned);
    const scoreLead = rescored[0].score - rescored[1].score;

    if (ambiguousFrequentPrefix) {
        return queryTokens.length >= 2 && scoreLead >= 80 ? rescored[0] : null;
    }

    return scoreLead >= 40 ? rescored[0] : null;
}