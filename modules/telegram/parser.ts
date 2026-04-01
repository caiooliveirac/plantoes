import { STANDARD_OPERATIONAL_ROLE_CODES } from "@/modules/operational/roles";

const RAMAIS_REGULACAO = new Set([
    "1321", "1322", "1323", "1324", "1325",
    "1361", "1362", "1363", "1364", "1365", "1366", "1367", "1368",
    "2031", "2032", "2033", "2034", "2035",
    "2151", "2152", "2153", "2154",
    "2377",
]);

const BASES_INTERVENCAO = new Set([
    "SM01", "CB02", "PR03", "PM04", "BR05", "CN10",
    "PP20", "IT30", "PM40", "CZ50", "BR60", "CC70",
]);

const ABBREVIATION_MAP: Record<string, string> = {
    "01": "SM01", "1": "SM01",
    "02": "CB02", "2": "CB02",
    "03": "PR03", "3": "PR03",
    "04": "PM04", "4": "PM04",
    "05": "BR05", "5": "BR05",
    "10": "CN10",
    "20": "PP20",
    "30": "IT30",
    "40": "PM40",
    "50": "CZ50",
    "60": "BR60",
    "70": "CC70",
};

const ARRIVAL_SIGNALS = [
    /\b(?:CHEGUEI|CHEGANDO|CHEGADA|PRESENTE|ASSUMINDO|ASSUMI|RENDENDO|RENDI)\b/i,
    /\b(?:TO\s+AQUI|TÔ\s+AQUI|ESTOU\s+AQUI|JA\s+AQUI|JÁ\s+AQUI)\b/i,
    /\b(?:CONTINUO|CONTINUA|SEGUINDO|SIGO)\b/i,
    /\b(?:DESLOCANDO\s+PARA|INDO\s+PARA|RUMO\s+A)\b/i,
];

const CONTINUATION_SIGNALS = [
    /\b(?:CONT\.?|CONTINHA|CONTINUO|CONTINUA|CONTINUANDO|CONTINUEI|CONTINUAREI)\b/i,
    /\b(?:SEGUINDO|SEGUE|SEGUI|SIGO)\b/i,
    /\b(?:FICO|FICANDO|FIQUEI)\b/i,
    /\b(?:PERMANEC?O|PERMANECENDO|PERMANECE)\b/i,
    /\b(?:EMENDO|EMENDANDO|EMENDA)\b/i,
    /\b(?:PROSSIGO|PROSSEGUINDO)\b/i,
    /\bJA\s+(?:TO|TÔ|ESTOU)\s+(?:NA|NO)\b/i,
    /\bNAO\s+(?:SAI[O]?|SAIO)\b/i,
];

const DEPARTURE_SIGNALS = [
    /\b(?:SAINDO|SAIU|SAI|SAIDA|SAÍDA|ENCERRANDO|ENCERREI|ENCERRADO|FINALIZANDO|FINALIZEI|LIBEREI|LIBERADO|LIBERADA|DESCENDO|DESCI|BAIXANDO|BAIXEI|TERMINEI|TERMINOU)\b/i,
    /\b(?:FIM|FINAL)\s+DE\s+PLANTAO\b/i,
    /\b(?:INDO|FUI|VOU)\s+EMBORA\b/i,
];

const RE_TIME_PATTERNS = [
    /\b(\d{1,2})[:\.](\d{2})(?=\b|h\b|h$)/i,
    /\b(\d{1,2})h(\d{2})?\b/i,
    /(?:às?|as)\s+(\d{1,2})(?:\s*(?:h|hora|horas))?\b/i,
];

const NAME_NOISE_TOKENS = new Set([
    "A", "AO", "AOS", "AS", "ATE", "ATÉ", "BOA", "BOM", "CHEGADA", "CHEGANDO", "CHEGUEI",
    "CONT", "CONTINHA", "CONTINUA", "CONTINUO", "CONTINUANDO", "CONTINUEI", "CONTINUAREI", "CORRIJA", "CRU", "DA", "DAS", "DE",
    "DESLOCANDO", "DIA", "DO", "DOS", "EM", "EMENDO", "EMENDANDO", "EMENDA", "ERRADO", "ESTA", "ESTÁ", "ESTOU", "FICO", "FICANDO", "FIQUEI", "HORARIO",
    "HORÁRIO", "JA", "JÁ", "NA", "NAS", "NO", "NOITE", "NOS", "OLA", "OLA", "OI", "PARA", "PERMANECE", "PERMANECENDO", "PRESENTE",
    "PROSSIGO", "PROSSEGUINDO", "RENDENDO", "RENDI", "SAI", "SAIU", "SAIDA", "SAÍDA", "SAINDO", "ENCERRANDO", "ENCERREI", "FINALIZANDO", "FINALIZEI", "LIBEREI", "SEGUE", "SEGUI", "SEGUIR", "SO", "SÓ", "TO",
    "LIBERADO", "LIBERADA", "DESCENDO", "DESCI", "BAIXANDO", "BAIXEI", "TERMINEI", "TERMINOU",
    "TARDE", "TÔ", "TUDO", "BEM", "AGORA", "AI", "AÍ",
    ...STANDARD_OPERATIONAL_ROLE_CODES,
]);

