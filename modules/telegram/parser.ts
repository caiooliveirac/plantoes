import { HALF_SHIFT_ROLE_LABEL } from "@/modules/operational/half-shift";
import { STANDARD_OPERATIONAL_ROLE_CODES } from "@/modules/operational/roles";
import { computeLevenshteinDistance } from "@/modules/telegram/departure-flow";

const RAMAIS_REGULACAO = new Set([
    "1321", "1322", "1323", "1324", "1325", "1326", "1327", "1328", "1329",
    "1361", "1362", "1363", "1364", "1365", "1366", "1367", "1368",
    "1476",
    "2031", "2032", "2033", "2034", "2035",
    "2151", "2152", "2153", "2154",
    "2262", "2263",
    "2376", "2377",
]);

const BASES_INTERVENCAO = new Set([
    "SM01", "CB02", "PR03", "PM04", "BR05", "CN10",
    "PP20", "IT30", "PM40", "CZ50", "BR60", "CC70",
]);

// Bases de intervenção cujo código NÃO segue o shape XX99 (só letras). Precisam
// de uma passada própria no parser — o loop de XX99 nunca as enxerga. Ver GOA
// (base diurna, migration 0035): o mesmo papel que NUCLEO/PIAM têm na regulação.
const BASES_INTERVENCAO_NOMEADAS = ["GOA"] as const;
const NAMED_BASE_PATTERN = new RegExp(`\\b(${BASES_INTERVENCAO_NOMEADAS.join("|")})\\b`);

/**
 * Códigos de base de intervenção que o parser reconhece (XX99 + nomeadas), na
 * ordem de exibição. Fonte única para listas didáticas (ex.: resposta do
 * /chave) — em vez de uma cópia à mão que dessincroniza quando nasce base nova.
 */
export function listKnownInterventionBaseCodes(): string[] {
    return [...BASES_INTERVENCAO, ...BASES_INTERVENCAO_NOMEADAS];
}

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
    /\b(?:CHEGUEI|CHEGANDO|CHEGADA|PRESENTE|ASSUMINDO|ASSUMI|RENDENDO)\b/i,
    /\b(?:TO\s+AQUI|TÔ\s+AQUI|ESTOU\s+AQUI|JA\s+AQUI|JÁ\s+AQUI)\b/i,
    /\b(?:CONTINUO|CONTINUA|SEGUINDO|SIGO)\b/i,
    /\b(?:DESLOCANDO\s+PARA|INDO\s+PARA|RUMO\s+A)\b/i,
];

// Plantonista se declarando como MEIO plantão / meio turno (pago como MEIO).
// Reconhecido para que uma chegada tardia tipo "meio turno as 11:30" não seja
// rejeitada por faltar SD/SN/P. Só é honrado mais adiante dentro da janela de
// meio plantão (ver shouldAssumeTelegramHalfShift), quando o turno já não está
// mais sendo oferecido inteiro. "BOA TARDE" é saudação, não sinal.
const HALF_SHIFT_SIGNALS = [
    /\bMEIO\s*[-_]?\s*(?:PLANTAO|TURNO)\b/,
    /\bMEIO\b/,
    /\bM[PT]\b/,
    /\b(?:PLANTAO|TURNO)\s+(?:DA\s+)?TARDE\b/,
];

function hasHalfShiftSignal(normalized: string) {
    if (HALF_SHIFT_SIGNALS.some((re) => re.test(normalized))) {
        return true;
    }
    return /\bTARDE\b/.test(normalized) && !/\bBOA\s+TARDE\b/.test(normalized);
}

const CONTINUATION_SIGNALS = [
    /\b(?:CONT\.?|CONTINHA|CONTINUO|CONTINUA|CONTINUANDO|CONTINUEI|CONTINUAREI|CONTINUAR)\b/i,
    /\b(?:SEGUINDO|SEGUE|SEGUI|SIGO|SEGUIR)\b/i,
    /\b(?:FICO|FICANDO|FIQUEI|FICAR)\b/i,
    /\b(?:PERMANEC?O|PERMANECENDO|PERMANECE|PERMANECER)\b/i,
    /\b(?:EMENDO|EMENDANDO|EMENDA|EMENDAR)\b/i,
    /\b(?:PROSSIGO|PROSSEGUINDO|PROSSEGUIR)\b/i,
    /\bJA\s+(?:TO|TO|ESTOU)\s+(?:NA|NO)\b/i,
    /\bNAO\s+(?:SAI[O]?|SAIO)\b/i,
    /\b(?:VOU|VAI|VAMOS)\s+(?:CONTINUAR|CONTINUANDO|FICAR|FICANDO|PERMANECER|PERMANECENDO|SEGUIR|SEGUINDO|EMENDAR|EMENDANDO|PROSSEGUIR|PROSSEGUINDO)\b/i,
];

