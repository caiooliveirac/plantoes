import { normalizeDoctorName } from "@/modules/doctors/importer";

const NAME_PARTICLES = new Set(["de", "da", "do", "dos", "das", "e"]);
const AMBIGUOUS_FIRST_NAME_PREFIXES = ["ale", "gabriel", "joao", "lucas", "felipe"];

export interface TelegramDoctorDirectoryEntry {
    id: string;
    fullName: string;
    displayName: string | null;
    normalizedName: string;
    isActive?: boolean;
}

export interface TelegramDoctorCandidate {
    id: string;
    fullName: string;
    displayName: string | null;
    normalizedName: string;
    isActive?: boolean;
    score: number;
}

export function pickConfidentDoctorCandidate(query: string, candidates: TelegramDoctorCandidate[]) {
    if (candidates.length === 0) {
        return null;
    }

    const [first, second] = candidates;
    if (isExactCandidateMatch(query, first)) {
        return first;
    }

    const queryTokens = tokenizeName(query);
    const lead = first.score - (second?.score ?? 0);
    const hasTwoOrMoreTokens = queryTokens.length >= 2;

    if (candidates.length === 1) {
        return first.score >= 150 ? first : null;
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
        .filter((token) => token.length >= 2 && !NAME_PARTICLES.has(token));
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
    return candidate.normalizedName === normalizedQuery || normalizedDisplayName === normalizedQuery;
}

export function scoreDoctorCandidate(query: string, doctor: TelegramDoctorDirectoryEntry) {
    const normalizedQuery = normalizeDoctorName(query);
    if (!normalizedQuery) {
        return 0;
    }

    const doctorTokens = tokenizeName(doctor.fullName);
    const queryTokens = tokenizeName(query);
    const displayNormalized = doctor.displayName ? normalizeDoctorName(doctor.displayName) : "";

    if (doctor.normalizedName === normalizedQuery) {
        return 1000;
    }

    let score = 0;
    if (doctor.normalizedName.includes(normalizedQuery)) {
        score += 220;
    }
    if (displayNormalized && displayNormalized.includes(normalizedQuery)) {
        score += 200;
    }

    const matchedTokens = queryTokens.filter((token) => doctorTokens.includes(token));
    score += matchedTokens.length * 70;

    if (queryTokens[0] && doctorTokens[0] === queryTokens[0]) {
        score += 55;
    }
    if (queryTokens.at(-1) && doctorTokens.at(-1) === queryTokens.at(-1)) {
        score += 55;
    }

    if (
        queryTokens.length >= 2
        && doctorTokens[0] === queryTokens[0]
        && doctorTokens.includes(queryTokens.at(-1) as string)
    ) {
        score += 80;
    }

    if (queryTokens.length > 0 && matchedTokens.length === queryTokens.length) {
        score += 120;
    }

    return score;
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