const CASUAL_PATTERNS = [
    /\b(?:OI|OLA|OLAA|OIE|E\s+AI|E\s+AII|SALVE)\b/i,
    /\bBOM\s+DIA\b/i,
    /\bBOA\s+TARDE\b/i,
    /\bBOA\s+NOITE\b/i,
    /\bBOM\s+PLANTAO\b/i,
    /\bBOM\s+TRABALHO\b/i,
    /\bTUDO\s+BEM\b/i,
    /\bTD\s+BEM\b/i,
    /\bBELEZA\b/i,
    /\bSHOW\b/i,
    /\bVALEU\b/i,
    /\bOBRIGAD[OA]\b/i,
    /\bGRATIDAO\b/i,
    /\bOTIMO\s+PLANTAO\b/i,
    /\bEXCELENTE\s+PLANTAO\b/i,
];

const CASUAL_FILLER_TOKENS = new Set([
    "A", "AE", "AI", "AÍ", "AMIGOS", "AMIGAS", "CHEFIA", "COLEGAS", "E", "EQUIPE",
    "GALERA", "GENTE", "MEUS", "MINHAS", "PESSOAL", "PRA", "PARA", "QUERIDOS",
    "QUERIDAS", "TURMA", "TIME", "TODOS", "TODAS", "VOCES", "VOCÊS",
]);

export interface ParsedMessage {
    sector: "REGULATION" | "INTERVENTION" | null;
    baseCode: string | null;
    arrivalTime: string | null;
    shiftType: "SD" | "SN" | "P" | null;
    roleFunction: string | null;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    isDeparture: boolean;
    isContinuation: boolean;
    extractedNames: string[];
}

export interface ParsedBatchMessageLine {
    lineNumber: number;
    rawLine: string;
    headingSector: "REGULATION" | "INTERVENTION" | null;
    parsed: ParsedMessage;
}

function normalizeTelegramText(value: string) {
    return value.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function isTelegramBatchHeading(line: string) {
    const normalized = normalizeTelegramText(line).replace(/[^A-Z]/g, "");
    if (!normalized) {
        return null;
    }

    if (normalized.includes("REGULACAO")) {
        return "REGULATION" as const;
    }

    if (normalized.includes("INTERVENCAO")) {
        return "INTERVENTION" as const;
    }

    return null;
}

function isTelegramBatchSeparator(line: string) {
    const normalized = line.trim();
    return normalized.length > 0 && /^[\s\-_.~*⸻—–]+$/.test(normalized);
}

export function parseTelegramBatchLines(text: string): ParsedBatchMessageLine[] {
    const lines = text.split(/\r?\n/);
    let headingSector: "REGULATION" | "INTERVENTION" | null = null;

    return lines.flatMap((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || isTelegramBatchSeparator(trimmed)) {
            return [];
        }

        const nextHeading = isTelegramBatchHeading(trimmed);
        if (nextHeading) {
            headingSector = nextHeading;
            return [];
        }

        return [{
            lineNumber: index + 1,
            rawLine: trimmed,
            headingSector,
            parsed: parseMessage(trimmed),
        }];
    });
}

export function parseMessageMulti(text: string): ParsedMessage[] {
    const parts = text
        .split(/\n|(?<=[.!?;])\s+/)
        .map((entry) => entry.trim())
        .filter(Boolean);

    if (parts.length <= 1) {
        return [parseMessage(text)];
    }

    const parsedParts = parts.map((part) => parseMessage(part));
    const results = parsedParts
        .map((entry, index) => enrichParsedEntryFromContext(entry, parsedParts, index))
        .filter((entry) => entry.baseCode);
    return results.length > 0 ? results : [parseMessage(text)];
}