const DEPARTURE_SIGNALS = [
    /\b(?:SAINDO|SAIU|SAI|SAIDA|SAÍDA|ENCERRANDO|ENCERREI|ENCERRADO|FINALIZANDO|FINALIZEI|LIBEREI|LIBERADO|LIBERADA|DESCENDO|DESCI|BAIXANDO|BAIXEI|TERMINEI|TERMINOU)\b/i,
    /\b(?:RETIRAR|RETIRO|RETIRANDO|RETIRADA|RETIRADO|RETIREI)\b/i,
    /\b(?:FIM|FINAL)\s+DE\s+PLANTAO\b/i,
    /\b(?:INDO|FUI|VOU)\s+EMBORA\b/i,
    /\b(?:FUI|SENDO)\s+RENDID[OA]\b/i,
];

// F4: Fuzzy departure keywords — catch common typos like "aaindo", "saimo", "saiindo"
const DEPARTURE_FUZZY_KEYWORDS = [
    "SAINDO", "SAIU", "SAIDA", "ENCERRANDO", "ENCERREI", "ENCERRADO",
    "FINALIZANDO", "FINALIZEI",
    "DESCENDO", "DESCI", "BAIXANDO", "BAIXEI", "TERMINEI", "TERMINOU",
];

function hasFuzzyDepartureSignal(normalized: string): boolean {
    const tokens = normalized.split(/\s+/).filter(Boolean);
    return tokens.some((token) =>
        token.length >= 4 && DEPARTURE_FUZZY_KEYWORDS.some((keyword) => {
            if (token === keyword) return false; // Already caught by regex
            const threshold = keyword.length >= 10 ? 3 : keyword.length >= 7 ? 2 : 1;
            return computeLevenshteinDistance(token, keyword) <= threshold;
        }),
    );
}

const REASSIGNMENT_SIGNALS = [
    /\b(?:TROCANDO|TROCOU|TROQUEI|MUDANDO|MUDOU|MUDEI)\s+(?:DE\s+\S+\s+)?(?:PARA|P\/|PRO|PRA)\b/i,
    /\b(?:REMANEJAD[OA]|TRANSFERID[OA])\s+(?:PARA|P\/|PRO|PRA)\b/i,
];

const RE_TIME_PATTERNS = [
    /\b(\d{1,2})[:\.](\d{2})(?=\b|h\b|h$)/i,
    /\b(\d{1,2})h(\d{2})?\b/i,
    /(?:às?|as)\s+(\d{1,2})(?:\s*(?:h|hora|horas))?\b/i,
];

