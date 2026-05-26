import { parseMessage } from "@/modules/telegram/parser";

export type TelegramCommandName = "corrigir" | "retirar" | "remover" | "ramal" | "ativar" | "desativar" | "ontem" | "hoje" | "corrigirsaida";

const DEPARTURE_COMMAND_ALIASES = new Set(["saiu", "saindo", "saida", "saída"]);
const TELEGRAM_DEPARTURE_CORRECTION_COMMAND_PREFIX = /^\/corrigirsaida(?:@\w+)?\b\s*([\s\S]*)$/i;
const TELEGRAM_COVERAGE_COMMAND_PREFIX = /^\/cobertura(?:@\w+)?\b\s*([\s\S]*)$/i;

export interface ParsedTelegramCoverageCommand {
    name: "cobertura";
    baseCode: string | null;
    time: string | null;
    note: string | null;
    rawBody: string;
}

export function isTelegramCoverageCommandText(text: string) {
    return TELEGRAM_COVERAGE_COMMAND_PREFIX.test(text.trim());
}

export function parseTelegramCoverageCommand(text: string): ParsedTelegramCoverageCommand | null {
    const match = text.trim().match(TELEGRAM_COVERAGE_COMMAND_PREFIX);
    if (!match) {
        return null;
    }
    const rawBody = (match[1] ?? "").trim();
    // tokens: base [HH:MM] [restante = nota livre]
    const tokens = rawBody.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
        return { name: "cobertura", baseCode: null, time: null, note: null, rawBody };
    }
    const baseCode = tokens[0].toUpperCase();
    let time: string | null = null;
    const remaining: string[] = [];
    for (const token of tokens.slice(1)) {
        if (!time && /^\d{1,2}[:h]\d{2}$/i.test(token)) {
            time = token.replace(/h/i, ":");
            continue;
        }
        remaining.push(token);
    }
    return {
        name: "cobertura",
        baseCode,
        time,
        note: remaining.length > 0 ? remaining.join(" ") : null,
        rawBody,
    };
}

export interface ParsedTelegramCommand {
    name: TelegramCommandName;
    sector: "REGULATION" | "INTERVENTION";
    targetCode: string;
    doctorName: string | null;
    time: string | null;
    shiftLabel: "SD" | "SN" | "P" | null;
    roleLabel: string | null;
    rawBody: string;
    isDeparture: boolean;
}

export interface ParsedTelegramDepartureCorrectionCommand {
    name: "corrigirsaida";
    doctorName: string | null;
    targetCode: string | null;
    sector: "REGULATION" | "INTERVENTION" | null;
    rawBody: string;
}

export function isTelegramAdminOnlyCommand(name: TelegramCommandName) {
    return name === "remover" || name === "ativar" || name === "desativar";
}

export function isTelegramDepartureCorrectionCommandText(text: string) {
    return TELEGRAM_DEPARTURE_CORRECTION_COMMAND_PREFIX.test(text.trim());
}

export function parseTelegramDepartureCorrectionCommand(text: string): ParsedTelegramDepartureCorrectionCommand | null {
    const match = text.trim().match(TELEGRAM_DEPARTURE_CORRECTION_COMMAND_PREFIX);
    if (!match) {
        return null;
    }

    const rawBody = match[1]?.trim() ?? "";
    if (!rawBody) {
        return null;
    }

    const parsed = parseMessage(rawBody);
    const targetCode = parsed.baseCode ?? null;
    const doctorName = parsed.extractedNames[0]
        ?? (targetCode
            ? rawBody.replace(new RegExp(`\\b${targetCode}\\b`, "i"), " ").trim() || null
            : rawBody.trim() || null);

    if (!doctorName) {
        return null;
    }

    return {
        name: "corrigirsaida",
        doctorName,
        targetCode,
        sector: parsed.sector,
        rawBody,
    };
}

export function parseTelegramCommand(text: string): ParsedTelegramCommand | null {
    const match = text.trim().match(/^\/(corrigir|retirar|remover|ramal|ativar|desativar|saiu|saindo|saida|saída|ontem|hoje)\b\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }

    const rawCommandName = match[1].toLowerCase();
    const name = DEPARTURE_COMMAND_ALIASES.has(rawCommandName) ? "retirar" : rawCommandName as TelegramCommandName;
    const rawBody = match[2]?.trim() ?? "";
    const parsed = parseMessage(rawBody);

    if (!parsed.sector || !parsed.baseCode) {
        return null;
    }

    return {
        name,
        sector: parsed.sector,
        targetCode: parsed.baseCode,
        doctorName: parsed.extractedNames[0] ?? null,
        time: parsed.arrivalTime,
        shiftLabel: parsed.shiftType,
        roleLabel: parsed.roleFunction,
        rawBody,
        isDeparture: parsed.isDeparture || DEPARTURE_COMMAND_ALIASES.has(rawCommandName),
    };
}