export function parseMessage(text: string): ParsedMessage {
    const normalized = normalizeTelegramText(text);
    let sector: ParsedMessage["sector"] = null;
    let baseCode: string | null = null;
    let arrivalTime: string | null = null;
    let shiftType: ParsedMessage["shiftType"] = null;
    let roleFunction: string | null = null;
    let confidence: ParsedMessage["confidence"] = "LOW";

    const baseMatch = normalized.match(/\b([A-Z]{2})[\s-]?(\d{2})\b/);
    if (baseMatch) {
        const candidate = `${baseMatch[1]}${baseMatch[2]}`;
        if (BASES_INTERVENCAO.has(candidate)) {
            sector = "INTERVENTION";
            baseCode = candidate;
        }
    }

    if (!baseCode) {
        const ramalMatch = normalized.match(/(?:RAMAL|PA|POSICAO|REG)?\s*[:\-]?\s*(\d{4})\b/);
        if (ramalMatch && RAMAIS_REGULACAO.has(ramalMatch[1])) {
            sector = "REGULATION";
            baseCode = ramalMatch[1];
        }
    }

    if (!baseCode) {
        const bareBaseMatch = normalized.match(/(?:^|\s)(?:BASE|NA|NO|DA|DO)?\s*(?<![:\d])0?(01|02|03|04|05|10|20|30|40|50|60|70)\b(?!\s*[:h]\d)/);
        if (bareBaseMatch) {
            const resolved = ABBREVIATION_MAP[bareBaseMatch[1]];
            if (resolved) {
                sector = "INTERVENTION";
                baseCode = resolved;
            }
        }
    }

    for (const re of RE_TIME_PATTERNS) {
        const match = text.match(re);
        if (!match) {
            continue;
        }

        const hours = (match[1] || "0").padStart(2, "0");
        const minutes = (match[2] || "00").padStart(2, "0");
        arrivalTime = `${hours}:${minutes}`;
        break;
    }

    const shiftMatch = normalized.match(/\b(SD|SN|P|DIURNO|NOTURNO)\b/);
    if (shiftMatch) {
        if (shiftMatch[1] === "DIURNO") shiftType = "SD";
        else if (shiftMatch[1] === "NOTURNO") shiftType = "SN";
        else shiftType = shiftMatch[1] as ParsedMessage["shiftType"];
    }

    const roleMatch = normalized.match(new RegExp(`\\b(${STANDARD_OPERATIONAL_ROLE_CODES.join("|")})\\b`));
    if (roleMatch?.[1]) {
        roleFunction = roleMatch[1];
    }

    const extractedNames = extractNames(text);
    const isTransferToDestination = /\b(?:DESLOCANDO\s+PARA|INDO\s+PARA|RUMO\s+A)\b/i.test(normalized);
    const isDeparture = !isTransferToDestination && DEPARTURE_SIGNALS.some((re) => re.test(normalized));
    const isContinuation = CONTINUATION_SIGNALS.some((re) => re.test(normalized));
    const hasArrivalSignal = ARRIVAL_SIGNALS.some((re) => re.test(normalized));

    if (baseCode && (hasArrivalSignal || isDeparture || arrivalTime || shiftType || extractedNames.length > 0)) {
        confidence = extractedNames.length > 0 || hasArrivalSignal || isDeparture ? "HIGH" : "MEDIUM";
    } else if (baseCode) {
        confidence = "MEDIUM";
    }

    return {
        sector,
        baseCode,
        arrivalTime,
        shiftType,
        roleFunction,
        confidence,
        isDeparture,
        isContinuation,
        extractedNames,
    };
}

export function isCasualTelegramMessage(text: string) {
    const normalized = normalizeTelegramText(text);
    const trimmed = normalized.trim();
    if (!trimmed) {
        return false;
    }

    if (trimmed.startsWith("/")) {
        return false;
    }

    const hasCasualSignal = CASUAL_PATTERNS.some((pattern) => pattern.test(trimmed));
    if (!hasCasualSignal) {
        return false;
    }

    const hasOperationalCue = Boolean(
        trimmed.match(/\b([A-Z]{2})[\s-]?(\d{2})\b/)
        || trimmed.match(/(?:RAMAL|PA|POSICAO|REG)?\s*[:\-]?\s*(\d{4})\b/)
        || trimmed.match(/\b(SD|SN|P|DIURNO|NOTURNO)\b/)
        || ARRIVAL_SIGNALS.some((pattern) => pattern.test(trimmed))
        || DEPARTURE_SIGNALS.some((pattern) => pattern.test(trimmed))
        || trimmed.match(/\b(?:BASE|RAMAL|POSICAO|POSICAO|REGULACAO|REGULAÇÃO|CHEGADA|SAIDA|SAIDA|PLANTAO)\s+\d+/)
    );

    if (hasOperationalCue) {
        return false;
    }

    const remainder = trimmed
        .replace(/[!?.;,/\\()[\]{}:+-]/g, " ")
        .replace(/\b(?:OI|OLA|OLAA|OIE|E\s+AI|E\s+AII|SALVE|BOM\s+DIA|BOA\s+TARDE|BOA\s+NOITE|BOM\s+PLANTAO|BOM\s+TRABALHO|TUDO\s+BEM|TD\s+BEM|BELEZA|SHOW|VALEU|OBRIGAD[OA]|GRATIDAO|OTIMO\s+PLANTAO|EXCELENTE\s+PLANTAO)\b/gi, " ")
        .split(/\s+/)
        .filter(Boolean)
        .filter((token) => !CASUAL_FILLER_TOKENS.has(token));

    return remainder.length <= 4;
}