const NAME_NOISE_TOKENS = new Set([
    "A", "AO", "AOS", "AS", "ATE", "ATÉ", "BOA", "BOM", "CHEGADA", "CHEGANDO", "CHEGUEI",
    "CONT", "CONTINHA", "CONTINUA", "CONTINUO", "CONTINUANDO", "CONTINUEI", "CONTINUAREI", "CONTINUAR", "CORRIJA", "CRU", "DA", "DAS", "DE", "DESDE",
    "DESLOCANDO", "DIA", "DO", "DOS", "EM", "EMENDO", "EMENDANDO", "EMENDA", "EMENDAR", "ENTRADA", "ERRADO", "ESTA", "ESTÁ", "ESTOU", "FICO", "FICANDO", "FIQUEI", "FICAR", "HORARIO",
    "HORÁRIO", "JA", "JÁ", "LOGIN", "NA", "NAS", "NO", "NOITE", "NOS", "OLA", "OLA", "OI", "PARA", "PERMANECE", "PERMANECENDO", "PERMANECER", "POR", "PRESENTE",
    "PROSSIGO", "PROSSEGUINDO", "PROSSEGUIR", "RENDENDO", "RENDI", "RENDIDA", "RENDIDO", "SAI", "SAIU", "SAIDA", "SAÍDA", "SAINDO", "ENCERRANDO", "ENCERREI", "FINALIZANDO", "FINALIZEI", "LIBEREI", "SEGUE", "SEGUI", "SEGUIR", "SEGUINDO", "SIGO", "SO", "SOMBRA", "SÓ", "TO",
    "LIBERADO", "LIBERADA", "DESCENDO", "DESCI", "BAIXANDO", "BAIXEI", "TERMINEI", "TERMINOU", "VOU", "VAI", "VAMOS",
    "CHEFIA", "SISTEMA", "TARDE", "TÔ", "TUDO", "BEM", "AGORA", "AI", "AÍ",
    // Tokens operacionais que contaminavam a query de nomes (audit 2026-04)
    "MUDANDO", "MUDOU", "MUDEI", "TROCANDO", "TROCOU", "TROQUEI", "LOGADA", "LOGADO", "LOGOU",
    "REMANEJADO", "REMANEJADA", "TRANSFERIDO", "TRANSFERIDA",
    "APOS", "APÓS", "REDIGIR", "OCORRENCIA", "OCORRENCIAS", "OCORRÊNCIA", "OCORRÊNCIAS",
    "FUI", "PELA", "PELO", "PORQUE", "POIS", "RELATO", "PLANTAO", "PLANTÃO",
    "TURNO", "DESATIVADA", "DESATIVADO", "ATIVADA", "ATIVADO",
    "RECONHECEU", "RECONHECEU", "FURO", "ESCALA", "TEMPO", "COLEGA",
    "RENDIÇÃO", "RENDICAO", "PASSAGEM", "HIGIENIZACAO", "HIGIENIZAÇÃO",
    "ATENDIMENTO", "CHAMADO",
    // Tokens adicionais identificados no audit diário (06/abr/2026)
    "ESTAVA", "ESTAVAM", "NUCLEO", "PA", "CHAGADA", "POSICAO",
    "ORDEM", "QUAL", "EMBORA", "RENDIDO", "RENDIDA",
    // Tokens adicionais identificados no audit (07/abr/2026)
    "PLANTA", "PLANTAR", "REALOCADO", "REALOCADA", "REALOCANDO",
    "CORRIGIR", "CORRECAO", "MEDICO", "MEDICA", "MRV", "CHEFE",
    "EU", "MEU", "MINHA", "INTE", "CB", "COMUNICO", "ALMOCO",
    // Sinais de meio plantão não devem contaminar o nome do médico (audit 2026-05).
    "MEIO", "MP", "MT",
    "RETIRAR", "RETIRADA", "RETIRADO", "RETIRANDO", "RETIRO", "RETIREI",
    // Saudacoes/verbos discursivos em mensagens multi-linha (audit 2026-05):
    // "Bom dia informo\nSaida da BR60" extraia "informo" como nome.
    "INFORMO", "AVISO", "INFORMA", "AVISA", "PESSOAL", "GALERA", "GENTE",
    "BOM", "BOA", "OLA", "OI", "DIA", "TARDE", "NOITE",
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
    /\bPERFEIT[OA]\b/i,
    /^K{3,}\b/i,
    /\bVAI\s+DAR\s+CERTO\b/i,
    /\bNAO\s+ENTENDI\b/i,
    /\bDESIST[OI]\b/i,
    // P6: conversational patterns that are not operational registrations
    /\bAJUDA\b/i,
    /\bQUEM\s+(?:E|ESTA|TA)\b/i,
    /\bCADASTR/i,
    /\bCOMO\s+(?:FAZ|FACO|USA)\b/i,
];

const CASUAL_FILLER_TOKENS = new Set([
    "A", "AE", "AI", "AÍ", "AMIGOS", "AMIGAS", "CHEFIA", "COLEGAS", "DA", "DE", "DO", "E", "EQUIPE",
    "GALERA", "GENTE", "JESUS", "MEUS", "MINHAS", "NAO", "O", "PESSOAL", "PRA", "PARA", "QUERIDOS",
    "QUERIDAS", "SUA", "TURMA", "TIME", "TODOS", "TODAS", "VOCES", "VOCÊS",
]);

const OPERATIONAL_META_KEYWORDS = [
    /\bVAGA(?:S)?\b/i,
    /\bCOBERTURA\b/i,
    /\bSEM\s+MEDIC[OA]\b/i,
    /\bFURO\b/i,
    /\bDESCOBERT[OA]\b/i,
    /\bQUEM\s+(?:COBRE|ASSUME|RENDE)\b/i,
    /\bALGU[ÉE]M\s+(?:COBRE|ASSUME|RENDE)\b/i,
    /\bPRECISA\s+DE\s+COBERTURA\b/i,
];

const OPERATIONAL_META_TARGET_CUES = /\b(?:\d{4}|[A-Z]{2}[\s-]?\d{2}|CRU|COI|NUCLEO|PIAM)\b/i;

// Pares de letras que casam com o padrão XX99 mas nunca são tentativa de base
// ("AS 07", "SD 07", "DA 60"...). Usado só no diagnóstico de destino desconhecido.
const UNKNOWN_TARGET_LETTER_STOPWORDS = new Set([
    "AS", "AO", "DA", "DE", "DO", "NA", "NO", "EM", "SD", "SN", "HS", "HR",
    "JA", "AH", "EH", "TO", "AT", "ATE",
]);

// Candidato a destino que o parser NÃO reconheceu: 4 dígitos que não são ramal
// (nem o horário já extraído) ou XX99 que não é base. Diagnóstico apenas — nunca
// vira registro sozinho.
function extractUnknownTargetToken(source: string, arrivalTime: string | null): string | null {
    const timeDigits = arrivalTime ? arrivalTime.replace(":", "") : null;
    const timeDigitsUnpadded = arrivalTime ? arrivalTime.replace(/^0/, "").replace(":", "") : null;

    for (const match of source.matchAll(/(?<![\d:.,/-])(\d{4})(?![\d:.,/hH])/g)) {
        const token = match[1];
        if (token === timeDigits || token === timeDigitsUnpadded) {
            continue;
        }
        return token;
    }

    for (const match of source.matchAll(/\b([A-Z]{2})[\s-]?(\d{2})\b/g)) {
        if (UNKNOWN_TARGET_LETTER_STOPWORDS.has(match[1])) {
            continue;
        }
        return `${match[1]}${match[2]}`;
    }

    return null;
}
const OPERATIONAL_META_QUESTION_CUES = /[?]|\b(?:QUEM|ALGU[ÉE]M|TEM|TA|ESTA|ESTÁ|CADE|CAD[EÊ]|FALTA|PRECISA)\b/i;

export interface ParsedMessage {
    sector: "REGULATION" | "INTERVENTION" | null;
    baseCode: string | null;
    arrivalTime: string | null;
    shiftType: "SD" | "SN" | "P" | null;
    roleFunction: string | null;
    isShadow?: boolean;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    isDeparture: boolean;
    isContinuation: boolean;
    isReassignment: boolean;
    extractedNames: string[];
    /**
     * Token que PARECE um destino (4 dígitos ou XX99) mas não é ramal/base
     * conhecido — preenchido só quando nenhum baseCode foi resolvido. Permite
     * diagnóstico "não conheço *2376*" + sugestões por distância de edição
     * (auditoria comunicação §3.1#9). Campo aditivo: ausente = sem candidato.
     */
    unknownTargetToken?: string | null;
}

export interface ParsedBatchMessageLine {
    lineNumber: number;
    rawLine: string;
    headingSector: "REGULATION" | "INTERVENTION" | null;
    parsed: ParsedMessage;
}

function normalizeTelegramText(value: string) {
    return value
        .replace(/[_*~`]/g, "")  // Strip Telegram markdown formatting
        .toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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
    // F1 fix: Try parsing the whole text first. If it yields a valid operational entry
    // with baseCode + extractedNames, prefer that over splitting — splitting by \n can
    // separate a doctor name from the base code (e.g. "Marcela Carvalho saindo da PM\n40").
    const wholeParsed = parseMessage(text);
    if (wholeParsed.baseCode && wholeParsed.extractedNames.length > 0) {
        return [wholeParsed];
    }

    const parts = text
        .split(/\n|(?<=[.!?;])\s+/)
        .map((entry) => entry.trim())
        .filter(Boolean);

    if (parts.length <= 1) {
        return [wholeParsed.baseCode ? [wholeParsed] : [parseMessage(text)]].flat();
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

    // Detect reassignment early so we can extract the TARGET base from after "para"
    const isReassignment = REASSIGNMENT_SIGNALS.some((re) => re.test(normalized));
    let baseExtractionSource = normalized;
    if (isReassignment) {
        const paraPattern = /\b(?:TROCANDO|TROCOU|TROQUEI|MUDANDO|MUDOU|MUDEI|REMANEJAD[OA]|TRANSFERID[OA])\s+(?:DE\s+\S+\s+)?(?:PARA|P\/|PRO|PRA)\s+/i;
        const paraMatch = normalized.match(paraPattern);
        if (paraMatch && paraMatch.index !== undefined) {
            baseExtractionSource = normalized.slice(paraMatch.index + paraMatch[0].length);
        }
    }

    // Iterate all XX-NN matches to find the first valid intervention base
    // (avoids false positives like "AS 07" blocking detection of "PR03")
    for (const baseMatch of baseExtractionSource.matchAll(/\b([A-Z]{2})[\s-]?(\d{2})\b/g)) {
        const candidate = `${baseMatch[1]}${baseMatch[2]}`;
        if (BASES_INTERVENCAO.has(candidate)) {
            sector = "INTERVENTION";
            baseCode = candidate;
            break;
        }
    }

    // Bases nomeadas (GOA): código sem dígitos, invisível ao loop XX99 acima.
    if (!baseCode) {
        const namedBaseMatch = baseExtractionSource.match(NAMED_BASE_PATTERN);
        if (namedBaseMatch) {
            sector = "INTERVENTION";
            baseCode = namedBaseMatch[1];
        }
    }

    if (!baseCode) {
        const ramalMatch = baseExtractionSource.match(/(?:RAMAL|PA|POSICAO|REG)?\s*[:\-]?\s*(\d{4})\b/);
        if (ramalMatch && RAMAIS_REGULACAO.has(ramalMatch[1])) {
            sector = "REGULATION";
            baseCode = ramalMatch[1];
        }
    }

    if (!baseCode) {
        const bareBaseMatch = baseExtractionSource.match(/(?:^|\s)(?:BASE|NA|NO|DA|DO)?\s*(?<![:\d])0?(01|02|03|04|05|10|20|30|40|50|60|70)\b(?!\s*[:h]\d)/);
        if (bareBaseMatch) {
            const resolved = ABBREVIATION_MAP[bareBaseMatch[1]];
            if (resolved) {
                sector = "INTERVENTION";
                baseCode = resolved;
            }
        }
    }

    // Detect NUCLEO / PIAM as regulation positions (non-numeric codes)
    if (!baseCode) {
        const namedPostMatch = baseExtractionSource.match(/\b(NUCLEO|PIAM)\b/);
        if (namedPostMatch) {
            sector = "REGULATION";
            baseCode = namedPostMatch[1];
        }
    }

    for (const re of RE_TIME_PATTERNS) {
        const match = text.match(re);
        if (!match) {
            continue;
        }

        const hours = (match[1] || "0").padStart(2, "0");
        const minutes = (match[2] || "00").padStart(2, "0");
        if (hours === "24" && minutes === "00") {
            // "24h" is a shift duration (plantão 24h), not a clock time.
            continue;
        }
        arrivalTime = `${hours}:${minutes}`;
        break;
    }

    const shiftMatch = normalized.match(/\b(SD|SN|P|DIURNO|NOTURNO|24\s*H(?:S|ORAS?)?)\b/);
    if (shiftMatch) {
        if (shiftMatch[1] === "DIURNO") shiftType = "SD";
        else if (shiftMatch[1] === "NOTURNO") shiftType = "SN";
        else if (shiftMatch[1].startsWith("24")) shiftType = "P";
        else shiftType = shiftMatch[1] as ParsedMessage["shiftType"];
    }

    // "RECIPIENDARIO" / "RECIPIENDARIA" are the written-out forms of "RECIP".
    // Replace them before applying the word-boundary role regex (which only matches the short code).
    const normalizedForRole = normalized.replace(/\bRECIPIENDARI[OA]\b/g, "RECIP");
    const roleMatch = normalizedForRole.match(new RegExp(`\\b(${STANDARD_OPERATIONAL_ROLE_CODES.join("|")})\\b`));
    if (roleMatch?.[1]) {
        roleFunction = roleMatch[1];
    }

    // Meio plantão / meio turno declarado sem SD/SN/P explícito: marca o papel
    // como MEIO para sobreviver ao gate de chegada. Quando o médico já informou
    // um turno explícito, esse é respeitado e "tarde" fica sendo só hora do dia.
    if (!shiftType && !roleFunction && hasHalfShiftSignal(normalized)) {
        roleFunction = HALF_SHIFT_ROLE_LABEL;
    }

    const isShadow = /\b(?:SOMBRA|SHADOW)\b/i.test(normalized);

    const isTransferToDestination = /\b(?:DESLOCANDO\s+PARA|INDO\s+PARA|RUMO\s+A)\b/i.test(normalized);
    const isDeparture = !isTransferToDestination && !isReassignment && (
        DEPARTURE_SIGNALS.some((re) => re.test(normalized))
        || hasFuzzyDepartureSignal(normalized)
    );
    const extractedNames = extractNames(text, { departureSplit: isDeparture, reassignmentSplit: isReassignment });
    const isContinuation = !isReassignment && CONTINUATION_SIGNALS.some((re) => re.test(normalized));
    const hasArrivalSignal = ARRIVAL_SIGNALS.some((re) => re.test(normalized));

    if (baseCode && (hasArrivalSignal || isDeparture || isReassignment || arrivalTime || shiftType || extractedNames.length > 0)) {
        confidence = extractedNames.length > 0 || hasArrivalSignal || isDeparture || isReassignment ? "HIGH" : "MEDIUM";
    } else if (baseCode) {
        confidence = "MEDIUM";
    }

    // Diagnóstico de destino desconhecido (auditoria §3.1#9): só quando NENHUM
    // ramal/base foi resolvido — expõe o token rejeitado para o serviço sugerir
    // códigos reais próximos.
    const unknownTargetToken = baseCode ? null : extractUnknownTargetToken(baseExtractionSource, arrivalTime);

    return {
        sector,
        baseCode,
        arrivalTime,
        shiftType,
        roleFunction,
        isShadow,
        confidence,
        isDeparture,
        isContinuation,
        isReassignment,
        extractedNames,
        unknownTargetToken,
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

    // Emoji-only messages (possibly with whitespace/punctuation)
    const withoutEmoji = trimmed.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, "").replace(/[!?.;,\s]/g, "").trim();
    if (!withoutEmoji) {
        return true;
    }

    const hasCasualSignal = CASUAL_PATTERNS.some((pattern) => pattern.test(trimmed));
    if (!hasCasualSignal) {
        return false;
    }

    const remainder = trimmed
        .replace(/[!?.;,/\\()[\]{}:+-]/g, " ")
        .replace(/\b(?:OI|OLA|OLAA|OIE|E\s+AI|E\s+AII|SALVE|BOM\s+DIA|BOA\s+TARDE|BOA\s+NOITE|BOM\s+PLANTAO|BOM\s+TRABALHO|TUDO\s+BEM|TD\s+BEM|BELEZA|SHOW|VALEU|OBRIGAD[OA]|GRATIDAO|OTIMO\s+PLANTAO|EXCELENTE\s+PLANTAO|PERFEITO|PERFEITA|VAI\s+DAR\s+CERTO|NAO\s+ENTENDI|DESIST[OI])\b/gi, " ")
        .replace(/K{3,}/gi, " ")
        .split(/\s+/)
        .filter(Boolean)
        .filter((token) => !CASUAL_FILLER_TOKENS.has(token));

    return remainder.length <= 4;
}

export function looksLikeOperationalMetaConversation(text: string) {
    const normalized = normalizeTelegramText(text).trim();
    if (!normalized || normalized.startsWith("/")) {
        return false;
    }

    const hasMetaKeyword = OPERATIONAL_META_KEYWORDS.some((pattern) => pattern.test(normalized));
    if (!hasMetaKeyword) {
        return false;
    }

    const hasQuestionCue = OPERATIONAL_META_QUESTION_CUES.test(normalized);
    const hasTargetCue = OPERATIONAL_META_TARGET_CUES.test(normalized);
    if (!hasQuestionCue && !hasTargetCue) {
        return false;
    }

    const hasExplicitOperationalSignal = ARRIVAL_SIGNALS.some((re) => re.test(normalized))
        || CONTINUATION_SIGNALS.some((re) => re.test(normalized))
        || DEPARTURE_SIGNALS.some((re) => re.test(normalized))
        || REASSIGNMENT_SIGNALS.some((re) => re.test(normalized))
        || hasFuzzyDepartureSignal(normalized);
    if (hasExplicitOperationalSignal) {
        return false;
    }

    // Guardrail: keep strongly-structured operational records out of this bucket.
    const parsed = parseMessage(text);
    const looksStructuredOperational = Boolean(
        parsed.baseCode
        && (parsed.arrivalTime || parsed.shiftType),
    );
    if (looksStructuredOperational && !hasQuestionCue) {
        return false;
    }

    return true;
}

// F5: Detect messages about meal breaks (almoço/descanso/jantar) that should NOT be
// treated as arrivals. When someone writes "1368 ALMOÇO 12:30" or "MARIANA ALMOÇO 1368",
// the ramal triggers operational parsing but the intent is meal-break scheduling.
// Note: normalizeTelegramText strips accents, so ALMOÇO → ALMOCO, ALOMOÇO → ALOMOCO etc.
// Tolerant to typos: covers almoco/alomoco/almço/almuço/almoçando/almoçar/almocei,
// jantar/janta/jantando, descanso/descansar/descansando, refeicao/refeições.
export const MEAL_BREAK_KEYWORDS = /\b(?:AL(?:MO|OM|MU|MC)\w{0,8}|JANT\w{0,5}|DESCANS\w{0,6}|REFEI[CK]\w{0,5})\b/;

export function looksLikeMealBreakMessage(text: string): boolean {
    return MEAL_BREAK_KEYWORDS.test(normalizeTelegramText(text));
}

export function looksLikeDepartureMessage(text: string) {
    const normalized = normalizeTelegramText(text);
    return DEPARTURE_SIGNALS.some((pattern) => pattern.test(normalized));
}

function extractNames(text: string, options?: { departureSplit?: boolean; reassignmentSplit?: boolean }) {
    // For departure messages with "rendida/rendido por", only keep the part BEFORE the split
    // so we extract the departing doctor, not the replacing one.
    let nameSource = text;
    if (options?.departureSplit) {
        const splitMatch = text.match(/\b(?:rendid[oa]|substituíd[oa]|trocad[oa])\s+(?:por|pelo|pela)\b/i);
        if (splitMatch && splitMatch.index !== undefined) {
            nameSource = text.slice(0, splitMatch.index);
        }
    }

    // For reassignment messages, extract the doctor name from BEFORE the reassignment signal
    if (options?.reassignmentSplit) {
        const reassignmentMatch = text.match(/\b(?:trocando|trocou|mudando|mudou|remanejad[oa]|transferid[oa])\s+(?:para|p\/|pro|pra)\b/i);
        if (reassignmentMatch && reassignmentMatch.index !== undefined) {
            nameSource = text.slice(0, reassignmentMatch.index);
        }
    }

    const cleaned = nameSource
        .replace(/[_*~`]/g, "")  // Strip Telegram markdown
        .replace(/@\w+/g, " ")
        .replace(/\b\d{1,2}[:.h]\d{0,2}\s*(?:hrs?|hs|horas?)?\b/gi, " ")  // times + hrs/hs suffix
        .replace(/\b[A-Z]{2}[\s\-]?\d{2}\b/gi, " ")
        .replace(/\b\d{4}\b/g, " ")
        .replace(/\b(?:SD|SN|P|DIURNO|NOTURNO)\b/gi, " ")
        .replace(/\b\d+H?\b/gi, " ")
        .replace(/\bP\/\b/gi, " ")
        .replace(/\b(?:NUCLEO|PIAM)\b/gi, " ")  // Named regulation positions
        .replace(new RegExp(`\\b(?:${BASES_INTERVENCAO_NOMEADAS.join("|")})\\b`, "gi"), " ")  // Named intervention bases (GOA)
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