export function looksLikeDepartureMessage(text: string) {
    const normalized = normalizeTelegramText(text);
    return DEPARTURE_SIGNALS.some((pattern) => pattern.test(normalized));
}

function extractNames(text: string) {
    const cleaned = text
        .replace(/@\w+/g, " ")
        .replace(/\b\d{1,2}[:.h]\d{0,2}\b/gi, " ")
        .replace(/\b[A-Z]{2}[\s\-]?\d{2}\b/gi, " ")
        .replace(/\b\d{4}\b/g, " ")
        .replace(/\b(?:SD|SN|P|DIURNO|NOTURNO)\b/gi, " ")
        .replace(/[+\-:;!?.,()\[\]{}]/g, " ")
        .replace(/\bDr[a]?\.?\b/gi, " ")
        .trim();

    const tokens = cleaned.split(/\s+/).filter(Boolean);
    const filtered = tokens.filter((token) => {
        if (token.length <= 1 || !/[A-Za-zÀ-ÿ]/.test(token)) {
            return false;
        }

        const normalizedToken = token.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        return !NAME_NOISE_TOKENS.has(normalizedToken);
    });
    if (filtered.length === 0) {
        return [] as string[];
    }

    return [filtered.join(" ")];
}

function pickNearestStandaloneContext(parts: ParsedMessage[], index: number, predicate: (parsed: ParsedMessage) => boolean) {
    for (let distance = 1; distance < parts.length; distance += 1) {
        const previous = parts[index - distance];
        if (previous && !previous.baseCode && predicate(previous)) {
            return previous;
        }

        const next = parts[index + distance];
        if (next && !next.baseCode && predicate(next)) {
            return next;
        }
    }

    return null;
}

function enrichParsedEntryFromContext(parsed: ParsedMessage, parts: ParsedMessage[], index: number): ParsedMessage {
    if (!parsed.baseCode) {
        return parsed;
    }

    const contextualName = parsed.extractedNames[0]
        ?? pickStandaloneName(pickNearestStandaloneContext(parts, index, (entry) => Boolean(entry.extractedNames[0])) ?? undefined);
    const contextualTime = parsed.arrivalTime
        ?? pickStandaloneTime(pickNearestStandaloneContext(parts, index, (entry) => Boolean(entry.arrivalTime)) ?? undefined);
    const contextualShift = parsed.shiftType
        ?? (pickNearestStandaloneContext(parts, index, (entry) => Boolean(entry.shiftType))?.shiftType ?? null);
    const contextualRole = parsed.roleFunction
        ?? (pickNearestStandaloneContext(parts, index, (entry) => Boolean(entry.roleFunction))?.roleFunction ?? null);
    const contextualDeparture = parsed.isDeparture
        || Boolean(pickNearestStandaloneContext(parts, index, (entry) => entry.isDeparture));
    const contextualContinuation = parsed.isContinuation
        || Boolean(pickNearestStandaloneContext(parts, index, (entry) => entry.isContinuation));
    const enrichedConfidence = parsed.confidence === "HIGH"
        ? "HIGH"
        : (contextualName || contextualTime || contextualShift || contextualDeparture || contextualContinuation)
            ? "HIGH"
            : parsed.confidence;

    return {
        ...parsed,
        arrivalTime: contextualTime,
        shiftType: contextualShift,
        roleFunction: contextualRole,
        confidence: enrichedConfidence,
        isDeparture: contextualDeparture,
        isContinuation: contextualContinuation,
        extractedNames: contextualName ? [contextualName] : parsed.extractedNames,
    };
}

function pickStandaloneName(parsed?: ParsedMessage) {
    if (!parsed || parsed.baseCode || parsed.isDeparture || parsed.shiftType || parsed.arrivalTime) {
        return null;
    }

    return parsed.extractedNames[0] ?? null;
}

function pickStandaloneTime(parsed?: ParsedMessage) {
    if (!parsed || parsed.baseCode || parsed.isDeparture || parsed.shiftType) {
        return null;
    }

    return parsed.arrivalTime ?? null;
}